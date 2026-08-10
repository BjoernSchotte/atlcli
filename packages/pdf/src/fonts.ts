/**
 * Font-intake seam (spec 007 B5) — pure, browser-safe sfnt inspection and
 * integrity verification for corporate fonts fed into the PDF compiler.
 *
 * The engine never fetches font bytes: a host resolves them through a
 * {@link FontSource} (see `types.ts`) and hands them to the compiler as
 * `Uint8Array[]`. This module supplies the two pure helpers a host needs on
 * that path:
 *
 *  - {@link parseFontMeta} inspects sfnt bytes (TrueType `00 01 00 00`, CFF
 *    `OTTO`, or a `ttcf` collection), reads the `name` table for each face, and
 *    returns one descriptive record per face. WOFF/WOFF2 web-packaged fonts are
 *    rejected with actionable guidance because the pinned Typst compiler
 *    consumes sfnt only. Every read is bounds-checked, so a truncated or hostile
 *    file rejects with a typed {@link FontParseError}, never an unrelated
 *    `RangeError`.
 *  - {@link verifyFontBytes} re-hashes delivered bytes against an approved
 *    {@link FontAsset}'s `sha256`. This is MANDATORY host wiring between
 *    `FontSource.getBytes` and `BrowserPdfCompilerAssets.fonts` — see its doc
 *    comment for the exact construction.
 *
 * Browser-safety: no `node:`/`bun:` imports. `crypto` is the Web Crypto global
 * (browsers, Bun, Node >= 18); `TextDecoder`/`DataView` are platform globals.
 */
import type { FontAsset } from "./types.js";

/** 10 MB hard cap per font file (reject, never truncate). */
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

/** Guidance surfaced when a web-packaged (WOFF/WOFF2) font is submitted. */
export const WEB_PACKAGED_FONT_GUIDANCE =
  "web-packaged font detected — the PDF compiler consumes TTF/OTF; " +
  "export the desktop font from your font source";

export type FontParseErrorReason =
  | "empty"
  | "too-large"
  | "truncated"
  | "unsupported-format"
  | "web-packaged"
  | "missing-name-table"
  | "malformed-name-table";

/**
 * Typed rejection from {@link parseFontMeta}. Every failure — including
 * truncated headers, out-of-range table offsets, and hostile table counts —
 * surfaces here with a machine-readable {@link reason}, so a host renders
 * actionable guidance instead of catching an anonymous `RangeError`.
 */
export class FontParseError extends Error {
  readonly reason: FontParseErrorReason;

  constructor(reason: FontParseErrorReason, message: string) {
    super(message);
    this.name = "FontParseError";
    this.reason = reason;
  }
}

/**
 * Thrown by {@link verifyFontBytes} when delivered bytes do not hash to the
 * approved {@link FontAsset}'s `sha256`. A corrupted or swapped delivery must
 * never be embedded under the approved font's license claim, so there is no
 * silent fallback.
 */
export class FontVerificationError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      `Font bytes failed their SHA-256 check (expected ${expected}, got ${actual}) — ` +
        "the delivered font does not match the approved record; re-resolve it."
    );
    this.name = "FontVerificationError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * One face parsed from a font file, shaped like a {@link FontAsset} minus the
 * host-supplied `sha256`/`license` (those describe the delivery and the legal
 * attestation, neither of which is derivable from the bytes). A `ttcf`
 * collection yields one record per bundled face.
 */
export interface ParsedFontFace {
  /** Typographic family (name ID 16, else 1). */
  family: string;
  /** Typographic subfamily (name ID 17, else 2), e.g. `"Regular"`, `"Bold"`. */
  subfamily: string;
  /** Derived from the subfamily: `"italic"` for italic/oblique faces. */
  style: "normal" | "italic";
  /** Derived from the subfamily keyword (`Bold` -> 700, …); defaults to 400. */
  weight: number;
  /** OpenType `fvar` axes inspected from this exact face. */
  axes?: readonly ParsedFontAxis[];
}

export interface ParsedFontAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

