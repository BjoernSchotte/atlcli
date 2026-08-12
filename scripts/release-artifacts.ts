#!/usr/bin/env bun

import { createHash } from "node:crypto";

export const BUILD_METADATA_SCHEMA_ID = "atlcli.build-metadata/v1";
export const SECURITY_ATTESTATION_SCHEMA_ID = "atlcli.security-attestation/v1";
export const SOURCE_ELIGIBILITY_SCHEMA_ID = "atlcli.source-eligibility/v1";

export type ReleaseChannel = "stable" | "dev";

export interface ReleaseIdentityInput {
  channel: ReleaseChannel;
  rootVersion: string;
  sourceSha: string;
  sourceReachableFromMain: boolean;
  timestamp: string | Date;
  runNumber: number;
  runAttempt: number;
  extensionBuildSequence?: number;
}

export interface ReleaseIdentity {
  channel: ReleaseChannel;
  rootVersion: string;
  sourceSha: string;
  shortSha: string;
  buildId: string;
  releaseTag: string;
  cliVersion: string;
  extensionVersion: string;
  extensionVersionName: string;
  homebrewVersion: string;
  createdAt: string;
  runNumber: number;
  runAttempt: number;
}

export interface ArtifactDigest {
  name: string;
  size: number;
  sha256: string;
}

export interface ExistingDevRelease {
  tag: string;
  sourceSha: string;
  complete: boolean;
}

export type PublicationDecision =
  | { decision: "create"; tag: string }
  | { decision: "noop"; tag: string; reason: "source-already-proven" }
  | { decision: "hard-conflict"; tag: string; reason: string };

const ROOT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CLI_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;

function positiveInteger(name: string, value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}; got ${value}`);
  }
  return value;
}

export function parseRootVersion(version: string): [number, number, number] {
  const match = ROOT_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`rootVersion must be MAJOR.MINOR.PATCH with numeric components; got ${version}`);
  }
  const components = match.slice(1).map(Number) as [number, number, number];
  for (const component of components) {
    if (component > 65535) {
      throw new Error(`rootVersion component exceeds the Chrome limit 65535: ${version}`);
    }
  }
  return components;
}

export function validateSourceSha(sourceSha: string, reachableFromMain: boolean): string {
  if (!FULL_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`sourceSha must be a lowercase 40-character Git SHA; got ${sourceSha}`);
  }
  if (!reachableFromMain) {
    throw new Error(`sourceSha ${sourceSha} is not reachable from origin/main`);
  }
  return sourceSha;
}

function utcParts(timestamp: string | Date): {
  iso: string;
  day: string;
  second: string;
} {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`timestamp must be a valid ISO-8601 instant; got ${String(timestamp)}`);
  }
  const iso = date.toISOString();
  return {
    iso,
    day: iso.slice(0, 10).replaceAll("-", ""),
    second: iso.slice(0, 19).replaceAll(/[-:T]/g, ""),
  };
}

export function createReleaseIdentity(input: ReleaseIdentityInput): ReleaseIdentity {
  const [major, minor, patch] = parseRootVersion(input.rootVersion);
  const sourceSha = validateSourceSha(input.sourceSha, input.sourceReachableFromMain);
  const runNumber = positiveInteger("runNumber", input.runNumber);
  const runAttempt = positiveInteger("runAttempt", input.runAttempt);
  const extensionBuildSequence = positiveInteger(
    "extensionBuildSequence",
    input.extensionBuildSequence ?? runNumber,
    65535,
  );
  const time = utcParts(input.timestamp);
  const shortSha = sourceSha.slice(0, 8);

  if (input.channel === "stable") {
    const buildId = `v${input.rootVersion}`;
    return {
      channel: input.channel,
      rootVersion: input.rootVersion,
      sourceSha,
      shortSha,
      buildId,
      releaseTag: buildId,
      cliVersion: input.rootVersion,
      extensionVersion: `${major}.${minor}.${patch}`,
      extensionVersionName: input.rootVersion,
      homebrewVersion: input.rootVersion,
      createdAt: time.iso,
      runNumber,
      runAttempt,
    };
  }

  const buildId = `dev-${time.day}.${runNumber}.${runAttempt}-${shortSha}`;
  return {
    channel: input.channel,
    rootVersion: input.rootVersion,
    sourceSha,
    shortSha,
    buildId,
    releaseTag: buildId,
    cliVersion: `${input.rootVersion}-dev.${time.day}.${runNumber}.${runAttempt}+${shortSha}`,
    extensionVersion: `${major}.${minor}.${patch}.${extensionBuildSequence}`,
    extensionVersionName:
      `${input.rootVersion}-dev.${time.day}.${runNumber}.${runAttempt}-${shortSha}`,
    homebrewVersion: `${time.second}.${runNumber}.${runAttempt}`,
    createdAt: time.iso,
    runNumber,
    runAttempt,
  };
}

export function cliAssetName(target: (typeof CLI_TARGETS)[number]): string {
  const extension = target.startsWith("windows-") ? "zip" : "tar.gz";
  return `atlcli-${target}.${extension}`;
}

export function expectedReleaseAssetNames(identity: ReleaseIdentity): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${identity.buildId}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ].sort();
}

export function assertExpectedReleaseAssets(
  identity: ReleaseIdentity,
  actualNames: string[],
): string[] {
  const actual = [...actualNames].sort();
  const duplicates = actual.filter((name, index) => index > 0 && name === actual[index - 1]);
  if (duplicates.length > 0) {
    throw new Error(`duplicate release assets: ${[...new Set(duplicates)].join(", ")}`);
  }
  for (const name of actual) {
    if (!ASSET_NAME_PATTERN.test(name)) throw new Error(`invalid release asset name: ${name}`);
  }

  const expected = expectedReleaseAssetNames(identity);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `release asset contract mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }
  return actual;
}

