import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  validatePdfOutput,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE } from "@atlcli/pdf/template";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { BrowserPdfCompiler } from "./index.js";

// Real WASM + real font bytes; no mocks (spec 007 "never mock" rule).
beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

async function fontBytesForFamily(family: string): Promise<Uint8Array[]> {
  return Promise.all(
    PDF_RUNTIME_ASSETS.fonts
      .filter((f) => f.family === family)
      .map((f) => packageBytes(`@atlcli/pdf/fonts/${f.fileName}`))
  );
}

function bundle(main: string): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap: [], notes: [] };
}

// "Custom" corporate font stands in for a host-uploaded face: it is a real font
// (Source Code Pro) present ONLY in the added Uint8Array set, never in the base
// bundle — so its appearance in getLoadedFonts() proves add_raw_font surfaced a
// family from the added bytes (a file rename could not achieve this: the family
// is read from the font's own name table).
const CUSTOM_FAMILY = "Source Code Pro";

// getLoadedFonts() reflects the fonts the compiler actually touched during a
// compile (the typst world loads faces lazily), so every assertion runs after a
// real compile of a document that references the custom family.
const CUSTOM_DOC = String.raw`#set text(font: "Source Sans 3")
= Custom font intake
#text(font: "Source Code Pro")[Rendered with the added corporate font.]
`;

describe("custom font intake into BrowserPdfCompilerAssets.fonts", () => {
  it("does not surface the custom family when it is absent from the fonts", async () => {
    const base = [
      ...(await fontBytesForFamily("Source Sans 3")),
      ...(await fontBytesForFamily("Source Serif 4")),
    ];
    const wasm = await packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm");
    const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts: base });
    // Compile the Code-Pro doc with no Code-Pro bytes available: the family can
    // never be loaded from a base set that does not contain it.
    await compiler.compile(bundle(CUSTOM_DOC));
    const loaded = (await compiler.getLoadedFonts()).join("\n");
    expect(loaded).not.toContain(CUSTOM_FAMILY);
  }, 30_000);

  it("loads the custom family and compiles a document using it with zero diagnostics", async () => {
    const base = [
      ...(await fontBytesForFamily("Source Sans 3")),
      ...(await fontBytesForFamily("Source Serif 4")),
    ];
    const custom = await fontBytesForFamily(CUSTOM_FAMILY);
    expect(custom.length).toBeGreaterThan(0);

    const wasm = await packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm");
    const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts: [...base, ...custom] });

    const result = await compiler.compile(bundle(CUSTOM_DOC));
    expect(result.diagnostics).toEqual([]);
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });

    const loaded = (await compiler.getLoadedFonts()).join("\n");
    expect(loaded).toContain(CUSTOM_FAMILY);
  }, 30_000);
});
