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
import { paragraphText, splitParagraphs } from "./ooxml-text.js";

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

/** The document parts a scan/preprocess must cover. */
export function documentPartNames(zip: PizZip): string[] {
  return Object.keys(zip.files)
    .filter((n) => /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n))
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

  for (const part of parts) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const para of splitParagraphs(xml)) {
      const text = paragraphText(para);
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

  return { supported, unsupported, never, parts, hasContentPlaceholder: hasContent };
}

/** Validate + unzip + scan uploaded template bytes in one call (Task 3). */
export function scanTemplate(bytes: Uint8Array): ScanResult {
  return scanZip(unzipDocx(bytes));
}
