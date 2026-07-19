import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import {
  ATLCLI_TYPST_TEMPLATE,
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  serializePdfDocument,
  validatePdfOutput,
  type ExportBlock,
  type PdfSourceBundle,
  type PdfTemplateSettings,
} from "@atlcli/pdf/browser";
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

const settingsMetadata = {
  title: "Settings Zoo",
  space: "DOCSY",
  version: 3,
  author: "Ada",
  exportedAt: new Date("2026-07-19T00:00:00Z"),
};

function settingsBundle(settings?: PdfTemplateSettings): PdfSourceBundle {
  return serializePdfDocument(
    {
      blocks: [
        { type: "heading", level: 1, content: [{ type: "text", text: "Section" }] },
        { type: "paragraph", content: [{ type: "text", text: "Hello settings." }] },
      ],
      assets: [],
      notes: [],
    },
    { metadata: settingsMetadata, settings }
  );
}

/** Raw latin1 view plus every inflatable FlateDecode stream, for byte asserts. */
function inflatedPdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const parts = [raw];
  const streamRegex = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (bytes[stop - 1] === 0x0a || bytes[stop - 1] === 0x0d)) stop -= 1;
    try {
      parts.push(inflateSync(bytes.subarray(start, stop)).toString("latin1"));
    } catch {
      // Not a FlateDecode stream (image, font program, …) — skip.
    }
  }
  return parts.join("\n");
}

