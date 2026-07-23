/**
 * Conformance case 004 `macros` (spec 004 macro renderer registry, gated by 011).
 *
 * Runs the REAL `defaultRegistry` + `resolveMacroBlocks` resolver pass over a
 * storage fixture (live-Jira macro, draw.io diagram macro, unknown macro) with
 * deterministic in-memory ports (recorded Jira payload, an attachment lookup),
 * then serializes the resolved blocks through both engines. Proves:
 *   - the Jira JQL macro renders as a REAL `table` block (`macro-rendered-via`),
 *   - macros that cannot render hit the placeholder FLOOR: the `unknown` block
 *     is preserved and a `macro-degraded` note is emitted,
 *   - both engines serialize the resolved document cleanly.
 * Emits a PDF sha256 digest + report projection (which threads the resolution
 * notes) for the shape-parity gate.
 */
import { validatePdfOutput } from "@atlcli/pdf/browser";
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  countTables,
  countUnknown,
  DOCX_TEMPLATE_BYTES,
  hasMacroAdfExport,
  MACRO_ADF_BLOCK_EXPORT_TEXT,
  MACRO_ADF_BODIED_EXPORT_TEXT,
  MACRO_METADATA,
  resolveMacroFixtureBlocks,
} from "@atlcli/export-fixtures";
import { projectReportNotes, sha256Hex, type ReportNoteProjection } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const PDF_FILENAME = "Macro Coverage.pdf";
const compiler = new HarnessPdfWorkerClient();

export interface MacroCaseResult {
  compilerVersion: string;
  jiraTableCount: number;
  floorUnknownCount: number;
  adfExportResolved: boolean;
  resolutionNoteCodes: string[];
  pageCount: number;
  tagged: boolean;
  docxHasTable: boolean;
  docxHasAdfExport: boolean;
  reportNotes: ReportNoteProjection[];
  digests: Record<string, string>;
}

export async function runMacroCase(): Promise<MacroCaseResult> {
  const resolvedPdf = await resolveMacroFixtureBlocks("pdf");

  // Registry contract: one Jira table, two floored unknown macros, and both a
  // "rendered-via" (Jira) and a "degraded" (floor) note.
  const jiraTableCount = countTables(resolvedPdf.blocks);
  const floorUnknownCount = countUnknown(resolvedPdf.blocks);
  const adfExportResolved = hasMacroAdfExport(resolvedPdf.blocks);
  const resolutionNoteCodes = resolvedPdf.notes.map((n) => n.code);
  if (jiraTableCount !== 1) throw new Error(`Expected exactly one Jira table, got ${jiraTableCount}.`);
  if (floorUnknownCount < 2) throw new Error(`Expected >=2 placeholder-floor macros, got ${floorUnknownCount}.`);
  if (!adfExportResolved) {
    throw new Error("The Forge ADF extension did not resolve through its documented local ID.");
  }
  if (!resolutionNoteCodes.includes("macro-rendered-via")) {
    throw new Error("Missing macro-rendered-via note for the resolved Jira macro.");
  }
  if (!resolutionNoteCodes.includes("macro-degraded")) {
    throw new Error("Missing macro-degraded note for the placeholder floor.");
  }

  // PDF — serialize the resolved document; resolution notes ride along as source notes.
  const pdf = await compilePdf(compiler, resolvedPdf.blocks, MACRO_METADATA, PDF_FILENAME, resolvedPdf.notes);
  const inspection = validatePdfOutput(pdf.bytes);
  if (!inspection.tagged) throw new Error("Macro PDF is not tagged.");

  // DOCX — resolve for the word target and serialize the resolved blocks.
  const resolvedDocx = await resolveMacroFixtureBlocks("docx");
  const output = new MemoryOutputSink();
  await runExport(
    {
      details: {
        id: "macro-page",
        title: "Macro Coverage",
        url: "https://example.invalid/wiki/spaces/TEST/pages/macro-page",
        version: 1,
        spaceKey: "TEST",
        storage: "",
        created: "2026-07-17T08:00:00.000Z",
        modified: "2026-07-17T08:00:00.000Z",
        createdBy: { displayName: "Harness Author" },
        modifiedBy: { displayName: "Harness Author" },
        labels: [],
      },
      blocks: resolvedDocx.blocks,
      sourceNotes: resolvedDocx.notes,
      template: { name: "macro-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const docxHasTable = documentXml.includes("<w:tbl");
  const docxHasAdfExport =
    documentXml.includes(MACRO_ADF_BLOCK_EXPORT_TEXT) &&
    documentXml.includes(MACRO_ADF_BODIED_EXPORT_TEXT);
  if (!docxHasTable) throw new Error("DOCX did not render the Jira table.");
  if (!docxHasAdfExport) throw new Error("DOCX did not render the platform-projected Forge ADF export.");

  return {
    compilerVersion: pdf.report.compilerVersion,
    jiraTableCount,
    floorUnknownCount,
    adfExportResolved,
    resolutionNoteCodes,
    pageCount: inspection.pageCount,
    tagged: inspection.tagged,
    docxHasTable,
    docxHasAdfExport,
    reportNotes: projectReportNotes(pdf.report.notes),
    digests: { "macros.pdf": await sha256Hex(pdf.bytes) },
  };
}
