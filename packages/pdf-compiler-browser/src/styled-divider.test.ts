import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf/browser";
import type { ExportBlock } from "@atlcli/confluence";
import { preparePdfDocument } from "../../pdf/src/prepare.js";
import { serializePdfDocument } from "../../pdf/src/serialize.js";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

describe("styled dividers (ADF Stage-0 rule / bodiedRule)", () => {
  let compiler: BrowserPdfCompiler;

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
    ]);
    compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
  }, 180_000);

  afterAll(async () => {
    await compiler?.reset();
  });

  it("compiles every line style, weight, color, and label alignment", async () => {
    const label = (text: string, alignment?: "center" | "end"): Extract<ExportBlock, { type: "paragraph" }> => ({
      type: "paragraph",
      content: [{ type: "text", text }],
      ...(alignment ? { presentation: { alignment } } : {}),
    });
    const blocks: ExportBlock[] = [
      { type: "divider" },
      ...(["solid", "dashed", "dotted", "sketch", "fade"] as const).map((style): ExportBlock => ({
        type: "divider",
        style,
        color: "#ff5630",
        weight: 2.5,
      })),
      { type: "divider", label: label("Start label") },
      { type: "divider", style: "dashed", label: label("Center label", "center") },
      { type: "divider", style: "fade", color: "#00b8d9", label: label("End label", "end") },
      {
        type: "divider",
        weight: 3,
        label: { type: "heading", level: 2, content: [{ type: "text", text: "Heading label" }] },
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Styled dividers",
        space: "DOCSY",
        version: 1,
        author: "test",
        exporter: "atlcli",
        language: "en",
        region: "US",
        exportedAt: new Date("2026-11-09T12:00:00Z"),
      },
    });
    const result = await compiler.compile(bundle);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.pdf?.byteLength).toBeGreaterThan(0);
  }, 120_000);
});
