/**
 * Spec 011 (PDF/UA) — the accessibility reference page's claims, pinned.
 *
 * `src/content/docs/reference/pdf-accessibility.md` is a liability statement:
 * it tells readers exactly which accessibility properties an exported PDF has
 * and, just as importantly, which it does not. A documentation page cannot be
 * the source of truth for that — a template change could quietly falsify a
 * sentence nobody re-reads.
 *
 * So every affirmative claim on that page has a test here, asserted against
 * REAL compiled PDF bytes from the pinned compiler (same wasm, same bundled
 * fonts the CLI and browser hosts use). If a claim stops being true, this file
 * goes red and the page must be corrected in the same change.
 *
 * The last test is the important one: it pins the LIMIT of the alt-text claim.
 * When an author writes no alt text the exporter substitutes the filename, so
 * the file still carries a well-formed `/Alt` and a naive conformance checker
 * sees nothing wrong — while a screen reader announces "chart-final-v2.png".
 * That gap is why the `image-missing-alt` audit exists, and why the page
 * must not claim more than "alt-text pass-through".
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  validatePdfOutput,
  type ExportBlock,
  type PdfExportMetadata,
  type PdfProfile,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

// --- a real 1×1 RGBA PNG, built here so no fixture file can drift ------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 255, 0, 0, 255])))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

// --- compile + inspect -------------------------------------------------------

const METADATA: PdfExportMetadata = {
  title: "Accessibility claims",
  space: "DOCSY",
  language: "en",
  exportedAt: new Date("2026-07-19T00:00:00.000Z"),
};

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer());
}

let compiler: BrowserPdfCompiler;

async function compile(
  blocks: ExportBlock[],
  settings: object = {},
  profile?: PdfProfile
): Promise<Uint8Array> {
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => ({ bytes: tinyPng(), mediaType: "image/png" }),
  });
  const bundle = serializePdfDocument(prepared, {
    metadata: METADATA,
    settings,
    ...(profile ? { profile } : {}),
  });
  const result = await compiler.compile(bundle);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`fixture failed to compile: ${JSON.stringify(errors)}`);
  return result.pdf!;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Split the document into indirect objects, so an assertion can be scoped to
 * the object that owns a key rather than to the file as a whole. Several
 * claims below are only meaningful per-object (does THIS figure carry an
 * `/Alt`, does THIS font descriptor carry a font programme).
 */
function objectsOf(text: string): string[] {
  return [...text.matchAll(/\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g)].map((match) => match[1]!);
}

/**
 * The whole document as searchable text: the raw bytes plus every inflated
 * FlateDecode stream. Structure-tree content (where `/Alt` lives) is compressed,
 * so a raw byte scan alone would silently find nothing and every assertion
 * below would be vacuous.
 */
function inspectable(pdf: Uint8Array): string {
  const latin1 = new TextDecoder("latin1").decode(pdf);
  let text = latin1;
  const streams = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(latin1))) {
    const start = match.index + match[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      text += `\n${inflateSync(Buffer.from(pdf.subarray(start, end))).toString("latin1")}`;
    } catch {
      // Not a flate stream (or an image payload) — nothing to read here.
    }
  }
  return text;
}

const DOCUMENT: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Chapter One" }] },
  {
    type: "image",
    source: { kind: "attachment", filename: "pic.png" },
    alt: "A distinctive alt sentence",
  },
  { type: "heading", level: 2, content: [{ type: "text", text: "Sub" }] },
  { type: "paragraph", content: [{ type: "text", text: "Body copy." }] },
];

