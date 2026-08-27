import {
  type ImportBlock,
  type ImportIssue,
  type ImportRun,
  type ImportTableCell,
  type ImportTableRow,
} from "@atlcli/import-core";
import {
  PDF_TABLE_POLICY_REVISION,
  PDF_TABLE_POLICY_REVISION_V2,
  type PdfDecisionEvidenceV1,
  type PdfDecisionEvidenceV2,
  type PdfNormalizedRect,
  type PdfPageFactsV1,
  type PdfPageFactsV2,
  type PdfStructureAttributeFact,
  type PdfStructureNodeFact,
  type PdfStructureNodeFactV2,
} from "./contracts.js";
import {
  appendPdfTextAssemblyV2,
  pdfTextAssemblyConfidenceV2,
  pdfTextAssemblyIssuesV2,
  pdfTextAssemblyOutcomeV2,
  pdfTextBoundaryDecisionIdsV2,
} from "./assembly-evidence.js";
import { correlateTaggedTextWithLinksV2, taggedRuns, taggedRunsV2 } from "./links.js";
import type { PdfGeometryFragmentV1, PdfReadingOrderPageV1 } from "./reading-order.js";
import { structureChildrenV2, structureRole, structureRoleV2 } from "./structure.js";
import {
  correlateTaggedText,
  descendantMcids,
  orderedDescendantMcidsV2,
  unresolvedStructureKidIndexesV2,
  unionRects,
} from "./text.js";
import type { PdfTextBoundaryDecisionV2, PdfTextTransformationV2 } from "./text-assembly.js";

export const PDF_TABLE_POLICY_V1 = Object.freeze({
  maximumRows: 250,
  maximumColumns: 50,
  maximumSpan: 50,
  pathAxisTolerance: 0.004,
  gridJoinTolerance: 0.006,
  minimumGridWidth: 0.1,
  minimumGridHeight: 0.03,
  alignedRowTolerance: 0.015,
  alignedColumnTolerance: 0.03,
  minimumAlignedRows: 3,
  minimumAlignedColumns: 3,
  boldHeaderWeight: 600,
} as const);

export type PdfTableProjectionMode = "native" | "linearized-render-required" | "none";

export interface PdfTableProjectionV1 {
  mode: PdfTableProjectionMode;
  sourceId: string;
  pageIndex: number;
  bbox?: PdfNormalizedRect;
  fragmentIds: string[];
  blocks: ImportBlock[];
  evidence: PdfDecisionEvidenceV1[];
  issues: ImportIssue[];
  claimedCharacterIndexes: number[];
}

