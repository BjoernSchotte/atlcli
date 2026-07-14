/**
 * DOCX export orchestration (spec 004 Task 5 / PLAN §2.3–2.5).
 *
 * Ties the pieces together into one browser-side flow:
 *   1. unzip the customer template (PizZip);
 *   2. scan its `$scroll.*` placeholders (reused classification);
 *   3. resolve non-content placeholders (lazy space/user fetch);
 *   4. walk the page storage → ExportBlock[] → OOXML body;
 *   5. swap the `$scroll.content` paragraph for a docxtemplater rawxml tag
 *      paragraph (`@scrollContent`, written with Private-Use-Area delimiters);
 *   6. preprocess the remaining `$scroll.*` text (run-normalized) across
 *      document + header/footer parts of the TEMPLATE — NEVER leaving a literal,
 *      and never touching the page body (which is not injected yet);
 *   7. render with docxtemplater: the engine expands the rawxml tag, inserting
 *      the serialized body VERBATIM — the page body is a DATA value, never
 *      re-parsed for tags, so literal braces and `$scroll.*` examples in the page
 *      survive (findings #7/#11);
 *   8. synthesize the code style, set `w:updateFields` so the TOC repaginates;
 *   9. emit bytes + a structured {@link ExportReport}.
 *
 * **Engine (PLAN Decision F1, Option A):** docxtemplater free is the rendering
 * engine, configured with Private-Use-Area delimiters (U+E000 … U+E001) instead
 * of the default `{…}`. docxtemplater always scans the whole document for its
 * delimiter pair; a PUA pair cannot occur in any real Word template or in
 * customer page content, so the customer template's literal `{`, `}`, `{foo}`
 * are NEVER treated as tags — never parsed, never mutated, never throw (finding
 * #11). Only our own injected `@scrollContent` tag is a tag, and its value (the
 * page body OOXML) is inserted through the free-tier rawxml module WITHOUT
 * re-parsing, so page-authored `$scroll.*` / braces pass through verbatim
 * (finding #7). Non-content `$scroll.*` placeholders are resolved to text on the
 * template parts BEFORE render (engine-agnostic run-normalized preprocessor,
 * findings #8/#9). Images are deferred (F3): they add report lines, never OOXML.
 */
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { storageToBlocks, type ConfluencePageDetails, type ExportNote } from "@atlcli/confluence/browser";
import { documentPartNames, PLACEHOLDER_RE, scanZip, unzipDocx, type ScanResult } from "./scan.js";
import {
  resolvePlaceholders,
  type CurrentUser,
  type ResolveDeps,
  type TemplateMeta,
} from "./resolver.js";
import { serializeBlocks } from "./serialize.js";
import { CODE_STYLE_ID, codeStyleXml, parseStyleNames } from "./ooxml.js";
import {
  encodeXmlText,
  paragraphText,
  rewriteScrollText,
  splitParagraphs,
} from "./ooxml-text.js";

export interface ExportReport {
  /** Placeholders resolved to a non-empty value. */
  resolvedCount: number;
  /** Distinct unsupported/never placeholder bases (rendered empty). */
  unsupportedNames: string[];
  /** Number of images skipped (deferred embedding). */
  skippedImages: number;
  /** Wall-clock export duration in milliseconds. */
  durationMs: number;
  /** Suggested download filename (`<page-title>.docx`). */
  filename: string;
  /** All non-fatal notes (resolver + serializer + flow). */
  notes: ExportNote[];
  /** The template scan (reused classification), for the panel. */
  scan: ScanResult;
}

export interface ExportResult {
  bytes: Uint8Array;
  report: ExportReport;
}

export interface ExportInput {
  templateBytes: Uint8Array;
  details: ConfluencePageDetails;
  template: TemplateMeta;
  exportDate?: Date;
  deps?: ResolveDeps;
}

/**
 * docxtemplater delimiter pair from the Unicode Private Use Area (U+E000,
 * U+E001), built from code points so no control byte lives in this source. These
 * code points are reserved for private agreement and carry no character
 * semantics, so they cannot appear in a real Word template or in customer page
 * content. docxtemplater scans the whole document for exactly this pair, so with
 * a PUA pair the customer's literal `{`, `}`, `{foo}` (and guillemets `«…»`,
 * which appear in real German/French prose) are never delimiters — never parsed,
 * never mutated, never throw (finding #11).
 */
