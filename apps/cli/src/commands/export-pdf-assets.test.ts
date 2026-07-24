import { beforeAll, describe, expect, it } from "bun:test";
import {
  validatePdfOutput,
  type PdfSourceBundle,
} from "@atlcli/pdf";
import { ATLCLI_TYPST_TEMPLATE } from "@atlcli/pdf/template";
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

  it("loads the wasm as a standalone ArrayBuffer and all 12 fonts", async () => {
    const { wasm, fonts } = await loadPdfCompilerAssets();
    expect(wasm).toBeInstanceOf(ArrayBuffer);
    expect(wasm.byteLength).toBeGreaterThan(1_000_000); // multi-MB typst wasm
    expect(fonts).toHaveLength(12);
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

  it("imports the wasm compiler ONLY lazily (regression: no static import)", async () => {
    // Static-import scan (same technique as compiler.test.ts): the multi-MB
    // wasm compiler must never load for non-export commands. Both files may only
    // reach it through a dynamic `await import(...)`.
    const assetsSrc = await Bun.file(new URL("./export-pdf-assets.ts", import.meta.url)).text();
    expect(assetsSrc).toMatch(/await import\(\s*["']@atlcli\/pdf-compiler-browser["']\s*\)/);
    expect(assetsSrc).not.toMatch(/^\s*import\s+\{[^}]*BrowserPdfCompiler[^}]*\}\s+from\s+["']@atlcli\/pdf-compiler-browser["']/m);

    const cmdSrc = await Bun.file(new URL("./export-pdf.ts", import.meta.url)).text();
    // export-pdf.ts reaches the compiler only via getPdfCompiler(), never a
    // direct static compiler import.
    expect(cmdSrc).not.toMatch(/from\s+["']@atlcli\/pdf-compiler-browser["']/);
  });
});
