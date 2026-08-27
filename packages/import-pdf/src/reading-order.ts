import type {
  PdfNormalizedRect,
  PdfPageFactsV1,
  PdfPageFactsV2,
  PdfTextCharacterFact,
  PdfTextCharacterFactV2,
} from "./contracts.js";
import { normalizePdfText, textDirection, unionRects, type PdfTextDirection } from "./text.js";
import { assemblePdfTextV2, type PdfTextAssemblyV2 } from "./text-assembly.js";

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

export const PDF_GEOMETRY_POLICY_V2 = Object.freeze({
  ...PDF_GEOMETRY_POLICY_V1,
  lineClusterCenterGlyphFactor: 0.7,
  minimumLineClusterTolerance: 0.0025,
  paragraphMaximumLineGapGlyphFactor: 2.4,
  paragraphMaximumIndentDelta: 0.02,
  paragraphMaximumFontDeltaPoints: 0.5,
  pageNumberFooterMinimumX: 0.75,
  pageNumberFooterMinimumY: 0.9,
  columnStartPrecision: 100,
  columnAlignmentGlyphFactor: 0.7,
} as const);

export interface PdfGeometryFragmentV2
  extends Omit<PdfGeometryFragmentV1, "characters"> {
  characters: PdfTextCharacterFactV2[];
  assembly: PdfTextAssemblyV2;
  physicalLineIndex: number;
}

export interface PdfReadingOrderPageV2
  extends Omit<PdfReadingOrderPageV1, "fragments" | "ordered"> {
  fragments: PdfGeometryFragmentV2[];
  ordered: PdfGeometryFragmentV2[];
}

function pageFurnitureV2(text: string, bbox: PdfNormalizedRect): boolean {
  if (pageFurniture(text, bbox)) return true;
  return bbox.x >= PDF_GEOMETRY_POLICY_V2.pageNumberFooterMinimumX
    && bbox.y >= PDF_GEOMETRY_POLICY_V2.pageNumberFooterMinimumY
    && /^[ivxlcdm\d]+$/iu.test(text.trim());
}

function isGeometryAnchorV2(character: PdfTextCharacterFactV2): boolean {
  if (!character.bbox || character.bbox.width <= 0 || character.bbox.height <= 0) return false;
  return character.hyphen || character.value.replace(/[\s\p{Cc}\u00ad]/gu, "").length > 0;
}

function verticalCenter(rect: PdfNormalizedRect): number {
  return rect.y + rect.height / 2;
}

interface GeometryLineClusterV2 {
  anchors: PdfTextCharacterFactV2[];
  center: number;
  height: number;
}

function clusterPhysicalLinesV2(page: PdfPageFactsV2): GeometryLineClusterV2[] {
  const clusters: GeometryLineClusterV2[] = [];
  const anchors = page.characters
    .filter(isGeometryAnchorV2)
    .sort((left, right) =>
      verticalCenter(left.bbox!) - verticalCenter(right.bbox!)
      || left.bbox!.x - right.bbox!.x
      || left.index - right.index
    );
  for (const anchor of anchors) {
    const center = verticalCenter(anchor.bbox!);
    const cluster = clusters.find((candidate) =>
      Math.abs(candidate.center - center) <= Math.max(
        PDF_GEOMETRY_POLICY_V2.minimumLineClusterTolerance,
        Math.max(candidate.height, anchor.bbox!.height)
          * PDF_GEOMETRY_POLICY_V2.lineClusterCenterGlyphFactor,
      )
    );
    if (cluster) {
      cluster.anchors.push(anchor);
      cluster.center = median(cluster.anchors.map((character) => verticalCenter(character.bbox!)));
      cluster.height = median(cluster.anchors.map((character) => character.bbox!.height));
    } else {
      clusters.push({ anchors: [anchor], center, height: anchor.bbox!.height });
    }
  }
  return clusters.sort((left, right) => left.center - right.center);
}