export function normalizeArtifactDigests(artifacts: ArtifactDigest[]): ArtifactDigest[] {
  const seen = new Set<string>();
  return artifacts
    .map((artifact) => {
      if (!ASSET_NAME_PATTERN.test(artifact.name)) {
        throw new Error(`invalid artifact name: ${artifact.name}`);
      }
      if (seen.has(artifact.name)) {
        throw new Error(`duplicate artifact name: ${artifact.name}`);
      }
      seen.add(artifact.name);
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
        throw new Error(`artifact size must be a positive integer: ${artifact.name}`);
      }
      const sha256 = artifact.sha256.toLowerCase();
      if (!SHA256_PATTERN.test(sha256)) {
        throw new Error(`artifact sha256 must contain 64 hexadecimal characters: ${artifact.name}`);
      }
      return { ...artifact, sha256 };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function renderChecksums(artifacts: ArtifactDigest[]): string {
  return normalizeArtifactDigests(artifacts)
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n") + "\n";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decidePublication(input: {
  requested: ReleaseIdentity;
  existing: ExistingDevRelease[];
  forceRebuild: boolean;
}): PublicationDecision {
  const exactTag = input.existing.find((release) => release.tag === input.requested.releaseTag);
  if (exactTag) {
    const sameSource = exactTag.sourceSha === input.requested.sourceSha;
    return {
      decision: "hard-conflict",
      tag: exactTag.tag,
      reason: sameSource
        ? "requested immutable tag already exists; create a new run attempt instead of overwriting it"
        : "requested tag already belongs to a different full source SHA",
    };
  }

  const sameSource = input.existing
    .filter((release) => release.sourceSha === input.requested.sourceSha)
    .sort((left, right) => right.tag.localeCompare(left.tag));
  const proven = sameSource.find((release) => release.complete);
  if (proven && !input.forceRebuild) {
    return { decision: "noop", tag: proven.tag, reason: "source-already-proven" };
  }
  if (sameSource.some((release) => !release.complete) && !input.forceRebuild) {
    return {
      decision: "hard-conflict",
      tag: sameSource.find((release) => !release.complete)!.tag,
      reason: "an incomplete immutable release exists for this source; use a new forced build",
    };
  }
  return { decision: "create", tag: input.requested.releaseTag };
}

const SHA256_SCHEMA = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const SOURCE_SHA_SCHEMA = { type: "string", pattern: "^[0-9a-f]{40}$" } as const;

export const BUILD_METADATA_JSON_SCHEMA = {
  $id: BUILD_METADATA_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "channel",
    "rootVersion",
    "sourceSha",
    "sourceRef",
    "releaseTag",
    "buildId",
    "run",
    "toolchain",
    "lockfileSha256",
    "artifacts",
    "extension",
    "sourceEligibilitySha256",
  ],
  properties: {
    schema: { const: BUILD_METADATA_SCHEMA_ID },
    channel: { enum: ["stable", "dev"] },
    rootVersion: { type: "string", pattern: ROOT_VERSION_PATTERN.source },
    sourceSha: SOURCE_SHA_SCHEMA,
    sourceRef: { type: "string", minLength: 1 },
    releaseTag: { type: "string", minLength: 1 },
    buildId: { type: "string", minLength: 1 },
    run: {
      type: "object",
      additionalProperties: false,
      required: ["id", "attempt", "event", "createdAt"],
      properties: {
        id: { type: "integer", minimum: 1 },
        attempt: { type: "integer", minimum: 1 },
        event: { enum: ["push", "schedule", "workflow_dispatch"] },
        createdAt: { type: "string", minLength: 20 },
      },
    },
    toolchain: {
      type: "object",
      additionalProperties: false,
      required: ["bun", "wxt", "runnerOs"],
      properties: {
        bun: { type: "string", minLength: 1 },
        wxt: { type: "string", minLength: 1 },
        runnerOs: { type: "string", minLength: 1 },
      },
    },
    lockfileSha256: SHA256_SCHEMA,
    artifacts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "size", "sha256"],
        properties: {
          name: { type: "string", pattern: ASSET_NAME_PATTERN.source },
          size: { type: "integer", minimum: 1 },
          sha256: SHA256_SCHEMA,
        },
      },
    },
    extension: {
      type: "object",
      additionalProperties: false,
      required: ["contentTreeSha256", "manifestSha256", "cspSha256", "permissionsSha256"],
      properties: {
        contentTreeSha256: SHA256_SCHEMA,
        manifestSha256: SHA256_SCHEMA,
        cspSha256: SHA256_SCHEMA,
        permissionsSha256: SHA256_SCHEMA,
      },
    },
    sourceEligibilitySha256: SHA256_SCHEMA,
  },
} as const;

