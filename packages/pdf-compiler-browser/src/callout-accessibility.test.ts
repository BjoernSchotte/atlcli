import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  PDF_RUNTIME_ASSETS,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import {
  decorativeCalloutIcon,
  labelledCalloutIcon,
} from "../../pdf/src/callout-accessibility.js";
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

function source(iconExpression: string): PdfSourceBundle {
  return {
    main:
      `#set document(title: "Callout accessibility spike")\n` +
      `#set text(font: "Source Sans 3")\n` +
      `#${iconExpression}\n` +
      `#text("Warning")\n` +
      `#text("Body marker")\n`,
    template: "",
    assets: [],
    sourceMap: [],
    notes: [],
  };
}

describe("semantic callout PDF accessibility spikes", () => {
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

  it("excludes a decorative glyph from the structure tree", async () => {
    const result = await compiler.compile(
      source(decorativeCalloutIcon('[#text(font: "Noto Sans Symbols2", "⚠")]')),
    );
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const text = inspectable(result.pdf!);

    expect(text).toContain("/StructTreeRoot");
    expect(text).toContain("/Artifact");
    expect(text).not.toMatch(/\/S\s*\/Figure\b/);
  }, 120_000);

  it("can alternatively expose one labelled figure replacement", async () => {
    const result = await compiler.compile(
      source(labelledCalloutIcon('[#text(font: "Noto Sans Symbols2", "⚠")]', "Warning")),
    );
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const text = inspectable(result.pdf!);
    const figures = [...text.matchAll(/\/S\s*\/Figure\b/g)];

    expect(figures).toHaveLength(1);
    expect(text).toContain("/Alt (Warning)");
  }, 120_000);
});