export interface PdfTableProjectionV2 {
  mode: PdfTableProjectionMode;
  sourceId: string;
  pageIndex: number;
  bbox?: PdfNormalizedRect;
  fragmentIds: string[];
  blocks: ImportBlock[];
  evidence: PdfDecisionEvidenceV2[];
  issues: ImportIssue[];
  claimedCharacterIndexes: number[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
}

function tableLocator(
  page: PdfPageFactsV1,
  sourceId: string,
  bbox?: PdfNormalizedRect,
  mcids: readonly number[] = [],
) {
  return {
    pageIndex: page.index,
    ...(page.label ? { pageLabel: page.label } : {}),
    ...(bbox ? { bbox } : {}),
    structurePath: sourceId,
    ...(mcids.length > 0 ? { markedContentIds: mcids.map((mcid) => `p${page.index}:mcid:${mcid}`) } : {}),
  };
}

function attributeNumber(attributes: readonly PdfStructureAttributeFact[], name: string): number | null {
  const attribute = attributes.find((candidate) =>
    candidate.name.trim().toLocaleLowerCase("en-US") === name
  );
  if (!attribute) return 1;
  return typeof attribute.value === "number" && Number.isInteger(attribute.value)
    ? attribute.value
    : null;
}

function taggedCell(
  page: PdfPageFactsV1,
  node: PdfStructureNodeFact,
): { cell: ImportTableCell; characters: number[]; bbox?: PdfNormalizedRect } {
  const correlated = correlateTaggedText(page, node);
  const linked = taggedRuns(
    correlated.characters,
    page.annotations,
    correlated.usedActualText ? correlated.text : undefined,
  );
  const rowspan = attributeNumber(node.attributes, "rowspan")!;
  const colspan = attributeNumber(node.attributes, "colspan")!;
  const paragraphId = `${node.id}:paragraph`;
  return {
    cell: {
      id: `${node.id}:cell`,
      sourceRefs: [node.id],
      header: structureRole(node) === "TH",
      ...(rowspan > 1 ? { rowspan } : {}),
      ...(colspan > 1 ? { colspan } : {}),
      blocks: [{
        id: paragraphId,
        type: "paragraph",
        runs: linked.runs,
        sourceRefs: [node.id],
      }],
    },
    characters: correlated.characters.map((character) => character.index),
    ...(correlated.bbox ? { bbox: correlated.bbox } : {}),
  };
}

function validTaggedGrid(
  page: PdfPageFactsV1,
  rows: readonly PdfStructureNodeFact[],
  corruptMcids: ReadonlySet<number>,
): { valid: boolean; reason: string } {
  if (rows.length === 0 || rows.length > PDF_TABLE_POLICY_V1.maximumRows) {
    return { valid: false, reason: "row-count" };
  }
  const occupied = new Map<string, string>();
  let width = 0;
  for (const [rowIndex, row] of rows.entries()) {
    if (structureRole(row) !== "TR" || row.children.length === 0) {
      return { valid: false, reason: "row-structure" };
    }
    let columnIndex = 0;
    for (const cell of row.children) {
      const role = structureRole(cell);
      if (role !== "TH" && role !== "TD") return { valid: false, reason: "cell-role" };
      while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
      const mcids = descendantMcids(cell);
      const rowspan = attributeNumber(cell.attributes, "rowspan");
      const colspan = attributeNumber(cell.attributes, "colspan");
      const correlated = correlateTaggedText(page, cell);
      if (
        mcids.length === 0
        || mcids.some((mcid) => corruptMcids.has(mcid))
        || correlated.text.length === 0
        || correlated.hasUnicodeError
        || rowspan === null
        || colspan === null
        || rowspan < 1
        || colspan < 1
        || rowspan > PDF_TABLE_POLICY_V1.maximumSpan
        || colspan > PDF_TABLE_POLICY_V1.maximumSpan
        || rowIndex + rowspan > rows.length
      ) return { valid: false, reason: "cell-evidence" };
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < colspan; columnOffset += 1) {
          const key = `${rowIndex + rowOffset}:${columnIndex + columnOffset}`;
          if (occupied.has(key)) return { valid: false, reason: "span-overlap" };
          occupied.set(key, cell.id);
        }
      }
      columnIndex += colspan;
      width = Math.max(width, columnIndex);
    }
  }
  if (width === 0 || width > PDF_TABLE_POLICY_V1.maximumColumns) {
    return { valid: false, reason: "column-count" };
  }
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (!occupied.has(`${row}:${column}`)) return { valid: false, reason: "grid-hole" };
    }
  }
  return { valid: true, reason: "qualified" };
}

