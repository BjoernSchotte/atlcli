import { describe, expect, test } from "bun:test";
import { CLI_TARGETS, cliAssetName, createReleaseIdentity } from "../release-artifacts";
import { resolveDevPublication } from "./dev-release-decision";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function identity(runNumber = 418) {
  return createReleaseIdentity({
    channel: "dev",
    rootVersion: "0.17.2",
    sourceSha: SHA,
    sourceReachableFromMain: true,
    timestamp: "2026-08-12T02:17:45Z",
    runNumber,
    runAttempt: 1,
  });
}

function names(buildId: string): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${buildId}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ];
}

function release(buildId: string, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: buildId,
    draft: false,
    prerelease: true,
    assets: names(buildId).map((name) => ({
      name,
      browser_download_url: `https://github.com/BjoernSchotte/atlcli/releases/download/${buildId}/${name}`,
    })),
    ...overrides,
  };
}

describe("dev release publication decision", () => {
  test("creates when no prior dev release exists", async () => {
    const requested = identity();
    const result = await resolveDevPublication({
      requested,
      forceRebuild: false,
      releases: [],
      loadMetadata: async () => { throw new Error("not called"); },
    });
    expect(result).toMatchObject({ decision: "create", selectedTag: requested.releaseTag });
  });

  test("returns a no-op only for a complete immutable prerelease bound to the full SHA", async () => {
    const old = identity(417);
    const requested = identity(418);
    const result = await resolveDevPublication({
      requested,
      forceRebuild: false,
      releases: [release(old.releaseTag)],
      loadMetadata: async () => ({
        channel: "dev",
        sourceSha: SHA,
        buildId: old.buildId,
        releaseTag: old.releaseTag,
      }),
    });
    expect(result).toMatchObject({
      decision: "noop",
      selectedTag: old.releaseTag,
      reason: "source-already-proven",
    });
  });

  test("force rebuild creates a new tag but does not bypass an exact-tag conflict", async () => {
    const old = identity(417);
    const requested = identity(418);
    const forced = await resolveDevPublication({
      requested,
      forceRebuild: true,
      releases: [release(old.releaseTag)],
      loadMetadata: async () => ({
        channel: "dev",
        sourceSha: SHA,
        buildId: old.buildId,
        releaseTag: old.releaseTag,
      }),
    });
    expect(forced.decision).toBe("create");

    const conflict = await resolveDevPublication({
      requested,
      forceRebuild: true,
      releases: [release(requested.releaseTag)],
      loadMetadata: async () => ({
        channel: "dev",
        sourceSha: SHA,
        buildId: requested.buildId,
        releaseTag: requested.releaseTag,
      }),
    });
    expect(conflict.decision).toBe("hard-conflict");
  });

  test("fails closed for incomplete, mutable, or unreadable same-SHA releases", async () => {
    const old = identity(417);
    const requested = identity(418);
    for (const candidate of [
      release(old.releaseTag, { draft: true }),
      release(old.releaseTag, { prerelease: false }),
      release(old.releaseTag, { assets: release(old.releaseTag).assets.slice(1) }),
    ]) {
      const result = await resolveDevPublication({
        requested,
        forceRebuild: false,
        releases: [candidate],
        loadMetadata: async () => ({
          channel: "dev",
          sourceSha: SHA,
          buildId: old.buildId,
          releaseTag: old.releaseTag,
        }),
      });
      expect(result.decision).toBe("hard-conflict");
    }

    const unreadable = await resolveDevPublication({
      requested,
      forceRebuild: false,
      releases: [release(old.releaseTag)],
      loadMetadata: async () => { throw new Error("bad metadata"); },
    });
    expect(unreadable.decision).toBe("hard-conflict");
  });

  test("ignores stable releases entirely", async () => {
    const requested = identity();
    const result = await resolveDevPublication({
      requested,
      forceRebuild: false,
      releases: [release("v0.17.2")],
      loadMetadata: async () => { throw new Error("stable metadata must not be loaded"); },
    });
    expect(result.decision).toBe("create");
    expect(result.inspectedDevReleases).toBe(0);
  });
});
