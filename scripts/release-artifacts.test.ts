import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import {
  BUILD_METADATA_JSON_SCHEMA,
  BUILD_METADATA_SCHEMA_ID,
  SECURITY_ATTESTATION_JSON_SCHEMA,
  SECURITY_ATTESTATION_SCHEMA_ID,
  SOURCE_ELIGIBILITY_JSON_SCHEMA,
  SOURCE_ELIGIBILITY_SCHEMA_ID,
  assertExpectedReleaseAssets,
  canonicalJson,
  createReleaseIdentity,
  decidePublication,
  expectedReleaseAssetNames,
  normalizeArtifactDigests,
  renderChecksums,
  sha256Text,
  type ReleaseIdentity,
} from "./release-artifacts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SAME_SHORT_SHA = "01234567ffffffffffffffffffffffffffffffff";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function devIdentity(overrides: Partial<Parameters<typeof createReleaseIdentity>[0]> = {}) {
  return createReleaseIdentity({
    channel: "dev",
    rootVersion: "0.17.2",
    sourceSha: SHA,
    sourceReachableFromMain: true,
    timestamp: "2026-08-12T02:17:45.000Z",
    runNumber: 418,
    runAttempt: 2,
    ...overrides,
  });
}

describe("release identity", () => {
  test("creates stable identity without a prerelease version", () => {
    expect(
      createReleaseIdentity({
        channel: "stable",
        rootVersion: "0.17.2",
        sourceSha: SHA,
        sourceReachableFromMain: true,
        timestamp: "2026-08-12T02:17:45Z",
        runNumber: 1,
        runAttempt: 1,
      }),
    ).toEqual({
      channel: "stable",
      rootVersion: "0.17.2",
      sourceSha: SHA,
      shortSha: "01234567",
      buildId: "v0.17.2",
      releaseTag: "v0.17.2",
      cliVersion: "0.17.2",
      extensionVersion: "0.17.2",
      extensionVersionName: "0.17.2",
      homebrewVersion: "0.17.2",
      createdAt: "2026-08-12T02:17:45.000Z",
      runNumber: 1,
      runAttempt: 1,
    });
  });

  test("creates immutable dev, SemVer, Chrome, and Homebrew identities", () => {
    expect(devIdentity()).toEqual({
      channel: "dev",
      rootVersion: "0.17.2",
      sourceSha: SHA,
      shortSha: "01234567",
      buildId: "dev-20260812.418.2-01234567",
      releaseTag: "dev-20260812.418.2-01234567",
      cliVersion: "0.17.2-dev.20260812.418.2+01234567",
      extensionVersion: "0.17.2.418",
      extensionVersionName: "0.17.2-dev.20260812.418.2-01234567",
      homebrewVersion: "20260812021745.418.2",
      createdAt: "2026-08-12T02:17:45.000Z",
      runNumber: 418,
      runAttempt: 2,
    });
  });

  test("accepts the largest Chrome extension component and rejects overflow", () => {
    expect(devIdentity({ extensionBuildSequence: 65535 }).extensionVersion).toBe(
      "0.17.2.65535",
    );
    expect(() => devIdentity({ extensionBuildSequence: 65536 })).toThrow("65535");
    expect(() => devIdentity({ extensionBuildSequence: 0 })).toThrow("extensionBuildSequence");
  });

  test("rejects invalid root versions, source SHAs, reachability, runs, and dates", () => {
    for (const rootVersion of ["0.17", "01.17.2", "0.17.2-dev", "0.17.65536"]) {
      expect(() => devIdentity({ rootVersion })).toThrow();
    }
    expect(() => devIdentity({ sourceSha: SHA.toUpperCase() })).toThrow("lowercase");
    expect(() => devIdentity({ sourceReachableFromMain: false })).toThrow("origin/main");
    expect(() => devIdentity({ runNumber: 0 })).toThrow("runNumber");
    expect(() => devIdentity({ runAttempt: 0 })).toThrow("runAttempt");
    expect(() => devIdentity({ timestamp: "not-a-date" })).toThrow("ISO-8601");
  });

  test("keeps the hard asset contract sorted and complete", () => {
    const identity = devIdentity();
    const expected = [
      "atlcli-darwin-arm64.tar.gz",
      "atlcli-darwin-x64.tar.gz",
      "atlcli-extension-chrome-mv3-dev-20260812.418.2-01234567.zip",
      "atlcli-linux-arm64.tar.gz",
      "atlcli-linux-x64.tar.gz",
      "atlcli-windows-x64.zip",
      "build-metadata.json",
      "checksums.txt",
      "security-attestation.json",
      "source-eligibility.json",
    ];
    expect(expectedReleaseAssetNames(identity)).toEqual(expected);
    expect(assertExpectedReleaseAssets(identity, [...expected].reverse())).toEqual(expected);
    expect(() => assertExpectedReleaseAssets(identity, expected.slice(1))).toThrow("missing=");
    expect(() => assertExpectedReleaseAssets(identity, [...expected, "unexpected.zip"])).toThrow(
      "extra=",
    );
    expect(() => assertExpectedReleaseAssets(identity, [...expected, expected[0]!])).toThrow(
      "duplicate",
    );
  });
});

