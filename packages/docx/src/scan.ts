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
  | "suspicious-compression"
  | "corrupt-entry"
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
   * Distinct docxtpl/Jinja placeholder forms found in the TEMPLATE's own text
   * (spec 010 W3-D) — placeholder syntax this engine will never fill. Inventory
   * ONLY: `exportDocx` turns a non-empty list into a `warning`-level
   * `template-foreign-placeholders` note. Whitespace-normalized for display,
   * first-seen order, capped at {@link MAX_FOREIGN_PLACEHOLDERS} distinct forms.
   *
   * OPTIONAL for the same additive-API reason as
   * {@link ScanResult.riskyFieldInstructions}; always populated by
   * {@link scanZip}, so read it as `?? []`.
   */
  foreignPlaceholders?: string[];
  /**
   * Audited field-instruction keywords found anywhere in the template (spec 011):
   * `INCLUDETEXT` and `INCLUDEPICTURE`. Inventory ONLY — `exportDocx` turns a
   * non-empty list into a `template-field-instruction-risk` report note. These
   * two have legitimate uses in corporate templates, so they are surfaced rather
   * than refused.
   *
   * `DDE`/`DDEAUTO` are deliberately NOT here: they have no legitimate use in an
   * export template and are a documented remote-code-execution chain, so
   * {@link unzipDocx} rejects them outright via {@link assertNoActiveContent}.
   *
   * OPTIONAL because spec 009 froze this package's public API as additive-only —
   * a required field would break every existing `ScanResult` literal. Always
   * populated by {@link scanZip}; read it as `?? []`.
   */
  riskyFieldInstructions?: string[];
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
 * docxtpl/Jinja placeholder syntax — `{{ … }}` (variable) and `{% … %}` (tag,
 * which covers docxtpl's paragraph/row/cell forms `{%p …%}` / `{%tr …%}` /
 * `{%tc …%}`).
 *
 * This engine fills `$scroll.*` only. A docxtpl template handed to `--engine ts`
 * therefore renders its placeholders as VISIBLE LITERAL TEXT: the export flow
 * swaps docxtemplater's delimiters for a Unicode Private-Use pair precisely so
 * that a customer's own braces are never treated as tags, which means `{{ title }}`
 * survives the render intact and lands in the finished document. That is the
 * silent failure this pattern exists to name — a 62-page `.docx` shipped with
 * seven unfilled `{{ … }}` placeholders in the body and a report that said
 * nothing about them.
 *
 * Bounded and newline-anchored: a placeholder never spans a hard break (
 * {@link import("./ooxml-text.js").paragraphText} renders `<w:br/>`/`<w:tab/>` as
 * `\n`), and the 200-char ceiling keeps a document full of stray braces from
 * degenerating into quadratic backtracking. Non-greedy, so `{{ {'a': 1} }}`
 * closes at its own `}}`.
 */
export const FOREIGN_PLACEHOLDER_RE = /\{\{[^\n]{1,200}?\}\}|\{%[^\n]{1,200}?%\}/g;

/**
 * How many DISTINCT foreign placeholder forms a scan records. The note only ever
 * shows a handful; the cap keeps a pathological template from carrying an
 * unbounded array through the report.
 */
export const MAX_FOREIGN_PLACEHOLDERS = 20;

/**
 * The docxtpl/Jinja placeholder forms in one paragraph's text, whitespace-
 * normalized for display (Word's run splitting and `xml:space` handling make the
 * raw spacing meaningless). Pure; see {@link FOREIGN_PLACEHOLDER_RE}.
 *
 * Call this with TEMPLATE text only. Page content is scanned nowhere: `scanZip`
 * runs on the template archive before the exported body is injected, so a page
 * that legitimately documents Jinja can never trigger the note.
 */
export function collectForeignPlaceholders(text: string): string[] {
  if (!text.includes("{")) return [];
  const found: string[] = [];
  FOREIGN_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOREIGN_PLACEHOLDER_RE.exec(text)) !== null) {
    const normalized = m[0].replace(/\s+/g, " ").trim();
    if (!found.includes(normalized)) found.push(normalized);
  }
  return found;
}

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
  _data?: { uncompressedSize?: number; compressedSize?: number };
}

/**
 * Plausibility bounds on an entry's DECLARED uncompressed size, relative to its
 * compressed size (spec 011 round 3).
 *
 * The declared size lives in the zip central directory, which is entirely
 * attacker-controlled. Budgeting on it alone was defeated by simply lying:
 * an archive whose `word/document.xml` declared 1 KiB while its DEFLATE stream
 * expanded to 400 MiB sailed past every cap and was inflated (measured: RSS
 * +819 MiB in 227 ms) before PizZip noticed the mismatch. These two ratios make
 * the declared size self-checking against a quantity the attacker cannot forge
 * without also shrinking the payload — the compressed byte count.
 */

