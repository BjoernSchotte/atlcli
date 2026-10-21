import type { PdfGeometryFragmentV2, PdfReadingOrderPageV2 } from "./reading-order.js";

export interface PdfContentsV2 {
  /** Fragments of proven contents lines other than their page numbers. */
  entries: Set<string>;
  /** The trailing page numbers of those lines. */
  pageNumbers: Set<string>;
}

const letters = (value: string): string => value.toLocaleLowerCase("und").replace(/[^\p{L}]+/gu, "");

/**
 * Untagged exports set a table of contents in the heading styles it lists.
 * A contents line is a physical line ending in a page number at the right
 * whose letters also stand on a later page as a fragment or a line. A page
 * holds a table of contents when at least three lines prove so and their
 * numbers never decrease; a numbered column elsewhere repeats no later text.
 */
export function detectContentsV2(
  pages: readonly PdfReadingOrderPageV2[],
  suppressed: ReadonlySet<string>,
): PdfContentsV2 {
  const contents: PdfContentsV2 = { entries: new Set(), pageNumbers: new Set() };
  const lines = pages.map((page) => {
    const byLine = new Map<number, PdfGeometryFragmentV2[]>();
    for (const fragment of page.ordered) {
      if (suppressed.has(fragment.id)) continue;
      byLine.set(fragment.physicalLineIndex, [...byLine.get(fragment.physicalLineIndex) ?? [], fragment]);
    }
    return [...byLine.values()].map((line) => line.sort((left, right) => left.bbox.x - right.bbox.x));
  });
  const later: Array<Set<string>> = [];
  let seen = new Set<string>();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    later[index] = seen;
    seen = new Set([
      ...seen,
      ...lines[index]!.flatMap((line) => [letters(line.map((fragment) => fragment.text).join(" ")), ...line.map((fragment) => letters(fragment.text))]),
    ]);
  }
  for (const [index, pageLines] of lines.entries()) {
    const proven = pageLines.flatMap((line) => {
      const number = line.at(-1)!;
      const entry = line.slice(0, -1);
      const text = letters(entry.map((fragment) => fragment.text).join(" "));
      return entry.length > 0 && /^\d{1,4}$/u.test(number.text.trim()) && number.bbox.x > 0.5
        && text.length >= 3 && later[index]!.has(text)
        ? [{ entry, number }]
        : [];
    });
    const numbers = proven.map((line) => Number(line.number.text.trim()));
    if (proven.length < 3 || numbers.some((value, position) => position > 0 && value < numbers[position - 1]!)) continue;
    for (const line of proven) {
      for (const fragment of line.entry) contents.entries.add(fragment.id);
      contents.pageNumbers.add(line.number.id);
    }
  }
  return contents;
}
