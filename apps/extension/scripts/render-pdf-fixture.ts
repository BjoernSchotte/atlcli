#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExportBlock } from "@atlcli/confluence/browser";
import { preparePdfDocument, serializePdfDocument } from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "../utils/pdf/compiler.js";
import { validatePdfOutput } from "../utils/pdf/validate.js";
import { ensurePdfFonts } from "../../../packages/pdf/scripts/ensure-fonts.js";

type ExportTableCell = Extract<ExportBlock, { type: "table" }>["rows"][number]["cells"][number];

const DENSE_TABLE_LINK =
  "https://docs.example.com/platform/integration/deployment-guide?environment=staging&source=pdf-fixture";
const CUSTOM_LABEL_LINK = "https://docs.example.com/platform/overview";

function textCell(text: string, header = false): ExportTableCell {
  return {
    header,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function statusCell(text: string, color: string): ExportTableCell {
  return {
    header: false,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "status", text, color }] }],
  };
}

function linkCell(label: string, href: string): ExportTableCell {
  return {
    header: false,
    colspan: 1,
    rowspan: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "link", target: { kind: "external", href }, content: [{ type: "text", text: label }] }],
      },
    ],
  };
}

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
  { type: "heading", level: 3, content: [{ type: "text", text: "Narrow-track table" }] },
  {
    type: "table",
    columnWidths: [1, 1, 0.75, 2, 2, 2, 2],
    rows: [
      {
        cells: ["Level", "Type", "Impact", "Description", "Operations", "Timing", "Decision"]
          .map((text) => textCell(text, true)),
      },
      {
        cells: [
          textCell("3"),
          textCell("Scheduled review"),
          textCell("Moderate / Severe"),
          textCell("Cross-team dependency coordination"),
          textCell("Architecture and platform alignment"),
          textCell("Verification before rollout"),
          textCell("Approval required"),
        ],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Narrow status track" }] },
  {
    type: "table",
    columnWidths: [1.2, 0.45, 2.1, 3.5, 1.2, 0.7],
    rows: [
      {
        cells: ["Recorded", "State", "Summary", "Notes", "Owner", "Length"]
          .map((text) => textCell(text, true)),
      },
      {
        cells: [
          textCell("2032-02-29"),
          statusCell("PASS", "green"),
          textCell("Synthetic review"),
          textCell("Width-aware badge regression"),
          textCell("Team"),
          textCell("4 min"),
        ],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Merged section table" }] },
  {
    type: "table",
    columnWidths: [1, 2, 2, 1],
    rows: [
      {
        cells: ["Key", "Scope", "Cadence", "Owner"].map((text) => textCell(text, true)),
      },
      {
        cells: [
          { ...textCell("Vertical"), rowspan: 2 },
          { ...textCell("Upper span"), colspan: 2 },
          textCell("Team"),
        ],
      },
      {
        cells: [{ ...textCell("Lower span"), colspan: 3 }],
      },
      {
        cells: [{
          ...textCell("Synthetic section", true),
          colspan: 4,
          backgroundColor: "#8994A9",
          content: [{
            type: "paragraph",
            content: [{
              type: "text",
              text: "Synthetic section",
              marks: ["bold"],
              color: "#172B4D",
            }],
          }],
        }],
      },
      {
        cells: [textCell("B"), textCell("Local"), textCell("Weekly"), textCell("Team")],
      },
    ],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Dense table" }] },
  {
    type: "table",
    columnWidths: Array<number>(14).fill(1),
    rows: [
      {
        cells: [
          "Updated",
          "Component",
          "Stage",
          "Priority",
          "Description",
          "Reference",
          "Owner",
          "Release",
          "Branch",
          "Review",
          "Fallback",
          "Notes",
          "Guide",
          "Result",
        ].map((text) => textCell(text, true)),
      },
      {
        cells: [
          textCell("2031-12-31 23:59"),
          textCell("Integration gateway"),
          statusCell("SYNCHRONIZED", "#DE350B"),
          statusCell("READY FOR RELEASE", "#00875A"),
          textCell("Normal prose keeps natural word wrapping in narrow columns without turning every token into an atom."),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "link",
                    target: { kind: "external", href: DENSE_TABLE_LINK },
                    content: [{ type: "text", text: DENSE_TABLE_LINK }],
                  },
                ],
              },
            ],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "mention", accountId: "synthetic:account-123456789", displayName: "Alexanderson Exampleton" }] }],
          },
          textCell("1.13.1"),
          textCell("development"),
          statusCell("WAITING FOR REVIEW", "#FF991F"),
          textCell("AlphabeticOverflowGuard"),
          textCell("-"),
          linkCell("Deployment guide", CUSTOM_LABEL_LINK),
          textCell("Synthetic fixture"),
        ],
      },
      {
        cells: [
          textCell("21 May 2026 09:30"),
          textCell("Event processor"),
          statusCell("IN PROGRESS", "#0052CC"),
          statusCell("NORMAL", "#42526E"),
          textCell("Ordinary descriptive sentences continue to wrap at meaningful word boundaries in dense mode."),
          linkCell("Custom link labels stay readable", CUSTOM_LABEL_LINK),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "mention", accountId: "synthetic:user-1234567890-abcdef" }] }],
          },
          textCell("1.13.2"),
          textCell("release-candidate"),
          statusCell("APPROVED", "#00875A"),
          textCell("Full cell content remains available"),
          textCell("REF-1234567890, TASK-9876543210 alphaomegaworkflow-beta"),
          linkCell("portal.example.invalid", CUSTOM_LABEL_LINK),
          textCell("Verified"),
        ],
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        cells: [
          textCell(`D${index + 1}`),
          textCell(`S${index + 1}`),
          textCell("ON"),
          textCell("LOW"),
          textCell("Text"),
          textCell("Ref"),
          textCell("Team"),
          textCell(`1.14.${index}`),
          textCell("main"),
          textCell("OK"),
          textCell("Ja"),
          textCell("Test"),
          textCell("Guide"),
          textCell("OK"),
        ],
      })),
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
