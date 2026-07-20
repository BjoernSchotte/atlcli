export interface PdfOutputInspection {
  pageCount: number;
  tagged: boolean;
  hasOutline: boolean;
  embeddedFontFiles: number;
  /**
   * Whether the document catalog declares a natural language (`/Lang`) —
   * PDF/UA-1 7.2 and ISO 32000 14.9.2 both require it, and a screen reader
   * without it guesses the pronunciation of every word (spec 011, PDF/UA).
   *
   * Reported, never thrown: the built-in template always emits `/Lang` (it is
   * verified against the real compiler in
   * `packages/pdf-compiler-browser/src/pdf-lang-catalog.test.ts`), but a
   * Level-B custom template is not obliged to, and refusing to emit a
   * compiled document over a missing language would be a harsher gate than
   * the missing-alt audit next to it. `runPdfExport` turns a `false` here into
   * a `pdf-language-missing` warning on the report.
   */
  hasLang: boolean;
}

/**
 * Chunked scanning (spec 010, T5.6).
 *
 * This file used to `TextDecoder("latin1").decode(bytes)` the whole document
 * and run every regex over the resulting string. Measured cost
 * (`packages/pdf/scripts/bytes-memory.bench.ts`, Bun 1.3.8 / JSC, arm64):
 *
 *   | PDF size | live string after decode |
 *   |----------|--------------------------|
 *   | 32 MiB   | +64.0 MiB                |
 *   | 64 MiB   | +128.0 MiB               |
 *
 * — i.e. exactly 2x the file, on top of the bytes themselves, at the moment
 * the compiler's own output copy is also still alive. 64 MiB is not a
 * hypothetical: it is the largest result `PDF_JOB_MAX_BYTES` accepts.
 *
 * The document is now decoded one {@link CHUNK_BYTES} window at a time, so the
 * peak is the window rather than the file. Verdicts are *identical* to the
 * whole-file scan, which is what the tests assert — see {@link windowEndFor}
 * for why a marker straddling a chunk boundary cannot be missed or
 * double-counted.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * {@link CHUNK_BYTES}, exported for the boundary tests only — a test that
 * hard-codes 1 MiB would silently stop testing the boundary the day the chunk
 * size is tuned. Deliberately absent from the package barrels.
 */
export const PDF_SCAN_CHUNK_BYTES = CHUNK_BYTES;

/**
 * An upper bound on how far a single match can reach past the position where
 * it started. The longest literal any pattern below matches is
 * `/StructTreeRoot` (15 bytes) plus the one character `\b` needs to look at.
 */
const MAX_TOKEN_BYTES = 20;

/**
 * The bytes `\s` can match once decoded as Latin-1.
 *
 * `\s` also matches U+1680, U+2000–U+200A, U+2028/9, U+202F, U+205F, U+3000 and
 * U+FEFF, but Latin-1 decoding maps byte `b` to `U+00b`, so no byte can produce
 * any of those. `0xA0` (NO-BREAK SPACE) is the one non-obvious member and it is
 * deliberately included: dropping it would make the chunked scan disagree with
 * the whole-file regex on a file that pads with it.
 */
function isLatin1Whitespace(byte: number): boolean {
  return (
    byte === 0x20 ||
    (byte >= 0x09 && byte <= 0x0d) ||
    byte === 0xa0
  );
}

/** True when `bytes` contains `ascii` starting at `at`. */
function matchesAt(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at < 0 || at + ascii.length > bytes.byteLength) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** First index of `ascii` at or after `from`, or `-1`. Byte-level, no decode. */
function indexOfAscii(bytes: Uint8Array, ascii: string, from: number): number {
  const last = bytes.byteLength - ascii.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (matchesAt(bytes, i, ascii)) return i;
  }
  return -1;
}

/**
 * Last index of `ascii` starting at or before `from`, or `-1`. Mirrors
 * `String.prototype.lastIndexOf(search, fromIndex)`, which also allows the hit
 * to *start* at `fromIndex`.
 */
function lastIndexOfAscii(bytes: Uint8Array, ascii: string, from: number): number {
  for (let i = Math.min(from, bytes.byteLength - ascii.length); i >= 0; i -= 1) {
    if (matchesAt(bytes, i, ascii)) return i;
  }
  return -1;
}

/**
 * Where the decoded window for a chunk ending at `cutoff` must stop.
 *
 * Chunks tile the file: chunk *n* owns matches whose start index falls in
 * `[start, cutoff)`, so every match is counted exactly once no matter how many
 * windows contain it. The only remaining hazard is a match that *starts* before
 * `cutoff` but *ends* after the window — a naive fixed overlap misses those,
 * which is precisely the failure mode chunking introduces.
 *
 * Every pattern here is either a single literal or `/Type` `\s*` `/Page` — one
 * literal, an unbounded whitespace run, one literal. So the window is extended
 * past (a) any partial literal at the cutoff, (b) the whole whitespace run that
 * follows it — *however long* — and (c) the literal after that. `\s*` being
 * unbounded is exactly why (b) is a `while` and not a constant.
 */
function windowEndFor(bytes: Uint8Array, cutoff: number): number {
  const total = bytes.byteLength;
  let end = Math.min(total, cutoff + MAX_TOKEN_BYTES);
  while (end < total && isLatin1Whitespace(bytes[end]!)) end += 1;
  return Math.min(total, end + MAX_TOKEN_BYTES);
}

