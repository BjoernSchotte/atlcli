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
 *   - any member whose declared size is implausible for its own compressed
 *     stream (`suspicious-compression`) — see below;
 *   - a member that fails to inflate (`corrupt-entry`);
 *   - more than {@link MAX_TEMPLATE_PACK_ENTRIES} entries;
 *   - path traversal (`..` segments, absolute paths, backslashes, drive letters)
 *     and ASCII control characters in member paths (see {@link assertSafePath});
 *   - symlink entries;
 *   - a missing/unreadable manifest, or a missing `engine.entry` member.
 *
 * The size caps alone are NOT sufficient, because the declared uncompressed
 * size they budget on is attacker-controlled central-directory metadata. Two
 * independent families of check are therefore required:
 *
 *  - ABSOLUTE caps refuse an HONEST bomb — one that truthfully declares a huge
 *    payload.
 *  - RATIO plausibility ({@link assertPlausibleCompression}) refuses a LYING
 *    central directory — one that UNDER-declares to slip past those caps and
 *    detonate at inflation time. Measured before this guard: a member declaring
 *    1 KiB whose stream inflates to 400 MiB cost +819 MiB RSS in 231 ms.
 *
 * Residual risk, stated plainly: a member declaring a size consistent with its
 * compressed stream but whose DEFLATE data decodes to something else still
 * inflates before PizZip's own post-hoc size comparison fires. PizZip exposes no
 * bounded/streaming inflate, so that spike cannot be prevented here; it is
 * bounded by the ratio cap (at most ~500x the compressed bytes actually shipped)
 * and surfaces as a typed `corrupt-entry` rather than an untyped crash (see
 * {@link readEntryBytes}).
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

/**
 * Maximum plausible declared:compressed ratio for a pack member.
 *
 * DEFLATE tops out near 1032:1. Measured ratios for REAL template-pack media
 * (PizZip, the same compressor `packTemplate` uses):
 *
 * | Member                                        | ratio    |
 * |-----------------------------------------------|----------|
 * | PNG / incompressible image data                |    1.2:1 |
 * | TTF font (real Inter-Regular, 411 KB)          |    2.1:1 |
 * | TTF font (real JetBrainsMono-Regular, 274 KB)  |    2.1:1 |
 * | Typst source (real, 23 KB)                     |    3.4:1 |
 * | SVG logo/diagram (2000 paths)                  |    7.1:1 |
 * | Typst table, 100 000 VARYING rows              |    6.4:1 |
 * | Manifest JSON, 400-key localization table      |   11.9:1 |
 * | Manifest JSON, 50 000 IDENTICAL entries        |   19.5:1 |
 * | Typst source, 20 000 IDENTICAL blocks          |  335.8:1 |
 * | Typst source, 200 000 IDENTICAL blocks         |  342.9:1 |
 *
 * The last two rows are why this is 500 and not 100: a highly repetitive but
 * entirely legitimate template (a long form of identical empty blocks)
 * compresses far better than prose, and a 100:1 cap would reject it. A limit
 * that refuses real packs is an availability bug, not a control.
 *
 * Critically, that shape CONVERGES rather than approaching DEFLATE's ceiling:
 * 230:1 at 1000 blocks, 335.8:1 at 20 000, 342.9:1 at 200 000 (10.6 MB
 * uncompressed). Any real Typst/JSON syntax needs several distinct bytes per
 * repeated unit, which bounds the ratio a few hundred to one. Only a
 * single-byte run (e.g. 2 MiB of pure newlines, measured 1023:1) reaches the
 * ceiling, and that is a degenerate blob rather than a template — a pack member
 * of that shape has no legitimate function, so the envelope is not fitted to it.
 *
 * 500:1 therefore sits ~1.46x above every legitimate shape measured and well
 * below DEFLATE's ceiling, so it still catches a bomb that stays UNDER the
 * absolute caps: declaring the full 32 MiB per-file cap now forces an attacker
 * to ship at least 65.5 KiB of real compressed data instead of 31.8 KiB.
 */
const MAX_DECLARED_COMPRESSION_RATIO = 500;

/**
 * Minimum plausible declared:compressed ratio.
 *
 * DEFLATE never meaningfully expands its input: worst case is ~1.0003x plus a
 * few bytes of framing. A member declaring FEWER bytes than its own compressed
 * stream is therefore provably lying, which is exactly the shape of the
 * inflation bypass this guard closes — a member declaring 1 KiB whose stream
 * inflates to 400 MiB passed both absolute caps and detonated in the inflation
 * pass (measured: +819 MiB RSS in 231 ms, surfacing as an untyped PizZip
 * "uncompressed data size mismatch"). 0.9 tolerates framing overhead on small
 * entries while still catching a lie by orders of magnitude.
 *
 * This lower bound is the actual protection; the upper bound only narrows the
 * remaining sub-cap window.
 */
