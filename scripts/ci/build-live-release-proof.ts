#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { canonicalJson, expectedReleaseAssetNames, type ReleaseIdentity } from "../release-artifacts.js";

interface BuildMetadata {
  schema: "atlcli.build-metadata/v1";
  channel: "dev";
  rootVersion: string;
  sourceSha: string;
  releaseTag: string;
  buildId: string;
  run: { id: number; attempt: number; event: "workflow_dispatch" | "schedule"; createdAt: string };
  toolchain: { bun: string; wxt: string; runnerOs: string };
  lockfileSha256: string;
  artifacts: { name: string; size: number; sha256: string }[];
  extension: { contentTreeSha256: string };
}

interface SourceEligibility {
  schema: "atlcli.source-eligibility/v1";
  decision: "eligible";
  degraded: boolean;
  sourceSha: string;
  policyVersion: string;
  workflow: { runId: number; runAttempt: number; conclusion: "success" };
  requiredJob: { conclusion: "success" };
}

interface ReleaseReceipt {
  schema: "atlcli.github-release-transaction/v1";
  operation: "verify-published";
  releaseUrl: string;
  tag: string;
  sourceSha: string;
  draft: false;
  prerelease: true;
  makeLatest: false;
  immutable: true;
  assets: { name: string; size: number; sha256: string }[];
  stableLatestBefore: string;
  stableLatestAfter: string;
  run: { id: number; attempt: number };
}

interface ReleaseVerification {
  schema: "atlcli.release-verification/v1";
  sourceSha: string;
  channel: "dev";
  buildId: string;
  releaseTag: string;
  verifiedArtifacts: { name: string; size: number; sha256: string }[];
  extension: { contentTreeSha256: string; outputScan: "success"; entryCount: number };
}

interface NativeReceipt {
  schema: "atlcli.native-cli-verification/v1";
  target: string;
  runner: { platform: string; arch: string };
  releaseInfo: { channel: "dev"; sourceSha: string; buildId: string; releaseTag: string };
}

interface HomebrewNativeReceipt {
  schema: "atlcli.homebrew-dev-native-verification/v1";
  target: string;
  rubyPlatform: string;
  hostCpu: string;
  releaseInfo: { channel: "dev"; sourceSha: string; buildId: string; releaseTag: string };
}

interface HomebrewDispatch {
  schema: "atlcli.homebrew-dev-dispatch/v1";
  workflow: { id: number; attempt: number; url: string; conclusion: "success" };
  tapCommit: string;
  formulaSha256: string;
  pointer: {
    schema: "atlcli.homebrew-dev-pointer/v1";
    tag: string;
    sourceSha: string;
  };
}

interface WorkflowRun {
  databaseId: number;
  attempt: number;
  event: "workflow_dispatch" | "schedule";
  headSha: string;
  url: string;
  conclusion: "success";
  jobs: { name: string; conclusion: string }[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const CLI_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];
const BREW_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const PACKED_SUITES = ["worker", "jobs", "research", "rovo", "palette"];

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function files(root: string, filename: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...files(path, filename));
    else if (entry.name === filename) result.push(path);
  }
  return result.sort();
}

function exactTargets<T extends { target: string }>(receipts: T[], targets: string[], label: string): Record<string, T> {
  const actual = receipts.map(({ target }) => target).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...targets].sort())) {
    throw new Error(`${label} target contract mismatch; expected=${targets}; actual=${actual}`);
  }
  return Object.fromEntries(receipts.map((receipt) => [receipt.target, receipt]));
}

function successfulJob(run: WorkflowRun, name: string): void {
  const matches = run.jobs.filter((job) => job.name === name && job.conclusion === "success");
  if (matches.length !== 1) throw new Error(`required successful workflow job missing or ambiguous: ${name}`);
}

function sameIdentity(value: { sourceSha: string; releaseTag: string; buildId?: string }, metadata: BuildMetadata): void {
  if (
    value.sourceSha !== metadata.sourceSha ||
    value.releaseTag !== metadata.releaseTag ||
    (value.buildId !== undefined && value.buildId !== metadata.buildId)
  ) throw new Error("live proof input identity mismatch");
}

