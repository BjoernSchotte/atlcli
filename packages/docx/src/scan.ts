/**
 * Template placeholder scan (spec 004 Task 3 / PLAN §2.4).
 *
 * Given uploaded `.docx` bytes, unzip with PizZip, walk `document.xml` plus all
 * `header*.xml` / `footer*.xml` parts, merge run-split text per paragraph, and
 * regex out every `$scroll.*` / `$adhocState` occurrence. Each hit is graded via
 * {@link classifyPlaceholder} into supported / unsupported / never so the panel
 * can render ✓ / ⚠ / ✗ and the export report can reuse the same classification.
 *
 * All logic here is pure over the input bytes (PizZip runs in bun and the
 * panel), so the scan is unit-testable against in-test fixtures built with
 * PizZip.
 */
import PizZip from "pizzip";
import { classifyPlaceholder, type PlaceholderStatus } from "./placeholder-map.js";
import { collectParagraphTexts } from "./ooxml-text.js";

/**
 * Why an uploaded `.docx` was refused.
 *
 * `not-zip` / `not-docx` / `too-large` are the original structural rejections.
 * The rest are the spec 011 security-hardening budget + active-content policy:
 * every one is a HARD refusal at import time — nothing is ever silently
 * stripped, because a user who uploaded a macro-bearing template must learn
 * that the template is unusable rather than silently receive a neutered copy.
 */
export type DocxErrorKind =
  | "not-zip"
  | "not-docx"
  | "too-large"
  | "too-many-entries"
  | "path-traversal"
  | "invalid-path"
  | "entry-too-large"
  | "uncompressed-too-large"
  | "active-content";

/** Thrown when uploaded bytes are not a readable/acceptable `.docx` package. */
export class DocxError extends Error {
  constructor(
    readonly kind: DocxErrorKind,
    message: string,
    /** The offending archive member, when the rejection names one. */
    readonly path?: string
  ) {
    super(message);
    this.name = "DocxError";
  }
}

/** 20 MB upload cap (PLAN Task 3 AC) — the COMPRESSED input size. */
export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;

/**
 * Decompression budget for a raw `.docx` upload (spec 011 security hardening).
 *
 * {@link MAX_TEMPLATE_BYTES} bounds only the bytes that arrive; it says nothing
 * about what they inflate to. A 20 MB deflate stream of zeros expands to tens of
 * gigabytes, so a compressed-only cap is not a memory bound at all. These three
 * limits are checked against each entry's **declared** uncompressed size from
 * the zip central directory, BEFORE anything is inflated.
 *
 * This is deliberately a SEPARATE budget from `@atlcli/template-pack`'s
 * `MAX_TEMPLATE_PACK_*` constants: that is the outer `.wiki-pdf-template`
 * container on a different code path. The numbers here are sized for the
 * 20 MB raw-`.docx` path alone.
 */
export interface ArchiveBudget {
  /** Maximum number of zip entries (directories included). */
  maxEntryCount: number;
  /** Maximum cumulative DECLARED uncompressed size across all entries. */
  maxUncompressedBytes: number;
  /** Maximum DECLARED uncompressed size of any single entry. */
  maxSingleEntryUncompressedBytes: number;
}

/**
 * The default budget applied by {@link unzipDocx}.
 *
 * Rationale for each number, given the 20 MB compressed input cap:
 *  - `maxEntryCount: 2048` — a real Word template has tens to low hundreds of
 *    parts (document/styles/settings/numbering + one media entry per image).
 *    2048 leaves an order of magnitude of headroom while stopping an entry
 *    flood, whose cost is per-entry bookkeeping rather than bytes.
 *  - `maxUncompressedBytes: 128 MiB` — ~6.4x the compressed cap. Media (PNG/
 *    JPEG) barely compresses, so a legitimate media-heavy 20 MB template lands
 *    near 20-30 MiB; the XML parts compress ~10-20x but are a few MiB at most.
 *    128 MiB is far above any real template and far below a bomb.
 *  - `maxSingleEntryUncompressedBytes: 64 MiB` — half the cumulative cap, so no
 *    single member can exhaust the budget on its own, and comfortably above the
 *    largest plausible single part.
 */
