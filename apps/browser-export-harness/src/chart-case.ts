import {
  canvasSvgRasterizer,
  memoryTemplateSource,
  runExport,
  unzipDocx,
} from "@atlcli/docx/browser-entry";
import {
  chartWorldClassBlocksV1,
  CHART_WORLD_CLASS_KINDS_V1,
  DOCX_TEMPLATE_BYTES,
} from "@atlcli/export-fixtures";
import {
  runPdfExport,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The chart acceptance corpus has no external assets.");
  },
};

function clock(): () => number {
  let tick = 0;
  return () => tick++;
}

export interface ChartCaseResult {
  shapes: readonly string[];
  docx: {
    byteLength: number;
    svgParts: number;
    pngFallbackParts: number;
    titlesInDocument: number;
    complete: boolean;
    noteCodes: string[];
  };
  pdf: {
    byteLength: number;
    pageCount: number;
    svgAssets: number;
    titlesInTypstSource: number;
    complete: boolean;
    noteCodes: string[];
  };
}

/**
 * Runs the canonical twelve-shape chart corpus through the ordinary-browser
 * DOCX and PDF entry points. The checks intentionally inspect the artifacts
 * handed to each host seam: Word must contain the canonical SVG plus PNG
 * compatibility renditions, while Typst must receive the canonical SVGs as
 * vector assets. No browser screenshot service or second chart renderer is
 * involved.
 */
export async function runChartCase(): Promise<ChartCaseResult> {
  const blocks = chartWorldClassBlocksV1();

  const docxOutput = new MemoryOutputSink();
  const docxReport = await runExport(
    {
      details: {
        id: "chart-browser-proof",
        title: "Chart browser proof",
        version: 1,
        spaceKey: "PROOF",
        storage: "",
      },
      blocks,
      template: {
        name: "chart-browser-proof.docx",
        modificationDate: new Date("2026-08-01T00:00:00.000Z"),
      },
      exportDate: new Date("2026-08-01T00:00:00.000Z"),
    },
    {
      templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES),
      rasterizer: canvasSvgRasterizer({ document }),
      output: docxOutput,
    },
  );
  const docxBytes = docxOutput.single.bytes;
  const zip = unzipDocx(docxBytes);
  const mediaParts = Object.keys(zip.files).filter((name) => name.startsWith("word/media/"));
  const svgParts = mediaParts.filter((name) => name.endsWith(".svg"));
  const pngFallbackParts = mediaParts.filter((name) => name.endsWith(".png"));
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const titlesInDocument = blocks.filter((block) =>
    block.chart.title !== undefined && documentXml.includes(block.chart.title)
  ).length;
  if (svgParts.length !== blocks.length || pngFallbackParts.length !== blocks.length) {
    throw new Error(
      `DOCX chart media mismatch: ${svgParts.length} SVG and ${pngFallbackParts.length} PNG for ${blocks.length} charts.`,
    );
  }
  if (titlesInDocument !== blocks.length) {
    throw new Error(`DOCX retained ${titlesInDocument}/${blocks.length} chart titles.`);
  }

  const worker = new HarnessPdfWorkerClient();
  let capturedBundle: PdfSourceBundle | undefined;
  const capturingCompiler: PdfCompilePort = {
    compile(bundle, context) {
      capturedBundle = bundle;
      return worker.compile(bundle, context);
    },
  };
  const pdfOutput = new MemoryOutputSink();
  const pdfReport = await runPdfExport(
    {
      blocks,
      metadata: {
        title: "Chart browser proof",
        space: "PROOF",
        version: 1,
        exporter: "atlcli ordinary-browser harness",
        exportedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      profile: "tagged",
      filename: "chart-browser-proof.pdf",
    },
    {
      assets: noAssets,
      compiler: capturingCompiler,
      output: pdfOutput,
      now: clock(),
    },
  );
  const pdfBytes = pdfOutput.single.bytes;
  const inspection = validatePdfOutput(pdfBytes);
  if (!capturedBundle) throw new Error("The PDF compiler did not receive a source bundle.");
  const bundle: PdfSourceBundle = capturedBundle;
  const svgAssets = bundle.assets.filter(
    (asset) => asset.mediaType === "image/svg+xml" && asset.path.startsWith("assets/chart-"),
  );
  const titlesInTypstSource = blocks.filter((block) =>
    block.chart.title !== undefined && bundle.main.includes(block.chart.title)
  ).length;
  if (svgAssets.length !== blocks.length) {
    throw new Error(`PDF received ${svgAssets.length}/${blocks.length} chart SVG assets.`);
  }
  if (titlesInTypstSource !== blocks.length) {
    throw new Error(`PDF retained ${titlesInTypstSource}/${blocks.length} chart titles.`);
  }
  for (const asset of svgAssets) {
    const svg = new TextDecoder().decode(asset.bytes);
    if (!svg.includes('class="ts-chart"') || !svg.includes('role="img"')) {
      throw new Error(`PDF chart asset ${asset.path} is not the accessible TanStack SVG.`);
    }
  }

  return {
    shapes: CHART_WORLD_CLASS_KINDS_V1,
    docx: {
      byteLength: docxBytes.byteLength,
      svgParts: svgParts.length,
      pngFallbackParts: pngFallbackParts.length,
      titlesInDocument,
      complete: docxReport.complete,
      noteCodes: [...new Set(docxReport.notes.map((note) => note.code))].sort(),
    },
    pdf: {
      byteLength: pdfBytes.byteLength,
      pageCount: inspection.pageCount,
      svgAssets: svgAssets.length,
      titlesInTypstSource,
      complete: pdfReport.complete,
      noteCodes: [...new Set(pdfReport.notes.map((note) => note.code))].sort(),
    },
  };
}
