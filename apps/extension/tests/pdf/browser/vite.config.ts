import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import type { ExportBlock, PdfExportMetadata } from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "../../../../../packages/pdf-compiler-browser/src/compiler.js";
import { ATLCLI_TYPST_TEMPLATE } from "../../../../../packages/pdf/src/template.js";
import { preparePdfDocument } from "../../../../../packages/pdf/src/prepare.js";
import { serializePdfDocument } from "../../../../../packages/pdf/src/serialize.js";

const VIRTUAL_ID = "virtual:preview-link-pdf";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await readFile(fileURLToPath(resolved)));
}

async function compileLinkFixture(): Promise<Uint8Array> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-It.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Semibold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSans3-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-It.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceSerif4-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceCodePro-Regular.ttf"),
    packageBytes("@atlcli/pdf/fonts/SourceCodePro-Bold.ttf"),
    packageBytes("@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf"),
  ]);
  const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
  const blocks: ExportBlock[] = [
    { type: "heading", level: 1, content: [{ type: "text", text: "Preview links" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "anchor", anchor: "chapter-two" },
          content: [{ type: "text", text: "Open chapter two" }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "external", href: "https://example.com/docs" },
          content: [{ type: "text", text: "External documentation" }],
        },
      ],
    },
    { type: "pageBreak" },
    { type: "anchor", name: "chapter-two" },
    { type: "heading", level: 1, content: [{ type: "text", text: "Chapter two" }] },
  ];
  const metadata: PdfExportMetadata = {
    title: "Preview link fixture",
    space: "DOCSY",
    version: 1,
    author: "Playwright",
    exporter: "atlcli extension viewer harness",
    exportedAt: new Date("2026-07-22T10:00:00.000Z"),
  };
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => {
      throw new Error("The link fixture has no assets.");
    },
  });
  const bundle = serializePdfDocument(prepared, {
    metadata,
    settings: { cover: false, outline: false },
  });
  const result = await compiler.compile({ ...bundle, template: ATLCLI_TYPST_TEMPLATE });
  if (!result.pdf) {
    throw new Error(`Link fixture failed to compile: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.pdf;
}

function fixturePlugin(bytes: Uint8Array): Plugin {
  const base64 = Buffer.from(bytes).toString("base64");
  return {
    name: "preview-link-pdf-fixture",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },
    load(id) {
      return id === RESOLVED_VIRTUAL_ID
        ? `export const PDF_BYTES_BASE64 = ${JSON.stringify(base64)};`
        : null;
    },
  };
}

export default defineConfig(async () => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: { conditions: ["development", "browser"] },
  plugins: [fixturePlugin(await compileLinkFixture())],
  build: { target: "es2022", assetsInlineLimit: 0 },
}));
