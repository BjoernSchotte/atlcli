import { describe, expect, test } from "bun:test";
import { verifyNativeCli } from "./verify-native-cli";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "dev-20260812.418.2-01234567";

function devInfo() {
  return {
    schema: "atlcli.release-info/v1",
    version: "0.17.2-dev.20260812.418.2+01234567",
    channel: "dev",
    sourceSha: SHA,
    buildId: TAG,
    releaseTag: TAG,
    homebrewVersion: "20260812153245.418.2",
  };
}

describe("native CLI consumer receipt", () => {
  test("accepts exact dev identity only on the matching native runtime", () => {
    const receipt = verifyNativeCli({
      releaseInfo: devInfo(),
      channel: "dev",
      rootVersion: "0.17.2",
      tag: TAG,
      sourceSha: SHA,
      target: "linux-arm64",
      platform: "linux",
      arch: "arm64",
    });
    expect(receipt.target).toBe("linux-arm64");
    expect(receipt.releaseInfo.sourceSha).toBe(SHA);
  });

  test("blocks emulated or wrong-architecture evidence", () => {
    expect(() => verifyNativeCli({
      releaseInfo: devInfo(),
      channel: "dev",
      rootVersion: "0.17.2",
      tag: TAG,
      sourceSha: SHA,
      target: "linux-arm64",
      platform: "linux",
      arch: "x64",
    })).toThrow("cannot be proven");
  });

  test("blocks source, tag, version, and Homebrew identity drift", () => {
    for (const patch of [
      { sourceSha: "f".repeat(40) },
      { releaseTag: "dev-20260812.419.1-01234567" },
      { version: "0.17.2" },
      { homebrewVersion: "bad" },
    ]) {
      expect(() => verifyNativeCli({
        releaseInfo: { ...devInfo(), ...patch },
        channel: "dev",
        rootVersion: "0.17.2",
        tag: TAG,
        sourceSha: SHA,
        target: "windows-x64",
        platform: "win32",
        arch: "x64",
      })).toThrow();
    }
  });

  test("accepts the unchanged stable release identity", () => {
    expect(verifyNativeCli({
      releaseInfo: {
        schema: "atlcli.release-info/v1",
        version: "0.17.2",
        channel: "stable",
        sourceSha: SHA,
        buildId: "v0.17.2",
        releaseTag: "v0.17.2",
        homebrewVersion: "0.17.2",
      },
      channel: "stable",
      rootVersion: "0.17.2",
      tag: "v0.17.2",
      sourceSha: SHA,
      target: "darwin-x64",
      platform: "darwin",
      arch: "x64",
    }).releaseInfo.channel).toBe("stable");
  });
});
