import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { documentToAdf, documentToStorage, type ImportBlock } from "@atlcli/import-core";
import {
  type PdfPageFactsV1,
  type PdfStructureNodeFact,
  type PdfStructureNodeFactV2,
  type PdfTextCharacterFact,
} from "./contracts.js";
import { createNodePdfiumFactsAdapter, createNodePdfiumFactsAdapterV2 } from "./node.js";
import { normalizeTaggedPdfFacts, normalizeTaggedPdfFactsV2 } from "./normalize.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";
import { flattenStructureV2, structureRoleV2 } from "./structure.js";
import {
  analyzeUntaggedTableV2,
  collectTaggedTableRowsV2,
  projectTaggedTable,
  projectTaggedTableV2,
} from "./tables.js";
import { normalizeUntaggedPdfFacts, normalizeUntaggedPdfFactsV2 } from "./untagged.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");
const qualityFixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");

function tableBlock(blocks: readonly ImportBlock[]) {
  const table = blocks.find((block) => block.type === "table");
  if (!table || table.type !== "table") throw new Error("expected native table");
  return table;
}

function textRuns(block: ImportBlock): string {
  if (block.type === "paragraph" || block.type === "heading") {
    return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
  }
  return "";
}

function node(
  id: string,
  type: string,
  mcids: number[] = [],
  children: PdfStructureNodeFact[] = [],
  rowspan = 1,
  colspan = 1,
): PdfStructureNodeFact {
  return {
    id,
    type,
    title: "",
    alt: "",
    actualText: "",
    language: "",
    elementId: "",
    mcids,
    childMcids: mcids,
    attributes: type === "TH" || type === "TD" ? [
      { name: "O", type: 4, value: "Table" },
      { name: "RowSpan", type: 2, value: rowspan },
      { name: "ColSpan", type: 2, value: colspan },
    ] : [],
    children,
  };
}

function syntheticTaggedPage(table: PdfStructureNodeFact, values: readonly string[]): PdfPageFactsV1 {
  const characters: PdfTextCharacterFact[] = [];
  for (const [mcid, value] of values.entries()) {
    for (const [offset, character] of [...value].entries()) {
      characters.push({
        index: characters.length,
        unicode: character.codePointAt(0)!,
        value: character,
        bbox: { x: 0.1 + (mcid % 2) * 0.3 + offset * 0.01, y: 0.1 + mcid * 0.05, width: 0.009, height: 0.02 },
        fontSizePoints: 11,
        fontWeight: mcid === 0 ? 700 : 400,
        angleRadians: 0,
        mcid,
        generated: false,
        hyphen: false,
        unicodeMapError: false,
      });
    }
  }
  return {
    index: 0,
    widthPoints: 600,
    heightPoints: 800,
    boxes: { bounding: null, media: null, crop: null, bleed: null, trim: null, art: null },
    rotation: 0,
    kind: "digital",
    text: values.join(""),
    characters,
    structures: [table],
    objectTypeCounts: {},
    operatorSummary: { capability: "unavailable", count: null },
    images: [],
    paths: [],
    annotations: [],
  };
}

