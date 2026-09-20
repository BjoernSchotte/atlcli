import type {
  PdfNormalizedRect,
  PdfPageFactsV1,
  PdfPageFactsV2,
  PdfStructureNodeFact,
  PdfStructureNodeFactV2,
  PdfTextCharacterFact,
  PdfTextCharacterFactV2,
} from "./contracts.js";
import { assemblePdfTextV2, type PdfTextAssemblyV2 } from "./text-assembly.js";

export type PdfTextDirection = "ltr" | "rtl" | "neutral";

export interface CorrelatedTaggedText {
  text: string;
  characters: PdfTextCharacterFact[];
  bbox: PdfNormalizedRect | null;
  direction: PdfTextDirection;
  hasUnicodeError: boolean;
  usedActualText: boolean;
}

export interface CorrelatedTaggedTextV2 {
  text: string;
  characters: PdfTextCharacterFactV2[];
  assembly: PdfTextAssemblyV2;
  bbox: PdfNormalizedRect | null;
  direction: PdfTextDirection;
  hasUnicodeError: boolean;
  usedActualText: boolean;
}

export function descendantMcids(node: PdfStructureNodeFact): number[] {
  const values = [...node.mcids, ...node.childMcids];
  for (const child of node.children) values.push(...descendantMcids(child));
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value >= 0))].sort(
    (a, b) => a - b,
  );
}

/** Ordered V2 traversal uses direct MCIDs only when no ordered kid is usable. */
export function orderedDescendantMcidsV2(node: PdfStructureNodeFactV2): number[] {
  const values: number[] = [];
  const visit = (current: PdfStructureNodeFactV2): void => {
    const usableKids = current.kids.filter((kid) => kid.kind !== "unresolved");
    if (usableKids.length === 0) {
      values.push(...current.directMcids);
      return;
    }
    for (const kid of current.kids) {
      if (kid.kind === "mcid") values.push(kid.mcid);
      else if (kid.kind === "element") visit(kid.node);
    }
  };
  visit(node);
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value >= 0))];
}

export function unresolvedStructureKidIndexesV2(node: PdfStructureNodeFactV2): number[] {
  const values: number[] = [];
  const visit = (current: PdfStructureNodeFactV2): void => {
    for (const kid of current.kids) {
      if (kid.kind === "unresolved") values.push(kid.index);
      else if (kid.kind === "element") visit(kid.node);
    }
  };
  visit(node);
  return values;
}

export function normalizePdfText(value: string): string {
  return normalizePdfTextFragment(value).trim();
}

export function normalizePdfTextFragment(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00ad(?=\n|$)/gu, "")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, " ")
    // PDF text APIs can surface non-rendering C0/C1 control codes. Confluence
    // removes them from ADF on write, so discard them at the source boundary
    // before preview and semantic readback digests are calculated.
    .replace(/\p{Cc}+/gu, "")
    .normalize("NFC");
}

export function textDirection(value: string): PdfTextDirection {
  let ltr = 0;
  let rtl = 0;
  for (const character of value) {
    if (/\p{Script=Arabic}|\p{Script=Hebrew}/u.test(character)) rtl += 1;
    else if (/\p{Letter}|\p{Number}/u.test(character)) ltr += 1;
  }
  if (rtl > ltr) return "rtl";
  if (ltr > 0) return "ltr";
  return "neutral";
}

export function unionRects(
  rects: Array<PdfNormalizedRect | null | undefined>,
): PdfNormalizedRect | null {
  const values = rects.filter((rect): rect is PdfNormalizedRect => rect !== null && rect !== undefined);
  if (values.length === 0) return null;
  const left = Math.min(...values.map((rect) => rect.x));
  const top = Math.min(...values.map((rect) => rect.y));
  const right = Math.max(...values.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...values.map((rect) => rect.y + rect.height));
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, right - left)),
    height: round(Math.max(0, bottom - top)),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function charactersForMcids(
  page: PdfPageFactsV1,
  mcids: readonly number[],
): PdfTextCharacterFact[] {
  const accepted = new Set(mcids);
  return page.characters
    .filter((character) => character.mcid !== null && accepted.has(character.mcid))
    .sort((a, b) => a.index - b.index);
}

/** Preserve structure-tree MCID order and page order only inside each MCID. */
export function charactersForOrderedMcidsV2(
  page: PdfPageFactsV2,
  mcids: readonly number[],
): PdfTextCharacterFactV2[] {
  const result: PdfTextCharacterFactV2[] = [];
  const seen = new Set<number>();
  for (const mcid of mcids) {
    const owned = page.characters.filter((character) => character.mcid === mcid);
    const previous = result.at(-1);
    const first = owned[0];
    if (previous && first && first.index > previous.index) {
      for (const bridge of page.characters) {
        if (
          bridge.index <= previous.index
          || bridge.index >= first.index
          || seen.has(bridge.index)
          || !bridge.generated
          || (!/^\s*$/u.test(bridge.value) && !bridge.hyphen && !bridge.value.includes("\u00ad"))
        ) continue;
        seen.add(bridge.index);
        result.push(bridge);
      }
    }
    for (const character of owned) {
      if (seen.has(character.index)) continue;
      seen.add(character.index);
      result.push(character);
    }
  }
  return result;
}

