/**
 * Conformance case 003 `content-compat` (spec 003 content features, gated by 011).
 *
 * A Confluence storage fixture with `scroll-pagebreak`, `scroll-landscape`,
 * `scroll-title` (→ caption) and a 200-row repeating-header table, exercised
 * through the REAL `storageToBlocks` parser. The DOCX engine consumes the
 * storage directly (`details.storage`); the PDF engine consumes the same
 * storage parsed for the `pdf` exporter. Proves:
 *   - the parser emits NO warning notes,
 *   - the DOCX carries a page break, a landscape section, and the full table,
 *   - the PDF grows past one page (the page break) and stays tagged.
 * Emits a PDF sha256 digest + report projection for the shape-parity gate.
 */
import { validatePdfOutput } from "@atlcli/pdf/browser";
import {
  memoryTemplateSource,
  runExport,
  unzipDocx,
} from "@atlcli/docx/browser-entry";
import {
  CONTENT_COMPAT_DETAILS,
  CONTENT_COMPAT_METADATA,
  contentCompatBlocks,
  DOCX_TEMPLATE_BYTES,
} from "@atlcli/export-fixtures";
import { projectReportNotes, sha256Hex, type ReportNoteProjection } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const PDF_FILENAME = "Content Compatibility.pdf";
const compiler = new HarnessPdfWorkerClient();

function warningCodes(notes: ReadonlyArray<{ code: string; level?: string; severity?: string }>): string[] {
  return notes.filter((n) => (n.severity ?? n.level) === "warning").map((n) => n.code);
}

export interface ContentCaseResult {
  compilerVersion: string;
  parseWarningCodes: string[];
  pageCount: number;
  tagged: boolean;
  docxHasPageBreak: boolean;
  docxHasLandscape: boolean;
  docxRowCount: number;
  reportNotes: ReportNoteProjection[];
  digests: Record<string, string>;
}

export async function runContentCase(): Promise<ContentCaseResult> {
  const parsed = contentCompatBlocks("pdf");
  const parseWarningCodes = warningCodes(parsed.notes);
  if (parseWarningCodes.length > 0) {
    throw new Error(`storageToBlocks emitted unexpected warnings: ${parseWarningCodes.join(", ")}.`);
  }

  // PDF — the scroll-pagebreak forces a second page.
  const pdf = await compilePdf(compiler, parsed.blocks, CONTENT_COMPAT_METADATA, PDF_FILENAME);
  const inspection = validatePdfOutput(pdf.bytes);
  if (!inspection.tagged) throw new Error("Content-compat PDF is not tagged.");
  if (inspection.pageCount < 2) throw new Error(`Expected >=2 pages (scroll-pagebreak), got ${inspection.pageCount}.`);

  // DOCX — consume the storage directly; assert the section/table markers.
  const output = new MemoryOutputSink();
  await runExport(
    {
      details: CONTENT_COMPAT_DETAILS,
      template: { name: "content-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const docxHasPageBreak = documentXml.includes('w:type="page"');
  const docxHasLandscape = documentXml.includes('w:orient="landscape"');
  const docxRowCount = (documentXml.match(/<w:tr\b/g) ?? []).length;
  if (!docxHasPageBreak) throw new Error("DOCX is missing the scroll-pagebreak.");
  if (!docxHasLandscape) throw new Error("DOCX is missing the scroll-landscape section.");
  if (docxRowCount < 200) throw new Error(`Expected >=200 DOCX table rows, got ${docxRowCount}.`);

  return {
    compilerVersion: pdf.report.compilerVersion,
    parseWarningCodes,
    pageCount: inspection.pageCount,
    tagged: inspection.tagged,
    docxHasPageBreak,
    docxHasLandscape,
    docxRowCount,
    reportNotes: projectReportNotes(pdf.report.notes),
    digests: { "content-compat.pdf": await sha256Hex(pdf.bytes) },
  };
}
