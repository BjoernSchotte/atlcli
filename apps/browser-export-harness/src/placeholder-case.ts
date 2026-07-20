/**
 * Conformance case 005 `placeholders` (spec 005 includepage + metadata, gated by
 * 011). DOCX-only. Exports a real `.docx` template carrying `$scroll.title`, an
 * unsupported `$scroll.metadata.*`, a resolvable includepage, and a
 * self-include, through the REAL `runExport` with an in-memory `getIncludedPage`
 * port (production `buildGetIncludedPage`, no mocks). Proves:
 *   - the resolved document contains the INCLUDED page's text + the resolved
 *     title metadata,
 *   - a self-include is caught by cycle protection (`includepage-cycle`),
 *   - the unsupported metadata placeholder degrades visibly (`placeholder-unsupported`).
 */
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  PLACEHOLDER_ROOT_DETAILS,
  PLACEHOLDER_TEMPLATE_BYTES,
  placeholderGetIncludedPage,
} from "@atlcli/export-fixtures";
import { sha256Hex } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";

export interface PlaceholderCaseResult {
  noteCodes: string[];
  includedTextResolved: boolean;
  titleResolved: boolean;
  cycleDetected: boolean;
  metadataUnsupported: boolean;
  docxDigest: string;
}

export async function runPlaceholderCase(): Promise<PlaceholderCaseResult> {
  const output = new MemoryOutputSink();
  const report = await runExport(
    {
      details: PLACEHOLDER_ROOT_DETAILS,
      template: { name: "placeholder-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
      deps: { getIncludedPage: placeholderGetIncludedPage() },
    },
    { templates: memoryTemplateSource(PLACEHOLDER_TEMPLATE_BYTES), output },
  );

  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const includedTextResolved = documentXml.includes("Imprint body text");
  const titleResolved = documentXml.includes("Placeholders Home");
  const noteCodes = report.notes.map((n) => n.code);
  const cycleDetected = noteCodes.includes("includepage-cycle");
  const metadataUnsupported = noteCodes.includes("placeholder-unsupported");

  if (!includedTextResolved) throw new Error("The includepage target text was not resolved into the DOCX.");
  if (!titleResolved) throw new Error("The $scroll.title metadata placeholder was not resolved.");
  if (!cycleDetected) throw new Error("The self-include was not caught by cycle protection.");
  if (!metadataUnsupported) throw new Error("The unsupported $scroll.metadata placeholder emitted no note.");

  return {
    noteCodes,
    includedTextResolved,
    titleResolved,
    cycleDetected,
    metadataUnsupported,
    docxDigest: await sha256Hex(output.single.bytes),
  };
}