const DELIM_START = String.fromCodePoint(0xe000);
const DELIM_END = String.fromCodePoint(0xe001);

/** The rawxml data key whose value is the serialized page body OOXML. */
const CONTENT_KEY = "scrollContent";

/**
 * The paragraph we swap in for `$scroll.content` before render. Its ONLY text is
 * the docxtemplater rawxml tag `@scrollContent` (delimited with the PUA pair);
 * the free-tier rawxml module requires a raw tag to be the sole content of its
 * paragraph, and expands the WHOLE paragraph to the tag's value — so the
 * serialized body replaces this placeholder paragraph cleanly. It contains no
 * `$scroll` text, so the `$scroll.*` preprocessor leaves it untouched.
 */
const CONTENT_TAG_PARA =
  `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@${CONTENT_KEY}${DELIM_END}</w:t></w:r></w:p>`;

/**
 * Thrown when docxtemplater cannot render the (delimiter-swapped) template.
 * With PUA delimiters this is not expected — the customer's own text is never a
 * tag — but a residual malformed input is classified specifically here rather
 * than surfacing as a generic "Export failed" (second half of finding #11). The
 * caller can present the structured `details` instead of a bare message.
 */
export class DocxRenderError extends Error {
  constructor(
    message: string,
    readonly details: string[]
  ) {
    super(message);
    this.name = "DocxRenderError";
  }
}

/** Turn a page title into a safe `.docx` filename. */
export function toDownloadFilename(title: string): string {
  const base = (title || "export").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return `${base || "export"}.docx`;
}

/**
 * Run the full export. Returns the `.docx` bytes and a report.
 * Throws {@link import("./scan.js").DocxError} on a truly fatal template problem
 * (an unreadable / non-Word zip from {@link unzipDocx}), or {@link
 * DocxRenderError} if docxtemplater cannot render the delimiter-swapped template
 * (not expected with PUA delimiters). The customer template's own text is never
 * scanned with `{…}`, so literal braces / `$scroll.*` examples can't cause a
 * parse error.
 */
