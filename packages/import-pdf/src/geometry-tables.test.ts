/**
 * Untagged table recovery from vector rulings and text alignment: the
 * accepted shapes and the fail-closed cases. Real producer output is covered
 * by the `untagged-word` quality fixture.
 */
import { describe, expect, it } from "bun:test";
import type { PdfNormalizedRect, PdfPageFactsV2, PdfPathObjectFact, PdfTextCharacterFactV2 } from "./contracts.js";
import { detectGeometryGridsV2, geometryDecorationPathIdsV2 } from "./geometry-tables.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";

interface Text { text: string; x: number; y: number; bold?: boolean }

function page(texts: readonly Text[], boxes: readonly PdfNormalizedRect[]): PdfPageFactsV2 {
  const characters: PdfTextCharacterFactV2[] = [];
  for (const [run, item] of texts.entries()) {
    for (const [offset, value] of [...item.text].entries()) {
      characters.push({
        index: characters.length,
        unicode: value.codePointAt(0)!,
        value,
        bbox: { x: item.x + offset * 0.012, y: item.y, width: 0.011, height: 0.016 },
        fontSizePoints: 11,
        fontWeight: item.bold ? 700 : 400,
        angleRadians: 0,
        mcid: null,
        textRunId: `run:${run}`,
        generated: false,
        hyphen: false,
        unicodeMapError: false,
      });
    }
  }
  const paths: PdfPathObjectFact[] = boxes.map((bbox, index) => ({
    id: `path:${index}`, mcid: null, bbox, segmentCount: 5, fillMode: 2, stroke: false,
  }));
  return {
    index: 0,
    widthPoints: 600,
    heightPoints: 800,
    boxes: { bounding: null, media: null, crop: null, bleed: null, trim: null, art: null },
    rotation: 0,
    kind: "digital",
    text: characters.map((character) => character.value).join(""),
    characters,
    images: [],
    paths,
    annotations: [],
    structures: [],
  } as unknown as PdfPageFactsV2;
}

const T = 0.001; // ruling thickness
const h = (y: number, x0: number, x1: number) => ({ x: x0, y, width: x1 - x0, height: T });
const v = (x: number, y0: number, y1: number) => ({ x, y: y0, width: T, height: y1 - y0 });
const grids = (facts: PdfPageFactsV2) => detectGeometryGridsV2(facts, analyzeGeometryReadingOrderV2(facts));
const cellTexts = (facts: PdfPageFactsV2) => grids(facts)[0]?.cells.map((cell) =>
  [cell.row, cell.column, cell.rowspan, cell.colspan, cell.fragments.map((fragment) => fragment.text).join(" ")]
);

// A 2 x 2 grid from x 0.1 to 0.7 and y 0.2 to 0.3.
const frame = [h(0.2, 0.1, 0.7), h(0.3, 0.1, 0.7), v(0.1, 0.2, 0.3), v(0.7, 0.2, 0.3)];
const inner = [h(0.25, 0.1, 0.7), v(0.4, 0.2, 0.3)];
const texts: Text[] = [
  { text: "Name", x: 0.11, y: 0.215, bold: true }, { text: "Value", x: 0.41, y: 0.215, bold: true },
  { text: "Alpha", x: 0.11, y: 0.265 }, { text: "12", x: 0.41, y: 0.265 },
];

describe("ruled tables", () => {
  it("reads a closed grid with a bold header row", () => {
    const facts = page(texts, [...frame, ...inner]);
    expect(cellTexts(facts)).toEqual([
      [0, 0, 1, 1, "Name"], [0, 1, 1, 1, "Value"], [1, 0, 1, 1, "Alpha"], [1, 1, 1, 1, "12"],
    ]);
    expect(grids(facts)[0]!.headerRows).toBe(1);
  });

  it("merges cells where no separator is drawn", () => {
    const facts = page([{ text: "Spanning title", x: 0.11, y: 0.215 }, ...texts.slice(2)], [...frame, h(0.25, 0.1, 0.7), v(0.4, 0.25, 0.3)]);
    expect(cellTexts(facts)).toEqual([
      [0, 0, 1, 2, "Spanning title"], [1, 0, 1, 1, "Alpha"], [1, 1, 1, 1, "12"],
    ]);
  });

  it("rejects a grid whose frame is open", () => {
    // The bottom rule covers only half the width.
    expect(grids(page(texts, [frame[0]!, h(0.3, 0.1, 0.4), frame[2]!, frame[3]!, ...inner]))).toEqual([]);
  });

  it("reads a grid without a right border as a table ruled by rows", () => {
    expect(grids(page(texts, [frame[0]!, frame[1]!, frame[2]!, ...inner]))[0]).toMatchObject({ rowCount: 2, columnCount: 2 });
  });

  it("splits text that runs across a drawn cell edge", () => {
    // Narrow padding: "Alpha" ends in the first column, "Beta" starts in the second.
    const facts = page([{ text: "AlphaBeta", x: 0.34, y: 0.265 }, ...texts.slice(0, 2)], [...frame, ...inner]);
    const cells = cellTexts(facts)!;
    expect(cells.find((cell) => cell[0] === 1 && cell[1] === 0)?.[4]).toBe("Alpha");
    expect(cells.find((cell) => cell[0] === 1 && cell[1] === 1)?.[4]).toBe("Beta");
  });

  it("rejects a glyph that sits on a cell edge", () => {
    // The glyph centre is exactly on the column edge at x 0.4.
    const facts = page([{ text: "X", x: 0.4 - 0.0055, y: 0.265 }, ...texts.slice(0, 2)], [...frame, ...inner]);
    expect(grids(facts)).toEqual([]);
  });
});