const MIN_DECLARED_COMPRESSION_RATIO = 0.9;

/**
 * Below this compressed size the ratio checks are skipped.
 *
 * Zip framing dominates tiny members, which makes both ratios meaningless and
 * would reject ordinary small ones — measured here: a 4-byte member compresses
 * to 6 bytes (0.7:1, under the lower bound) and a 198-byte Typst snippet to
 * 16 bytes (12.4:1). A member this small cannot inflate to anything dangerous
 * even at DEFLATE's theoretical maximum (512 B x 1032 = 528 KiB), so skipping
 * it costs nothing.
 */
const COMPRESSION_RATIO_FLOOR_BYTES = 512;

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
  | "suspicious-compression"
  | "corrupt-entry"
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
 * Reject a member whose declared uncompressed size is implausible for its own
 * compressed stream (see {@link MAX_DECLARED_COMPRESSION_RATIO} /
 * {@link MIN_DECLARED_COMPRESSION_RATIO}).
 *
 * This deliberately mirrors `assertPlausibleCompression` in `@atlcli/docx`
 * rather than importing it — exactly as {@link assertSafePath} mirrors that
 * package's `assertSafeDocxEntryName`. The rule is shared but the ERROR TYPE is
 * not: callers of {@link unpackTemplate} switch on {@link TemplatePackError} and
 * its `kind`, so importing the docx helper would throw a `DocxError` straight
 * through this package's import gate and defeat the typing it exists to
 * provide. The ratio envelope is re-derived from template-pack media (fonts,
 * images, Typst, manifest JSON) rather than inherited — see the constants.
 *
 * @throws {TemplatePackError} `suspicious-compression`.
 */
function assertPlausibleCompression(entry: ReadEntry, declared: number): void {
  const compressed = entry._data?.compressedSize;
  if (typeof compressed !== "number" || !Number.isFinite(compressed)) return;
  if (compressed < COMPRESSION_RATIO_FLOOR_BYTES) return;
  if (declared > compressed * MAX_DECLARED_COMPRESSION_RATIO) {
    throw new TemplatePackError(
      "suspicious-compression",
      `Member "${entry.name}" declares ${declared} bytes from ${compressed} compressed (ratio ${(declared / compressed).toFixed(1)}:1, limit ${MAX_DECLARED_COMPRESSION_RATIO}:1).`,
      entry.name
    );
  }
  if (declared < compressed * MIN_DECLARED_COMPRESSION_RATIO) {
    throw new TemplatePackError(
      "suspicious-compression",
      `Member "${entry.name}" declares only ${declared} uncompressed bytes for a ${compressed}-byte compressed stream. DEFLATE never expands its input, so the declared size is false — refusing before inflation.`,
      entry.name
    );
  }
}

/**
 * Inflate one member, translating a decompression failure into a typed error.
 *
 * PizZip inflates eagerly and only compares sizes afterwards, throwing a bare
 * `Error("Bug : uncompressed data size mismatch")`. Without this wrapper that
 * untyped throw escapes {@link unpackTemplate}, so a caller switching on
 * {@link TemplatePackError.kind} faces an unhandled exception from what is
 * simply another malformed archive.
 *
 * @throws {TemplatePackError} `corrupt-entry`.
 */
function readEntryBytes(entry: ReadEntry): Uint8Array {
  try {
    return entry.asUint8Array();
  } catch (err) {
    throw new TemplatePackError(
      "corrupt-entry",
      `Member "${entry.name}" could not be decompressed (${(err as Error).message}); the archive is corrupt or its central directory is falsified.`,
      entry.name
    );
  }
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

  // First pass: paths, symlinks and ABSOLUTE size caps, WITHOUT inflating.
  const sized: { entry: ReadEntry; declared: number }[] = [];
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
    sized.push({ entry, declared });
  }

  // Second pass: ratio plausibility, only once the archive fits every absolute
  // cap. Separated from the pass above rather than folded into it, because the
  // cumulative budget is a property of the WHOLE archive: three members
  // honestly declaring 30 MiB of zeros each breach the 64 MiB total, but the
  // breach is only detectable at the third, while a per-entry ratio test would
  // fire on the first and misreport an HONEST bomb (nothing in it lied) as
  // `suspicious-compression`. Checking every absolute cap first keeps the
  // diagnosis accurate: size kinds for honest bombs, `suspicious-compression`
  // strictly for a central directory that cannot be telling the truth.
  // Both passes read metadata only, so nothing is inflated either way.
  for (const { entry, declared } of sized) {
    assertPlausibleCompression(entry, declared);
  }

  // Final pass: inflate, now that declared sizes are both within the absolute
  // caps and plausible for their own compressed streams.
  const files: Record<string, Uint8Array> = {};
  let manifestBytes: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry.dir) continue;
    const data = readEntryBytes(entry);
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