export const DOCX_ARCHIVE_BUDGET: ArchiveBudget = {
  maxEntryCount: 2048,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxSingleEntryUncompressedBytes: 64 * 1024 * 1024,
};

/** One classified placeholder, aggregated across all occurrences. */
export interface ScanHit {
  /** The classification base, e.g. `$scroll.title` (arguments stripped). */
  base: string;
  status: PlaceholderStatus;
  /** Number of raw occurrences across all parts. */
  count: number;
  /** Distinct raw forms seen (incl. `.("format")` args), for display. */
  raw: string[];
  /** Why an unsupported/never placeholder will be empty. */
  reason?: string;
}

/** Result of {@link scanTemplate}: buckets + which parts were scanned. */
export interface ScanResult {
  supported: ScanHit[];
  unsupported: ScanHit[];
  never: ScanHit[];
  /** Names of the document parts scanned (document.xml, header1.xml, …). */
  parts: string[];
  /** True when the template contains a `$scroll.content` insertion point. */
  hasContentPlaceholder: boolean;
  /**
   * Style names referenced by `STYLEREF` fields anywhere in the template
   * (spec 006 G1). Inventory ONLY — the scan records the names; it does NOT
   * decide pass/fail, because it runs before the page body is serialized and
   * so cannot know which heading styles this export will actually emit after
   * promotion. `exportDocx` validates this against the emitted styles.
   */
  stylerefStyleNames: string[];
  /**
   * Risky field-instruction keywords found anywhere in the template (spec 011
   * active-content audit): `INCLUDETEXT`, `INCLUDEPICTURE`, `DDEAUTO`, `DDE`.
   * Inventory ONLY — `exportDocx` turns a non-empty list into a
   * `template-field-instruction-risk` report note. Never a rejection: these
   * instructions have legitimate uses, unlike VBA/ActiveX/altChunk, which
   * {@link unzipDocx} refuses outright.
   */
  riskyFieldInstructions: string[];
}

/**
 * Collect the style names referenced by `STYLEREF` fields in one part's XML
 * (spec 006 G1). Covers both `w:fldSimple` (instruction in an attribute) and
 * complex fields (`w:instrText`), reassembling instruction text split across
 * multiple `w:instrText` runs before matching. Diagnostics-only — never
 * mutates anything. Quotes may be literal or XML-escaped (`&quot;`).
 */
export function collectStylerefFields(xml: string): string[] {
  const names: string[] = [];
  const decode = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  const matchRefs = (instr: string): void => {
    for (const m of decode(instr).matchAll(/STYLEREF\s+"([^"]+)"/gi)) names.push(m[1].trim());
  };
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)) matchRefs(m[1]);
  // Reassemble run-split complex-field instruction text: concatenate adjacent
  // instrText runs so ` STYL` + `EREF "…"` split across runs still matches.
  const instrConcat = [...xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)]
    .map((m) => m[1])
    .join("");
  matchRefs(instrConcat);
  return names;
}

/**
 * `$scroll.<dotted-name>[ .(args) ]` or the bare Comala `$adhocState`.
 *
 * The name is one or more dot-separated alphabetic segments; the grammar stops
 * at the last segment so a sentence-ending period is NOT swallowed
 * (`$scroll.title.` matches `$scroll.title`, leaving the `.` as literal text).
 * A real dotted sub-token (`$scroll.pagelabels.capitalised`) still matches whole.
 * An optional argument group — `.("dd.MM.yyyy")`, `.(key,fallback)` — is picked
 * up via the optional leading dot before the parenthesis. This one regex is the
 * single placeholder grammar shared by the scan, the resolver, and the
 * body/header/footer preprocessor.
 */
export const PLACEHOLDER_RE = /\$scroll\.[A-Za-z]+(?:\.[A-Za-z]+)*(?:\.?\([^)]*\))?|\$adhocState/g;

