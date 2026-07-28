/**
 * Deterministic MIXED corpus (issue #118 plan corpus table): representative
 * chapters, repeated logos, diagrams/SVG, screenshots, captions, wrapped
 * media, and JPEG photos — composed from the two proven extremes instead of
 * a third bespoke generator: the text-heavy tree contributes structure
 * (headings, tables, code, macros, small diagrams) and the image-heavy
 * corpus contributes realistic compressed media with repeats and inline/
 * full-width placements. Interleaving is deterministic per (seed, scale).
 */
import { composeChapters } from "@atlcli/confluence";
import type { ExportBlock } from "@atlcli/confluence/browser";
import {
  findLargeExportAsset,
  generateLargeExportCorpus,
  type LargeExportCorpus,
} from "./large-export-corpus.js";
import {
  generateImageHeavyCorpus,
  resolveImageHeavyAsset,
  type ImageHeavyCorpus,
} from "./image-heavy-corpus.js";

export const MIXED_EXPORT_CORPUS_SCHEMA = "atlcli.mixed-export-corpus/1" as const;

export interface MixedExportCorpusOptions {
  seed?: number;
  /** Image-heavy linear scale for the media half (default 0.35 ≈ 12 MiB). */
  imageScale?: number;
}

export interface MixedExportCorpus {
  schema: typeof MIXED_EXPORT_CORPUS_SCHEMA;
  identity: string;
  blocks: ExportBlock[];
  text: LargeExportCorpus;
  images: ImageHeavyCorpus;
  counts: { blocks: number; textBlocks: number; imageBlocks: number; assetBytes: number };
}

export function generateMixedExportCorpus(
  options: MixedExportCorpusOptions = {},
): MixedExportCorpus {
  const imageScale = options.imageScale ?? 0.35;
  const text = generateLargeExportCorpus({
    pages: 50,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const images = generateImageHeavyCorpus({
    scale: imageScale,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const textBlocks = composeChapters(text.nodes).blocks;

  // Deterministic interleave: split the image chapters at their pageBreaks
  // and weave one media chapter after every fourth text block run.
  const imageChapters: ExportBlock[][] = [[]];
  for (const block of images.blocks) {
    if (block.type === "pageBreak") imageChapters.push([]);
    else imageChapters[imageChapters.length - 1]!.push(block);
  }
  const blocks: ExportBlock[] = [];
  let nextImageChapter = 0;
  for (let index = 0; index < textBlocks.length; index += 1) {
    blocks.push(textBlocks[index]!);
    if (index % 4 === 3 && nextImageChapter < imageChapters.length) {
      blocks.push({ type: "pageBreak" }, ...imageChapters[nextImageChapter]!);
      nextImageChapter += 1;
    }
  }
  for (; nextImageChapter < imageChapters.length; nextImageChapter += 1) {
    blocks.push({ type: "pageBreak" }, ...imageChapters[nextImageChapter]!);
  }

  return {
    schema: MIXED_EXPORT_CORPUS_SCHEMA,
    identity:
      `${MIXED_EXPORT_CORPUS_SCHEMA}|text=${text.schema}:${text.pages}:${text.seed}` +
      `|images=${images.manifestSha256}`,
    blocks,
    text,
    images,
    counts: {
      blocks: blocks.length,
      textBlocks: textBlocks.length,
      imageBlocks: images.blocks.length,
      assetBytes:
        text.counts.assetBytes + images.counts.uniqueAssetBytes,
    },
  };
}

/** Resolve a mixed-corpus asset from whichever half owns it. */
export function resolveMixedExportAsset(
  corpus: MixedExportCorpus,
  ref: { filename: string; pageId?: string },
): { bytes: Uint8Array; mediaType: string; filename: string } {
  const fromText = findLargeExportAsset(corpus.text, {
    kind: "attachment",
    filename: ref.filename,
    ...(ref.pageId ? { pageId: ref.pageId } : {}),
  });
  if (fromText) {
    return { bytes: fromText.bytes, mediaType: fromText.mediaType, filename: fromText.filename };
  }
  return resolveImageHeavyAsset(corpus.images, ref.filename);
}
