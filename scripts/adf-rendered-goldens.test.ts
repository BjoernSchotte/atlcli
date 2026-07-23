import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ADF_RENDERED_GOLDEN_DIR,
  ADF_RENDERED_GOLDEN_MANIFEST,
  adfRenderedGoldenTools,
  checkAdfRenderedGoldens,
  type AdfRenderedGoldenManifest,
} from "./adf-rendered-goldens.js";

const tools = adfRenderedGoldenTools();
const HAVE_RENDER_TOOLS = Boolean(tools.soffice && tools.pdftoppm && tools.pdftotext);

describe("ADF rendered goldens", () => {
  it("pins synthetic visual references for both export formats and every target feature", async () => {
    const manifest = JSON.parse(await readFile(ADF_RENDERED_GOLDEN_MANIFEST, "utf8")) as AdfRenderedGoldenManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.features).toEqual([
      "inline-code",
      "unicode-emoji",
      "custom-emoji-fallback",
      "block-alignment",
      "block-indentation",
      "ordered-list-start",
      "nested-list-restart",
      "table",
      "layout-degradation",
      "smart-link",
      "media-fallback",
      "extension",
    ]);
    for (const format of ["docx", "pdf"] as const) {
      expect(manifest.formats[format].pages.length).toBeGreaterThan(0);
      for (const page of manifest.formats[format].pages) {
        const bytes = new Uint8Array(await readFile(`${ADF_RENDERED_GOLDEN_DIR}/${page.file}`));
        expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      }
    }
  });

  it.skipIf(!HAVE_RENDER_TOOLS)("re-renders DOCX and PDF within the reviewed visual budgets", async () => {
    const result = await checkAdfRenderedGoldens();
    expect(result).toMatchObject({ updated: false, docxPages: 1, pdfPages: 4 });
    expect(result.maxMeanPixelDifference).toBeLessThanOrEqual(0.08);
    expect(result.minContentBoundsIou).toBeGreaterThanOrEqual(0.8);
  }, 60_000);
});
