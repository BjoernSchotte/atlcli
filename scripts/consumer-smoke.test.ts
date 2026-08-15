import { describe, expect, it } from "bun:test";
import { runTarballSmoke } from "./consumer-smoke.js";
import {
  FILELINK_SMOKE_ENV,
  KNOWN_FILELINK_EEXIST_BUN_VERSION,
  installFilelinkWithKnownRetry,
  isKnownTransientFilelinkInstallFailure,
  knownFilelinkEexistPackage,
  runFilelinkSmoke,
  type InstallResult,
} from "./consumer-smoke-filelink.js";
import { runNodeSmoke } from "./consumer-smoke-node.js";
import { runViteSmoke } from "./consumer-smoke-vite.js";

/**
 * Consumer smoke wiring (spec 009): the heavy suites run behind
 * ATLCLI_CONSUMER_SMOKE=1 (set in the consumer-smoke CI workflow) because
 * they install from the public registry (transitive third-party deps) and
 * spawn real npm/node processes — too slow/network-dependent for every local
 * `bun test`. Each suite throws on any failed step; a passing test means the
 * whole flow (pack → install → real DOCX/PDF exports → skipLibCheck:false
 * type-check) succeeded.
 */

const enabled = process.env.ATLCLI_CONSUMER_SMOKE === "1";
const allowedPackages = new Set(["@atlcli/confluence", "@atlcli/pdf", "@atlcli/template-pack"]);
const success: InstallResult = { exitCode: 0, stdout: "", stderr: "" };
const knownFailure = (
  line = "error: File exists: failed to link package @atlcli/confluence",
): InstallResult => ({
  exitCode: 1,
  stdout: "bun install v1.3.14\nResolving dependencies\n",
  stderr: `${line}\n`,
});
const currentKnownFailure: InstallResult = {
  exitCode: 1,
  stdout: "bun install v1.3.14 (0d9b296a)\n",
  stderr:
    "EEXIST: File or folder exists: failed to link package: @atlcli/template-pack@/home/runner/work/atlcli/atlcli/packages/template-pack (link)\n" +
    "Failed to install 1 package\n" +
    "Saved lockfile\n",
};

describe("filesystem-link package identity", () => {
  it("does not compare state across Bun's distinct direct and transitive file: copies", () => {
    expect(FILELINK_SMOKE_ENV).toEqual({
      NODE_ENV: "production",
      ATLCLI_ASSERT_SHARED_CODE_HIGHLIGHT_STATE: "0",
    });
  });
});

describe("known Bun file-link EEXIST retry", () => {
  it("recognizes only the reviewed Bun/package/error tuple", () => {
    expect(
      knownFilelinkEexistPackage(
        knownFailure(),
        KNOWN_FILELINK_EEXIST_BUN_VERSION,
        allowedPackages,
      ),
    ).toBe("@atlcli/confluence");
    expect(
      knownFilelinkEexistPackage(
        currentKnownFailure,
        KNOWN_FILELINK_EEXIST_BUN_VERSION,
        allowedPackages,
      ),
    ).toBe("@atlcli/template-pack");
    expect(knownFilelinkEexistPackage(knownFailure(), "1.3.15", allowedPackages)).toBeNull();
    expect(
      knownFilelinkEexistPackage(
        knownFailure("error: File exists: failed to link package @atlcli/unknown"),
        KNOWN_FILELINK_EEXIST_BUN_VERSION,
        allowedPackages,
      ),
    ).toBeNull();
  });

  it("recreates once and performs exactly one retry for the known signature", () => {
    const attempts = [knownFailure(), success];
    let installs = 0;
    let recreates = 0;
    const warnings: string[] = [];
    installFilelinkWithKnownRetry({
      bunVersion: KNOWN_FILELINK_EEXIST_BUN_VERSION,
      allowedPackages,
      install: () => attempts[installs++]!,
      recreate: () => recreates++,
      warn: (message) => warnings.push(message),
    });
    expect(installs).toBe(2);
    expect(recreates).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@atlcli/confluence");
    expect(warnings[0]).not.toContain("/tmp/");
  });

  it("keeps a second exact failure fatal and never attempts a third install", () => {
    let installs = 0;
    expect(() =>
      installFilelinkWithKnownRetry({
        bunVersion: KNOWN_FILELINK_EEXIST_BUN_VERSION,
        allowedPackages,
        install: () => {
          installs++;
          return knownFailure();
        },
        recreate: () => {},
      }),
    ).toThrow("bun install (filelink consumer) failed");
    expect(installs).toBe(2);
  });

  it("does not retry adjacent, mixed, or mutated failures", () => {
    const failures: InstallResult[] = [
      knownFailure("error: File exists: package cache already exists"),
      knownFailure("npm error EEXIST"),
      {
        ...knownFailure(),
        stderr:
          "error: File exists: failed to link package @atlcli/confluence\n" +
          "fatal: checksum verification failed\n",
      },
      knownFailure("error: Directory exists: failed to link package @atlcli/confluence"),
      knownFailure("error: File exists: failed linking package @atlcli/confluence"),
    ];

    for (const failure of failures) {
      let installs = 0;
      expect(() =>
        installFilelinkWithKnownRetry({
          bunVersion: KNOWN_FILELINK_EEXIST_BUN_VERSION,
          allowedPackages,
          install: () => {
            installs++;
            return failure;
          },
          recreate: () => {
            throw new Error("must not recreate");
          },
        }),
      ).toThrow();
      expect(installs).toBe(1);
    }
  });
});

