import {
  canvasSvgRasterizer,
  memoryTemplateSource,
} from "@atlcli/docx/browser-runtime";
import { runExport } from "@atlcli/docx/browser";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  DOCX_DETAILS,
  DOCX_EXPECTED,
  DOCX_TEMPLATE_BYTES,
} from "./fixture.js";
import { MemoryOutputSink } from "./memory-output.js";

export interface DocxCaseResult {
  filename: string;
  byteLength: number;
  resolvedCount: number;
  renderedDiagrams: number;
  semanticNoteCodes: string[];
  mediaParts: string[];
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function runDocxCase(): Promise<DocxCaseResult> {
  if ((globalThis as { Buffer?: unknown }).Buffer !== undefined) {
    throw new Error("The DOCX browser runtime must not install a global Buffer.");
  }

  const output = new MemoryOutputSink();
  const report = await runExport(
    {
      details: DOCX_DETAILS,
      template: {
        name: "browser-harness-template.docx",
        modificationDate: new Date("2026-07-17T08:00:00.000Z"),
      },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    {
      templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES),
      rasterizer: canvasSvgRasterizer({ document }),
      output,
    },
  );

  const emitted = output.single;
  if (!hasZipSignature(emitted.bytes)) throw new Error("DOCX output has no ZIP signature.");

  const zip = unzipDocx(emitted.bytes);
  const mediaParts = Object.keys(zip.files)
    .filter((name) => /^word\/media\/.*\.png$/i.test(name))
    .sort();
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const relationships = zip.file("word/_rels/document.xml.rels")?.asText() ?? "";
  if (mediaParts.length === 0 || !documentXml.includes("a:blip") || !relationships.includes("/image")) {
    throw new Error("The Mermaid diagram was not structurally embedded in the DOCX package.");
  }

  const semanticNoteCodes = report.notes
    .map((note) => note.code)
    .filter((code) => code !== "perf-timing");
  if (report.filename !== DOCX_EXPECTED.filename) {
    throw new Error(`Unexpected DOCX filename: ${report.filename}.`);
  }
  if (report.resolvedCount !== DOCX_EXPECTED.resolvedCount) {
    throw new Error(`Unexpected DOCX resolved count: ${report.resolvedCount}.`);
  }
  if (report.renderedDiagrams !== DOCX_EXPECTED.renderedDiagrams) {
    throw new Error(`Unexpected rendered diagram count: ${report.renderedDiagrams}.`);
  }
  if (JSON.stringify(semanticNoteCodes) !== JSON.stringify(DOCX_EXPECTED.semanticNoteCodes)) {
    throw new Error(`Unexpected DOCX report notes: ${semanticNoteCodes.join(", ")}.`);
  }

  return {
    filename: emitted.name,
    byteLength: emitted.bytes.byteLength,
    resolvedCount: report.resolvedCount,
    renderedDiagrams: report.renderedDiagrams,
    semanticNoteCodes,
    mediaParts,
  };
}
