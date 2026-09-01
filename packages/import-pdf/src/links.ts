import type { ImportRun } from "@atlcli/import-core";
import type {
  PdfAnnotationFact,
  PdfNormalizedRect,
  PdfPageFactsV2,
  PdfStructureNodeFactV2,
  PdfTextCharacterFact,
  PdfTextCharacterFactV2,
} from "./contracts.js";
import type { PdfTextAssemblyV2 } from "./text-assembly.js";
import {
  charactersForOrderedMcidsV2,
  correlateTaggedTextV2,
  normalizePdfText,
  normalizePdfTextFragment,
  orderedDescendantMcidsV2,
  type CorrelatedTaggedTextV2,
} from "./text.js";

function intersectionRatio(a: PdfNormalizedRect, b: PdfNormalizedRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = a.width * a.height;
  return area <= 0 ? 0 : (width * height) / area;
}

export function safeLinkForCharacter(
  character: PdfTextCharacterFact,
  annotations: readonly PdfAnnotationFact[],
): { href: string; annotationId: string } | null {
  if (!character.bbox) return null;
  for (const annotation of annotations) {
    if (!annotation.safeExternalTarget || !annotation.bbox) continue;
    if (intersectionRatio(character.bbox, annotation.bbox) >= 0.4) {
      return { href: annotation.safeExternalTarget, annotationId: annotation.id };
    }
  }
  return null;
}

export function taggedRuns(
  characters: readonly PdfTextCharacterFact[],
  annotations: readonly PdfAnnotationFact[],
  actualText?: string,
): { runs: ImportRun[]; annotationIds: string[] } {
  if (actualText) return { runs: [{ kind: "text", text: normalizePdfText(actualText) }], annotationIds: [] };
  const groups: Array<{ text: string; href?: string; annotationId?: string }> = [];
  for (const character of characters) {
    const link = safeLinkForCharacter(character, annotations);
    const previous = groups.at(-1);
    if (previous && previous.href === link?.href) previous.text += character.value;
    else groups.push({ text: character.value, ...(link ?? {}) });
  }
  const runs: ImportRun[] = [];
  const annotationIds = new Set<string>();
  for (const [index, group] of groups.entries()) {
    let text = normalizePdfTextFragment(group.text);
    if (index === 0) text = text.trimStart();
    if (index === groups.length - 1) text = text.trimEnd();
    if (!text) continue;
    if (group.annotationId) annotationIds.add(group.annotationId);
    runs.push({
      kind: "text",
      text,
      ...(group.href ? { marks: { link: { href: group.href } } } : {}),
    });
  }
  return { runs, annotationIds: [...annotationIds].sort() };
}

interface SafeSegmentLink {
  href: string;
  annotationId: string;
}

function sameLink(left: SafeSegmentLink | null, right: SafeSegmentLink | null): boolean {
  return left !== null
    && right !== null
    && left.href === right.href
    && left.annotationId === right.annotationId;
}

export function markedCharacterIndexesV2(
  characters: readonly PdfTextCharacterFactV2[],
  annotations: readonly PdfAnnotationFact[],
): number[] {
  return characters
    .filter((character) => safeLinkForCharacter(character, annotations) !== null)
    .map((character) => character.index);
}

export function correlateTaggedTextWithLinksV2(
  page: PdfPageFactsV2,
  node: PdfStructureNodeFactV2,
): CorrelatedTaggedTextV2 {
  const characters = charactersForOrderedMcidsV2(page, orderedDescendantMcidsV2(node));
  return correlateTaggedTextV2(
    page,
    node,
    markedCharacterIndexesV2(characters, page.annotations),
  );
}

/** Build runs from exact assembly segments so text and link boundaries cannot diverge. */
export function taggedRunsV2(
  assembly: PdfTextAssemblyV2,
  characters: readonly PdfTextCharacterFactV2[],
  annotations: readonly PdfAnnotationFact[],
): { runs: ImportRun[]; annotationIds: string[] } {
  const byIndex = new Map(characters.map((character) => [character.index, character]));
  const directLinks = assembly.segments.map((segment): SafeSegmentLink | null => {
    const links = segment.characterIndexes.flatMap((index) => {
      const character = byIndex.get(index);
      const link = character ? safeLinkForCharacter(character, annotations) : null;
      return link ? [link] : [];
    });
    if (links.length !== segment.characterIndexes.length || links.length === 0) return null;
    return links.every((link) => sameLink(links[0]!, link)) ? links[0]! : null;
  });
  const linkForSegment = (index: number): SafeSegmentLink | null => {
    const direct = directLinks[index];
    if (direct) return direct;
    const segment = assembly.segments[index]!;
    if (!segment.synthesized && !/^\s+$/u.test(segment.text)) return null;
    let left: SafeSegmentLink | null = null;
    let right: SafeSegmentLink | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (assembly.segments[cursor]!.synthesized) continue;
      left = directLinks[cursor] ?? null;
      break;
    }
    for (let cursor = index + 1; cursor < assembly.segments.length; cursor += 1) {
      if (assembly.segments[cursor]!.synthesized) continue;
      right = directLinks[cursor] ?? null;
      break;
    }
    return sameLink(left, right) ? left : null;
  };

  const runs: ImportRun[] = [];
  const annotationIds = new Set<string>();
  for (const [index, segment] of assembly.segments.entries()) {
    if (!segment.text) continue;
    const link = linkForSegment(index);
    if (link) annotationIds.add(link.annotationId);
    const marks = link ? { link: { href: link.href } } : undefined;
    const previous = runs.at(-1);
    const previousHref = previous?.kind === "text" ? previous.marks?.link?.href : undefined;
    if (previous?.kind === "text" && previousHref === marks?.link.href) {
      previous.text += segment.text;
    } else {
      runs.push({ kind: "text", text: segment.text, ...(marks ? { marks } : {}) });
    }
  }
  return { runs, annotationIds: [...annotationIds].sort() };
}
