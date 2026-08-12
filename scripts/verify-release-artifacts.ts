#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import Ajv from "ajv";
import JSZip from "jszip";
import {
  collectArtifacts,
  scanOutputDir,
  validateExtensionArtifactInventory,
} from "../apps/extension/scripts/check-output-build.js";
import {
  BUILD_METADATA_JSON_SCHEMA,
  CLI_TARGETS,
  SECURITY_ATTESTATION_JSON_SCHEMA,
  SOURCE_ELIGIBILITY_JSON_SCHEMA,
  canonicalJson,
  cliAssetName,
  normalizeArtifactDigests,
  type ArtifactDigest,
} from "./release-artifacts.js";
import { readReleaseTree, releaseTreeDigest } from "./release-archive.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXTENSION_MARKER_SUFFIX = ".atlcli-release-extraction-v1";
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_ENTRY_SIZE = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_SIZE = 256 * 1024 * 1024;
const MAX_ZIP_RATIO = 1_000;

interface BuildMetadata {
  schema: "atlcli.build-metadata/v1";
  channel: "stable" | "dev";
  rootVersion: string;
  sourceSha: string;
  sourceRef: string;
  releaseTag: string;
  buildId: string;
  run: { id: number; attempt: number; event: string; createdAt: string };
  toolchain: { bun: string; wxt: string; runnerOs: string };
  lockfileSha256: string;
  artifacts: ArtifactDigest[];
  extension: {
    contentTreeSha256: string;
    manifestSha256: string;
    cspSha256: string;
    permissionsSha256: string;
  };
  sourceEligibilitySha256: string;
}

interface SecurityAttestation {
  schema: "atlcli.security-attestation/v1";
  commit: string;
  veraPdfDigestOk: boolean | null;
  m1AcceptanceOk: boolean | null;
  checks: { status: "ok" | "failed" | "indeterminate" }[];
}

interface SourceEligibility {
  schema: "atlcli.source-eligibility/v1";
  decision: "eligible" | "blocked";
  sourceSha: string;
  workflow: { conclusion: string };
  requiredJob: { conclusion: string };
}

interface ExtractedExtensionInspection {
  entries: ZipCentralEntry[];
  manifestBytes: Buffer;
  manifest: {
    version?: string;
    version_name?: string;
    permissions?: string[];
    host_permissions?: string[];
    content_security_policy?: unknown;
  };
  fingerprints: BuildMetadata["extension"];
  outputScan: "success" | "not-run";
}

export interface ZipCentralEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localHeaderOffset: number;
}

export interface ReleaseVerificationReceipt {
  schema: "atlcli.release-verification/v1";
  sourceSha: string;
  channel: "stable" | "dev";
  buildId: string;
  releaseTag: string;
  verifiedArtifacts: ArtifactDigest[];
  extension: {
    extractedDirectory: string;
    contentTreeSha256: string;
    manifestSha256: string;
    cspSha256: string;
    permissionsSha256: string;
    entryCount: number;
    outputScan: "success" | "not-run";
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes("\0") ||
    components.includes("") ||
    components.includes(".") ||
    components.includes("..")
  ) {
    throw new Error(`unsafe archive path: ${path}`);
  }
  return normalized;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) throw new Error("ZIP archive is too short");
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === bytes.byteLength
    ) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

