/** Browser conformance that starts with real ADF before either render engine. */
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  ADF_CONFORMANCE_DETAILS,
  ADF_CONFORMANCE_METADATA,
  DOCX_TEMPLATE_BYTES,
  adfConformanceBlocks,
} from "@atlcli/export-fixtures";
import { validatePdfOutput } from "@atlcli/pdf/browser";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const compiler = new HarnessPdfWorkerClient();

export interface AdfSourceCaseResult {
  representation: "atlas_doc_format";
  blockTypes: string[];
  sourceNoteCodes: string[];
  pdfTagged: boolean;
  pdfPageCount: number;
  docxHasInlineCode: boolean;
  docxHasEmoji: boolean;
  docxHasTable: boolean;
  docxHasCardTitle: boolean;
  docxHasExtensionBody: boolean;
  docxHasVisibleMediaFallback: boolean;
}

export async function runAdfSourceCase(): Promise<AdfSourceCaseResult> {
  const pdfSource = adfConformanceBlocks("pdf");
  const wordSource = adfConformanceBlocks("word");
  if (
    pdfSource.representation !== "atlas_doc_format"
    || wordSource.representation !== "atlas_doc_format"
  ) {
    throw new Error("ADF-source conformance did not retain its primary representation.");
  }
  if (JSON.stringify(pdfSource.blocks) !== JSON.stringify(wordSource.blocks)) {
    throw new Error("ADF target decoders produced different neutral blocks.");
  }

  const pdf = await compilePdf(
    compiler,
    pdfSource.blocks,
    ADF_CONFORMANCE_METADATA,
    "ADF Browser Conformance.pdf",
    pdfSource.notes,
  );
  const inspection = validatePdfOutput(pdf.bytes);
  if (!inspection.tagged || inspection.pageCount < 1) {
    throw new Error("ADF-source PDF did not pass structural validation.");
  }

  const output = new MemoryOutputSink();
  await runExport(
    {
      details: ADF_CONFORMANCE_DETAILS,
      blocks: wordSource.blocks,
      sourceNotes: wordSource.notes,
      template: {
        name: "adf-conformance-template.docx",
        modificationDate: new Date("2026-07-22T08:00:00.000Z"),
      },
      exportDate: new Date("2026-07-22T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const relationships = zip.file("word/_rels/document.xml.rels")?.asText() ?? "";
  const result: AdfSourceCaseResult = {
    representation: pdfSource.representation,
    blockTypes: pdfSource.blocks.map((block) => block.type),
    sourceNoteCodes: pdfSource.notes.map((note) => note.code),
    pdfTagged: inspection.tagged,
    pdfPageCount: inspection.pageCount,
    docxHasInlineCode: documentXml.includes('w:rFonts w:ascii="Consolas"'),
    docxHasEmoji: documentXml.includes("⚠️"),
    docxHasTable: documentXml.includes("<w:tbl"),
    docxHasCardTitle:
      documentXml.includes("Local card title")
      && (documentXml.includes("https://example.invalid/adf-card")
        || relationships.includes("https://example.invalid/adf-card")),
    docxHasExtensionBody: documentXml.includes("Extension body"),
    docxHasVisibleMediaFallback: documentXml.includes("Visible media fallback") && documentXml.includes("Media caption"),
  };

  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith("docxHas") && value !== true) {
      throw new Error(`ADF-source DOCX assertion failed: ${key}.`);
    }
  }
  if (!result.sourceNoteCodes.includes("adf-media-unresolved")) {
    throw new Error("ADF-source case lost the unresolved-media degradation note.");
  }
  return result;
}
