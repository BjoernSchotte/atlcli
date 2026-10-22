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
 * whose letters also stand on a later page as a fragment or a line; an entry
 * wrapped onto several lines is proven by the joined lines above its number.
 * A page holds a table of contents when at least three lines prove so and
 * their numbers never decrease; a numbered column elsewhere repeats no later
 * text. Between its first and last proven entry, an unnumbered line whose
 * letters stand on a later page is an entry without a page number.
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
  const textOf = (fragments: readonly PdfGeometryFragmentV2[]): string => letters(fragments.map((fragment) => fragment.text).join(" "));
  const later: Array<Set<string>> = [];
  let seen = new Set<string>();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    later[index] = seen;
    seen = new Set([...seen, ...lines[index]!.flatMap((line) => [textOf(line), ...line.map((fragment) => letters(fragment.text))])]);
  }
  for (const [index, pageLines] of lines.entries()) {
    const laterText = (fragments: readonly PdfGeometryFragmentV2[]): boolean => {
      const text = textOf(fragments);
      return text.length >= 3 && later[index]!.has(text);
    };
    const proven: Array<{ entry: PdfGeometryFragmentV2[]; number: PdfGeometryFragmentV2; first: number; last: number }> = [];
    // Unnumbered lines directly above the current one: a wrapped entry's head.
    let pending: PdfGeometryFragmentV2[][] = [];
    for (const [position, line] of pageLines.entries()) {
      const number = line.at(-1)!;
      const entry = line.slice(0, -1);
      if (!(/^\d{1,4}$/u.test(number.text.trim()) && number.bbox.x > 0.5)) {
        // ponytail: a wrapped entry spans at most three lines.
        pending = [...pending, line].slice(-2);
        continue;
      }
      const head = pending.findIndex((_, start) => laterText([...pending.slice(start).flat(), ...entry]));
      if (entry.length > 0 && laterText(entry)) proven.push({ entry, number, first: position, last: position });
      else if (head >= 0) proven.push({ entry: [...pending.slice(head).flat(), ...entry], number, first: position - pending.length + head, last: position });
      pending = [];
    }
    const numbers = proven.map((line) => Number(line.number.text.trim()));
    if (proven.length < 3 || numbers.some((value, position) => position > 0 && value < numbers[position - 1]!)) continue;
    const claimed = new Set(proven.flatMap((line) => Array.from({ length: line.last - line.first + 1 }, (_, offset) => line.first + offset)));
    for (let position = proven[0]!.first; position <= proven.at(-1)!.last; position += 1) {
      if (claimed.has(position) || !laterText(pageLines[position]!)) continue;
      for (const fragment of pageLines[position]!) contents.entries.add(fragment.id);
    }
    for (const line of proven) {
      for (const fragment of line.entry) contents.entries.add(fragment.id);
      contents.pageNumbers.add(line.number.id);
    }
  }
  return contents;
}