describe("PDF accessibility claims (spec 011 — pins the reference page)", () => {
  let text: string;
  let pdf: Uint8Array;

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    await ensureVendoredTypst();
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
    ]);
    compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
    pdf = await compile(DOCUMENT);
    text = inspectable(pdf);
  }, 180_000);

  it('CLAIM "Tagged PDF": the file carries a structure tree and is marked', () => {
    expect(text).toContain("/StructTreeRoot");
    expect(text).toContain("/MarkInfo");
    // `/MarkInfo` alone proves nothing — the dictionary can exist with
    // `/Marked false`. The page claims the content IS marked, so assert it.
    expect(/\/Marked\s+true/.test(text)).toBe(true);
    // Typst asserts its own tagging is not guesswork; a `/Suspects true` file
    // would mean the structure is present but untrustworthy.
    expect(text).toContain("/Suspects false");
  });

  it('CLAIM "document language": /Lang is in the catalog', () => {
    expect(validatePdfOutput(pdf).hasLang).toBe(true);
  });

  it('CLAIM "outline": PDF bookmarks are generated from headings', () => {
    expect(/\/Type\s*\/Outlines/.test(text)).toBe(true);
    expect((text.match(/\/Title\s*\(/g) ?? []).length).toBeGreaterThan(0);
  });

  it("the bookmark outline does NOT depend on the in-body table of contents", async () => {
    // `settings.outline` controls the rendered Contents PAGE. Readers reasonably
    // assume turning it off also removes PDF bookmarks — it does not, and the
    // reference page says so, so the distinction is pinned here.
    const withoutContentsPage = inspectable(await compile(DOCUMENT, { outline: false }));
    expect(/\/Type\s*\/Outlines/.test(withoutContentsPage)).toBe(true);
  }, 120_000);

  it('CLAIM "embedded fonts": EVERY font descriptor carries a font programme', () => {
    // `embeddedFontFiles > 0` (all validatePdfOutput enforces) would also pass
    // for a document with nine embedded fonts and one referenced-but-absent
    // one — which is exactly the case that breaks a reader without the font
    // installed. The page says "every font used is embedded", so check every
    // descriptor: a non-embedded font is a /FontDescriptor with no /FontFile*.
    const descriptors = objectsOf(text).filter((object) => /\/Type\s*\/FontDescriptor/.test(object));
    expect(descriptors.length).toBeGreaterThan(0);
    const unembedded = descriptors.filter((object) => !/\/FontFile(?:2|3)?\b/.test(object));
    expect(unembedded, `${unembedded.length} font descriptor(s) reference a non-embedded font`).toEqual([]);
    expect(validatePdfOutput(pdf).embeddedFontFiles).toBe(descriptors.length);
  });

  it('CLAIM "alt-text pass-through": author alt text reaches /Alt ON the /Figure element', () => {
    // Asserting `/Figure` and `/Alt (…)` both appear SOMEWHERE would pass even
    // if the alt text were attached to an unrelated element, so find the
    // figure's own structure-element object and read the /Alt out of it.
    const figures = objectsOf(text).filter((object) => /\/S\s*\/Figure\b/.test(object));
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatch(/\/Alt\s*\(A distinctive alt sentence\)/);
  });

  it("CLAIM: an export requested as pdf-ua-1 is byte-identical to a tagged one", async () => {
    // The page states this identity as a fact — that `profile` records what a
    // host asked for, never what was achieved. A future partial `pdf-ua-1`
    // implementation would silently falsify that sentence without this test.
    const [tagged, ua] = await Promise.all([
      compile(DOCUMENT, {}, "tagged"),
      compile(DOCUMENT, {}, "pdf-ua-1"),
    ]);
    expect(sha256Hex(ua)).toBe(sha256Hex(tagged));
    expect(inspectable(ua)).not.toContain("pdfuaid");
  }, 180_000);

  it("LIMIT of that claim: a missing alt becomes a filename, not an absent /Alt", async () => {
    // This is why `image-missing-alt` exists. The file looks conformant —
    // there IS an /Alt, so a checker that only tests for its presence passes —
    // while a screen reader reads out a build artifact's filename. The page
    // must therefore promise "pass-through", never "accessible alt text".
    const withoutAlt = await compile([
      { type: "heading", level: 1, content: [{ type: "text", text: "Chapter" }] },
      { type: "image", source: { kind: "attachment", filename: "chart-final-v2.png" } },
    ]);
    expect(inspectable(withoutAlt)).toContain("/Alt (chart-final-v2.png");
  }, 120_000);
});
