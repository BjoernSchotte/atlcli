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
import type { ImportIssue, ImportTableRow } from "@atlcli/import-core";
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
  kind: "ruled" | "aligned";
  pageIndex: number;
  bbox: PdfNormalizedRect;
  columnEdges: number[];
  rowCount: number;
  columnCount: number;
  cells: PdfGeometryGridCellV2[];
  headerRows: number;
  pathIds: string[];
  fragmentIds: string[];
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
  if (xs.length < 3 && ys.length >= 3) return rowRuledGrid(page, connected, component, ys, fragments);
  if (xs.length < 3 || ys.length < 3) return null; // at least two columns and two rows
  const rows = ys.length - 1;
  const columns = xs.length - 1;
  if (rows > P.maximumRows || columns > P.maximumColumns) return null;
  const left = xs[0]!;
  const right = xs.at(-1)!;
  const top = ys[0]!;
  const bottom = ys.at(-1)!;
  // The frame must be drawn; an open grid is not proven.
  if (
    !drawn(component, true, top, left, right) || !drawn(component, true, bottom, left, right)
    || !drawn(component, false, left, top, bottom) || !drawn(component, false, right, top, bottom)
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
    if (!box || box.width <= P.rulingThickness || box.height <= P.rulingThickness || path.segmentCount > 5) continue;
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

const cellText = (cell: PdfGeometryGridCellV2) => cell.fragments.map((fragment) => fragment.text.trim()).join(" ");

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
export function projectGeometryTableV2(parts: readonly PdfGeometryTablePartV2[]): Map<number, PdfTableProjectionV2> {
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
    "text-boundary" as const,
    ...(header ? ["font-evidence" as const] : []),
  ];
  for (const [partIndex, { page, grid }] of parts.entries()) {
    const skip = partIndex === 0 ? 0 : repeatedHeaderRows(first.grid, grid);
    const rowOffset = rows.length - skip;
    for (let row = 0; row < grid.rowCount; row += 1) {
      const repeat = row < skip;
      const projectedRow: ImportTableRow = { cells: [] };
      for (const cell of grid.cells.filter((candidate) => candidate.row === row)) {
        const key = `${cell.row}:${cell.column}`;
        const id = repeat ? cellIds.get(key)! : `${tableId}:cell:${row + rowOffset}:${cell.column}`;
        if (partIndex === 0) cellIds.set(key, id);
        const header = partIndex === 0 ? row < grid.headerRows : repeat;
        const fragments = [...cell.fragments].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.sourceOrder - b.sourceOrder);
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
          const assembly = assembleGeometryFragmentsV2(page, `${id}:p${page.index}`, fragments);
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
          if (!repeat) {
            const linked = taggedRunsV2(assembly, fragments.flatMap((fragment) => fragment.characters), page.annotations);
            projectedRow.cells.push({
              id,
              sourceRefs: fragments.map((fragment) => fragment.id),
              header,
              ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
              ...(cell.colspan > 1 ? { colspan: cell.colspan } : {}),
              blocks: [{ id: `${id}:paragraph`, type: "paragraph", runs: linked.runs, sourceRefs: fragments.map((fragment) => fragment.id) }],
            });
            continue;
          }
        }
        if (!repeat) {
          projectedRow.cells.push({
            id,
            sourceRefs: [id],
            header,
            ...(cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
            ...(cell.colspan > 1 ? { colspan: cell.colspan } : {}),
            blocks: [],
          });
        }
      }
      if (!repeat) rows.push(projectedRow);
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
        ? grid.kind === "ruled" ? "pdf/table-untagged-grid-native" : "pdf/table-untagged-aligned-native"
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
): PdfTableProjectionV2[][] {
  const grids = analyses.map((analysis) => detectGeometryGridsV2(pages[analysis.pageIndex]!, analysis));
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
    const projections = projectGeometryTableV2(parts);
    if ([...projections.values()].some((projection) => projection.mode !== "native")) continue;
    for (const [pageIndex, projection] of projections) result[pageIndex]!.push(projection);
  }
  return result;
}