describe("tables ruled by rows only", () => {
  // Word draws such tables with a left bar that connects the rules.
  const rules = [h(0.2, 0.1, 0.8), h(0.25, 0.1, 0.8), h(0.33, 0.1, 0.8), h(0.38, 0.1, 0.8), v(0.1, 0.2, 0.38)];

  it("does not join unconnected horizontal rules into a table", () => {
    const facts = page([
      { text: "Term", x: 0.11, y: 0.215 }, { text: "Meaning", x: 0.4, y: 0.215 },
      { text: "Alpha", x: 0.11, y: 0.265 }, { text: "one", x: 0.4, y: 0.265 },
    ], rules.slice(0, 4));
    expect(grids(facts).filter((grid) => grid.kind === "ruled")).toEqual([]);
  });

  it("takes columns from shared left edges and keeps a wrapped cell in one row", () => {
    const facts = page([
      { text: "Term", x: 0.11, y: 0.215, bold: true }, { text: "Meaning", x: 0.4, y: 0.215, bold: true },
      { text: "Alpha", x: 0.11, y: 0.265 }, { text: "first line", x: 0.4, y: 0.265 }, { text: "wrapped line", x: 0.4, y: 0.29 },
      { text: "Beta", x: 0.11, y: 0.345 }, { text: "single", x: 0.4, y: 0.345 },
    ], rules);
    expect(cellTexts(facts)).toEqual([
      [0, 0, 1, 1, "Term"], [0, 1, 1, 1, "Meaning"],
      [1, 0, 1, 1, "Alpha"], [1, 1, 1, 1, "first line wrapped line"],
      [2, 0, 1, 1, "Beta"], [2, 1, 1, 1, "single"],
    ]);
  });

  it("splits a band into rows when every line starts in the first column", () => {
    const facts = page([
      { text: "Term", x: 0.11, y: 0.215, bold: true }, { text: "Meaning", x: 0.4, y: 0.215, bold: true },
      { text: "Alpha", x: 0.11, y: 0.265 }, { text: "one", x: 0.4, y: 0.265 },
      { text: "Gamma", x: 0.11, y: 0.29 }, { text: "two", x: 0.4, y: 0.29 },
      { text: "Beta", x: 0.11, y: 0.345 }, { text: "three", x: 0.4, y: 0.345 },
    ], rules);
    expect(cellTexts(facts)?.map((cell) => cell[4])).toEqual(["Term", "Meaning", "Alpha", "one", "Gamma", "two", "Beta", "three"]);
  });
});

describe("borderless tables", () => {
  const rows = (columns: number) => [0.2, 0.23, 0.26, 0.29].flatMap((y, row) =>
    Array.from({ length: columns }, (_, column) => ({ text: `R${row}C${column}`, x: 0.1 + column * 0.25, y, bold: row === 0 }))
  );

  it("accepts three aligned single-line columns", () => {
    const [grid] = grids(page(rows(3), []));
    expect(grid).toMatchObject({ kind: "aligned", rowCount: 4, columnCount: 3, headerRows: 1 });
  });

  it("does not take two aligned columns for a table", () => {
    expect(grids(page(rows(2), []))).toEqual([]);
  });
});

describe("decoration", () => {
  it("treats a box behind text as background and keeps an empty box", () => {
    const facts = page([{ text: "Note in a box", x: 0.12, y: 0.52 }], [
      { x: 0.1, y: 0.5, width: 0.5, height: 0.06 },
      { x: 0.1, y: 0.7, width: 0.2, height: 0.1 },
    ]);
    expect([...geometryDecorationPathIdsV2(facts, [])]).toEqual(["path:0"]);
  });
});
