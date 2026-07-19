import { beforeAll, describe, expect, it } from "bun:test";
import {
  ATLCLI_TYPST_TEMPLATE,
  validatePdfOutput,
  type PdfSourceBundle,
} from "@atlcli/pdf";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";
import { assertPdfAssetParity, getPdfCompiler, loadPdfCompilerAssets } from "./export-pdf-assets.js";

// The `bun test` offline claim holds only once the root `fonts:ensure` /
// `prebuild` step has warmed `packages/pdf/.fonts/`. `ensurePdfFonts` itself
// only hits the network on a COLD cache (sha256-verified download); a warm cache
// is a no-op. CI ordering: run `bun run fonts:ensure` before `bun test`.
beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

function minimalBundle(): PdfSourceBundle {
  return {
    main: String.raw`#set text(font: "Source Sans 3")
= CLI smoke
#text(font: "Source Serif 4")[Serif]
#text(font: "Source Code Pro")[Code]
`,
    template: ATLCLI_TYPST_TEMPLATE,
    assets: [],
    sourceMap: [],
    notes: [],
  };
}

describe("export-pdf-assets (T3.1 compile port under Bun)", () => {
  it("keeps the embedded font set in parity with the canonical manifest", () => {
    expect(() => assertPdfAssetParity()).not.toThrow();
  });

  it("loads the wasm as a standalone ArrayBuffer and all 10 fonts", async () => {
    const { wasm, fonts } = await loadPdfCompilerAssets();
    expect(wasm).toBeInstanceOf(ArrayBuffer);
    expect(wasm.byteLength).toBeGreaterThan(1_000_000); // multi-MB typst wasm
    expect(fonts).toHaveLength(10);
    for (const font of fonts) expect(font.byteLength).toBeGreaterThan(0);
  });

  it("compiles a minimal bundle to a tagged, font-embedded PDF via the real load path", async () => {
    const compiler = await getPdfCompiler();
    const result = await compiler.compile(minimalBundle());
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    const bytes = result.pdf!;
    // %PDF- magic bytes.
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const inspection = validatePdfOutput(bytes);
    expect(inspection.pageCount).toBeGreaterThanOrEqual(1);
    expect(inspection.tagged).toBe(true);
    expect(inspection.embeddedFontFiles).toBeGreaterThan(0);
  }, 30_000);

  it("reuses one lazily-created compiler instance across calls", async () => {
    const first = await getPdfCompiler();
    const second = await getPdfCompiler();
    expect(first).toBe(second);
  });
});
