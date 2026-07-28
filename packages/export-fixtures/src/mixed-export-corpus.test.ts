import { describe, expect, it } from "bun:test";
import { generateMixedExportCorpus, resolveMixedExportAsset } from "./mixed-export-corpus.js";

describe("mixed export corpus (issue #118 plan corpus table)", () => {
  it("is deterministic and composes both halves", () => {
    const corpus = generateMixedExportCorpus({ imageScale: 0.06 });
    const again = generateMixedExportCorpus({ imageScale: 0.06 });
    expect(again.identity).toBe(corpus.identity);
    expect(again.counts).toEqual(corpus.counts);
    expect(corpus.counts.blocks).toBeGreaterThan(corpus.counts.textBlocks);
    expect(corpus.counts.assetBytes).toBeGreaterThan(corpus.text.counts.assetBytes);
    // Every image block in the woven document resolves through the router.
    const filenames = new Set<string>();
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const record = value as Record<string, unknown>;
      const source = record.source as { kind?: string; filename?: string; pageId?: string } | undefined;
      if (source?.kind === "attachment" && source.filename) {
        filenames.add(`${source.pageId ?? ""}|${source.filename}`);
        const resolved = resolveMixedExportAsset(corpus, {
          filename: source.filename,
          ...(source.pageId ? { pageId: source.pageId } : {}),
        });
        expect(resolved.bytes.byteLength).toBeGreaterThan(0);
      }
      Object.values(record).forEach(walk);
    };
    walk(corpus.blocks);
    expect(filenames.size).toBeGreaterThan(20);
  });
});
