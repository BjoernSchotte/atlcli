#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runExport, resvgSvgRasterizer } from "@atlcli/docx";
import {
  chartWorldClassBlocksV1,
} from "@atlcli/export-fixtures";
import type { ConfluencePageDetails, ExportBlock } from "@atlcli/confluence";
import { runPdfExport, type PdfExportMetadata } from "@atlcli/pdf";
import { nodeDocxEnv } from "../packages/export-node/src/docx-env.js";
import { nodePdfEnv } from "../packages/export-node/src/pdf-env.js";

const PROOF_DATE = new Date("2026-08-01T18:00:00.000Z");
const DOCX_FILENAME = "chart-world-class-proof.docx";
const PDF_FILENAME = "chart-world-class-proof.pdf";

const details: ConfluencePageDetails = {
  id: "chart-world-class-proof",
  title: "Chart world-class proof",
  url: "https://example.invalid/wiki/spaces/TEST/pages/chart-world-class-proof",
  version: 1,
  spaceKey: "TEST",
  storage: "",
  created: PROOF_DATE.toISOString(),
  modified: PROOF_DATE.toISOString(),
  createdBy: { displayName: "Fixture Author" },
  modifiedBy: { displayName: "Fixture Author" },
  labels: ["chart-proof"],
};

const metadata: PdfExportMetadata = {
  title: details.title,
  space: details.spaceKey,
  version: details.version,
  author: details.createdBy?.displayName,
  exporter: "atlcli chart proof",
  language: "en",
  region: "GB",
  exportedAt: PROOF_DATE,
};

function proofBlocks(): ExportBlock[] {
  const blocks = chartWorldClassBlocksV1();
  if (process.argv.includes("--diagnostic") && blocks[0]) {
    blocks[0] = {
      ...blocks[0],
      diagnostics: [{
        code: "skipped-row",
        message: "One malformed source row was skipped; the remaining values are shown.",
        row: 3,
      }],
    };
  }
  return blocks.flatMap((block, index) => (
    index === blocks.length - 1 ? [block] : [block, { type: "pageBreak" }]
  ));
}

async function main(): Promise<void> {
  const outputDir = resolve(process.argv[2] ?? "/private/tmp/atlcli-chart-world-class-proof");
  await mkdir(outputDir, { recursive: true });
  const blocks = proofBlocks();
  const profile: Parameters<typeof nodePdfEnv>[0] = {
    name: "chart-world-class-proof",
    baseUrl: "https://example.invalid",
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "fixture@example.invalid", token: "unused" },
  };

  const docxReport = await runExport(
    {
      details,
      blocks,
      template: { name: DOCX_FILENAME, modificationDate: PROOF_DATE },
      exportDate: PROOF_DATE,
    },
    nodeDocxEnv({
      outPath: join(outputDir, DOCX_FILENAME),
      extras: {
        rasterizer: resvgSvgRasterizer(),
        assets: {
          async fetch(): Promise<never> {
            throw new Error("The tenant-free chart proof must not request external assets.");
          },
        },
      },
    }),
  );

  const pdfReport = await runPdfExport(
    {
      blocks,
      metadata,
      profile: "tagged",
      filename: PDF_FILENAME,
    },
    nodePdfEnv(profile, {
      outDir: outputDir,
      assets: {
        async resolve(): Promise<never> {
          throw new Error("The tenant-free chart proof must not request external assets.");
        },
      },
    }),
  );

  process.stdout.write(`${JSON.stringify({
    outputDir,
    files: {
      docx: join(outputDir, DOCX_FILENAME),
      pdf: join(outputDir, PDF_FILENAME),
    },
    shapes: chartWorldClassBlocksV1().map((block) => block.chart.kind),
    reports: {
      docx: {
        filename: docxReport.filename,
        renderedDiagrams: docxReport.renderedDiagrams,
        skippedImages: docxReport.skippedImages,
        notes: docxReport.notes.map((note) => ({ code: note.code, message: note.message })),
      },
      pdf: {
        filename: pdfReport.filename,
        renderedDiagrams: pdfReport.renderedDiagrams,
        skippedAssets: pdfReport.skippedAssets,
        notes: pdfReport.notes.map((note) => ({ code: note.code, message: note.message })),
      },
    },
  }, null, 2)}\n`);
}

await main();
