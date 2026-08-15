#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  BUILD_METADATA_SCHEMA_ID,
  CLI_TARGETS,
  canonicalJson,
  cliAssetName,
  createReleaseIdentity,
  normalizeArtifactDigests,
  renderChecksums,
  type ArtifactDigest,
  type ReleaseChannel,
  type ReleaseIdentity,
} from "./release-artifacts.js";
import { verifyAndExtractExtensionArchive } from "./verify-release-artifacts.js";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface AssembleReleaseBundleInput {
  directory: string;
  channel: ReleaseChannel;
  rootVersion: string;
  sourceSha: string;
  sourceRef: string;
  createdAt: string;
  runId: number;
  runNumber: number;
  runAttempt: number;
  event: "push" | "schedule" | "workflow_dispatch";
  expectedBuildId: string;
  securityAttestationPath: string;
  sourceEligibilityPath?: string;
  lockfilePath?: string;
  runnerOs?: string;
  bunVersion?: string;
  wxtVersion?: string;
  verifyExtensionRuntime?: boolean;
}

export interface AssembleReleaseBundleReceipt {
  schema: "atlcli.release-bundle-assembly/v1";
  identity: ReleaseIdentity;
  assets: ArtifactDigest[];
  metadataSha256: string;
  checksumsSha256: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${value}`);
  }
  return value;
}

function copyReceipt(source: string, destination: string): void {
  const from = resolve(source);
  const to = resolve(destination);
  if (from !== to) copyFileSync(from, to);
}

function digestFile(path: string): ArtifactDigest {
  const bytes = readFileSync(path);
  return { name: basename(path), size: bytes.byteLength, sha256: sha256(bytes) };
}

export async function assembleReleaseBundle(
  input: AssembleReleaseBundleInput,
): Promise<AssembleReleaseBundleReceipt> {
  const directory = resolve(input.directory);
  const identity = createReleaseIdentity({
    channel: input.channel,
    rootVersion: input.rootVersion,
    sourceSha: input.sourceSha,
    sourceReachableFromMain: true,
    timestamp: input.createdAt,
    runNumber: positiveInteger("runNumber", input.runNumber),
    runAttempt: positiveInteger("runAttempt", input.runAttempt),
  });
  if (identity.buildId !== input.expectedBuildId) {
    throw new Error(
      `derived build ID ${identity.buildId} does not match expected ${input.expectedBuildId}`,
    );
  }

  const securityPath = join(directory, "security-attestation.json");
  copyReceipt(input.securityAttestationPath, securityPath);
  const eligibilityPath = join(directory, "source-eligibility.json");
  if (input.channel === "dev") {
    if (!input.sourceEligibilityPath) {
      throw new Error("dev release bundle requires a source eligibility receipt");
    }
    copyReceipt(input.sourceEligibilityPath, eligibilityPath);
  } else if (input.sourceEligibilityPath) {
    throw new Error("stable release bundle must not include a source eligibility receipt");
  }

  const extensionName = `atlcli-extension-chrome-mv3-${identity.buildId}.zip`;
  const payloadNames = [
    ...CLI_TARGETS.map(cliAssetName),
    extensionName,
    "security-attestation.json",
    ...(input.channel === "dev" ? ["source-eligibility.json"] : []),
  ].sort();
  const actualFiles = readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(payloadNames)) {
    throw new Error(
      `release payload contract mismatch; expected ${payloadNames.join(", ")}; got ${actualFiles.join(", ")}`,
    );
  }

  const extractionDirectory = join(directory, ".assembly-extension");
  const extension = await verifyAndExtractExtensionArchive({
    zipPath: join(directory, extensionName),
    extractionDirectory,
    verifyRuntime: input.verifyExtensionRuntime ?? true,
  });
  rmSync(extractionDirectory, { recursive: true, force: true });
  rmSync(`${extractionDirectory}.atlcli-release-extraction-v1`, { force: true });

  const artifacts = normalizeArtifactDigests(payloadNames.map((name) => digestFile(join(directory, name))));
  const lockfilePath = resolve(input.lockfilePath ?? join(REPO_ROOT, "bun.lock"));
  const wxtVersion = input.wxtVersion ?? (
    JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/wxt/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const metadata = canonicalJson({
    schema: BUILD_METADATA_SCHEMA_ID,
    channel: input.channel,
    rootVersion: identity.rootVersion,
    sourceSha: identity.sourceSha,
    sourceRef: input.sourceRef,
    releaseTag: identity.releaseTag,
    buildId: identity.buildId,
    run: {
      id: positiveInteger("runId", input.runId),
      attempt: identity.runAttempt,
      event: input.event,
      createdAt: identity.createdAt,
    },
    toolchain: {
      bun: input.bunVersion ?? Bun.version,
      wxt: wxtVersion,
      runnerOs: input.runnerOs ?? `${process.platform}-${process.arch}`,
    },
    lockfileSha256: sha256(readFileSync(lockfilePath)),
    artifacts,
    extension: extension.fingerprints,
    sourceEligibilitySha256:
      input.channel === "dev" ? sha256(readFileSync(eligibilityPath)) : null,
  });
  const checksums = renderChecksums(artifacts);
  writeFileSync(join(directory, "build-metadata.json"), metadata);
  writeFileSync(join(directory, "checksums.txt"), checksums);

  return {
    schema: "atlcli.release-bundle-assembly/v1",
    identity,
    assets: artifacts,
    metadataSha256: sha256(metadata),
    checksumsSha256: sha256(checksums),
  };
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`missing required option ${name}`);
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const channel = required(args, "--channel");
  const event = required(args, "--event");
  if (channel !== "stable" && channel !== "dev") throw new Error("invalid --channel");
  if (event !== "push" && event !== "schedule" && event !== "workflow_dispatch") {
    throw new Error("invalid --event");
  }
  const receipt = await assembleReleaseBundle({
    directory: required(args, "--dir"),
    channel,
    rootVersion: required(args, "--version"),
    sourceSha: required(args, "--source-sha"),
    sourceRef: required(args, "--source-ref"),
    createdAt: required(args, "--created-at"),
    runId: Number(required(args, "--run-id")),
    runNumber: Number(required(args, "--run-number")),
    runAttempt: Number(required(args, "--run-attempt")),
    event,
    expectedBuildId: required(args, "--build-id"),
    securityAttestationPath: required(args, "--security-attestation"),
    sourceEligibilityPath: value(args, "--source-eligibility"),
    runnerOs: value(args, "--runner-os"),
  });
  process.stdout.write(canonicalJson(receipt));
}
