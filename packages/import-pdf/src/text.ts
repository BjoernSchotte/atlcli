import type {
  PdfNormalizedRect,
  PdfPageFactsV1,
  PdfStructureNodeFact,
  PdfStructureNodeFactV2,
  PdfTextCharacterFact,
} from "./contracts.js";

export type PdfTextDirection = "ltr" | "rtl" | "neutral";

export interface CorrelatedTaggedText {
  text: string;
  characters: PdfTextCharacterFact[];
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
