import type { PdfNormalizedRect, PdfPageFactsV1, PdfTextCharacterFact } from "./contracts.js";
import { normalizePdfText, textDirection, unionRects, type PdfTextDirection } from "./text.js";

export const PDF_GEOMETRY_POLICY_V1 = Object.freeze({
  maxColumns: 2,
  columnGap: 0.18,
  minimumLinesPerColumn: 2,
  fragmentGap: 0.025,
  fragmentGapGlyphFactor: 4,
  conflictingOverlapRatio: 0.25,
  duplicateOverlapRatio: 0.7,
  headingFontRatio: 1.15,
  headingFontDeltaPoints: 1.5,
  maximumHeadingLength: 120,
  maximumHorizontalAngleRadians: 0.12,
} as const);

export interface PdfGeometryFragmentV1 {
  id: string;
  pageIndex: number;
  text: string;
  bbox: PdfNormalizedRect;
  characters: PdfTextCharacterFact[];
  fontSizePoints: number;
  fontWeight: number;
  angleRadians: number;
  direction: PdfTextDirection;
  sourceOrder: number;
  column: number;
  furniture: boolean;
  duplicateOf?: string;
}

export interface PdfReadingOrderPageV1 {
  pageIndex: number;
  fragments: PdfGeometryFragmentV1[];
  ordered: PdfGeometryFragmentV1[];
  columnCount: number;
  qualificationReasons: string[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function isBreak(character: PdfTextCharacterFact): boolean {
  return character.value === "\r" || character.value === "\n";
}

function splitPhysicalLines(characters: readonly PdfTextCharacterFact[]): PdfTextCharacterFact[][] {
  const lines: PdfTextCharacterFact[][] = [];
  let current: PdfTextCharacterFact[] = [];
  for (const character of characters) {
    if (isBreak(character)) {
      if (current.length > 0) lines.push(current);
      current = [];
    } else {
      current.push(character);
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function splitFragments(line: readonly PdfTextCharacterFact[]): PdfTextCharacterFact[][] {
  const widths = line.flatMap((character) => character.bbox && character.bbox.width > 0
    ? [character.bbox.width]
    : []);
  const threshold = Math.max(
    PDF_GEOMETRY_POLICY_V1.fragmentGap,
    median(widths) * PDF_GEOMETRY_POLICY_V1.fragmentGapGlyphFactor,
  );
  const result: PdfTextCharacterFact[][] = [];
  let current: PdfTextCharacterFact[] = [];
  for (const character of line) {
    const previous = current.at(-1);
    const gap = previous?.bbox && character.bbox
      ? character.bbox.x - (previous.bbox.x + previous.bbox.width)
      : 0;
    if (current.length > 0 && gap > threshold) {
      result.push(current);
      current = [];
    }
    current.push(character);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function overlapRatio(a: PdfNormalizedRect, b: PdfNormalizedRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const minimumArea = Math.min(a.width * a.height, b.width * b.height);
  return minimumArea <= 0 ? 0 : (width * height) / minimumArea;
}

function pageFurniture(text: string, bbox: PdfNormalizedRect): boolean {
  return bbox.y < 0.14 && bbox.x > 0.6 && /(?:page|seite)\s+[ivxlcdm\d]+\b/iu.test(text);
}

export function extractGeometryFragments(page: PdfPageFactsV1): PdfGeometryFragmentV1[] {
  const fragments: PdfGeometryFragmentV1[] = [];
  for (const line of splitPhysicalLines(page.characters)) {
    for (const part of splitFragments(line)) {
      const text = normalizePdfText(part.map((character) => character.value).join(""));
      const bbox = unionRects(part.map((character) => character.bbox));
      if (!text || !bbox) continue;
      const fontSizePoints = median(part.filter((character) => !character.generated && character.fontSizePoints > 1)
        .map((character) => character.fontSizePoints));
      const angleRadians = median(part.filter((character) => !character.generated)
        .map((character) => character.angleRadians));
      const fontWeight = median(part.filter((character) => !character.generated)
        .map((character) => character.fontWeight));
      fragments.push({
        id: `pdf:p${page.index}:fragment:${part[0]!.index}-${part.at(-1)!.index}`,
        pageIndex: page.index,
        text,
        bbox,
        characters: [...part],
        fontSizePoints,
        fontWeight,
        angleRadians,
        direction: textDirection(text),
        sourceOrder: fragments.length,
        column: 0,
        furniture: pageFurniture(text, bbox),
      });
    }
  }
  return fragments;
}

function assignColumns(fragments: PdfGeometryFragmentV1[], ignored: ReadonlySet<string>): number {
  const content = fragments.filter((fragment) =>
    !fragment.furniture && !fragment.duplicateOf && !ignored.has(fragment.id)
  );
  if (content.length === 0) return 1;
  const xs = [...new Set(content.map((fragment) => Math.round(fragment.bbox.x * 100) / 100))].sort(
    (a, b) => a - b,
  );
  const boundaries: number[] = [];
  for (let index = 1; index < xs.length; index += 1) {
    if (xs[index]! - xs[index - 1]! >= PDF_GEOMETRY_POLICY_V1.columnGap) {
      boundaries.push((xs[index]! + xs[index - 1]!) / 2);
    }
  }
  const columnCount = boundaries.length + 1;
  for (const fragment of content) {
    fragment.column = boundaries.filter((boundary) => fragment.bbox.x > boundary).length;
  }
  return columnCount;
}

export function analyzeGeometryReadingOrder(
  page: PdfPageFactsV1,
  ignoredFragmentIds: ReadonlySet<string> = new Set(),
): PdfReadingOrderPageV1 {
  const fragments = extractGeometryFragments(page);
  const reasons = new Set<string>();
  const extractedIndexes = new Set(fragments.flatMap((fragment) =>
    fragment.characters.map((character) => character.index)
  ));
  if (page.characters.some((character) =>
    !isBreak(character)
    && character.value.replace(/[\s\u00ad]/gu, "").length > 0
    && !extractedIndexes.has(character.index)
  )) {
    reasons.add("missing-geometry");
  }
  for (let left = 0; left < fragments.length; left += 1) {
    for (let right = left + 1; right < fragments.length; right += 1) {
      const a = fragments[left]!;
      const b = fragments[right]!;
      const ratio = overlapRatio(a.bbox, b.bbox);
      if (ratio >= PDF_GEOMETRY_POLICY_V1.duplicateOverlapRatio && a.text === b.text) {
        b.duplicateOf = a.id;
      } else if (ratio >= PDF_GEOMETRY_POLICY_V1.conflictingOverlapRatio && a.text !== b.text) {
        reasons.add("conflicting-overlap");
      }
    }
  }
  if (fragments.some((fragment) => Math.abs(fragment.angleRadians) > PDF_GEOMETRY_POLICY_V1.maximumHorizontalAngleRadians)) {
    reasons.add("non-horizontal-text");
  }
  if (fragments.some((fragment) => fragment.characters.some((character) => character.unicodeMapError))) {
    reasons.add("unicode-map-error");
  }
  const columnCount = assignColumns(fragments, ignoredFragmentIds);
  if (columnCount > PDF_GEOMETRY_POLICY_V1.maxColumns) reasons.add("too-many-columns");
  if (columnCount === 2) {
    const counts = [0, 1].map((column) => fragments.filter((fragment) =>
      !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id) && fragment.column === column
    ).length);
    if (counts.some((count) => count < PDF_GEOMETRY_POLICY_V1.minimumLinesPerColumn)) {
      reasons.add("under-evidenced-column");
    }
    const leftRight = fragments.filter((fragment) =>
      !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id)
    );
    const leftEdge = Math.max(...leftRight.filter((fragment) => fragment.column === 0)
      .map((fragment) => fragment.bbox.x + fragment.bbox.width));
    const rightEdge = Math.min(...leftRight.filter((fragment) => fragment.column === 1)
      .map((fragment) => fragment.bbox.x));
    if (leftEdge >= rightEdge) reasons.add("column-overlap");
  }
  const ordered = fragments
    .filter((fragment) => !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id))
    .sort((a, b) => a.column - b.column || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.sourceOrder - b.sourceOrder);
  return {
    pageIndex: page.index,
    fragments,
    ordered,
    columnCount,
    qualificationReasons: [...reasons].sort(),
  };
}

export function geometryBodyFontSize(pages: readonly PdfReadingOrderPageV1[]): number {
  return median(pages.flatMap((page) => page.fragments
    .filter((fragment) => !fragment.furniture && !fragment.duplicateOf)
    .map((fragment) => fragment.fontSizePoints)
    .filter((size) => size > 0)));
}
