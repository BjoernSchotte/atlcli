import type { ImportIssue, ImportListBlock } from "@atlcli/import-core";
import type { PdfDecisionEvidenceV1, PdfPageFactsV1, PdfStructureNodeFact } from "./contracts.js";
import { correlateTaggedText, unionRects } from "./text.js";
import { structureRole } from "./structure.js";
import { taggedRuns } from "./links.js";

export interface TaggedListProjection {
  block: ImportListBlock | null;
  evidence: PdfDecisionEvidenceV1[];
  issues: ImportIssue[];
  claimedCharacterIndexes: number[];
}

function childrenWithRole(node: PdfStructureNodeFact, role: string): PdfStructureNodeFact[] {
  return node.children.filter((child) => structureRole(child) === role);
}

export function projectTaggedList(
  page: PdfPageFactsV1,
  node: PdfStructureNodeFact,
  corruptMcids: ReadonlySet<number>,
): TaggedListProjection {
  const evidence: PdfDecisionEvidenceV1[] = [];
  const issues: ImportIssue[] = [];
  const claimed = new Set<number>();
  const items = [];
  let ordered = false;
  for (const [itemIndex, item] of childrenWithRole(node, "LI").entries()) {
    const label = childrenWithRole(item, "Lbl")[0];
    const body = childrenWithRole(item, "LBody")[0] ?? item;
    const labelCorrelation = label ? correlateTaggedText(page, label) : null;
    const labelText = labelCorrelation?.text ?? "";
    labelCorrelation?.characters.forEach((character) => claimed.add(character.index));
    ordered ||= /^\s*(?:\d+|[a-z]+)[.)]\s*$/iu.test(labelText);
    const paragraph = body.children.find((child) => structureRole(child) === "P") ?? body;
    const correlated = correlateTaggedText(page, paragraph);
    const mcids = [...new Set(correlated.characters.map((character) => character.mcid).filter(
      (mcid): mcid is number => mcid !== null,
    ))];
    if (!correlated.text || mcids.some((mcid) => corruptMcids.has(mcid))) {
      issues.push({
        code: "pdf-import/tagged-list-item-demoted",
        severity: "warning",
        outcome: "reported",
        message: "A tagged list item could not be correlated uniquely and requires geometry fallback.",
        sourceRefs: [item.id],
        context: { pageIndex: page.index, itemIndex },
      });
      continue;
    }
    correlated.characters.forEach((character) => claimed.add(character.index));
    const tagged = taggedRuns(
      correlated.characters,
      page.annotations,
      correlated.usedActualText ? correlated.text : undefined,
    );
    const paragraphId = `${item.id}:paragraph`;
    const nested = body.children.find((child) => structureRole(child) === "L");
    const child = nested ? projectTaggedList(page, nested, corruptMcids) : null;
    if (child) {
      child.claimedCharacterIndexes.forEach((index) => claimed.add(index));
      evidence.push(...child.evidence);
      issues.push(...child.issues);
    }
    items.push({
      blocks: [{ id: paragraphId, type: "paragraph" as const, runs: tagged.runs, sourceRefs: [item.id] }],
      ...(child?.block ? { child: child.block } : {}),
    });
    evidence.push({
      sourceId: item.id,
      targetNodeId: paragraphId,
      locator: {
        pageIndex: page.index,
        ...(page.label ? { pageLabel: page.label } : {}),
        ...(correlated.bbox ? { bbox: correlated.bbox } : {}),
        structurePath: item.id,
        markedContentIds: mcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
        ...(tagged.annotationIds[0] ? { annotationId: tagged.annotationIds[0] } : {}),
      },
      basis: [
        "structure-tree",
        "marked-content",
        ...(correlated.bbox ? ["text-geometry" as const] : []),
        ...(tagged.annotationIds.length > 0 ? ["annotation" as const] : []),
      ],
      confidence: correlated.usedActualText ? 0.99 : 1,
      decisionCode: "pdf/tagged-list-item-native",
      outcome: "native",
      analyzerRevision: "atlcli.pdf-tagged-policy/1",
    });
  }
  if (items.length === 0) return { block: null, evidence, issues, claimedCharacterIndexes: [...claimed] };
  const block: ImportListBlock = {
    id: `${node.id}:list`,
    type: "list",
    ordered,
    items,
    sourceRefs: [node.id],
  };
  const claimedCharacters = page.characters.filter((character) => claimed.has(character.index));
  const claimedMcids = [...new Set(claimedCharacters.map((character) => character.mcid).filter(
    (mcid): mcid is number => mcid !== null,
  ))].sort((a, b) => a - b);
  const bbox = unionRects(claimedCharacters.map((character) => character.bbox));
  evidence.unshift({
    sourceId: node.id,
    targetNodeId: block.id,
    locator: {
      pageIndex: page.index,
      ...(page.label ? { pageLabel: page.label } : {}),
      ...(bbox ? { bbox } : {}),
      structurePath: node.id,
      markedContentIds: claimedMcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
    },
    basis: ["structure-tree", "marked-content"],
    confidence: 1,
    decisionCode: "pdf/tagged-list-native",
    outcome: "native",
    analyzerRevision: "atlcli.pdf-tagged-policy/1",
  });
  return { block, evidence, issues, claimedCharacterIndexes: [...claimed].sort((a, b) => a - b) };
}