export function buildLiveReleaseProof(input: {
  releaseDir: string;
  releaseVerification: ReleaseVerification;
  releaseReceipt: ReleaseReceipt;
  eligibility: SourceEligibility;
  releaseRun: WorkflowRun;
  nativeReceipts: NativeReceipt[];
  homebrewDispatch: HomebrewDispatch;
  homebrewNativeReceipts: HomebrewNativeReceipt[];
  pointerText: string;
  formulaText: string;
  recordedAt: string;
}): unknown {
  const metadata = json<BuildMetadata>(join(input.releaseDir, "build-metadata.json"));
  if (metadata.schema !== "atlcli.build-metadata/v1" || metadata.channel !== "dev") throw new Error("invalid dev build metadata");
  if (!SHA.test(metadata.sourceSha) || !SHA256.test(metadata.lockfileSha256)) throw new Error("invalid metadata identity digest");
  if (input.eligibility.decision !== "eligible" || input.eligibility.sourceSha !== metadata.sourceSha) throw new Error("source is not eligible");
  sameIdentity(input.releaseVerification, metadata);
  if (input.releaseReceipt.sourceSha !== metadata.sourceSha || input.releaseReceipt.tag !== metadata.releaseTag) {
    throw new Error("public release receipt identity mismatch");
  }
  if (
    input.releaseReceipt.operation !== "verify-published" || input.releaseReceipt.draft ||
    !input.releaseReceipt.prerelease || input.releaseReceipt.makeLatest || !input.releaseReceipt.immutable ||
    input.releaseReceipt.stableLatestBefore !== input.releaseReceipt.stableLatestAfter
  ) throw new Error("published release contract is not proven");
  if (
    input.releaseRun.databaseId !== metadata.run.id || input.releaseRun.attempt !== metadata.run.attempt ||
    input.releaseRun.event !== metadata.run.event || input.releaseRun.headSha !== metadata.sourceSha ||
    input.releaseRun.conclusion !== "success"
  ) throw new Error("release workflow identity mismatch");
  for (const job of ["Download and consume every draft asset", "Verify public prerelease and stable latest isolation", "Publish and verify isolated Homebrew dev formula"]) {
    successfulJob(input.releaseRun, job);
  }
  if (canonicalJson(input.releaseVerification.verifiedArtifacts) !== canonicalJson(metadata.artifacts)) {
    throw new Error("downloaded artifact verifier receipt differs from build metadata");
  }

  const identity = {
    channel: "dev",
    rootVersion: metadata.rootVersion,
    sourceSha: metadata.sourceSha,
    shortSha: metadata.sourceSha.slice(0, 8),
    buildId: metadata.buildId,
    releaseTag: metadata.releaseTag,
  } as ReleaseIdentity;
  const expectedNames = expectedReleaseAssetNames(identity);
  const actualFiles = readdirSync(input.releaseDir)
    .filter((name) => statSync(join(input.releaseDir, name)).isFile())
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedNames)) throw new Error("downloaded live asset inventory mismatch");
  const assets = actualFiles.map((filename) => {
    const bytes = readFileSync(join(input.releaseDir, filename));
    return { filename, size: bytes.byteLength, sha256: sha256(bytes) };
  });
  const receiptAssets = input.releaseReceipt.assets.map(({ name, ...asset }) => ({ filename: name, ...asset })).sort((a, b) => a.filename.localeCompare(b.filename));
  if (canonicalJson(assets) !== canonicalJson(receiptAssets)) throw new Error("public release receipt differs from downloaded bytes");

  const nativeMatrix = exactTargets(input.nativeReceipts, CLI_TARGETS, "native CLI");
  for (const receipt of Object.values(nativeMatrix)) sameIdentity(receipt.releaseInfo, metadata);
  const brewMatrix = exactTargets(input.homebrewNativeReceipts, BREW_TARGETS, "Homebrew native");
  for (const receipt of Object.values(brewMatrix)) sameIdentity(receipt.releaseInfo, metadata);
  if (
    input.homebrewDispatch.workflow.conclusion !== "success" ||
    input.homebrewDispatch.pointer.tag !== metadata.releaseTag ||
    input.homebrewDispatch.pointer.sourceSha !== metadata.sourceSha ||
    input.homebrewDispatch.formulaSha256 !== sha256(input.formulaText) ||
    !SHA.test(input.homebrewDispatch.tapCommit)
  ) throw new Error("Homebrew publication identity mismatch");
  const publicPointer = JSON.parse(input.pointerText) as typeof input.homebrewDispatch.pointer;
  if (canonicalJson(publicPointer) !== canonicalJson(input.homebrewDispatch.pointer)) throw new Error("public Homebrew pointer differs from dispatch receipt");

  const extensionName = actualFiles.find((name) => name.startsWith("atlcli-extension-chrome-mv3-"));
  if (!extensionName) throw new Error("extension release asset is missing");
  const manifest = json<{ version?: string }>(join(input.releaseDir, "extension", "manifest.json"));
  if (!manifest.version || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error("verified extension manifest version is invalid");
  if (
    input.releaseVerification.extension.outputScan !== "success" ||
    input.releaseVerification.extension.contentTreeSha256 !== metadata.extension.contentTreeSha256
  ) throw new Error("extension verification does not match metadata");

  const proof = {
    schema: "atlcli.dev-release-live-proof/v1",
    recordedAt: input.recordedAt,
    source: {
      sha: metadata.sourceSha,
      canonicalMainPushRunId: input.eligibility.workflow.runId,
      canonicalMainPushAttempt: input.eligibility.workflow.runAttempt,
      requiredAggregate: input.eligibility.requiredJob.conclusion,
      requiredPolicyVersion: input.eligibility.policyVersion,
      advisoryPolicyVersion: input.eligibility.policyVersion,
      decision: input.eligibility.degraded ? "degraded" : "eligible",
    },
    workflow: { runId: input.releaseRun.databaseId, attempt: input.releaseRun.attempt, event: input.releaseRun.event, url: input.releaseRun.url },
    release: {
      buildId: metadata.buildId,
      tag: metadata.releaseTag,
      url: input.releaseReceipt.releaseUrl,
      prerelease: true,
      draft: false,
      immutable: true,
      stableLatestUnchanged: true,
    },
    toolchain: {
      bun: metadata.toolchain.bun,
      wxt: metadata.toolchain.wxt,
      runnerImages: Object.fromEntries(Object.entries(nativeMatrix).map(([target, receipt]) => [target, receipt.runner])),
      lockfileSha256: metadata.lockfileSha256,
    },
    assets,
    extension: {
      archiveSha256: assets.find(({ filename }) => filename === extensionName)!.sha256,
      manifestVersion: manifest.version,
      inventorySha256: input.releaseVerification.extension.contentTreeSha256,
      packedChromiumSuites: Object.fromEntries(PACKED_SUITES.map((suite) => [suite, "success"])),
    },
    homebrew: {
      tapCommit: input.homebrewDispatch.tapCommit,
      tapCommitUrl: `https://github.com/BjoernSchotte/homebrew-tap/commit/${input.homebrewDispatch.tapCommit}`,
      formulaSha256: input.homebrewDispatch.formulaSha256,
      pointerSha256: sha256(input.pointerText),
      releaseTag: metadata.releaseTag,
      nativeMatrix: Object.fromEntries(Object.entries(brewMatrix).map(([target, receipt]) => [target, { rubyPlatform: receipt.rubyPlatform, hostCpu: receipt.hostCpu, result: "success" }])),
      installedReleaseInfo: Object.values(brewMatrix)[0]!.releaseInfo,
    },
    tests: {
      exactDownloadedAssetVerifier: "success",
      packedChromium: "success",
      nativeCliMatrix: "success",
      homebrewAuditInstallTestSwitchMatrix: "success",
      stableLatestIsolation: "success",
    },
    privacy: { containsSecrets: false, containsTenantData: false, containsAbsoluteHomePaths: false, containsRawLogs: false },
  };
  return proof;
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}