function linearizeTaggedTable(
  page: PdfPageFactsV1,
  table: PdfStructureNodeFact,
  rows: readonly PdfStructureNodeFact[],
  reason: string,
): PdfTableProjectionV1 {
  const blocks: ImportBlock[] = [];
  const evidence: PdfDecisionEvidenceV1[] = [];
  const claimed = new Set<number>();
  const boxes: PdfNormalizedRect[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const cells = row.children.filter((cell) => ["TH", "TD"].includes(structureRole(cell)));
    const texts = cells.map((cell) => {
      const correlated = correlateTaggedText(page, cell);
      correlated.characters.forEach((character) => claimed.add(character.index));
      if (correlated.bbox) boxes.push(correlated.bbox);
      return correlated.text;
    });
    if (texts.length === 0) continue;
    const id = `${table.id}:linear-row:${rowIndex}`;
    blocks.push({
      id,
      type: "paragraph",
      runs: [{ kind: "text", text: texts.join(" | ") }],
      sourceRefs: cells.map((cell) => cell.id),
    });
    for (const cell of cells) {
      const correlated = correlateTaggedText(page, cell);
      evidence.push({
        sourceId: cell.id,
        targetNodeId: id,
        locator: tableLocator(page, cell.id, correlated.bbox ?? undefined, descendantMcids(cell)),
        basis: ["structure-tree", "marked-content"],
        confidence: 0.7,
        decisionCode: "pdf/table-tagged-linearized",
        outcome: "approximated",
        analyzerRevision: PDF_TABLE_POLICY_REVISION,
      });
    }
  }
  return {
    mode: "linearized-render-required",
    sourceId: table.id,
    pageIndex: page.index,
    ...(unionRects(boxes) ? { bbox: unionRects(boxes)! } : {}),
    fragmentIds: [],
    blocks,
    evidence,
    issues: [{
      code: "pdf-import/table-tagged-linearized",
      severity: "warning",
      outcome: "approximated",
      message: "Tagged table evidence was not a complete non-overlapping grid; cell text was linearized and a rendered-region fallback is required.",
      sourceRefs: [table.id],
      context: { pageIndex: page.index, reason, rows: rows.length },
    }],
    claimedCharacterIndexes: [...claimed].sort((a, b) => a - b),
  };
}

export function projectTaggedTable(
  page: PdfPageFactsV1,
  table: PdfStructureNodeFact,
  corruptMcids: ReadonlySet<number>,
): PdfTableProjectionV1 {
  const rows = table.children;
  const qualification = validTaggedGrid(page, rows, corruptMcids);
  if (!qualification.valid) return linearizeTaggedTable(page, table, rows, qualification.reason);
  const projectedRows: ImportTableRow[] = [];
  const evidence: PdfDecisionEvidenceV1[] = [];
  const claimed = new Set<number>();
  const boxes: PdfNormalizedRect[] = [];
  for (const row of rows) {
    const projectedCells: ImportTableCell[] = [];
    for (const node of row.children) {
      const projected = taggedCell(page, node);
      projectedCells.push(projected.cell);
      projected.characters.forEach((index) => claimed.add(index));
      if (projected.bbox) boxes.push(projected.bbox);
      evidence.push({
        sourceId: node.id,
        targetNodeId: projected.cell.id,
        locator: tableLocator(page, node.id, projected.bbox, descendantMcids(node)),
        basis: ["structure-tree", "marked-content", ...(projected.bbox ? ["text-geometry" as const] : [])],
        confidence: 1,
        decisionCode: "pdf/table-tagged-cell-native",
        outcome: "native",
        analyzerRevision: PDF_TABLE_POLICY_REVISION,
      });
    }
    projectedRows.push({ cells: projectedCells });
  }
  const id = `${table.id}:table`;
  const bbox = unionRects(boxes);
  evidence.push({
    sourceId: table.id,
    targetNodeId: id,
    locator: tableLocator(page, table.id, bbox ?? undefined, descendantMcids(table)),
    basis: ["structure-tree", "marked-content", ...(bbox ? ["text-geometry" as const] : [])],
    confidence: 1,
    decisionCode: "pdf/table-tagged-native",
    outcome: "native",
    analyzerRevision: PDF_TABLE_POLICY_REVISION,
  });
  return {
    mode: "native",
    sourceId: table.id,
    pageIndex: page.index,
    ...(bbox ? { bbox } : {}),
    fragmentIds: [],
    blocks: [{ id, type: "table", rows: projectedRows, sourceRefs: [table.id] }],
    evidence,
    issues: [],
    claimedCharacterIndexes: [...claimed].sort((a, b) => a - b),
  };
}

function tableLocatorV2(
  page: PdfPageFactsV2,
  sourceId: string,
  bbox?: PdfNormalizedRect,
  mcids: readonly number[] = [],
  characterIndexes: readonly number[] = [],
) {
  return {
    pageIndex: page.index,
    ...(page.label ? { pageLabel: page.label } : {}),
    ...(bbox ? { bbox } : {}),
    structurePath: sourceId,
    ...(mcids.length > 0
      ? { markedContentIds: mcids.map((mcid) => `p${page.index}:mcid:${mcid}`) }
      : {}),
    ...(characterIndexes.length > 0 ? { characterIndexes: [...characterIndexes] } : {}),
  };
}

