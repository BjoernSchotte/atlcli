import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
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

function inspectable(pdf: Uint8Array): string {
  const latin1 = new TextDecoder("latin1").decode(pdf);
  let text = latin1;
  const streams = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(latin1))) {
    const start = match.index + match[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (pdf[stop - 1] === 0x0a || pdf[stop - 1] === 0x0d)) stop -= 1;
    try {
      text += `\n${inflateSync(pdf.subarray(start, stop)).toString("latin1")}`;
    } catch {
      // Font and image streams are not FlateDecode text streams.
    }
  }
  return text;
}

describe("semantic callout PDF accessibility", () => {
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

  it("compiles every production semantic callout as one labelled figure", async () => {
    const kinds = ["info", "note", "warning", "tip", "success", "error"] as const;
    const blocks: ExportBlock[] = kinds.map((kind) => ({
      type: "callout",
      kind,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: `${kind} body` }],
      }],
    }));
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Semantic callouts",
        space: "DOCSY",
        version: 1,
        author: "P1 test",
        exporter: "atlcli",
        language: "en",
        region: "US",
        exportedAt: new Date("2026-07-24T12:00:00Z"),
      },
    });
    const result = await compiler.compile(bundle);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const text = inspectable(result.pdf!);
    expect([...text.matchAll(/\/S\s*\/Figure\b/g)]).toHaveLength(6);
    for (const label of ["Info", "Note", "Warning", "Tip", "Success", "Error"]) {
      expect(text).toMatch(new RegExp(`/Alt\\s*\\(${label}\\)`, "u"));
    }
  }, 120_000);
});