function assignSupportingCharactersV2(
  page: PdfPageFactsV2,
  lines: GeometryLineClusterV2[],
): Map<number, PdfTextCharacterFactV2[]> {
  const lineByAnchor = new Map<number, number>();
  lines.forEach((line, lineIndex) => {
    line.anchors.forEach((character) => lineByAnchor.set(character.index, lineIndex));
  });
  const anchorsByIndex = page.characters.filter(isGeometryAnchorV2)
    .sort((left, right) => left.index - right.index);
  const result = new Map(lines.map((_, lineIndex) => [lineIndex, [] as PdfTextCharacterFactV2[]]));
  lines.forEach((line, lineIndex) => result.get(lineIndex)!.push(...line.anchors));
  let nextAnchorOffset = 0;
  for (const character of [...page.characters].sort((left, right) => left.index - right.index)) {
    if (lineByAnchor.has(character.index) || isBreak(character)) continue;
    while (
      nextAnchorOffset < anchorsByIndex.length
      && anchorsByIndex[nextAnchorOffset]!.index < character.index
    ) {
      nextAnchorOffset += 1;
    }
    const previous = anchorsByIndex[nextAnchorOffset - 1];
    const next = anchorsByIndex[nextAnchorOffset];
    const previousLine = previous ? lineByAnchor.get(previous.index) : undefined;
    const nextLine = next ? lineByAnchor.get(next.index) : undefined;
    if (previousLine !== undefined && previousLine === nextLine) {
      result.get(previousLine)!.push(character);
    }
  }
  return result;
}

function directionalGapV2(
  left: PdfTextCharacterFactV2,
  right: PdfTextCharacterFactV2,
  direction: PdfTextDirection,
): number {
  if (!left.bbox || !right.bbox) return 0;
  return direction === "rtl"
    ? left.bbox.x - (right.bbox.x + right.bbox.width)
    : right.bbox.x - (left.bbox.x + left.bbox.width);
}

function splitGeometryLineV2(
  characters: readonly PdfTextCharacterFactV2[],
): PdfTextCharacterFactV2[][] {
  const sourceOrdered = [...characters].sort((left, right) => left.index - right.index);
  const anchors = sourceOrdered.filter(isGeometryAnchorV2);
  if (anchors.length === 0) return [];
  const direction = textDirection(anchors.map((character) => character.value).join(""));
  const widths = anchors.map((character) => character.bbox!.width).filter((width) => width > 0);
  const threshold = Math.max(
    PDF_GEOMETRY_POLICY_V2.fragmentGap,
    median(widths) * PDF_GEOMETRY_POLICY_V2.fragmentGapGlyphFactor,
  );
  const anchorGroups: PdfTextCharacterFactV2[][] = [];
  let current: PdfTextCharacterFactV2[] = [];
  for (const anchor of anchors) {
    const previous = current.at(-1);
    const separatedByWhitespace = direction === "rtl" && previous && sourceOrdered.some((character) =>
      character.index > previous.index
      && character.index < anchor.index
      && !isBreak(character)
      && /^\s$/u.test(character.value)
    );
    if (
      previous
      && !separatedByWhitespace
      && directionalGapV2(previous, anchor, direction) > threshold
    ) {
      anchorGroups.push(current);
      current = [];
    }
    current.push(anchor);
  }
  if (current.length > 0) anchorGroups.push(current);
  const groupByAnchor = new Map<number, number>();
  anchorGroups.forEach((group, groupIndex) =>
    group.forEach((character) => groupByAnchor.set(character.index, groupIndex))
  );
  const groups = anchorGroups.map((group) => [...group]);
  for (const character of sourceOrdered) {
    if (groupByAnchor.has(character.index)) continue;
    let previous: PdfTextCharacterFactV2 | undefined;
    let next: PdfTextCharacterFactV2 | undefined;
    for (const anchor of anchors) {
      if (anchor.index < character.index) previous = anchor;
      else if (anchor.index > character.index) {
        next = anchor;
        break;
      }
    }
    const previousGroup = previous ? groupByAnchor.get(previous.index) : undefined;
    const nextGroup = next ? groupByAnchor.get(next.index) : undefined;
    if (previousGroup !== undefined && previousGroup === nextGroup) {
      groups[previousGroup]!.push(character);
    }
  }
  return groups.map((group) => {
    const ordered = group.sort((left, right) => left.index - right.index);
    const valueDirection = textDirection(ordered.map((character) => character.value).join(""));
    const positioned = ordered.filter(isGeometryAnchorV2);
    const descending = positioned.length > 1 && positioned.every((character, index) =>
      index === 0 || character.bbox!.x <= positioned[index - 1]!.bbox!.x
    );
    if (valueDirection !== "rtl") return ordered;
    if (descending) return ordered.reverse();
    const logical: PdfTextCharacterFactV2[] = [];
    let token: PdfTextCharacterFactV2[] = [];
    const flushToken = () => {
      const tokenAnchors = token.filter(isGeometryAnchorV2);
      const ascending = tokenAnchors.length > 1 && tokenAnchors.every((character, index) =>
        index === 0 || character.bbox!.x >= tokenAnchors[index - 1]!.bbox!.x
      );
      logical.push(...(ascending ? token.reverse() : token));
      token = [];
    };
    for (const character of ordered) {
      if (!isBreak(character) && /^\s$/u.test(character.value)) {
        flushToken();
        logical.push(character);
      } else {
        token.push(character);
      }
    }
    flushToken();
    return logical;
  });
}

