import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  CONFLUENCE_LEGACY_EMOJI_PROJECTIONS,
} from "@atlcli/confluence";
import {
  PDF_RUNTIME_ASSETS,
  validatePdfOutput,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE } from "@atlcli/pdf/template";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { BrowserPdfCompiler } from "./index.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

function bundle(main: string): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap: [], notes: [] };
}

describe("legacy emoji projection PDF font coverage", () => {
  it("compiles every canonical projection with the pinned symbol and emoji fonts", async () => {
    const fonts = await Promise.all(
      PDF_RUNTIME_ASSETS.fonts.map((font) =>
        packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
      )
    );
    const wasm = await packageBytes("@atlcli/pdf-compiler-browser/wasm");
    const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
    const rows = Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS)
      .map(({ canonicalName, text }) => `${canonicalName}: ${text}`)
      .join("\n\n");
    const source = String.raw`
#import "/atlcli.typ": *
#set page(width: 210mm, height: auto, margin: 15mm)
#set text(font: ("Source Sans 3", "Noto Sans Symbols2", "Noto Emoji"), size: 11pt)
= Legacy emoji projection coverage
${rows}
`;

    try {
      const result = await compiler.compile(bundle(source));
      expect(result.diagnostics).toEqual([]);
      expect(result.pdf).toBeDefined();
      expect(validatePdfOutput(result.pdf!)).toMatchObject({
        pageCount: 1,
        tagged: true,
      });
      expect((await compiler.getLoadedFonts()).join("\n")).toContain("Noto Sans Symbols2");
      expect((await compiler.getLoadedFonts()).join("\n")).toContain("Noto Emoji");
    } finally {
      await compiler.reset();
    }
  }, 30_000);
});
