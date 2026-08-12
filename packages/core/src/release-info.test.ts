import { describe, expect, test } from "bun:test";
import {
  RELEASE_INFO_SCHEMA,
  createReleaseInfo,
  getCurrentVersion,
  getReleaseInfo,
} from "./release-info";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("release info", () => {
  test("preserves the source fallback when no compile-time defines exist", () => {
    expect(getReleaseInfo()).toEqual({
      schema: RELEASE_INFO_SCHEMA,
      version: "dev",
      channel: "source",
      sourceSha: "unknown",
      buildId: "source",
      releaseTag: null,
      homebrewVersion: null,
    });
    expect(getCurrentVersion()).toBe("dev");
  });

  test("creates a complete dev release identity", () => {
    expect(
      createReleaseInfo({
        version: "0.17.2-dev.20260812.418.2+01234567",
        channel: "dev",
        sourceSha: SHA,
        buildId: "dev-20260812.418.2-01234567",
        releaseTag: "dev-20260812.418.2-01234567",
        homebrewVersion: "20260812021745.418.2",
      }),
    ).toEqual({
      schema: "atlcli.release-info/v1",
      version: "0.17.2-dev.20260812.418.2+01234567",
      channel: "dev",
      sourceSha: SHA,
      buildId: "dev-20260812.418.2-01234567",
      releaseTag: "dev-20260812.418.2-01234567",
      homebrewVersion: "20260812021745.418.2",
    });
  });

  test("rejects unverifiable dev provenance", () => {
    expect(() =>
      createReleaseInfo({
        version: "0.17.2-dev.1",
        channel: "dev",
        sourceSha: "unknown",
        buildId: "dev-1",
      }),
    ).toThrow("full source SHA");
    expect(() =>
      createReleaseInfo({
        version: "0.17.2-dev.1",
        channel: "dev",
        sourceSha: SHA.toUpperCase(),
        buildId: "dev-1",
      }),
    ).toThrow("lowercase");
  });
});
