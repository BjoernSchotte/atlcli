import { afterEach, describe, expect, test } from "bun:test";
import {
  checkForUpdates,
  compareVersions,
  detectInstallMethod,
  type UpdateInfo,
} from "./update";
import type { ReleaseInfoV1 } from "./release-info";

const originalFetch = globalThis.fetch;
const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function releaseInfo(channel: "stable" | "dev" | "source", version: string): ReleaseInfoV1 {
  return {
    schema: "atlcli.release-info/v1",
    channel,
    version,
    sourceSha: channel === "dev" ? SHA : "unknown",
    buildId: channel === "stable" ? `v${version}` : channel,
    releaseTag: channel === "stable" ? `v${version}` : null,
    homebrewVersion: null,
  };
}

describe("semantic version comparison", () => {
  test("orders stable and prerelease versions without NaN coercion", () => {
    expect(compareVersions("v0.17.2", "0.17.2")).toBe(0);
    expect(compareVersions("0.17.2-dev.2", "0.17.2-dev.10")).toBe(-1);
    expect(compareVersions("0.17.2-dev.10", "0.17.2")).toBe(-1);
    expect(compareVersions("0.17.2", "0.17.2-dev.10")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(() => compareVersions("dev", "0.17.2")).toThrow("Invalid semantic version");
  });
});

describe("install method", () => {
  test("distinguishes the dev formula from stable Homebrew", () => {
    expect(detectInstallMethod("/opt/homebrew/Cellar/atlcli-dev/20260812.1/bin/atlcli")).toBe(
      "homebrew-dev",
    );
    expect(detectInstallMethod("/opt/homebrew/Cellar/atlcli/0.17.2/bin/atlcli")).toBe(
      "homebrew",
    );
    expect(detectInstallMethod("/Users/example/.atlcli/bin/atlcli")).toBe("script");
  });
});

describe("channel-aware update checks", () => {
  test("never compares a dev Homebrew build with stable latest", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("stable latest must not be fetched for dev");
    }) as unknown as typeof fetch;

    const result = await checkForUpdates({
      releaseInfo: releaseInfo("dev", "0.17.2-dev.20260812.1.1+01234567"),
      installMethod: "homebrew-dev",
      platform: "darwin-arm64",
    });

    expect(fetched).toBe(false);
    expect(result).toEqual<UpdateInfo>({
      currentVersion: "0.17.2-dev.20260812.1.1+01234567",
      latestVersion: "0.17.2-dev.20260812.1.1+01234567",
      updateAvailable: false,
      downloadUrl: null,
      checksum: null,
      installMethod: "homebrew-dev",
    });
  });

  test("preserves the stable latest-release check", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        tag_name: "v0.17.3",
        name: "v0.17.3",
        prerelease: false,
        assets: [],
      });
    }) as unknown as typeof fetch;

    const result = await checkForUpdates({
      releaseInfo: releaseInfo("stable", "0.17.2"),
      installMethod: "homebrew",
      platform: "darwin-arm64",
    });

    expect(urls).toEqual(["https://api.github.com/repos/BjoernSchotte/atlcli/releases/latest"]);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("0.17.3");
    expect(result.installMethod).toBe("homebrew");
  });
});