interface ScanTally {
  pages: number;
  fontFiles: number;
  hasStructTreeRoot: boolean;
  hasMarkInfo: boolean;
  hasOutline: boolean;
  /** Absolute byte offsets of every `/Type /Catalog` hit. */
  catalogAt: number[];
}

/**
 * One chunked pass collecting everything the inspection needs.
 *
 * The regexes are byte-for-byte the ones the whole-file scan used, so the
 * verdicts cannot drift from a rewrite of the matching logic — only the size of
 * the string they run against changed.
 */
function scanPdfBytes(bytes: Uint8Array): ScanTally {
  const decoder = new TextDecoder("latin1");
  const page = /\/Type\s*\/Page\b/g;
  const fontFile = /\/FontFile(?:2|3)?\b/g;
  const catalog = /\/Type\s*\/Catalog\b/g;
  const structTreeRoot = /\/StructTreeRoot\b/g;
  const markInfo = /\/MarkInfo\b/g;
  const outlines = /\/Outlines\b/g;

  const tally: ScanTally = {
    pages: 0,
    fontFiles: 0,
    hasStructTreeRoot: false,
    hasMarkInfo: false,
    hasOutline: false,
    catalogAt: [],
  };

  const total = bytes.byteLength;
  for (let start = 0; start < total; start += CHUNK_BYTES) {
    const cutoff = Math.min(total, start + CHUNK_BYTES);
    const text = decoder.decode(bytes.subarray(start, windowEndFor(bytes, cutoff)));
    const owned = cutoff - start;

    const countOwned = (pattern: RegExp): number => {
      pattern.lastIndex = 0;
      let hits = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index < owned) hits += 1;
      }
      return hits;
    };

    tally.pages += countOwned(page);
    tally.fontFiles += countOwned(fontFile);
    if (!tally.hasStructTreeRoot && countOwned(structTreeRoot) > 0) tally.hasStructTreeRoot = true;
    if (!tally.hasMarkInfo && countOwned(markInfo) > 0) tally.hasMarkInfo = true;
    if (!tally.hasOutline && countOwned(outlines) > 0) tally.hasOutline = true;

    catalog.lastIndex = 0;
    for (const match of text.matchAll(catalog)) {
      if (match.index < owned) tally.catalogAt.push(start + match.index);
    }
  }
  return tally;
}

/**
 * `/Lang` in the document catalog. Matched against the catalog dictionary
 * specifically (not anywhere in the file) so an XMP `dc:language` packet or a
 * `/Lang` on some structure element cannot be mistaken for the document-level
 * declaration that PDF/UA requires.
 *
 * The built-in template's compiler (typst.ts 0.7.0 / Typst 0.14.2) writes the
 * catalog uncompressed, so a byte scan is sufficient and no stream inflation is
 * needed — verified by compiling real PDFs, see the test named above.
 *
 * The enclosing indirect object is located by byte search and only *that* slice
 * is decoded — a catalog dictionary, not the file. Scanning the whole object
 * (not just forward from `/Type`) keeps the check independent of key order
 * inside the dict.
 */
function hasCatalogLang(bytes: Uint8Array, catalogAt: readonly number[]): boolean {
  const decoder = new TextDecoder("latin1");
  for (const at of catalogAt) {
    const objStart = lastIndexOfAscii(bytes, " obj", at);
    const objEnd = indexOfAscii(bytes, "endobj", at);
    const body = decoder.decode(
      bytes.subarray(objStart < 0 ? at : objStart, objEnd < 0 ? bytes.byteLength : objEnd)
    );
    if (/\/Lang\s*[(<]/.test(body)) return true;
  }
  return false;
}

/** `/%%EOF\s*$/` without decoding: trailing whitespace, then the literal. */
function endsWithEof(bytes: Uint8Array): boolean {
  let end = bytes.byteLength;
  while (end > 0 && isLatin1Whitespace(bytes[end - 1]!)) end -= 1;
  return matchesAt(bytes, end - 5, "%%EOF");
}

/** Cheap structural gate before a browser host emits compiled PDF bytes. */
export function validatePdfOutput(bytes: Uint8Array): PdfOutputInspection {
  if (bytes.byteLength < 32) throw new Error("PDF compiler returned a truncated document.");
  if (!matchesAt(bytes, 0, "%PDF-")) throw new Error("PDF compiler returned invalid file bytes.");
  if (!endsWithEof(bytes)) throw new Error("PDF compiler returned an incomplete document.");

  const tally = scanPdfBytes(bytes);
  if (tally.pages === 0) throw new Error("PDF contains no pages.");
  const tagged = tally.hasStructTreeRoot && tally.hasMarkInfo;
  if (!tagged) throw new Error("PDF compiler output is missing the required tag structure.");
  if (tally.fontFiles === 0) throw new Error("PDF compiler output has no embedded font files.");

  return {
    pageCount: tally.pages,
    tagged,
    hasOutline: tally.hasOutline,
    embeddedFontFiles: tally.fontFiles,
    hasLang: hasCatalogLang(bytes, tally.catalogAt),
  };
}
