import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  type ImportBlock,
  type ImportDocumentV2,
  type ImportIssue,
} from "@atlcli/import-core";
import {
  PDF_TAGGED_POLICY_REVISION,
  PDF_TAGGED_SEMANTICS_SCHEMA_V1,
  type PdfDecisionEvidenceV1,
  type PdfFactsV1,
  type PdfPageFactsV1,
  type PdfStructureNodeFact,
  type PdfTaggedPageOutcomeV1,
  type PdfTaggedSemanticsV1,
} from "./contracts.js";
import { digestPdfCanonical, digestPdfFacts } from "./canonical.js";
import { headingHierarchyGap, taggedHeadingLevel } from "./headings.js";
import { projectTaggedList } from "./lists.js";
import { taggedRuns } from "./links.js";
import { indexTaggedStructure, isSemanticContainer, structureRole } from "./structure.js";
import { correlateTaggedText, descendantMcids } from "./text.js";
import { PdfImportError } from "./issues.js";
import { projectTaggedTable } from "./tables.js";

interface MutableProjection {
  blocks: ImportBlock[];
  evidence: PdfDecisionEvidenceV1[];
  issues: ImportIssue[];
  claimedCharacterIndexes: Set<number>;
  corruptTagCount: number;
  previousHeadingLevel: number | null;
}

function locator(page: PdfPageFactsV1, node: PdfStructureNodeFact, bbox?: ReturnType<typeof correlateTaggedText>["bbox"]) {
  const mcids = descendantMcids(node).map((mcid) => `p${page.index}:mcid:${mcid}`);
  return {
    pageIndex: page.index,
    ...(page.label ? { pageLabel: page.label } : {}),
    ...(bbox ? { bbox } : {}),
    structurePath: node.id,
    ...(mcids.length > 0 ? { markedContentIds: mcids } : {}),
  };
}

function reportDeferred(
  page: PdfPageFactsV1,
  node: PdfStructureNodeFact,
  state: MutableProjection,
  feature: "table" | "figure" | "unsupported",
): void {
  const correlated = correlateTaggedText(page, node);
  correlated.characters.forEach((character) => state.claimedCharacterIndexes.add(character.index));
  state.evidence.push({
    sourceId: node.id,
    locator: locator(page, node, correlated.bbox),
    basis: ["structure-tree", "marked-content"],
    confidence: 1,
    decisionCode: `pdf/tagged-${feature}-deferred`,
    outcome: "reported",
    analyzerRevision: PDF_TAGGED_POLICY_REVISION,
  });
  state.issues.push({
    code: `pdf-import/tagged-${feature}-deferred`,
    severity: "info",
    outcome: "reported",
    message: `Tagged ${feature} semantics are preserved as evidence for a later feature task.`,
    sourceRefs: [node.id],
    context: { pageIndex: page.index, markedContentIds: descendantMcids(node).length },
  });
}

