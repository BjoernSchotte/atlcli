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

  it("rejects a declared MIME type that disagrees with magic bytes", async () => {
    const prepared = await preparePdfDocument(images(1), {
      resolve: async () => ({ bytes: pngBytes(), mediaType: "image/jpeg" }),
    });
    expect(prepared.assets).toEqual([]);
    expect(prepared.notes[0]?.message).toContain("declared media type");
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