function taggedCellV2(page: PdfPageFactsV2, node: PdfStructureNodeFactV2) {
  const correlated = correlateTaggedTextWithLinksV2(page, node);
  const linked = taggedRunsV2(correlated.assembly, correlated.characters, page.annotations);
  const rowspan = attributeNumber(node.attributes, "rowspan")!;
  const colspan = attributeNumber(node.attributes, "colspan")!;
  const paragraphId = `${node.id}:paragraph`;
  return {
    cell: {
      id: `${node.id}:cell`,
      sourceRefs: [node.id],
      header: structureRoleV2(node) === "TH",
      ...(rowspan > 1 ? { rowspan } : {}),
      ...(colspan > 1 ? { colspan } : {}),
      blocks: [{
        id: paragraphId,
        type: "paragraph" as const,
        runs: linked.runs,
        sourceRefs: [node.id],
      }],
    } satisfies ImportTableCell,
    correlated,
  };
}

function validTaggedGridV2(
  page: PdfPageFactsV2,
  rows: readonly PdfStructureNodeFactV2[],
  corruptMcids: ReadonlySet<number>,
): { valid: boolean; reason: string } {
  if (rows.length === 0 || rows.length > PDF_TABLE_POLICY_V1.maximumRows) {
    return { valid: false, reason: "row-count" };
  }
  const occupied = new Map<string, string>();
  let width = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const cells = structureChildrenV2(row);
    if (structureRoleV2(row) !== "TR" || cells.length === 0) {
      return { valid: false, reason: "row-structure" };
    }
    let columnIndex = 0;
    for (const cell of cells) {
      const role = structureRoleV2(cell);
      if (role !== "TH" && role !== "TD") return { valid: false, reason: "cell-role" };
      while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
      const mcids = orderedDescendantMcidsV2(cell);
      const rowspan = attributeNumber(cell.attributes, "rowspan");
      const colspan = attributeNumber(cell.attributes, "colspan");
      const correlated = correlateTaggedTextWithLinksV2(page, cell);
      if (
        mcids.length === 0
        || mcids.some((mcid) => corruptMcids.has(mcid))
        || correlated.text.length === 0
        || correlated.hasUnicodeError
        || correlated.assembly.unresolvedBoundaryCount > 0
        || unresolvedStructureKidIndexesV2(cell).length > 0
        || rowspan === null
        || colspan === null
        || rowspan < 1
        || colspan < 1
        || rowspan > PDF_TABLE_POLICY_V1.maximumSpan
        || colspan > PDF_TABLE_POLICY_V1.maximumSpan
        || rowIndex + rowspan > rows.length
      ) return { valid: false, reason: "cell-evidence" };
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < colspan; columnOffset += 1) {
          const key = `${rowIndex + rowOffset}:${columnIndex + columnOffset}`;
          if (occupied.has(key)) return { valid: false, reason: "span-overlap" };
          occupied.set(key, cell.id);
        }
      }
      columnIndex += colspan;
      width = Math.max(width, columnIndex);
    }
  }
  if (width === 0 || width > PDF_TABLE_POLICY_V1.maximumColumns) {
    return { valid: false, reason: "column-count" };
  }
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (!occupied.has(`${row}:${column}`)) return { valid: false, reason: "grid-hole" };
    }
  }
  return { valid: true, reason: "qualified" };
}

