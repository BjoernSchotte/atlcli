/**
 * Table recovery for untagged digital PDFs from vector rulings and text
 * alignment, without learned models.
 *
 * Word processors draw table borders as thin filled rectangles (often with a
 * small square at each joint) and cell shading as rectangles. A connected set
 * of rulings is one candidate grid; its cells are the regions between ruling
 * coordinates, merged where no separator is drawn. Text only fills cells; a
 * fragment that crosses a cell edge rejects the grid (fail closed). A grid
 * that ends a page and one that starts the next page with the same column
 * edges are one table; a header row repeated on the continuation is shown
 * once and still owns its characters.
 */
import type { ImportBlock, ImportIssue, ImportTableRow } from "@atlcli/import-core";
import {
  PDF_TABLE_POLICY_REVISION_V2,
  type PdfDecisionEvidenceV2,
  type PdfNormalizedRect,
  type PdfPageFactsV2,
} from "./contracts.js";
import { taggedRunsV2 } from "./links.js";
import {
  assembleGeometryFragmentsV2,
  geometryFragmentV2,
  type PdfGeometryFragmentV2,
  type PdfReadingOrderPageV2,
} from "./reading-order.js";
import {
  appendPdfTextAssemblyV2,
  pdfTextAssemblyConfidenceV2,
  pdfTextAssemblyIssuesV2,
  pdfTextAssemblyOutcomeV2,
  pdfTextBoundaryDecisionIdsV2,
} from "./assembly-evidence.js";
import type { PdfTableProjectionV2 } from "./tables.js";
import type { PdfTextBoundaryDecisionV2, PdfTextTransformationV2 } from "./text-assembly.js";
import { unionRects } from "./text.js";

export const PDF_GEOMETRY_TABLE_POLICY_V2 = Object.freeze({
  /** A path thinner than this on one axis is a ruling. */
  rulingThickness: 0.004,
  /** Coordinates closer than this are the same ruling line. */
  coordinateTolerance: 0.003,
  /** A cell edge is drawn when rulings cover this share of it. */
  separatorCoverage: 0.8,
  minimumBand: 0.004,
  maximumRows: 250,
  maximumColumns: 50,
  boldWeight: 600,
  /** Continuation parts must repeat every column edge within this distance. */
  continuationEdgeTolerance: 0.006,
  /** Filled body rows that prove a lone partly blank row after a break is a split row's rest. */
  denseSplitMinimumRows: 5,
  /** How far a proposed column edge may move to the nearest gap between glyphs. */
  proposalEdgeWindow: 0.02,
  borderless: {
    minimumColumns: 3,
    minimumRows: 3,
    anchorTolerance: 0.01,
    rowTolerance: 0.006,
    /** Minimum whitespace between columns, in median glyph heights. */
    minimumGapFactor: 1.5,
  },
} as const);

interface Ruling {
  /** An edge of a rectangle (shading or a box), not a drawn line. */
  boxEdge: boolean;
  horizontal: boolean;
  at: number;
  from: number;
  to: number;
  pathId: string;
}

export interface PdfGeometryGridCellV2 {
  row: number;
  column: number;
  rowspan: number;
  colspan: number;
  bbox: PdfNormalizedRect;
  fragments: PdfGeometryFragmentV2[];
}

export interface PdfGeometryGridV2 {
  /** `proposed`: structure from a table-structure model, verified against the characters. */
  kind: "ruled" | "aligned" | "proposed";
  pageIndex: number;
  bbox: PdfNormalizedRect;
  columnEdges: number[];
  rowCount: number;
  columnCount: number;
  cells: PdfGeometryGridCellV2[];
  headerRows: number;
  pathIds: string[];
  fragmentIds: string[];
  /** The top side has no rule: the first row may continue the previous page's last row. */
  openTop?: boolean;
  /** The bottom side has no rule: the last row may continue on the next page. */
  openBottom?: boolean;
}

const P = PDF_GEOMETRY_TABLE_POLICY_V2;

function rulingsOf(page: PdfPageFactsV2): Ruling[] {
  const rulings: Ruling[] = [];
  for (const path of page.paths) {
    const box = path.bbox;
    if (!box) continue;
    const thinY = box.height <= P.rulingThickness;
    const thinX = box.width <= P.rulingThickness;
    if (thinY && thinX) continue; // joint squares and dots
    if (thinY) rulings.push({ boxEdge: false, horizontal: true, at: box.y + box.height / 2, from: box.x, to: box.x + box.width, pathId: path.id });
    else if (thinX) rulings.push({ boxEdge: false, horizontal: false, at: box.x + box.width / 2, from: box.y, to: box.y + box.height, pathId: path.id });
    else if (path.segmentCount <= 5) {
      // A rectangle (cell shading, a stroked or filled box) bounds its region.
      const right = box.x + box.width;
      const bottom = box.y + box.height;
      rulings.push(
        { boxEdge: true, horizontal: true, at: box.y, from: box.x, to: right, pathId: path.id },
        { boxEdge: true, horizontal: true, at: bottom, from: box.x, to: right, pathId: path.id },
        { boxEdge: true, horizontal: false, at: box.x, from: box.y, to: bottom, pathId: path.id },
        { boxEdge: true, horizontal: false, at: right, from: box.y, to: bottom, pathId: path.id },
      );
    }
  }
  return rulings;
}

function touches(a: Ruling, b: Ruling): boolean {
  const t = P.coordinateTolerance;
  if (a.horizontal === b.horizontal) {
    return Math.abs(a.at - b.at) <= t && a.from <= b.to + t && b.from <= a.to + t;
  }
  const [h, v] = a.horizontal ? [a, b] : [b, a];
  return v.at >= h.from - t && v.at <= h.to + t && h.at >= v.from - t && h.at <= v.to + t;
}

/** Connected rulings. ponytail: O(n²) per page; a sweep line if pages carry thousands of rulings. */
function rulingComponents(rulings: readonly Ruling[]): Ruling[][] {
  const parent = rulings.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  for (let left = 0; left < rulings.length; left += 1) {
    for (let right = left + 1; right < rulings.length; right += 1) {
      if (touches(rulings[left]!, rulings[right]!)) parent[find(left)] = find(right);
    }
  }
  const groups = new Map<number, Ruling[]>();
  rulings.forEach((ruling, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), ruling]);
  });
  return [...groups.values()];
}

function clusterCoordinates(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const value of sorted) {
    const last = clusters.at(-1);
    if (last && value - last.at(-1)! <= P.coordinateTolerance) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((cluster) => cluster.reduce((sum, value) => sum + value, 0) / cluster.length)
    .filter((value, index, all) => index === 0 || value - all[index - 1]! >= P.minimumBand);
}

