/**
 * DOCX export orchestration (spec 004 Task 5 / PLAN §2.3–2.5).
 *
 * Ties the pieces together into one browser-side flow:
 *   1. unzip the customer template (PizZip);
 *   2. scan its `$scroll.*` placeholders (reused classification);
 *   3. resolve non-content placeholders (lazy space/user fetch);
 *   4. walk the page storage → ExportBlock[] → OOXML body;
 *   5. swap the `$scroll.content` paragraph for a docxtemplater `{@scrollContent}`
 *      raw tag and render the body in via `{@rawXml}` (engine F1: docxtemplater
 *      free);
 *   6. preprocess the remaining `$scroll.*` text (run-normalized) across
 *      document + header/footer parts — NEVER leaving a literal;
 *   7. synthesize the code style, set `w:updateFields` so the TOC repaginates;
 *   8. emit bytes + a structured {@link ExportReport}.
 *
 * Images are deferred (F3): they add report lines, never OOXML — so the output
 * has no dangling relationship. Everything here is browser-safe (PizZip +
 * docxtemplater are eval-free; the only dynamic import is Shiki, code-split).
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

/** The docxtemplater raw tag we splice in place of `$scroll.content`. */
const CONTENT_TAG_PARA = `<w:p><w:r><w:t xml:space="preserve">{@scrollContent}</w:t></w:r></w:p>`;

/** Turn a page title into a safe `.docx` filename. */
export function toDownloadFilename(title: string): string {
  const base = (title || "export").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return `${base || "export"}.docx`;
}

/**
 * Run the full export. Returns the `.docx` bytes and a report.
 * Throws only on a truly fatal template problem (docxtemplater parse error).
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

  // 3. Splice the content insertion point → {@scrollContent}. If the template
  //    has none, inject the tag before the body's final section break.
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

  // 4. Render the body via docxtemplater {@rawXml}.
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({ scrollContent: body.xml });
  const outZip: PizZip = doc.getZip();

  // 5. Preprocess remaining $scroll.* text across all parts (post-render, so no
  //    resolved value can collide with docxtemplater's `{…}` parser).
  preprocessScrollText(outZip, resolved.values);

  // 6. Synthesize the code style if the body referenced it; force TOC refresh.
  if (body.xml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(outZip);
  ensureUpdateFields(outZip);

  const bytes = outZip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;

  const notes = [...resolved.notes, ...walkNotes, ...body.notes, ...flowNotes];
  const skippedImages = notes.filter((n) => n.code === "image-skipped").length;

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

/** Replace the paragraph containing `$scroll.content` with the raw tag. */
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

/** Insert the content tag before the body's final section break (fallback). */
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
        xml = xml.replace(para, rewritten);
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
      zip.file(path, existing.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>'));
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
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
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