function linearizeTaggedTableV2(
  page: PdfPageFactsV2,
  table: PdfStructureNodeFactV2,
  rows: readonly PdfStructureNodeFactV2[],
  reason: string,
): PdfTableProjectionV2 {
  const blocks: ImportBlock[] = [];
  const evidence: PdfDecisionEvidenceV2[] = [];
  const issues: ImportIssue[] = [];
  const claimed = new Set<number>();
  const boxes: PdfNormalizedRect[] = [];
  const boundaries: PdfTextBoundaryDecisionV2[] = [];
  const transformations: PdfTextTransformationV2[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const cells = structureChildrenV2(row).filter((cell) =>
      ["TH", "TD"].includes(structureRoleV2(cell))
    );
    const texts = cells.map((cell) => {
      const correlated = correlateTaggedTextWithLinksV2(page, cell);
      appendPdfTextAssemblyV2({ boundaries, transformations }, correlated.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(correlated.assembly, page.index, cell.id));
      correlated.characters.forEach((character) => claimed.add(character.index));
      if (correlated.bbox) boxes.push(correlated.bbox);
      return correlated.text;
    });
    if (texts.length === 0) continue;
    const id = `${table.id}:linear-row:${rowIndex}`;
    blocks.push({
      id,
      type: "paragraph",
      runs: [{ kind: "text", text: texts.join(" | ") }],
      sourceRefs: cells.map((cell) => cell.id),
    });
    for (const cell of cells) {
      const correlated = correlateTaggedTextWithLinksV2(page, cell);
      const unresolved = correlated.assembly.unresolvedBoundaryCount > 0;
      evidence.push({
        sourceId: cell.id,
        targetNodeId: id,
        locator: tableLocatorV2(
          page,
          cell.id,
          correlated.bbox ?? undefined,
          orderedDescendantMcidsV2(cell),
          correlated.assembly.characterIndexes,
        ),
        basis: ["structure-tree", "marked-content", "text-boundary"],
        confidence: unresolved ? pdfTextAssemblyConfidenceV2(correlated.assembly) : 0.7,
        decisionCode: unresolved
          ? "pdf/table-tagged-boundary-unresolved"
          : "pdf/table-tagged-linearized",
        outcome: unresolved ? "reported" : "approximated",
        analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(correlated.assembly),
      });
    }
  }
  const bbox = unionRects(boxes);
  issues.push({
    code: "pdf-import/table-tagged-linearized",
    severity: "warning",
    outcome: "approximated",
    message: "Tagged table evidence was not a complete non-overlapping grid; cell text was linearized and a rendered-region fallback is required.",
    sourceRefs: [table.id],
    context: { pageIndex: page.index, reason, rows: rows.length },
  });
  return {
    mode: "linearized-render-required",
    sourceId: table.id,
    pageIndex: page.index,
    ...(bbox ? { bbox } : {}),
    fragmentIds: [],
    blocks,
    evidence,
    issues,
    claimedCharacterIndexes: [...claimed].sort((left, right) => left - right),
    boundaries,
    transformations,
  };
}

