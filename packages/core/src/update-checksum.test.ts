import { describe, expect, test } from "bun:test";
import { findChecksum, verifyAssetChecksum } from "./update-checksum";

const ASSET = "atlcli-darwin-arm64.tar.gz";
const DIGEST = "a".repeat(64);
const CHECKSUMS = `${"b".repeat(64)}  atlcli-linux-x64.tar.gz\n${DIGEST}  ${ASSET}\n`;

describe("update checksum verification", () => {
  test("a missing checksums file aborts the update", () => {
    expect(() => verifyAssetChecksum(null, ASSET, DIGEST)).toThrow("checksums.txt is missing");
  });

  test("no entry for the asset aborts the update", () => {
    expect(() => verifyAssetChecksum(CHECKSUMS, "atlcli-windows-x64.tar.gz", DIGEST)).toThrow(
      "no entry for atlcli-windows-x64.tar.gz"
    );
    expect(() => verifyAssetChecksum("", ASSET, DIGEST)).toThrow("no entry for");
  });

  test("a mismatching digest aborts the update", () => {
    expect(() => verifyAssetChecksum(CHECKSUMS, ASSET, "c".repeat(64))).toThrow(
      "Checksum verification failed"
    );
  });

  test("a matching digest passes", () => {
    expect(() => verifyAssetChecksum(CHECKSUMS, ASSET, DIGEST)).not.toThrow();
    expect(findChecksum(CHECKSUMS, ASSET)).toBe(DIGEST);
  });
});
