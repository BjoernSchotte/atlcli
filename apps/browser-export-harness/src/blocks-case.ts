/**
 * Conformance case 001 `blocks` (spec 001 block model, gated by spec 011).
 *
 * Drives a fixture that uses EVERY new `ExportBlock` field
 * (`heading.explicitAnchor`, `pageBreak`, `table.columnWidths` + `caption`,
 * `codeBlock.caption`, `orientation`, `anchor`, enriched `unknown`) through both
 * the PDF and DOCX engines. Proves:
 *   - both engines emit NO warning notes for the enriched model,
 *   - the PDF side is byte-identical on warm repeat (determinism),
 *   - the DOCX package structurally reflects the new fields (table grid,
 *     landscape section, named bookmark, preserved unknown-macro body).
 * Emits a PDF sha256 digest + report projection for the shape-parity gate.
 */
import { validatePdfOutput, type PdfExportReport } from "@atlcli/pdf/browser";
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  BLOCKS_ALL_FIELDS,
  BLOCKS_DETAILS,
  BLOCKS_METADATA,
  DOCX_TEMPLATE_BYTES,
} from "@atlcli/export-fixtures";
import { equalBytes, projectReportNotes, sha256Hex, type ReportNoteProjection } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const PDF_FILENAME = "Block Model Coverage.pdf";
const compiler = new HarnessPdfWorkerClient();

function warningCodes(notes: ReadonlyArray<{ code: string; level?: string; severity?: string }>): string[] {
  return notes.filter((n) => (n.severity ?? n.level) === "warning").map((n) => n.code);
}

export interface BlocksCaseResult {
  compilerVersion: string;
  byteIdenticalWarmRepeat: boolean;
  pageCount: number;
  tagged: boolean;
  docxHasTable: boolean;
  docxHasLandscape: boolean;
  docxHasAnchorBookmark: boolean;
  docxHasUnknownPlaceholder: boolean;
  docxHasCodeTitle: boolean;
  docxHasNestedCalloutIcons: boolean;
  pdfHasCodeCollapseProjection: boolean;
  docxHasCodeCollapseProjection: boolean;
  pdfWarningCodes: string[];
  docxWarningCodes: string[];
  reportNotes: ReportNoteProjection[];
  digests: Record<string, string>;
}

async function runDocx(): Promise<{ report: import("@atlcli/docx/browser").ExportReport; bytes: Uint8Array }> {
  const output = new MemoryOutputSink();
  const report = await runExport(
    {
      details: BLOCKS_DETAILS,
      blocks: BLOCKS_ALL_FIELDS,
      template: { name: "blocks-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  return { report, bytes: output.single.bytes };
}

export async function runBlocksCase(): Promise<BlocksCaseResult> {
  // PDF — warm-repeat determinism + structural validity.
  const first = await compilePdf(compiler, BLOCKS_ALL_FIELDS, BLOCKS_METADATA, PDF_FILENAME);
  const second = await compilePdf(compiler, BLOCKS_ALL_FIELDS, BLOCKS_METADATA, PDF_FILENAME);
  const byteIdenticalWarmRepeat = equalBytes(first.bytes, second.bytes);
  if (!byteIdenticalWarmRepeat) throw new Error("Block-model PDF was not byte-identical on warm repeat.");

  const inspection = validatePdfOutput(first.bytes);
  if (!inspection.tagged) throw new Error("Block-model PDF is not tagged.");
  // A standalone pageBreak block forces at least two pages.
  if (inspection.pageCount < 2) throw new Error(`Expected >=2 pages (pageBreak), got ${inspection.pageCount}.`);

  const pdfReport: PdfExportReport = first.report;
  const pdfWarningCodes = warningCodes(pdfReport.notes);
  if (pdfWarningCodes.length > 0) {
    throw new Error(`PDF engine emitted unexpected warning notes: ${pdfWarningCodes.join(", ")}.`);
  }

  // DOCX — the enriched fields land in the package.
  const docx = await runDocx();
  const zip = unzipDocx(docx.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const docxHasTable = documentXml.includes("<w:tbl");
  const docxHasLandscape = documentXml.includes('w:orient="landscape"');
  const docxHasAnchorBookmark = documentXml.includes('w:name="appendix"');
  const docxHasUnknownPlaceholder = documentXml.includes("customwidget");
  // Syntax highlighting splits one logical code line across several <w:t>
  // runs. Compare the ordered visible text, not a contiguous XML substring.
  const documentText = [...documentXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
    .map((match) => match[1] ?? "")
    .join("");
  const docxHasCodeTitle =
    documentText.includes("Legacy code header") &&
    documentText.includes("export const answer = 42;") &&
    documentText.indexOf("Legacy code header") < documentText.indexOf("export const answer = 42;");
  const docxHasNestedCalloutIcons =
    ["Warning", "Tip", "Info", "Note"].every(
      (label) => documentXml.match(new RegExp(`descr="${label}"`, "gu"))?.length === 2,
    )
    && documentText.includes("Dense table warning")
    && documentText.includes("Tip inside list item")
    && documentText.includes("Note inside callout");
  if (!docxHasTable) throw new Error("DOCX is missing the table (columnWidths block).");
  if (!docxHasLandscape) throw new Error("DOCX is missing the landscape orientation section.");
  if (!docxHasAnchorBookmark) throw new Error("DOCX is missing the named anchor bookmark.");
  if (!docxHasUnknownPlaceholder) throw new Error("DOCX did not preserve the unknown-macro placeholder.");
  if (!docxHasCodeTitle) throw new Error("DOCX did not render the legacy code title above the source.");
  if (!docxHasNestedCalloutIcons) {
    throw new Error("DOCX did not render semantic callout icons in table, list, and callout containers.");
  }

  const pdfHasCodeCollapseProjection = pdfReport.notes.some(
    (note) => note.code === "code-collapse-static" && note.level === "info",
  );
  const docxHasCodeCollapseProjection = docx.report.notes.some(
    (note) => note.code === "code-collapse-static" && note.level === "info",
  );
  if (!pdfHasCodeCollapseProjection || !docxHasCodeCollapseProjection) {
    throw new Error("The static code-collapse projection fact is missing from one target.");
  }

  const docxWarningCodes = warningCodes(docx.report.notes);
  if (docxWarningCodes.length > 0) {
    throw new Error(`DOCX engine emitted unexpected warning notes: ${docxWarningCodes.join(", ")}.`);
  }

  const digest = await sha256Hex(first.bytes);
  return {
    compilerVersion: pdfReport.compilerVersion,
    byteIdenticalWarmRepeat,
    pageCount: inspection.pageCount,
    tagged: inspection.tagged,
    docxHasTable,
    docxHasLandscape,
    docxHasAnchorBookmark,
    docxHasUnknownPlaceholder,
    docxHasCodeTitle,
    docxHasNestedCalloutIcons,
    pdfHasCodeCollapseProjection,
    docxHasCodeCollapseProjection,
    pdfWarningCodes,
    docxWarningCodes,
    reportNotes: projectReportNotes(pdfReport.notes),
    digests: { "blocks.pdf": digest },
  };
}