export function projectTaggedTableV2(
  page: PdfPageFactsV2,
  table: PdfStructureNodeFactV2,
  corruptMcids: ReadonlySet<number>,
): PdfTableProjectionV2 {
  const rows = structureChildrenV2(table);
  const qualification = validTaggedGridV2(page, rows, corruptMcids);
  if (!qualification.valid) {
    return linearizeTaggedTableV2(page, table, rows, qualification.reason);
  }
  const projectedRows: ImportTableRow[] = [];
  const evidence: PdfDecisionEvidenceV2[] = [];
  const issues: ImportIssue[] = [];
  const claimed = new Set<number>();
  const boxes: PdfNormalizedRect[] = [];
  const boundaries: PdfTextBoundaryDecisionV2[] = [];
  const transformations: PdfTextTransformationV2[] = [];
  for (const row of rows) {
    const projectedCells: ImportTableCell[] = [];
    for (const node of structureChildrenV2(row)) {
      const projected = taggedCellV2(page, node);
      const assembly = projected.correlated.assembly;
      projectedCells.push(projected.cell);
      projected.correlated.characters.forEach((character) => claimed.add(character.index));
      if (projected.correlated.bbox) boxes.push(projected.correlated.bbox);
      appendPdfTextAssemblyV2({ boundaries, transformations }, assembly);
      issues.push(...pdfTextAssemblyIssuesV2(assembly, page.index, node.id));
      evidence.push({
        sourceId: node.id,
        targetNodeId: projected.cell.id,
        locator: tableLocatorV2(
          page,
          node.id,
          projected.correlated.bbox ?? undefined,
          orderedDescendantMcidsV2(node),
          assembly.characterIndexes,
        ),
        basis: [
          "structure-tree",
          "marked-content",
          "text-boundary",
          ...(projected.correlated.bbox ? ["text-geometry" as const] : []),
        ],
        confidence: pdfTextAssemblyConfidenceV2(assembly),
        decisionCode: assembly.unresolvedBoundaryCount > 0
          ? "pdf/table-tagged-cell-boundary-unresolved"
          : "pdf/table-tagged-cell-native",
        outcome: pdfTextAssemblyOutcomeV2(assembly),
        analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(assembly),
      });
    }
    projectedRows.push({ cells: projectedCells });
  }
  const id = `${table.id}:table`;
  const bbox = unionRects(boxes);
  const cellEvidence = evidence.filter((item) => item.decisionCode.includes("cell"));
  const outcome = cellEvidence.some((item) => item.outcome !== "native") ? "reported" : "native";
  evidence.push({
    sourceId: table.id,
    targetNodeId: id,
    locator: tableLocatorV2(
      page,
      table.id,
      bbox ?? undefined,
      orderedDescendantMcidsV2(table),
      [...claimed].sort((left, right) => left - right),
    ),
    basis: [
      "structure-tree",
      "marked-content",
      "text-boundary",
      ...(bbox ? ["text-geometry" as const] : []),
    ],
    confidence: cellEvidence.length > 0
      ? Math.min(...cellEvidence.map((item) => item.confidence))
      : 0,
    decisionCode: outcome === "native" ? "pdf/table-tagged-native" : "pdf/table-tagged-reported",
    outcome,
    analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
    boundaryDecisionIds: [...new Set(cellEvidence.flatMap((item) => item.boundaryDecisionIds))],
  });
  return {
    mode: outcome === "native" ? "native" : "linearized-render-required",
    sourceId: table.id,
    pageIndex: page.index,
    ...(bbox ? { bbox } : {}),
    fragmentIds: [],
    blocks: [{ id, type: "table", rows: projectedRows, sourceRefs: [table.id] }],
    evidence,
    issues,
    claimedCharacterIndexes: [...claimed].sort((left, right) => left - right),
    boundaries,
    transformations,
  };
}

function uniqueCoordinates(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || Math.abs(value - previous) > PDF_TABLE_POLICY_V1.gridJoinTolerance) {
      result.push(value);
    } else {
      result[result.length - 1] = (previous + value) / 2;
    }
  }
  return result;
}

function paragraphForFragments(
  page: PdfPageFactsV1,
  id: string,
  fragments: readonly PdfGeometryFragmentV1[],
): ImportBlock {
  const runs: ImportRun[] = [];
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) runs.push({ kind: "text", text: " " });
    runs.push(...taggedRuns(fragment.characters, page.annotations).runs);
  }
  return { id, type: "paragraph", runs, sourceRefs: fragments.map((fragment) => fragment.id) };
}

