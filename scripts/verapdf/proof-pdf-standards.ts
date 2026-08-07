/** External conformance proof for every product-facing Typst PDF standard. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  compileStandardCorpus,
  VERAPDF_OUT_DIR,
  type VeraPdfStandardFixture,
} from "./compile-corpus.js";
import { parseVeraPdfCompliance, parseVeraPdfReport } from "./ratchet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = resolve(HERE, "verapdf.lock.json");
const REPORT_PATH = resolve(VERAPDF_OUT_DIR, "pdf-standard-proof.json");

interface VeraPdfLock {
  schema: "atlcli.verapdf-image-lock/1";
  repository: string;
  tag: string;
  digest: `sha256:${string}`;
  platform: { os: string; architecture: string };
  version: string;
  license: string;
  provenance: string;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "signal"}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function loadLock(): VeraPdfLock {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as VeraPdfLock;
  if (
    lock.schema !== "atlcli.verapdf-image-lock/1" ||
    lock.repository !== "verapdf/cli" ||
    lock.tag !== `v${lock.version}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(lock.digest) ||
    lock.platform.os !== "linux" ||
    lock.platform.architecture !== "amd64" ||
    !lock.provenance.startsWith("https://github.com/veraPDF/")
  ) {
    throw new Error("Invalid veraPDF image lock");
  }
  return lock;
}

function assertRemoteTagDigest(lock: VeraPdfLock): void {
  const manifest = JSON.parse(
    run("docker", ["manifest", "inspect", "--verbose", `${lock.repository}:${lock.tag}`]),
  ) as unknown;
  const descriptors = Array.isArray(manifest) ? manifest : [manifest];
  const matching = descriptors.find((entry) => {
    const record = entry as {
      Descriptor?: { digest?: string; platform?: { os?: string; architecture?: string } };
    };
    return record.Descriptor?.platform?.os === lock.platform.os &&
      record.Descriptor?.platform?.architecture === lock.platform.architecture;
  }) as { Descriptor?: { digest?: string } } | undefined;
  if (matching?.Descriptor?.digest !== lock.digest) {
    throw new Error(
      `veraPDF tag/digest mismatch for ${lock.platform.os}/${lock.platform.architecture}: ` +
        `expected ${lock.digest}, received ${matching?.Descriptor?.digest ?? "no descriptor"}`,
    );
  }
}

function validatorVersion(lock: VeraPdfLock, image: string): string {
  const output = run("docker", [
    "run",
    "--rm",
    "--platform",
    `${lock.platform.os}/${lock.platform.architecture}`,
    "--network",
    "none",
    image,
    "--version",
  ]);
  if (!output.includes(lock.version)) {
    throw new Error(`veraPDF version mismatch: expected ${lock.version}, received ${output.trim()}`);
  }
  return lock.version;
}

function validateFixture(lock: VeraPdfLock, image: string, fixture: VeraPdfStandardFixture): unknown {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      `${lock.platform.os}/${lock.platform.architecture}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--mount",
      `type=bind,src=${VERAPDF_OUT_DIR},dst=/data,readonly`,
      image,
      "--flavour",
      fixture.flavour,
      "--format",
      "json",
      `/data/${basename(fixture.path)}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (!result.stdout) {
    throw new Error(
      `veraPDF produced no report for ${fixture.id} (${result.status ?? "signal"}): ${result.stderr}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`veraPDF produced invalid JSON for ${fixture.id}: ${String(error)}`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  const lock = loadLock();
  assertRemoteTagDigest(lock);
  const image = `${lock.repository}@${lock.digest}`;
  const version = validatorVersion(lock, image);
  const fixtures = await compileStandardCorpus();
  const evidence = [];
  const failures: string[] = [];

  for (const fixture of fixtures) {
    const report = validateFixture(lock, image, fixture);
    const compliance = parseVeraPdfCompliance(report);
    const findings = parseVeraPdfReport(report, fixture.id);
    if (compliance.compliant !== fixture.expectedCompliant) {
      failures.push(
        `${fixture.id}: expected compliant=${fixture.expectedCompliant}, got ${compliance.compliant}`,
      );
    }
    if (!fixture.expectedCompliant && findings.length === 0) {
      failures.push(`${fixture.id}: invalid canary failed without normalized findings`);
    }
    evidence.push({
      fixture: fixture.id,
      requestedStandard: fixture.standard,
      flavour: fixture.flavour,
      compilerVersion: fixture.compilerVersion,
      artifactSha256: sha256(fixture.path),
      validator: {
        image,
        version,
        compliant: compliance.compliant,
        profiles: compliance.profileNames,
        findings,
      },
    });
  }

  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({ schema: "atlcli.pdf-standard-proof/1", evidence }, null, 2)}\n`,
  );
  if (failures.length > 0) {
    throw new Error(`PDF standard proof failed:\n${failures.join("\n")}`);
  }
  process.stdout.write(
    `proof:pdf-standards: ${fixtures.length - 1} standards passed; invalid canary rejected; evidence ${REPORT_PATH}\n`,
  );
}

await main();
