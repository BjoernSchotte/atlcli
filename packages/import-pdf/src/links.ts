import type { ImportRun } from "@atlcli/import-core";
import type { PdfAnnotationFact, PdfNormalizedRect, PdfTextCharacterFact } from "./contracts.js";
import { normalizePdfText, normalizePdfTextFragment } from "./text.js";

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
