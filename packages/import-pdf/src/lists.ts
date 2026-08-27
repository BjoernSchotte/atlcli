import type { ImportIssue, ImportListBlock } from "@atlcli/import-core";
import {
  PDF_TAGGED_POLICY_REVISION_V2,
  type PdfDecisionEvidenceV1,
  type PdfDecisionEvidenceV2,
  type PdfPageFactsV1,
  type PdfPageFactsV2,
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
import { correlateTaggedText, orderedDescendantMcidsV2, unionRects } from "./text.js";
import { structureChildrenV2, structureRole, structureRoleV2 } from "./structure.js";
import { correlateTaggedTextWithLinksV2, taggedRuns, taggedRunsV2 } from "./links.js";
import type { PdfTextBoundaryDecisionV2, PdfTextTransformationV2 } from "./text-assembly.js";

export interface TaggedListProjection {
  block: ImportListBlock | null;
  evidence: PdfDecisionEvidenceV1[];
  issues: ImportIssue[];
  claimedCharacterIndexes: number[];
}

export interface TaggedListProjectionV2 {
  block: ImportListBlock | null;
  evidence: PdfDecisionEvidenceV2[];
  issues: ImportIssue[];
  claimedCharacterIndexes: number[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
}

function childrenWithRole(node: PdfStructureNodeFact, role: string): PdfStructureNodeFact[] {
  return node.children.filter((child) => structureRole(child) === role);
}

function childrenWithRoleV2(
  node: PdfStructureNodeFactV2,
  role: string,
): PdfStructureNodeFactV2[] {
  return structureChildrenV2(node).filter((child) => structureRoleV2(child) === role);
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

export function projectTaggedListV2(
  page: PdfPageFactsV2,
  node: PdfStructureNodeFactV2,
  corruptMcids: ReadonlySet<number>,
): TaggedListProjectionV2 {
  const evidence: PdfDecisionEvidenceV2[] = [];
  const issues: ImportIssue[] = [];
  const claimed = new Set<number>();
  const aggregate = {
    boundaries: [] as PdfTextBoundaryDecisionV2[],
    transformations: [] as PdfTextTransformationV2[],
  };
  const items: ImportListBlock["items"] = [];
  let ordered = false;
  for (const [itemIndex, item] of childrenWithRoleV2(node, "LI").entries()) {
    const label = childrenWithRoleV2(item, "Lbl")[0];
    const explicitBody = childrenWithRoleV2(item, "LBody")[0];
    const body = explicitBody ?? {
      ...item,
      directMcids: [],
      kids: item.kids.filter((kid) =>
        kid.kind !== "element" || structureRoleV2(kid.node) !== "Lbl"
      ),
    };
    const labelCorrelation = label ? correlateTaggedTextWithLinksV2(page, label) : null;
    if (labelCorrelation) {
      appendPdfTextAssemblyV2(aggregate, labelCorrelation.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(labelCorrelation.assembly, page.index, label!.id));
      labelCorrelation.characters.forEach((character) => claimed.add(character.index));
    }
    const labelText = labelCorrelation?.text ?? "";
    ordered ||= /^\s*(?:\d+|[a-z]+)[.)]\s*$/iu.test(labelText);
    const paragraph = childrenWithRoleV2(body, "P")[0] ?? body;
    const correlated = correlateTaggedTextWithLinksV2(page, paragraph);
    appendPdfTextAssemblyV2(aggregate, correlated.assembly);
    issues.push(...pdfTextAssemblyIssuesV2(correlated.assembly, page.index, item.id));
    const mcids = orderedDescendantMcidsV2(paragraph);
    const unresolvedStructure = paragraph.kids.some((kid) => kid.kind === "unresolved");
    if (
      !correlated.text
      || mcids.length === 0
      || mcids.some((mcid) => corruptMcids.has(mcid))
      || correlated.hasUnicodeError
      || unresolvedStructure
    ) {
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
    const tagged = taggedRunsV2(correlated.assembly, correlated.characters, page.annotations);
    const paragraphId = `${item.id}:paragraph`;
    const nested = childrenWithRoleV2(body, "L")[0];
    const child = nested ? projectTaggedListV2(page, nested, corruptMcids) : null;
    if (child) {
      child.claimedCharacterIndexes.forEach((index) => claimed.add(index));
      aggregate.boundaries.push(...child.boundaries);
      aggregate.transformations.push(...child.transformations);
      evidence.push(...child.evidence);
      issues.push(...child.issues);
    }
    items.push({
      blocks: [{ id: paragraphId, type: "paragraph", runs: tagged.runs, sourceRefs: [item.id] }],
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
        characterIndexes: correlated.assembly.characterIndexes,
        ...(tagged.annotationIds[0] ? { annotationId: tagged.annotationIds[0] } : {}),
      },
      basis: [
        "structure-tree",
        "marked-content",
        "text-boundary",
        ...(correlated.bbox ? ["text-geometry" as const] : []),
        ...(tagged.annotationIds.length > 0 ? ["annotation" as const] : []),
      ],
      confidence: pdfTextAssemblyConfidenceV2(correlated.assembly),
      decisionCode: correlated.assembly.unresolvedBoundaryCount > 0
        ? "pdf/tagged-list-item-boundary-unresolved"
        : "pdf/tagged-list-item-native",
      outcome: pdfTextAssemblyOutcomeV2(correlated.assembly),
      analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
      boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(correlated.assembly),
    });
  }
  if (items.length === 0) {
    return {
      block: null,
      evidence,
      issues,
      claimedCharacterIndexes: [...claimed].sort((left, right) => left - right),
      ...aggregate,
    };
  }
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
  ))];
  const bbox = unionRects(claimedCharacters.map((character) => character.bbox));
  const itemEvidence = evidence.filter((item) => item.decisionCode.includes("list-item"));
  const boundaryDecisionIds = [...new Set(itemEvidence.flatMap((item) => item.boundaryDecisionIds))];
  const outcome = itemEvidence.some((item) => item.outcome !== "native") ? "reported" : "native";
  evidence.unshift({
    sourceId: node.id,
    targetNodeId: block.id,
    locator: {
      pageIndex: page.index,
      ...(page.label ? { pageLabel: page.label } : {}),
      ...(bbox ? { bbox } : {}),
      structurePath: node.id,
      markedContentIds: claimedMcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
      characterIndexes: [...claimed].sort((left, right) => left - right),
    },
    basis: ["structure-tree", "marked-content", "text-boundary"],
    confidence: itemEvidence.length > 0
      ? Math.min(...itemEvidence.map((item) => item.confidence))
      : 0,
    decisionCode: outcome === "native" ? "pdf/tagged-list-native" : "pdf/tagged-list-reported",
    outcome,
    analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
    boundaryDecisionIds,
  });
  return {
    block,
    evidence,
    issues,
    claimedCharacterIndexes: [...claimed].sort((left, right) => left - right),
    ...aggregate,
  };
}