describe("artifact metadata primitives", () => {
  test("sorts checksums and terminates the file with one newline", () => {
    expect(
      renderChecksums([
        { name: "z.zip", size: 2, sha256: DIGEST_B.toUpperCase() },
        { name: "a.tar.gz", size: 1, sha256: DIGEST_A },
      ]),
    ).toBe(`${DIGEST_A}  a.tar.gz\n${DIGEST_B}  z.zip\n`);
  });

  test("rejects duplicate, unsafe, malformed, and non-positive artifact records", () => {
    expect(() =>
      normalizeArtifactDigests([
        { name: "a.zip", size: 1, sha256: DIGEST_A },
        { name: "a.zip", size: 1, sha256: DIGEST_A },
      ]),
    ).toThrow("duplicate");
    expect(() =>
      normalizeArtifactDigests([{ name: "../a.zip", size: 1, sha256: DIGEST_A }]),
    ).toThrow("name");
    expect(() =>
      normalizeArtifactDigests([{ name: "a.zip", size: -1, sha256: DIGEST_A }]),
    ).toThrow("size");
    expect(() =>
      normalizeArtifactDigests([{ name: "a.zip", size: 0, sha256: DIGEST_A }]),
    ).toThrow("size");
    expect(() =>
      normalizeArtifactDigests([{ name: "a.zip", size: 1, sha256: "nope" }]),
    ).toThrow("sha256");
  });

  test("renders nested objects canonically", () => {
    const rendered = canonicalJson({ z: 1, a: { z: 2, a: 1 } });
    expect(rendered).toBe('{\n  "a": {\n    "a": 1,\n    "z": 2\n  },\n  "z": 1\n}\n');
    expect(sha256Text(rendered)).toHaveLength(64);
  });
});

describe("publication decision", () => {
  function existing(
    identity: ReleaseIdentity,
    overrides: Partial<{ tag: string; sourceSha: string; complete: boolean }> = {},
  ) {
    return {
      tag: identity.releaseTag,
      sourceSha: identity.sourceSha,
      complete: true,
      ...overrides,
    };
  }

  test("creates when no release exists", () => {
    const requested = devIdentity();
    expect(decidePublication({ requested, existing: [], forceRebuild: false })).toEqual({
      decision: "create",
      tag: requested.releaseTag,
    });
  });

  test("returns a no-op for an already proven SHA", () => {
    const requested = devIdentity({ runNumber: 419 });
    expect(
      decidePublication({
        requested,
        existing: [existing(requested, { tag: "dev-20260812.418.1-01234567" })],
        forceRebuild: false,
      }),
    ).toEqual({
      decision: "noop",
      tag: "dev-20260812.418.1-01234567",
      reason: "source-already-proven",
    });
  });

  test("force rebuild creates a new tag but never overwrites the same tag", () => {
    const requested = devIdentity({ runNumber: 419 });
    expect(
      decidePublication({
        requested,
        existing: [existing(requested, { tag: "dev-20260812.418.1-01234567" })],
        forceRebuild: true,
      }),
    ).toEqual({ decision: "create", tag: requested.releaseTag });
    expect(
      decidePublication({
        requested,
        existing: [existing(requested)],
        forceRebuild: true,
      }).decision,
    ).toBe("hard-conflict");
  });

  test("fails closed for incomplete releases and short-SHA collisions", () => {
    const requested = devIdentity();
    expect(
      decidePublication({
        requested,
        existing: [existing(requested, { tag: "dev-20260811.417.1-01234567", complete: false })],
        forceRebuild: false,
      }).decision,
    ).toBe("hard-conflict");
    expect(
      decidePublication({
        requested,
        existing: [existing(requested, { sourceSha: OTHER_SAME_SHORT_SHA })],
        forceRebuild: false,
      }),
    ).toEqual({
      decision: "hard-conflict",
      tag: requested.releaseTag,
      reason: "requested tag already belongs to a different full source SHA",
    });
  });
});