function coverage(rulings: readonly Ruling[], horizontal: boolean, at: number, from: number, to: number): number {
  const spans = rulings
    .filter((ruling) => ruling.horizontal === horizontal && Math.abs(ruling.at - at) <= P.coordinateTolerance)
    .map((ruling) => [Math.max(from, ruling.from), Math.min(to, ruling.to)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let until = from;
  for (const [start, end] of spans) {
    const begin = Math.max(start, until);
    if (end > begin) covered += end - begin;
    until = Math.max(until, end);
  }
  return to > from ? covered / (to - from) : 0;
}

const drawn = (rulings: readonly Ruling[], horizontal: boolean, at: number, from: number, to: number) =>
  coverage(rulings, horizontal, at, from, to) >= P.separatorCoverage;

const center = (box: PdfNormalizedRect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const within = (inner: PdfNormalizedRect, outer: PdfNormalizedRect, tolerance: number = P.coordinateTolerance) =>
  inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
  && inner.x + inner.width <= outer.x + outer.width + tolerance
  && inner.y + inner.height <= outer.y + outer.height + tolerance;
const bold = (fragment: PdfGeometryFragmentV2) => fragment.fontWeight >= P.boldWeight;

function headerRowCount(rowCount: number, cells: readonly PdfGeometryGridCellV2[]): number {
  let header = 0;
  for (let row = 0; row < rowCount - 1; row += 1) {
    const texts = cells.filter((cell) => cell.row <= row && row < cell.row + cell.rowspan && cell.fragments.length > 0);
    if (texts.length === 0 || !texts.every((cell) => cell.fragments.every(bold))) break;
    header = row + 1;
  }
  const body = cells.filter((cell) => cell.row >= header && cell.fragments.length > 0);
  return body.some((cell) => cell.fragments.some((fragment) => !bold(fragment))) ? header : 0;
}

/**
 * Where every line of one orientation ends at the same coordinate beyond the
 * outermost perpendicular line, that coordinate is an open frame side: Word
 * tables without outer side borders, or a table continued from the previous
 * page without a top rule.
 */
function impliedFrameEdge(
  lines: readonly Ruling[],
  horizontal: boolean,
  positions: readonly number[],
  start: boolean,
): number | null {
  const ends = positions.map((at) => {
    const on = lines.filter((line) => line.horizontal === horizontal && Math.abs(line.at - at) <= P.coordinateTolerance);
    return start ? Math.min(...on.map((line) => line.from)) : Math.max(...on.map((line) => line.to));
  });
  const edge = start ? Math.min(...ends) : Math.max(...ends);
  return Number.isFinite(edge) && ends.every((end) => Math.abs(end - edge) <= P.coordinateTolerance) ? edge : null;
}

function ruledGrid(
  page: PdfPageFactsV2,
  connected: readonly Ruling[],
  fragments: readonly PdfGeometryFragmentV2[],
): PdfGeometryGridV2 | null {
  // Drawn lines define the grid when present: shading follows elementary
  // cells even inside merged cells. Without lines, shading edges are the grid.
  const lines = connected.filter((ruling) => !ruling.boxEdge);
  const component = lines.some((ruling) => ruling.horizontal) && lines.some((ruling) => !ruling.horizontal) ? lines : connected;
  const xs = clusterCoordinates(component.filter((ruling) => !ruling.horizontal).map((ruling) => ruling.at));
  const ys = clusterCoordinates(component.filter((ruling) => ruling.horizontal).map((ruling) => ruling.at));
  const open = { left: false, right: false, top: false, bottom: false };
  // Before counting columns: a table with inside rules only (Word's
  // "no outer border") draws one vertical line fewer than it has columns.
  if (lines.length === component.length && xs.length > 0 && ys.length > 0) {
    const sides = {
      left: impliedFrameEdge(component, true, ys, true),
      right: impliedFrameEdge(component, true, ys, false),
      top: impliedFrameEdge(component, false, xs, true),
      bottom: impliedFrameEdge(component, false, xs, false),
    };
    if (sides.left !== null && xs[0]! - sides.left >= P.minimumBand) { xs.unshift(sides.left); open.left = true; }
    if (sides.right !== null && sides.right - xs.at(-1)! >= P.minimumBand) { xs.push(sides.right); open.right = true; }
    if (sides.top !== null && ys[0]! - sides.top >= P.minimumBand) { ys.unshift(sides.top); open.top = true; }
    if (sides.bottom !== null && sides.bottom - ys.at(-1)! >= P.minimumBand) { ys.push(sides.bottom); open.bottom = true; }
  }
  if (xs.length < 3 && ys.length >= 3) return rowRuledGrid(page, connected, component, ys, fragments);
  if (xs.length < 3 || ys.length < 3) return null; // at least two columns and two rows
  const rows = ys.length - 1;
  const columns = xs.length - 1;
  if (rows > P.maximumRows || columns > P.maximumColumns) return null;
  const left = xs[0]!;
  const right = xs.at(-1)!;
  const top = ys[0]!;
  const bottom = ys.at(-1)!;
  // The frame must be drawn or implied by every line ending on it; an open
  // grid is not proven.
  if (
    !open.top && !drawn(component, true, top, left, right) || !open.bottom && !drawn(component, true, bottom, left, right)
    || !open.left && !drawn(component, false, left, top, bottom) || !open.right && !drawn(component, false, right, top, bottom)
  ) return null;
  const parent = Array.from({ length: rows * columns }, (_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (column + 1 < columns && !drawn(component, false, xs[column + 1]!, ys[row]!, ys[row + 1]!)) {
        parent[find(row * columns + column)] = find(row * columns + column + 1);
      }
      if (row + 1 < rows && !drawn(component, true, ys[row + 1]!, xs[column]!, xs[column + 1]!)) {
        parent[find(row * columns + column)] = find((row + 1) * columns + column);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < rows * columns; index += 1) {
    groups.set(find(index), [...(groups.get(find(index)) ?? []), index]);
  }
  const cells: PdfGeometryGridCellV2[] = [];
  for (const members of groups.values()) {
    const rowsOf = members.map((index) => Math.floor(index / columns));
    const columnsOf = members.map((index) => index % columns);
    const row = Math.min(...rowsOf);
    const column = Math.min(...columnsOf);
    const rowspan = Math.max(...rowsOf) - row + 1;
    const colspan = Math.max(...columnsOf) - column + 1;
    if (rowspan * colspan !== members.length) return null; // merged region is not a rectangle
    cells.push({
      row, column, rowspan, colspan,
      bbox: { x: xs[column]!, y: ys[row]!, width: xs[column + colspan]! - xs[column]!, height: ys[row + rowspan]! - ys[row]! },
      fragments: [],
    });
  }
  if (cells.length < 2) return null;
  const bbox = { x: left, y: top, width: right - left, height: bottom - top };
  const inside = fragments.filter((fragment) => {
    const point = center(fragment.bbox);
    return point.x > left && point.x < right && point.y > top && point.y < bottom;
  });
  for (const fragment of inside) {
    const cell = cells.find((candidate) => within(fragment.bbox, candidate.bbox));
    if (cell) {
      cell.fragments.push(fragment);
      continue;
    }
    // Narrow cell padding can leave text of adjacent cells in one fragment:
    // split it at the drawn cell edges, character by character.
    const parts = new Map<PdfGeometryGridCellV2, typeof fragment.characters>();
    let current: PdfGeometryGridCellV2 | undefined;
    for (const character of fragment.characters) {
      if (character.bbox && character.value.trim()) {
        const point = center(character.bbox);
        current = cells.find((candidate) =>
          point.x > candidate.bbox.x && point.x < candidate.bbox.x + candidate.bbox.width
          && point.y > candidate.bbox.y && point.y < candidate.bbox.y + candidate.bbox.height
        );
        if (!current) return null; // a glyph on a cell edge
      }
      if (current) parts.set(current, [...(parts.get(current) ?? []), character]);
    }
    for (const [target, characters] of parts) {
      const piece = geometryFragmentV2(page, characters, fragment.physicalLineIndex, fragment.sourceOrder);
      if (!piece || !within(piece.bbox, target.bbox)) return null;
      target.fragments.push({ ...piece, id: `${piece.id}:of:${fragment.id}` });
    }
  }
  if (inside.length === 0) return null;
  cells.sort((a, b) => a.row - b.row || a.column - b.column);
  return {
    kind: "ruled",
    pageIndex: page.index,
    bbox,
    columnEdges: xs,
    rowCount: rows,
    columnCount: columns,
    cells,
    headerRows: headerRowCount(rows, cells),
    pathIds: [...new Set(connected.map((ruling) => ruling.pathId))],
    fragmentIds: inside.map((fragment) => fragment.id),
    ...(open.top ? { openTop: true } : {}),
    ...(open.bottom ? { openBottom: true } : {}),
  };
}

/** Splits a fragment at column boundaries; null when a glyph sits on a boundary. */
function splitAtColumns(
  page: PdfPageFactsV2,
  fragment: PdfGeometryFragmentV2,
  columnOf: (x: number) => number,
): Map<number, PdfGeometryFragmentV2> | null {
  const parts = new Map<number, typeof fragment.characters>();
  let current: number | undefined;
  for (const character of fragment.characters) {
    if (character.bbox && character.value.trim()) {
      const left = columnOf(character.bbox.x);
      if (left !== columnOf(character.bbox.x + character.bbox.width)) return null;
      current = left;
    }
    if (current !== undefined) parts.set(current, [...(parts.get(current) ?? []), character]);
  }
  const pieces = new Map<number, PdfGeometryFragmentV2>();
  for (const [column, characters] of parts) {
    const piece = geometryFragmentV2(page, characters, fragment.physicalLineIndex, fragment.sourceOrder);
    if (!piece) return null;
    pieces.set(column, parts.size === 1 ? fragment : { ...piece, id: `${piece.id}:of:${fragment.id}` });
  }
  return pieces;
}

/**
 * A table drawn with horizontal rules only: rows come from the rules,
 * columns from left text edges shared by at least two rows. A band holding
 * several text lines is one row with wrapped cells, or several rows when
 * every line starts in the first column and fills at least two columns.
 */
function rowRuledGrid(
  page: PdfPageFactsV2,
  connected: readonly Ruling[],
  component: readonly Ruling[],
  ys: readonly number[],
  fragments: readonly PdfGeometryFragmentV2[],
): PdfGeometryGridV2 | null {
  const horizontals = component.filter((ruling) => ruling.horizontal);
  const left = Math.min(...horizontals.map((ruling) => ruling.from));
  const right = Math.max(...horizontals.map((ruling) => ruling.to));
  const top = ys[0]!;
  const bottom = ys.at(-1)!;
  if (!drawn(component, true, top, left, right) || !drawn(component, true, bottom, left, right)) return null;
  if (!ys.every((y) => drawn(component, true, y, left, right))) return null;
  const inside = fragments.filter((fragment) => {
    const point = center(fragment.bbox);
    return point.x > left - P.coordinateTolerance && point.x < right + P.coordinateTolerance && point.y > top && point.y < bottom;
  });
  if (inside.length === 0) return null;
  if (inside.some((fragment) => fragment.bbox.x < left - P.coordinateTolerance || fragment.bbox.x + fragment.bbox.width > right + P.coordinateTolerance)) return null;
  const bandOf = (fragment: PdfGeometryFragmentV2) => {
    const y = center(fragment.bbox).y;
    return ys.findIndex((edge, index) => index < ys.length - 1 && y > edge && y < ys[index + 1]!);
  };
  // Column anchors: left edges (clustered) used in at least two bands.
  const lefts = clusterCoordinates(inside.map((fragment) => fragment.bbox.x).sort((a, b) => a - b))
    .filter((anchor) => new Set(inside
      .filter((fragment) => Math.abs(fragment.bbox.x - anchor) <= P.borderless.anchorTolerance)
      .map(bandOf)).size >= 2);
  const anchors = lefts.filter((anchor, index) => index === 0 || anchor - lefts[index - 1]! > P.borderless.anchorTolerance);
  if (anchors.length < 2 || anchors.length > P.maximumColumns) return null;
  const edges = [left, ...anchors.slice(1).map((anchor) => anchor - P.coordinateTolerance), right];
  const columnOf = (x: number) => Math.max(0, edges.findIndex((edge, index) => index < edges.length - 1 && x >= edge && x < edges[index + 1]!));
  const bands = ys.slice(0, -1).map(() => new Map<number, PdfGeometryFragmentV2[]>());
  for (const fragment of inside) {
    const band = bandOf(fragment);
    if (band < 0) return null;
    const pieces = splitAtColumns(page, fragment, columnOf);
    if (!pieces) return null;
    for (const [column, piece] of pieces) bands[band]!.set(column, [...(bands[band]!.get(column) ?? []), piece]);
  }
  const cells: PdfGeometryGridCellV2[] = [];
  let row = 0;
  const lineTolerance = P.borderless.rowTolerance;
  for (const [bandIndex, band] of bands.entries()) {
    const all = [...band.values()].flat();
    const baselines = clusterCoordinates(all.map((fragment) => fragment.bbox.y).sort((a, b) => a - b))
      .filter((value, index, list) => index === 0 || value - list[index - 1]! > lineTolerance);
    const at = (fragment: PdfGeometryFragmentV2, baseline: number) => Math.abs(fragment.bbox.y - baseline) <= lineTolerance;
    const subRows = baselines.length > 1 && baselines.every((baseline) =>
      (band.get(0) ?? []).some((fragment) => at(fragment, baseline))
      && [...band.values()].filter((list) => list.some((fragment) => at(fragment, baseline))).length >= 2
    );
    const rowTops = subRows ? baselines : [baselines[0] ?? ys[bandIndex]!];
    for (const [subIndex, rowTop] of rowTops.entries()) {
      const rowBottom = subRows && subIndex + 1 < rowTops.length ? rowTops[subIndex + 1]! - lineTolerance : ys[bandIndex + 1]!;
      const y0 = subIndex === 0 ? ys[bandIndex]! : rowTop - lineTolerance;
      for (let column = 0; column < anchors.length; column += 1) {
        const members = (band.get(column) ?? []).filter((fragment) => !subRows || (fragment.bbox.y >= rowTop - lineTolerance && fragment.bbox.y < rowBottom));
        cells.push({
          row, column, rowspan: 1, colspan: 1,
          bbox: { x: edges[column]!, y: y0, width: edges[column + 1]! - edges[column]!, height: rowBottom - y0 },
          fragments: members,
        });
      }
      row += 1;
    }
  }
  if (row < 2 || row > P.maximumRows) return null;
  return {
    kind: "ruled",
    pageIndex: page.index,
    bbox: { x: left, y: top, width: right - left, height: bottom - top },
    columnEdges: edges,
    rowCount: row,
    columnCount: anchors.length,
    cells,
    headerRows: headerRowCount(row, cells),
    pathIds: [...new Set(connected.map((ruling) => ruling.pathId))],
    fragmentIds: inside.map((fragment) => fragment.id),
  };
}

/**
 * A borderless table is accepted only in its unambiguous form: at least
 * three rows of single-line cells, the same number of cells in every row,
 * left edges aligned per column and clear whitespace between columns.
 */
function alignedGrids(page: PdfPageFactsV2, fragments: readonly PdfGeometryFragmentV2[]): PdfGeometryGridV2[] {
  const B = P.borderless;
  const lines: PdfGeometryFragmentV2[][] = [];
  for (const fragment of [...fragments].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const line = lines.find((candidate) => Math.abs(candidate[0]!.bbox.y - fragment.bbox.y) <= B.rowTolerance);
    if (line) line.push(fragment);
    else lines.push([fragment]);
  }
  lines.forEach((line) => line.sort((a, b) => a.bbox.x - b.bbox.x));
  lines.sort((a, b) => a[0]!.bbox.y - b[0]!.bbox.y);
  const glyph = (line: readonly PdfGeometryFragmentV2[]) => Math.max(...line.map((fragment) => fragment.bbox.height));
  const aligned = (a: readonly PdfGeometryFragmentV2[], b: readonly PdfGeometryFragmentV2[]) =>
    a.length === b.length && a.every((fragment, index) => Math.abs(fragment.bbox.x - b[index]!.bbox.x) <= B.anchorTolerance);
  const separated = (line: readonly PdfGeometryFragmentV2[]) => line.every((fragment, index) =>
    index === 0 || fragment.bbox.x - (line[index - 1]!.bbox.x + line[index - 1]!.bbox.width) >= B.minimumGapFactor * glyph(line)
  );
  const grids: PdfGeometryGridV2[] = [];
  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    if (lines[start]!.length >= B.minimumColumns && separated(lines[start]!)) {
      while (end < lines.length && aligned(lines[start]!, lines[end]!) && separated(lines[end]!)) end += 1;
    }
    const run = lines.slice(start, end);
    if (run.length >= B.minimumRows && run[0]!.length >= B.minimumColumns) {
      const columns = run[0]!.length;
      const edges = [
        ...run[0]!.map((_, column) => Math.min(...run.map((line) => line[column]!.bbox.x))),
        Math.max(...run.map((line) => line.at(-1)!.bbox.x + line.at(-1)!.bbox.width)),
      ];
      // Column right edges must stay left of the next column for every row.
      const ordered = run.every((line) => line.every((fragment, column) =>
        column === columns - 1 || fragment.bbox.x + fragment.bbox.width < edges[column + 1]!
      ));
      if (ordered) {
        const cells = run.flatMap((line, row) => line.map((fragment, column) => ({
          row, column, rowspan: 1, colspan: 1, bbox: fragment.bbox, fragments: [fragment],
        })));
        const bbox = unionRects(run.flat().map((fragment) => fragment.bbox))!;
        grids.push({
          kind: "aligned",
          pageIndex: page.index,
          bbox,
          columnEdges: edges,
          rowCount: run.length,
          columnCount: columns,
          cells,
          headerRows: headerRowCount(run.length, cells),
          pathIds: [],
          fragmentIds: run.flat().map((fragment) => fragment.id),
        });
      }
    }
    start = end;
  }
  return grids;
}

/** Ruled grids, then borderless tables among the remaining text, in page order. */
export function detectGeometryGridsV2(page: PdfPageFactsV2, analysis: PdfReadingOrderPageV2): PdfGeometryGridV2[] {
  const body = analysis.fragments.filter((fragment) => !fragment.furniture && !fragment.duplicateOf);
  const ruled = rulingComponents(rulingsOf(page))
    .map((component) => ruledGrid(page, component, body))
    .filter((grid): grid is PdfGeometryGridV2 => grid !== null);
  const used = new Set(ruled.flatMap((grid) => grid.fragmentIds));
  const remaining = body.filter((fragment) => !used.has(fragment.id)
    && !ruled.some((grid) => within(fragment.bbox, grid.bbox)));
  return [...ruled, ...alignedGrids(page, remaining)].sort((a, b) => a.bbox.y - b.bbox.y);
}

/**
 * Paths that are table rulings or a background behind text: a filled or
 * stroked rectangle that holds visible text and no image. These are not
 * figures.
 */
export function geometryDecorationPathIdsV2(page: PdfPageFactsV2, grids: readonly PdfGeometryGridV2[]): Set<string> {
  const ids = new Set(grids.flatMap((grid) => grid.pathIds));
  for (const path of page.paths) {
    const box = path.bbox;
    // A rectangle: `re` is five segments; LibreOffice draws it as a moveto,
    // four linetos and a close.
    if (!box || box.width <= P.rulingThickness || box.height <= P.rulingThickness || path.segmentCount > 6) continue;
    const holdsText = page.characters.some((character) =>
      character.bbox && character.value.trim().length > 0 && within(character.bbox, box, 0)
    );
    const holdsImage = page.images.some((image) => image.bbox && within(image.bbox, box, 0));
    if (holdsText && !holdsImage) ids.add(path.id);
  }
  return ids;
}

export interface PdfGeometryTablePartV2 {
  page: PdfPageFactsV2;
  grid: PdfGeometryGridV2;
}

/**
 * Appends one page's view of a cell to the cell's blocks. A row split by a
 * page break continues the same paragraph; a trailing hyphen is ambiguous
 * across pages and keeps the parts apart.
 */
export function continueCellBlocksV2(blocks: ImportBlock[], next: readonly ImportBlock[]): void {
  const previous = blocks.at(-1);
  const first = next[0];
  const previousText = previous?.type === "paragraph"
    ? previous.runs.map((run) => run.kind === "text" ? run.text : "\n").join("")
    : "";
  if (
    previous?.type === "paragraph" && first?.type === "paragraph" && next.length === 1
    && /\S$/u.test(previousText) && !/[-\u00ad\u2010]$/u.test(previousText) && first.runs.length > 0
  ) {
    // Merge like taggedRunsV2 so adjacent runs with equal marks stay one.
    for (const run of [{ kind: "text" as const, text: " " }, ...first.runs]) {
      const last = previous.runs.at(-1);
      if (last?.kind === "text" && run.kind === "text" && JSON.stringify(last.marks) === JSON.stringify(run.marks)) {
        last.text += run.text;
      } else previous.runs.push({ ...run });
    }
  } else blocks.push(...next);
}

const cellText = (cell: PdfGeometryGridCellV2) => cell.fragments.map((fragment) => fragment.text.trim()).join(" ");
const blocksText = (blocks: readonly ImportBlock[]): string => blocks
  .map((block) => "runs" in block ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : "")
  .join(" ").trim();
const SENTENCE_END = /[.!?…:;]["'”’)\]]*$/u;

/** Whether `next` continues `previous` on the following page with the same columns. */
export function geometryGridContinues(
  previous: PdfGeometryGridV2,
  next: PdfGeometryGridV2,
): boolean {
  return next.pageIndex === previous.pageIndex + 1
    && next.kind === previous.kind
    && next.columnCount === previous.columnCount
    && next.columnEdges.every((edge, index) =>
      Math.abs(edge - previous.columnEdges[index]!) <= P.continuationEdgeTolerance
    );
}

/** Number of leading rows of `next` that repeat the header rows of `first`. */
function repeatedHeaderRows(first: PdfGeometryGridV2, next: PdfGeometryGridV2): number {
  if (first.headerRows === 0 || next.rowCount <= first.headerRows) return 0;
  const signature = (grid: PdfGeometryGridV2) => grid.cells
    .filter((cell) => cell.row < first.headerRows)
    .map((cell) => `${cell.row}:${cell.column}:${cell.rowspan}:${cell.colspan}:${cellText(cell)}`)
    .join("|");
  return signature(first) === signature(next) && next.cells
    .filter((cell) => cell.row < first.headerRows)
    .every((cell) => cell.fragments.every(bold))
    ? first.headerRows
    : 0;
}

/**
 * Projects one table from its page parts. Continuation parts contribute their
 * rows; a repeated header contributes its characters to the header cells.
 */
export function projectGeometryTableV2(
  parts: readonly PdfGeometryTablePartV2[],
  documentLexicon?: ReadonlySet<string>,
): Map<number, PdfTableProjectionV2> {
  const first = parts[0]!;
  const tableId = `pdf:p${first.page.index}:${first.grid.kind}-table-v2:${first.grid.bbox.x.toFixed(6)}:${first.grid.bbox.y.toFixed(6)}`;
  const evidence = new Map<number, PdfDecisionEvidenceV2[]>(parts.map((part) => [part.page.index, []]));
  const claimed = new Map<number, number[]>(parts.map((part) => [part.page.index, []]));
  const issues: ImportIssue[] = [];
  const boundaries: PdfTextBoundaryDecisionV2[] = [];
  const transformations: PdfTextTransformationV2[] = [];
  const rows: ImportTableRow[] = [];
  const cellIds = new Map<string, string>();
  let outcome: "native" | ReturnType<typeof pdfTextAssemblyOutcomeV2> = "native";
  const basis = (grid: PdfGeometryGridV2, header: boolean) => [
    "text-geometry" as const,
    ...(grid.kind === "ruled" ? ["path-object" as const] : []),
    ...(grid.kind === "proposed" ? ["model-proposal" as const] : []),
    "text-boundary" as const,
    ...(header ? ["font-evidence" as const] : []),
  ];
  // The last projected row's cells by column, for a row split by a page break.
  let lastRow = new Map<number, ImportTableRow["cells"][number]>();
  for (const [partIndex, { page, grid }] of parts.entries()) {
    const skip = partIndex === 0 ? 0 : repeatedHeaderRows(first.grid, grid);
    // A table whose frame is drawn but which is open on both sides of the
    // page break, without a repeated header: the first row is the rest of the
    // previous page's last row when both rows have the same simple cells. A
    // table drawn without outer rules is open on every page and proves
    // nothing; Word and LibreOffice draw the frame across a split row.
    const firstCells = grid.cells.filter((cell) => cell.row === 0);
    const sameSimpleCells = partIndex > 0 && skip === 0 && lastRow.size === grid.columnCount
      && firstCells.every((cell) =>
        cell.rowspan === 1 && cell.colspan === 1 && lastRow.get(cell.column)?.rowspan === undefined
        && lastRow.get(cell.column)?.colspan === undefined
      );
    const framedSplit = sameSimpleCells && grid.openTop === true
      && first.grid.openTop !== true && parts[partIndex - 1]!.grid.openBottom === true;
    // Word and LibreOffice draw the frame across a split row, so its rest is
    // a row of its own whose finished cells are blank, like a row that leaves
    // cells blank on purpose. Its text proves the split: every filled cell
    // continues a filled cell whose text stops mid-sentence, or starts in
    // lowercase. So does a table that fills every other body cell: Word
    // breaks a split row between sentences, and its rest is then the only
    // row with blank cells. Otherwise say so instead of guessing.
    const restOfRow = sameSimpleCells && !framedSplit
      && firstCells.some((cell) => cell.fragments.length > 0)
      && firstCells.some((cell) => cell.fragments.length === 0 && (lastRow.get(cell.column)?.blocks.length ?? 0) > 0);
    const textSplit = restOfRow && firstCells.every((cell) => {
      if (cell.fragments.length === 0) return true;
      const previous = blocksText(lastRow.get(cell.column)?.blocks ?? []);
      return previous.length > 0 && (!SENTENCE_END.test(previous) || /^\p{Ll}/u.test(cellText(cell)));
    });
    const bodyRows = parts.slice(0, partIndex + 1).flatMap((part, index) => {
      const start = index === 0 ? first.grid.headerRows : index === partIndex ? 1 : repeatedHeaderRows(first.grid, part.grid);
      return Array.from({ length: Math.max(0, part.grid.rowCount - start) }, (_, offset) =>
        part.grid.cells.filter((cell) => cell.row === start + offset));
    });
    const denseSplit = restOfRow && !textSplit && bodyRows.length >= P.denseSplitMinimumRows
      && bodyRows.every((cells) => cells.every((cell) => cell.fragments.length > 0));
    const splitRow = framedSplit || textSplit || denseSplit;
    if (restOfRow) {
      issues.push(textSplit || denseSplit ? {
        code: "pdf-import/table-row-split-joined",
        severity: "info",
        outcome: "approximated",
        message: textSplit
          ? "The first row after a page break continues the text of the row before it; it was joined to that row."
          : "The first row after a page break is the only row of the table that leaves cells blank, where the row before fills them; it was joined to that row.",
        sourceRefs: [tableId],
        context: { pageIndex: page.index, rowIndex: rows.length - 1 },
      } : {
        code: "pdf-import/table-row-split-unproven",
        severity: "warning",
        outcome: "native",
        message: "The first row after a page break leaves cells blank that the row before fills; it may be the rest of a row split by the break.",
        sourceRefs: [tableId],
        context: { pageIndex: page.index, rowIndex: rows.length },
      });
    }
    const rowOffset = rows.length - skip - (splitRow ? 1 : 0);
    for (let row = 0; row < grid.rowCount; row += 1) {
      const repeat = row < skip;
      const continues = splitRow && row === 0;
      const projectedRow: ImportTableRow = { cells: [] };
      const projectedColumns = new Map<number, ImportTableRow["cells"][number]>();
      for (const cell of grid.cells.filter((candidate) => candidate.row === row)) {
        const key = `${cell.row}:${cell.column}`;
        const id = continues
          ? lastRow.get(cell.column)!.id
          : repeat ? cellIds.get(key)! : `${tableId}:cell:${row + rowOffset}:${cell.column}`;
        if (partIndex === 0) cellIds.set(key, id);
        const header = partIndex === 0 ? row < grid.headerRows : repeat;
        // Physical lines, not raw y: text of one line can sit a hair higher.
        const fragments = [...cell.fragments].sort((a, b) => a.physicalLineIndex - b.physicalLineIndex || a.bbox.x - b.bbox.x || a.sourceOrder - b.sourceOrder);
        if (fragments.length === 0) {
          evidence.get(page.index)!.push({
            sourceId: `${id}:p${page.index}`,
            targetNodeId: id,
            locator: { pageIndex: page.index, bbox: cell.bbox, structurePath: id },
            basis: basis(grid, false),
            confidence: 1,
            decisionCode: "pdf/table-untagged-grid-cell-empty",
            outcome: "native",
            analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
            boundaryDecisionIds: [],
          });
        } else {
          const assembly = assembleGeometryFragmentsV2(page, `${id}:p${page.index}`, fragments, documentLexicon);
          appendPdfTextAssemblyV2({ boundaries, transformations }, assembly);
          issues.push(...pdfTextAssemblyIssuesV2(assembly, page.index, id));
          const cellOutcome = pdfTextAssemblyOutcomeV2(assembly);
          if (cellOutcome !== "native") outcome = cellOutcome;
          claimed.get(page.index)!.push(...assembly.characterIndexes);
          evidence.get(page.index)!.push({
            sourceId: `${id}:p${page.index}`,
            targetNodeId: id,
            locator: {
              pageIndex: page.index,
              ...(page.label ? { pageLabel: page.label } : {}),
              bbox: cell.bbox,
              structurePath: id,
              characterIndexes: assembly.characterIndexes,
            },
            basis: basis(grid, header),
            confidence: pdfTextAssemblyConfidenceV2(assembly),
            decisionCode: cellOutcome !== "native"
              ? "pdf/table-untagged-grid-cell-boundary-unresolved"
              : repeat ? "pdf/table-untagged-grid-cell-header-repeated" : "pdf/table-untagged-grid-cell-native",
            outcome: cellOutcome,
            analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
            boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(assembly),
          });
          if (continues) {
            const target = lastRow.get(cell.column)!;
            const linked = taggedRunsV2(assembly, fragments.flatMap((fragment) => fragment.characters), page.annotations);
            target.sourceRefs = [...(target.sourceRefs ?? []), ...fragments.map((fragment) => fragment.id)];
            continueCellBlocksV2(target.blocks, [{ id: `${id}:p${page.index}:paragraph`, type: "paragraph", runs: linked.runs, sourceRefs: fragments.map((fragment) => fragment.id) }]);
            continue;
          }
          if (!repeat) {
            const linked = taggedRunsV2(assembly, fragments.flatMap((fragment) => fragment.characters), page.annotations);
            const projectedCell = {
              id,
              sourceRefs: fragments.map((fragment) => fragment.id),
              header,
              ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
              ...(cell.colspan > 1 ? { colspan: cell.colspan } : {}),
              blocks: [{ id: `${id}:paragraph`, type: "paragraph" as const, runs: linked.runs, sourceRefs: fragments.map((fragment) => fragment.id) }],
            };
            projectedRow.cells.push(projectedCell);
            projectedColumns.set(cell.column, projectedCell);
            continue;
          }
        }
        if (!repeat && !continues) {
          projectedColumns.set(cell.column, {
            id,
            sourceRefs: [id],
            header,
            ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
            ...(cell.colspan > 1 ? { colspan: cell.colspan } : {}),
            blocks: [],
          });
          projectedRow.cells.push(projectedColumns.get(cell.column)!);
        }
      }
      if (!repeat && !continues) {
        rows.push(projectedRow);
        lastRow = projectedColumns;
      }
    }
  }
  const native = outcome === "native";
  const result = new Map<number, PdfTableProjectionV2>();
  for (const [partIndex, { page, grid }] of parts.entries()) {
    const pageEvidence = evidence.get(page.index)!;
    const characterIndexes = claimed.get(page.index)!.sort((a, b) => a - b);
    pageEvidence.push({
      sourceId: `${tableId}:p${page.index}`,
      targetNodeId: tableId,
      locator: { pageIndex: page.index, bbox: grid.bbox, structurePath: tableId, characterIndexes },
      basis: basis(grid, false),
      confidence: native ? Math.min(1, ...pageEvidence.map((item) => item.confidence)) : 0,
      decisionCode: native
        ? { ruled: "pdf/table-untagged-grid-native", aligned: "pdf/table-untagged-aligned-native", proposed: "pdf/table-untagged-proposed-native" }[grid.kind]
        : "pdf/table-untagged-grid-boundary-unresolved",
      outcome: native ? "native" : outcome,
      analyzerRevision: PDF_TABLE_POLICY_REVISION_V2,
      boundaryDecisionIds: [...new Set(pageEvidence.flatMap((item) => item.boundaryDecisionIds))],
    });
    result.set(page.index, {
      mode: native ? "native" : "linearized-render-required",
      sourceId: tableId,
      pageIndex: page.index,
      bbox: grid.bbox,
      fragmentIds: grid.fragmentIds,
      blocks: partIndex === 0 ? [{ id: tableId, type: "table", rows, sourceRefs: parts.map((part) => `${tableId}:p${part.page.index}`) }] : [],
      evidence: pageEvidence,
      issues: partIndex === 0 ? [
        ...issues,
        ...(parts.length > 1 ? [{
          code: "pdf-import/table-continuation-joined",
          severity: "info" as const,
          outcome: "native" as const,
          message: "A table continued across page breaks was projected as one native table.",
          sourceRefs: [tableId],
          context: { pageIndex: page.index, pages: parts.length },
        }] : []),
      ] : [],
      claimedCharacterIndexes: characterIndexes,
      boundaries: partIndex === 0 ? boundaries : [],
      transformations: partIndex === 0 ? transformations : [],
    });
  }
  return result;
}

/**
 * Native geometry tables for every page. A grid that is the last body content
 * of its page joins a grid that is the first body content of the next page
 * when both have the same column edges. A part whose cells do not all
 * assemble natively drops the whole table, so its text stays with the page.
 */
export function projectUntaggedGeometryTablesV2(
  pages: readonly PdfPageFactsV2[],
  analyses: readonly PdfReadingOrderPageV2[],
  ignoredFragmentIds: ReadonlySet<string>,
  proposedGrids: readonly PdfGeometryGridV2[] = [],
  documentLexicon?: ReadonlySet<string>,
): PdfTableProjectionV2[][] {
  const overlaps = (a: PdfNormalizedRect, b: PdfNormalizedRect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const grids = analyses.map((analysis) => {
    const detected = detectGeometryGridsV2(pages[analysis.pageIndex]!, analysis);
    // Verified proposals only fill areas the deterministic pass left open.
    const proposed = proposedGrids.filter((grid) => grid.pageIndex === analysis.pageIndex
      && !detected.some((candidate) => overlaps(candidate.bbox, grid.bbox)));
    return [...detected, ...proposed].sort((a, b) => a.bbox.y - b.bbox.y);
  });
  const body = analyses.map((analysis) => analysis.fragments.filter((fragment) =>
    !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id)
  ));
  const outside = (pageIndex: number, grid: PdfGeometryGridV2) => {
    const ids = new Set(grids[pageIndex]!.flatMap((candidate) => candidate.fragmentIds));
    return body[pageIndex]!.filter((fragment) => !ids.has(fragment.id));
  };
  const endsPage = (grid: PdfGeometryGridV2) =>
    grid === grids[grid.pageIndex]!.at(-1)
    && outside(grid.pageIndex, grid).every((fragment) => fragment.bbox.y < grid.bbox.y);
  const startsPage = (grid: PdfGeometryGridV2) =>
    grid === grids[grid.pageIndex]![0]
    && outside(grid.pageIndex, grid).every((fragment) => fragment.bbox.y > grid.bbox.y + grid.bbox.height);
  const tables: PdfGeometryTablePartV2[][] = [];
  const continued = new Set<PdfGeometryGridV2>();
  for (const pageGrids of grids) {
    for (const grid of pageGrids) {
      if (continued.has(grid)) continue;
      const parts: PdfGeometryTablePartV2[] = [{ page: pages[grid.pageIndex]!, grid }];
      for (let last = grid; endsPage(last);) {
        const next = grids[last.pageIndex + 1]?.[0];
        if (!next || !startsPage(next) || !geometryGridContinues(last, next)) break;
        parts.push({ page: pages[next.pageIndex]!, grid: next });
        continued.add(next);
        last = next;
      }
      tables.push(parts);
    }
  }
  const result: PdfTableProjectionV2[][] = pages.map(() => []);
  for (const parts of tables) {
    const projections = projectGeometryTableV2(parts, documentLexicon);
    if ([...projections.values()].some((projection) => projection.mode !== "native")) continue;
    for (const [pageIndex, projection] of projections) result[pageIndex]!.push(projection);
  }
  return result;
}

/** A table-structure proposal in page-normalized coordinates (for example from Table Transformer). */
export interface PdfTableStructureProposalV1 {
  rows: PdfNormalizedRect[];
  columns: PdfNormalizedRect[];
  columnHeaders: PdfNormalizedRect[];
  spanningCells: PdfNormalizedRect[];
}

const bottomOf = (box: PdfNormalizedRect) => box.y + box.height;
const rightOf = (box: PdfNormalizedRect) => box.x + box.width;

/** Edges between consecutive bands: the outer edges, then midpoints of the gaps. */
function bandEdges(bands: readonly PdfNormalizedRect[], start: (box: PdfNormalizedRect) => number, end: (box: PdfNormalizedRect) => number): number[] | null {
  const sorted = [...bands].sort((a, b) => (start(a) + end(a)) - (start(b) + end(b)));
  const edges = [start(sorted[0]!)];
  for (let index = 1; index < sorted.length; index += 1) edges.push((end(sorted[index - 1]!) + start(sorted[index]!)) / 2);
  edges.push(end(sorted.at(-1)!));
  return edges.every((edge, index) => index === 0 || edge - edges[index - 1]! >= P.minimumBand) ? edges : null;
}

/**
 * Accepts a proposed structure only when the PDF's own characters fit it:
 * every text fragment of the table area lands in exactly one cell (split at
 * column edges per character), every row holds text, and spanning cells
 * cover whole rectangles of rows and columns. The proposal never adds or
 * changes text.
 */
export function verifyTableProposalV2(
  page: PdfPageFactsV2,
  analysis: PdfReadingOrderPageV2,
  region: PdfNormalizedRect,
  proposal: PdfTableStructureProposalV1,
): PdfGeometryGridV2 | null {
  if (proposal.rows.length < 2 || proposal.columns.length < 2) return null;
  if (proposal.rows.length > P.maximumRows || proposal.columns.length > P.maximumColumns) return null;
  const ys = bandEdges(proposal.rows, (box) => box.y, bottomOf);
  const xs = bandEdges(proposal.columns, (box) => box.x, rightOf);
  if (!ys || !xs) return null;
  const frame = { x: xs[0]!, y: ys[0]!, width: xs.at(-1)! - xs[0]!, height: ys.at(-1)! - ys[0]! };
  const rows = ys.length - 1;
  const columns = xs.length - 1;
  const inside = analysis.fragments.filter((fragment) => {
    if (fragment.furniture || fragment.duplicateOf) return false;
    const point = center(fragment.bbox);
    return within({ ...point, width: 0, height: 0 }, region, 0) && within({ ...point, width: 0, height: 0 }, frame, 0);
  });
  if (inside.length === 0) return null;
  // The model's column boxes are approximate: an interior edge that cuts a
  // word moves to the nearest word boundary within a small window. Words are
  // runs of visible glyphs, so an edge never lands between two letters.
  const words: Array<readonly [number, number]> = [];
  for (const fragment of inside) {
    let word: [number, number] | null = null;
    for (const character of fragment.characters) {
      if (character.bbox && character.value.trim()) {
        const end = character.bbox.x + character.bbox.width;
        word = word ? [word[0], Math.max(word[1], end)] : [character.bbox.x, end];
      } else if (word) {
        words.push(word);
        word = null;
      }
    }
    if (word) words.push(word);
  }
  const cuts = (x: number) => words.some(([start, end]) => start < x && x < end);
  for (let index = 1; index < xs.length - 1; index += 1) {
    if (!cuts(xs[index]!)) continue;
    const options = words.flatMap(([start, end]) => [start, end])
      .filter((x) => Math.abs(x - xs[index]!) <= P.proposalEdgeWindow && x > xs[index - 1]! && x < xs[index + 1]! && !cuts(x))
      .sort((a, b) => Math.abs(a - xs[index]!) - Math.abs(b - xs[index]!));
    if (options[0] !== undefined) xs[index] = options[0];
  }
  // Spanning cells merge the elementary cells whose centres they contain.
  const parent = Array.from({ length: rows * columns }, (_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  for (const span of proposal.spanningCells) {
    const members: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const point = { x: (xs[column]! + xs[column + 1]!) / 2, y: (ys[row]! + ys[row + 1]!) / 2, width: 0, height: 0 };
        if (within(point, span, 0)) members.push(row * columns + column);
      }
    }
    for (const member of members.slice(1)) parent[find(member)] = find(members[0]!);
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < rows * columns; index += 1) groups.set(find(index), [...(groups.get(find(index)) ?? []), index]);
  const cells: PdfGeometryGridCellV2[] = [];
  const cellOf = new Map<number, PdfGeometryGridCellV2>();
  for (const members of groups.values()) {
    const rowsOf = members.map((index) => Math.floor(index / columns));
    const columnsOf = members.map((index) => index % columns);
    const row = Math.min(...rowsOf);
    const column = Math.min(...columnsOf);
    const rowspan = Math.max(...rowsOf) - row + 1;
    const colspan = Math.max(...columnsOf) - column + 1;
    if (rowspan * colspan !== members.length) return null;
    const cell: PdfGeometryGridCellV2 = {
      row, column, rowspan, colspan,
      bbox: { x: xs[column]!, y: ys[row]!, width: xs[column + colspan]! - xs[column]!, height: ys[row + rowspan]! - ys[row]! },
      fragments: [],
    };
    cells.push(cell);
    for (const member of members) cellOf.set(member, cell);
  }
  // Text is in the frame by its centre; its glyphs may overhang the outer edges.
  const columnOf = (x: number) => x < xs[1]! ? 0 : x >= xs.at(-2)! ? columns - 1
    : xs.findIndex((edge, index) => index < xs.length - 1 && x >= edge && x < xs[index + 1]!);
  const rowOf = (y: number) => y < ys[1]! ? 0 : y >= ys.at(-2)! ? rows - 1
    : ys.findIndex((edge, index) => index < ys.length - 1 && y >= edge && y < ys[index + 1]!);
  for (const fragment of inside) {
    const pieces = splitAtColumns(page, fragment, (x) => {
      const column = columnOf(x);
      return column < 0 ? -1 : column;
    });
    if (!pieces || pieces.has(-1)) return null;
    for (const [column, piece] of pieces) {
      const row = rowOf(center(piece.bbox).y);
      if (row < 0) return null;
      cellOf.get(row * columns + column)!.fragments.push(piece);
    }
  }
  // A row or column without any text is not evidenced by the PDF.
  for (let row = 0; row < rows; row += 1) {
    if (!cells.some((cell) => cell.row <= row && row < cell.row + cell.rowspan && cell.fragments.length > 0)) return null;
  }
  for (let column = 0; column < columns; column += 1) {
    if (!cells.some((cell) => cell.column <= column && column < cell.column + cell.colspan && cell.fragments.length > 0)) return null;
  }
  cells.sort((a, b) => a.row - b.row || a.column - b.column);
  let headerRows = 0;
  while (headerRows < rows - 1 && proposal.columnHeaders.some((box) =>
    within({ x: frame.x + frame.width / 2, y: (ys[headerRows]! + ys[headerRows + 1]!) / 2, width: 0, height: 0 }, { ...box, x: frame.x, width: frame.width }, P.coordinateTolerance)
  )) headerRows += 1;
  return {
    kind: "proposed",
    pageIndex: page.index,
    bbox: frame,
    columnEdges: xs,
    rowCount: rows,
    columnCount: columns,
    cells,
    headerRows: headerRows || headerRowCount(rows, cells),
    pathIds: [],
    fragmentIds: inside.map((fragment) => fragment.id),
  };
}

/**
 * Areas the deterministic pass could not turn into a table but that hold
 * table-like evidence: ruling components with text that did not qualify, and
 * aligned text rows. These are the only regions offered to a proposer.
 */
export function untaggedTableCandidateRegionsV2(
  page: PdfPageFactsV2,
  analysis: PdfReadingOrderPageV2,
  alignedCandidate: PdfNormalizedRect | null,
): PdfNormalizedRect[] {
  const accepted = detectGeometryGridsV2(page, analysis);
  const overlapsAccepted = (box: PdfNormalizedRect) => accepted.some((grid) =>
    box.x < rightOf(grid.bbox) && rightOf(box) > grid.bbox.x && box.y < bottomOf(grid.bbox) && bottomOf(box) > grid.bbox.y
  );
  const regions: PdfNormalizedRect[] = [];
  for (const component of rulingComponents(rulingsOf(page))) {
    if (new Set(component.map((ruling) => ruling.pathId)).size < 4) continue;
    const xs = component.flatMap((ruling) => ruling.horizontal ? [ruling.from, ruling.to] : [ruling.at]);
    const ys = component.flatMap((ruling) => ruling.horizontal ? [ruling.at] : [ruling.from, ruling.to]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (box.y > 0.92 || bottomOf(box) < 0.08 || box.width < 0.1 || box.height < 0.02 || overlapsAccepted(box)) continue;
    const characters = page.characters.filter((character) => character.bbox && character.value.trim() && within(character.bbox, box)).length;
    if (characters >= 20) regions.push(box);
  }
  if (alignedCandidate && !overlapsAccepted(alignedCandidate) && !regions.some((box) => within(alignedCandidate, box))) regions.push(alignedCandidate);
  // Table Transformer was trained on table crops with a white margin.
  const margin = 0.03;
  return regions.map((box) => {
    const x = Math.max(0, box.x - margin);
    const y = Math.max(0, box.y - margin);
    return { x, y, width: Math.min(1, rightOf(box) + margin) - x, height: Math.min(1, bottomOf(box) + margin) - y };
  });
}
