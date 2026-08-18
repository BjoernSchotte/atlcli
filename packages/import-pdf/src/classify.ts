import type { PdfDocumentClassification, PdfPageFactsV1, PdfPageKind } from "./contracts.js";

export function classifyPdfPage(text: string, imageCount: number): PdfPageKind {
  const hasText = text.trim().length > 0;
  const hasImages = imageCount > 0;
  return hasText && hasImages ? "mixed" : hasText ? "digital" : hasImages ? "image-only" : "blank";
}

export function classifyPdfDocument(
  tagged: boolean,
  pages: readonly Pick<PdfPageFactsV1, "kind">[],
): PdfDocumentClassification {
  if (tagged) return "tagged";
  const kinds = new Set(pages.map((page) => page.kind));
  if (kinds.size === 1 && kinds.has("digital")) return "digital-untagged";
  if (kinds.size === 1 && kinds.has("image-only")) return "scan";
  if (kinds.size === 1 && kinds.has("blank")) return "blank";
  return "mixed";
}