describe("PDF table reconstruction", () => {
  it("assembles every real V2 geometry table cell before publication", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "table-positive.pdf"))),
    );
    const result = await normalizeUntaggedPdfFactsV2(raw.facts, raw.factsDigest);
    const table = tableBlock(result.document.blocks);

    expect(table.rows.flatMap((row) => row.cells).map((cell) => textRuns(cell.blocks[0]!))).toEqual([
      "Plot", "Apples", "Pears", "North", "12", "8", "South", "9", "11",
    ]);
    expect(result.requiresFallbackPages).toEqual([]);
    expect(result.pageOutcomes[0]).toMatchObject({
      mode: "geometry-native",
      boundaryDecisionCount: 6,
      unresolvedBoundaryCount: 0,
    });
    expect(result.evidence.filter((item) =>
      item.decisionCode === "pdf/table-untagged-grid-cell-native"
    )).toHaveLength(9);
    expect(result.evidence.filter((item) =>
      item.decisionCode === "pdf/table-untagged-grid-cell-native"
    ).every((item) => item.boundaryDecisionIds.every((id) =>
      result.boundaries.some((boundary) => boundary.id === id)
    ))).toBe(true);
    expect(documentToStorage(result.document)).toContain(
      "<tr><td><p>Plot</p></td><td><p>Apples</p></td><td><p>Pears</p></td></tr>",
    );
  });

  it("rejects a painted grid when one segmented line has incomplete coverage", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "producer-word.pdf")),
    ));
    const page = raw.facts.pages[0]!;
    const incompletePage = {
      ...page,
      paths: page.paths.filter((path) => !(
        path.fillMode !== 0
        && path.bbox
        && path.bbox.x > 0.48
        && path.bbox.x < 0.51
        && path.bbox.y > 0.44
        && path.bbox.height > 0.02
      )),
    };
    const table = analyzeUntaggedTableV2(
      incompletePage,
      analyzeGeometryReadingOrderV2(incompletePage),
    );

    expect(table.mode).toBe("none");
    expect(table.blocks).toEqual([]);
  });

  it("routes every real V2 tagged cell through shared assembly evidence", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "complex-tagged.pdf"))),
    );
    const result = await normalizeTaggedPdfFactsV2(raw.facts, raw.factsDigest);
    const table = tableBlock(result.document.blocks);

    expect(table.rows.flatMap((row) => row.cells).map((cell) => textRuns(cell.blocks[0]!))).toEqual([
      "Plot", "Yield", "North", "Twelve",
    ]);
    expect(result.evidence.filter((item) =>
      item.decisionCode === "pdf/table-tagged-cell-native"
    )).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
      outcome: "native",
      boundaryDecisionIds: [],
    })));
    expect(documentToAdf(result.document).content[2]?.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
      "tableHeader", "tableHeader",
    ]);
    expect(documentToStorage(result.document)).toContain(
      "<tr><th><p>Plot</p></th><th><p>Yield</p></th></tr>",
    );
  });

  it("collects wrapped V2 rows in source order and defaults absent spans to one", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "independent-structures-tagged.pdf")),
    ));
    const page = raw.facts.pages[0]!;
    const tables = flattenStructureV2(page.structures).filter((candidate) =>
      structureRoleV2(candidate) === "Table"
    );
    const wrapped = tables[0]!;
    const collected = collectTaggedTableRowsV2(wrapped);
    const projection = projectTaggedTableV2(page, wrapped, new Set());
    const table = tableBlock(projection.blocks);

    expect(collected).toMatchObject({ valid: true, reason: "qualified" });
    expect(collected.rows.map((row) => structureRoleV2(row))).toEqual(["TR", "TR", "TR"]);
    expect(projection.mode).toBe("native");
    expect(table.rows.flatMap((row) => row.cells).map((cell) => textRuns(cell.blocks[0]!))).toEqual([
      "Zone", "Signal", "North", "Clear", "Summary", "Stable",
    ]);
    expect(table.rows.flatMap((row) => row.cells).every((cell) =>
      cell.rowspan === undefined && cell.colspan === undefined
    )).toBe(true);
    expect(documentToAdf({ blocks: projection.blocks }).content[0]?.content)
      .toHaveLength(3);
    expect(documentToStorage({ blocks: projection.blocks, assets: [] })).toContain(
      "<tr><td><p>Summary</p></td><td><p>Stable</p></td></tr>",
    );
  });

  it("rejects semantic wrapper content, nested tables, and rotated tagged grids", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const positive = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "independent-structures-tagged.pdf")),
    ));
    const positivePage = positive.facts.pages[0]!;
    const wrapped = flattenStructureV2(positivePage.structures).find((candidate) =>
      structureRoleV2(candidate) === "Table"
    )!;
    const contaminated = structuredClone(wrapped);
    const wrapper = flattenStructureV2([contaminated]).find((candidate) =>
      ["THead", "TBody", "TFoot"].includes(structureRoleV2(candidate))
    )!;
    wrapper.kids.push({ kind: "mcid", index: wrapper.kids.length, mcid: 999 });

    expect(collectTaggedTableRowsV2(contaminated)).toMatchObject({
      valid: false,
      reason: "row-wrapper-content",
    });
    expect(projectTaggedTableV2({ ...positivePage, rotation: 90 }, wrapped, new Set()).mode)
      .toBe("linearized-render-required");

    const negative = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "independent-negative-tagged.pdf")),
    ));
    const negativePage = negative.facts.pages[0]!;
    const nested = flattenStructureV2(negativePage.structures).find((candidate) =>
      structureRoleV2(candidate) === "Table"
    )!;
    const nestedProjection = projectTaggedTableV2(negativePage, nested, new Set());
    const linearized = nestedProjection.blocks.map(textRuns).join("\n");

    expect(nestedProjection.mode).toBe("linearized-render-required");
    expect(linearized.split("Outer")).toHaveLength(2);
    expect(linearized.split("Nested")).toHaveLength(2);

    const browser = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "producer-browser.pdf")),
    ));
    const browserTable = flattenStructureV2(browser.facts.pages[0]!.structures).find((candidate) =>
      structureRoleV2(candidate) === "Table"
    ) as PdfStructureNodeFactV2;
    expect(browserTable.directMcids.length).toBeGreaterThan(0);
    expect(collectTaggedTableRowsV2(browserTable).valid).toBe(true);
  });

  it("projects the real tagged table with header identity and exact target encodings", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const raw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "complex-tagged.pdf"))),
    );
    const result = await normalizeTaggedPdfFacts(raw.facts, raw.factsDigest);
    const table = tableBlock(result.document.blocks);

    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((row) => row.cells.length)).toEqual([2, 2]);
    expect(table.rows[0]?.cells.every((cell) => cell.header)).toBe(true);
    expect(table.rows[1]?.cells.every((cell) => !cell.header)).toBe(true);
    expect(table.rows.flatMap((row) => row.cells).map((cell) => textRuns(cell.blocks[0]!))).toEqual([
      "Plot", "Yield", "North", "Twelve",
    ]);
    const adf = documentToAdf(result.document);
    expect(adf.content[2]?.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
      "tableHeader", "tableHeader",
    ]);
    expect(documentToStorage(result.document)).toContain("<tr><th><p>Plot</p></th><th><p>Yield</p></th></tr>");
    expect(result.evidence.filter((item) => item.decisionCode === "pdf/table-tagged-cell-native")).toHaveLength(4);
  });

  it("accepts only a complete tagged span grid and preserves rowspan/colspan in ADF and Storage", () => {
    const table = node("table", "Table", [], [
      node("row-0", "TR", [], [node("head", "TH", [0], [], 1, 2)]),
      node("row-1", "TR", [], [node("left", "TD", [1], [], 2, 1), node("right-1", "TD", [2])]),
      node("row-2", "TR", [], [node("right-2", "TD", [3])]),
    ]);
    const projection = projectTaggedTable(
      syntheticTaggedPage(table, ["Header", "Left", "Upper", "Lower"]),
      table,
      new Set(),
    );
    const native = tableBlock(projection.blocks);

    expect(projection.mode).toBe("native");
    expect(native.rows[0]?.cells[0]).toMatchObject({ header: true, colspan: 2 });
    expect(native.rows[1]?.cells[0]).toMatchObject({ header: false, rowspan: 2 });
    const document = { blocks: projection.blocks, assets: [] };
    const adf = documentToAdf(document);
    expect(adf.content[0]?.content?.[0]?.content?.[0]?.attrs).toEqual({ colspan: 2 });
    expect(adf.content[0]?.content?.[1]?.content?.[0]?.attrs).toEqual({ rowspan: 2 });
    const storage = documentToStorage(document);
    expect(storage).toContain('<th colspan="2"><p>Header</p></th>');
    expect(storage).toContain('<td rowspan="2"><p>Left</p></td>');
  });

  it("linearizes malformed tagged grids without duplicated or lost cell text", () => {
    const table = node("table", "Table", [], [
      node("row-0", "TR", [], [node("a", "TH", [0]), node("b", "TH", [1])]),
      node("row-1", "TR", [], [node("c", "TD", [2])]),
    ]);
    const projection = projectTaggedTable(
      syntheticTaggedPage(table, ["Alpha", "Beta", "Gamma"]),
      table,
      new Set(),
    );
    const text = projection.blocks.map(textRuns).join("\n");

    expect(projection.mode).toBe("linearized-render-required");
    expect(projection.blocks.every((block) => block.type === "paragraph")).toBe(true);
    for (const token of ["Alpha", "Beta", "Gamma"]) expect(text.split(token)).toHaveLength(2);
    expect(projection.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/table-tagged-linearized",
      outcome: "approximated",
    }));
    expect(projection.evidence.every((item) => item.outcome === "approximated")).toBe(true);

    const invalidSpan = node("invalid-table", "Table", [], [
      node("invalid-row", "TR", [], [node("invalid-cell", "TH", [0])]),
    ]);
    invalidSpan.children[0]!.children[0]!.attributes.find((attribute) => attribute.name === "ColSpan")!.value = "2";
    expect(projectTaggedTable(
      syntheticTaggedPage(invalidSpan, ["Invalid span"]),
      invalidSpan,
      new Set(),
    ).mode).toBe("linearized-render-required");
  });

  it("promotes the real stroked rectangular grid but never alignment alone", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const positiveRaw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "table-positive.pdf"))),
    );
    const negativeRaw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "table-negative.pdf"))),
    );
    const positive = await normalizeUntaggedPdfFacts(positiveRaw.facts, positiveRaw.factsDigest);
    const negative = await normalizeUntaggedPdfFacts(negativeRaw.facts, negativeRaw.factsDigest);
    const native = tableBlock(positive.document.blocks);

    expect(positive.requiresFallbackPages).toEqual([]);
    expect(native.rows).toHaveLength(3);
    expect(native.rows.every((row) => row.cells.length === 3)).toBe(true);
    expect(native.rows.flatMap((row) => row.cells).map((cell) => textRuns(cell.blocks[0]!))).toEqual([
      "Plot", "Apples", "Pears", "North", "12", "8", "South", "9", "11",
    ]);
    expect(positive.evidence.some((item) => item.basis.includes("path-object") && item.outcome === "native")).toBe(true);
    expect(documentToAdf(positive.document).content.map((item) => item.type)).toEqual(["heading", "table"]);

    expect(negative.requiresFallbackPages).toEqual([0]);
    expect(negative.document.blocks.some((block) => block.type === "table")).toBe(false);
    expect(negative.document.blocks.map(textRuns)).toEqual([
      "Plot | Apples | Pears", "North | 12 | 8", "South | 9 | 11",
    ]);
    expect(negative.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/table-alignment-only-linearized",
      outcome: "approximated",
    }));
    expect(negative.evidence.filter((item) => item.decisionCode.includes("table"))
      .every((item) => item.outcome !== "native")).toBe(true);
  });
});
