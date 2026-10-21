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

const INLINE_LIST_BODY_ROLES = new Set(["NonStruct", "Span", "Strong", "Em", "Link", "Quote"]);
const LIST_MARKER = /^(?:[•◦▪▫‣⁃∙·●○■□–—*-]|\d{1,3}[.)]|[a-z][.)]|[ivxlc]{1,6}[.)])$/iu;

/**
 * Without an Lbl, some producers (LibreOffice) write the list marker into the
 * body as its own leading marked-content sequence. That sequence is the label
 * when it holds exactly one marker token and a later sequence holds text.
 */
function implicitListLabelV2(
  page: PdfPageFactsV2,
  paragraph: PdfStructureNodeFactV2 | undefined,
): { paragraph: PdfStructureNodeFactV2; characters: PdfPageFactsV2["characters"]; mcid: number } | null {
  const firstKid = paragraph?.kids[0];
  if (!paragraph || firstKid?.kind !== "mcid" || !paragraph.kids.slice(1).some((kid) => kid.kind === "mcid")) return null;
  const characters = page.characters.filter((character) => character.mcid === firstKid.mcid);
  const marker = characters.map((character) => character.value).join("").replace(/[\s\u00ad]/gu, "");
  if (!LIST_MARKER.test(marker)) return null;
  return {
    paragraph: {
      ...paragraph,
      directMcids: paragraph.directMcids.filter((mcid) => mcid !== firstKid.mcid),
      kids: paragraph.kids.slice(1),
    },
    characters,
    mcid: firstKid.mcid,
  };
}