// sfnt magic numbers (big-endian uint32 read of the first four bytes).
const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true' (Apple TrueType)
const SFNT_OTTO = 0x4f54544f; // 'OTTO' (CFF/OpenType)
const SFNT_TTCF = 0x74746366; // 'ttcf' (collection)
const MAGIC_WOFF = 0x774f4646; // 'wOFF'
const MAGIC_WOFF2 = 0x774f4632; // 'wOF2'

const NAME_ID_FAMILY = 1;
const NAME_ID_SUBFAMILY = 2;
const NAME_ID_TYPO_FAMILY = 16;
const NAME_ID_TYPO_SUBFAMILY = 17;

/** Bounds-checked big-endian readers — throw a typed error, never a RangeError. */
function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new FontParseError("truncated", `font truncated: cannot read u16 at offset ${offset}`);
  }
  return view.getUint16(offset);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new FontParseError("truncated", `font truncated: cannot read u32 at offset ${offset}`);
  }
  return view.getUint32(offset);
}

function readFixed16_16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new FontParseError("truncated", `font truncated: cannot read fixed value at offset ${offset}`);
  }
  return view.getInt32(offset) / 65_536;
}

function readTag(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new FontParseError("truncated", `font truncated: cannot read tag at offset ${offset}`);
  }
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/** Priority for competing name records: higher wins. Windows English first. */
function namePriority(platformID: number, languageID: number): number {
  if (platformID === 3) return languageID === 0x0409 ? 40 : 30; // Windows (UTF-16BE)
  if (platformID === 0) return 20; // Unicode (UTF-16BE)
  if (platformID === 1) return languageID === 0 ? 12 : 10; // Mac (Mac Roman ~ ASCII)
  return 1;
}

function decodeName(bytes: Uint8Array, offset: number, length: number, platformID: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new FontParseError(
      "malformed-name-table",
      `name string out of range (offset ${offset}, length ${length}, size ${bytes.length})`
    );
  }
  const slice = bytes.subarray(offset, offset + length);
  if (platformID === 1) {
    // Mac Roman: approximate as byte-per-char; font family names are ASCII.
    let out = "";
    for (const b of slice) out += String.fromCharCode(b);
    return out;
  }
  // Platform 0 (Unicode) and 3 (Windows) store UTF-16BE.
  return new TextDecoder("utf-16be").decode(slice);
}

/** Parse a single `name` table, returning the best family/subfamily strings. */
function parseNameTable(bytes: Uint8Array, view: DataView, nameOffset: number, nameLength: number): { family: string; subfamily: string } {
  if (nameOffset + nameLength > bytes.length) {
    throw new FontParseError(
      "malformed-name-table",
      `name table out of range (offset ${nameOffset}, length ${nameLength}, size ${bytes.length})`
    );
  }
  const count = readU16(view, nameOffset + 2);
  const storageOffset = readU16(view, nameOffset + 4);
  const recordsStart = nameOffset + 6;
  if (recordsStart + count * 12 > bytes.length) {
    throw new FontParseError("malformed-name-table", "name records extend past the font bytes");
  }
  const storageBase = nameOffset + storageOffset;

  // Track the highest-priority decoded string per name ID.
  const best = new Map<number, { priority: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const rec = recordsStart + i * 12;
    const platformID = readU16(view, rec);
    const languageID = readU16(view, rec + 4);
    const nameID = readU16(view, rec + 6);
    if (
      nameID !== NAME_ID_FAMILY &&
      nameID !== NAME_ID_SUBFAMILY &&
      nameID !== NAME_ID_TYPO_FAMILY &&
      nameID !== NAME_ID_TYPO_SUBFAMILY
    ) {
      continue;
    }
    const length = readU16(view, rec + 8);
    const strOffset = readU16(view, rec + 10);
    const priority = namePriority(platformID, languageID);
    const existing = best.get(nameID);
    if (existing && existing.priority >= priority) continue;
    const value = decodeName(bytes, storageBase + strOffset, length, platformID).trim();
    if (value === "") continue;
    best.set(nameID, { priority, value });
  }

  const family = best.get(NAME_ID_TYPO_FAMILY)?.value ?? best.get(NAME_ID_FAMILY)?.value;
  const subfamily =
    best.get(NAME_ID_TYPO_SUBFAMILY)?.value ?? best.get(NAME_ID_SUBFAMILY)?.value ?? "Regular";
  if (family === undefined) {
    throw new FontParseError("malformed-name-table", "font name table has no family record");
  }
  return { family, subfamily };
}

