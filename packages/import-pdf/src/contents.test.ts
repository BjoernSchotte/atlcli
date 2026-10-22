import { describe, expect, it } from "bun:test";
import { detectContentsV2 } from "./contents.js";
import type { PdfReadingOrderPageV2 } from "./reading-order.js";

/** A page from lines of [text, x] fragments; ids are `p<page>:l<line>:f<fragment>`. */
function page(index: number, lines: Array<Array<[string, number]>>): PdfReadingOrderPageV2 {
  const ordered = lines.flatMap((line, lineIndex) => line.map(([text, x], fragmentIndex) => ({
    id: `p${index}:l${lineIndex}:f${fragmentIndex}`,
    text,
    bbox: { x, y: lineIndex * 0.03, width: 0.1, height: 0.02 },
    physicalLineIndex: lineIndex,
  })));
  return { index, ordered, fragments: ordered } as unknown as PdfReadingOrderPageV2;
}

const body = page(1, [
  [["1 Introduction", 0.1]],
  [["2 A rather long section title that wraps", 0.1]],
  [["Appendix", 0.1]],
  [["3 Results", 0.1]],
  [["4 Outlook", 0.1]],
]);

describe("detectContentsV2", () => {
  it("proves a wrapped entry and an unnumbered entry on a contents page", () => {
    // Regression: the wrapped head and the unnumbered "Appendix" became headings.
    const contents = page(0, [
      [["Contents", 0.1]],
      [["1 Introduction", 0.1], ["2", 0.9]],
      [["2 A rather long section title", 0.1]],
      [["that wraps", 0.12], ["3", 0.9]],
      [["Appendix", 0.1]],
      [["3 Results", 0.1], ["5", 0.9]],
      [["4 Outlook", 0.1], ["7", 0.9]],
    ]);
    const result = detectContentsV2([contents, body], new Set());
    expect([...result.pageNumbers].sort()).toEqual(["p0:l1:f1", "p0:l3:f1", "p0:l5:f1", "p0:l6:f1"]);
    expect([...result.entries].sort()).toEqual(["p0:l1:f0", "p0:l2:f0", "p0:l3:f0", "p0:l4:f0", "p0:l5:f0", "p0:l6:f0"]);
  });

  it("leaves the page title and lines outside the entries alone", () => {
    const contents = page(0, [
      [["Introduction", 0.1]],
      [["1 Introduction", 0.1], ["2", 0.9]],
      [["3 Results", 0.1], ["5", 0.9]],
      [["4 Outlook", 0.1], ["7", 0.9]],
      [["Appendix", 0.1]],
    ]);
    const result = detectContentsV2([contents, page(1, [[["Introduction", 0.1]], ...body.ordered.map((fragment) => [[fragment.text, 0.1] as [string, number]])])], new Set());
    expect(result.entries.has("p0:l0:f0")).toBe(false);
    expect(result.entries.has("p0:l4:f0")).toBe(false);
  });

  it("ignores a numbered column whose text never repeats", () => {
    const table = page(0, [
      [["Apples", 0.1], ["2", 0.9]],
      [["Pears", 0.1], ["3", 0.9]],
      [["Plums", 0.1], ["5", 0.9]],
    ]);
    const result = detectContentsV2([table, body], new Set());
    expect(result.entries.size + result.pageNumbers.size).toBe(0);
  });
});