/**
 * The document parts a scan/preprocess must cover:
 *  - the main story + all headers/footers (WordprocessingML `<w:t>` text), and
 *  - chart (`word/charts/chart*.xml`) and SmartArt-diagram
 *    (`word/diagrams/data*.xml` / `drawing*.xml`) parts, whose placeholder text
 *    lives in DrawingML `<a:t>` runs in a SEPARATE part rather than in the main
 *    story. {@link import("./ooxml-text.js").collectParagraphTexts} /
 *    {@link import("./ooxml-text.js").rewriteScrollText} read `<a:t>` from these.
 *
 * `$scroll.content` never lives in a chart/diagram part, so including them here
 * is safe for the content-anchor lookup ({@link import("./export.js")}).
 */
export function documentPartNames(zip: PizZip): string[] {
  return Object.keys(zip.files)
    .filter(
      (n) =>
        /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n) ||
        /^word\/charts\/chart\d*\.xml$/.test(n) ||
        /^word\/diagrams\/(data|drawing)\d*\.xml$/.test(n)
    )
    .sort();
}

/** Minimal read view over a PizZip entry, including its declared sizes. */
interface ReadEntry {
  name: string;
  dir: boolean;
  _data?: { uncompressedSize?: number };
}

/**
 * Reject any member path that could escape the archive root.
 *
 * Mirrors `assertSafePath` in `@atlcli/template-pack`'s `unpack.ts` (spec 007)
 * deliberately rather than importing it: that module throws `TemplatePackError`
 * for the outer `.wiki-pdf-template` container, and `@atlcli/docx` must not take
 * a dependency on the PDF container format to validate a raw `.docx`. The RULE
 * is identical on purpose — `..` segments, absolute paths, backslashes, drive
 * prefixes, and ASCII control characters — because both are archives whose
 * member names may end up on a filesystem or in a derived identifier.
 *
 * Nothing in `unzipDocx` writes members to disk today, so this is defense in
 * depth: it stops a hostile name at the boundary, before a future caller
 * (an "extract this template" feature, a debug dump) can be tricked by it.
 */
export function assertSafeDocxEntryName(name: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new DocxError(
      "invalid-path",
      `Control character in archive entry name ${JSON.stringify(name)}.`,
      name
    );
  }
  if (name.includes("\\")) {
    throw new DocxError("path-traversal", `Backslash in archive entry name "${name}".`, name);
  }
  if (name.startsWith("/")) {
    throw new DocxError("path-traversal", `Absolute archive entry name "${name}".`, name);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new DocxError("path-traversal", `Drive-letter archive entry name "${name}".`, name);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new DocxError(
      "path-traversal",
      `Parent-directory segment in archive entry name "${name}".`,
      name
    );
  }
}

/**
 * Enforce {@link ArchiveBudget} + entry-name policy over a loaded archive.
 *
 * Runs entirely on the central-directory metadata PizZip parsed at load time:
 * every size compared here is the entry's DECLARED uncompressed size, so a zip
 * bomb is refused before a single byte is inflated. Exported for tests and for
 * hosts that hold a `PizZip` from elsewhere.
 */
export function assertArchiveBudget(
  zip: PizZip,
  budget: ArchiveBudget = DOCX_ARCHIVE_BUDGET
): void {
  const entries = Object.values(zip.files) as unknown as ReadEntry[];
  if (entries.length > budget.maxEntryCount) {
    throw new DocxError(
      "too-many-entries",
      `Template archive has ${entries.length} entries (limit ${budget.maxEntryCount}).`
    );
  }
  let cumulative = 0;
  for (const entry of entries) {
    assertSafeDocxEntryName(entry.name);
    if (entry.dir) continue;
    // An entry whose declared size is unreadable cannot be budgeted, so it is
    // refused rather than inflated blind.
    const declared = entry._data?.uncompressedSize;
    if (typeof declared !== "number" || !Number.isFinite(declared) || declared < 0) {
      throw new DocxError(
        "entry-too-large",
        `Cannot determine the declared uncompressed size of "${entry.name}".`,
        entry.name
      );
    }
    if (declared > budget.maxSingleEntryUncompressedBytes) {
      throw new DocxError(
        "entry-too-large",
        `Archive member "${entry.name}" declares ${declared} uncompressed bytes (per-entry limit ${budget.maxSingleEntryUncompressedBytes}).`,
        entry.name
      );
    }
    cumulative += declared;
    if (cumulative > budget.maxUncompressedBytes) {
      throw new DocxError(
        "uncompressed-too-large",
        `Template archive declares more than ${budget.maxUncompressedBytes} uncompressed bytes in total.`,
        entry.name
      );
    }
  }
}

