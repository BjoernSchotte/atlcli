import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import JSZip from "jszip";

export interface ReleaseTreeEntry {
  path: string;
  bytes: Uint8Array;
  mode: number;
}

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes("\0") ||
    parts.includes("..") ||
    parts.includes(".")
  ) {
    throw new Error(`unsafe archive path: ${path}`);
  }
  return normalized;
}

function collectDirectory(
  root: string,
  current: string,
  entries: ReleaseTreeEntry[],
): void {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`release tree contains a symlink: ${absolute}`);
    if (stat.isDirectory()) {
      collectDirectory(root, absolute, entries);
    } else if (stat.isFile()) {
      entries.push({
        path: safeRelativePath(relative(root, absolute)),
        bytes: readFileSync(absolute),
        mode: stat.mode & 0o777,
      });
    } else {
      throw new Error(`release tree contains an unsupported entry: ${absolute}`);
    }
  }
}

export function readReleaseTree(directory: string): ReleaseTreeEntry[] {
  const root = resolve(directory);
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new Error(`release tree root is not a directory: ${directory}`);
  const entries: ReleaseTreeEntry[] = [];
  collectDirectory(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function releaseTreeDigest(entries: ReleaseTreeEntry[]): string {
  const inventory = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${createHash("sha256").update(entry.bytes).digest("hex")}  ${entry.path}\n`)
    .join("");
  return createHash("sha256").update(inventory).digest("hex");
}

export async function deterministicZip(entries: ReleaseTreeEntry[]): Promise<Uint8Array> {
  const archive = new JSZip();
  const seen = new Set<string>();
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = safeRelativePath(entry.path);
    if (seen.has(path)) throw new Error(`duplicate archive path: ${path}`);
    seen.add(path);
    archive.file(path, entry.bytes, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
      unixPermissions: 0o100000 | (entry.mode & 0o777),
    });
  }
  return archive.generateAsync({
    type: "uint8array",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const rendered = value.toString(8).padStart(length - 1, "0");
  if (rendered.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  target.set(Buffer.from(`${rendered}\0`, "ascii"), offset);
}

export function deterministicTarGz(entry: ReleaseTreeEntry): Uint8Array {
  const path = safeRelativePath(entry.path);
  if (Buffer.byteLength(path) > 100) throw new Error(`tar entry path exceeds 100 bytes: ${path}`);
  const header = new Uint8Array(512);
  header.set(Buffer.from(path, "utf8"), 0);
  writeOctal(header, 100, 8, entry.mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.set(Buffer.from("ustar\0", "ascii"), 257);
  header.set(Buffer.from("00", "ascii"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.set(Buffer.from(checksumText, "ascii"), 148);

  const bodyBlocks = Math.ceil(entry.bytes.byteLength / 512);
  const tar = new Uint8Array(512 + bodyBlocks * 512 + 1024);
  tar.set(header, 0);
  tar.set(entry.bytes, 512);
  return gzipSync(tar, { level: 9 });
}

export async function writeDeterministicZip(
  outputPath: string,
  entries: ReleaseTreeEntry[],
): Promise<void> {
  writeFileSync(outputPath, await deterministicZip(entries));
}

export function writeDeterministicTarGz(
  outputPath: string,
  entry: ReleaseTreeEntry,
): void {
  writeFileSync(outputPath, deterministicTarGz(entry));
}

export function executableEntry(path: string, bytes: Uint8Array): ReleaseTreeEntry {
  return { path: safeRelativePath(path), bytes, mode: 0o755 };
}
