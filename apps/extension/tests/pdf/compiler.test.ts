import { beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  ATLCLI_TYPST_TEMPLATE,
  preparePdfDocument,
  serializePdfDocument,
} from "@atlcli/pdf/browser";
import { BrowserPdfCompiler, formatPdfDiagnostics } from "../../utils/pdf/compiler.js";
import { validatePdfOutput } from "../../utils/pdf/validate.js";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";

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
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

function sourceBundle(main: string): PdfSourceBundle {
  return { main, template: ATLCLI_TYPST_TEMPLATE, assets: [], sourceMap: [], notes: [] };
}

function anonymousText(length: number, special: Record<number, string> = {}): string {
  const characters = Array<string>(length).fill("x");
  for (const [offset, value] of Object.entries(special)) characters[Number(offset)] = value;
  return characters.join("");
}

const DENSE_TABLE_LINK =
  "https://docs.example.com/platform/integration/deployment-guide?environment=staging&source=pdf-test";
const CUSTOM_LABEL_LINK = "https://docs.example.com/platform/overview";

function denseTableFixture(): ExportBlock {
  const cell = (text: string, header = false) => ({
    header,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
  });
  return {
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
        ].map((text) => cell(text, true)),
      },
      {
        cells: [
          cell("20 May 2026 12:00"),
          cell("Integration gateway"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "DEPLOYMENT BLOCKED", color: "#DE350B" }] }],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "READY FOR RELEASE", color: "#00875A" }] }],
          },
          cell("Normal prose keeps natural word wrapping in narrow columns without turning every token into an atom."),
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
            content: [{ type: "paragraph", content: [{ type: "mention", accountId: "synthetic:account-123456789", displayName: "Alex Example" }] }],
          },
          cell("1.13.1"),
          cell("development"),
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "WAITING FOR REVIEW", color: "#FF991F" }] }],
          },
          cell("No forced clipping"),
          cell("-"),
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
                    target: { kind: "external", href: CUSTOM_LABEL_LINK },
                    content: [{ type: "text", text: "Deployment guide" }],
                  },
                ],
              },
            ],
          },
          cell("Synthetic fixture"),
        ],
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        cells: [
          cell(`D${index + 1}`),
          cell(`S${index + 1}`),
          cell("ON"),
          cell("LOW"),
          cell("Text"),
          cell("Ref"),
          cell("Team"),
          cell(`1.14.${index}`),
          cell("main"),
          cell("OK"),
          cell("Ja"),
          cell("Test"),
          cell("Guide"),
          cell("OK"),
        ],
      })),
    ],
  };
}