/**
 * Archive members that carry executable / externally-linked Word payloads
 * (spec 011 active-content policy).
 *
 *  - `word/vbaProject.bin` — the VBA macro storage of a `.docm`-style template.
 *    Renaming a `.docm` to `.docx` leaves this part in place; Word will happily
 *    honour it once the content type says so.
 *  - `word/vbaData.xml` — the companion VBA part; present only alongside macros.
 *  - `word/activeX/…` — ActiveX / OLE control parts (`activeX1.xml` plus its
 *    `activeX1.bin` control state), which instantiate a COM object on open.
 *
 * Matching is case-insensitive because zip member names are not normalized and
 * `word/VBAProject.bin` is the same part to Word.
 */
function classifyActiveContentPart(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "word/vbaproject.bin") return "a VBA macro project (word/vbaProject.bin)";
  if (lower === "word/vbadata.xml") return "a VBA macro data part (word/vbaData.xml)";
  if (lower.startsWith("word/activex/")) return `an ActiveX/OLE control part (${name})`;
  return undefined;
}

/**
 * Parts whose XML is inspected for `<w:altChunk>` — the main story plus every
 * header/footer. The spec names `document.xml`; headers and footers accept the
 * same element, so they are covered too rather than left as a bypass.
 */
function altChunkScanParts(zip: PizZip): string[] {
  return Object.keys(zip.files).filter((n) =>
    /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n)
  );
}

/**
 * Every relationship part in the package (`*.rels`), for the aFChunk sweep.
 *
 * Deliberately not narrowed to `word/_rels/document.xml.rels`: a header's or
 * footer's own rels part can carry the relationship just as well, and matching
 * on the suffix costs nothing while leaving no part uncovered.
 */
function relationshipPartNames(zip: PizZip): string[] {
  return Object.keys(zip.files).filter((n) => /\.rels$/i.test(n));
}

/**
 * Resolve XML character references in an attribute value.
 *
 * A conforming parser resolves `&#107;` to `k` before the value is ever
 * compared, so `…/aFChun&#107;` and `…/aFChunk` are the same relationship type
 * to Word while differing as raw text. Numeric refs are expanded before
 * `&amp;` so that a literal `&amp;#107;` — which denotes the *text* `&#107;`,
 * not `k` — is not over-decoded.
 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/**
 * True when a `.rels` part declares an altChunk relationship — a `Type` ending
 * in `/aFChunk` (`…/officeDocument/2006/relationships/aFChunk`).
 *
 * This is the companion half of the `<w:altChunk>` element scan, and the more
 * reliable of the two. The element scan matches a literal `w:` prefix, but XML
 * binds namespaces by URI, not by prefix: a template that declares
 * `xmlns:x="…/wordprocessingml/2006/main"` and writes `<x:altChunk r:id="…"/>`
 * carries the very same element as far as Word is concerned, while matching no
 * `<w:altChunk` text. A relationship `Type`, by contrast, is a plain attribute
 * *value* that has to equal the aFChunk URI for Word to resolve the import at
 * all — there is no prefix indirection to hide behind.
 *
 * Both halves are required for the import to fire (an element with no matching
 * relationship is an inert dangling `r:id`, and vice versa), so scanning each
 * one closes the gap the other leaves. Matching is case-insensitive and runs on
 * the entity-decoded value: neither variation would function in Word, so a hit
 * on one can only mean an obfuscation attempt.
 */