function nativeUntaggedGrid(
  page: PdfPageFactsV1,
  analysis: PdfReadingOrderPageV1,
): PdfTableProjectionV1 | null {
  const paths = page.paths.filter((path) => path.stroke && path.segmentCount >= 2 && path.bbox);
  const vertical = paths.filter((path) => path.bbox!.width <= PDF_TABLE_POLICY_V1.pathAxisTolerance
    && path.bbox!.height >= PDF_TABLE_POLICY_V1.minimumGridHeight);
  const horizontal = paths.filter((path) => path.bbox!.height <= PDF_TABLE_POLICY_V1.pathAxisTolerance
    && path.bbox!.width >= PDF_TABLE_POLICY_V1.minimumGridWidth);
  const xs = uniqueCoordinates(vertical.map((path) => path.bbox!.x));
  const ys = uniqueCoordinates(horizontal.map((path) => path.bbox!.y));
  if (xs.length < 3 || ys.length < 3) return null;
  const minX = xs[0]!;
  const maxX = xs.at(-1)!;
  const minY = ys[0]!;
  const maxY = ys.at(-1)!;
  if (
    vertical.some((path) => path.bbox!.y > minY + PDF_TABLE_POLICY_V1.gridJoinTolerance
      || path.bbox!.y + path.bbox!.height < maxY - PDF_TABLE_POLICY_V1.gridJoinTolerance)
    || horizontal.some((path) => path.bbox!.x > minX + PDF_TABLE_POLICY_V1.gridJoinTolerance
      || path.bbox!.x + path.bbox!.width < maxX - PDF_TABLE_POLICY_V1.gridJoinTolerance)
  ) return null;
  const gridFragments = analysis.fragments.filter((fragment) => {
    const centerX = fragment.bbox.x + fragment.bbox.width / 2;
    const centerY = fragment.bbox.y + fragment.bbox.height / 2;
    return !fragment.furniture && !fragment.duplicateOf
      && centerX > minX && centerX < maxX && centerY > minY && centerY < maxY;
  });
  const rowCount = ys.length - 1;
  const columnCount = xs.length - 1;
  if (
    rowCount > PDF_TABLE_POLICY_V1.maximumRows
    || columnCount > PDF_TABLE_POLICY_V1.maximumColumns
  ) return null;
  const cells = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => [] as PdfGeometryFragmentV1[])
  );
  for (const fragment of gridFragments) {
    const centerX = fragment.bbox.x + fragment.bbox.width / 2;
    const centerY = fragment.bbox.y + fragment.bbox.height / 2;
    const row = ys.findIndex((edge, index) => index < ys.length - 1 && centerY > edge && centerY < ys[index + 1]!);
    const column = xs.findIndex((edge, index) => index < xs.length - 1 && centerX > edge && centerX < xs[index + 1]!);
    if (row < 0 || column < 0) return null;
    cells[row]![column]!.push(fragment);
  }
  if (cells.some((row) => row.some((cell) => cell.length === 0))) return null;
  const firstWeights = cells[0]!.flat().map((fragment) => fragment.fontWeight);
  const otherWeights = cells.slice(1).flat(2).map((fragment) => fragment.fontWeight);
  const firstRowHeader = firstWeights.length > 0
    && firstWeights.every((weight) => weight >= PDF_TABLE_POLICY_V1.boldHeaderWeight)
    && otherWeights.some((weight) => weight < PDF_TABLE_POLICY_V1.boldHeaderWeight);
  const tableId = `pdf:p${page.index}:grid:${minX.toFixed(6)}:${minY.toFixed(6)}`;
  const evidence: PdfDecisionEvidenceV1[] = [];
  const rows: ImportTableRow[] = cells.map((row, rowIndex) => ({
    cells: row.map((fragments, columnIndex) => {
      fragments.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.sourceOrder - b.sourceOrder);
      const id = `${tableId}:cell:${rowIndex}:${columnIndex}`;
      const bbox = unionRects(fragments.map((fragment) => fragment.bbox));
      evidence.push({
        sourceId: id,
        targetNodeId: id,
        locator: tableLocator(page, id, bbox ?? undefined),
        basis: ["text-geometry", "path-object", ...(firstRowHeader && rowIndex === 0 ? ["font-evidence" as const] : [])],
        confidence: 0.98,
        decisionCode: "pdf/table-untagged-grid-cell-native",
        outcome: "native",
        analyzerRevision: PDF_TABLE_POLICY_REVISION,
      });
      return {
        id,
        sourceRefs: fragments.map((fragment) => fragment.id),
        header: firstRowHeader && rowIndex === 0,
        blocks: [paragraphForFragments(page, `${id}:paragraph`, fragments)],
      };
    }),
  }));
  const bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  evidence.push({
    sourceId: tableId,
    targetNodeId: tableId,
    locator: tableLocator(page, tableId, bbox),
    basis: ["text-geometry", "path-object"],
    confidence: 0.98,
    decisionCode: "pdf/table-untagged-grid-native",
    outcome: "native",
    analyzerRevision: PDF_TABLE_POLICY_REVISION,
  });
  return {
    mode: "native",
    sourceId: tableId,
    pageIndex: page.index,
    bbox,
    fragmentIds: gridFragments.map((fragment) => fragment.id),
    blocks: [{ id: tableId, type: "table", rows, sourceRefs: paths.map((path) => path.id) }],
    evidence,
    issues: [],
    claimedCharacterIndexes: gridFragments.flatMap((fragment) => fragment.characters.map((character) => character.index)),
  };
}

