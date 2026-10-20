/**
 * Production tagged lane on the full-document structure tree (PIQ-13 to PIQ-15):
 * multi-page tables, repeated headers, empty and omitted cells, spans across
 * page breaks, and the nested-table negative.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type { ImportBlock } from "@atlcli/import-core";
import { normalizeHybridPdfFactsV2 } from "./hybrid.js";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";
import { charactersForOrderedMcidsV2 } from "./text.js";
import type { PdfPageFactsV2, PdfStructureNodeFactV2 } from "./contracts.js";
import { projectTaggedLogicalTableV2 } from "./tables.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures/struct-tree");

async function hybrid(name: string) {
  const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, name)));
  const { facts, factsDigest } = await (await createNodePdfiumFactsAdapterV2()).analyze(bytes);
  return { facts, semantics: await normalizeHybridPdfFactsV2(facts, factsDigest) };
}

type Table = Extract<ImportBlock, { type: "table" }>;
const tables = (blocks: readonly ImportBlock[]) => blocks.filter((block): block is Table => block.type === "table");
const cellText = (cell: Table["rows"][number]["cells"][number]) =>
  cell.blocks.map((block) => block.type === "paragraph" ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : "").join(" / ");
const rowText = (table: Table, row: number) => table.rows[row]!.cells.map(cellText);

describe("tagged lane on the full-document structure tree", () => {
  it("imports a three-page table with a repeated header as one native table without fallbacks", async () => {
    const { facts, semantics } = await hybrid("browser-multipage-table.pdf");
    expect(facts.structureSource).toBe("document-tree");
    expect(semantics.pageOutcomes.every((page) => page.mode === "hybrid-native")).toBe(true);
    const [inventory, second] = tables(semantics.document.blocks);
    expect(tables(semantics.document.blocks)).toHaveLength(2);
    expect(inventory!.rows).toHaveLength(71);
    // The repeated page header is kept once; its repetitions are owned, not dropped.
    expect(inventory!.rows[0]!.cells.map((cell) => [cell.header, cellText(cell)])).toEqual([
      [true, "Name"], [true, ""], [true, "Notes"],
    ]);
    expect(rowText(inventory!, 1)).toEqual(["Item 1", "Value 1", "Note 1"]);
    // The producer omitted the empty cell's element; /Headers places the others.
    expect(rowText(inventory!, 7)).toEqual(["Item 7", "", "Note 7"]);
    expect(rowText(inventory!, 5)[2]).toBe("Wrapped note 5 (see item 5); continues, with punctuation: done.");
    expect(rowText(inventory!, 70)).toEqual(["Item 70", "Value 70", "Wrapped note 70 (see item 70); continues, with punctuation: done."]);
    expect(second!.rows[0]!.cells.map((cell) => [cell.rowspan ?? 1, cell.colspan ?? 1])).toEqual([[2, 1], [1, 2]]);
    expect(semantics.document.issues.filter((issue) => issue.code === "pdf-import/table-continuation-joined")).toHaveLength(1);
  });

  it("keeps a row span that crosses a page break and visual order in left-to-right cells", async () => {
    const { semantics } = await hybrid("browser-rowspan-break.pdf");
    // The figure page repairs non-table residue locally; no page needs a fallback.
    expect(semantics.pageOutcomes.every((page) => page.fallbackScope === "none")).toBe(true);
    const [table] = tables(semantics.document.blocks);
    expect(table!.rows).toHaveLength(46);
    expect(table!.rows[20]!.cells[0]).toMatchObject({ rowspan: 6 });
    expect(rowText(table!, 20)).toEqual(["Spanning group", "Row 20", "漢字 20"]);
    expect(rowText(table!, 21)).toEqual(["Row 21", "Text 21"]);
    expect(rowText(table!, 22)).toEqual(["Row 22", "مرحبا 22"]);
    expect(rowText(table!, 30)).toEqual(["Merged", "Spanning two columns"]);
    expect(table!.rows[30]!.cells[1]).toMatchObject({ colspan: 2 });
  });

  it("keeps item text before a nested list, empty items and spaced dashes at line wraps", async () => {
    const { semantics } = await hybrid("browser-list-patterns.pdf");
    expect(semantics.pageOutcomes.every((page) => page.mode === "hybrid-native")).toBe(true);
    const list = semantics.document.blocks.find((block) => block.type === "list");
    const texts = (items: Extract<ImportBlock, { type: "list" }>["items"]): unknown[] => items.map((item) => [
      item.blocks.map((block) => block.type === "paragraph" ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : ""),
      ...(item.child ? [texts(item.child.items)] : []),
    ]);
    expect(list?.type === "list" ? texts(list.items) : null).toEqual([
      [["Parent item text"], [[["Child one"]], [["Child two"]]]],
      [[""]],
      [["Last item"]],
    ]);
    const paragraph = semantics.document.blocks.find((block) => block.type === "paragraph");
    expect(paragraph?.type === "paragraph" ? paragraph.runs.map((run) => run.kind === "text" ? run.text : "").join("") : null)
      .toBe("Alpha beta gamma – delta epsilon.");
  });

  it("fails closed for a nested table instead of emitting a silent native grid", async () => {
    const { semantics } = await hybrid("browser-hard-table.pdf");
    expect(tables(semantics.document.blocks)).toHaveLength(0);
    expect(semantics.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/table-tagged-linearized",
      context: expect.objectContaining({ reason: "cell-evidence" }),
    }));
  });
});

describe("visual order inside one marked-content sequence", () => {
  const glyph = (value: string, index: number, x: number): PdfPageFactsV2["characters"][number] => ({
    index,
    unicode: value.codePointAt(0)!,
    value,
    bbox: { x, y: 0.1, width: 0.009, height: 0.02 },
    fontSizePoints: 11,
    fontWeight: 400,
    angleRadians: 0,
    mcid: 7,
    textRunId: "pdf:p0:text-run:0",
    generated: false,
    hyphen: false,
    unicodeMapError: false,
  });
  const page = (characters: PdfPageFactsV2["characters"]) => ({ characters } as PdfPageFactsV2);
  const order = (characters: PdfPageFactsV2["characters"]) =>
    charactersForOrderedMcidsV2(page(characters), [7]).map((character) => character.value).join("");

  it("reorders a left-to-right line whose glyphs were emitted out of visual order", () => {
    expect(order([glyph("2", 0, 0.30), glyph(" ", 1, 0.28), glyph("R", 2, 0.10), glyph("o", 3, 0.12), glyph("w", 4, 0.14)]))
      .toBe("Row 2");
  });

  it("keeps source order whenever the sequence contains right-to-left text", () => {
    expect(order([glyph("م", 0, 0.30), glyph("ر", 1, 0.28), glyph("2", 2, 0.10)])).toBe("مر2");
  });
});

describe("logical table projection across pages", () => {
  // Minimal page facts: one word per cell, each cell's text under its own MCID.
  const pageWith = (index: number, words: string[]): PdfPageFactsV2 => {
    let at = 0;
    const characters = words.flatMap((text, mcid) => [...text].map((value, offset) => ({
      index: at++,
      unicode: value.codePointAt(0)!,
      value,
      bbox: { x: 0.1 + (mcid % 2) * 0.4 + offset * 0.012, y: 0.1 + Math.floor(mcid / 2) * 0.05, width: 0.01, height: 0.02 },
      fontSizePoints: 11,
      fontWeight: 400,
      angleRadians: 0,
      mcid,
      textRunId: `pdf:p${index}:text-run:${mcid}`,
      generated: false,
      hyphen: false,
      unicodeMapError: false,
    })));
    return { index, rotation: 0, characters, annotations: [] } as unknown as PdfPageFactsV2;
  };
  const node = (pageIndex: number, logicalId: string, type: string, kids: PdfStructureNodeFactV2["kids"]): PdfStructureNodeFactV2 => ({
    id: `pdf:p${pageIndex}:struct:${logicalId}`,
    logicalId,
    type,
    title: "",
    alt: "",
    actualText: "",
    language: "",
    elementId: "",
    directMcids: kids.flatMap((kid) => kid.kind === "mcid" ? [kid.mcid] : []),
    kids,
    attributes: [],
  });
  const row = (pageIndex: number, logicalId: string, role: "TH" | "TD", mcids: [number, number]) =>
    node(pageIndex, logicalId, "TR", mcids.map((mcid, index) => ({
      kind: "element" as const,
      index,
      node: node(pageIndex, `${logicalId}c${index}`, role, [{ kind: "mcid", index: 0, mcid }]),
    })));
  const table = (pageIndex: number, rows: PdfStructureNodeFactV2[]) =>
    node(pageIndex, "t", "Table", rows.map((r, index) => ({ kind: "element" as const, index, node: r })));

  it("folds a header re-tagged as a new row on the continuation page into the first header", () => {
    const first = pageWith(0, ["Name", "Value", "A", "1"]);
    const second = pageWith(1, ["Name", "Value", "B", "2"]);
    const projection = projectTaggedLogicalTableV2([
      { page: first, table: table(0, [row(0, "h", "TH", [0, 1]), row(0, "r1", "TD", [2, 3])]), corruptMcids: new Set() },
      { page: second, table: table(1, [row(1, "h2", "TH", [0, 1]), row(1, "r2", "TD", [2, 3])]), corruptMcids: new Set() },
    ]);
    const block = projection?.blocks[0];
    expect(block?.type === "table" ? block.rows.map((r) => r.cells.map((c) => [c.header, c.blocks.length])) : null)
      .toEqual([[[true, 1], [true, 1]], [[false, 1], [false, 1]], [[false, 1], [false, 1]]]);
    // The repeated header's characters stay owned on its own page.
    expect(projection?.pageClaims?.find((claim) => claim.pageIndex === 1)?.characterIndexes).toHaveLength(11);
  });

  it("keeps a differing header on the continuation page as a row", () => {
    const projection = projectTaggedLogicalTableV2([
      { page: pageWith(0, ["Name", "Value", "A", "1"]), table: table(0, [row(0, "h", "TH", [0, 1]), row(0, "r1", "TD", [2, 3])]), corruptMcids: new Set() },
      { page: pageWith(1, ["Name", "Total", "B", "2"]), table: table(1, [row(1, "h2", "TH", [0, 1]), row(1, "r2", "TD", [2, 3])]), corruptMcids: new Set() },
    ]);
    const block = projection?.blocks[0];
    expect(block?.type === "table" ? block.rows.length : null).toBe(4);
  });
});