export function extractGeometryFragmentsV2(page: PdfPageFactsV2): PdfGeometryFragmentV2[] {
  const lines = clusterPhysicalLinesV2(page);
  const lineCharacters = assignSupportingCharactersV2(page, lines);
  const fragments: PdfGeometryFragmentV2[] = [];
  for (const [lineIndex] of lines.entries()) {
    for (const part of splitGeometryLineV2(lineCharacters.get(lineIndex) ?? [])) {
      const indexes = part.map((character) => character.index);
      const start = Math.min(...indexes);
      const end = Math.max(...indexes);
      const id = `pdf:p${page.index}:fragment-v2:${start}-${end}`;
      const assembly = assemblePdfTextV2({ sourceId: id, characters: part, orderBasis: "geometry" });
      if (!assembly.text || !assembly.bbox) continue;
      const sourceCharacters = part.filter((character) => !character.generated);
      const fontSizePoints = median(
        sourceCharacters.filter((character) => character.fontSizePoints > 1)
          .map((character) => character.fontSizePoints),
      );
      const angleRadians = median(sourceCharacters.map((character) => character.angleRadians));
      const fontWeight = median(sourceCharacters.map((character) => character.fontWeight));
      fragments.push({
        id,
        pageIndex: page.index,
        text: assembly.text,
        bbox: assembly.bbox,
        characters: [...part],
        assembly,
        fontSizePoints,
        fontWeight,
        angleRadians,
        direction: assembly.direction,
        sourceOrder: fragments.length,
        column: 0,
        furniture: pageFurnitureV2(assembly.text, assembly.bbox),
        physicalLineIndex: lineIndex,
      });
    }
  }
  return fragments;
}

