import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence/browser";
import {
  digestLargeExportCorpus,
  findLargeExportAsset,
  generateLargeExportCorpus,
  LARGE_EXPORT_CORPUS_DEFAULT_SEED,
  type LargeExportCorpus,
} from "./large-export-corpus.js";

function imageBlocks(corpus: LargeExportCorpus): Array<Extract<ExportBlock, { type: "image" }>> {
  return corpus.nodes.flatMap((node) =>
    node.blocks.filter((block): block is Extract<ExportBlock, { type: "image" }> =>
      block.type === "image",
    ),
  );
}

describe("large export baseline corpus", () => {
  it("pins the 50-page counts and digest", async () => {
    const corpus = generateLargeExportCorpus({ pages: 50 });

    expect(corpus.seed).toBe(LARGE_EXPORT_CORPUS_DEFAULT_SEED);
    expect(corpus.counts).toEqual({
      pages: 50,
      blocks: 689,
      tables: 12,
      tableRows: 101,
      resolvedMacros: 10,
      imageAssets: 10,
      diagramAssets: 5,
      assetBytes: 168_547,
      labelledPages: 8,
      maxDepth: 3,
    });
    expect(await digestLargeExportCorpus(corpus)).toBe(
      "72465d58c376bedbc2c8d492d0cec5fda9c682b95eeea2cc9d164444fbc15686",
    );
  });

  it("pins the 500-page counts and digest", async () => {
    const corpus = generateLargeExportCorpus({ pages: 500 });

    expect(corpus.counts).toEqual({
      pages: 500,
      blocks: 6_932,
      tables: 126,
      tableRows: 1_041,
      resolvedMacros: 105,
      imageAssets: 100,
      diagramAssets: 50,
      assetBytes: 1_685_499,
      labelledPages: 83,
      maxDepth: 3,
    });
    expect(await digestLargeExportCorpus(corpus)).toBe(
      "82da8edb1d0a4bcdd5f47dd8fbcf14278170749071dc4c7916c714c782a8ed94",
    );
  });

  it("is deterministic by seed and produces a valid parent-before-child hierarchy", async () => {
    const first = generateLargeExportCorpus({ pages: 50, seed: 1234 });
    const again = generateLargeExportCorpus({ pages: 50, seed: 1234 });
    const different = generateLargeExportCorpus({ pages: 50, seed: 1235 });

    expect(await digestLargeExportCorpus(first)).toBe(await digestLargeExportCorpus(again));
    expect(await digestLargeExportCorpus(first)).not.toBe(
      await digestLargeExportCorpus(different),
    );

    const seen = new Map<string, number>();
    for (const node of first.nodes) {
      if (node.parentId === null) {
        expect(node.depth).toBe(0);
      } else {
        const parentDepth = seen.get(node.parentId);
        expect(parentDepth, `missing earlier parent ${node.parentId}`).toBeDefined();
        expect(node.depth).toBe(parentDepth! + 1);
      }
      seen.set(node.pageId, node.depth);
    }
  });

  it("ships real PNG images and resolved SVG diagram assets for every image block", () => {
    const corpus = generateLargeExportCorpus({ pages: 50 });
    const blocks = imageBlocks(corpus);

    expect(blocks.length).toBe(corpus.assets.length);
    for (const block of blocks) {
      const asset = findLargeExportAsset(corpus, block.source);
      expect(asset, `${JSON.stringify(block.source)} must resolve`).toBeDefined();
      if (asset!.mediaType === "image/png") {
        expect(Array.from(asset!.bytes.slice(0, 8))).toEqual([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(asset!.bytes.byteLength).toBeGreaterThan(16_000);
      } else {
        const source = new TextDecoder().decode(asset!.bytes);
        expect(source).toStartWith("<svg");
        expect(source).toContain("Source ");
      }
    }

    const diagramPages = corpus.nodes.filter((node) =>
      node.notes.some((note) => note.macroName === "drawio"),
    );
    expect(diagramPages).toHaveLength(corpus.counts.diagramAssets);
    expect(
      diagramPages.every((node) => node.blocks.some((block) => block.type === "image")),
    ).toBe(true);
    expect(corpus.nodes.some((node) => node.blocks.some((block) => block.type === "unknown"))).toBe(
      false,
    );
  });
});