/**
 * Maximum plausible declared:compressed ratio.
 *
 * DEFLATE tops out near 1032:1. Measured ratios for real `.docx` parts built by
 * this package's own fixtures:
 *
 * | Part                              | ratio   |
 * |-----------------------------------|---------|
 * | Incompressible media (JPEG/PNG)    |   ~1:1  |
 * | 4000-paragraph `document.xml`      |  26.6:1 |
 * | 20 000 IDENTICAL paragraphs        | 304.9:1 |
 *
 * The third row is why this is 500 and not the 100 first chosen: a highly
 * repetitive but entirely legitimate template (a long form of identical empty
 * rows) compresses far better than typical prose, and a 100:1 cap rejected it.
 * A limit that refuses real templates is an availability bug, not a control.
 *
 * 500:1 sits above every legitimate shape measured and below DEFLATE's ceiling,
 * so it still catches a bomb that stays UNDER the absolute caps — e.g. 60 MiB
 * declared from 60 KiB compressed passes {@link ArchiveBudget} but is refused
 * here. The absolute caps remain the primary defence against honest bombs; this
 * is the secondary one that narrows the sub-cap window.
 */
const MAX_DECLARED_COMPRESSION_RATIO = 500;

/**
 * Minimum plausible declared:compressed ratio.
 *
 * DEFLATE never meaningfully expands its input: worst case is ~1.0003x plus a
 * few bytes of framing. A member declaring FEWER bytes than its own compressed
 * stream is therefore provably lying about its size, which is exactly the shape
 * of the inflation bypass above. 0.9 tolerates the framing overhead on tiny
 * entries while still catching a lie by orders of magnitude.
 */
const MIN_DECLARED_COMPRESSION_RATIO = 0.9;

/**
 * Below this compressed size the ratio checks are skipped.
 *
 * Zip framing dominates tiny members (a 4-byte part can carry a 92-byte
 * compressed record), which makes both ratios meaningless and would reject
 * ordinary small parts like `[Content_Types].xml`. A member this small cannot
 * inflate to anything dangerous even at the theoretical maximum ratio
 * (512 B x 1032 = 528 KiB), so skipping it costs nothing.
 */
const COMPRESSION_RATIO_FLOOR_BYTES = 512;

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
 * Reject an entry whose declared uncompressed size is implausible for its own
 * compressed stream (see {@link MAX_DECLARED_COMPRESSION_RATIO} /
 * {@link MIN_DECLARED_COMPRESSION_RATIO}).
 *
 * Exported so `@atlcli/template-pack`'s `.wiki-pdf-template` reader — which
 * budgets on declared sizes the same way and has the same blind spot — can
 * adopt the identical rule without re-deriving the constants.
 *
 * @throws {DocxError} `suspicious-compression`.
 */
export function assertPlausibleCompression(
  entry: { name: string; _data?: { compressedSize?: number } },
  declared: number
): void {
  const compressed = entry._data?.compressedSize;
  if (typeof compressed !== "number" || !Number.isFinite(compressed)) return;
  if (compressed < COMPRESSION_RATIO_FLOOR_BYTES) return;
  if (declared > compressed * MAX_DECLARED_COMPRESSION_RATIO) {
    throw new DocxError(
      "suspicious-compression",
      `Archive member "${entry.name}" declares ${declared} bytes from ${compressed} compressed (ratio ${(declared / compressed).toFixed(1)}:1, limit ${MAX_DECLARED_COMPRESSION_RATIO}:1).`,
      entry.name
    );
  }
  if (declared < compressed * MIN_DECLARED_COMPRESSION_RATIO) {
    throw new DocxError(
      "suspicious-compression",
      `Archive member "${entry.name}" declares only ${declared} uncompressed bytes for a ${compressed}-byte compressed stream. DEFLATE never expands its input, so the declared size is false — refusing before inflation.`,
      entry.name
    );
  }
}