function assignColumnsV2(
  fragments: PdfGeometryFragmentV2[],
  ignored: ReadonlySet<string>,
): number {
  const content = fragments.filter((fragment) =>
    !fragment.furniture && !fragment.duplicateOf && !ignored.has(fragment.id)
  );
  if (content.length === 0) return 1;
  const columnEvidence = content.some((fragment) => fragment.direction !== "rtl")
    ? content.filter((fragment) => fragment.direction !== "rtl")
    : content;
  const startGroups = new Map<number, PdfGeometryFragmentV2[]>();
  for (const fragment of columnEvidence) {
    const start = Math.round(
      fragment.bbox.x * PDF_GEOMETRY_POLICY_V2.columnStartPrecision,
    ) / PDF_GEOMETRY_POLICY_V2.columnStartPrecision;
    const group = startGroups.get(start) ?? [];
    group.push(fragment);
    startGroups.set(start, group);
  }
  const xs = [...startGroups.entries()]
    .filter(([, group]) => group.length >= PDF_GEOMETRY_POLICY_V2.minimumLinesPerColumn)
    .map(([start]) => start)
    .sort((left, right) => left - right);
  const boundaries: number[] = [];
  for (let index = 1; index < xs.length; index += 1) {
    const leftStart = xs[index - 1]!;
    const rightStart = xs[index]!;
    if (rightStart - leftStart < PDF_GEOMETRY_POLICY_V2.columnGap) continue;
    const boundary = (rightStart + leftStart) / 2;
    const left = columnEvidence.filter((fragment) => fragment.bbox.x < boundary);
    const right = columnEvidence.filter((fragment) => fragment.bbox.x > boundary);
    const alignedLeft = new Set<string>();
    const alignedRight = new Set<string>();
    for (const leftFragment of left) {
      for (const rightFragment of right) {
        const centerDelta = Math.abs(
          verticalCenter(leftFragment.bbox) - verticalCenter(rightFragment.bbox),
        );
        const tolerance = Math.max(leftFragment.bbox.height, rightFragment.bbox.height)
          * PDF_GEOMETRY_POLICY_V2.columnAlignmentGlyphFactor;
        if (centerDelta <= tolerance) {
          alignedLeft.add(leftFragment.id);
          alignedRight.add(rightFragment.id);
        }
      }
    }
    if (
      alignedLeft.size >= PDF_GEOMETRY_POLICY_V2.minimumLinesPerColumn
      && alignedRight.size >= PDF_GEOMETRY_POLICY_V2.minimumLinesPerColumn
    ) boundaries.push(boundary);
  }
  fragments.forEach((fragment) => {
    if (!fragment.furniture && !fragment.duplicateOf && !ignored.has(fragment.id)) {
      fragment.column = boundaries.filter((boundary) => fragment.bbox.x > boundary).length;
    }
  });
  return boundaries.length + 1;
}

export function analyzeGeometryReadingOrderV2(
  page: PdfPageFactsV2,
  ignoredFragmentIds: ReadonlySet<string> = new Set(),
): PdfReadingOrderPageV2 {
  const fragments = extractGeometryFragmentsV2(page);
  const reasons = new Set<string>();
  const extractedIndexes = new Set(fragments.flatMap((fragment) => fragment.assembly.characterIndexes));
  if (page.characters.some((character) =>
    !isBreak(character)
    && character.value.replace(/[\s\u00ad]/gu, "").length > 0
    && !extractedIndexes.has(character.index)
  )) reasons.add("missing-geometry");
  for (let left = 0; left < fragments.length; left += 1) {
    for (let right = left + 1; right < fragments.length; right += 1) {
      const a = fragments[left]!;
      const b = fragments[right]!;
      const ratio = overlapRatio(a.bbox, b.bbox);
      if (ratio >= PDF_GEOMETRY_POLICY_V2.duplicateOverlapRatio && a.text === b.text) {
        b.duplicateOf = a.id;
      } else if (ratio >= PDF_GEOMETRY_POLICY_V2.conflictingOverlapRatio && a.text !== b.text) {
        reasons.add("conflicting-overlap");
      }
    }
  }
  if (fragments.some((fragment) =>
    Math.abs(fragment.angleRadians) > PDF_GEOMETRY_POLICY_V2.maximumHorizontalAngleRadians
  )) reasons.add("non-horizontal-text");
  if (fragments.some((fragment) => fragment.assembly.hasUnicodeError)) reasons.add("unicode-map-error");
  if (fragments.some((fragment) => fragment.assembly.unresolvedBoundaryCount > 0)) {
    reasons.add("unresolved-text-boundary");
  }
  const columnCount = assignColumnsV2(fragments, ignoredFragmentIds);
  if (columnCount > PDF_GEOMETRY_POLICY_V2.maxColumns) reasons.add("too-many-columns");
  if (columnCount === 2) {
    const content = fragments.filter((fragment) =>
      !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id)
    );
    const counts = [0, 1].map((column) =>
      content.filter((fragment) => fragment.column === column).length
    );
    if (counts.some((count) => count < PDF_GEOMETRY_POLICY_V2.minimumLinesPerColumn)) {
      reasons.add("under-evidenced-column");
    }
    const leftEdge = Math.max(...content.filter((fragment) => fragment.column === 0)
      .map((fragment) => fragment.bbox.x + fragment.bbox.width));
    const rightEdge = Math.min(...content.filter((fragment) => fragment.column === 1)
      .map((fragment) => fragment.bbox.x));
    if (leftEdge >= rightEdge) reasons.add("column-overlap");
  }
  const ordered = fragments
    .filter((fragment) =>
      !fragment.furniture && !fragment.duplicateOf && !ignoredFragmentIds.has(fragment.id)
    )
    .sort((left, right) =>
      left.column - right.column
      || left.bbox.y - right.bbox.y
      || left.bbox.x - right.bbox.x
      || left.sourceOrder - right.sourceOrder
    );
  return {
    pageIndex: page.index,
    fragments,
    ordered,
    columnCount,
    qualificationReasons: [...reasons].sort(),
  };
}

