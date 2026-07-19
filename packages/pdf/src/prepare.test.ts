import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
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
    expect(prepared.notes[0]?.code).toBe("pdf-image-skipped");
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

  it("carries caption fields through preparation on table/codeBlock/image", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", code: "x=1", caption: { kind: "code", content: [{ type: "text", text: "Listing 1" }] } },
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
    expect((prepared.blocks[1] as { caption?: unknown }).caption).toEqual({
      kind: "table",
      content: [{ type: "text", text: "Table 1" }],
    });
    expect((prepared.blocks[2] as { caption?: unknown }).caption).toEqual({
      kind: "figure",
      content: [{ type: "text", text: "Figure 1" }],
    });
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
