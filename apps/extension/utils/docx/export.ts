/**
 * DOCX export orchestration (spec 004 Task 5 / PLAN §2.3–2.5).
 *
 * Ties the pieces together into one browser-side flow:
 *   1. unzip the customer template (PizZip);
 *   2. scan its `$scroll.*` placeholders (reused classification);
 *   3. resolve non-content placeholders (lazy space/user fetch);
 *   4. walk the page storage → ExportBlock[] → OOXML body;
 *   5. swap the `$scroll.content` paragraph for a private sentinel paragraph;
 *   6. preprocess the remaining `$scroll.*` text (run-normalized) across
 *      document + header/footer parts of the TEMPLATE — NEVER leaving a literal,
 *      and never touching the page body (which is not injected yet);
 *   7. splice the serialized body in place of the sentinel as raw XML — the page
 *      body is DATA and is never run through a `{…}` template parser, so literal
 *      braces and `$scroll.*` examples in the page survive verbatim;
 *   8. synthesize the code style, set `w:updateFields` so the TOC repaginates;
 *   9. emit bytes + a structured {@link ExportReport}.
 *
 * The template body is spliced directly rather than via docxtemplater's data
 * pass: docxtemplater parsed the WHOLE customer template with `{…}` delimiters,
 * which mutated balanced `{foo}` and threw on a lone brace, and its render had
 * to run before placeholder preprocessing — which then scanned the injected body
 * and rewrote page-authored `$scroll.*` examples. Ordering placeholder
 * resolution on the template first, then splicing the body as opaque XML,
 * removes both failure modes (PLAN Decision F1 permits the no-engine content
 * path). Images are deferred (F3): they add report lines, never OOXML.
 */
import PizZip from "pizzip";
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
  rewriteParagraphText,
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
 * A unique sentinel paragraph we swap in for `$scroll.content` before
 * placeholder preprocessing, then replace wholesale with the serialized body.
 * It contains no `$scroll` text, so the preprocessor leaves it untouched, and
 * the storage walker never emits this marker, so it cannot collide with page
 * content. The whole `<w:p>` string is what we later splice out.
 */
const CONTENT_SENTINEL = "ATLCLI-SCROLL-CONTENT";
const CONTENT_SENTINEL_PARA = `<w:p><w:r><w:t xml:space="preserve">${CONTENT_SENTINEL}</w:t></w:r></w:p>`;

/** Turn a page title into a safe `.docx` filename. */
export function toDownloadFilename(title: string): string {
  const base = (title || "export").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return `${base || "export"}.docx`;
}

/**
 * Run the full export. Returns the `.docx` bytes and a report.
 * Throws only on a truly fatal template problem (an unreadable / non-Word zip
 * from {@link unzipDocx}); the customer template's own text is never parsed as a
 * template, so literal braces / `$scroll.*` examples can't cause a parse error.
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

  // 3. Swap the $scroll.content paragraph for a sentinel. If the template has
  //    none, inject the sentinel before the body's final section break.
  const contentFound = injectContentSentinel(zip);
  const flowNotes: ExportNote[] = [];
  if (!contentFound) {
    injectContentSentinelAtEnd(zip);
    flowNotes.push({
      level: "info",
      code: "no-content-placeholder",
      message: "Template had no $scroll.content; page body was inserted before the final section break.",
    });
  }

  // 4. Resolve remaining $scroll.* text across the TEMPLATE parts (the page body
  //    is NOT injected yet — so page-authored $scroll.* examples can't be hit).
  preprocessScrollText(zip, resolved.values);

  // 5. Splice the serialized body in for the sentinel as opaque XML. Never runs
  //    through a `{…}` parser, so literal braces / $scroll text in the page pass
  //    through verbatim.
  spliceContentSentinel(zip, body.xml);

  // 6. Synthesize the code style if the body referenced it; force TOC refresh.
  if (body.xml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(zip);
  ensureUpdateFields(zip);

  const bytes = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;

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
// Zip surgery
// ---------------------------------------------------------------------------

/** Note kinds that mean "an image was not embedded" (for the report tally). */
const IMAGE_SKIP_CODES = new Set(["image-skipped", "image-unresolved", "inline-image-skipped"]);

/** Replace the paragraph containing `$scroll.content` with the sentinel. */
function injectContentSentinel(zip: PizZip): boolean {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const para of splitParagraphs(xml)) {
      if (paragraphText(para).includes("$scroll.content")) {
        zip.file(part, xml.replace(para, CONTENT_SENTINEL_PARA));
        return true;
      }
    }
  }
  return false;
}

/** Insert the sentinel before the body's final section break (fallback). */
function injectContentSentinelAtEnd(zip: PizZip): void {
  const part = "word/document.xml";
  const xml = zip.file(part)?.asText();
  if (!xml) return;
  // The body-level sectPr is the last <w:sectPr> before </w:body>.
  const bodyClose = xml.lastIndexOf("</w:body>");
  const sectPr = xml.lastIndexOf("<w:sectPr", bodyClose === -1 ? undefined : bodyClose);
  if (sectPr !== -1) {
    zip.file(part, xml.slice(0, sectPr) + CONTENT_SENTINEL_PARA + xml.slice(sectPr));
  } else if (bodyClose !== -1) {
    zip.file(part, xml.slice(0, bodyClose) + CONTENT_SENTINEL_PARA + xml.slice(bodyClose));
  }
}

/** Replace the sentinel paragraph with the serialized body (raw XML). */
function spliceContentSentinel(zip: PizZip, bodyXml: string): void {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText();
    if (xml && xml.includes(CONTENT_SENTINEL_PARA)) {
      zip.file(part, xml.replace(CONTENT_SENTINEL_PARA, () => bodyXml));
      return;
    }
  }
}

/**
 * Replace every `$scroll.*` / `$adhocState` occurrence across document +
 * header/footer parts with its resolved value (empty for unsupported/never),
 * run-normalizing each placeholder paragraph first so split runs are merged.
 * Guarantees no literal placeholder survives.
 */
export function preprocessScrollText(zip: PizZip, values: Map<string, string>): void {
  for (const part of documentPartNames(zip)) {
    let xml = zip.file(part)?.asText();
    if (!xml) continue;
    let changed = false;
    for (const para of splitParagraphs(xml)) {
      const text = paragraphText(para);
      if (!text.includes("$scroll") && !text.includes("$adhocState")) continue;
      const rewritten = rewriteParagraphText(para, (joined) => replaceTokens(joined, values));
      if (rewritten !== para) {
        // Function replacer: resolved values may contain `$`, which is a special
        // pattern in a string replacement.
        xml = xml.replace(para, () => rewritten);
        changed = true;
      }
    }
    if (changed) zip.file(part, xml);
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
