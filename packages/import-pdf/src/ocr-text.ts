import type { ImportBlock, ImportDocumentV2, ImportIssue } from "@atlcli/import-core";
import type { PdfFactsV2 } from "./contracts.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";

/**
 * A scan stays a page image; its invisible OCR layer is the scanner's
 * guess, not source text. It is attached after the page image's caption as
 * a collapsed block of lines, so the page can be searched and copied from,
 * and is reported as unverified.
 */
export function attachPdfOcrTextV2(facts: PdfFactsV2, document: ImportDocumentV2): ImportDocumentV2 {
  const issues: ImportIssue[] = [];
  // Block id after which a page's OCR text follows: the caption, or the image.
  const anchors = new Map<string, number>();
  for (const block of document.blocks) {
    if (block.type !== "image" || block.presentation !== "page-fallback") continue;
    const pageRef = block.sourceRefs?.find((ref) => /^pdf:p\d+$/u.test(ref));
    if (pageRef) anchors.set(block.captionBlockId ?? block.id, Number(pageRef.slice("pdf:p".length)));
  }
  const blocks = document.blocks.flatMap((block): ImportBlock[] => {
    const pageIndex = anchors.get(block.id);
    const page = pageIndex === undefined ? undefined : facts.pages[pageIndex];
    if (pageIndex === undefined || !page) return [block];
    const layer = { ...page, characters: page.characters.filter((character) => character.invisible || character.generated) };
    if (!layer.characters.some((character) => character.invisible)) return [block];
    const lines = new Map<number, string[]>();
    for (const fragment of analyzeGeometryReadingOrderV2(layer, new Set()).ordered) {
      if (fragment.text.trim()) lines.set(fragment.physicalLineIndex, [...lines.get(fragment.physicalLineIndex) ?? [], fragment.text.trim()]);
    }
    if (lines.size === 0) return [block];
    const id = `pdf:p${pageIndex}:ocr-text`;
    issues.push({
      code: "pdf-import/ocr-text-attached",
      severity: "info",
      outcome: "approximated",
      message: "The scan's OCR text layer is attached unverified beside the page image; it may contain recognition errors.",
      sourceRefs: [`pdf:p${pageIndex}`],
      context: { pageIndex, lines: lines.size },
    });
    return [block, {
      id,
      type: "disclosure",
      title: `Recognized text (OCR, unverified) — source page ${pageIndex + 1}`,
      blocks: [...lines.values()].map((line, index) => ({
        id: `${id}:line:${index}`,
        type: "paragraph",
        runs: [{ kind: "text", text: line.join(" ") }],
        sourceRefs: [`pdf:p${pageIndex}`],
      })),
      sourceRefs: [`pdf:p${pageIndex}`],
    }];
  });
  return issues.length === 0 ? document : { ...document, blocks, issues: [...document.issues, ...issues] };
}