/**
 * Enforce {@link ArchiveBudget} + entry-name policy over a loaded archive.
 *
 * Runs entirely on the central-directory metadata PizZip parsed at load time,
 * so nothing here inflates a byte. Two independent families of check, because
 * the declared size is attacker-controlled and one family alone is bypassable:
 *
 *  - ABSOLUTE caps ({@link ArchiveBudget}) refuse an HONEST bomb — one that
 *    truthfully declares a huge payload.
 *  - RATIO plausibility ({@link assertPlausibleCompression}) refuses a LYING
 *    central directory — one that under-declares to slip past those caps and
 *    detonate at inflation time.
 *
 * Residual risk, stated plainly: an entry that declares a size consistent with
 * its compressed stream but whose DEFLATE data decodes to something else still
 * inflates before PizZip's own post-hoc size comparison fires. PizZip exposes no
 * bounded/streaming inflate, so that spike cannot be prevented here; it is
 * bounded by {@link MAX_TEMPLATE_BYTES} and surfaces as a typed
 * `corrupt-entry` {@link DocxError} rather than an untyped crash (see
 * {@link readPartText}).
 *
 * Exported for tests and for hosts that hold a `PizZip` from elsewhere.
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
    assertPlausibleCompression(entry, declared);
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
 * Archive members that carry executable / externally-linked Word payloads,
 * matched by PATH (spec 011 active-content policy).
 *
 * A path check alone is NOT sufficient and is not relied on as such — see
 * {@link findActiveContentRelationship}, which is the authoritative half. OPC
 * resolves a part by the relationship that points at it, never by its location,
 * so `word/macros/vbaProject.bin` or `customXml/vbaProject.bin` is just as live
 * as the canonical path. This function is the belt to that pair of braces: it
 * catches a payload dropped in without any relationship at all, and it names
 * the part in terms an author recognises.
 *
 * Matching is case-insensitive (zip member names are not normalized, and
 * `word/VBAProject.bin` is the same part to Word) and matches on the BASENAME
 * or an `activeX`/`macros` path segment, so relocating the payload does not
 * evade it.
 */
function classifyActiveContentPart(name: string): string | undefined {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === "vbaproject.bin") return `a VBA macro project (${name})`;
  if (base === "vbadata.xml") return `a VBA macro data part (${name})`;
  // Any `activeX/` folder anywhere, plus the conventional `activeXN.xml|bin`
  // basenames wherever they were relocated to.
  if (lower.split("/").includes("activex")) return `an ActiveX/OLE control part (${name})`;
  if (/^activex\d*\.(xml|bin)$/.test(base)) return `an ActiveX/OLE control part (${name})`;
  return undefined;
}

/**
 * EVERY WordprocessingML part in the package — the main story plus headers,
 * footers, footnotes, endnotes, comments, glossary, charts, diagrams.
 *
 * Two callers need exactly this breadth, for the same underlying reason: a
 * document's content is not confined to `word/document.xml`.
 *
 *  - The `altChunk` sweep ({@link assertNoActiveContent}). `CT_AltChunk` is a
 *    member of `EG_BlockLevelElts`, so it is valid anywhere block-level content
 *    is. Probing the earlier document/header/footer-only list found it accepted
 *    in `word/footnotes.xml`, `word/endnotes.xml`, `word/comments.xml` and
 *    `word/glossary/document.xml`.
 *  - The field sweep ({@link needsFieldRefresh}). A TOC in a header, a `SEQ` in
 *    a footnote and a `STYLEREF` in a footer are all ordinary authoring; a
 *    document-only scan would call such a document field-free and ship it
 *    without the refresh flag.
 *
 * Deliberately NOT narrowed further: the cost is one regex over parts that are
 * being read anyway, and every narrowing so far has turned out to have a
 * counterexample.
 */
function wordprocessingPartNames(zip: PizZip): string[] {
  return Object.keys(zip.files).filter(
    (n) => /^word\/.*\.xml$/i.test(n) && !/^word\/_rels\//i.test(n)
  );
}

/**
 * Inflate one part to text, translating a decompression failure into a typed
 * {@link DocxError}.
 *
 * PizZip throws a bare `Error("Bug : uncompressed data size mismatch")` when a
 * member's real inflated length disagrees with its declared size — precisely
 * what a forged central directory produces. Left untranslated that reaches every
 * caller as an unhandled exception with no `kind` to switch on, so a host that
 * carefully handles `DocxError` still crashes. Every read of a template part
 * inside this module goes through here.
 *
 * @throws {DocxError} `corrupt-entry` when the member cannot be decompressed.
 */