function extractPdfText(pdf: Uint8Array): string | null {
  const pdftotext = Bun.which("pdftotext");
  if (!pdftotext) return null;
  const result = spawnSync(pdftotext, ["-raw", "-", "-"], {
    input: pdf,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pdftotext failed: ${result.stderr.trim()}`);
  return result.stdout;
}

describe("BrowserPdfCompiler", () => {
  it("maps a Typst source range back to its nested content path", () => {
    expect(
      formatPdfDiagnostics(
        [{ package: "", path: "/main.typ", severity: "error", range: "27:5-27:6", message: "bad content" }],
        [
          {
            blockPath: "blocks[2].content[0]",
            blockType: "paragraph",
            startLine: 25,
            startColumn: 1,
            endLine: 29,
            endColumn: 80,
          },
        ]
      )
    ).toBe("blocks[2].content[0]: error: bad content");
  });

  it("registers every pinned PDF font with the compiler", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(
      sourceBundle(
        `#set text(font: "Source Serif 4")\n#text(weight: "semibold")[Semibold] #text(weight: "bold")[Bold] #emph[Italic]\n#text(font: "Source Sans 3")[Sans #text(weight: "bold")[Bold] #emph[Italic]]\n#text(font: "Source Code Pro")[Code #text(weight: "bold")[Bold]]`
      )
    );
    expect(result.diagnostics).toEqual([]);
    const fonts = await compiler.getLoadedFonts();
    expect(fonts.length).toBeGreaterThanOrEqual(3);
    expect(fonts.join("\n")).toContain("Source Serif 4");
    expect(fonts.join("\n")).toContain("Source Sans 3");
    expect(fonts.join("\n")).toContain("Source Code Pro");
  }, 30_000);

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
    expect(new TextDecoder().decode(result.pdf)).toContain("https://atlcli.sh/");
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true, hasOutline: true });
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
        type: "list",
        ordered: false,
        items: [
          {
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Editorial marker" }] },
              {
                type: "list",
                ordered: false,
                items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "Nested marker" }] }] }],
              },
            ],
          },
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "Numbered item" }] }] }],
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

  it("compiles narrow German table cells with explicit hyphenation", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        columnWidths: [1, 1, 1, 1],
        rows: [
          {
            cells: [
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Aktivität" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Team" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] },
              { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "State" }] }] },
            ],
          },
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Capability-/Reifegradbewertung (1)" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Table wrapping regression",
        language: "de",
        region: "DE",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle);
    const repeat = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(repeat.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(repeat.pdf).toEqual(result.pdf);
  }, 30_000);

  it("compiles a dense table without losing prose, status labels, or the full link target", async () => {
    const prepared = await preparePdfDocument([denseTableFixture()], {
      resolve: async () => { throw new Error("no assets in fixture"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Dense table regression",
        language: "en",
        region: "US",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
    const inspection = validatePdfOutput(result.pdf!);
    expect(inspection.tagged).toBe(true);
    expect(inspection.pageCount).toBeGreaterThan(4);
    expect(inspection.embeddedFontFiles).toBeGreaterThanOrEqual(3);

    const pdfSource = new TextDecoder("latin1").decode(result.pdf);
    expect(pdfSource).toContain(`/URI (${DENSE_TABLE_LINK})`);
    expect(pdfSource).toContain(`/URI (${CUSTOM_LABEL_LINK})`);
    expect(pdfSource).toMatch(/SourceCodePro-Bold/);

    expect(bundle.main).toContain("Normal prose keeps natural word wrapping");
    expect(bundle.main).toContain("DEPLOYMENT BLOCKED");
    expect(bundle.main).toContain("Alex Example");
    const extracted = extractPdfText(result.pdf!);
    if (extracted !== null) {
      const extractedCompact = extracted
        .replaceAll("\u00ad", "")
        .replaceAll("\u200b", "")
        .replace(/\s+/g, "");
      expect(extractedCompact).toContain("prosekeeps");
      expect(extractedCompact).toContain("naturalwordwrapping");
      expect(extractedCompact).toContain("DEPLOYMENTBLOCKED");
      expect(extractedCompact).toContain("READYFORRELEASE");
      expect(extractedCompact).toContain("WAITINGFORREVIEW");
      expect(extractedCompact).toContain("AlexExample");
      expect(extractedCompact).toContain("docs.example.com");
      expect(extractedCompact).toContain("Deploymentguide");
      expect(extractedCompact.match(/Updated/g)?.length ?? 0).toBeGreaterThan(1);
    }

    const repeat = await compiler.compile(bundle);
    expect(repeat.diagnostics).toEqual([]);
    expect(repeat.pdf).toEqual(result.pdf);
  }, 30_000);

  it("compiles literal office-style text safely inside lists and tables", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: false,
        items: [
          {
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", marks: ["bold"], text: anonymousText(38, { 16: "&", 24: "-", 37: ":" }) },
                  { type: "text", text: anonymousText(23, { 0: "\u00a0", 22: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(27, { 9: "-", 14: "-" }) },
                  { type: "text", text: anonymousText(52, { 0: "\u00a0", 1: "—", 51: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(15, { 5: "-" }) },
                  { type: "text", text: anonymousText(71, { 0: ".", 64: ":", 70: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(20) },
                  { type: "text", text: anonymousText(43, { 0: "(", 8: "/", 37: ")", 42: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(23, { 8: "-" }) },
                  { type: "text", text: anonymousText(113, { 0: ".", 48: "—", 65: ",", 112: "\u00a0" }) },
                  { type: "text", marks: ["bold"], text: anonymousText(17, { 5: "-" }) },
                  {
                    type: "text",
                    text: anonymousText(162, {
                      0: "\u00a0",
                      27: ".",
                      121: "-",
                      130: "-",
                      131: "/",
                      136: "-",
                      144: "-",
                      152: "-",
                      161: ".",
                    }),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                header: false,
                colspan: 1,
                rowspan: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: anonymousText(32, { 10: "-", 11: "/", 19: "-", 30: "+", 31: "\u00a0" }),
                      },
                      { type: "text", marks: ["bold"], text: anonymousText(13, { 3: "-" }) },
                      { type: "text", text: anonymousText(25, { 0: "(", 3: "/", 6: ",", 24: ")" }) },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("no assets in fixture");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Literal text regression",
        exporter: "atlcli",
        exportedAt: new Date("2026-07-16T12:00:00Z"),
      },
    });
    const compiler = await createCompiler();
    const result = await compiler.compile(bundle);

    expect(result.diagnostics).toEqual([]);
    expect(result.pdf).toBeDefined();
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

  it("produces byte-identical output on a warm repeat compile", async () => {
    const compiler = await createCompiler();
    const bundle = sourceBundle("= Deterministic\n\nSame source, same PDF.");
    const first = await compiler.compile(bundle);
    const second = await compiler.compile(bundle);
    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(second.pdf).toEqual(first.pdf);
  }, 30_000);
});
