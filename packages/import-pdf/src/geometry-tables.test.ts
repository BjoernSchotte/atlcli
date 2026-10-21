/**
 * Untagged table recovery from vector rulings and text alignment: the
 * accepted shapes and the fail-closed cases. Real producer output is covered
 * by the `untagged-word` quality fixture.
 */
import { describe, expect, it } from "bun:test";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";
import { normalizeUntaggedPdfFactsV2 } from "./untagged.js";
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

/** A PDF with one Helvetica text and filled-rectangle content stream per page, in points (595 x 842). */
function pagesPdf(pages: Array<{ rects: Array<[number, number, number, number]>; texts: Array<[string, number, number]>; raw?: string[] }>): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, { rects, texts, raw = [] }] of pages.entries()) {
    const content = [
      ...rects.map(([x, y, w, h]) => `${x} ${y} ${w} ${h} re f`),
      ...texts.map(([text, x, y]) => `BT /F1 11 Tf ${x} ${y} Td (${text}) Tj ET`),
      ...raw,
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

async function normalizePdf(bytes: Uint8Array) {
  const { facts, factsDigest } = await (await createNodePdfiumFactsAdapterV2()).analyze(bytes);
  return normalizeUntaggedPdfFactsV2(facts, factsDigest);
}

const tables = (result: Awaited<ReturnType<typeof normalizePdf>>) =>
  result.document.blocks.filter((block) => block.type === "table");
const tableTexts = (table: ReturnType<typeof tables>[number]) => table.type === "table"
  ? table.rows.map((row) => row.cells.map((cell) => cell.blocks.map((block) =>
      block.type === "paragraph" ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : "").join("/")))
  : [];

/**
 * A Word-style table without outer side borders: full-width row rules from
 * x 60 to 460 and column rules at 160, 260, 360 between `top` and `bottom`.
 * Rows are 24 points high; `rows` hold the cell texts, top row first.
 */
function openSidedTable(rows: string[][], top: number, rules: { topRule: boolean; verticalTop?: number }) {
  const bottom = top - rows.length * 24;
  const ys = Array.from({ length: rows.length + 1 }, (_, index) => top - index * 24)
    .filter((y, index) => index > 0 || rules.topRule);
  const verticalTop = rules.verticalTop ?? top;
  return {
    rects: [
      ...ys.map((y) => [60, y, 400, 0.5] as [number, number, number, number]),
      ...[160, 260, 360].map((x) => [x, bottom, 0.5, verticalTop - bottom] as [number, number, number, number]),
    ],
    texts: rows.flatMap((cells, row) => cells.flatMap((text, column) =>
      text ? [[text, 66 + column * 100, top - row * 24 - 16] as [string, number, number]] : []
    )),
  };
}

describe("open-sided and continued ruled tables", () => {
  it("implies the side borders a Word table omits", async () => {
    const result = await normalizePdf(pagesPdf([openSidedTable([
      ["Item", "Owner", "Due", "State"],
      ["Alpha", "North", "May", "Open"],
      ["Beta", "South", "June", "Done"],
    ], 700, { topRule: true })]));

    expect(result.requiresFallbackPages).toEqual([]);
    expect(tables(result).map(tableTexts)).toEqual([[
      ["Item", "Owner", "Due", "State"],
      ["Alpha", "North", "May", "Open"],
      ["Beta", "South", "June", "Done"],
    ]]);
  });

  it("continues a row split by a page break in the same cells", async () => {
    // Regression: the continued page has no top rule, so its grid was not
    // closed, and the rest of the split row became a row of its own.
    const first = openSidedTable([["Item", "Owner", "Due", "State"], ["Alpha", "North", "May", "Open"]], 120, { topRule: true });
    const next = openSidedTable([["", "region", "", ""], ["Beta", "South", "June", "Done"], ["Gamma", "East", "July", "Open"]], 790, { topRule: false, verticalTop: 814 });
    const result = await normalizePdf(pagesPdf([first, next]));

    expect(result.requiresFallbackPages).toEqual([]);
    expect(tables(result).map(tableTexts)).toEqual([[
      ["Item", "Owner", "Due", "State"],
      ["Alpha", "North region", "May", "Open"],
      ["Beta", "South", "June", "Done"],
      ["Gamma", "East", "July", "Open"],
    ]]);
  });

  it("reads a cell line whose second fragment sits a hair higher in line order", async () => {
    // Regression: cell fragments were sorted by raw y, so the higher right
    // fragment came before the start of its own line.
    const table = openSidedTable([["Item", "Owner", "Due", "State"], ["", "", "", ""], ["Beta", "South", "June", "Done"]], 700, { topRule: true });
    table.texts.push(["Alpha", 66, 668], ["one", 66, 656], ["two", 110, 656.4]);
    const result = await normalizePdf(pagesPdf([table]));

    expect(result.requiresFallbackPages).toEqual([]);
    expect(tables(result).map(tableTexts)[0]?.[1]?.[0]).toBe("Alpha one two");
  });

  it("keeps a whole native table whose first page falls back", async () => {
    // Regression: the table's blocks belonged to its first page; when that
    // page fell back, the rows on the following pages disappeared. Later the
    // fallback page's own rows were left to the page image only.
    const first = openSidedTable([["Item", "Owner", "Due", "State"], ["Alpha", "North", "May", "Open"]], 120, { topRule: true });
    const next = openSidedTable([["Beta", "South", "June", "Done"], ["Gamma", "East", "July", "Open"], ["Delta", "West", "May", "Done"]], 790, { topRule: true });
    const result = await normalizePdf(pagesPdf([
      // Rotated text sends the first page to a fallback.
      { ...first, raw: ["BT /F1 11 Tf 0 1 -1 0 520 400 Tm (Rotated margin note) Tj ET"] },
      next,
    ]));

    expect(result.requiresFallbackPages).toEqual([0]);
    expect(tables(result).map(tableTexts)).toEqual([[
      ["Item", "Owner", "Due", "State"],
      ["Alpha", "North", "May", "Open"],
      ["Beta", "South", "June", "Done"],
      ["Gamma", "East", "July", "Open"],
      ["Delta", "West", "May", "Done"],
    ]]);
  });
});

describe("linearized alignment-only tables", () => {
  // Columns drift by 12 points from row to row: too loose for a borderless
  // table, aligned enough to be linearized with a rendered crop.
  const rows = [["Plot", "Apples", "Pears"], ["North", "12", "8"], ["South", "9", "11"]];
  const alignedTexts = (top: number, pitch = 20) => rows.flatMap((cells, row) => cells.map((text, column) =>
    [text, 70 + column * 150 + (row % 2) * 12, top - row * pitch] as [string, number, number]
  ));

  it("keeps the rest of the page native around a linearized table", async () => {
    const result = await normalizePdf(pagesPdf([{ rects: [], texts: [
      ["Neutral introduction paragraph.", 70, 700],
      ...alignedTexts(640),
      ["Neutral closing paragraph.", 70, 520],
    ] }]));

    expect(result.requiresFallbackPages).toEqual([]);
    expect(result.document.issues.some((issue) => issue.code === "pdf-import/table-alignment-only-linearized")).toBe(true);
    expect(result.document.blocks.map((block) =>
      block.type === "paragraph" ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : block.type
    )).toEqual([
      "Neutral introduction paragraph.",
      "Plot | Apples | Pears", "North | 12 | 8", "South | 9 | 11",
      "Neutral closing paragraph.",
    ]);
  });

  it("falls back when other text lies inside the table region", async () => {
    const result = await normalizePdf(pagesPdf([{ rects: [], texts: [
      ...alignedTexts(640, 40),
      ["A note between the rows", 70, 620],
    ] }]));

    expect(result.requiresFallbackPages).toEqual([0]);
  });
});
