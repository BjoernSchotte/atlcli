import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNfsHelper, nativeNfsTarget, verifyNfsHelperIdentity, verifyNfsCompanion } from "./build-nfs-helper.js";
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

test("companion admission binds file set, source, protocol, digest and executable architecture", () => {
  const source = "a".repeat(40);
  const binary = Buffer.alloc(64);
  binary.set([0x7f, 69, 76, 70, 2, 1]);
  binary.writeUInt16LE(62, 18);
  const receipt = {
    schema: "atlcli.nfs-helper-build/v1", target: "x86_64-unknown-linux-gnu", sourceSha: source, dirty: false,
    sourceTreeSha256: "b".repeat(64), cargoLockSha256: "c".repeat(64),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    identity: { name: "atlcli-confluence-nfs", version: "0.1.0", bridgeVersion: NFS_BRIDGE_VERSION, os: "linux", arch: "x86_64" },
  };
  const entries = (overrides = {}, bytes = binary) => [
    { path: "atlcli-confluence-nfs", bytes, mode: 0o755 },
    { path: "LICENSE-nfsserve", bytes: Buffer.from("Redistribution"), mode: 0o644 },
    { path: "nfs-helper-build.json", bytes: Buffer.from(JSON.stringify({ ...receipt, ...overrides })), mode: 0o644 },
  ];
  verifyNfsCompanion(entries(), "linux-x64", source);
  expect(() => verifyNfsCompanion(entries().slice(0, 2), "linux-x64", source)).toThrow("files");
  expect(() => verifyNfsCompanion(entries(), "linux-arm64", source)).toThrow("provenance");
  expect(() => verifyNfsCompanion(entries(), "linux-x64", "d".repeat(40))).toThrow("provenance");
  expect(() => verifyNfsCompanion(entries({ dirty: true }), "linux-x64", source)).toThrow("provenance");
  verifyNfsCompanion(entries({ dirty: true }), "linux-x64", source, true);
  expect(() => verifyNfsCompanion(entries({ binarySha256: "e".repeat(64) }), "linux-x64", source)).toThrow("checksum");
  expect(() => verifyNfsCompanion(entries({ identity: { ...receipt.identity, bridgeVersion: 1 } }), "linux-x64", source)).toThrow("identity");
  const foreign = Buffer.from(binary); foreign.writeUInt16LE(183, 18);
  const forged = { binarySha256: createHash("sha256").update(foreign).digest("hex") };
  expect(() => verifyNfsCompanion(entries(forged, foreign), "linux-x64", source)).toThrow("architecture");
});
