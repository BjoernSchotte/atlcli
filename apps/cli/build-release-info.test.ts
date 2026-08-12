import { describe, expect, test } from "bun:test";
import { resolveBuildReleaseInfo } from "./build-release-info";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("CLI build release identity", () => {
  test("keeps the existing build command on the stable channel", () => {
    expect(
      resolveBuildReleaseInfo({ environment: {}, rootVersion: "0.17.2", gitSha: SHA }),
    ).toEqual({
      schema: "atlcli.release-info/v1",
      version: "0.17.2",
      channel: "stable",
      sourceSha: SHA,
      buildId: "v0.17.2",
      releaseTag: "v0.17.2",
      homebrewVersion: "0.17.2",
    });
  });

  test("accepts a complete explicit dev identity", () => {
    expect(
      resolveBuildReleaseInfo({
        environment: {
          ATLCLI_RELEASE_CHANNEL: "dev",
          ATLCLI_RELEASE_VERSION: "0.17.2-dev.20260812.418.2+01234567",
          ATLCLI_SOURCE_SHA: SHA,
          ATLCLI_BUILD_ID: "dev-20260812.418.2-01234567",
          ATLCLI_RELEASE_TAG: "dev-20260812.418.2-01234567",
          ATLCLI_HOMEBREW_VERSION: "20260812021745.418.2",
        },
        rootVersion: "0.17.2",
        gitSha: "unknown",
      }),
    ).toMatchObject({
      channel: "dev",
      sourceSha: SHA,
      buildId: "dev-20260812.418.2-01234567",
    });
  });

  test("fails closed for invalid or incomplete dev inputs", () => {
    expect(() =>
      resolveBuildReleaseInfo({
        environment: { ATLCLI_RELEASE_CHANNEL: "nightly" },
        rootVersion: "0.17.2",
        gitSha: SHA,
      }),
    ).toThrow("Invalid ATLCLI_RELEASE_CHANNEL");
    expect(() =>
      resolveBuildReleaseInfo({
        environment: { ATLCLI_RELEASE_CHANNEL: "dev" },
        rootVersion: "0.17.2",
        gitSha: SHA,
      }),
    ).toThrow("buildId");
  });
});
