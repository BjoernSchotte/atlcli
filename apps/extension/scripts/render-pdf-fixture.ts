#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExportBlock } from "@atlcli/confluence/browser";
import { preparePdfDocument, serializePdfDocument } from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "../utils/pdf/compiler.js";
import { validatePdfOutput } from "../utils/pdf/validate.js";
import { ensurePdfFonts } from "../../../packages/pdf/scripts/ensure-fonts.js";

await ensurePdfFonts({ logger: () => {} });

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

const [wasm, ...fonts] = await Promise.all([
  packageBytes("@myriaddreamin/typst-ts-web-compiler/wasm"),
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
]);

const blocks: ExportBlock[] = [
  { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "A semantic PDF fixture with ", marks: ["italic"] },
      { type: "text", text: "strong text", marks: ["bold"] },
      { type: "text", text: ", links and a status. " },
      {
        type: "link",
        target: { kind: "external", href: "https://example.com/docs" },
        content: [{ type: "text", text: "Documentation" }],
      },
      { type: "text", text: " " },
      { type: "status", text: "READY", color: "#00875A" },
    ],
  },
  {
    type: "callout",
    kind: "info",
    title: "Built locally",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Compiler, template and fonts are packaged with the extension." }],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Lists and tasks" }] },
  {
    type: "list",
    ordered: false,
    items: [
      {
        checked: true,
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "PDF generated with enough breathing room for a multi-line item that carries real explanatory content." }],
        }],
      },
      {
        checked: false,
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Visual review confirms that adjacent list items remain distinct without looking disconnected." }],
        }],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Table" }] },
  {
    type: "table",
    columnWidths: [1, 1, 1, 1],
    rows: [
      {
        cells: [
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Capability" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Result" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "State" }] }] },
        ],
      },
      {
        cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Capability-/Reifegradbewertung (1)" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Enabled" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Team" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }] },
        ],
      },
      {
        cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Installation, configuration, and rollout planning (2)" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Active" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Team" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Planned" }] }] },
        ],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Code and diagram" }] },
  { type: "codeBlock", language: "typescript", code: "const format: 'pdf' | 'docx' = 'pdf';" },
  { type: "codeBlock", language: "mermaid", code: "flowchart LR\n  Page --> Blocks --> Typst --> PDF" },
  {
    type: "blockquote",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Word export remains a separate, unchanged path." }] }],
  },
  ...Array.from({ length: 18 }, (_, index): ExportBlock => ({
    type: "paragraph",
    content: [{ type: "text", text: `Fixture paragraph ${index + 1}. ` + "Readable pagination and running headers. ".repeat(8) }],
  })),
];

const prepared = await preparePdfDocument(blocks, {
  resolve: async () => {
    throw new Error("fixture has no attachment images");
  },
});
const bundle = serializePdfDocument(prepared, {
  metadata: {
    title: "atlcli PDF export fixture",
    space: "DOCSY",
    version: 1,
    author: "atlcli",
    exporter: "atlcli",
    language: "de",
    region: "DE",
    exportedAt: new Date("2026-07-16T12:00:00Z"),
  },
});
const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
const started = performance.now();
const result = await compiler.compile(bundle);
const compileMs = performance.now() - started;
if (!result.pdf) throw new Error(JSON.stringify(result.diagnostics, null, 2));
const inspection = validatePdfOutput(result.pdf);
const outputDir = join(import.meta.dir, "..", "..", "..", "tmp", "pdfs");
mkdirSync(outputDir, { recursive: true });
const outputPath = process.argv[2] ?? join(outputDir, "pdf-export-feature-zoo.pdf");
await Bun.write(outputPath, result.pdf);
console.log(JSON.stringify({ outputPath, bytes: result.pdf.byteLength, compileMs, ...inspection }, null, 2));
