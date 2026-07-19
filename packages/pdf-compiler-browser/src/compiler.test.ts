import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS, type PdfSourceBundle } from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE, validatePdfOutput } from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { BrowserPdfCompiler, PDF_BROWSER_COMPILER_VERSION } from "./index.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

function bundle(main: string, sourceMap: PdfSourceBundle["sourceMap"] = []): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap, notes: [] };
}

describe("BrowserPdfCompiler package", () => {
  it("compiles with the complete canonical font set", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle(String.raw`#set text(font: "Source Sans 3")
= Package smoke
#text(font: "Source Serif 4")[Serif]
#text(font: "Source Code Pro")[Code]
`));
    expect(result.compilerVersion).toBe(PDF_BROWSER_COMPILER_VERSION);
    expect(result.diagnostics).toEqual([]);
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });
    const loaded = (await compiler.getLoadedFonts()).join("\n");
    expect(loaded).toContain("Source Sans 3");
    expect(loaded).toContain("Source Serif 4");
    expect(loaded).toContain("Source Code Pro");
  }, 30_000);

  it("returns normalized, source-mapped diagnostics without raw Typst ranges", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle(
      "#this-function-does-not-exist()",
      [{ blockPath: "blocks[0]", blockType: "paragraph", startLine: 1, startColumn: 1, endLine: 1, endColumn: 40 }]
    ));
    expect(result.pdf).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      path: "/main.typ",
      blockPath: "blocks[0]",
    });
    expect("range" in (result.diagnostics[0] as object)).toBe(false);
  }, 30_000);

  it("drops compiler state and initializes cleanly after reset", async () => {
    const compiler = await createCompiler();
    const source = bundle("= Reset lifecycle\n\nSame source.");
    const first = await compiler.compile(source);
    await compiler.reset();
    const second = await compiler.compile(source);
    expect(second.diagnostics).toEqual([]);
    expect(second.pdf).toEqual(first.pdf);
  }, 30_000);

  it("contains no host-specific asset or extension imports", async () => {
    const source = await Bun.file(new URL("./compiler.ts", import.meta.url)).text();
    expect(source).not.toMatch(/\?url|chrome|indexedDB|wxt|apps\/extension/);
  });
});