export function correlateTaggedText(
  page: PdfPageFactsV1,
  node: PdfStructureNodeFact,
): CorrelatedTaggedText {
  const characters = charactersForMcids(page, descendantMcids(node));
  const extracted = normalizePdfText(characters.map((character) => character.value).join(""));
  const actual = normalizePdfText(node.actualText);
  const text = actual || extracted;
  return {
    text,
    characters,
    bbox: unionRects(characters.map((character) => character.bbox)),
    direction: textDirection(text),
    hasUnicodeError: characters.some((character) => character.unicodeMapError),
    usedActualText: actual.length > 0,
  };
}

export function correlateTaggedTextV2(
  page: PdfPageFactsV2,
  node: PdfStructureNodeFactV2,
  markedCharacterIndexes: readonly number[] = [],
): CorrelatedTaggedTextV2 {
  const characters = charactersForOrderedMcidsV2(page, orderedDescendantMcidsV2(node));
  const sourceAssembly = assemblePdfTextV2({
    sourceId: node.id,
    characters,
    orderBasis: "structure-order",
    ...(node.actualText.length > 0 ? { actualText: node.actualText } : {}),
    ...(markedCharacterIndexes.length > 0 ? { markedCharacterIndexes } : {}),
  });
  const childCorrelations = node.actualText.length > 0
    ? []
    : node.kids.flatMap((kid) => {
        if (kid.kind !== "element") return [];
        const childIndexes = new Set(orderedDescendantMcidsV2(kid.node));
        const childMarked = markedCharacterIndexes.filter((index) => {
          const character = page.characters.find((candidate) => candidate.index === index);
          return character?.mcid !== null && character !== undefined && childIndexes.has(character.mcid);
        });
        const correlated = correlateTaggedTextV2(page, kid.node, childMarked);
        return correlated.usedActualText ? [correlated] : [];
      });
  let assembly = sourceAssembly;
  if (childCorrelations.length > 0) {
    const byCharacterIndex = new Map<number, CorrelatedTaggedTextV2>();
    for (const correlated of childCorrelations) {
      for (const index of correlated.assembly.characterIndexes) {
        byCharacterIndex.set(index, correlated);
      }
    }
    const emitted = new Set<CorrelatedTaggedTextV2>();
    const segments: PdfTextAssemblyV2["segments"] = [];
    const segmentOwners = sourceAssembly.segments.map((segment) =>
      segment.characterIndexes.length > 0
        ? byCharacterIndex.get(segment.characterIndexes[0]!)
        : undefined
    );
    for (const [segmentIndex, segment] of sourceAssembly.segments.entries()) {
      let replacement = segmentOwners[segmentIndex];
      if (!replacement && segment.characterIndexes.length === 0) {
        let left: CorrelatedTaggedTextV2 | undefined;
        for (let cursor = segmentIndex - 1; cursor >= 0; cursor -= 1) {
          if (segmentOwners[cursor] === undefined) continue;
          left = segmentOwners[cursor];
          break;
        }
        const right = segmentOwners.slice(segmentIndex + 1).find((owner) => owner !== undefined);
        if (left && left === right) replacement = left;
      }
      if (!replacement) {
        segments.push(segment);
        continue;
      }
      if (!emitted.has(replacement)) {
        segments.push(...replacement.assembly.segments);
        emitted.add(replacement);
      }
    }
    const replacedIndexes = new Set(byCharacterIndex.keys());
    const boundaries = [
      ...sourceAssembly.boundaries,
      ...childCorrelations.flatMap((correlated) => correlated.assembly.boundaries),
    ];
    const transformations = [
      ...sourceAssembly.transformations.filter((transformation) =>
        transformation.characterIndexes.every((index) => !replacedIndexes.has(index))
      ),
      ...childCorrelations.flatMap((correlated) => correlated.assembly.transformations),
    ];
    const issues = childCorrelations.flatMap((correlated) => correlated.assembly.issues);
    const text = segments.map((segment) => segment.text).join("").normalize("NFC");
    assembly = {
      ...sourceAssembly,
      text,
      segments,
      boundaries,
      transformations,
      issues,
      unresolvedBoundaryCount: boundaries.filter((boundary) => boundary.action === "unresolved").length,
      direction: textDirection(text),
      usedActualText: true,
    };
  }
  return {
    text: assembly.text,
    characters,
    assembly,
    bbox: assembly.bbox,
    direction: assembly.direction,
    hasUnicodeError: assembly.hasUnicodeError,
    usedActualText: assembly.usedActualText,
  };
}