export const SECURITY_ATTESTATION_JSON_SCHEMA = {
  $id: SECURITY_ATTESTATION_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "commit",
    "date",
    "veraPdfDigestOk",
    "veraPdfBaselineDelta",
    "securityReviewNote",
    "m1AcceptanceOk",
    "checks",
  ],
  properties: {
    schema: { const: SECURITY_ATTESTATION_SCHEMA_ID },
    commit: SOURCE_SHA_SCHEMA,
    date: { type: "string", minLength: 20 },
    veraPdfDigestOk: { type: ["boolean", "null"] },
    veraPdfBaselineDelta: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["added", "removed", "changed"],
          properties: {
            added: { type: "array", items: { type: "string" } },
            removed: { type: "array", items: { type: "string" } },
            changed: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    securityReviewNote: { type: "string", minLength: 1 },
    m1AcceptanceOk: { type: ["boolean", "null"] },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "status", "detail"],
        properties: {
          field: { type: "string", minLength: 1 },
          status: { enum: ["ok", "failed", "indeterminate"] },
          detail: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export const SOURCE_ELIGIBILITY_JSON_SCHEMA = {
  $id: SOURCE_ELIGIBILITY_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: ["schema", "decision", "sourceSha", "policyVersion", "workflow", "requiredJob", "advisory"],
  properties: {
    schema: { const: SOURCE_ELIGIBILITY_SCHEMA_ID },
    decision: { enum: ["eligible", "blocked"] },
    sourceSha: SOURCE_SHA_SCHEMA,
    policyVersion: { type: "string", minLength: 1 },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["path", "event", "branch", "runId", "runAttempt", "status", "conclusion", "url"],
      properties: {
        path: { const: ".github/workflows/ci.yml" },
        event: { const: "push" },
        branch: { const: "main" },
        runId: { type: "integer", minimum: 1 },
        runAttempt: { type: "integer", minimum: 1 },
        status: { const: "completed" },
        conclusion: { type: "string", minLength: 1 },
        url: { type: "string", pattern: "^https://github\\.com/" },
      },
    },
    requiredJob: {
      type: "object",
      additionalProperties: false,
      required: ["name", "status", "conclusion", "url"],
      properties: {
        name: { const: "required" },
        status: { const: "completed" },
        conclusion: { type: "string", minLength: 1 },
        url: { type: "string", pattern: "^https://github\\.com/" },
      },
    },
    advisory: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "conclusion"],
        properties: {
          name: { type: "string", minLength: 1 },
          conclusion: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "identity") {
    process.stderr.write(
      "Usage: bun scripts/release-artifacts.ts identity --channel <stable|dev> --version <x.y.z> --source-sha <sha> --run-number <n> --run-attempt <n> --timestamp <iso>\n",
    );
    process.exit(2);
  }
  const channel = arg("--channel");
  const version = arg("--version");
  const sourceSha = arg("--source-sha");
  const timestamp = arg("--timestamp");
  const runNumber = Number(arg("--run-number"));
  const runAttempt = Number(arg("--run-attempt"));
  if ((channel !== "stable" && channel !== "dev") || !version || !sourceSha || !timestamp) {
    throw new Error("identity requires channel, version, source SHA, timestamp, run number, and run attempt");
  }
  const identity = createReleaseIdentity({
    channel,
    rootVersion: version,
    sourceSha,
    sourceReachableFromMain: true,
    timestamp,
    runNumber,
    runAttempt,
  });
  process.stdout.write(canonicalJson(identity));
}