describe("release receipt schemas", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateBuildMetadata = ajv.compile(BUILD_METADATA_JSON_SCHEMA);
  const validateSecurity = ajv.compile(SECURITY_ATTESTATION_JSON_SCHEMA);
  const validateEligibility = ajv.compile(SOURCE_ELIGIBILITY_JSON_SCHEMA);

  test("accepts complete versioned receipts", () => {
    expect(
      validateBuildMetadata({
        schema: BUILD_METADATA_SCHEMA_ID,
        channel: "dev",
        rootVersion: "0.17.2",
        sourceSha: SHA,
        sourceRef: "refs/heads/main",
        releaseTag: "dev-20260812.418.2-01234567",
        buildId: "dev-20260812.418.2-01234567",
        run: {
          id: 123,
          attempt: 2,
          event: "workflow_dispatch",
          createdAt: "2026-08-12T02:17:45.000Z",
        },
        toolchain: { bun: "1.3.14", wxt: "0.20.27", runnerOs: "Linux" },
        lockfileSha256: DIGEST_A,
        artifacts: [{ name: "atlcli-linux-x64.tar.gz", size: 1, sha256: DIGEST_B }],
        extension: {
          contentTreeSha256: DIGEST_A,
          manifestSha256: DIGEST_B,
          cspSha256: DIGEST_A,
          permissionsSha256: DIGEST_B,
        },
        sourceEligibilitySha256: DIGEST_A,
      }),
    ).toBe(true);
    expect(
      validateSecurity({
        schema: SECURITY_ATTESTATION_SCHEMA_ID,
        commit: SHA,
        date: "2026-08-12T02:17:45.000Z",
        veraPdfDigestOk: null,
        veraPdfBaselineDelta: null,
        securityReviewNote: "reviewed",
        m1AcceptanceOk: null,
        checks: [{ field: "veraPdfDigestOk", status: "indeterminate", detail: "not installed" }],
      }),
    ).toBe(true);
    expect(
      validateEligibility({
        schema: SOURCE_ELIGIBILITY_SCHEMA_ID,
        decision: "eligible",
        sourceSha: SHA,
        policyVersion: "1",
        workflow: {
          path: ".github/workflows/ci.yml",
          event: "push",
          branch: "main",
          runId: 123,
          runAttempt: 2,
          status: "completed",
          conclusion: "success",
          url: "https://github.com/BjoernSchotte/atlcli/actions/runs/123",
        },
        requiredJob: {
          name: "required",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/BjoernSchotte/atlcli/actions/runs/123/job/456",
        },
        advisory: [],
      }),
    ).toBe(true);
  });

  test("rejects missing, unknown, and malformed receipt fields", () => {
    expect(validateBuildMetadata({ schema: BUILD_METADATA_SCHEMA_ID })).toBe(false);
    expect(
      validateSecurity({
        schema: SECURITY_ATTESTATION_SCHEMA_ID,
        commit: SHA,
        date: "2026-08-12T02:17:45.000Z",
        veraPdfDigestOk: null,
        veraPdfBaselineDelta: null,
        securityReviewNote: "reviewed",
        m1AcceptanceOk: null,
        checks: [],
        unexpected: true,
      }),
    ).toBe(false);
    expect(
      validateEligibility({
        schema: SOURCE_ELIGIBILITY_SCHEMA_ID,
        decision: "eligible",
        sourceSha: "short",
      }),
    ).toBe(false);
  });
});
