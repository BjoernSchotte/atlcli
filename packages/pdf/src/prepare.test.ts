import { describe, expect, it } from "bun:test";
import { AssetPipelineError, type ExportBlock } from "@atlcli/confluence";
import {
  plainCodeHighlight,
  type CodeHighlightRuntime,
} from "@atlcli/code-highlight/contract";
import { PDF_ASSET_CONCURRENCY, preparePdfDocument } from "./prepare.js";

function pngBytes(unique = 0): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1 + unique,
  ]);
}

function images(count: number): ExportBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "image" as const,
    source: { kind: "attachment" as const, filename: `${index}.png` },
    alt: `Image ${index}`,
  }));
}

const unusedAssets = {
  resolve: async () => {
    throw new Error("asset resolver must stay unused");
  },
};

describe("PDF code-highlighting runtime gate", () => {
  it("keeps no-code, missing, unknown, plain-body, and Mermaid-only input runtime-free", async () => {
    let loaderCalls = 0;
    const prepared = await preparePdfDocument([
      { type: "paragraph", content: [{ type: "text", text: "No code" }] },
      { type: "codeBlock", code: "plain" },
      { type: "codeBlock", language: "not-a-language", code: "plain" },
      { type: "unknown", macroName: "plain-body", plainBody: "raw fallback" },
      { type: "codeBlock", language: "mermaid", code: "graph TD; A-->B" },
    ], unusedAssets, {
      codeTheme: "dracula",
      codeHighlightRuntimeLoader: async () => {
        loaderCalls += 1;
        throw new Error("runtime must stay gated");
      },
    });

    expect(loaderCalls).toBe(0);
    expect(prepared.blocks).toHaveLength(5);
    expect(
      prepared.notes.filter(({ code }) => code === "code-highlight-skipped"),
    ).toHaveLength(1);
  });

  it("loads once and prepares distinct canonical languages in first-use order", async () => {
    let loaderCalls = 0;
    const preparations: Array<{ languages: readonly string[]; theme?: string }> = [];
    const highlights: Array<{ language?: string; theme?: string }> = [];
    const runtime: CodeHighlightRuntime = {
      prepare: async (languages, theme) => {
        preparations.push({ languages: [...languages], theme });
      },
      highlight: async (code, language, theme) => {
        highlights.push({ language, theme });
        return plainCodeHighlight(code, theme);
      },
    };

    await preparePdfDocument([
      { type: "codeBlock", language: "TS", code: "const x = 1;" },
      {
        type: "callout",
        kind: "info",
        content: [
          { type: "codeBlock", language: "python", code: "x = 1" },
          { type: "codeBlock", language: "typescript", code: "const y = 2;" },
        ],
      },
    ], unusedAssets, {
      codeTheme: "dracula",
      codeHighlightRuntimeLoader: async () => {
        loaderCalls += 1;
        return runtime;
      },
    });

    expect(loaderCalls).toBe(1);
    expect(preparations).toEqual([{
      languages: ["typescript", "python"],
      theme: "dracula",
    }]);
    expect(highlights).toEqual([
      { language: "typescript", theme: "dracula" },
      { language: "python", theme: "dracula" },
      { language: "typescript", theme: "dracula" },
    ]);
  });

  it("has no static package-root edge from PDF preparation", async () => {
    const source = await Bun.file(
      new URL("./prepare.ts", import.meta.url),
    ).text();
    expect(source).not.toContain('from "@atlcli/code-highlight";');
  });
});