export function projectTaggedListV2(
  page: PdfPageFactsV2,
  node: PdfStructureNodeFactV2,
  corruptMcids: ReadonlySet<number>,
  documentLexicon?: ReadonlySet<string>,
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
    const labelCorrelation = label ? correlateTaggedTextWithLinksV2(page, label, documentLexicon) : null;
    if (labelCorrelation) {
      appendPdfTextAssemblyV2(aggregate, labelCorrelation.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(labelCorrelation.assembly, page.index, label!.id));
    }
    const labelText = labelCorrelation?.text ?? "";
    const bodyChildren = structureChildrenV2(body);
    const inlineRole = (child: PdfStructureNodeFactV2) => INLINE_LIST_BODY_ROLES.has(structureRoleV2(child));
    const inlineBody = bodyChildren.length > 0 && bodyChildren.every(inlineRole);
    // Producers such as word processors put an item's own text directly into
    // LBody, followed by a nested list. That leading content is the item's
    // paragraph when it precedes every non-inline child.
    const leadingKids = body.kids.filter((kid) => kid.kind === "mcid" || (kid.kind === "element" && inlineRole(kid.node)));
    const firstBlockKid = body.kids.findIndex((kid) => kid.kind === "element" && !inlineRole(kid.node));
    const leadingParagraph = !inlineBody
      && bodyChildren.every((child) => structureRoleV2(child) !== "P")
      && leadingKids.length > 0
      && firstBlockKid >= 0
      && leadingKids.every((kid) => body.kids.indexOf(kid) < firstBlockKid)
      ? {
        ...body,
        directMcids: leadingKids.flatMap((kid) => kid.kind === "mcid" ? [kid.mcid] : []),
        kids: leadingKids,
      }
      : null;
    const paragraphNodes = bodyChildren.length === 0 || inlineBody
      ? [body]
      : leadingParagraph
        ? [leadingParagraph]
        : bodyChildren.filter((child) => structureRoleV2(child) === "P");
    const implicitLabel = label ? null : implicitListLabelV2(page, paragraphNodes[0]);
    if (implicitLabel) paragraphNodes[0] = implicitLabel.paragraph;
    const nestedNodes = bodyChildren.filter((child) => structureRoleV2(child) === "L");
    const unknownNodes = inlineBody ? [] : bodyChildren.filter((child) =>
      !["P", "L"].includes(structureRoleV2(child)) && !(leadingParagraph && inlineRole(child))
    );
    const nestedIndex = nestedNodes[0] ? bodyChildren.indexOf(nestedNodes[0]) : -1;
    const lastParagraphIndex = Math.max(-1, ...paragraphNodes.map((paragraph) =>
      bodyChildren.indexOf(paragraph)
    ));
    const compatibleNested = nestedNodes.length === 1
      && unknownNodes.length === 0
      && nestedIndex > lastParagraphIndex;
    const residualNodes = [
      ...unknownNodes,
      ...(compatibleNested ? [] : nestedNodes),
    ];
    for (const [residualIndex, residual] of residualNodes.entries()) {
      const correlated = correlateTaggedTextWithLinksV2(page, residual, documentLexicon);
      appendPdfTextAssemblyV2(aggregate, correlated.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(correlated.assembly, page.index, residual.id));
      evidence.push({
        sourceId: residual.id,
        locator: {
          pageIndex: page.index,
          ...(page.label ? { pageLabel: page.label } : {}),
          ...(correlated.bbox ? { bbox: correlated.bbox } : {}),
          structurePath: residual.id,
          markedContentIds: orderedDescendantMcidsV2(residual)
            .map((mcid) => `p${page.index}:mcid:${mcid}`),
          characterIndexes: correlated.assembly.characterIndexes,
        },
        basis: ["structure-tree", "marked-content", "text-boundary"],
        confidence: 0,
        decisionCode: "pdf/tagged-list-item-residual",
        outcome: "reported",
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(correlated.assembly),
      });
      issues.push({
        code: "pdf-import/tagged-list-item-residual",
        severity: "warning",
        outcome: "reported",
        message: "A list-item child cannot be represented in neutral list order and remains explicit fallback evidence.",
        sourceRefs: [residual.id],
        context: {
          pageIndex: page.index,
          itemIndex,
          residualIndex,
          role: structureRoleV2(residual),
        },
      });
    }

    const blocks: ImportListBlock["items"][number]["blocks"] = [];
    for (const [paragraphIndex, paragraph] of paragraphNodes.entries()) {
      const correlated = correlateTaggedTextWithLinksV2(page, paragraph, documentLexicon);
      appendPdfTextAssemblyV2(aggregate, correlated.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(correlated.assembly, page.index, paragraph.id));
      const mcids = orderedDescendantMcidsV2(paragraph);
      const unresolvedStructure = paragraph.kids.some((kid) => kid.kind === "unresolved");
      if (
        !correlated.text
        && (mcids.length > 0 || paragraph.kids.length === 0)
        && !mcids.some((mcid) => corruptMcids.has(mcid))
        && !correlated.hasUnicodeError
        && !unresolvedStructure
        && correlated.characters.every((character) => !character.value.trim())
      ) {
        // Marked content that paints nothing visible (e.g. a lone space).
        continue;
      }
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
          message: "A tagged list-item paragraph could not be correlated uniquely and requires fallback.",
          sourceRefs: [paragraph.id],
          context: { pageIndex: page.index, itemIndex, paragraphIndex },
        });
        evidence.push({
          sourceId: paragraph.id,
          locator: {
            pageIndex: page.index,
            ...(page.label ? { pageLabel: page.label } : {}),
            ...(correlated.bbox ? { bbox: correlated.bbox } : {}),
            structurePath: paragraph.id,
            markedContentIds: mcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
            characterIndexes: correlated.assembly.characterIndexes,
          },
          basis: ["structure-tree", "marked-content", "text-boundary"],
          confidence: 0,
          decisionCode: "pdf/tagged-list-item-paragraph-demoted",
          outcome: "reported",
          analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
          boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(correlated.assembly),
        });
        continue;
      }
      correlated.characters.forEach((character) => claimed.add(character.index));
      const tagged = taggedRunsV2(correlated.assembly, correlated.characters, page.annotations);
      const paragraphId = `${paragraph.id}:paragraph`;
      blocks.push({
        id: paragraphId,
        type: "paragraph",
        runs: tagged.runs,
        sourceRefs: [paragraph.id],
      });
      evidence.push({
        sourceId: paragraph.id,
        targetNodeId: paragraphId,
        locator: {
          pageIndex: page.index,
          ...(page.label ? { pageLabel: page.label } : {}),
          ...(correlated.bbox ? { bbox: correlated.bbox } : {}),
          structurePath: paragraph.id,
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
          : "pdf/tagged-list-item-paragraph-native",
        outcome: pdfTextAssemblyOutcomeV2(correlated.assembly),
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(correlated.assembly),
      });
    }
    const nested = compatibleNested ? nestedNodes[0] : undefined;
    const child = nested ? projectTaggedListV2(page, nested, corruptMcids, documentLexicon) : null;
    if (child) {
      child.claimedCharacterIndexes.forEach((index) => claimed.add(index));
      aggregate.boundaries.push(...child.boundaries);
      aggregate.transformations.push(...child.transformations);
      evidence.push(...child.evidence);
      issues.push(...child.issues);
    }
    if (blocks.length === 0 && paragraphNodes.length > 0 && !child && !evidence.some((entry) =>
      entry.decisionCode === "pdf/tagged-list-item-paragraph-demoted"
      && paragraphNodes.some((paragraph) => paragraph.id === entry.sourceId)
    )) {
      // Every body paragraph was empty: an authored empty item (bullet only).
      const paragraphId = `${body.id}:empty:paragraph`;
      blocks.push({ id: paragraphId, type: "paragraph", runs: [], sourceRefs: [body.id] });
      evidence.push({
        sourceId: body.id,
        targetNodeId: paragraphId,
        locator: { pageIndex: page.index, ...(page.label ? { pageLabel: page.label } : {}), structurePath: body.id },
        basis: ["structure-tree", "marked-content"],
        confidence: 1,
        decisionCode: "pdf/tagged-list-item-paragraph-empty",
        outcome: "native",
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: [],
      });
    }
    if (blocks.length === 0) {
      issues.push({
        code: "pdf-import/tagged-list-item-demoted",
        severity: "warning",
        outcome: "reported",
        message: "A tagged list item has no representable paragraph content.",
        sourceRefs: [item.id],
        context: { pageIndex: page.index, itemIndex },
      });
      continue;
    }
    const labelMcids = label ? orderedDescendantMcidsV2(label) : [];
    const validLabel = labelCorrelation
      && labelMcids.length > 0
      && !labelMcids.some((mcid) => corruptMcids.has(mcid))
      && !labelCorrelation.hasUnicodeError
      && labelCorrelation.assembly.unresolvedBoundaryCount === 0;
    if (validLabel) {
      ordered ||= /^\s*(?:\d+|[a-z]+)[.)]\s*$/iu.test(labelText);
      labelCorrelation.characters.forEach((character) => claimed.add(character.index));
      evidence.push({
        sourceId: label!.id,
        targetNodeId: blocks[0]!.id,
        locator: {
          pageIndex: page.index,
          ...(page.label ? { pageLabel: page.label } : {}),
          ...(labelCorrelation.bbox ? { bbox: labelCorrelation.bbox } : {}),
          structurePath: label!.id,
          markedContentIds: labelMcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
          characterIndexes: labelCorrelation.assembly.characterIndexes,
        },
        basis: ["structure-tree", "marked-content", "text-boundary"],
        confidence: pdfTextAssemblyConfidenceV2(labelCorrelation.assembly),
        decisionCode: "pdf/tagged-list-label-native",
        outcome: "native",
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(labelCorrelation.assembly),
      });
    } else if (label) {
      evidence.push({
        sourceId: label.id,
        locator: {
          pageIndex: page.index,
          structurePath: label.id,
          markedContentIds: labelMcids.map((mcid) => `p${page.index}:mcid:${mcid}`),
          characterIndexes: labelCorrelation?.assembly.characterIndexes ?? [],
        },
        basis: ["structure-tree", "marked-content", "text-boundary"],
        confidence: 0,
        decisionCode: "pdf/tagged-list-label-demoted",
        outcome: "reported",
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: labelCorrelation
          ? pdfTextBoundaryDecisionIdsV2(labelCorrelation.assembly)
          : [],
      });
    }
    if (implicitLabel) {
      const labelValue = implicitLabel.characters.map((character) => character.value).join("");
      ordered ||= /^\s*(?:\d+|[a-z]+)[.)]\s*$/iu.test(labelValue);
      implicitLabel.characters.forEach((character) => claimed.add(character.index));
      evidence.push({
        sourceId: `${paragraphNodes[0]!.id}:implicit-label`,
        targetNodeId: blocks[0]!.id,
        locator: {
          pageIndex: page.index,
          ...(page.label ? { pageLabel: page.label } : {}),
          structurePath: paragraphNodes[0]!.id,
          markedContentIds: [`p${page.index}:mcid:${implicitLabel.mcid}`],
          characterIndexes: implicitLabel.characters.map((character) => character.index),
        },
        basis: ["structure-tree", "marked-content"],
        confidence: 0.95,
        decisionCode: "pdf/tagged-list-label-implicit",
        outcome: "native",
        analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
        boundaryDecisionIds: [],
      });
    }
    items.push({
      blocks,
      ...(child?.block ? { child: child.block } : {}),
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
