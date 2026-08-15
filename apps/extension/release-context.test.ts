import { describe, expect, test } from "bun:test";
import {
  resolveExtensionReleaseContext,
  validateChromeExtensionVersion,
} from "./release-context";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("extension release context", () => {
  test("keeps ordinary source builds explicitly non-release", () => {
    expect(resolveExtensionReleaseContext({})).toEqual({
      channel: "source",
      sourceSha: "unknown",
      buildId: "source",
      version: "0.0.0",
      versionName: "source",
      artifactName: "atlcli-extension-chrome-mv3-source.zip",
    });
  });

  test("binds dev manifest and artifact names to validated release inputs", () => {
    expect(
      resolveExtensionReleaseContext({
        ATLCLI_RELEASE_CHANNEL: "dev",
        ATLCLI_SOURCE_SHA: SHA,
        ATLCLI_BUILD_ID: "dev-20260812.418.2-01234567",
        ATLCLI_EXTENSION_VERSION: "0.17.2.418",
        ATLCLI_EXTENSION_VERSION_NAME: "0.17.2-dev.20260812.418.2-01234567",
      }),
    ).toEqual({
      channel: "dev",
      sourceSha: SHA,
      buildId: "dev-20260812.418.2-01234567",
      version: "0.17.2.418",
      versionName: "0.17.2-dev.20260812.418.2-01234567",
      artifactName: "atlcli-extension-chrome-mv3-dev-20260812.418.2-01234567.zip",
    });
  });

  test("enforces Chrome numeric boundaries and release completeness", () => {
    expect(validateChromeExtensionVersion("0.0.0.0")).toBe("0.0.0.0");
    expect(validateChromeExtensionVersion("65535.65535.65535.65535")).toBe(
      "65535.65535.65535.65535",
    );
    for (const invalid of ["", "1.2.3.4.5", "1.2.65536", "01.2.3", "1.a.3"]) {
      expect(() => validateChromeExtensionVersion(invalid)).toThrow();
    }
    expect(() =>
      resolveExtensionReleaseContext({
        ATLCLI_RELEASE_CHANNEL: "dev",
        ATLCLI_SOURCE_SHA: SHA,
      }),
    ).toThrow("build ID");
    expect(() =>
      resolveExtensionReleaseContext({ ATLCLI_BUILD_ID: "dev-without-channel" }),
    ).toThrow("explicit stable or dev");
  });
});