describe("PDF asset preparation", () => {
  it("rejects corrupt bytes and preserves a readable fallback", async () => {
    const prepared = await preparePdfDocument(images(1), {
      resolve: async () => ({
        bytes: new TextEncoder().encode("not an image"),
        mediaType: "image/png",
      }),
    });
    expect(prepared.assets).toEqual([]);
    expect(prepared.blocks[0]).toMatchObject({ type: "image", fallbackLabel: "Image 0" });
    expect(prepared.notes[0]?.code).toBe("image-embed-failed");
    expect(prepared.notes[0]?.message).toContain("corrupt");
  });

  it("rejects active SVG content instead of compiling it", async () => {
    const prepared = await preparePdfDocument(images(1), {
      resolve: async () => ({
        bytes: new TextEncoder().encode(
          `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`
        ),
        mediaType: "image/svg+xml",
      }),
    });
    expect(prepared.assets).toEqual([]);
    expect(prepared.notes[0]?.message).toContain("active");
  });

  it("rejects hostile SVG assets through the shared svg-safety rules", async () => {
    // Bypass classes the old inline sanitizer accepted: namespace-prefixed
    // script elements and javascript:/relative href targets.
    const hostiles = [
      `<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="../../etc/passwd"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY x "y"><rect/></svg>`,
    ];
    for (const hostile of hostiles) {
      const prepared = await preparePdfDocument(images(1), {
        resolve: async () => ({
          bytes: new TextEncoder().encode(hostile),
          mediaType: "image/svg+xml",
        }),
      });
      expect(prepared.assets).toEqual([]);
      expect(prepared.notes[0]?.message).toContain("active");
    }
  });

  it("rejects a UTF-16LE + BOM <script> SVG through the shared BOM-aware policy (spec 011)", async () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
    const bytes = new Uint8Array(2 + hostile.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < hostile.length; i++) {
      const c = hostile.charCodeAt(i);
      bytes[2 + i * 2] = c & 0xff;
      bytes[3 + i * 2] = c >> 8;
    }
    const prepared = await preparePdfDocument(images(1), {
      resolve: async () => ({ bytes, mediaType: "image/svg+xml" }),
    });
    // Recognized as SVG (BOM-aware sniff) and rejected by the scanner, not
    // silently dropped as "unrecognized bytes".
    expect(prepared.assets).toEqual([]);
    expect(prepared.notes[0]?.message).toContain("active");
  });

  it("rejects a declared MIME type that disagrees with magic bytes", async () => {
    const prepared = await preparePdfDocument(images(1), {
      resolve: async () => ({ bytes: pngBytes(), mediaType: "image/jpeg" }),
    });
    expect(prepared.assets).toEqual([]);
    expect(prepared.notes[0]?.message).toContain("declared media type");
  });

  it("resolves an image nested inside an orientation region", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "orientation",
        landscape: true,
        content: [
          { type: "image", source: { kind: "attachment", filename: "wide.png" }, alt: "Wide" },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({ bytes: pngBytes(), mediaType: "image/png" }),
    });
    expect(prepared.assets).toHaveLength(1);
    const region = prepared.blocks[0] as { type: "orientation"; content: Array<{ type: string; assetPath?: string }> };
    expect(region.type).toBe("orientation");
    expect(region.content[0]).toMatchObject({ type: "image", assetPath: prepared.assets[0]!.path });
  });

  it("resolves an image nested inside a page-layout column", async () => {
    const blocks: ExportBlock[] = [{
      type: "layout",
      columns: [{
        width: 100,
        content: [
          { type: "image", source: { kind: "attachment", filename: "column.png" }, alt: "Column" },
        ],
      }],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({ bytes: pngBytes(), mediaType: "image/png" }),
    });
    expect(prepared.assets).toHaveLength(1);
    expect(prepared.blocks[0]).toMatchObject({
      type: "layout",
      columns: [{
        content: [{ type: "image", assetPath: prepared.assets[0]!.path }],
      }],
    });
  });

  it("recurses through expands while unresolved media stays non-fetching and captioned", async () => {
    const seen: string[] = [];
    const blocks: ExportBlock[] = [{
      type: "expand",
      nested: false,
      title: "Assets",
      content: [
        {
          type: "image",
          source: { kind: "attachment", filename: "inside.png" },
          alt: "Inside",
        },
        {
          type: "mediaFallback",
          label: "unresolved-media",
          media: { mediaType: "file", id: "media-1" },
          caption: {
            kind: "figure",
            localId: "caption-1",
            content: [{ type: "text", text: "Unresolved caption" }],
          },
        },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async (reference) => {
        seen.push(reference.filename ?? "");
        return { bytes: pngBytes(), mediaType: "image/png" };
      },
    });

    expect(seen).toEqual(["inside.png"]);
    expect(prepared.assets).toHaveLength(1);
    expect(prepared.blocks[0]).toMatchObject({
      type: "expand",
      content: [
        { type: "image", assetPath: prepared.assets[0]!.path },
        {
          type: "mediaFallback",
          media: { id: "media-1" },
          caption: {
            localId: "caption-1",
            content: [{ type: "text", text: "Unresolved caption" }],
          },
        },
      ],
    });
  });

  it("carries caption fields through preparation on table/codeBlock/image", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "codeBlock",
        code: "x=1",
        caption: { kind: "code", content: [{ type: "text", text: "Listing 1" }] },
        title: "Deployment",
        initiallyCollapsed: true,
        wrap: false,
        hideLineNumbers: false,
        firstLineNumber: 7,
        localId: "code-local",
        uniqueId: "code-unique",
      },
      { type: "table", rows: [], caption: { kind: "table", content: [{ type: "text", text: "Table 1" }] } },
      {
        type: "image",
        source: { kind: "attachment", filename: "fig.png" },
        caption: { kind: "figure", content: [{ type: "text", text: "Figure 1" }] },
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({ bytes: pngBytes(), mediaType: "image/png" }),
    });
    expect((prepared.blocks[0] as { caption?: unknown }).caption).toEqual({
      kind: "code",
      content: [{ type: "text", text: "Listing 1" }],
    });
    expect(prepared.blocks[0]).toMatchObject({
      wrap: false,
      title: "Deployment",
      initiallyCollapsed: true,
      hideLineNumbers: false,
      firstLineNumber: 7,
      localId: "code-local",
      uniqueId: "code-unique",
    });
    expect((prepared.blocks[1] as { caption?: unknown }).caption).toEqual({
      kind: "table",
      content: [{ type: "text", text: "Table 1" }],
    });
    expect((prepared.blocks[2] as { caption?: unknown }).caption).toEqual({
      kind: "figure",
      content: [{ type: "text", text: "Figure 1" }],
    });
  });

  it("retains legacy code title and collapse intent when Mermaid becomes a diagram", async () => {
    const prepared = await preparePdfDocument([{
      type: "codeBlock",
      language: "mermaid",
      code: "flowchart LR\nA --> B",
      title: "System flow",
      initiallyCollapsed: true,
    }], {
      resolve: async () => {
        throw new Error("unused");
      },
    });

    expect(prepared.blocks[0]).toMatchObject({
      type: "diagram",
      title: "System flow",
      initiallyCollapsed: true,
    });
  });

  it("resolves correlated inline media in paragraphs and captions with shared asset dedup", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before" },
          {
            type: "media",
            media: { mediaType: "image", id: "inline-1", filename: "shared.png" },
            source: { kind: "attachment", filename: "shared.png" },
            alt: "Inline architecture",
          },
          { type: "text", text: "after" },
        ],
      },
      {
        type: "image",
        source: { kind: "attachment", filename: "shared.png" },
        alt: "Block architecture",
        caption: {
          kind: "figure",
          content: [{
            type: "media",
            media: { mediaType: "image", id: "inline-2", filename: "shared.png" },
            source: { kind: "attachment", filename: "shared.png" },
            alt: "Caption architecture",
          }],
        },
      },
    ];
    const progress: Array<{ done: number; total: number }> = [];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({
        bytes: pngBytes(),
        mediaType: "image/png",
        filename: "shared.png",
      }),
    }, {
      onProgress: (event) => {
        if (event.phase === "assets" && event.total !== null) {
          progress.push({ done: event.done, total: event.total });
        }
      },
    });

    expect(prepared.assets).toHaveLength(1);
    const assetPath = prepared.assets[0]!.path;
    expect(prepared.blocks[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "before" },
        { type: "media", assetPath, fallbackLabel: "Inline architecture" },
        { type: "text", text: "after" },
      ],
    });
    expect(prepared.blocks[1]).toMatchObject({
      type: "image",
      assetPath,
      caption: {
        content: [{ type: "media", assetPath, fallbackLabel: "Caption architecture" }],
      },
    });
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 });
  });

  it("keeps a deterministic inline-media fallback when resolution fails", async () => {
    const prepared = await preparePdfDocument([{
      type: "paragraph",
      content: [{
        type: "media",
        media: { mediaType: "image", id: "inline-1", filename: "missing.png" },
        source: { kind: "attachment", filename: "missing.png" },
        alt: "Missing inline",
      }],
    }], {
      resolve: async () => {
        throw new Error("offline");
      },
    });

    expect(prepared.blocks[0]).toMatchObject({
      content: [{ type: "media", fallbackLabel: "Missing inline" }],
    });
    expect(prepared.notes).toContainEqual(expect.objectContaining({
      code: "image-embed-failed",
      message: expect.stringContaining("offline"),
    }));
  });

  it("deduplicates identical large images so the shared budget counts them once", async () => {
    // Three references to the SAME 20 MiB image. Without content dedup that is
    // 60 MiB (over the 50 MiB cap); deduped it is 20 MiB and succeeds — proving
    // the AssetBudget dedups BEFORE counting against the cap.
    const twentyMiB = new Uint8Array(20 * 1024 * 1024);
    twentyMiB.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const prepared = await preparePdfDocument(images(3), {
      resolve: async () => ({ bytes: twentyMiB, mediaType: "image/png" }),
    });
    expect(prepared.assets).toHaveLength(1);
    expect(prepared.notes).toEqual([]);
  });

  it("keeps product caps without the benchmark seam and honors both halves with it", async () => {
    // Issue #118 Phase 0: the ≥100 MiB image-heavy corpus runs through the
    // real pipeline via a Symbol.for override; without the hook the shared
    // product caps stay exactly as before.
    const fakePng = (sizeBytes: number, unique: number): Uint8Array => {
      const bytes = new Uint8Array(sizeBytes);
      bytes.set([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0, 1, 0, 0, 0, 1 + unique,
      ]);
      return bytes;
    };
    const twentySixMiB = fakePng(26 * 1024 * 1024, 0);

    // Default per-file cap: oversize asset degrades to a note, not an embed.
    const rejected = await preparePdfDocument(images(1), {
      resolve: async () => ({ bytes: twentySixMiB, mediaType: "image/png" }),
    });
    expect(rejected.assets).toEqual([]);
    expect(rejected.notes[0]?.message).toContain("25 MB per-file limit");

    const hook = Symbol.for("atlcli.pdf.benchmark-asset-budget");
    const host = globalThis as typeof globalThis &
      Record<symbol, { maxAssetBytes?: number; maxTotalBytes?: number } | undefined>;
    host[hook] = { maxAssetBytes: 32 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 };
    try {
      // Per-file half: the same 26 MiB asset embeds under the raised cap.
      const perFile = await preparePdfDocument(images(1), {
        resolve: async () => ({ bytes: twentySixMiB, mediaType: "image/png" }),
      });
      expect(perFile.assets).toHaveLength(1);
      expect(perFile.notes).toEqual([]);

      // Total half: three distinct 18 MiB assets (54 MiB > the 50 MiB product
      // cap) succeed only because the total override is active.
      const total = await preparePdfDocument(images(3), {
        resolve: async (ref) => ({
          bytes: fakePng(18 * 1024 * 1024, Number(ref.filename?.[0] ?? 0)),
          mediaType: "image/png",
        }),
      });
      expect(total.assets).toHaveLength(3);
      expect(total.notes).toEqual([]);
    } finally {
      delete host[hook];
    }

    // Hook removed: the same 54 MiB total breaches the product cap again.
    await expect(
      preparePdfDocument(images(3), {
        resolve: async (ref) => ({
          bytes: fakePng(18 * 1024 * 1024, Number(ref.filename?.[0] ?? 0)),
          mediaType: "image/png",
        }),
      })
    ).rejects.toThrow(/budget|50/);
  });

  it("applies an explicit image profile: downscales rasters, keeps original untouched (issue #118)", async () => {
    const { encodeJpeg } = await import("@atlcli/export-media");
    const rgbGradient = (width: number, height: number): Uint8Array => {
      const out = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3;
        out[i] = (x * 255 / (width - 1)) | 0;
        out[i + 1] = (y * 255 / (height - 1)) | 0;
        out[i + 2] = ((x + y) * 127 / (width + height)) | 0;
      }
      return out;
    };
    const bigJpeg = encodeJpeg(rgbGradient(1600, 1200), 1600, 1200, 90);
    const resolver = {
      resolve: async () => ({ bytes: bigJpeg, mediaType: "image/jpeg" }),
    };

    const original = await preparePdfDocument(images(1), resolver);
    expect(original.assets[0]!.bytes).toBe(bigJpeg); // byte-identical passthrough
    expect(original.notes).toEqual([]);

    const standard = await preparePdfDocument(images(1), resolver, {
      imageQuality: { imageProfile: "standard" },
    });
    expect(standard.assets).toHaveLength(1);
    expect(standard.assets[0]!.mediaType).toBe("image/jpeg");
    expect(standard.assets[0]!.bytes.byteLength).toBeLessThan(bigJpeg.byteLength);
    const note = standard.notes.find((entry) => entry.code === "image-profile-applied");
    expect(note?.level).toBe("info");
    expect(note?.message).toContain("normalized 1 raster asset");

    // Deterministic: repeated preparation embeds identical derivative bytes.
    const again = await preparePdfDocument(images(1), resolver, {
      imageQuality: { imageProfile: "standard" },
    });
    expect(again.assets[0]!.bytes).toEqual(standard.assets[0]!.bytes);
    // And the derivative path differs from the original's (new content hash).
    expect(again.assets[0]!.path).toBe(standard.assets[0]!.path);
    expect(standard.assets[0]!.path).not.toBe(original.assets[0]!.path);

    // Browser hosts can move decode/resize into a disposable worker without
    // forking PDF preparation. The async boundary must be awaited and retain
    // the exact pinned output contract.
    const { normalizeRasterAssetV1 } = await import("@atlcli/export-media");
    let portCalls = 0;
    let activePortCalls = 0;
    let maxActivePortCalls = 0;
    let portSettled = false;
    const asyncPort = await preparePdfDocument(images(2), resolver, {
      imageQuality: { imageProfile: "standard" },
      rasterNormalizer: {
        normalize: async (request) => {
          portCalls += 1;
          activePortCalls += 1;
          maxActivePortCalls = Math.max(maxActivePortCalls, activePortCalls);
          await Promise.resolve();
          const result = normalizeRasterAssetV1(request);
          activePortCalls -= 1;
          portSettled = true;
          return result;
        },
      },
    });
    expect(portCalls).toBe(2);
    expect(maxActivePortCalls).toBe(1);
    expect(portSettled).toBe(true);
    expect(asyncPort.assets[0]!.bytes).toEqual(standard.assets[0]!.bytes);

    // Invalid combination fails before any fetch.
    await expect(
      preparePdfDocument(images(1), resolver, {
        imageQuality: { imageProfile: "original", imagePpi: 240 },
      }),
    ).rejects.toThrow("original never re-encodes");
  });

  it("reports one progress event per embedded asset", async () => {
    const events: Array<{ phase: string; done: number; total: number | null }> = [];
    let n = 0;
    await preparePdfDocument(
      images(2),
      { resolve: async () => ({ bytes: pngBytes(n++), mediaType: "image/png" }) },
      { onProgress: (e) => events.push({ phase: e.phase, done: e.done, total: e.total }) }
    );
    expect(events.every((e) => e.phase === "assets")).toBe(true);
    expect(events.map((e) => e.done)).toEqual([1, 2]);
    expect(events.every((e) => e.total === 2)).toBe(true);
  });

  it("threads the owning pageId through to the resolver (spec 008 T3.3)", async () => {
    // Two pages in one composed document with identically named but
    // byte-different attachments must resolve to DISTINCT bytes, not collide on
    // filename alone.
    const blocks: ExportBlock[] = [
      { type: "image", source: { kind: "attachment", filename: "logo.png", pageId: "111" }, alt: "A" },
      { type: "image", source: { kind: "attachment", filename: "logo.png", pageId: "222" }, alt: "B" },
    ];
    const seen: Array<{ filename?: string; pageId?: string }> = [];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async (ref) => {
        seen.push({ filename: ref.filename, pageId: ref.pageId });
        // Distinct bytes per page so the two must NOT dedup together.
        return { bytes: pngBytes(ref.pageId === "111" ? 1 : 2), mediaType: "image/png" };
      },
    });
    expect(seen).toEqual([
      { filename: "logo.png", pageId: "111" },
      { filename: "logo.png", pageId: "222" },
    ]);
    expect(prepared.assets).toHaveLength(2);
  });

  it("aborts the export on a cancellation error instead of skipping the image (spec 008 T3.2)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      preparePdfDocument(
        images(1),
        {
          resolve: async (_ref, context) => {
            context?.signal?.throwIfAborted();
            return { bytes: pngBytes(), mediaType: "image/png" };
          },
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds parallel attachment resolution and preserves deterministic order", async () => {
    let active = 0;
    let peak = 0;
    const prepared = await preparePdfDocument(images(8), {
      resolve: async (ref) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const index = Number.parseInt(ref.filename ?? "0", 10);
        return { bytes: pngBytes(index), mediaType: "image/png" };
      },
    });
    expect(peak).toBe(PDF_ASSET_CONCURRENCY);
    expect(prepared.assets.map((asset) => asset.path.match(/image-(\d+)-/)?.[1])).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "8"]
    );
  });
});