export async function exportDocx(input: ExportInput): Promise<ExportResult> {
  const start = Date.now();
  const exportDate = input.exportDate ?? new Date();

  const zip = unzipDocx(input.templateBytes);
  const scan = scanZip(zip);

  // 1. Resolve non-content placeholders (lazy fetch driven by the used set).
  const usedRaw = [...scan.supported, ...scan.unsupported, ...scan.never].flatMap((h) => h.raw);
  const resolved = await resolvePlaceholders(usedRaw, { details: input.details, template: input.template, exportDate }, input.deps);

  // 2. Storage → blocks → OOXML body.
  const { blocks, notes: walkNotes } = storageToBlocks(input.details.storage ?? "");
  const styleNames = parseStyleNames(zip.file("word/styles.xml")?.asText() ?? "");
  const body = await serializeBlocks(blocks, { styleNames });

  // 3. Swap the $scroll.content paragraph for the rawxml tag paragraph. If the
  //    template has none, inject the tag before the body's final section break.
  const contentFound = injectContentTag(zip);
  const flowNotes: ExportNote[] = [];
  if (!contentFound) {
    injectContentTagAtEnd(zip);
    flowNotes.push({
      level: "info",
      code: "no-content-placeholder",
      message: "Template had no $scroll.content; page body was inserted before the final section break.",
    });
  }

  // 4. Resolve remaining $scroll.* text across the TEMPLATE parts (the page body
  //    is NOT injected yet — so page-authored $scroll.* examples can't be hit).
  //    Runs before render so the engine only ever sees resolved text + the one
  //    rawxml tag.
  preprocessScrollText(zip, resolved.values);

  // 5. Render with docxtemplater: the rawxml tag expands to the serialized body,
  //    inserted VERBATIM (the body is a DATA value, never re-parsed for tags), so
  //    literal braces / $scroll text in the page pass through unchanged. PUA
  //    delimiters guarantee the customer's own `{…}` is never a tag.
  const rendered = renderContent(zip, body.xml);

  // 6. Synthesize the code style if the body referenced it; force TOC refresh.
  if (body.xml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(rendered);
  ensureUpdateFields(rendered);

  const bytes = rendered.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;

  const notes = [...resolved.notes, ...walkNotes, ...body.notes, ...flowNotes];
  // Every image-skip note kind counts toward the report's skipped-image total:
  // serializer `image-skipped`, walker `image-unresolved` and `inline-image-skipped`.
  const skippedImages = notes.filter((n) => IMAGE_SKIP_CODES.has(n.code)).length;

  return {
    bytes,
    report: {
      resolvedCount: resolved.resolvedCount,
      unsupportedNames: resolved.unsupportedNames,
      skippedImages,
      durationMs: Date.now() - start,
      filename: toDownloadFilename(input.details.title),
      notes,
      scan,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the template with docxtemplater (PUA delimiters) so the `@scrollContent`
 * rawxml tag expands to `bodyXml`. Returns the rendered PizZip archive for
 * follow-up surgery (code style, updateFields). Any docxtemplater failure is
 * re-thrown as a {@link DocxRenderError} carrying the engine's structured
 * explanation, so the caller never sees a generic "Export failed".
 */
function renderContent(zip: PizZip, bodyXml: string): PizZip {
  let doc: Docxtemplater<PizZip>;
  try {
    doc = new Docxtemplater<PizZip>(zip, {
      delimiters: { start: DELIM_START, end: DELIM_END },
      paragraphLoop: true,
      linebreaks: true,
      // Suppress docxtemplater's internal console.error on a template error; we
      // classify and surface it via DocxRenderError instead (engine-decision.md
      // notes the cosmetic console noise).
      errorLogging: false,
    });
    doc.render({ [CONTENT_KEY]: bodyXml });
  } catch (err) {
    throw new DocxRenderError(
      "The Word template could not be rendered.",
      explainDocxError(err)
    );
  }
  return doc.getZip();
}

interface DocxErrorLike {
  message?: string;
  properties?: {
    explanation?: string;
    errors?: DocxErrorLike[];
  };
}

/**
 * Flatten a docxtemplater error into human-readable lines. A multi-error
 * `TemplateError` carries `properties.errors[]` (each with its own
 * `properties.explanation`); a single error carries `properties.explanation`
 * directly; a plain Error just yields its message.
 */
function explainDocxError(err: unknown): string[] {
  const e = err as DocxErrorLike;
  const nested = e.properties?.errors;
  if (nested?.length) {
    return nested.map((n) => n.properties?.explanation ?? n.message ?? "unknown template error");
  }
  const explanation = e.properties?.explanation;
  if (explanation) return [explanation];
  return [err instanceof Error ? err.message : String(err)];
}

// ---------------------------------------------------------------------------
// Zip surgery
// ---------------------------------------------------------------------------

/** Note kinds that mean "an image was not embedded" (for the report tally). */
const IMAGE_SKIP_CODES = new Set(["image-skipped", "image-unresolved", "inline-image-skipped"]);

/** Replace the paragraph containing `$scroll.content` with the rawxml tag. */
function injectContentTag(zip: PizZip): boolean {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const para of splitParagraphs(xml)) {
      if (paragraphText(para).includes("$scroll.content")) {
        zip.file(part, xml.replace(para, CONTENT_TAG_PARA));
        return true;
      }
    }
  }
  return false;
}

/** Insert the rawxml tag before the body's final section break (fallback). */
function injectContentTagAtEnd(zip: PizZip): void {
  const part = "word/document.xml";
  const xml = zip.file(part)?.asText();
  if (!xml) return;
  // The body-level sectPr is the last <w:sectPr> before </w:body>.
  const bodyClose = xml.lastIndexOf("</w:body>");
  const sectPr = xml.lastIndexOf("<w:sectPr", bodyClose === -1 ? undefined : bodyClose);
  if (sectPr !== -1) {
    zip.file(part, xml.slice(0, sectPr) + CONTENT_TAG_PARA + xml.slice(sectPr));
  } else if (bodyClose !== -1) {
    zip.file(part, xml.slice(0, bodyClose) + CONTENT_TAG_PARA + xml.slice(bodyClose));
  }
}

/**
 * Replace every `$scroll.*` / `$adhocState` occurrence across document +
 * header/footer parts with its resolved value (empty for unsupported/never).
 *
 * {@link rewriteScrollText} run-normalizes each placeholder paragraph (merging
 * split runs), descends into text boxes (`mc:Choice` + `mc:Fallback`), and
 * replaces clean `<w:t>` runs that share a paragraph with a drawing/pict run —
 * so a title inside a cover-page text box and a `$scroll.title` run trailing a
 * footer picture are both resolved. Guarantees no literal placeholder survives.
 */
export function preprocessScrollText(zip: PizZip, values: Map<string, string>): void {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText();
    if (!xml) continue;
    if (!xml.includes("$scroll") && !xml.includes("$adhocState")) continue;
    // Function-free replacement path: resolved values may contain `$`, so
    // rewriteScrollText splices literally rather than via String.replace.
    const rewritten = rewriteScrollText(xml, (joined) => replaceTokens(joined, values));
    if (rewritten !== xml) zip.file(part, rewritten);
  }
}

/** Replace each placeholder token in text; unknown tokens → empty (no literal). */
function replaceTokens(text: string, values: Map<string, string>): string {
  PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(PLACEHOLDER_RE, (m) => values.get(m) ?? "");
}

/** Add the synthesized code paragraph style to styles.xml if absent. */
export function ensureCodeStyle(zip: PizZip): void {
  const path = "word/styles.xml";
  const xml = zip.file(path)?.asText();
  if (!xml) return;
  if (xml.includes(`w:styleId="${CODE_STYLE_ID}"`)) return;
  zip.file(path, xml.replace("</w:styles>", `${codeStyleXml()}</w:styles>`));
}

/**
 * Ensure `word/settings.xml` carries `<w:updateFields w:val="true"/>` so Word
 * offers to repaginate a TOC field on open. Creates settings.xml (+ content-type
 * + relationship) when a bare template lacks it.
 */
export function ensureUpdateFields(zip: PizZip): void {
  const path = "word/settings.xml";
  const existing = zip.file(path)?.asText();
  if (existing) {
    if (/<w:updateFields\b/.test(existing)) {
      // Normalize BOTH the self-closing (`<w:updateFields w:val="false"/>`) and
      // the paired (`<w:updateFields w:val="false"></w:updateFields>`) forms to a
      // single self-closing `true` — the paired form was previously left as-is,
      // so a template pinning the TOC to false never refreshed.
      const normalized = existing
        .replace(/<w:updateFields\b[^>]*>[\s\S]*?<\/w:updateFields>/, '<w:updateFields w:val="true"/>')
        .replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>');
      zip.file(path, normalized);
      return;
    }
    // Insert as the first child of <w:settings …>.
    const opened = existing.replace(/(<w:settings\b[^>]*>)/, '$1<w:updateFields w:val="true"/>');
    zip.file(path, opened);
    return;
  }
  // No settings.xml — synthesize one and register it.
  const settings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:updateFields w:val="true"/></w:settings>`;
  zip.file(path, settings);
  registerSettingsPart(zip);
}

function registerSettingsPart(zip: PizZip): void {
  const ctPath = "[Content_Types].xml";
  const ct = zip.file(ctPath)?.asText();
  if (ct && !ct.includes("word/settings.xml")) {
    zip.file(
      ctPath,
      ct.replace(
        "</Types>",
        `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`
      )
    );
  }
  const relsPath = "word/_rels/document.xml.rels";
  const rels =
    zip.file(relsPath)?.asText() ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!rels.includes("settings.xml")) {
    // Parse existing rIds regardless of quote style (`Id="rId1"` or `Id='rId1'`),
    // then allocate max+1 — matching only double-quoted ids could re-issue an id
    // already used with single quotes and collide.
    const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
    const rid = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`
      )
    );
  }
}

// Re-export for the panel/tests: keep encode local usage referenced.
export { encodeXmlText };
export type { CurrentUser };
