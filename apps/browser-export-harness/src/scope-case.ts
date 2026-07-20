/**
 * Conformance case 002 `scope` (spec 002 scope orchestration, gated by 011).
 *
 * Composes a three-page tree (root + two chapters) through the REAL
 * `composeChapters` and runs the composed document through both engines. Proves:
 *   - compose emits NO warning notes (in-page anchor + link resolve — no
 *     dangling-link diagnostic — after anchor namespacing),
 *   - the PDF grows to >=3 pages (a hard page break per chapter) and carries an
 *     outline (chapter headings),
 *   - the DOCX carries the chapter page breaks and the namespaced anchor
 *     bookmark.
 * Emits a PDF sha256 digest + report projection for the shape-parity gate.
 */
import { validatePdfOutput } from "@atlcli/pdf/browser";
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  composeScopeDocument,
  DOCX_TEMPLATE_BYTES,
  SCOPE_METADATA,
  SCOPE_ROOT_DETAILS,
} from "@atlcli/export-fixtures";
import { projectReportNotes, sha256Hex, type ReportNoteProjection } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const PDF_FILENAME = "Handbook.pdf";
const compiler = new HarnessPdfWorkerClient();

function warningCodes(notes: ReadonlyArray<{ code: string; level?: string; severity?: string }>): string[] {
  return notes.filter((n) => (n.severity ?? n.level) === "warning").map((n) => n.code);
}

export interface ScopeCaseResult {
  compilerVersion: string;
  composeBlockCount: number;
  composeWarningCodes: string[];
  pageCount: number;
  tagged: boolean;
  hasOutline: boolean;
  docxPageBreaks: number;
  docxHasNamespacedAnchor: boolean;
  reportNotes: ReportNoteProjection[];
  digests: Record<string, string>;
}

export async function runScopeCase(): Promise<ScopeCaseResult> {
  const composed = composeScopeDocument();
  const composeWarningCodes = warningCodes(composed.notes);
  if (composeWarningCodes.length > 0) {
    throw new Error(`composeChapters emitted unexpected warnings: ${composeWarningCodes.join(", ")}.`);
  }

  // PDF — chapter page breaks + outline growth.
  const pdf = await compilePdf(compiler, composed.blocks, SCOPE_METADATA, PDF_FILENAME);
  const inspection = validatePdfOutput(pdf.bytes);
  if (!inspection.tagged) throw new Error("Scope PDF is not tagged.");
  if (inspection.pageCount < 3) {
    throw new Error(`Expected >=3 pages (one per chapter), got ${inspection.pageCount}.`);
  }
  if (!inspection.hasOutline) throw new Error("Scope PDF has no outline (chapter headings).");

  // DOCX — the composed blocks reflect chapter breaks + the namespaced anchor.
  const output = new MemoryOutputSink();
  const docxReport = await runExport(
    {
      details: SCOPE_ROOT_DETAILS,
      blocks: composed.blocks,
      template: { name: "scope-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  void docxReport;
  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const docxPageBreaks = (documentXml.match(/w:type="page"/g) ?? []).length;
  if (docxPageBreaks < 2) throw new Error(`Expected >=2 DOCX chapter page breaks, got ${docxPageBreaks}.`);
  // The in-page anchor "alpha" survives namespacing into a bookmark (name is
  // sanitized to `p<pageId>-alpha` → still contains "alpha").
  const docxHasNamespacedAnchor = /w:name="[^"]*alpha[^"]*"/.test(documentXml);
  if (!docxHasNamespacedAnchor) throw new Error("DOCX lost the namespaced in-page anchor bookmark.");

  return {
    compilerVersion: pdf.report.compilerVersion,
    composeBlockCount: composed.blocks.length,
    composeWarningCodes,
    pageCount: inspection.pageCount,
    tagged: inspection.tagged,
    hasOutline: inspection.hasOutline,
    docxPageBreaks,
    docxHasNamespacedAnchor,
    reportNotes: projectReportNotes(pdf.report.notes),
    digests: { "scope.pdf": await sha256Hex(pdf.bytes) },
  };
}