/**
 * Alt-text audit (spec 011, PDF/UA 7.3). The audit's value is entirely in its
 * provenance: "some image has no alt text" is unactionable in a 500-page tree
 * export, so every assertion here checks WHICH page/block the note names, not
 * merely that a note exists.
 */
describe("PDF alt-text audit", () => {
  const ok = { resolve: async () => ({ bytes: pngBytes(), mediaType: "image/png" }) };
  const altNotes = (notes: Awaited<ReturnType<typeof preparePdfDocument>>["notes"]) =>
    notes.filter((note) => note.code === "image-missing-alt");

  function image(alt: string | undefined, filename = "diagram.png", pageId?: string): ExportBlock {
    return {
      type: "image",
      source: { kind: "attachment", filename, ...(pageId ? { pageId } : {}) },
      ...(alt === undefined ? {} : { alt }),
    };
  }

  it("names the source page, block path and asset for an image with no alt", async () => {
    const prepared = await preparePdfDocument([image(undefined, "chart.png", "12345")], ok);
    expect(altNotes(prepared.notes)).toEqual([
      {
        level: "warning",
        code: "image-missing-alt",
        message: expect.stringContaining("chart.png"),
        source: { pageId: "12345", blockPath: "blocks[0]", assetName: "chart.png" },
      },
    ]);
  });

  it("stays silent when the author wrote alt text", async () => {
    const prepared = await preparePdfDocument([image("A revenue chart")], ok);
    expect(altNotes(prepared.notes)).toEqual([]);
  });

  it("treats whitespace-only alt as missing", async () => {
    // Confluence's editor produces `alt=" "` readily; a space helps nobody.
    const prepared = await preparePdfDocument([image("   ")], ok);
    expect(altNotes(prepared.notes)).toHaveLength(1);
  });

  it("audits an image that FAILED to embed, not just the embedded ones", async () => {
    // The defect is on the source page, so it is independent of whether the
    // bytes resolved — a broken attachment still needs alt text once fixed.
    const prepared = await preparePdfDocument([image(undefined, "gone.png")], {
      resolve: async () => {
        throw new Error("404");
      },
    });
    expect(altNotes(prepared.notes)).toHaveLength(1);
    expect(prepared.notes.map((note) => note.code)).toContain("image-embed-failed");
  });

  it("does not downgrade a durable asset-pipeline failure to a missing image", async () => {
    await expect(
      preparePdfDocument([image("Figure", "figure.png")], {
        resolve: async () => {
          throw new AssetPipelineError("asset checkpoint quota exceeded");
        },
      }),
    ).rejects.toThrow("asset checkpoint quota exceeded");
  });

  it("reports a block path that locates the image inside nested containers", async () => {
    const blocks: ExportBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      {
        type: "table",
        rows: [
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [] },
              {
                header: false,
                colspan: 1,
                rowspan: 1,
                content: [
                  {
                    type: "callout",
                    kind: "info",
                    content: [
                      {
                        type: "list",
                        ordered: false,
                        items: [{ content: [image(undefined, "deep.png")] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, ok);
    expect(altNotes(prepared.notes)[0]?.source?.blockPath).toBe(
      "blocks[1].rows[0].cells[1].content[0].content[0].items[0].content[0]"
    );
  });

  it("falls back to the host's page context when the block carries no page id", async () => {
    // External images and single-page exports have no attachment pageId, but
    // the caller knows which page it is exporting.
    const external: ExportBlock = {
      type: "image",
      source: { kind: "external", url: "https://example.test/a.png" },
    };
    const prepared = await preparePdfDocument([external], ok, {
      pageContext: { pageId: "777", pageTitle: "Release Notes", pageUrl: "https://wiki.test/777" },
    });
    expect(altNotes(prepared.notes)[0]?.source).toEqual({
      pageId: "777",
      pageTitle: "Release Notes",
      pageUrl: "https://wiki.test/777",
      blockPath: "blocks[0]",
      assetName: "https://example.test/a.png",
    });
  });

  it("prefers the block's own attachment page id over the host fallback", async () => {
    // In a tree export the fallback names the ROOT page, which would send the
    // author to the wrong page to fix the alt text.
    const prepared = await preparePdfDocument([image(undefined, "x.png", "child-9")], ok, {
      pageContext: { pageId: "root-1" },
    });
    expect(altNotes(prepared.notes)[0]?.source?.pageId).toBe("child-9");
  });

  it("emits exactly one audit note per offending image", async () => {
    const prepared = await preparePdfDocument(
      [image(undefined, "a.png"), image("fine", "b.png"), image(undefined, "c.png")],
      ok
    );
    expect(altNotes(prepared.notes).map((note) => note.source?.assetName)).toEqual(["a.png", "c.png"]);
  });
});
