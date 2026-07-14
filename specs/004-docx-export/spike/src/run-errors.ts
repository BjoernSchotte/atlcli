/**
 * Criterion 4: error behaviour on malformed templates.
 * Feeds (a) a corrupted (non-zip) buffer and (b) a template with a broken
 * command/tag to each engine, and records the error message quality.
 *
 * Run: bun run src/run-errors.ts
 */
import createReport from "docx-templates";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { makeDocx } from "./make-docx";

const corrupt = Buffer.from("PK\x03\x04 this is not really a zip file at all");

async function docxTemplatesCorrupt() {
  try {
    await createReport({ template: corrupt, cmdDelimiter: ["+++", "+++"], data: {} });
    return "NO ERROR (unexpected)";
  } catch (e: any) {
    return `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 140)}`;
  }
}

async function docxTemplatesBadTag() {
  // Unterminated FOR loop.
  const tpl = await makeDocx([{ text: "+++FOR x IN items+++" }, { text: "+++INS $x+++" }]);
  try {
    await createReport({ template: tpl, cmdDelimiter: ["+++", "+++"], data: { items: [1, 2] } });
    return "NO ERROR (unexpected)";
  } catch (e: any) {
    return `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 140)}`;
  }
}

function docxtemplaterCorrupt() {
  try {
    const zip = new PizZip(corrupt);
    new Docxtemplater(zip, {});
    return "NO ERROR (unexpected)";
  } catch (e: any) {
    return `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 140)}`;
  }
}

async function docxtemplaterBadTag() {
  const tpl = await makeDocx([{ text: "Hello {unclosed tag" }]);
  try {
    const zip = new PizZip(tpl);
    new Docxtemplater(zip, {}); // compile() throws on unclosed tag
    return "NO ERROR (unexpected)";
  } catch (e: any) {
    const props = e?.properties;
    const detail = props?.errors?.[0]?.properties?.explanation ?? props?.explanation ?? e?.message;
    return `${e?.constructor?.name}: ${String(detail).slice(0, 140)}`;
  }
}

console.log("=== Criterion 4: malformed template error behaviour ===");
console.log("docx-templates  | corrupt zip :", await docxTemplatesCorrupt());
console.log("docx-templates  | broken tag  :", await docxTemplatesBadTag());
console.log("docxtemplater   | corrupt zip :", docxtemplaterCorrupt());
console.log("docxtemplater   | broken tag  :", await docxtemplaterBadTag());
