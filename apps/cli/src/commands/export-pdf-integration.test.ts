import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  validatePdfOutput,
  type ExportBlock,
  type PdfExportMetadata,
} from "@atlcli/pdf";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";
import { getPdfCompiler } from "./export-pdf-assets.js";
import { filePdfOutputSink } from "./export-pdf.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

/**
 * End-to-end proof of the CLI PDF chain WITHOUT Confluence (the fetch is E2E):
 * real compiler → real strict atomic sink → the on-disk bytes pass
 * validatePdfOutput as a tagged, font-embedded PDF with an outline.
 */
describe("PDF export chain writes a valid tagged PDF to disk", () => {
  it("compiles and commits a tagged, outlined, font-embedded PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-pdf-int-"));
    try {
      const blocks: ExportBlock[] = [
        { type: "heading", level: 1, content: [{ type: "text", text: "Integration heading" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body paragraph." }] },
        {
          type: "table",
          rows: [
            { cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Col" }] }] }] },
            { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] },
          ],
        },
      ];
      const metadata: PdfExportMetadata = {
        title: "Integration",
        space: "DOCSY",
        exportedAt: new Date("2026-07-19T00:00:00Z"),
      };
      const outPath = join(dir, "integration.pdf");
      const compiler = await getPdfCompiler();
      const report = await runPdfExport(
        { blocks, metadata, filename: "integration.pdf" },
        {
          assets: { async resolve() { throw new Error("no assets"); } },
          compiler,
          output: filePdfOutputSink(outPath),
        }
      );
      expect(report.compilerDiagnostics).toEqual([]);
      expect(report.fontRequirements?.assets.length).toBeLessThan(
        PDF_RUNTIME_ASSETS.fonts.length,
      );
      expect(report.fontEvidence?.registeredAssetIds).toEqual(
        report.fontRequirements?.assets.map((asset) => asset.assetId),
      );
      expect(report.fontEvidence?.fullBundleFallback).toBe(false);
      const bytes = new Uint8Array(await readFile(outPath));
      expect(new TextDecoder("latin1").decode(bytes.subarray(0, 5))).toBe("%PDF-");
      const inspection = validatePdfOutput(bytes);
      expect(inspection.pageCount).toBeGreaterThanOrEqual(1);
      expect(inspection.tagged).toBe(true);
      expect(inspection.hasOutline).toBe(true);
      expect(inspection.embeddedFontFiles).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
