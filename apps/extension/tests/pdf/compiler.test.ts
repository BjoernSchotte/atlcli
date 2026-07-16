import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  ATLCLI_TYPST_TEMPLATE,
  preparePdfDocument,
  serializePdfDocument,
} from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "../../utils/pdf/compiler.js";

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, inter, mono] = await Promise.all([
    packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm"),
    packageBytes("@atlcli/docx/fonts/Inter-Regular.ttf"),
    packageBytes("@atlcli/docx/fonts/JetBrainsMono-Regular.ttf"),
  ]);
  return new BrowserPdfCompiler({ wasm, fonts: [inter, mono] });
}

function sourceBundle(main: string): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap: [], notes: [] };
}

describe("BrowserPdfCompiler", () => {
  it("compiles a real PDF with the bundled template and fonts", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(
      sourceBundle(String.raw`#import "atlcli.typ": atlcli-doc, callout, status-badge
#show: atlcli-doc.with(meta: (
  title: "Compiler smoke",
  space: "DOCSY",
  version: "v1",
  author: "atlcli",
  exporter: "atlcli",
  exported-at: datetime(year: 2026, month: 7, day: 16),
  exported-label: "2026-07-16",
))
= Hello
This is a real PDF.
`)
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
    expect(result.pdf?.byteLength).toBeGreaterThan(1_000);
  }, 30_000);

  it("returns structured diagnostics for invalid Typst", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(sourceBundle("#this-function-does-not-exist()"));
    expect(result.pdf).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.path).toContain("main.typ");
  }, 30_000);

  it("compiles the generated semantic block source", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A bold statement", marks: ["bold"] },
          { type: "lineBreak" },
          { type: "status", text: "DONE", color: "#00875A" },
        ],
      },
      {
        type: "callout",
        kind: "info",
        title: "Context",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Read me" }] }],
      },
      {
        type: "list",
        ordered: false,
        items: [
          { checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }] },
        ],
      },
      {
        type: "table",
        rows: [
          { cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }] }] },
          { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] }] },
        ],
      },
      { type: "codeBlock", language: "javascript", code: "const answer = 42;" },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no image in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Generated PDF",
        space: "DOCSY",
        version: 1,
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
  }, 30_000);

  it("initializes and compiles when dynamic Function construction is blocked", async () => {
    const original = globalThis.Function;
    const blocked = new Proxy(original, {
      construct() {
        throw new Error("dynamic Function construction is forbidden by MV3 CSP");
      },
      apply() {
        throw new Error("dynamic Function construction is forbidden by MV3 CSP");
      },
    });
    Object.defineProperty(globalThis, "Function", { configurable: true, value: blocked });
    try {
      const compiler = await createCompiler();
      const result = await compiler.compile(sourceBundle("= CSP-safe\n\nNo unsafe eval."));
      expect(result.diagnostics).toEqual([]);
      expect(new TextDecoder().decode(result.pdf?.slice(0, 8))).toStartWith("%PDF-");
    } finally {
      Object.defineProperty(globalThis, "Function", { configurable: true, value: original });
    }
  }, 30_000);
});
