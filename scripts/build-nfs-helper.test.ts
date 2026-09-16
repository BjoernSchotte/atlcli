import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNfsHelper, nativeNfsTarget, verifyNfsHelperIdentity } from "./build-nfs-helper.js";
import { NFS_BRIDGE_VERSION } from "../apps/cli/src/vfs/nfs-framing.js";

test("selects native target triples and rejects unsupported platforms", () => {
  expect(nativeNfsTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
  expect(nativeNfsTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
  expect(nativeNfsTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
  expect(nativeNfsTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  expect(() => nativeNfsTarget("win32", "x64")).toThrow("Unsupported");
});

test("rejects helper protocol and architecture mismatches", () => {
  const identity = { name: "atlcli-confluence-nfs", version: "0.1.0", bridgeVersion: NFS_BRIDGE_VERSION, os: "linux", arch: "x86_64" };
  verifyNfsHelperIdentity(identity, "linux", "x64");
  expect(() => verifyNfsHelperIdentity({ ...identity, bridgeVersion: 1 }, "linux", "x64")).toThrow("identity");
  expect(() => verifyNfsHelperIdentity(identity, "darwin", "arm64")).toThrow("identity");
});

test.skipIf(!["darwin", "linux"].includes(process.platform))("refuses to overwrite an existing output before invoking the compiler", () => {
  const output = mkdtempSync(join(tmpdir(), "nfs-build-test-"));
  try {
    writeFileSync(join(output, "keep"), "unchanged");
    expect(() => buildNfsHelper(output)).toThrow("must be empty");
    expect(readFileSync(join(output, "keep"), "utf8")).toBe("unchanged");
  } finally { rmSync(output, { recursive: true, force: true }); }
});