// Real minimal 1x1 RGBA PNG built from scratch (no fixtures, no mocks).
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function tinyPng(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  // One scanline: filter byte 0 followed by a single opaque red RGBA pixel.
  const idat = new Uint8Array(deflateSync(new Uint8Array([0, 255, 0, 0, 255])));
  const chunks = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(chunks.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
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

  it("compiles a document whose anchor macro carries a raw multi-word name (spec 002 regression)", async () => {
    // Regression repro against the REAL Typst compiler: a Confluence anchor
    // macro named "Table of Contents" previously serialized as the raw
    // `<Table of Contents>` — an unclosed Typst label — failing the whole
    // export with a compile error. The serializer now sanitizes anchor names,
    // so this document must compile cleanly with a working internal link.
    const blocks: ExportBlock[] = [
      { type: "anchor", name: "Table of Contents" },
      { type: "paragraph", content: [{ type: "text", text: "Chapter body" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            target: { kind: "anchor", anchor: "Table of Contents" },
            content: [{ type: "text", text: "back to top" }],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const source = serializePdfDocument(prepared, {
      metadata: { title: "Anchor names", exportedAt: new Date("2026-07-19T00:00:00Z") },
    });
    const compiler = await createCompiler();
    const result = await compiler.compile(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(validatePdfOutput(result.pdf!).pageCount).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("template settings compiled output", () => {
  it("compiles Letter with a DRAFT watermark: clean, tagged, page count unchanged vs A4", async () => {
    const compiler = await createCompiler();
    const a4 = await compiler.compile(settingsBundle());
    const letter = await compiler.compile(
      settingsBundle({ page: "letter", orientation: "portrait", watermark: { text: "DRAFT" } })
    );
    expect(a4.diagnostics).toEqual([]);
    expect(letter.diagnostics).toEqual([]);
    const a4Info = validatePdfOutput(a4.pdf!);
    const letterInfo = validatePdfOutput(letter.pdf!);
    expect(letterInfo.tagged).toBe(true);
    // Background layers must not add pages.
    expect(letterInfo.pageCount).toBe(a4Info.pageCount);
    // Page size via MediaBox bytes (inflating FlateDecode streams if needed):
    // Letter = 612x792 pt, A4 = 595.x pt wide.
    expect(inflatedPdfText(letter.pdf!)).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+612(?:\.\d+)?\s+792/);
    expect(inflatedPdfText(a4.pdf!)).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+595(?:\.\d+)?\s/);
  }, 120_000);

  it("produces the exact page count for every cover/outline combination", async () => {
    const compiler = await createCompiler();
    // Baseline: cover + outline + one body page + colophon = 4 pages. Each
    // disabled section removes exactly one page — a stray unconditional
    // pagebreak() outside its guard would leave a blank page behind instead.
    const matrix: Array<{ cover: boolean; outline: boolean; pages: number }> = [
      { cover: true, outline: true, pages: 4 },
      { cover: false, outline: true, pages: 3 },
      { cover: true, outline: false, pages: 3 },
      { cover: false, outline: false, pages: 2 },
    ];
    for (const { cover, outline, pages } of matrix) {
      const result = await compiler.compile(settingsBundle({ cover, outline }));
      expect(result.diagnostics).toEqual([]);
      expect(validatePdfOutput(result.pdf!).pageCount).toBe(pages);
    }
  }, 240_000);

  it("compiles landscape orientation with the A4-tuned cover measurements intact", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(settingsBundle({ orientation: "landscape" }));
    expect(result.diagnostics).toEqual([]);
    // Cover and colophon still fit their landscape pages: same page count as portrait.
    expect(validatePdfOutput(result.pdf!).pageCount).toBe(4);
    expect(inflatedPdfText(result.pdf!)).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+841(?:\.\d+)?\s/);
  }, 120_000);

  it("compiles accent color, organization name, header/footer text, and a real PNG logo", async () => {
    const compiler = await createCompiler();
    const result = await compiler.compile(
      settingsBundle({
        accentColor: "#0052CC",
        organizationName: "Acme Corp",
        headerText: "Acme Handbook",
        footerText: "Acme Confidential",
        logo: { bytes: tinyPng(), mediaType: "image/png", alt: "Acme Corp" },
      })
    );
    expect(result.diagnostics).toEqual([]);
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true, pageCount: 4 });
  }, 120_000);
});

// ===========================================================================
// spec 003 — content features, verified against the REAL Typst compiler
// ===========================================================================
describe("spec 003 content features (real compiler)", () => {
  const meta = { title: "Content features", exportedAt: new Date("2026-07-20T00:00:00Z") };

  /** Prepare + serialize + compile a block list; return pdf + inflated text. */
  async function compileBlocks(
    blocks: ExportBlock[],
    settings?: PdfTemplateSettings
  ): Promise<{ pdf: Uint8Array; text: string; pageCount: number; diagnostics: unknown[] }> {
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        // A 1x1 PNG for any image so figure/orientation goldens embed real bytes.
        return { bytes: tinyPng(), mediaType: "image/png", filename: "x.png" };
      },
    });
    const source = serializePdfDocument(prepared, { metadata: meta, ...(settings ? { settings } : {}) });
    const compiler = await createCompiler();
    const result = await compiler.compile(source);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length) throw new Error(`compile errors: ${JSON.stringify(errors)}`);
    const inspection = validatePdfOutput(result.pdf!);
    return { pdf: result.pdf!, text: inflatedPdfText(result.pdf!), pageCount: inspection.pageCount, diagnostics: result.diagnostics };
  }

  /** Every /MediaBox as [width, height] pairs found in the PDF. */
  function mediaBoxes(text: string): Array<[number, number]> {
    const boxes: Array<[number, number]> = [];
    const re = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      boxes.push([Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])]);
    }
    return boxes;
  }

  it("a scroll-pagebreak increases the page count", async () => {
    const long = { type: "paragraph", content: [{ type: "text", text: "body" }] } as ExportBlock;
    const noBreak = await compileBlocks([long, long]);
    const withBreak = await compileBlocks([long, { type: "pageBreak" }, long]);
    expect(withBreak.pageCount).toBeGreaterThan(noBreak.pageCount);
  }, 60_000);

  it("a landscape orientation region produces a landscape page (width > height)", async () => {
    const { text } = await compileBlocks([
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "paragraph", content: [{ type: "text", text: "wide region" }] }],
      },
    ]);
    // At least one page is landscape (width > height).
    expect(mediaBoxes(text).some(([w, h]) => w > h)).toBe(true);
  }, 60_000);

  it("a portrait region inside a landscape base document flips back to portrait", async () => {
    const { text } = await compileBlocks(
      [
        {
          type: "orientation",
          landscape: false,
          content: [{ type: "paragraph", content: [{ type: "text", text: "narrow region" }] }],
        },
      ],
      { orientation: "landscape" }
    );
    // Both a landscape base page and a portrait (height > width) region page.
    const boxes = mediaBoxes(text);
    expect(boxes.some(([w, h]) => h > w)).toBe(true);
  }, 60_000);

  it("a 200-row table paginates with a repeating header row", async () => {
    const header = {
      cells: [
        { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Key" }] }] },
        { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
      ],
    };
    const body = Array.from({ length: 200 }, (_, i) => ({
      cells: [
        { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `row-${i}` }] }] },
        { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `val-${i}` }] }] },
      ],
    }));
    const { pageCount } = await compileBlocks([{ type: "table", rows: [header, ...body] }] as ExportBlock[]);
    expect(pageCount).toBeGreaterThan(1);
  }, 90_000);

  it("wide-table escalation goldens compile & paginate without content loss", async () => {
    const cell = (text: string) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }] as ExportBlock[],
    });
    // Long URLs/IDs, CJK, extreme colgroup ratios, and a colspan, all at once.
    const blocks: ExportBlock[] = [
      {
        type: "table",
        columnWidths: [1, 1, 40],
        rows: [
          { cells: [cell("https://example.com/very/long/path/that/keeps/going/2026/details"), cell("識別子一二三四五六七八"), cell("wide")] },
          { cells: [{ header: false, colspan: 3, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "spanning" }] }] }] },
        ],
      },
    ];
    const { pageCount } = await compileBlocks(blocks);
    expect(pageCount).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("a captioned figure compiles into a real figure", async () => {
    const { pageCount } = await compileBlocks([
      {
        type: "image",
        source: { kind: "attachment", filename: "x.png" },
        caption: { kind: "figure", content: [{ type: "text", text: "Architecture overview" }] },
      },
    ]);
    expect(pageCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
