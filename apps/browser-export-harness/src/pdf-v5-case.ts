/** Catalog-V3/canonical-revision-5 browser runtime and warm-repeat proof. */
import {
  runPdfExport,
  validatePdfOutput,
  type PdfAssetResolver,
} from "@atlcli/pdf/browser";
import { PDF_SETTINGS_BLOCKS, PDF_SETTINGS_METADATA } from "@atlcli/export-fixtures";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { buildPdfV5RuntimeFixture } from "./pdf-v5-runtime-fixture.js";
import { sha256Hex } from "./digest.js";

const compiler = new HarnessPdfWorkerClient();
const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The revision-5 browser fixture has no document assets.");
  },
};

function clock(): () => number {
  let tick = 0;
  return () => tick++;
}

async function compile(runtime: Awaited<ReturnType<typeof buildPdfV5RuntimeFixture>>["runtime"]) {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    {
      blocks: PDF_SETTINGS_BLOCKS,
      metadata: PDF_SETTINGS_METADATA,
      templatePack: runtime,
      profile: "tagged",
      filename: "Catalog V3 Browser Conformance.pdf",
    },
    { assets: noAssets, compiler, output, now: clock() },
  );
  return { bytes: output.single.bytes, report };
}

export async function runPdfV5Case() {
  const fixture = await buildPdfV5RuntimeFixture();
  const first = await compile(fixture.runtime);
  const warm = await compile(fixture.runtime);
  const inspection = validatePdfOutput(first.bytes);
  const pdfDigest = await sha256Hex(first.bytes);
  const warmDigest = await sha256Hex(warm.bytes);
  if (pdfDigest !== warmDigest) throw new Error("Revision-5 browser output changed on warm repeat.");
  if (!inspection.tagged || !inspection.hasOutline || inspection.embeddedFontFiles < 1) {
    throw new Error("Revision-5 browser output lost tags, outline, or embedded fonts.");
  }
  return {
    compilerVersion: first.report.compilerVersion,
    deterministicWarmRepeat: true,
    digests: {
      "runtime-v5.wiki-pdf-template": await sha256Hex(fixture.packBytes),
      "runtime-v5.pdf": pdfDigest,
    },
    reportNotes: first.report.notes.map(({ code, level }) => ({ code, severity: level })),
    parity: {
      runtimeSnapshot: structuredClone(fixture.runtime.runtimeSnapshot),
      runtimeInspection: inspection,
      runtimeReportNotes: first.report.notes.map(({ code, level }) => ({ code, level })),
    },
  };
}
