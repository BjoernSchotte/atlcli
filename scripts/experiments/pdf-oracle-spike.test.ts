import { describe, expect, it } from "bun:test";
import {
  assessArchitecture,
  compareTokenMultisets,
  normalizedTokens,
  roleCountDelta,
  type PdfBoxStructureOracle,
  type PdfPlumberGeometryOracle,
  type PdfiumImportSummary,
} from "./pdf-oracle-spike.js";

function current(overrides: Partial<PdfiumImportSummary> = {}): PdfiumImportSummary {
  return {
    schema: "atlcli.pdfium-import-summary/1",
    engine: "pdfium test",
    classification: "tagged",
    tagged: true,
    pages: 2,
    structureRoleCounts: { Document: 1, Table: 1, TR: 2, TH: 2, TD: 2 },
    unresolvedStructureKids: 0,
    blocks: { table: 1 },
    tables: [{ rows: 2, cells: 4, headerCells: 2, emptyCells: 0, rowCellCounts: [2, 2] }],
    pageFallbacks: 0,
    regionFallbacks: 0,
    unresolvedBoundaries: 0,
    unownedCharacters: 0,
    duplicateOwnershipAttempts: 0,
    issueCodes: {},
    factsTextTokens: 4,
    semanticTextTokens: 4,
    ...overrides,
  };
}

function pdfbox(overrides: Partial<PdfBoxStructureOracle> = {}): PdfBoxStructureOracle {
  return {
    schema: "atlcli.pdfbox-structure-oracle/1",
    engine: "PDFBox test",
    pages: 2,
    tagged: true,
    nodeCount: 8,
    kidCounts: { element: 7, mcid: 4, object: 0, unknown: 0 },
    cycleCount: 0,
    crossPageElementEdgeCount: 1,
    roleCounts: { Document: 1, Table: 1, TR: 2, TH: 2, TD: 2 },
    materializedCellCount: 4,
    materializedMcidReferenceCount: 4,
    materializedTextTokens: 4,
    tables: [{
      index: 0,
      rowCount: 2,
      cellCount: 4,
      headerCellCount: 2,
      dataCellCount: 2,
      emptyCellCount: 0,
      unresolvedCellCount: 0,
      pages: [0, 1],
      rowCellCounts: [2, 2],
    }],
    ...overrides,
  };
}

function pdfplumber(lineTableCount = 0): PdfPlumberGeometryOracle {
  return {
    schema: "atlcli.pdfplumber-geometry-oracle/1",
    engine: "pdfplumber test",
    pages: [{
      pageIndex: 0,
      characterCount: 10,
      lineCount: 4,
      rectangleCount: 0,
      curveCount: 0,
      lineTables: Array.from({ length: lineTableCount }, () => ({
        bbox: [0, 0, 10, 10],
        rows: 2,
        columns: 2,
        emptyCells: 0,
      })),
      textTables: [],
    }],
  };
}

describe("temporary PDF oracle architecture spike", () => {
  it("compares Unicode token multisets without exposing source text in the result", () => {
    expect(normalizedTokens("Äpfel, Öl 42")).toEqual(["äpfel", "öl", "42"]);
    expect(compareTokenMultisets("alpha beta beta", "alpha beta gamma")).toEqual({
      precision: 2 / 3,
      recall: 2 / 3,
    });
  });

  it("measures role-count disagreement without engine-specific identifiers", () => {
    expect(roleCountDelta({ Table: 1, TD: 3 }, { Table: 1, TD: 2, TH: 1 })).toBe(2);
    expect(roleCountDelta({ Table: 1 }, { Table: 1 })).toBe(0);
  });

  it("recognizes a full-document multi-page table as useful independent evidence", () => {
    const result = assessArchitecture({
      current: current(),
      pdfbox: pdfbox(),
      pdfplumber: pdfplumber(),
      comparisons: {
        pdfiumFactsVsPopplerTokenPrecision: 1,
        pdfiumFactsVsPopplerTokenRecall: 1,
        semanticVsPopplerTokenPrecision: 1,
        semanticVsPopplerTokenRecall: 1,
        pdfboxLogicalTables: 1,
        pdfboxMultiPageTables: 1,
        pdfboxTableMcidReferencesCoveredByPdfiumFacts: 1,
        pdfboxTableTokensCoveredByPdfiumFacts: 1,
        pdfboxTableTokensCoveredByCurrentSemantics: 1,
        pdfplumberLineTables: 0,
        currentEditableTables: 1,
      },
    });
    expect(result.carries).toBe(true);
    expect(result.findings).toContain("oracle/full-document-multipage-table-visible");
  });

  it("reports complementary structure and geometry advantages without majority voting", () => {
    const result = assessArchitecture({
      current: current({
        tables: [],
        unresolvedStructureKids: 1,
        pageFallbacks: 1,
      }),
      pdfbox: pdfbox({
        tables: [pdfbox().tables[0]!, { ...pdfbox().tables[0]!, index: 1, pages: [1] }],
      }),
      pdfplumber: pdfplumber(2),
      comparisons: {
        pdfiumFactsVsPopplerTokenPrecision: 1,
        pdfiumFactsVsPopplerTokenRecall: 1,
        semanticVsPopplerTokenPrecision: 1,
        semanticVsPopplerTokenRecall: 0.9,
        pdfboxLogicalTables: 2,
        pdfboxMultiPageTables: 1,
        pdfboxTableMcidReferencesCoveredByPdfiumFacts: 0.75,
        pdfboxTableTokensCoveredByPdfiumFacts: 1,
        pdfboxTableTokensCoveredByCurrentSemantics: 0.5,
        pdfplumberLineTables: 2,
        currentEditableTables: 0,
      },
    });
    expect(result.carries).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      "oracle/full-structure-table-advantage",
      "oracle/local-grid-advantage",
      "oracle/full-structure-resolves-pdfium-gap",
      "oracle/cross-engine-mcid-coverage-gap",
      "current/visual-fallback-present",
      "current/semantic-token-delta-needs-semantic-oracle",
    ]));
  });
});