function projectNode(
  page: PdfPageFactsV1,
  node: PdfStructureNodeFact,
  corruptMcids: ReadonlySet<number>,
  state: MutableProjection,
): void {
  const role = structureRole(node);
  if (isSemanticContainer(role)) {
    for (const child of node.children) projectNode(page, child, corruptMcids, state);
    return;
  }
  if (role === "Table") {
    const table = projectTaggedTable(page, node, corruptMcids);
    state.blocks.push(...table.blocks);
    state.evidence.push(...table.evidence);
    state.issues.push(...table.issues);
    table.claimedCharacterIndexes.forEach((index) => state.claimedCharacterIndexes.add(index));
    if (table.mode !== "native") state.corruptTagCount += 1;
    return;
  }
  if (role === "Figure") {
    reportDeferred(page, node, state, "figure");
    return;
  }
  if (role === "L") {
    const list = projectTaggedList(page, node, corruptMcids);
    state.evidence.push(...list.evidence);
    state.issues.push(...list.issues);
    list.claimedCharacterIndexes.forEach((index) => state.claimedCharacterIndexes.add(index));
    if (list.block) state.blocks.push(list.block);
    else state.corruptTagCount += 1;
    return;
  }
  const headingLevel = taggedHeadingLevel(role);
  if (role !== "P" && headingLevel === null) {
    reportDeferred(page, node, state, "unsupported");
    return;
  }
  const correlated = correlateTaggedText(page, node);
  const mcids = descendantMcids(node);
  const corrupt = mcids.length === 0
    || mcids.some((mcid) => corruptMcids.has(mcid))
    || correlated.hasUnicodeError
    || correlated.text.length === 0;
  if (corrupt) {
    state.corruptTagCount += 1;
    state.issues.push({
      code: "pdf-import/tagged-node-demoted",
      severity: "warning",
      outcome: "reported",
      message: "A tagged text node is missing, ambiguous, or has invalid Unicode mapping and requires geometry fallback.",
      sourceRefs: [node.id],
      context: { pageIndex: page.index, markedContentIds: mcids.length },
    });
    state.evidence.push({
      sourceId: node.id,
      locator: locator(page, node, correlated.bbox),
      basis: ["structure-tree", "marked-content"],
      confidence: 0,
      decisionCode: "pdf/tagged-node-demoted",
      outcome: "reported",
      analyzerRevision: PDF_TAGGED_POLICY_REVISION,
    });
    return;
  }
  correlated.characters.forEach((character) => state.claimedCharacterIndexes.add(character.index));
  const { runs, annotationIds } = taggedRuns(
    correlated.characters,
    page.annotations,
    correlated.usedActualText ? correlated.text : undefined,
  );
  const id = `${node.id}:${headingLevel === null ? "paragraph" : `heading-${headingLevel}`}`;
  const block: ImportBlock = headingLevel === null
    ? { id, type: "paragraph", runs, sourceRefs: [node.id] }
    : { id, type: "heading", level: headingLevel, runs, sourceRefs: [node.id] };
  if (headingLevel !== null) {
    if (headingHierarchyGap(state.previousHeadingLevel, headingLevel)) {
      state.issues.push({
        code: "pdf-import/tagged-heading-gap",
        severity: "warning",
        outcome: "native",
        message: "A tagged heading level skips an ancestor level; the explicit source level was retained.",
        sourceRefs: [node.id],
        context: { pageIndex: page.index, level: headingLevel },
      });
    }
    state.previousHeadingLevel = headingLevel;
  }
  state.blocks.push(block);
  state.evidence.push({
    sourceId: node.id,
    targetNodeId: id,
    locator: {
      ...locator(page, node, correlated.bbox),
      ...(annotationIds[0] ? { annotationId: annotationIds[0] } : {}),
    },
    basis: [
      "structure-tree",
      "marked-content",
      ...(correlated.bbox ? ["text-geometry" as const] : []),
      ...(annotationIds.length > 0 ? ["annotation" as const] : []),
    ],
    confidence: correlated.usedActualText ? 0.99 : 1,
    decisionCode: headingLevel === null ? "pdf/tagged-paragraph-native" : "pdf/tagged-heading-native",
    outcome: "native",
    analyzerRevision: PDF_TAGGED_POLICY_REVISION,
  });
}

function eligibleCharacters(page: PdfPageFactsV1): number[] {
  return page.characters
    .filter((character) => character.mcid !== null && normalizeVisible(character.value))
    .map((character) => character.index);
}

function normalizeVisible(value: string): boolean {
  return value.replace(/[\s\u00ad]/gu, "").length > 0;
}

function blockText(block: ImportBlock): string {
  if (block.type === "heading" || block.type === "paragraph") {
    return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
  }
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...item.blocks.map(blockText),
      ...(item.child ? [blockText(item.child)] : []),
    ]).join("\n");
  }
  if (block.type === "blockquote") return block.blocks.map(blockText).join("\n");
  if (block.type === "code") return block.text;
  if (block.type === "table") {
    return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map(blockText))).join("\n");
  }
  return "";
}

function reportRepeatedTaggedRegions(blocks: readonly ImportBlock[], issues: ImportIssue[]): void {
  const groups = new Map<string, ImportBlock[]>();
  for (const block of blocks) {
    const text = blockText(block).normalize("NFC").replace(/\s+/gu, " ").trim();
    if (text.length < 4) continue;
    groups.set(text, [...(groups.get(text) ?? []), block]);
  }
  for (const repeated of groups.values()) {
    if (repeated.length < 2) continue;
    issues.push({
      code: "pdf-import/tagged-repeated-region-retained",
      severity: "info",
      outcome: "native",
      message: "Repeated tagged content was retained with distinct source evidence; removal requires the repeated-region policy.",
      sourceRefs: repeated.flatMap((block) => block.sourceRefs ?? []),
      context: { occurrences: repeated.length },
    });
  }
}

