import { describe, expect, it } from "bun:test";
import { createDevReleaseShadowPlan, type ShadowAsset } from "./dev-release-shadow-plan";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "dev-20260812.418.1-01234567";

function assets(): ShadowAsset[] {
  return [
    "atlcli-linux-x64.tar.gz",
    "atlcli-linux-arm64.tar.gz",
    "atlcli-darwin-x64.tar.gz",
    "atlcli-darwin-arm64.tar.gz",
    "atlcli-windows-x64.zip",
    `atlcli-extension-chrome-mv3-${TAG}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ].map((filename, index) => ({ filename, size: index + 1, sha256: index.toString(16).padStart(64, "0") }));
}

describe("dev release shadow plan", () => {
  it("enumerates every GitHub and Homebrew publication write without executing one", () => {
    const result = createDevReleaseShadowPlan({
      sourceSha: SHA,
      tag: TAG,
      stableLatestBefore: "v0.17.2",
      assets: assets(),
      publishHomebrew: true,
    });
    expect(result.mode).toBe("shadow");
    expect(result.executedPublicationMutations).toEqual([]);
    expect(result.stableLatestExpectedAfter).toBe("v0.17.2");
    expect(result.plannedPublicationMutations).toHaveLength(15);
    expect(result.plannedPublicationMutations.filter(({ operation }) => operation === "upload-release-asset")).toHaveLength(10);
    expect(result.plannedPublicationMutations.at(-1)).toMatchObject({
      system: "homebrew-tap",
      operation: "commit-formula-and-pointer",
    });
  });

  it("omits Tap mutations when Homebrew is disabled", () => {
    const result = createDevReleaseShadowPlan({
      sourceSha: SHA,
      tag: TAG,
      stableLatestBefore: "v0.17.2",
      assets: assets(),
      publishHomebrew: false,
    });
    expect(result.plannedPublicationMutations).toHaveLength(13);
    expect(result.plannedPublicationMutations.every(({ system }) => system === "github")).toBe(true);
  });

  it("fails closed for a mismatched tag, incomplete inventory, or invalid digest", () => {
    expect(() => createDevReleaseShadowPlan({
      sourceSha: SHA,
      tag: "dev-20260812.418.1-deadbeef",
      stableLatestBefore: "v0.17.2",
      assets: assets(),
      publishHomebrew: true,
    })).toThrow("bound to the source SHA");
    expect(() => createDevReleaseShadowPlan({
      sourceSha: SHA,
      tag: TAG,
      stableLatestBefore: "v0.17.2",
      assets: assets().slice(1),
      publishHomebrew: true,
    })).toThrow("exactly ten");
    expect(() => createDevReleaseShadowPlan({
      sourceSha: SHA,
      tag: TAG,
      stableLatestBefore: "v0.17.2",
      assets: assets().map((asset, index) => index === 0 ? { ...asset, sha256: "bad" } : asset),
      publishHomebrew: true,
    })).toThrow("invalid shadow asset");
  });
});