export function inspectZipCentralDirectory(
  bytes: Uint8Array,
  limits: {
    maxEntries?: number;
    maxEntrySize?: number;
    maxTotalSize?: number;
    maxRatio?: number;
  } = {},
): ZipCentralEntry[] {
  const buffer = Buffer.from(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("multi-disk ZIP archives are not supported");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for the extension artifact");
  }
  if (eocd + 22 + commentLength !== bytes.byteLength) {
    throw new Error("ZIP end-of-central-directory comment length is inconsistent");
  }
  if (entryCount > (limits.maxEntries ?? MAX_ZIP_ENTRIES)) {
    throw new Error(`ZIP entry count exceeds limit: ${entryCount}`);
  }
  if (centralOffset + centralSize !== eocd) {
    throw new Error("ZIP central-directory boundaries are inconsistent");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipCentralEntry[] = [];
  const seen = new Set<string>();
  const portableSeen = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid ZIP central-directory entry ${index}`);
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw new Error(`truncated ZIP central-directory entry ${index}`);
    if ((flags & 0x1) !== 0) throw new Error("encrypted ZIP entries are forbidden");
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method: ${method}`);
    const path = safeArchivePath(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    if (seen.has(path)) throw new Error(`duplicate ZIP entry: ${path}`);
    seen.add(path);
    const portablePath = path.normalize("NFC").toLowerCase();
    if (portableSeen.has(portablePath)) throw new Error(`portable ZIP path collision: ${path}`);
    portableSeen.add(portablePath);

    const maxEntrySize = limits.maxEntrySize ?? MAX_ZIP_ENTRY_SIZE;
    if (uncompressedSize > maxEntrySize) throw new Error(`ZIP entry exceeds size limit: ${path}`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > (limits.maxTotalSize ?? MAX_ZIP_TOTAL_SIZE)) {
      throw new Error("ZIP total uncompressed size exceeds limit");
    }
    const ratio = compressedSize === 0
      ? (uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
      : uncompressedSize / compressedSize;
    if (ratio > (limits.maxRatio ?? MAX_ZIP_RATIO)) {
      throw new Error(`ZIP compression ratio exceeds limit: ${path}`);
    }
    const platform = versionMadeBy >>> 8;
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (platform === 3 && unixType === 0o120000) throw new Error(`ZIP symlink is forbidden: ${path}`);

    if (localHeaderOffset + 30 > centralOffset || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`invalid ZIP local header: ${path}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localName = decoder.decode(bytes.subarray(localNameStart, localNameStart + localNameLength));
    const dataStart = localNameStart + localNameLength + localExtraLength;
    if (localName !== path || dataStart + compressedSize > centralOffset) {
      throw new Error(`ZIP local/central path mismatch: ${path}`);
    }
    entries.push({ path, compressedSize, uncompressedSize, externalAttributes, localHeaderOffset });
    offset = next;
  }
  if (offset !== eocd) throw new Error("ZIP central directory contains trailing records");
  return entries;
}

function prepareExtractionDirectory(directory: string): string {
  const output = resolve(directory);
  const marker = `${output}${EXTENSION_MARKER_SUFFIX}`;
  if (existsSync(output)) {
    if (!existsSync(marker)) throw new Error(`refusing to replace unowned extraction directory: ${output}`);
    rmSync(output, { recursive: true, force: true });
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(marker, "owned by atlcli release verifier\n");
  return output;
}

export async function extractVerifiedZip(bytes: Uint8Array, directory: string): Promise<ZipCentralEntry[]> {
  const entries = inspectZipCentralDirectory(bytes);
  const output = prepareExtractionDirectory(directory);
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  for (const entry of entries) {
    if (entry.path.endsWith("/")) continue;
    const file = archive.file(entry.path);
    if (!file) throw new Error(`ZIP library could not resolve verified entry: ${entry.path}`);
    const target = join(output, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    const content = await file.async("uint8array");
    if (content.byteLength !== entry.uncompressedSize) {
      throw new Error(`ZIP uncompressed size mismatch: ${entry.path}`);
    }
    writeFileSync(target, content);
    const mode = (entry.externalAttributes >>> 16) & 0o777;
    if (mode > 0) chmodSync(target, mode);
  }
  return entries;
}

async function inspectExtractedExtension(input: {
  bytes: Uint8Array;
  extractionDirectory: string;
  verifyRuntime: boolean;
}): Promise<ExtractedExtensionInspection> {
  const entries = await extractVerifiedZip(input.bytes, input.extractionDirectory);
  const forbidden = entries
    .map(({ path }) => path)
    .filter((path) =>
      /(^|\/)(?:\.env(?:\.|$)|node_modules|tests?|src)(?:\/|$)/i.test(path) ||
      /\.(?:map|ts|tsx)$/i.test(path)
    );
  if (forbidden.length > 0) throw new Error(`forbidden extension files: ${forbidden.join(", ")}`);
  if (entries.filter(({ path }) => path === "manifest.json").length !== 1) {
    throw new Error("extension ZIP must contain exactly one root manifest.json");
  }
  const manifestBytes = readFileSync(join(input.extractionDirectory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as ExtractedExtensionInspection["manifest"];
  const fingerprints = {
    contentTreeSha256: releaseTreeDigest(readReleaseTree(input.extractionDirectory)),
    manifestSha256: sha256(manifestBytes),
    cspSha256: sha256(canonicalJson(manifest.content_security_policy ?? null)),
    permissionsSha256: sha256(canonicalJson({
      hostPermissions: [...(manifest.host_permissions ?? [])].sort(),
      permissions: [...(manifest.permissions ?? [])].sort(),
    })),
  };

  let outputScan: "success" | "not-run" = "not-run";
  if (input.verifyRuntime) {
    const leaks = scanOutputDir(input.extractionDirectory);
    const issues = validateExtensionArtifactInventory(collectArtifacts(input.extractionDirectory));
    if (leaks.length > 0 || issues.length > 0) {
      throw new Error(`extension output gate failed: ${JSON.stringify({ leaks, issues })}`);
    }
    outputScan = "success";
  }
  return { entries, manifestBytes, manifest, fingerprints, outputScan };
}

export async function verifyAndExtractExtensionArchive(input: {
  zipPath: string;
  extractionDirectory: string;
  verifyRuntime?: boolean;
}): Promise<{
  schema: "atlcli.extension-archive-verification/v1";
  artifactName: string;
  artifactSize: number;
  artifactSha256: string;
  entryCount: number;
  outputScan: "success" | "not-run";
  version: string | null;
  versionName: string | null;
  fingerprints: BuildMetadata["extension"];
}> {
  const bytes = readFileSync(resolve(input.zipPath));
  const inspection = await inspectExtractedExtension({
    bytes,
    extractionDirectory: resolve(input.extractionDirectory),
    verifyRuntime: input.verifyRuntime ?? true,
  });
  return {
    schema: "atlcli.extension-archive-verification/v1",
    artifactName: resolve(input.zipPath).split("/").at(-1)!,
    artifactSize: bytes.byteLength,
    artifactSha256: sha256(bytes),
    entryCount: inspection.entries.length,
    outputScan: inspection.outputScan,
    version: inspection.manifest.version ?? null,
    versionName: inspection.manifest.version_name ?? null,
    fingerprints: inspection.fingerprints,
  };
}

function parseTarOctal(bytes: Uint8Array, offset: number, length: number): number {
  const raw = Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid TAR octal field: ${JSON.stringify(raw)}`);
  return Number.parseInt(raw, 8);
}

export function inspectSingleBinaryTarGz(bytes: Uint8Array): { name: string; mode: number; bytes: Uint8Array } {
  const tar = gunzipSync(bytes);
  if (tar.byteLength < 1_536) throw new Error("TAR archive is too short");
  const header = tar.subarray(0, 512);
  const name = safeArchivePath(Buffer.from(header.subarray(0, 100)).toString("utf8").split("\0")[0]!);
  const mode = parseTarOctal(header, 100, 8);
  const size = parseTarOctal(header, 124, 12);
  const type = header[156];
  if (type !== 0 && type !== "0".charCodeAt(0)) throw new Error("TAR entry is not a regular file");
  const storedChecksum = parseTarOctal(header, 148, 8);
  const checksumHeader = new Uint8Array(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (storedChecksum !== actualChecksum) throw new Error("TAR header checksum mismatch");
  const paddedEnd = 512 + Math.ceil(size / 512) * 512;
  if (paddedEnd + 1_024 !== tar.byteLength) throw new Error("TAR must contain exactly one entry");
  if (tar.subarray(paddedEnd).some((byte) => byte !== 0)) throw new Error("TAR end blocks are not empty");
  return { name, mode, bytes: tar.subarray(512, 512 + size) };
}

function assertBinaryIdentity(binary: Uint8Array, metadata: BuildMetadata): void {
  const text = Buffer.from(binary);
  const shortSha = metadata.sourceSha.slice(0, 8);
  const dev = /^dev-(\d{8})\.(\d+)\.(\d+)-([0-9a-f]{8})$/.exec(metadata.buildId);
  const cliVersion = metadata.channel === "stable"
    ? metadata.rootVersion
    : `${metadata.rootVersion}-dev.${dev?.[1]}.${dev?.[2]}.${dev?.[3]}+${shortSha}`;
  const createdSecond = metadata.run.createdAt.slice(0, 19).replaceAll(/[-:T]/g, "");
  const homebrewVersion = metadata.channel === "stable"
    ? metadata.rootVersion
    : `${createdSecond}.${dev?.[2]}.${dev?.[3]}`;
  for (const expected of [
    "atlcli.release-info/v1",
    cliVersion,
    metadata.sourceSha,
    metadata.buildId,
    metadata.releaseTag,
    homebrewVersion,
  ]) {
    if (!text.includes(Buffer.from(expected))) {
      throw new Error(`CLI binary does not contain release identity field: ${expected}`);
    }
  }
}

async function inspectCliArchive(name: string, bytes: Uint8Array, metadata: BuildMetadata): Promise<void> {
  if (name.endsWith(".tar.gz")) {
    const binary = inspectSingleBinaryTarGz(bytes);
    if (binary.name !== "atlcli") throw new Error(`${name} must contain only atlcli`);
    if (binary.bytes.byteLength > 256 * 1024 * 1024) throw new Error(`${name} binary exceeds size limit`);
    if ((binary.mode & 0o111) === 0) throw new Error(`${name} binary is not executable`);
    assertBinaryIdentity(binary.bytes, metadata);
    return;
  }
  const entries = inspectZipCentralDirectory(bytes, {
    maxEntrySize: 256 * 1024 * 1024,
    maxTotalSize: 256 * 1024 * 1024,
  });
  if (entries.length !== 1 || entries[0]!.path !== "atlcli.exe") {
    throw new Error(`${name} must contain only atlcli.exe`);
  }
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const binary = await archive.file("atlcli.exe")!.async("uint8array");
  assertBinaryIdentity(binary, metadata);
}

function parseJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseChecksums(text: string): ArtifactDigest[] {
  const records = text.trimEnd().split("\n").map((line) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`invalid checksums.txt line: ${line}`);
    return { name: match[2]!, sha256: match[1]!, size: 1 };
  });
  return normalizeArtifactDigests(records);
}

function assertSchema<T>(validate: ReturnType<Ajv["compile"]>, value: T, label: string): void {
  if (!validate(value)) throw new Error(`${label} schema mismatch: ${JSON.stringify(validate.errors)}`);
}

function expectedAssetNames(metadata: BuildMetadata): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${metadata.buildId}.zip`,
    "checksums.txt",
    "build-metadata.json",
    "security-attestation.json",
    "source-eligibility.json",
  ].sort();
}

function payloadNames(metadata: BuildMetadata): string[] {
  return [
    ...CLI_TARGETS.map(cliAssetName),
    `atlcli-extension-chrome-mv3-${metadata.buildId}.zip`,
    "security-attestation.json",
    "source-eligibility.json",
  ].sort();
}

export async function verifyReleaseArtifacts(input: {
  directory: string;
  extractExtensionDirectory?: string;
  verifyExtensionRuntime?: boolean;
}): Promise<ReleaseVerificationReceipt> {
  const directory = resolve(input.directory);
  const metadata = parseJson<BuildMetadata>(join(directory, "build-metadata.json"));
  const security = parseJson<SecurityAttestation>(join(directory, "security-attestation.json"));
  const eligibility = parseJson<SourceEligibility>(join(directory, "source-eligibility.json"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  assertSchema(ajv.compile(BUILD_METADATA_JSON_SCHEMA), metadata, "build-metadata.json");
  assertSchema(ajv.compile(SECURITY_ATTESTATION_JSON_SCHEMA), security, "security-attestation.json");
  assertSchema(ajv.compile(SOURCE_ELIGIBILITY_JSON_SCHEMA), eligibility, "source-eligibility.json");
  const devIdentity = /^dev-(\d{8})\.(\d+)\.(\d+)-([0-9a-f]{8})$/.exec(metadata.buildId);
  if (metadata.channel === "stable") {
    if (metadata.buildId !== `v${metadata.rootVersion}` || metadata.releaseTag !== metadata.buildId) {
      throw new Error("stable metadata build ID and release tag are inconsistent");
    }
  } else if (
    !devIdentity ||
    metadata.releaseTag !== metadata.buildId ||
    devIdentity[4] !== metadata.sourceSha.slice(0, 8) ||
    Number(devIdentity[3]) !== metadata.run.attempt ||
    devIdentity[1] !== metadata.run.createdAt.slice(0, 10).replaceAll("-", "")
  ) {
    throw new Error("dev metadata build ID is not bound to source SHA, run attempt, and creation day");
  }
  if (!SHA_PATTERN.test(metadata.sourceSha) || security.commit !== metadata.sourceSha) {
    throw new Error("security attestation is not bound to metadata source SHA");
  }
  if (
    security.veraPdfDigestOk === false ||
    security.m1AcceptanceOk === false ||
    security.checks.some(({ status }) => status === "failed")
  ) {
    throw new Error("security attestation contains a failed check");
  }
  if (
    eligibility.sourceSha !== metadata.sourceSha ||
    eligibility.decision !== "eligible" ||
    eligibility.workflow.conclusion !== "success" ||
    eligibility.requiredJob.conclusion !== "success"
  ) {
    throw new Error("source eligibility is not a successful proof for metadata source SHA");
  }

  const topLevelFiles = readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isFile() && !name.endsWith(EXTENSION_MARKER_SUFFIX))
    .sort();
  const expectedNames = expectedAssetNames(metadata);
  if (JSON.stringify(topLevelFiles) !== JSON.stringify(expectedNames)) {
    throw new Error(`release asset contract mismatch: expected ${expectedNames}, got ${topLevelFiles}`);
  }
  const expectedPayloadNames = payloadNames(metadata);
  const metadataArtifacts = normalizeArtifactDigests(metadata.artifacts);
  if (JSON.stringify(metadataArtifacts.map(({ name }) => name)) !== JSON.stringify(expectedPayloadNames)) {
    throw new Error("metadata payload artifact set is incomplete or contains extra records");
  }
  const checksumRecords = parseChecksums(readFileSync(join(directory, "checksums.txt"), "utf8"));
  if (JSON.stringify(checksumRecords.map(({ name }) => name)) !== JSON.stringify(expectedPayloadNames)) {
    throw new Error("checksums.txt payload set is incomplete or contains extra records");
  }

  const actualArtifacts: ArtifactDigest[] = [];
  for (const expected of metadataArtifacts) {
    const bytes = readFileSync(join(directory, expected.name));
    const actual = { name: expected.name, size: bytes.byteLength, sha256: sha256(bytes) };
    const checksum = checksumRecords.find((entry) => entry.name === expected.name);
    if (
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256 ||
      checksum?.sha256 !== expected.sha256
    ) {
      throw new Error(`artifact digest mismatch: ${expected.name}`);
    }
    actualArtifacts.push(actual);
  }
  const eligibilityDigest = sha256(readFileSync(join(directory, "source-eligibility.json")));
  if (eligibilityDigest !== metadata.sourceEligibilitySha256) {
    throw new Error("source eligibility digest does not match metadata");
  }

  for (const target of CLI_TARGETS) {
    const name = cliAssetName(target);
    await inspectCliArchive(name, readFileSync(join(directory, name)), metadata);
  }

  const extensionName = `atlcli-extension-chrome-mv3-${metadata.buildId}.zip`;
  const extensionBytes = readFileSync(join(directory, extensionName));
  const extraction = input.extractExtensionDirectory ?? join(directory, "extension");
  const extensionInspection = await inspectExtractedExtension({
    bytes: extensionBytes,
    extractionDirectory: extraction,
    verifyRuntime: input.verifyExtensionRuntime ?? true,
  });
  const { manifest, fingerprints, entries: zipEntries, outputScan } = extensionInspection;
  const dev = /^dev-(\d{8})\.(\d+)\.(\d+)-([0-9a-f]{8})$/.exec(metadata.buildId);
  if (metadata.channel === "dev" && !dev) throw new Error("invalid dev build ID in metadata");
  const expectedVersion = metadata.channel === "stable"
    ? metadata.rootVersion
    : `${metadata.rootVersion}.${dev![2]}`;
  const expectedVersionName = metadata.channel === "stable"
    ? `${metadata.rootVersion}-stable`
    : `${metadata.rootVersion}-dev.${dev![1]}.${dev![2]}.${dev![3]}-${dev![4]}`;
  if (manifest.version !== expectedVersion || manifest.version_name !== expectedVersionName) {
    throw new Error("extension manifest release identity does not match metadata");
  }

  for (const [field, digest] of Object.entries(fingerprints)) {
    if (!SHA256_PATTERN.test(digest) || digest !== metadata.extension[field as keyof typeof fingerprints]) {
      throw new Error(`extension ${field} does not match metadata`);
    }
  }

  return {
    schema: "atlcli.release-verification/v1",
    sourceSha: metadata.sourceSha,
    channel: metadata.channel,
    buildId: metadata.buildId,
    releaseTag: metadata.releaseTag,
    verifiedArtifacts: normalizeArtifactDigests(actualArtifacts),
    extension: {
      extractedDirectory: extraction,
      ...fingerprints,
      entryCount: zipEntries.length,
      outputScan,
    },
  };
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "extension") {
    const zipPath = value("--zip");
    const output = value("--out");
    if (!zipPath || !output) {
      throw new Error("Usage: bun scripts/verify-release-artifacts.ts extension --zip <zip> --out <dir>");
    }
    process.stdout.write(canonicalJson(await verifyAndExtractExtensionArchive({
      zipPath,
      extractionDirectory: output,
    })));
    process.exit(0);
  }
  const directory = value("--dir");
  if (!directory) throw new Error("Usage: bun scripts/verify-release-artifacts.ts --dir <assets>");
  const receipt = await verifyReleaseArtifacts({ directory });
  process.stdout.write(canonicalJson(receipt));
}
