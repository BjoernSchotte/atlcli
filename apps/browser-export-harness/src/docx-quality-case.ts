/**
 * Conformance case 006 `docx-quality` (spec 006 Word quality, gated by 011).
 * DOCX-only. Drives blocks + template that exercise all four spec-006 outputs
 * through the REAL browser DOCX engine (canvas rasterizer, PizZip). Proves:
 *   - `word/numbering.xml` carries one self-contained definition per ordered
 *     list node, including authored top-level and nested starts,
 *   - `w:tblGrid` carries per-column widths from `columnWidths`,
 *   - an SVG attachment lands as an `asvg:svgBlip` + PNG-fallback media pair,
 *   - the running-header STYLEREF field survives into `word/header1.xml` with no
 *     unused-style warning (the level-1 heading emits the referenced style),
 *   - the engine emits no warning notes.
 */
import {
  canvasSvgRasterizer,
  memoryTemplateSource,
  runExport,
  unzipDocx,
  type AssetFetcher,
} from "@atlcli/docx/browser-entry";
import {
  DOCX_QUALITY_BLOCKS,
  DOCX_QUALITY_DETAILS,
  DOCX_QUALITY_SVG_BYTES,
  DOCX_QUALITY_SVG_FILENAME,
  DOCX_QUALITY_TEMPLATE_BYTES,
} from "@atlcli/export-fixtures";
import { MemoryOutputSink } from "./memory-output.js";

const svgAssets: AssetFetcher = {
  async fetch(ref): Promise<Uint8Array> {
    if (ref.filename === DOCX_QUALITY_SVG_FILENAME) return DOCX_QUALITY_SVG_BYTES;
    throw new Error(`Unexpected asset request: ${ref.filename ?? ref.url}`);
  },
};

export interface DocxQualityCaseResult {
  hasNumberingPart: boolean;
  numberingLevelCount: number;
  numberingDefinitionCount: number;
  numberingInstanceCount: number;
  orderedStarts: number[];
  orderedIndents: number[];
  gridColCount: number;
  svgMediaParts: string[];
  pngMediaParts: string[];
  hasSvgBlip: boolean;
  stylerefSurvives: boolean;
  stylerefStyleNames: string[];
  embeddedImages: number;
  warningCodes: string[];
}

export async function runDocxQualityCase(): Promise<DocxQualityCaseResult> {
  const output = new MemoryOutputSink();
  const report = await runExport(
    {
      details: DOCX_QUALITY_DETAILS,
      blocks: DOCX_QUALITY_BLOCKS,
      template: { name: "docx-quality-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
      assets: svgAssets,
      rasterizer: canvasSvgRasterizer({ document }),
    },
    { templates: memoryTemplateSource(DOCX_QUALITY_TEMPLATE_BYTES), output },
  );

  const zip = unzipDocx(output.single.bytes);
  const names = Object.keys(zip.files);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const header1 = zip.file("word/header1.xml")?.asText() ?? "";
  const numberingXml = zip.file("word/numbering.xml")?.asText() ?? "";

  const hasNumberingPart = numberingXml.length > 0;
  const numberingLevelCount = (numberingXml.match(/<w:lvl\b/g) ?? []).length;
  const numberingDefinitionCount = (numberingXml.match(/<w:abstractNum\b/g) ?? []).length;
  const numberingInstanceCount = (numberingXml.match(/<w:num\s/g) ?? []).length;
  const orderedStarts = [...numberingXml.matchAll(/<w:start w:val="(\d+)"\/>/g)].map((match) => Number(match[1]));
  const orderedIndents = [...numberingXml.matchAll(/<w:ind w:left="(\d+)" w:hanging="360"\/>/g)].map((match) => Number(match[1]));
  const gridColCount = (documentXml.match(/<w:gridCol\b/g) ?? []).length;
  const svgMediaParts = names.filter((n) => /^word\/media\/.*\.svg$/i.test(n)).sort();
  const pngMediaParts = names.filter((n) => /^word\/media\/.*\.png$/i.test(n)).sort();
  const hasSvgBlip = documentXml.includes("svgBlip");
  const stylerefSurvives = /STYLEREF/i.test(header1);
  const warningCodes = report.notes.filter((n) => n.level === "warning").map((n) => n.code);

  if (!hasNumberingPart) throw new Error("word/numbering.xml was not emitted for the ordered lists.");
  if (numberingDefinitionCount !== 2 || numberingLevelCount !== 2 || numberingInstanceCount !== 2) {
    throw new Error(
      `Expected two self-contained ordered-list definitions/instances, got ${numberingDefinitionCount}/${numberingLevelCount}/${numberingInstanceCount}.`,
    );
  }
  if (numberingXml.includes("<w:lvlOverride")) {
    throw new Error("Ordered-list numbering unexpectedly depends on a level override.");
  }
  if (orderedStarts.join(",") !== "3,8") {
    throw new Error(`Expected authored ordered-list starts 3,8, got ${orderedStarts.join(",")}.`);
  }
  if (orderedIndents.join(",") !== "720,1440") {
    throw new Error(`Expected nested ordered-list indents 720,1440, got ${orderedIndents.join(",")}.`);
  }
  if (gridColCount !== 2) throw new Error(`Expected 2 w:gridCol widths, got ${gridColCount}.`);
  if (svgMediaParts.length === 0) throw new Error("The SVG attachment did not land as an SVG media part.");
  if (pngMediaParts.length === 0) throw new Error("The SVG attachment produced no PNG-fallback media part.");
  if (!hasSvgBlip) throw new Error("document.xml is missing the asvg:svgBlip element.");
  if (!stylerefSurvives) throw new Error("The STYLEREF header field did not survive export.");
  if (report.embeddedImages < 1) throw new Error("The SVG image was not embedded.");
  if (warningCodes.length > 0) {
    throw new Error(`DOCX quality export emitted unexpected warnings: ${warningCodes.join(", ")}.`);
  }

  return {
    hasNumberingPart,
    numberingLevelCount,
    numberingDefinitionCount,
    numberingInstanceCount,
    orderedStarts,
    orderedIndents,
    gridColCount,
    svgMediaParts,
    pngMediaParts,
    hasSvgBlip,
    stylerefSurvives,
    stylerefStyleNames: report.scan.stylerefStyleNames,
    embeddedImages: report.embeddedImages,
    warningCodes,
  };
}
