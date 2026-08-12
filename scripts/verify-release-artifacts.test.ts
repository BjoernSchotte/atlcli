import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  canonicalJson,
  cliAssetName,
  normalizeArtifactDigests,
  renderChecksums,
  type ArtifactDigest,
} from "./release-artifacts";
import {
  deterministicTarGz,
  deterministicZip,
  executableEntry,
  readReleaseTree,
  releaseTreeDigest,
} from "./release-archive";
import {
  inspectSingleBinaryTarGz,
  inspectZipCentralDirectory,
  verifyReleaseArtifacts,
} from "./verify-release-artifacts";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const BUILD_ID = "dev-20260812.418.2-01234567";
const CLI_VERSION = "0.17.2-dev.20260812.418.2+01234567";
const EXTENSION_VERSION_NAME = "0.17.2-dev.20260812.418.2-01234567";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixture(input: { manifestPath?: string; forbiddenPath?: string } = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atlcli-release-verifier-"));
  const extension = join(root, "extension-source");
  const manifest = {
    manifest_version: 3,
    name: "atlcli",
    version: "0.17.2.418",
    version_name: EXTENSION_VERSION_NAME,
    permissions: ["storage", "tabs"],
    host_permissions: ["https://*.atlassian.net/*"],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    background: { service_worker: "background.js", type: "module" },
  };
  const manifestText = JSON.stringify(manifest);
  await Bun.write(join(extension, input.manifestPath ?? "manifest.json"), manifestText);
  await Bun.write(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  if (input.forbiddenPath) await Bun.write(join(extension, input.forbiddenPath), "forbidden fixture\n");

  const artifactDigests: ArtifactDigest[] = [];
  const binary = new TextEncoder().encode([
    "atlcli.release-info/v1",
    CLI_VERSION,
    SOURCE_SHA,
    BUILD_ID,
    BUILD_ID,
    "20260812021745.418.2",
  ].join("\0"));
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const) {
    const bytes = deterministicTarGz(executableEntry("atlcli", binary));
    const name = cliAssetName(target);
    writeFileSync(join(root, name), bytes);
    artifactDigests.push({ name, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  const windows = await deterministicZip([executableEntry("atlcli.exe", binary)]);
  const windowsName = cliAssetName("windows-x64");
  writeFileSync(join(root, windowsName), windows);
  artifactDigests.push({ name: windowsName, size: windows.byteLength, sha256: sha256(windows) });

  const extensionEntries = readReleaseTree(extension);
  const extensionZip = await deterministicZip(extensionEntries);
  const extensionName = `atlcli-extension-chrome-mv3-${BUILD_ID}.zip`;
  writeFileSync(join(root, extensionName), extensionZip);
  artifactDigests.push({
    name: extensionName,
    size: extensionZip.byteLength,
    sha256: sha256(extensionZip),
  });

  const security = canonicalJson({
    schema: "atlcli.security-attestation/v1",
    commit: SOURCE_SHA,
    date: "2026-08-12T02:17:45.000Z",
    veraPdfDigestOk: null,
    veraPdfBaselineDelta: null,
    securityReviewNote: "Synthetic verifier fixture; not a publication attestation.",
    m1AcceptanceOk: null,
    checks: [{ field: "fixture", status: "indeterminate", detail: "Unit-test fixture." }],
  });
  writeFileSync(join(root, "security-attestation.json"), security);
  artifactDigests.push({
    name: "security-attestation.json",
    size: Buffer.byteLength(security),
    sha256: sha256(security),
  });

  const eligibility = canonicalJson({
    schema: "atlcli.source-eligibility/v1",
    decision: "eligible",
    sourceSha: SOURCE_SHA,
    policyVersion: "fixture/v1",
    workflow: {
      path: ".github/workflows/ci.yml",
      event: "push",
      branch: "main",
      runId: 1,
      runAttempt: 1,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/BjoernSchotte/atlcli/actions/runs/1",
    },
    requiredJob: {
      name: "required",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/BjoernSchotte/atlcli/actions/runs/1/job/1",
    },
    advisory: [],
  });
  writeFileSync(join(root, "source-eligibility.json"), eligibility);
  artifactDigests.push({
    name: "source-eligibility.json",
    size: Buffer.byteLength(eligibility),
    sha256: sha256(eligibility),
  });

  const normalized = normalizeArtifactDigests(artifactDigests);
  const metadata = canonicalJson({
    schema: "atlcli.build-metadata/v1",
    channel: "dev",
    rootVersion: "0.17.2",
    sourceSha: SOURCE_SHA,
    sourceRef: "refs/heads/main",
    releaseTag: BUILD_ID,
    buildId: BUILD_ID,
    run: {
      id: 1,
      attempt: 2,
      event: "workflow_dispatch",
      createdAt: "2026-08-12T02:17:45.000Z",
    },
    toolchain: { bun: "1.3.14", wxt: "0.20.27", runnerOs: "fixture" },
    lockfileSha256: "a".repeat(64),
    artifacts: normalized,
    extension: {
      contentTreeSha256: releaseTreeDigest(extensionEntries),
      manifestSha256: sha256(manifestText),
      cspSha256: sha256(canonicalJson(manifest.content_security_policy)),
      permissionsSha256: sha256(canonicalJson({
        hostPermissions: [...manifest.host_permissions].sort(),
        permissions: [...manifest.permissions].sort(),
      })),
    },
    sourceEligibilitySha256: sha256(eligibility),
  });
  writeFileSync(join(root, "build-metadata.json"), metadata);
  writeFileSync(join(root, "checksums.txt"), renderChecksums(normalized));
  rmSync(extension, { recursive: true, force: true });
  return root;
}

function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const output = new Uint8Array(bytes);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  for (let index = 0; index <= output.byteLength - source.byteLength; index++) {
    if (Buffer.from(output.subarray(index, index + source.byteLength)).equals(source)) {
      output.set(replacement, index);
    }
  }
  return output;
}

describe("release artifact verifier", () => {
  test("verifies exact CLI, extension, metadata, eligibility, and attestation bytes", async () => {
    const root = await writeFixture();
    try {
      const receipt = await verifyReleaseArtifacts({
        directory: root,
        extractExtensionDirectory: join(root, "extracted"),
        verifyExtensionRuntime: false,
      });
      expect(receipt.sourceSha).toBe(SOURCE_SHA);
      expect(receipt.verifiedArtifacts).toHaveLength(8);
      expect(receipt.extension.entryCount).toBe(2);
      expect(receipt.extension.outputScan).toBe("not-run");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${join(root, "extracted")}.atlcli-release-extraction-v1`, { force: true });
    }
  });

  test("fails closed for a changed byte, wrong source binding, or missing asset", async () => {
    for (const mutation of ["byte", "source", "failed-attestation", "missing"] as const) {
      const root = await writeFixture();
      try {
        if (mutation === "byte") {
          const path = join(root, cliAssetName("linux-x64"));
          const bytes = readFileSync(path);
          bytes[bytes.byteLength - 1] ^= 1;
          writeFileSync(path, bytes);
        } else if (mutation === "source") {
          const path = join(root, "security-attestation.json");
          const value = JSON.parse(readFileSync(path, "utf8")) as { commit: string };
          value.commit = "f".repeat(40);
          writeFileSync(path, canonicalJson(value));
        } else if (mutation === "failed-attestation") {
          const path = join(root, "security-attestation.json");
          const value = JSON.parse(readFileSync(path, "utf8")) as {
            checks: { field: string; status: string; detail: string }[];
          };
          value.checks[0]!.status = "failed";
          writeFileSync(path, canonicalJson(value));
        } else {
          rmSync(join(root, cliAssetName("darwin-x64")));
        }
        await expect(
          verifyReleaseArtifacts({ directory: root, verifyExtensionRuntime: false }),
        ).rejects.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(`${join(root, "extension")}.atlcli-release-extraction-v1`, { force: true });
      }
    }
  });

  test("rejects an extension without a root manifest", async () => {
    const root = await writeFixture({ manifestPath: "nested/manifest.json" });
    try {
      await expect(
        verifyReleaseArtifacts({ directory: root, verifyExtensionRuntime: false }),
      ).rejects.toThrow("root manifest.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${join(root, "extension")}.atlcli-release-extraction-v1`, { force: true });
    }
  });

  test("rejects forbidden source files before browser execution", async () => {
    const root = await writeFixture({ forbiddenPath: "src/leak.ts" });
    try {
      await expect(
        verifyReleaseArtifacts({ directory: root, verifyExtensionRuntime: false }),
      ).rejects.toThrow("forbidden extension files");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${join(root, "extension")}.atlcli-release-extraction-v1`, { force: true });
    }
  });
});

describe("archive safety", () => {
  test("reads a single executable TAR entry and rejects a changed header", () => {
    const archive = deterministicTarGz(executableEntry("atlcli", new TextEncoder().encode("binary")));
    expect(inspectSingleBinaryTarGz(archive)).toMatchObject({ name: "atlcli", mode: 0o755 });
    const changed = new Uint8Array(archive);
    changed[20] ^= 1;
    expect(() => inspectSingleBinaryTarGz(changed)).toThrow();
  });

  test("rejects traversal, duplicate, symlink, and oversized ZIP entries", async () => {
    const traversal = new JSZip();
    traversal.file("../evil.js", "evil");
    await expect(
      Promise.resolve(traversal.generateAsync({ type: "uint8array" })).then(inspectZipCentralDirectory),
    ).rejects.toThrow("unsafe archive path");

    for (const unsafePath of ["/absolute.js", "C:/drive.js"]) {
      const unsafe = new JSZip();
      unsafe.file(unsafePath, "evil");
      const unsafeBytes = await unsafe.generateAsync({ type: "uint8array" });
      expect(() => inspectZipCentralDirectory(unsafeBytes)).toThrow("unsafe archive path");
    }

    const duplicate = new JSZip();
    duplicate.file("one-a.js", "a");
    duplicate.file("two-b.js", "b");
    const duplicateBytes = replaceAscii(
      await duplicate.generateAsync({ type: "uint8array" }),
      "two-b.js",
      "one-a.js",
    );
    expect(() => inspectZipCentralDirectory(duplicateBytes)).toThrow("duplicate ZIP entry");

    const portableCollision = new JSZip();
    portableCollision.file("Chunk.js", "a");
    portableCollision.file("chunk.js", "b");
    const collisionBytes = await portableCollision.generateAsync({ type: "uint8array" });
    expect(() => inspectZipCentralDirectory(collisionBytes)).toThrow("portable ZIP path collision");

    const symlink = new JSZip();
    symlink.file("link", "target", { unixPermissions: 0o120777 });
    const symlinkBytes = await symlink.generateAsync({ type: "uint8array", platform: "UNIX" });
    expect(() => inspectZipCentralDirectory(symlinkBytes)).toThrow("symlink");

    const oversized = new JSZip();
    oversized.file("large.bin", new Uint8Array(32));
    const oversizedBytes = await oversized.generateAsync({ type: "uint8array" });
    expect(() => inspectZipCentralDirectory(oversizedBytes, { maxEntrySize: 16 })).toThrow(
      "size limit",
    );

    const total = new JSZip();
    total.file("first.bin", new Uint8Array(10));
    total.file("second.bin", new Uint8Array(10));
    const totalBytes = await total.generateAsync({ type: "uint8array" });
    expect(() => inspectZipCentralDirectory(totalBytes, { maxTotalSize: 15 })).toThrow(
      "total uncompressed size",
    );

    const compressed = new JSZip();
    compressed.file("compressible.bin", new Uint8Array(1_024));
    const compressedBytes = await compressed.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(() => inspectZipCentralDirectory(compressedBytes, { maxRatio: 2 })).toThrow(
      "compression ratio",
    );
  });
});