const WEIGHT_KEYWORDS: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:extra[-\s]?black|ultra[-\s]?black)\b/i, 950],
  [/\b(?:black|heavy)\b/i, 900],
  [/\b(?:extra[-\s]?bold|ultra[-\s]?bold)\b/i, 800],
  [/\bsemi[-\s]?bold\b|\bdemi[-\s]?bold\b/i, 600],
  [/\bbold\b/i, 700],
  [/\bmedium\b/i, 500],
  [/\b(?:extra[-\s]?light|ultra[-\s]?light)\b/i, 200],
  [/\bthin\b|\bhairline\b/i, 100],
  [/\blight\b/i, 300],
];

function deriveStyle(subfamily: string): "normal" | "italic" {
  return /\b(?:italic|oblique)\b/i.test(subfamily) ? "italic" : "normal";
}

function deriveWeight(subfamily: string): number {
  for (const [pattern, weight] of WEIGHT_KEYWORDS) {
    if (pattern.test(subfamily)) return weight;
  }
  return 400;
}

function parseVariationAxes(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  length: number,
): ParsedFontAxis[] {
  if (offset < 0 || length < 16 || offset + length > bytes.length) {
    throw new FontParseError("truncated", "font fvar table is truncated");
  }
  const axesOffset = readU16(view, offset + 4);
  const axisCount = readU16(view, offset + 8);
  const axisSize = readU16(view, offset + 10);
  if (axisSize < 20 || offset + axesOffset + axisCount * axisSize > offset + length) {
    throw new FontParseError("truncated", "font fvar axis records extend past the table");
  }
  const axes: ParsedFontAxis[] = [];
  for (let index = 0; index < axisCount; index++) {
    const record = offset + axesOffset + index * axisSize;
    const min = readFixed16_16(view, record + 4);
    const defaultValue = readFixed16_16(view, record + 8);
    const max = readFixed16_16(view, record + 12);
    if (!(min <= defaultValue && defaultValue <= max)) {
      throw new FontParseError("truncated", "font fvar axis bounds are inconsistent");
    }
    axes.push({
      tag: readTag(bytes, record),
      min,
      default: defaultValue,
      max,
    });
  }
  return axes;
}

/** Parse one face at `tableDirOffset` (0 for a standalone font, else a TTC member). */
function parseFace(bytes: Uint8Array, view: DataView, tableDirOffset: number): ParsedFontFace {
  const numTables = readU16(view, tableDirOffset + 4);
  const dirStart = tableDirOffset + 12;
  // Guard a hostile numTables before touching the directory: the whole directory
  // must fit, so an inflated count rejects as "truncated" not a RangeError.
  if (dirStart + numTables * 16 > bytes.length) {
    throw new FontParseError("truncated", `table directory (${numTables} tables) extends past the font bytes`);
  }
  let nameOffset: number | undefined;
  let nameLength: number | undefined;
  let variationOffset: number | undefined;
  let variationLength: number | undefined;
  for (let i = 0; i < numTables; i++) {
    const rec = dirStart + i * 16;
    const tag = readTag(bytes, rec);
    if (tag === "name") {
      nameOffset = readU32(view, rec + 8);
      nameLength = readU32(view, rec + 12);
    } else if (tag === "fvar") {
      variationOffset = readU32(view, rec + 8);
      variationLength = readU32(view, rec + 12);
    }
  }
  if (nameOffset === undefined || nameLength === undefined) {
    throw new FontParseError("missing-name-table", "font has no `name` table");
  }
  const { family, subfamily } = parseNameTable(bytes, view, nameOffset, nameLength);
  const axes = variationOffset === undefined || variationLength === undefined
    ? undefined
    : parseVariationAxes(bytes, view, variationOffset, variationLength);
  return {
    family,
    subfamily,
    style: deriveStyle(subfamily),
    weight: deriveWeight(subfamily),
    ...(axes === undefined || axes.length === 0 ? {} : { axes }),
  };
}

