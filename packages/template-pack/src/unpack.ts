/**
 * `.wiki-pdf-template` reader with hard security caps (spec 007 T2.4).
 *
 * `unpackTemplate` is the canonical reader and the owner of the size-cap
 * constants folder 011's security-hardening task imports (rather than
 * re-declaring). It does structural integrity only — the semantic import gate
 * is {@link import("./manifest.js").validateManifest}, run separately by
 * {@link import("./validate.js").validatePack}.
 *
 * Hard rejections (all throw {@link TemplatePackError}):
 *   - outer archive over {@link MAX_TEMPLATE_PACK_BYTES} (checked before unzip);
 *   - cumulative declared uncompressed payload over
 *     {@link MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES} — accounted from each entry's
 *     *declared* uncompressed size and aborted BEFORE any inflation (zip-bomb
 *     guard), never by counting compressed bytes;
 *   - any single member over {@link MAX_TEMPLATE_PACK_FILE_BYTES};
 *   - more than {@link MAX_TEMPLATE_PACK_ENTRIES} entries;
 *   - path traversal (`..` segments, absolute paths, backslashes, drive letters)
 *     and ASCII control characters in member paths (see {@link assertSafePath});
 *   - symlink entries;
 *   - a missing/unreadable manifest, or a missing `engine.entry` member.
 *
 * The inner DOCX cap (`MAX_TEMPLATE_BYTES` = 20 MiB in `@atlcli/docx`) is
 * unrelated and unchanged; it still applies once a `kind: "docx"` container's
 * `template.docx` is scanned, and is smaller than these outer caps.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */
import PizZip from "pizzip";
import { TEMPLATE_PACK_MANIFEST_NAME, type TemplateManifest } from "./manifest.js";

/** Outer `.wiki-pdf-template` archive cap: 30 MiB (synced with folder 011). */
export const MAX_TEMPLATE_PACK_BYTES = 30 * 1024 * 1024;

/** Cumulative declared uncompressed payload cap: 64 MiB (synced with folder 011). */
export const MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Per-member declared uncompressed cap: 32 MiB. Chosen above the inner DOCX cap
 * (20 MiB) so a maximal `template.docx` still fits, and below the cumulative
 * cap so no single member can exhaust it alone.
 */
export const MAX_TEMPLATE_PACK_FILE_BYTES = 32 * 1024 * 1024;

/** Maximum number of archive entries. */
export const MAX_TEMPLATE_PACK_ENTRIES = 2048;

/** S_IFLNK mask/value for detecting symlink entries via unix permissions. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/** Typed rejection kinds carried by {@link TemplatePackError}. */
export type TemplatePackErrorKind =
  | "too-large-archive"
  | "not-zip"
  | "too-many-entries"
  | "path-traversal"
  | "invalid-path"
  | "symlink"
  | "file-too-large"
  | "uncompressed-too-large"
  | "missing-manifest"
  | "bad-manifest"
  | "missing-entry";

/** Thrown on any structural rejection while reading a pack. */
export class TemplatePackError extends Error {
  constructor(
    readonly kind: TemplatePackErrorKind,
    message: string,
    readonly path?: string
  ) {
    super(message);
    this.name = "TemplatePackError";
  }
}

/** Result of {@link unpackTemplate}: parsed (but not yet gated) manifest + payload. */
export interface UnpackedTemplate {
  /** The parsed manifest — structurally read, NOT semantically validated. */
  manifest: TemplateManifest;
  /** Payload members by path (the manifest file is excluded). */
  files: Record<string, Uint8Array>;
}

/** Minimal read view over a PizZip entry, including its internal declared sizes. */
interface ReadEntry {
  name: string;
  dir: boolean;
  unixPermissions?: number | null;
  asUint8Array(): Uint8Array;
  _data?: { uncompressedSize?: number; compressedSize?: number };
}

/**
 * Reject any member path that could escape the archive root or smuggle
 * structure into derived values. Shared by BOTH ends of the format:
 * `packTemplate` refuses to produce an archive `unpackTemplate` would reject.
 *
 * Beyond traversal (`..` segments, absolute paths, backslashes, drive
 * letters), every ASCII control character (0x00–0x1F, 0x7F) is rejected with
 * the typed kind `"invalid-path"`: newlines/CR/NUL in a member path have no
 * legitimate use and were provably usable to forge `payloadSha256` collisions
 * under a delimiter-based canonicalization (the canonicalization is now
 * delimiter-safe on its own — see `pack.ts` — but hostile paths stay banned at
 * the source as defense in depth).
 */