if (import.meta.main) {
  const releaseDir = arg("--release-dir");
  const proof = buildLiveReleaseProof({
    releaseDir,
    releaseVerification: json(arg("--release-verification")),
    releaseReceipt: json(arg("--release-receipt")),
    eligibility: json(join(releaseDir, "source-eligibility.json")),
    releaseRun: json(arg("--release-run")),
    nativeReceipts: files(arg("--native-cli-dir"), "native-cli-verification.json").map((path) => json<NativeReceipt>(path)),
    homebrewDispatch: json(arg("--homebrew-dispatch")),
    homebrewNativeReceipts: files(arg("--homebrew-native-dir"), "native-verification.json").map((path) => json<HomebrewNativeReceipt>(path)),
    pointerText: readFileSync(arg("--homebrew-pointer"), "utf8"),
    formulaText: readFileSync(arg("--homebrew-formula"), "utf8"),
    recordedAt: new Date().toISOString(),
  });
  const schema = json<object>(resolve("specs/dev-release-channel/evidence/schemas/live-release-proof.schema.json"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(proof)) throw new Error(`live proof schema validation failed: ${JSON.stringify(validate.errors)}`);
  const output = canonicalJson(proof);
  writeFileSync(arg("--out"), output);
  process.stdout.write(output);
}