function bridgeCharactersV2(
  page: PdfPageFactsV2,
  left: readonly PdfTextCharacterFactV2[],
  right: readonly PdfTextCharacterFactV2[],
  seen: ReadonlySet<number>,
): PdfTextCharacterFactV2[] {
  const leftMaximum = Math.max(...left.map((character) => character.index));
  const rightMinimum = Math.min(...right.map((character) => character.index));
  if (rightMinimum <= leftMaximum) return [];
  return page.characters.filter((character) =>
    character.index > leftMaximum
    && character.index < rightMinimum
    && !seen.has(character.index)
    && character.generated
    && (isBreak(character) || character.hyphen || character.value.includes("\u00ad"))
  );
}

export function assembleGeometryFragmentsV2(
  page: PdfPageFactsV2,
  sourceId: string,
  fragments: readonly PdfGeometryFragmentV2[],
): PdfTextAssemblyV2 {
  const characters: PdfTextCharacterFactV2[] = [];
  const seen = new Set<number>();
  for (const fragment of fragments) {
    if (characters.length > 0) {
      for (const character of bridgeCharactersV2(page, characters, fragment.characters, seen)) {
        seen.add(character.index);
        characters.push(character);
      }
    }
    for (const character of fragment.characters) {
      if (seen.has(character.index)) continue;
      seen.add(character.index);
      characters.push(character);
    }
  }
  return assemblePdfTextV2({ sourceId, characters, orderBasis: "geometry" });
}

export function geometryBodyFontSizeV2(pages: readonly PdfReadingOrderPageV2[]): number {
  return median(pages.flatMap((page) => page.ordered
    .map((fragment) => fragment.fontSizePoints)
    .filter((size) => size > 0)));
}

export function calibrateGeometryFontSizesV2(pages: readonly PdfReadingOrderPageV2[]): void {
  const fragments = pages.flatMap((page) => page.ordered);
  const reportedSizes = fragments.map((fragment) => fragment.fontSizePoints)
    .filter((size) => size > 1);
  const referenceSize = median(reportedSizes) || 10;
  const samples = new Map<string, Array<{ fragmentId: string; width: number }>>();
  for (const fragment of fragments) {
    for (const character of fragment.characters) {
      const key = character.value.normalize("NFC").toLocaleLowerCase("und");
      if (
        character.generated
        || !character.bbox
        || character.bbox.width <= 0
        || !/^[\p{L}\p{N}]$/u.test(key)
      ) continue;
      const values = samples.get(key) ?? [];
      values.push({ fragmentId: fragment.id, width: character.bbox.width });
      samples.set(key, values);
    }
  }
  const baselines = new Map<string, number>();
  for (const [key, values] of samples) {
    if (new Set(values.map((value) => value.fragmentId)).size < 2) continue;
    baselines.set(key, median(values.map((value) => value.width)));
  }
  for (const fragment of fragments) {
    if (fragment.fontSizePoints > 1) continue;
    const ratios = fragment.characters.flatMap((character) => {
      const key = character.value.normalize("NFC").toLocaleLowerCase("und");
      const baseline = baselines.get(key);
      return character.bbox && character.bbox.width > 0 && baseline && baseline > 0
        ? [character.bbox.width / baseline]
        : [];
    });
    fragment.fontSizePoints = ratios.length >= 5 ? referenceSize * median(ratios) : referenceSize;
  }
}