export function assertSafePath(name: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new TemplatePackError(
      "invalid-path",
      `Control character in path ${JSON.stringify(name)}`,
      name
    );
  }
  if (name.includes("\\")) {
    throw new TemplatePackError("path-traversal", `Backslash in path "${name}"`, name);
  }
  if (name.startsWith("/")) {
    throw new TemplatePackError("path-traversal", `Absolute path "${name}"`, name);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new TemplatePackError("path-traversal", `Drive-letter path "${name}"`, name);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new TemplatePackError("path-traversal", `Parent-directory segment in "${name}"`, name);
  }
}

function isSymlink(entry: ReadEntry): boolean {
  const mode = entry.unixPermissions;
  return typeof mode === "number" && (mode & S_IFMT) === S_IFLNK;
}

/**
 * Read and validate a `.wiki-pdf-template` archive.
 *
 * @throws {TemplatePackError} on any structural rejection above.
 */
export function unpackTemplate(bytes: Uint8Array): UnpackedTemplate {
  if (bytes.byteLength > MAX_TEMPLATE_PACK_BYTES) {
    throw new TemplatePackError(
      "too-large-archive",
      `Archive exceeds the ${MAX_TEMPLATE_PACK_BYTES}-byte limit (${bytes.byteLength}).`
    );
  }

  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch (err) {
    throw new TemplatePackError("not-zip", `Not a valid zip archive: ${(err as Error).message}`);
  }

  const entries = Object.values(zip.files) as unknown as ReadEntry[];
  if (entries.length > MAX_TEMPLATE_PACK_ENTRIES) {
    throw new TemplatePackError(
      "too-many-entries",
      `Archive has ${entries.length} entries (limit ${MAX_TEMPLATE_PACK_ENTRIES}).`
    );
  }

  // First pass: validate paths + declared sizes WITHOUT inflating (zip-bomb guard).
  let cumulative = 0;
  for (const entry of entries) {
    assertSafePath(entry.name);
    if (entry.dir) continue;
    if (isSymlink(entry)) {
      throw new TemplatePackError("symlink", `Symlink entry "${entry.name}" is not allowed`, entry.name);
    }
    const declared = entry._data?.uncompressedSize;
    if (typeof declared !== "number" || !Number.isFinite(declared)) {
      throw new TemplatePackError(
        "bad-manifest",
        `Cannot determine declared size of "${entry.name}"`,
        entry.name
      );
    }
    if (declared > MAX_TEMPLATE_PACK_FILE_BYTES) {
      throw new TemplatePackError(
        "file-too-large",
        `Member "${entry.name}" declares ${declared} bytes (per-file limit ${MAX_TEMPLATE_PACK_FILE_BYTES}).`,
        entry.name
      );
    }
    cumulative += declared;
    if (cumulative > MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES) {
      throw new TemplatePackError(
        "uncompressed-too-large",
        `Cumulative declared uncompressed size exceeds the ${MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES}-byte limit.`,
        entry.name
      );
    }
  }

  // Second pass: inflate now that declared sizes are proven within caps.
  const files: Record<string, Uint8Array> = {};
  let manifestBytes: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry.dir) continue;
    const data = entry.asUint8Array();
    if (entry.name === TEMPLATE_PACK_MANIFEST_NAME) {
      manifestBytes = data;
    } else {
      files[entry.name] = data;
    }
  }

  if (!manifestBytes) {
    throw new TemplatePackError(
      "missing-manifest",
      `Archive is missing its "${TEMPLATE_PACK_MANIFEST_NAME}" manifest.`
    );
  }

  let manifest: TemplateManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as TemplateManifest;
  } catch (err) {
    throw new TemplatePackError("bad-manifest", `Manifest is not valid JSON: ${(err as Error).message}`);
  }
  const entryName = manifest?.engine?.entry;
  if (typeof entryName !== "string" || entryName.length === 0) {
    throw new TemplatePackError("bad-manifest", "Manifest lacks a string engine.entry.");
  }
  if (!Object.prototype.hasOwnProperty.call(files, entryName)) {
    throw new TemplatePackError(
      "missing-entry",
      `Manifest engine.entry "${entryName}" is not present in the archive.`,
      entryName
    );
  }

  return { manifest, files };
}
