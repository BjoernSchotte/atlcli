import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  fontCodePointRanges,
  generatePdfFontCoverageSource,
} from "../scripts/generate-font-coverage.js";
import { PDF_FONT_COVERAGE_V1 } from "./font-coverage.generated.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

describe("generated PDF font coverage", () => {
  it("is reproducible from the pinned font bytes", async () => {
    const generatedPath = fileURLToPath(
      new URL("./font-coverage.generated.ts", import.meta.url),
    );

    expect(await generatePdfFontCoverageSource()).toBe(
      await Bun.file(generatedPath).text(),
    );
  });

  it("is hash-bound, ordered, and non-overlapping for every canonical font", () => {
    expect(JSON.stringify(
      PDF_FONT_COVERAGE_V1.map(({ fileName, sha256 }) => ({ fileName, sha256 })),
    )).toBe(JSON.stringify(
      PDF_RUNTIME_ASSETS.fonts.map(({ fileName, sha256 }) => ({
        fileName,
        sha256,
      })),
    ));
    for (const entry of PDF_FONT_COVERAGE_V1) {
      for (const [index, [start, end]] of entry.ranges.entries()) {
        expect(start).toBeLessThanOrEqual(end);
        const previous = entry.ranges[index - 1];
        if (previous) expect(start).toBeGreaterThan(previous[1] + 1);
      }
    }
  });

  it("rejects malformed sfnt bytes instead of producing trusted metadata", () => {
    expect(() => fontCodePointRanges(new Uint8Array(8))).toThrow();
  });
});
