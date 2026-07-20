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

/** Thrown when uploaded bytes are not a readable `.docx` (zip) package. */
export class DocxError extends Error {
  constructor(
    readonly kind: "not-zip" | "not-docx" | "too-large",
    message: string
  ) {
    super(message);
    this.name = "DocxError";
  }
}

/** 20 MB upload cap (PLAN Task 3 AC). */
export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;

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

/**
 * Unzip uploaded `.docx` bytes into a PizZip archive, validating that it is a
 * zip and looks like a Word document (`word/document.xml` present).
 *
 * @throws {DocxError} `too-large` past the cap, `not-zip` on a non-zip buffer,
 *   `not-docx` when the zip lacks `word/document.xml`.
 */
export function unzipDocx(bytes: Uint8Array): PizZip {
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new DocxError("too-large", `Template exceeds the ${MAX_TEMPLATE_BYTES} byte limit.`);
  }
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch (err) {
    throw new DocxError("not-zip", `Not a valid .docx (zip) file: ${(err as Error).message}`);
  }
  if (!zip.file("word/document.xml")) {
    throw new DocxError("not-docx", "File is a zip but not a Word document (no word/document.xml).");
  }
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

  for (const part of parts) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const name of collectStylerefFields(xml)) {
      if (!stylerefStyleNames.includes(name)) stylerefStyleNames.push(name);
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

  return { supported, unsupported, never, parts, hasContentPlaceholder: hasContent, stylerefStyleNames };
}

/** Validate + unzip + scan uploaded template bytes in one call (Task 3). */
export function scanTemplate(bytes: Uint8Array): ScanResult {
  return scanZip(unzipDocx(bytes));
}