export function hasAltChunkRelationship(relsXml: string): boolean {
  for (const m of relsXml.matchAll(/\bType\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (/\/aFChunk$/i.test(decodeXmlEntities(m[1] ?? m[2] ?? "").trim())) return true;
  }
  return false;
}

/**
 * Refuse an imported template that carries active content (spec 011).
 *
 * REJECT, never strip. A silent strip would hand back a document that looks
 * like the user's template but is not, and would make this a security control
 * the user cannot see; a typed `active-content` {@link DocxError} makes the
 * refusal explicit at the upload boundary.
 *
 * `<w:altChunk>` is included because it is an *import by reference*: the element
 * names a relationship whose target (HTML, RTF, another Word document) Word
 * pulls in and renders at open time. Combined with `ensureUpdateFields`, which
 * this exporter sets on every rendered document, an altChunk-bearing template is
 * a live external-content channel through the export.
 *
 * @throws {DocxError} `active-content` naming the offending part.
 */
export function assertNoActiveContent(zip: PizZip): void {
  for (const name of Object.keys(zip.files)) {
    const what = classifyActiveContentPart(name);
    if (what) {
      throw new DocxError(
        "active-content",
        `Template contains ${what}. Templates with macros or ActiveX/OLE controls cannot be imported; re-save the file as a plain .docx without them.`,
        name
      );
    }
  }
  for (const part of altChunkScanParts(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    if (/<w:altChunk[\s/>]/.test(xml)) {
      throw new DocxError(
        "active-content",
        `Template part "${part}" embeds external content via <w:altChunk>. Templates that import content by reference cannot be used; inline the content and re-save.`,
        part
      );
    }
  }
  // Runs AFTER the element scan so a template carrying both halves is still
  // reported against the part the author would recognise (document.xml), with
  // the relationship sweep catching only what the element regex missed.
  for (const part of relationshipPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    if (hasAltChunkRelationship(xml)) {
      throw new DocxError(
        "active-content",
        `Template part "${part}" declares an altChunk (aFChunk) relationship, the import-by-reference channel behind <w:altChunk>. Templates that import content by reference cannot be used; inline the content and re-save.`,
        part
      );
    }
  }
}

/**
 * Field instructions that reach outside the document when Word refreshes fields.
 *
 * `preprocessScrollText` deliberately leaves field instructions untouched, and
 * `ensureUpdateFields` writes `<w:updateFields w:val="true"/>` into every
 * exported document — so Word refreshes the template's own fields on open. That
 * combination is what turns a hostile `INCLUDETEXT`/`DDEAUTO` instruction into
 * an action. These are AUDITED, not rejected: unlike VBA/ActiveX they have
 * legitimate uses in real templates, so the export surfaces a report note
 * (`template-field-instruction-risk`) rather than refusing the upload.
 */
const RISKY_FIELD_INSTRUCTIONS = ["INCLUDETEXT", "INCLUDEPICTURE", "DDEAUTO", "DDE"] as const;

/**
 * Collect the risky field-instruction keywords present anywhere in the template
 * (see {@link RISKY_FIELD_INSTRUCTIONS}). Diagnostics ONLY — never mutates.
 *
 * Reuses {@link collectStylerefFields}'s reassembly trick: Word splits a complex
 * field's instruction across several `<w:instrText>` runs, so the runs are
 * concatenated before matching and ` INCLUDE` + `TEXT "…"` still matches.
 * Returns the distinct keywords found, uppercased, in declaration order.
 */
export function collectRiskyFieldInstructions(xml: string): string[] {
  const decode = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  let haystack = "";
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)) haystack += ` ${decode(m[1])}`;
  haystack += ` ${decode(
    [...xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]).join("")
  )}`;
  const found: string[] = [];
  for (const keyword of RISKY_FIELD_INSTRUCTIONS) {
    // Word-boundary match so DDEAUTO is not also reported as a bare DDE hit.
    if (new RegExp(`\\b${keyword}\\b`, "i").test(haystack) && !found.includes(keyword)) {
      found.push(keyword);
    }
  }
  return found;
}

