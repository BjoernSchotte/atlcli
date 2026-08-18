import type { PdfGeometryFragmentV1, PdfReadingOrderPageV1 } from "./reading-order.js";

function repeatedKey(fragment: PdfGeometryFragmentV1): string | null {
  const region = fragment.bbox.y < 0.1 ? "top" : fragment.bbox.y > 0.9 ? "bottom" : null;
  if (!region) return null;
  const normalized = fragment.text
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/\b\d+\b/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length >= 4 ? `${region}:${Math.round(fragment.bbox.x * 20)}:${normalized}` : null;
}

export function detectRepeatedRegions(pages: readonly PdfReadingOrderPageV1[]): Set<string> {
  const groups = new Map<string, PdfGeometryFragmentV1[]>();
  for (const page of pages) {
    for (const fragment of page.fragments) {
      const key = repeatedKey(fragment);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), fragment]);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const repeated = new Set<string>();
  for (const fragments of groups.values()) {
    const pageCount = new Set(fragments.map((fragment) => fragment.pageIndex)).size;
    if (pageCount < threshold) continue;
    for (const fragment of fragments) repeated.add(fragment.id);
  }
  return repeated;
}
