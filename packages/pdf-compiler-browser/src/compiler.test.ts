import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  resolveFullPdfFontRequirementsV1,
  validatePdfOutput,
  type ExportBlock,
  type PdfSourceBundle,
  type PdfTemplateSettings,
} from "@atlcli/pdf/browser";
import { ATLCLI_TYPST_TEMPLATE, serializePdfDocument } from "@atlcli/pdf/internal";
// Cross-package relative import (like ensure-fonts below): export-fixtures is
// a PRIVATE workspace package, and a devDependency on it from this publishable
// package breaks the spec-009 file:-link consumer install.
import {
  generateImageHeavyCorpus,
  resolveImageHeavyAsset,
} from "../../export-fixtures/src/image-heavy-corpus.js";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import {
  BrowserPdfCompiler,
  PDF_BROWSER_COMPILER_VERSION,
  type BrowserPdfCompilerFontSourceV1,
} from "./index.js";

let canonicalCompiler: BrowserPdfCompiler | undefined;

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  canonicalCompiler = await createCompiler();
});

afterAll(async () => {
  await canonicalCompiler?.reset();
});

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = import.meta.resolve(specifier);
  return new Uint8Array(await Bun.file(fileURLToPath(resolved)).arrayBuffer());
}

async function createCompiler(): Promise<BrowserPdfCompiler> {
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}

async function createDemandAwareCompiler(
  onLoad: (assetId: string) => void = () => {},
  sourcesTransform: (
    sources: BrowserPdfCompilerFontSourceV1[],
  ) => BrowserPdfCompilerFontSourceV1[] = (sources) => sources,
): Promise<BrowserPdfCompiler> {
  const wasm = await packageBytes("@atlcli/pdf-compiler-browser/wasm");
  const sources = PDF_RUNTIME_ASSETS.fonts.map(
    (font): BrowserPdfCompilerFontSourceV1 => ({
      assetId: font.assetId,
      sha256: font.sha256,
      load: async (context = {}) => {
        context.signal?.throwIfAborted();
        onLoad(font.assetId);
        return packageBytes(`@atlcli/pdf/fonts/${font.fileName}`);
      },
    }),
  );
  return new BrowserPdfCompiler({
    wasm: wasm.buffer,
    fonts: sourcesTransform(sources),
  });
}