export async function normalizeTaggedPdfFacts(
  facts: PdfFactsV1,
  factsDigest: string,
): Promise<PdfTaggedSemanticsV1> {
  const actualFactsDigest = await digestPdfFacts(facts);
  if (actualFactsDigest !== factsDigest) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF facts differ from the digest supplied to tagged semantic normalization.",
    );
  }
  const blocks: ImportBlock[] = [];
  const evidence: PdfDecisionEvidenceV1[] = [];
  const issues: ImportIssue[] = facts.issues.map(({ pageIndex, ...issue }) => ({
    ...issue,
    ...(pageIndex === undefined ? {} : { context: { ...issue.context, pageIndex } }),
  }));
  const pageOutcomes: PdfTaggedPageOutcomeV1[] = [];
  const requiresGeometryPages: number[] = [];
  let previousHeadingLevel: number | null = null;
  for (const page of facts.pages) {
    const pageBlockStart = blocks.length;
    const index = indexTaggedStructure(page);
    const state: MutableProjection = {
      blocks,
      evidence,
      issues,
      claimedCharacterIndexes: new Set(),
      corruptTagCount: index.duplicateMcids.size,
      previousHeadingLevel,
    };
    if (!facts.tagged || page.structures.length === 0) {
      state.corruptTagCount += 1;
      issues.push({
        code: "pdf-import/tagged-structure-missing",
        severity: "warning",
        outcome: "reported",
        message: "The page has no usable structure tree and requires geometry analysis.",
        sourceRefs: [`pdf:p${page.index}`],
        context: { pageIndex: page.index },
      });
    } else {
      for (const node of page.structures) projectNode(page, node, index.duplicateMcids, state);
    }
    previousHeadingLevel = state.previousHeadingLevel;
    const eligible = eligibleCharacters(page);
    const unclaimed = eligible.filter((characterIndex) => !state.claimedCharacterIndexes.has(characterIndex));
    if (unclaimed.length > 0) {
      issues.push({
        code: "pdf-import/tagged-text-unclaimed",
        severity: "warning",
        outcome: "reported",
        message: "Visible marked text is not uniquely represented by the accepted structure projection.",
        sourceRefs: [`pdf:p${page.index}`],
        context: { pageIndex: page.index, characters: unclaimed.length },
      });
    }
    const geometryRequired = state.corruptTagCount > 0 || unclaimed.length > 0;
    if (geometryRequired) requiresGeometryPages.push(page.index);
    const projectedNodeIds = blocks.slice(pageBlockStart).map((block) => block.id);
    if (projectedNodeIds.length > 0 && page.index > 0) blocks[pageBlockStart]!.pageBoundaryBefore = true;
    pageOutcomes.push({
      pageIndex: page.index,
      mode: geometryRequired ? "geometry-required" : "tagged-native",
      projectedNodeIds,
      claimedCharacterCount: state.claimedCharacterIndexes.size,
      unclaimedCharacterCount: unclaimed.length,
      corruptTagCount: state.corruptTagCount,
    });
  }
  const firstHeading = blocks.find((block) => block.type === "heading");
  const titleCandidate = firstHeading?.type === "heading"
    ? firstHeading.runs.map((run) => run.kind === "text" ? run.text : "\n").join("").trim()
    : undefined;
  const document: ImportDocumentV2 = {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    ...(titleCandidate ? { titleCandidate } : {}),
    blocks,
    assets: [],
    issues,
  };
  reportRepeatedTaggedRegions(blocks, issues);
  const digestInput = {
    schema: PDF_TAGGED_SEMANTICS_SCHEMA_V1,
    factsDigest,
    policyRevision: PDF_TAGGED_POLICY_REVISION,
    document,
    evidence,
    pageOutcomes,
    requiresGeometryPages,
  };
  return {
    ...digestInput,
    semanticDigest: await digestPdfCanonical(digestInput),
  };
}