/**
 * Inspect sfnt font bytes and return one descriptive record per face.
 *
 * Accepts TrueType (`00 01 00 00`), CFF/OpenType (`OTTO`), and TrueType
 * Collections (`ttcf`) — a collection yields one record per bundled face, so
 * multi-face corporate `.ttc` files never silently drop faces. Rejects:
 *
 *  - an empty buffer (`empty`);
 *  - anything over {@link MAX_FONT_BYTES} (`too-large`);
 *  - WOFF/WOFF2 web-packaged fonts with {@link WEB_PACKAGED_FONT_GUIDANCE}
 *    (`web-packaged`), since the pinned compiler consumes sfnt only;
 *  - any other magic (`unsupported-format`);
 *  - truncated headers / out-of-range offsets / hostile table counts
 *    (`truncated` or `malformed-name-table`).
 *
 * @throws {FontParseError} on any rejection — never an unrelated `RangeError`.
 */
export function parseFontMeta(bytes: Uint8Array): ParsedFontFace[] {
  if (bytes.length === 0) {
    throw new FontParseError("empty", "font file is empty");
  }
  if (bytes.length > MAX_FONT_BYTES) {
    throw new FontParseError("too-large", `font exceeds the ${MAX_FONT_BYTES}-byte cap (${bytes.length} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readU32(view, 0);

  if (magic === MAGIC_WOFF || magic === MAGIC_WOFF2) {
    throw new FontParseError("web-packaged", WEB_PACKAGED_FONT_GUIDANCE);
  }

  if (magic === SFNT_TTCF) {
    const numFonts = readU32(view, 8);
    if (numFonts === 0) {
      throw new FontParseError("malformed-name-table", "font collection declares zero faces");
    }
    const offsetsStart = 12;
    if (offsetsStart + numFonts * 4 > bytes.length) {
      throw new FontParseError("truncated", `collection header (${numFonts} faces) extends past the font bytes`);
    }
    const faces: ParsedFontFace[] = [];
    for (let i = 0; i < numFonts; i++) {
      faces.push(parseFace(bytes, view, readU32(view, offsetsStart + i * 4)));
    }
    return faces;
  }

  if (magic === SFNT_TRUETYPE || magic === SFNT_TRUE || magic === SFNT_OTTO) {
    return [parseFace(bytes, view, 0)];
  }

  throw new FontParseError(
    "unsupported-format",
    `unsupported font magic 0x${magic.toString(16).padStart(8, "0")} — expected TTF, OTF, or TTC`
  );
}

/** Lowercase hex SHA-256 of `bytes` via WebCrypto (`crypto.subtle.digest`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh, ArrayBuffer-backed view so the digest input is a plain
  // `BufferSource` regardless of the caller's backing store (mirrors the
  // template-library hash helper in `@atlcli/core`).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that delivered `bytes` hash to `asset.sha256`; throw a typed
 * {@link FontVerificationError} on mismatch.
 *
 * **This is MANDATORY host wiring** between {@link FontSource}.getBytes and
 * `BrowserPdfCompilerAssets.fonts`. Nothing else ties the bytes a `FontSource`
 * returns to the `sha256`/license record a host looked up before handing them
 * to `add_raw_font`, so a corrupted or swapped delivery would otherwise be
 * embedded under the approved font's license claim with no error. Hosts
 * construct the compiler like this — `bundledFonts` unioned with the verified
 * custom fonts — with **no change needed in `packages/pdf-compiler-browser`**
 * (`BrowserPdfCompilerAssets.fonts` is already `Uint8Array[]` and `add_raw_font`
 * accepts arbitrary extra fonts):
 *
 * ```ts
 * new BrowserPdfCompiler({
 *   wasm,
 *   fonts: [
 *     ...bundledFonts,
 *     ...(await Promise.all(
 *       customFonts.map(async (f) => {
 *         const bytes = await fontSource.getBytes(f.sha256);
 *         await verifyFontBytes(f, bytes); // gates every custom font
 *         return bytes;
 *       })
 *     )),
 *   ],
 * });
 * ```
 *
 * @throws {FontVerificationError} when the delivered bytes disagree with `asset.sha256`.
 */
export async function verifyFontBytes(asset: FontAsset, bytes: Uint8Array): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new FontVerificationError(asset.sha256, actual);
  }
}