export function readPartText(zip: PizZip, part: string): string {
  try {
    return zip.file(part)?.asText() ?? "";
  } catch (err) {
    throw new DocxError(
      "corrupt-entry",
      `Archive member "${part}" could not be decompressed (${(err as Error).message}); the archive is corrupt or its central directory is falsified.`,
      part
    );
  }
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
 * Relationship types that make a part live active content.
 *
 * OPC binds a part to its role through the relationship `Type` URI, which is a
 * plain attribute VALUE — there is no namespace-prefix indirection to hide
 * behind and no path to relocate. This is why the relationship sweep, not the
 * path list, is the authoritative check.
 *
 *  - `/aFChunk` — `<w:altChunk>` import-by-reference (HTML/RTF/DOCX pulled in
 *    and rendered at open time).
 *  - `/vbaProject` — the VBA macro storage of a `.docm`-style template.
 *  - `/control` — an ActiveX control, which instantiates a COM object on open.
 *
 * `/oleObject` is deliberately NOT listed: embedded OLE objects (a chart, a
 * linked spreadsheet) appear in legitimate corporate templates, so rejecting
 * them would break real documents. That is a product judgement, recorded here
 * rather than left implicit.
 */
const ACTIVE_CONTENT_RELATIONSHIP_TYPES: ReadonlyArray<{ suffix: string; what: string }> = [
  { suffix: "aFChunk", what: "an altChunk (aFChunk) import-by-reference relationship" },
  { suffix: "vbaProject", what: "a VBA macro project relationship" },
  { suffix: "control", what: "an ActiveX control relationship" },
];

/**
 * The first active-content relationship declared in a `.rels` part, if any.
 *
 * Matching is case-insensitive and runs on the entity-decoded `Type` value:
 * neither a case variant nor a charref-obfuscated URI would function in Word,
 * so a hit on one can only be an evasion attempt.
 */
export function findActiveContentRelationship(relsXml: string): string | undefined {
  for (const m of relsXml.matchAll(/\bType\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const type = decodeXmlEntities(m[1] ?? m[2] ?? "").trim();
    for (const { suffix, what } of ACTIVE_CONTENT_RELATIONSHIP_TYPES) {
      if (new RegExp(`/${suffix}$`, "i").test(type)) return what;
    }
  }
  return undefined;
}

/**
 * True when a `.rels` part declares an altChunk relationship.
 *
 * Retained as a named export for API stability; {@link findActiveContentRelationship}
 * is the general form and is what {@link assertNoActiveContent} calls.
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
 * Four independent sweeps, because each covers a gap the others leave:
 *  1. PATH — a payload dropped in with no relationship at all.
 *  2. ELEMENT — an `altChunk` element in any WordprocessingML part, matched
 *     under ANY namespace prefix (XML binds namespaces by URI, so `<x:altChunk>`
 *     is the same element as `<w:altChunk>` and a `w:`-only regex missed it).
 *  3. RELATIONSHIP — the authoritative one: an `aFChunk`/`vbaProject`/`control`
 *     relationship type in any `.rels` part, which is how OPC actually resolves
 *     these parts and the only channel that cannot be evaded by relocating a
 *     file or renaming a prefix.
 *  4. FIELD INSTRUCTION — `DDE`/`DDEAUTO`, a documented remote-code-execution
 *     chain with no legitimate use in an export template. Rejected, never merely
 *     audited: see {@link REJECTED_FIELD_INSTRUCTIONS} for why the refusal does
 *     not depend on whether THIS export sets the field-refresh flag.
 *
 * Runs inside {@link unzipDocx}, so the guarantee does not depend on which entry
 * point a host uses.
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
  for (const part of wordprocessingPartNames(zip)) {
    const xml = readPartText(zip, part);
    // Any namespace prefix, or none: `<w:altChunk`, `<x:altChunk`, `<altChunk`.
    if (/<(?:[A-Za-z_][\w.-]*:)?altChunk[\s/>]/.test(xml)) {
      throw new DocxError(
        "active-content",
        `Template part "${part}" embeds external content via <altChunk>. Templates that import content by reference cannot be used; inline the content and re-save.`,
        part
      );
    }
  }
  for (const part of relationshipPartNames(zip)) {
    const what = findActiveContentRelationship(readPartText(zip, part));
    if (what) {
      throw new DocxError(
        "active-content",
        `Template part "${part}" declares ${what}. Templates carrying macros, ActiveX controls or import-by-reference content cannot be used; re-save the file without them.`,
        part
      );
    }
  }
  for (const part of documentPartNames(zip)) {
    const hits = collectFieldInstructions(readPartText(zip, part), REJECTED_FIELD_INSTRUCTIONS);
    if (hits.length > 0) {
      throw new DocxError(
        "active-content",
        `Template part "${part}" contains a ${hits.join("/")} field instruction, a remote-code-execution channel that Word runs when it refreshes fields. Exported documents refresh fields on open, so such templates cannot be used.`,
        part
      );
    }
  }
}

/**
 * Field instructions that reach outside the document when Word refreshes fields.
 *
 * `preprocessScrollText` deliberately leaves field instructions untouched, so
 * whatever instruction the template carries survives into the exported document
 * verbatim. That is why the two lists below are graded differently.
 *
 * REJECTED: `DDE`/`DDEAUTO` execute an arbitrary command through Dynamic Data
 * Exchange. This is a documented remote-code-execution chain with no legitimate
 * use in an export template, so it is refused at import rather than audited.
 *
 * The refusal is deliberately INDEPENDENT of `<w:updateFields>`. An earlier
 * revision of this comment justified it by "the exporter writes the refresh flag
 * into every document, so the exporter itself arms the trigger" — true then,
 * false since {@link needsFieldRefresh} made the flag conditional. The premise
 * changed; the rule does not, and the rule was never contingent on it:
 *  - A `DDE` field fires on ANY field refresh — the reader pressing F9, printing,
 *    or Word's own "update fields before printing" option — not only the refresh
 *    this exporter's flag requests.
 *  - `DDE` is not on the {@link REFRESH_SENSITIVE_FIELDS} list, so a template
 *    carrying one would (absent this rejection) sail through with NO flag set
 *    and no note — a quieter delivery of the same payload, not a safer one.
 *  - "The flag might not be set this time" is not a security property. Shipping
 *    a remote-code-execution chain inside a document the customer will hand
 *    around is the harm; who eventually presses F9 is not ours to bet on.
 */
const REJECTED_FIELD_INSTRUCTIONS = ["DDEAUTO", "DDE"] as const;

/**
 * AUDITED: `INCLUDETEXT`/`INCLUDEPICTURE` pull in external content but have
 * genuine uses in corporate templates (a shared boilerplate clause, a logo on a
 * network share). Refusing them would break real documents, so they surface as a
 * `template-field-instruction-risk` note instead.
 */
const AUDITED_FIELD_INSTRUCTIONS = ["INCLUDETEXT", "INCLUDEPICTURE"] as const;

/**
 * Collect the risky field-instruction keywords present anywhere in the template
 * (see {@link RISKY_FIELD_INSTRUCTIONS}). Diagnostics ONLY — never mutates.
 *
 * Reuses {@link collectStylerefFields}'s reassembly trick: Word splits a complex
 * field's instruction across several `<w:instrText>` runs, so the runs are
 * concatenated before matching and ` INCLUDE` + `TEXT "…"` still matches.
 * Returns the distinct keywords found, uppercased, in declaration order.
 */
export function collectFieldInstructions(
  xml: string,
  keywords: ReadonlyArray<string> = AUDITED_FIELD_INSTRUCTIONS
): string[] {
  const decode = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  let haystack = "";
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)) haystack += ` ${decode(m[1])}`;
  haystack += ` ${decode(
    [...xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]).join("")
  )}`;
  const found: string[] = [];
  for (const keyword of keywords) {
    // Word-boundary match so DDEAUTO is not also reported as a bare DDE hit.
    if (new RegExp(`\\b${keyword}\\b`, "i").test(haystack) && !found.includes(keyword)) {
      found.push(keyword);
    }
  }
  return found;
}

