/**
 * Shared `$scroll.*` preprocessor — XML-level find/replace across the
 * document, header and footer parts of a docx zip. Needed by BOTH engines,
 * because neither treats `$scroll.*` as its own delimiter syntax: the engines'
 * data paths cannot address these placeholders, so a preprocessor pass is the
 * only way to replace them (and it must reach header/footer parts, not just
 * document.xml).
 *
 * This is engine-agnostic on purpose — a key spike finding.
 */
import type PizZip from "pizzip";

export interface ScrollTextValues {
  "$scroll.title"?: string;
  "$scroll.exportdate"?: string;
  "$scroll.exporter.fullName"?: string;
  "$scroll.space.name"?: string;
  "$scroll.pagelabels"?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bodyParts(zip: PizZip): string[] {
  return Object.keys(zip.files).filter((n) => /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/.test(n));
}

/** Replace the whole `<w:p>` paragraph that contains `$scroll.content`. */
function injectContent(xml: string, contentOoxml: string): string {
  const re = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?\$scroll\.content(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/;
  return xml.replace(re, contentOoxml);
}

/**
 * Apply replacements to all body/header/footer parts.
 * Returns the set of `$scroll.*` tokens actually replaced, per part.
 */
export function preprocessScroll(
  zip: PizZip,
  text: ScrollTextValues,
  contentOoxml: string,
): { part: string; replaced: string[] }[] {
  const report: { part: string; replaced: string[] }[] = [];
  for (const part of bodyParts(zip)) {
    let xml = zip.file(part)!.asText();
    const replaced: string[] = [];

    if (xml.includes("$scroll.content")) {
      xml = injectContent(xml, contentOoxml);
      replaced.push("$scroll.content");
    }
    for (const [token, value] of Object.entries(text)) {
      if (value == null) continue;
      if (xml.includes(token)) {
        xml = xml.split(token).join(esc(value));
        replaced.push(token);
      }
    }
    if (replaced.length) {
      zip.file(part, xml);
      report.push({ part, replaced });
    }
  }
  return report;
}