function alignedRows(analysis: PdfReadingOrderPageV1): PdfGeometryFragmentV1[][] {
  const candidates = analysis.fragments.filter((fragment) => !fragment.furniture && !fragment.duplicateOf);
  const rows: PdfGeometryFragmentV1[][] = [];
  for (const fragment of [...candidates].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const row = rows.find((existing) => Math.abs(existing[0]!.bbox.y - fragment.bbox.y) <= PDF_TABLE_POLICY_V1.alignedRowTolerance);
    if (row) row.push(fragment);
    else rows.push([fragment]);
  }
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width < PDF_TABLE_POLICY_V1.minimumAlignedColumns) return [];
  const rectangular = rows.filter((row) => row.length === width)
    .map((row) => row.sort((a, b) => a.bbox.x - b.bbox.x));
  if (rectangular.length < PDF_TABLE_POLICY_V1.minimumAlignedRows) return [];
  const anchors = rectangular[0]!.map((fragment) => fragment.bbox.x);
  return rectangular.every((row) => row.every((fragment, index) =>
    Math.abs(fragment.bbox.x - anchors[index]!) <= PDF_TABLE_POLICY_V1.alignedColumnTolerance
  )) ? rectangular : [];
}

function linearizedUntaggedCandidate(
  page: PdfPageFactsV1,
  analysis: PdfReadingOrderPageV1,
): PdfTableProjectionV1 | null {
  const rows = alignedRows(analysis);
  if (rows.length === 0) return null;
  const sourceId = `pdf:p${page.index}:aligned-table-candidate`;
  const evidence: PdfDecisionEvidenceV1[] = [];
  const blocks = rows.map((fragments, rowIndex) => {
    const id = `${sourceId}:linear-row:${rowIndex}`;
    for (const fragment of fragments) {
      evidence.push({
        sourceId: fragment.id,
        targetNodeId: id,
        locator: tableLocator(page, fragment.id, fragment.bbox),
        basis: ["text-geometry"],
        confidence: 0.5,
        decisionCode: "pdf/table-alignment-only-linearized",
        outcome: "approximated",
        analyzerRevision: PDF_TABLE_POLICY_REVISION,
      });
    }
    return {
      id,
      type: "paragraph" as const,
      runs: [{ kind: "text" as const, text: fragments.map((fragment) => fragment.text).join(" | ") }],
      sourceRefs: fragments.map((fragment) => fragment.id),
    };
  });
  const all = rows.flat();
  const bbox = unionRects(all.map((fragment) => fragment.bbox));
  return {
    mode: "linearized-render-required",
    sourceId,
    pageIndex: page.index,
    ...(bbox ? { bbox } : {}),
    fragmentIds: all.map((fragment) => fragment.id),
    blocks,
    evidence,
    issues: [{
      code: "pdf-import/table-alignment-only-linearized",
      severity: "warning",
      outcome: "approximated",
      message: "Aligned text without a proven grid was not promoted to a native table; rows were linearized and require a rendered-region fallback.",
      sourceRefs: [sourceId],
      context: { pageIndex: page.index, rows: rows.length, columns: rows[0]!.length },
    }],
    claimedCharacterIndexes: all.flatMap((fragment) => fragment.characters.map((character) => character.index)),
  };
}

export function analyzeUntaggedTable(
  page: PdfPageFactsV1,
  analysis: PdfReadingOrderPageV1,
): PdfTableProjectionV1 {
  return nativeUntaggedGrid(page, analysis)
    ?? linearizedUntaggedCandidate(page, analysis)
    ?? {
      mode: "none",
      sourceId: `pdf:p${page.index}:table:none`,
      pageIndex: page.index,
      fragmentIds: [],
      blocks: [],
      evidence: [],
      issues: [],
      claimedCharacterIndexes: [],
    };
}