/**
 * Backwards-compatible alias for {@link collectFieldInstructions} over the
 * audited keyword list. Retained as a named export for API stability.
 */
export function collectRiskyFieldInstructions(xml: string): string[] {
  return collectFieldInstructions(xml, AUDITED_FIELD_INSTRUCTIONS);
}

// ---------------------------------------------------------------------------
// Field-refresh classification (does this document need `<w:updateFields>`?)
// ---------------------------------------------------------------------------

/**
 * Field instructions whose REFRESH changes what the reader sees.
 *
 * `<w:updateFields w:val="true"/>` makes Word ask, on every single open, to
 * refresh the document's fields. That is worth asking for exactly when the
 * cached result baked into the file is wrong, and is pure noise otherwise. The
 * exporter used to set it unconditionally, so a 62-page tree export with no
 * table of contents and 116 static `HYPERLINK` fields prompted its reader
 * forever, to accomplish nothing. This list is the answer to "would a refresh
 * fix something visible?", type by type.
 *
 * The test each entry has to pass is narrower than "is this field dynamic": it
 * is *would setting the flag change what the reader sees, compared to not
 * setting it*. That is why `PAGE` is absent (see below) even though a page
 * number is about as dynamic as a field gets.
 *
 * INCLUDED, grouped by why:
 *
 *  - Generated over the body — `TOC`, `TOA`, `INDEX`, `RD`, `BIBLIOGRAPHY`.
 *    The field's content is produced FROM the document, and this export replaces
 *    the whole body. Unrefreshed, the reader gets the template's table of
 *    contents (usually literally empty, or "Right-click to update"). This is the
 *    case the flag exists for and it stays the default whenever a TOC is present:
 *    a silently empty TOC is a worse surprise than one prompt.
 *  - Resolved against the body — `REF`, `PAGEREF`, `NOTEREF`, `STYLEREF`.
 *    Cross-references and running heads point at bookmarks / styled paragraphs
 *    that only exist after injection; the cached result is the template's, i.e.
 *    stale by construction. (`STYLEREF` running heads are a documented feature of
 *    this engine — see `collectStylerefFields`.)
 *  - Numbered over the body — `SEQ`, `LISTNUM`, `AUTONUM`, `AUTONUMLGL`,
 *    `AUTONUMOUT`. The serializer emits every caption's `SEQ` field with a cached
 *    result of literally `1` (see `captionParagraph`), so without a refresh a
 *    document with three figures shows "Figure 1" three times. Wrong numbering is
 *    visible and looks like a product defect.
 *  - Pulled from outside — `INCLUDETEXT`, `INCLUDEPICTURE`, `LINK`. The cached
 *    copy is whatever the template captured; a refresh fetches the current
 *    source. (These also raise a `template-field-instruction-risk` note — see
 *    {@link AUDITED_FIELD_INSTRUCTIONS} — which is about trust, not staleness.)
 *  - Computed from the file — `FILENAME`, `FILESIZE`. The exported document IS a
 *    different file from the template these results were cached against.
 *  - Read from the clock — `DATE`, `TIME`. Word does not tick these on open; they
 *    change only on refresh, and showing the template author's save date as
 *    "today" is wrong on the face of it.
 *
 * EXCLUDED, and why — this half is the actual fix:
 *
 *  - `HYPERLINK`. A hyperlink field carries its display text statically in the
 *    field result; refreshing re-resolves the target and changes NOTHING the
 *    reader sees. 116 of them are what made every export prompt.
 *  - `PAGE`, `NUMPAGES`, `SECTIONPAGES`, `SECTION`. Word and LibreOffice compute
 *    these during pagination, on every open, independently of this flag. Setting
 *    it buys nothing — and since a page-number footer is in nearly every
 *    corporate template, including them would have quietly reinstated the defect.
 *  - `TITLE`, `SUBJECT`, `AUTHOR`, `KEYWORDS`, `COMMENTS`, `LASTSAVEDBY`,
 *    `CREATEDATE`, `SAVEDATE`, `PRINTDATE`, `REVNUM`, `EDITTIME`, `NUMWORDS`,
 *    `NUMCHARS`, `TEMPLATE`, `DOCPROPERTY`, `INFO`, `DOCVARIABLE`. These read
 *    `docProps/*` or `w:docVars`, and this exporter never rewrites either part —
 *    a refresh reproduces the value already cached. CONDITIONAL exclusion: if the
 *    export ever starts writing document properties or doc variables, move them
 *    into the included list.
 *  - `USERNAME`, `USERADDRESS`, `USERINITIALS`. A refresh WOULD change these — to
 *    the identity of whoever opened the file. Excluded deliberately: rewriting an
 *    author's document with its reader's name is a change, but not a correction.
 *  - `ASK`, `FILLIN`. A refresh interrogates the reader with a modal dialog per
 *    field. Never worth requesting on the reader's behalf.
 *  - `MACROBUTTON`, `GOTOBUTTON`, `SYMBOL`, `EQ`, `ADVANCE`, `QUOTE`, `SET`,
 *    `PRINT`. No recomputed visible result, or no result at all.
 *  - `IF` / `COMPARE`. Conditional on other fields — and if the condition reads a
 *    field that IS on this list, the document already qualifies through that one.
 *  - `DDE` / `DDEAUTO`. Unreachable: {@link assertNoActiveContent} refuses such a
 *    template at import. Their absence here is not a policy about them; see
 *    {@link REJECTED_FIELD_INSTRUCTIONS}.
 *  - Formula fields (`{ =SUM(ABOVE) }`). KNOWN GAP: the instruction starts with
 *    `=`, not a keyword, so {@link fieldKeyword} does not name it and a template
 *    whose only field is a table formula over injected content will not get the
 *    flag. Left as a gap rather than special-cased because the engine never emits
 *    one and a template formula cannot span into the injected body anyway.
 */
