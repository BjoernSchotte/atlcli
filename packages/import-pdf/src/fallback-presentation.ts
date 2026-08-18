import type { ImportBlock, ImportDocumentV2 } from "@atlcli/import-core";

export const PDF_FALLBACK_PRESENTATION_REVISION = "atlcli.pdf-fallback-presentation/1" as const;

export type PdfVisualFallbackPlacementV1 = "inline" | "collapsed" | "appendix";

function sourcePageNumber(block: Extract<ImportBlock, { type: "image" }>): number | null {
  for (const sourceRef of block.sourceRefs ?? []) {
    const match = /^pdf:p(\d+)$/u.exec(sourceRef);
    if (match) return Number(match[1]) + 1;
  }
  return null;
}

function fallbackTitle(block: Extract<ImportBlock, { type: "image" }>): string {
  const page = sourcePageNumber(block);
  return page === null ? "Original visual view" : `Original visual view — source page ${page}`;
}

function disclosure(
  image: Extract<ImportBlock, { type: "image" }>,
  caption: ImportBlock | undefined,
): Extract<ImportBlock, { type: "disclosure" }> {
  const blocks = [{ ...image, pageBoundaryBefore: undefined }, ...(caption ? [{ ...caption, pageBoundaryBefore: undefined }] : [])];
  return {
    id: `${image.id}:disclosure`,
    type: "disclosure",
    title: fallbackTitle(image),
    blocks,
    sourceRefs: [image.id, ...new Set(blocks.flatMap((block) => block.sourceRefs ?? []))],
    ...(image.pageBoundaryBefore ? { pageBoundaryBefore: true } : {}),
  };
}

export function applyPdfFallbackPresentation(
  document: ImportDocumentV2,
  placement: PdfVisualFallbackPlacementV1,
): ImportDocumentV2 {
  if (placement === "inline") return document;
  const captions = new Map(document.blocks.map((block) => [block.id, block]));
  const consumed = new Set<string>();
  const disclosures: Array<Extract<ImportBlock, { type: "disclosure" }>> = [];
  const blocks: ImportBlock[] = [];
  for (const block of document.blocks) {
    if (consumed.has(block.id)) continue;
    if (block.type !== "image" || block.presentation !== "page-fallback") {
      blocks.push(block);
      continue;
    }
    const caption = block.captionBlockId ? captions.get(block.captionBlockId) : undefined;
    if (caption) consumed.add(caption.id);
    const wrapped = disclosure(block, caption);
    if (placement === "collapsed") blocks.push(wrapped);
    else disclosures.push(wrapped);
  }
  if (placement === "appendix" && disclosures.length > 0) {
    blocks.push({
      id: "pdf:visual-fallback-appendix:heading",
      type: "heading",
      level: 2,
      runs: [{ kind: "text", text: "Original visual views" }],
    });
    blocks.push(...disclosures.map((item) => ({ ...item, pageBoundaryBefore: undefined })));
  }
  return { ...document, blocks };
}