describe("pinned Typst release transport retry", () => {
  const typstUrl =
    "https://github.com/BjoernSchotte/typst.ts/releases/download/" +
    "web-compiler-v0.8.0-rc3.typst0151.1/" +
    "myriaddreamin-typst-ts-web-compiler-0.8.0-rc3.typst0151.1.tgz";
  const transientFailure = (status = 503): InstallResult => ({
    exitCode: 1,
    stdout: "bun install v1.3.14\nResolving dependencies\nResolved, downloaded and extracted [39]\n",
    stderr:
      `error: GET ${typstUrl} - ${status}\n` +
      `error: @myriaddreamin/typst-ts-web-compiler@${typstUrl} failed to resolve\n`,
  });

  it("recognizes only the pinned URL and bounded transient HTTP statuses", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isKnownTransientFilelinkInstallFailure(transientFailure(status))).toBeTrue();
    }
    expect(isKnownTransientFilelinkInstallFailure(transientFailure(404))).toBeFalse();
    expect(isKnownTransientFilelinkInstallFailure({
      ...transientFailure(),
      stderr:
        "error: GET https://example.com/package.tgz - 503\n" +
        "error: @myriaddreamin/typst-ts-web-compiler@https://example.com/package.tgz failed to resolve\n",
    })).toBeFalse();
    expect(isKnownTransientFilelinkInstallFailure({
      ...transientFailure(),
      stderr: `error: GET ${typstUrl} - 503\nfatal: checksum verification failed\n`,
    })).toBeFalse();
  });

  it("recreates with bounded backoff and succeeds on a later transport attempt", () => {
    const attempts = [transientFailure(), transientFailure(502), success];
    const delays: number[] = [];
    let installs = 0;
    let recreates = 0;
    const warnings: string[] = [];
    installFilelinkWithKnownRetry({
      bunVersion: KNOWN_FILELINK_EEXIST_BUN_VERSION,
      allowedPackages,
      install: () => attempts[installs++]!,
      recreate: () => recreates++,
      delay: (milliseconds) => delays.push(milliseconds),
      warn: (message) => warnings.push(message),
    });
    expect(installs).toBe(3);
    expect(recreates).toBe(2);
    expect(delays).toEqual([5_000, 10_000]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).not.toContain(typstUrl);
  });

  it("keeps the third transient failure fatal", () => {
    let installs = 0;
    expect(() => installFilelinkWithKnownRetry({
      bunVersion: KNOWN_FILELINK_EEXIST_BUN_VERSION,
      allowedPackages,
      install: () => {
        installs++;
        return transientFailure();
      },
      recreate: () => {},
      delay: () => {},
    })).toThrow("bun install (filelink consumer) failed");
    expect(installs).toBe(3);
  });
});

if (!enabled) {
  console.log(
    "consumer-smoke: SKIPPED — set ATLCLI_CONSUMER_SMOKE=1 to run the tarball, " +
      "filesystem-link, and Node-LTS consumer suites (registry access required).",
  );
}

describe.skipIf(!enabled)("consumer smoke (spec 009)", () => {
  it(
    "tarball install (bun): pack all, install with overrides, DOCX + PDF smokes, skipLibCheck:false types",
    async () => {
      const { smokes } = await runTarballSmoke();
      console.log(`tarball: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "filesystem-link install (bun, NODE_ENV=production): file: package dirs resolve to dist and export for real",
    async () => {
      const { smokes } = await runFilelinkSmoke();
      console.log(`filelink: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "Node-LTS (npm + plain node): every Node-compatible entrypoint imports, NodeNext types check, real exports run",
    async () => {
      const { nodeVersion, npmVersion, smokes } = await runNodeSmoke();
      console.log(`node ${nodeVersion} / npm ${npmVersion}: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "Vite tarball build: browser assets resolve and the production chunk compiles real DOCX + PDF exports",
    async () => {
      const { viteVersion, smokes } = await runViteSmoke();
      console.log(`vite ${viteVersion}: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );
});