export const REFRESH_SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  // generated over the body
  "TOC",
  "TOA",
  "INDEX",
  "RD",
  "BIBLIOGRAPHY",
  // resolved against the body
  "REF",
  "PAGEREF",
  "NOTEREF",
  "STYLEREF",
  // numbered over the body
  "SEQ",
  "LISTNUM",
  "AUTONUM",
  "AUTONUMLGL",
  "AUTONUMOUT",
  // pulled from outside the document
  "INCLUDETEXT",
  "INCLUDEPICTURE",
  "LINK",
  // computed from the file itself
  "FILENAME",
  "FILESIZE",
  // read from the clock
  "DATE",
  "TIME",
]);

/**
 * One field's parts, in the order they appear in a part's XML.
 *
 * Both OOXML field encodings are covered, because a document routinely carries
 * both: `<w:fldSimple w:instr="…">` puts the whole instruction in an attribute,
 * while a complex field is a RUN SEQUENCE — `fldChar begin` → one or more
 * `<w:instrText>` runs → optional `fldChar separate` + cached result →
 * `fldChar end`.
 */
const FIELD_PART_RE =
  /<w:fldSimple\b[^>]*\bw:instr="([^"]*)"|<w:fldChar\b[^>]*\bw:fldCharType="([^"]*)"|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g;

/** Resolve the XML entities Word writes inside a field instruction. */
function decodeInstruction(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
}

/**
 * The leading keyword of one reassembled field instruction, uppercased.
 *
 * A field instruction's grammar is `<keyword> [arguments] [switches]`, so the
 * type of the field is its FIRST token and nothing else. `undefined` for an
 * instruction that opens with something other than an identifier — a formula
 * (`=SUM(ABOVE)`), a stray switch, or an empty instruction.
 */
function fieldKeyword(instruction: string): string | undefined {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(decodeInstruction(instruction));
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * The keyword of every field in one part's XML, uppercased, in document order.
 * Pure; never mutates. Repeats are kept — the caller decides what to do with a
 * count.
 *
 * WHY NOT {@link collectFieldInstructions}: that function concatenates every
 * instruction in the part into ONE haystack and asks whether a keyword appears
 * anywhere in it. For its own job — "does this template mention DDE at all",
 * where a false positive costs an over-cautious refusal — that is the right
 * trade. Here it would be actively wrong in both directions:
 *
 *  - FALSE POSITIVES from field ARGUMENTS. `\bSEQ\b` matches the URL inside
 *    ` HYPERLINK "https://example.com/seq/123" `, and `\bINDEX\b` matches any
 *    link ending `/index.html`. A document of nothing but hyperlinks would have
 *    kept prompting — the exact defect, re-created through the matcher.
 *  - FALSE POSITIVES from the JOIN. Instructions are concatenated with no
 *    separator, so two adjacent fields can spell a third keyword across their
 *    seam.
 *
 * So the keyword is read positionally, from the front of each field's OWN
 * instruction. What IS reused is the insight that fix was built on (see
 * {@link collectStylerefFields}): Word splits one instruction across several
 * `<w:instrText>` runs — ` TO` + `C \o "1-3"` is ordinary output — so the runs
 * are concatenated BEFORE matching. The concatenation is just bounded by the
 * field's own `fldChar begin`/`end` instead of running to the end of the part.
 *
 * Nesting is tracked with a stack, so `{ IF { PAGE } = 1 … }` reports both `IF`
 * and `PAGE` and the outer instruction does not swallow the inner one. An
 * unterminated field (no `end`) is flushed at the end of the part rather than
 * dropped; a `<w:instrText>` with no enclosing `begin` opens an implicit field,
 * because a malformed part should still be classified, not silently treated as
 * field-free.
 */
export function collectFieldKeywords(xml: string): string[] {
  const keywords: string[] = [];
  /** Open complex fields, outermost first. `done` = past `fldChar separate`. */
  const stack: { instruction: string; done: boolean }[] = [];
  const close = (): void => {
    const frame = stack.pop();
    if (!frame) return;
    const keyword = fieldKeyword(frame.instruction);
    if (keyword) keywords.push(keyword);
  };

  for (const m of xml.matchAll(FIELD_PART_RE)) {
    const [, simpleInstr, fldCharType, instrText] = m;
    if (simpleInstr !== undefined) {
      const keyword = fieldKeyword(simpleInstr);
      if (keyword) keywords.push(keyword);
      continue;
    }
    if (fldCharType !== undefined) {
      if (fldCharType === "begin") stack.push({ instruction: "", done: false });
      // `separate` ends the INSTRUCTION, not the field: everything after it is
      // the cached result, and any instrText that follows belongs to the parent.
      else if (fldCharType === "separate" && stack.length) stack[stack.length - 1]!.done = true;
      else if (fldCharType === "end") close();
      continue;
    }
    if (instrText !== undefined) {
      const top = stack[stack.length - 1];
      if (top && !top.done) top.instruction += instrText;
      else stack.push({ instruction: instrText, done: false });
    }
  }
  while (stack.length) close();
  return keywords;
}

/**
 * True when ANY field in the package would show the reader something different
 * after a refresh — i.e. when `<w:updateFields w:val="true"/>` earns its prompt.
 *
 * Runs over every WordprocessingML part ({@link wordprocessingPartNames}), not
 * just `word/document.xml`: a TOC in a header, a `SEQ` in a footnote and a
 * `STYLEREF` in a footer are all ordinary authoring.
 *
 * Call this on the RENDERED archive, not the template: the body's own `SEQ`
 * captions only exist after injection, and the template's TOC is present in both.
 */
export function needsFieldRefresh(zip: PizZip): boolean {
  for (const part of wordprocessingPartNames(zip)) {
    for (const keyword of collectFieldKeywords(readPartText(zip, part))) {
      if (REFRESH_SENSITIVE_FIELDS.has(keyword)) return true;
    }
  }
  return false;
}

/**
 * Unzip uploaded `.docx` bytes into a PizZip archive, validating that it is a
 * zip, fits the decompression budget, carries no hostile entry names, looks
 * like a Word document (`word/document.xml` present), and carries no active
 * content.
 *
 * Order matters: every budget, entry-name and compression-plausibility check
 * runs on central-directory metadata ONLY, before `assertNoActiveContent` reads
 * (and therefore inflates) any part.
 *
 * That ordering refuses both bomb shapes without inflating them — the honest one
 * via the absolute caps, the under-declaring one via
 * {@link assertPlausibleCompression}. It is NOT an absolute guarantee, and an
 * earlier revision of this comment wrongly claimed it was: an entry whose
 * declared size is consistent with its compressed stream but whose DEFLATE data
 * decodes to something else still inflates before PizZip's own post-hoc length
 * check fires. PizZip exposes no bounded inflate, so that residual spike is
 * bounded by {@link MAX_TEMPLATE_BYTES} rather than eliminated, and surfaces as
 * a typed `corrupt-entry` error via {@link readPartText}.
 *
 * @throws {DocxError} `too-large` past the compressed cap; `not-zip` on a
 *   non-zip buffer; `too-many-entries` / `entry-too-large` /
 *   `uncompressed-too-large` past {@link DOCX_ARCHIVE_BUDGET};
 *   `suspicious-compression` on an implausible declared:compressed ratio;
 *   `path-traversal` / `invalid-path` on a hostile entry name; `not-docx` when
 *   the zip lacks `word/document.xml`; `active-content` on
 *   VBA/ActiveX/altChunk/DDE; `corrupt-entry` when a part cannot be inflated.
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
  const foreignPlaceholders: string[] = [];

  for (const part of parts) {
    const xml = readPartText(zip, part);
    for (const name of collectStylerefFields(xml)) {
      if (!stylerefStyleNames.includes(name)) stylerefStyleNames.push(name);
    }
    for (const keyword of collectFieldInstructions(xml, AUDITED_FIELD_INSTRUCTIONS)) {
      if (!riskyFieldInstructions.includes(keyword)) riskyFieldInstructions.push(keyword);
    }
    // Walk every paragraph the replacement will touch — including text-box
    // (mc:Choice + mc:Fallback) and drawing-adjacent occurrences — so the panel's
    // supported-list matches what preprocessScrollText actually resolves.
    for (const text of collectParagraphTexts(xml)) {
      // Foreign (docxtpl/Jinja) syntax inventory. Runs on the SAME run-merged
      // paragraph text as the `$scroll.*` walk — Word routinely splits
      // `{{ title }}` across three runs, so a raw-XML regex would miss it.
      if (foreignPlaceholders.length < MAX_FOREIGN_PLACEHOLDERS) {
        for (const raw of collectForeignPlaceholders(text)) {
          if (foreignPlaceholders.length >= MAX_FOREIGN_PLACEHOLDERS) break;
          if (!foreignPlaceholders.includes(raw)) foreignPlaceholders.push(raw);
        }
      }
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
    foreignPlaceholders,
  };
}

/** Validate + unzip + scan uploaded template bytes in one call (Task 3). */
export function scanTemplate(bytes: Uint8Array): ScanResult {
  return scanZip(unzipDocx(bytes));
}
