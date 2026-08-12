import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { packagePrebuiltExtension } from "../apps/extension/scripts/package-release.js";
import {
  releaseInfoBunDefineArgs,
} from "../apps/cli/build-release-info.js";
import { createReleaseInfo } from "../packages/core/src/release-info.js";
import {
  CLI_TARGETS,
  canonicalJson,
  cliAssetName,
  createReleaseIdentity,
  normalizeArtifactDigests,
  type ArtifactDigest,
  type ReleaseChannel,
  type ReleaseIdentity,
} from "./release-artifacts.js";
import {
  deterministicTarGz,
  deterministicZip,
  executableEntry,
} from "./release-archive.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OUTPUT_MARKER = ".atlcli-release-artifacts-v1";

export interface ReleaseArtifactBuildReceipt {
  schema: "atlcli.release-artifact-build/v1";
  dryRun: boolean;
  publishableSource: boolean;
  identity: ReleaseIdentity;
  outputDirectory: string;
  artifacts: ArtifactDigest[];
  extensionContentTreeSha256: string | null;
}

function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${command.join(" ")}`);
  }
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function isSourceReachableFromMain(sourceSha: string): boolean {
  return Bun.spawnSync(["git", "merge-base", "--is-ancestor", sourceSha, "origin/main"], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function prepareReleaseOutputDirectory(outputDirectory: string): string {
  const output = resolve(outputDirectory);
  if (output === REPO_ROOT || basename(output) === "") {
    throw new Error("refusing to use repository root as release output directory");
  }
  if (existsSync(output)) {
    const entries = readdirSync(output);
    if (entries.length > 0 && !entries.includes(OUTPUT_MARKER)) {
      throw new Error(`refusing to clean an unowned release output directory: ${output}`);
    }
    rmSync(output, { recursive: true, force: true });
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, OUTPUT_MARKER), "owned by atlcli release artifact builder\n");
  return output;
}

export async function withRestoredFileMode<T>(
  path: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const originalMode = statSync(path).mode & 0o777;
  try {
    return await operation();
  } finally {
    chmodSync(path, originalMode);
  }
}

export async function buildCliArchive(input: {
  target: (typeof CLI_TARGETS)[number];
  identity: ReleaseIdentity;
  outputDirectory: string;
}): Promise<ArtifactDigest> {
  const work = mkdtempSync(join(tmpdir(), `atlcli-${input.target}-`));
  const entryPoint = join(REPO_ROOT, "apps/cli/src/index.ts");
  return withRestoredFileMode(entryPoint, async () => {
    try {
      const executableName = input.target.startsWith("windows-") ? "atlcli.exe" : "atlcli";
      const binaryPath = join(work, executableName);
      const releaseInfo = createReleaseInfo({
        version: input.identity.cliVersion,
        channel: input.identity.channel,
        sourceSha: input.identity.sourceSha,
        buildId: input.identity.buildId,
        releaseTag: input.identity.releaseTag,
        homebrewVersion: input.identity.homebrewVersion,
      });
      run([
        "bun",
        "build",
        "apps/cli/src/index.ts",
        "--compile",
        "--conditions=development",
        "--target",
        `bun-${input.target}`,
        ...releaseInfoBunDefineArgs(releaseInfo),
        "--outfile",
        binaryPath,
      ]);
      const binary = readFileSync(binaryPath);
      const entry = executableEntry(executableName, binary);
      const archive = input.target.startsWith("windows-")
        ? await deterministicZip([entry])
        : deterministicTarGz(entry);
      const name = cliAssetName(input.target);
      await Bun.write(join(input.outputDirectory, name), archive);
      return { name, size: archive.byteLength, sha256: sha256(archive) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

function extensionEnvironment(identity: ReleaseIdentity): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATLCLI_RELEASE_CHANNEL: identity.channel,
    ATLCLI_SOURCE_SHA: identity.sourceSha,
    ATLCLI_BUILD_ID: identity.buildId,
    ATLCLI_EXTENSION_VERSION: identity.extensionVersion,
    ATLCLI_EXTENSION_VERSION_NAME: identity.extensionVersionName,
  };
}

export async function buildReleaseArtifacts(input: {
  identity: ReleaseIdentity;
  outputDirectory: string;
  targets?: (typeof CLI_TARGETS)[number][];
  includeExtension?: boolean;
  dryRun: boolean;
  publishableSource: boolean;
}): Promise<ReleaseArtifactBuildReceipt> {
  const outputDirectory = prepareReleaseOutputDirectory(input.outputDirectory);
  const artifacts: ArtifactDigest[] = [];
  for (const target of input.targets ?? CLI_TARGETS) {
    artifacts.push(await buildCliArchive({ target, identity: input.identity, outputDirectory }));
  }

  let extensionContentTreeSha256: string | null = null;
  if (input.includeExtension ?? true) {
    const env = extensionEnvironment(input.identity);
    // `wxt zip` owns the single release build/package lifecycle. The configured
    // completion hook normalizes timestamps in-place for byte reproducibility.
    run(["bun", "run", "--cwd", "apps/extension", "zip"], { env });
    const extension = await packagePrebuiltExtension({
      inputDirectory: join(REPO_ROOT, "apps/extension/.output/chrome-mv3"),
      outputDirectory,
      environment: env,
    });
    artifacts.push({
      name: extension.artifactName,
      size: extension.artifactSize,
      sha256: extension.artifactSha256,
    });
    extensionContentTreeSha256 = extension.contentTreeSha256;
  }

  return {
    schema: "atlcli.release-artifact-build/v1",
    dryRun: input.dryRun,
    publishableSource: input.publishableSource,
    identity: input.identity,
    outputDirectory,
    artifacts: normalizeArtifactDigests(artifacts),
    extensionContentTreeSha256,
  };
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function integer(args: string[], name: string, fallback: number): number {
  const raw = value(args, name);
  return raw === undefined ? fallback : Number(raw);
}

export async function runReleaseArtifactBuildCli(args: string[]): Promise<void> {
  const channelValue = value(args, "--channel");
  if (channelValue !== "stable" && channelValue !== "dev") {
    throw new Error("build requires --channel stable or --channel dev");
  }
  const channel: ReleaseChannel = channelValue;
  const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const sourceSha = value(args, "--source-sha") ?? git(["rev-parse", "HEAD"]);
  const timestamp = value(args, "--timestamp") ?? git(["show", "-s", "--format=%cI", sourceSha]);
  const runNumber = integer(args, "--run-number", Number(process.env.GITHUB_RUN_NUMBER ?? 1));
  const runAttempt = integer(args, "--run-attempt", Number(process.env.GITHUB_RUN_ATTEMPT ?? 1));
  const dryRun = args.includes("--dry-run");
  const publishableSource = isSourceReachableFromMain(sourceSha);
  if (!publishableSource && !dryRun) {
    throw new Error("source SHA is not reachable from origin/main; only --dry-run review builds are allowed");
  }
  const identity = createReleaseIdentity({
    channel,
    rootVersion: value(args, "--version") ?? rootPackage.version,
    sourceSha,
    // A review-only dry run never publishes. The live workflow supplies the
    // separately proven eligibility receipt before this builder is invoked.
    sourceReachableFromMain: publishableSource || dryRun,
    timestamp,
    runNumber,
    runAttempt,
    extensionBuildSequence: integer(args, "--extension-sequence", runNumber),
  });
  const requestedTargetValues = args
    .flatMap((entry, index) => entry === "--target" ? [args[index + 1]] : [])
  for (const target of requestedTargetValues) {
    if (!target || !CLI_TARGETS.includes(target as (typeof CLI_TARGETS)[number])) {
      throw new Error(`unsupported release target: ${String(target)}`);
    }
  }
  const requestedTargets = requestedTargetValues as (typeof CLI_TARGETS)[number][];
  const skipCli = args.includes("--skip-cli");
  if (skipCli && args.includes("--skip-extension")) {
    throw new Error("build cannot skip both CLI and extension artifacts");
  }
  const receipt = await buildReleaseArtifacts({
    identity,
    outputDirectory: value(args, "--output") ?? join(REPO_ROOT, ".artifacts", "dev-release"),
    targets: skipCli ? [] : requestedTargets.length > 0 ? requestedTargets : undefined,
    includeExtension: !args.includes("--skip-extension"),
    dryRun,
    publishableSource,
  });
  const rendered = canonicalJson(receipt);
  const receiptPath = value(args, "--receipt");
  if (receiptPath) writeFileSync(resolve(receiptPath), rendered);
  else process.stdout.write(rendered);
}