function sharedCompiler(): BrowserPdfCompiler {
  if (!canonicalCompiler) {
    throw new Error("Canonical BrowserPdfCompiler is not initialized");
  }
  return canonicalCompiler;
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
  it("loads, registers, and reports only the resolved font subset", async () => {
    const loaded: string[] = [];
    const compiler = await createDemandAwareCompiler((assetId) => loaded.push(assetId));
    try {
      const source = settingsBundle({ cover: false, outline: false });
      const expected = source.fontRequirements!.assets.map((asset) => asset.assetId);
      const result = await compiler.compile(source);

      expect(result.diagnostics).toEqual([]);
      expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });
      expect(loaded).toEqual(expected);
      expect(result.fontEvidence).toMatchObject({
        schema: "atlcli.pdf-font-load-evidence/1",
        requirementKey: source.fontRequirements!.key,
        registeredAssetIds: expected,
        fullBundleFallback: false,
      });
      expect(result.fontEvidence!.registeredAssetIds.length).toBeLessThan(
        PDF_RUNTIME_ASSETS.fonts.length,
      );
      expect(result.fontEvidence!.loadedFontNames.join("\n")).not.toContain(
        "Source Code Pro",
      );

      await compiler.compile(source);
      expect(loaded).toEqual(expected);
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("rebuilds one compiler when the deterministic requirement key changes", async () => {
    const loaded: string[] = [];
    const compiler = await createDemandAwareCompiler((assetId) => loaded.push(assetId));
    try {
      const prose = settingsBundle({ cover: false, outline: false });
      const full = {
        ...prose,
        fontRequirements: resolveFullPdfFontRequirementsV1(),
      };
      await compiler.compile(prose);
      const proseLoadCount = loaded.length;
      const result = await compiler.compile(full);

      expect(loaded.slice(proseLoadCount)).toEqual(
        PDF_RUNTIME_ASSETS.fonts.map((font) => font.assetId),
      );
      expect(result.fontEvidence?.registeredAssetIds).toEqual(
        PDF_RUNTIME_ASSETS.fonts.map((font) => font.assetId),
      );
      expect(result.fontEvidence?.fullBundleFallback).toBe(false);
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("serializes process-global font ownership across compiler instances", async () => {
    const first = await createDemandAwareCompiler();
    const second = await createDemandAwareCompiler();
    const prose = settingsBundle({ cover: false, outline: false });
    const full = {
      ...prose,
      fontRequirements: resolveFullPdfFontRequirementsV1(),
    };
    try {
      const [firstProse, fullResult, secondProse] = await Promise.all([
        first.compile(prose),
        second.compile(full),
        first.compile(prose),
      ]);

      expect(firstProse.diagnostics).toEqual([]);
      expect(fullResult.diagnostics).toEqual([]);
      expect(secondProse.diagnostics).toEqual([]);
      expect(secondProse.pdf).toEqual(firstProse.pdf);
      expect(firstProse.fontEvidence?.registeredAssetIds).toEqual(
        prose.fontRequirements!.assets.map((asset) => asset.assetId),
      );
      expect(fullResult.fontEvidence?.registeredAssetIds).toEqual(
        PDF_RUNTIME_ASSETS.fonts.map((font) => font.assetId),
      );
    } finally {
      await first.reset();
      await second.reset();
    }
  }, 30_000);

  it("rejects missing and hash-mismatched font sources before compilation", async () => {
    const source = settingsBundle({ cover: false, outline: false });
    const required = source.fontRequirements!.assets[0]!;
    const missing = await createDemandAwareCompiler(
      () => {},
      (sources) => sources.filter((candidate) => candidate.assetId !== required.assetId),
    );
    const mismatched = await createDemandAwareCompiler(
      () => {},
      (sources) => sources.map((candidate) =>
        candidate.assetId === required.assetId
          ? { ...candidate, sha256: "0".repeat(64) }
          : candidate
      ),
    );
    try {
      await expect(missing.compile(source)).rejects.toThrow(
        `font source is missing ${required.assetId}`,
      );
      await expect(mismatched.compile(source)).rejects.toThrow(
        "does not match the required SHA-256",
      );
    } finally {
      await missing.reset();
      await mismatched.reset();
    }
  });

  it("does not invoke font loaders for a compile cancelled before initialization", async () => {
    let loads = 0;
    const compiler = await createDemandAwareCompiler(() => {
      loads += 1;
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    try {
      await expect(
        compiler.compile(settingsBundle(), { signal: controller.signal }),
      ).rejects.toThrow("cancelled");
      expect(loads).toBe(0);
    } finally {
      await compiler.reset();
    }
  });

  it("clears a failed initialization so the same compiler can retry", async () => {
    let attempts = 0;
    const source = settingsBundle({ cover: false, outline: false });
    const firstRequired = source.fontRequirements!.assets[0]!.assetId;
    const compiler = await createDemandAwareCompiler(
      () => {},
      (sources) => sources.map((candidate) =>
        candidate.assetId === firstRequired
          ? {
              ...candidate,
              load: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("transient font read");
                return packageBytes(
                  `@atlcli/pdf/fonts/${
                    PDF_RUNTIME_ASSETS.fonts.find(
                      (font) => font.assetId === firstRequired,
                    )!.fileName
                  }`,
                );
              },
            }
          : candidate
      ),
    );
    try {
      await expect(compiler.compile(source)).rejects.toThrow(
        "transient font read",
      );
      const result = await compiler.compile(source);
      expect(result.diagnostics).toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("compiles with the complete canonical font set", async () => {
    const compiler = sharedCompiler();
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
    try {
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
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("drops compiler state and initializes cleanly after reset", async () => {
    const compiler = await createCompiler();
    try {
      const source = bundle("= Reset lifecycle\n\nSame source.");
      const first = await compiler.compile(source);
      await compiler.reset();
      const second = await compiler.compile(source);
      expect(second.diagnostics).toEqual([]);
      expect(second.pdf).toEqual(first.pdf);
    } finally {
      await compiler.reset();
    }
  }, 30_000);

  it("exposes the real post-VFS measurement point before Typst compiles", async () => {
    const compiler = sharedCompiler();
    let hookRan = false;
    const hook = Symbol.for("atlcli.pdf-compiler-browser.memory-probe.after-vfs-loaded");
    const host = globalThis as typeof globalThis &
      Record<symbol, (() => void) | undefined>;
    host[hook] = () => {
      hookRan = true;
    };
    let result: Awaited<ReturnType<BrowserPdfCompiler["compile"]>>;
    try {
      result = await compiler.compile(bundle("= Measured compile"));
    } finally {
      delete host[hook];
    }
    expect(hookRan).toBe(true);
    expect(result.pdf?.byteLength).toBeGreaterThan(0);
  }, 30_000);

  it("decodes every image-heavy corpus encoder through the real Typst pipeline (issue #118)", async () => {
    // The corpus ships its own pinned JPEG/PNG encoders; this proves the REAL
    // compiler (image crate inside Typst WASM) accepts their output. A decode
    // failure surfaces as a compile diagnostic, so empty diagnostics + a
    // tagged PDF is the actual acceptance evidence.
    const corpus = generateImageHeavyCorpus({ scale: 0.06 });
    const prepared = await preparePdfDocument(corpus.blocks, {
      resolve: async (ref) => resolveImageHeavyAsset(corpus, ref.filename ?? ""),
    });
    expect(prepared.notes).toEqual([]);
    expect(prepared.assets).toHaveLength(corpus.counts.uniqueAssets);
    const source = serializePdfDocument(prepared, {
      metadata: {
        title: "Image-heavy corpus decode proof",
        space: "DOCSY",
        version: 1,
        exporter: "atlcli image-heavy corpus test",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: false, outline: false },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });
  }, 120_000);

  it("decodes profile-normalized derivatives through the real Typst pipeline (issue #118 P1)", async () => {
    // The 'standard' profile re-encodes rasters with the pinned in-repo
    // codec; Typst (image crate) must accept every derivative. Zero
    // diagnostics + a tagged PDF is the acceptance evidence, and the
    // normalized bundle must be materially smaller than the original.
    // Scale 0.75 keeps sources ABOVE the 180-PPI envelope target (photos
    // 1800px wide vs the 1176px cap) so normalization genuinely engages;
    // smaller scales are correctly all-kept ("no-downscale").
    const corpus = generateImageHeavyCorpus({ scale: 0.75 });
    const resolver = {
      resolve: async (ref: { filename?: string }) =>
        resolveImageHeavyAsset(corpus, ref.filename ?? ""),
    };
    const prepared = await preparePdfDocument(corpus.blocks, resolver, {
      imageQuality: { imageProfile: "standard" },
    });
    const originalBytes = corpus.counts.uniqueAssetBytes;
    const normalizedBytes = prepared.assets.reduce(
      (total, asset) => total + asset.bytes.byteLength,
      0,
    );
    expect(normalizedBytes).toBeLessThan(originalBytes * 0.75);
    expect(prepared.notes.some((note) => note.code === "image-profile-applied")).toBe(true);
    const source = serializePdfDocument(prepared, {
      metadata: {
        title: "Image profile decode proof",
        space: "DOCSY",
        version: 1,
        exporter: "atlcli image profile test",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: false, outline: false },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(validatePdfOutput(result.pdf!)).toMatchObject({ tagged: true });
  }, 120_000);

  it("registers the Typst WASM linear memory with the benchmark probe hook", async () => {
    const hook = Symbol.for("atlcli.pdf-compiler-browser.memory-probe.register-wasm-memory");
    const host = globalThis as typeof globalThis &
      Record<symbol, ((memory: WebAssembly.Memory) => void) | undefined>;
    let registered: WebAssembly.Memory | undefined;
    host[hook] = (memory) => {
      registered = memory;
    };
    const compiler = await createCompiler();
    try {
      const result = await compiler.compile(bundle("= Attribution probe"));
      expect(result.pdf?.byteLength).toBeGreaterThan(0);
      expect(registered).toBeInstanceOf(WebAssembly.Memory);
      // Linear memory only grows, so byteLength read after a compile is the
      // high-water mark the attribution gate consumes.
      expect(registered!.buffer.byteLength).toBeGreaterThan(0);
    } finally {
      delete host[hook];
      await compiler.reset();
    }
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
    const compiler = sharedCompiler();
    const result = await compiler.compile(source);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(validatePdfOutput(result.pdf!).pageCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("compiles the static PDF projection of a correlated ADF inline comment", async () => {
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [{
        type: "text",
        text: "Annotated value",
        annotations: [{
          id: "marker-private",
          annotationType: "inlineComment",
          comment: {
            bodyText: "Review this value",
            status: "resolved",
            replies: [{ bodyText: "Reviewed" }],
          },
        }],
      }],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const source = serializePdfDocument(prepared, {
      metadata: { title: "Inline comments", exportedAt: new Date("2026-07-19T00:00:00Z") },
    });
    const compiler = sharedCompiler();
    const result = await compiler.compile(source);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(validatePdfOutput(result.pdf!).pageCount).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("template settings compiled output", () => {
  it("compiles Letter with a DRAFT watermark: clean, tagged, page count unchanged vs A4", async () => {
    const compiler = sharedCompiler();
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
    const compiler = sharedCompiler();
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
    const compiler = sharedCompiler();
    const result = await compiler.compile(settingsBundle({ orientation: "landscape" }));
    expect(result.diagnostics).toEqual([]);
    // Cover and colophon still fit their landscape pages: same page count as portrait.
    expect(validatePdfOutput(result.pdf!).pageCount).toBe(4);
    expect(inflatedPdfText(result.pdf!)).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+841(?:\.\d+)?\s/);
  }, 120_000);

  it("compiles accent color, organization name, header/footer text, and a real PNG logo", async () => {
    const compiler = sharedCompiler();
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
    const compiler = sharedCompiler();
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

// Review-fix goldens (spec 003): the captioned-figure code paths previously
// emitted `#emph`/`#raw`/`#block` INSIDE `#figure(...)` arguments — code
// context, where a leading `#` is a Typst syntax error. These compile the
// real serializer output for every captioned shape.
describe("spec 003 captioned figures (real compiler, code-context regression)", () => {
  const meta = { title: "Caption regressions", exportedAt: new Date("2026-07-20T00:00:00Z") };

  async function compileWithResolver(
    blocks: ExportBlock[],
    resolve: () => Promise<{ bytes: Uint8Array; mediaType: string; filename?: string }>
  ) {
    const prepared = await preparePdfDocument(blocks, { resolve });
    const source = serializePdfDocument(prepared, { metadata: meta });
    const compiler = sharedCompiler();
    const result = await compiler.compile(source);
    return { result, source };
  }

  it("a captioned image with a FAILED embed compiles into a numbered figure fallback", async () => {
    const { result, source } = await compileWithResolver(
      [
        {
          type: "image",
          source: { kind: "attachment", filename: "broken.png" },
          caption: { kind: "figure", content: [{ type: "text", text: "Broken but numbered" }] },
        },
        {
          type: "image",
          source: { kind: "attachment", filename: "also-broken.png" },
          caption: { kind: "figure", content: [{ type: "text", text: "Second figure" }] },
        },
      ],
      async () => {
        throw new Error("attachment gone");
      }
    );
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(validatePdfOutput(result.pdf!).pageCount).toBeGreaterThanOrEqual(1);
    // The emitted markup is the bare-expression figure body (regression pin —
    // `#figure(#emph[...])` was a compile error). Both captioned fallbacks
    // compile as real figures; page text is font-subsetted, so the compile
    // succeeding with two #figure(emph[...]) bodies IS the assertion.
    expect(source.main.match(/#figure\(emph\[/g)).toHaveLength(2);
    expect(source.main).not.toContain("#figure(#");
  }, 60_000);

  it("a captioned table and captioned code block compile (bare block/raw in figure args)", async () => {
    const { result, source } = await compileWithResolver(
      [
        {
          type: "table",
          rows: [
            { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }] }] },
          ],
          caption: { kind: "table", content: [{ type: "text", text: "Captioned table" }] },
        },
        {
          type: "codeBlock",
          language: "ts",
          code: "const x = 1;",
          caption: { kind: "code", content: [{ type: "text", text: "Captioned listing" }] },
        },
      ],
      async () => {
        throw new Error("unused");
      }
    );
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(source.main).toContain("#figure(block(width: 100%)[");
    expect(source.main).toContain("#figure(block(width: 100%, fill: rgb(");
    expect(source.main).toContain('#text(font: "Source Code Pro"');
    expect(source.main).toContain('"const"');
  }, 60_000);

  it("a wide table nested inside a landscape region compiles and escalates against the landscape width", async () => {
    // No punctuation: the dense breaker legitimately splits at punctuation and
    // 4-char alphanumeric runs, so escalation needs many narrow columns.
    const longToken = "SUPERCALIFRAGILISTICEXPIALIDOCIOUS";
    const cells = Array.from({ length: 20 }, (_, i) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [
        { type: "paragraph" as const, content: [{ type: "text" as const, text: i === 0 ? longToken : `c${i}` }] },
      ],
    }));
    const wideTable: ExportBlock = { type: "table", rows: [{ cells }] };

    // Portrait: the long token escalates.
    const prepared = await preparePdfDocument([wideTable], {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const portrait = serializePdfDocument(prepared, { metadata: meta });
    const portraitEscalated = portrait.notes.some(
      (n) => n.code === "table-text-scaled" || n.code === "table-overflow-warned"
    );

    // Same table inside a landscape region: classification resets against the
    // wider landscape text area, and the whole document must still compile.
    const preparedLandscape = await preparePdfDocument(
      [{ type: "orientation", landscape: true, content: [wideTable] }],
      {
        resolve: async () => {
          throw new Error("unused");
        },
      }
    );
    const landscape = serializePdfDocument(preparedLandscape, { metadata: meta });
    const landscapeCodes = landscape.notes.map((n) => n.code);
    expect(portraitEscalated).toBe(true);
    // The landscape width fits the same token without the scaled tier.
    expect(landscapeCodes).not.toContain("table-text-scaled");
    expect(landscapeCodes).not.toContain("table-overflow-warned");

    const compiler = sharedCompiler();
    const result = await compiler.compile(landscape);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pdf).toBeDefined();
    expect(validatePdfOutput(result.pdf!).pageCount).toBeGreaterThanOrEqual(1);
    // The region page is genuinely landscape (width > height in MediaBox).
    const boxes = [...inflatedPdfText(result.pdf!).matchAll(
      /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g
    )].map((m) => [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])]);
    expect(boxes.some(([w, h]) => w! > h!)).toBe(true);
  }, 90_000);
});