/**
 * Unzip uploaded `.docx` bytes into a PizZip archive, validating that it is a
 * zip, fits the decompression budget, carries no hostile entry names, looks
 * like a Word document (`word/document.xml` present), and carries no active
 * content.
 *
 * Order matters: the budget and entry-name checks run on central-directory
 * metadata only, BEFORE `assertNoActiveContent` reads (and therefore inflates)
 * `word/document.xml`. A bomb can never be inflated to prove it is a bomb.
 *
 * @throws {DocxError} `too-large` past the compressed cap; `not-zip` on a
 *   non-zip buffer; `too-many-entries` / `entry-too-large` /
 *   `uncompressed-too-large` past {@link DOCX_ARCHIVE_BUDGET};
 *   `path-traversal` / `invalid-path` on a hostile entry name; `not-docx` when
 *   the zip lacks `word/document.xml`; `active-content` on VBA/ActiveX/altChunk.
 */
export function unzipDocx(bytes: Uint8Array, budget: ArchiveBudget = DOCX_ARCHIVE_BUDGET): PizZip {
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new DocxError("too-large", `Template exceeds the ${MAX_TEMPLATE_BYTES} byte limit.`);
  }
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch (err) {
    throw new DocxError("not-zip", `Not a valid .docx (zip) file: ${(err as Error).message}`);
  }
  assertArchiveBudget(zip, budget);
  if (!zip.file("word/document.xml")) {
    throw new DocxError("not-docx", "File is a zip but not a Word document (no word/document.xml).");
  }
  assertNoActiveContent(zip);
  return zip;
}

/**
 * Scan an already-unzipped template for placeholders.
 * Exposed separately so the export flow can reuse a zip it already holds.
 */
export function scanZip(zip: PizZip): ScanResult {
  const parts = documentPartNames(zip);
  const byBase = new Map<string, ScanHit>();
  let hasContent = false;
  const stylerefStyleNames: string[] = [];
  const riskyFieldInstructions: string[] = [];

  for (const part of parts) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const name of collectStylerefFields(xml)) {
      if (!stylerefStyleNames.includes(name)) stylerefStyleNames.push(name);
    }
    for (const keyword of collectRiskyFieldInstructions(xml)) {
      if (!riskyFieldInstructions.includes(keyword)) riskyFieldInstructions.push(keyword);
    }
    // Walk every paragraph the replacement will touch — including text-box
    // (mc:Choice + mc:Fallback) and drawing-adjacent occurrences — so the panel's
    // supported-list matches what preprocessScrollText actually resolves.
    for (const text of collectParagraphTexts(xml)) {
      if (!text.includes("$scroll") && !text.includes("$adhocState")) continue;
      let m: RegExpExecArray | null;
      PLACEHOLDER_RE.lastIndex = 0;
      while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
        const raw = m[0];
        const cls = classifyPlaceholder(raw);
        if (cls.base === "$scroll.content") hasContent = true;
        const existing = byBase.get(cls.base);
        if (existing) {
          existing.count += 1;
          if (!existing.raw.includes(raw)) existing.raw.push(raw);
        } else {
          byBase.set(cls.base, {
            base: cls.base,
            status: cls.status,
            count: 1,
            raw: [raw],
            reason: cls.reason,
          });
        }
      }
    }
  }

  const supported: ScanHit[] = [];
  const unsupported: ScanHit[] = [];
  const never: ScanHit[] = [];
  for (const hit of byBase.values()) {
    // $scroll.content is the content insertion point, not a listed placeholder.
    if (hit.base === "$scroll.content") continue;
    if (hit.status === "supported") supported.push(hit);
    else if (hit.status === "unsupported") unsupported.push(hit);
    else never.push(hit);
  }
  const byName = (a: ScanHit, b: ScanHit) => a.base.localeCompare(b.base);
  supported.sort(byName);
  unsupported.sort(byName);
  never.sort(byName);

  return {
    supported,
    unsupported,
    never,
    parts,
    hasContentPlaceholder: hasContent,
    stylerefStyleNames,
    riskyFieldInstructions,
  };
}

/** Validate + unzip + scan uploaded template bytes in one call (Task 3). */
export function scanTemplate(bytes: Uint8Array): ScanResult {
  return scanZip(unzipDocx(bytes));
}
