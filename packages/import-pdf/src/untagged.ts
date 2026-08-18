import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  type ImportBlock,
  type ImportDocumentV2,
  type ImportIssue,
  type ImportListBlock,
  type ImportRun,
} from "@atlcli/import-core";
import {
  PDF_GEOMETRY_POLICY_REVISION,
  PDF_UNTAGGED_SEMANTICS_SCHEMA_V1,
  type PdfDecisionEvidenceV1,
  type PdfFactsV1,
  type PdfPageFactsV1,
  type PdfUntaggedPageOutcomeV1,
  type PdfUntaggedSemanticsV1,
} from "./contracts.js";
import { digestPdfCanonical, digestPdfFacts } from "./canonical.js";
import { PdfImportError } from "./issues.js";
import { taggedRuns } from "./links.js";
import {
  PDF_GEOMETRY_POLICY_V1,
  analyzeGeometryReadingOrder,
  geometryBodyFontSize,
  type PdfGeometryFragmentV1,
  type PdfReadingOrderPageV1,
} from "./reading-order.js";
import { detectRepeatedRegions } from "./repeated-regions.js";
import { analyzeUntaggedTable, type PdfTableProjectionV1 } from "./tables.js";

interface ListMarker {
  ordered: boolean;
  marker: string;
  content: string;
}

function listMarker(text: string): ListMarker | null {
  const match = /^\s*((?:[-*•‣⁃])|(?:\d+|[a-z])[.)])\s+(.+)$/iu.exec(text);
  if (!match) return null;
  return {
    ordered: !/^[-*•‣⁃]$/u.test(match[1]!),
    marker: match[1]!,
    content: match[2]!,
  };
}

function evidenceLocator(page: PdfPageFactsV1, fragment: PdfGeometryFragmentV1) {
  return {
    pageIndex: page.index,
    ...(page.label ? { pageLabel: page.label } : {}),
    bbox: fragment.bbox,
    structurePath: fragment.id,
  };
}

function stripMarker(runs: ImportRun[], marker: string): ImportRun[] {
  const result = runs.map((run) => run.kind === "text" ? { ...run } : run);
  const first = result.find((run): run is Extract<ImportRun, { kind: "text" }> => run.kind === "text");
  if (!first) return [{ kind: "text", text: "" }];
  first.text = first.text.replace(new RegExp(`^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+`, "u"), "");
  return result.filter((run) => run.kind !== "text" || run.text.length > 0);
}

function fragmentRuns(page: PdfPageFactsV1, fragment: PdfGeometryFragmentV1): {
  runs: ImportRun[];
  annotationId?: string;
} {
  const tagged = taggedRuns(fragment.characters, page.annotations);
  return {
    runs: tagged.runs,
    ...(tagged.annotationIds[0] ? { annotationId: tagged.annotationIds[0] } : {}),
  };
}

function headingLevels(
  pages: readonly PdfReadingOrderPageV1[],
  suppressed: ReadonlySet<string>,
  bodyFont: number,
): Map<number, 1 | 2 | 3 | 4 | 5 | 6> {
  const sizes = [...new Set(pages.flatMap((page) => page.ordered)
    .filter((fragment) => !suppressed.has(fragment.id))
    .filter((fragment) =>
      fragment.text.length <= PDF_GEOMETRY_POLICY_V1.maximumHeadingLength
      && fragment.fontSizePoints >= Math.max(
        bodyFont * PDF_GEOMETRY_POLICY_V1.headingFontRatio,
        bodyFont + PDF_GEOMETRY_POLICY_V1.headingFontDeltaPoints,
      )
    )
    .map((fragment) => fragment.fontSizePoints))].sort((a, b) => b - a);
  return new Map(sizes.slice(0, 6).map((size, index) => [size, (index + 1) as 1 | 2 | 3 | 4 | 5 | 6]));
}

function suppressedEvidence(
  page: PdfPageFactsV1,
  fragment: PdfGeometryFragmentV1,
  reason: "page-furniture" | "repeated-region" | "overlap-duplicate",
): PdfDecisionEvidenceV1 {
  return {
    sourceId: fragment.id,
    locator: evidenceLocator(page, fragment),
    basis: ["text-geometry"],
    confidence: reason === "overlap-duplicate" ? 0.99 : 0.95,
    decisionCode: `pdf/geometry-${reason}-suppressed`,
    outcome: "approximated",
    analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
  };
}

function projectList(
  page: PdfPageFactsV1,
  fragments: PdfGeometryFragmentV1[],
  evidence: PdfDecisionEvidenceV1[],
): ImportListBlock {
  const baseX = Math.min(...fragments.map((fragment) => fragment.bbox.x));
  const root: ImportListBlock = {
    id: `${fragments[0]!.id}:list`,
    type: "list",
    ordered: listMarker(fragments[0]!.text)!.ordered,
    items: [],
    sourceRefs: fragments.map((fragment) => fragment.id),
  };
  let previousRootItem: ImportListBlock["items"][number] | undefined;
  for (const fragment of fragments) {
    const marker = listMarker(fragment.text)!;
    const linked = fragmentRuns(page, fragment);
    const paragraphId = `${fragment.id}:list-item`;
    const item = {
      blocks: [{
        id: paragraphId,
        type: "paragraph" as const,
        runs: stripMarker(linked.runs, marker.marker),
        sourceRefs: [fragment.id],
      }],
    };
    const nested = fragment.bbox.x - baseX >= 0.035;
    if (nested && previousRootItem) {
      const child = previousRootItem.child ?? {
        id: `${root.id}:nested`,
        type: "list" as const,
        ordered: marker.ordered,
        items: [],
        sourceRefs: [],
      };
      child.items.push(item);
      child.sourceRefs = [...(child.sourceRefs ?? []), fragment.id];
      previousRootItem.child = child;
    } else {
      root.items.push(item);
      previousRootItem = item;
    }
    evidence.push({
      sourceId: fragment.id,
      targetNodeId: paragraphId,
      locator: {
        ...evidenceLocator(page, fragment),
        ...(linked.annotationId ? { annotationId: linked.annotationId } : {}),
      },
      basis: ["text-geometry", "font-evidence", ...(linked.annotationId ? ["annotation" as const] : [])],
      confidence: 0.96,
      decisionCode: "pdf/geometry-list-item-native",
      outcome: "native",
      analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
    });
  }
  evidence.push({
    sourceId: root.id,
    targetNodeId: root.id,
    locator: { pageIndex: page.index, ...(page.label ? { pageLabel: page.label } : {}) },
    basis: ["text-geometry", "font-evidence"],
    confidence: 0.95,
    decisionCode: "pdf/geometry-list-native",
    outcome: "native",
    analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
  });
  return root;
}

function projectQualifiedPage(
  page: PdfPageFactsV1,
  analysis: PdfReadingOrderPageV1,
  suppressed: ReadonlySet<string>,
  headingLevelByFont: ReadonlyMap<number, 1 | 2 | 3 | 4 | 5 | 6>,
  evidence: PdfDecisionEvidenceV1[],
  table: PdfTableProjectionV1,
): ImportBlock[] {
  const available = analysis.ordered.filter((fragment) => !suppressed.has(fragment.id));
  const blocks: ImportBlock[] = [];
  let tableInserted = false;
  const insertTableBefore = (fragment?: PdfGeometryFragmentV1): void => {
    if (
      tableInserted
      || table.mode !== "native"
      || (fragment && table.bbox && table.bbox.y >= fragment.bbox.y)
    ) return;
    blocks.push(...table.blocks);
    tableInserted = true;
  };
  for (let index = 0; index < available.length;) {
    const fragment = available[index]!;
    insertTableBefore(fragment);
    if (listMarker(fragment.text)) {
      const listFragments: PdfGeometryFragmentV1[] = [];
      while (index < available.length && listMarker(available[index]!.text)) {
        listFragments.push(available[index]!);
        index += 1;
      }
      blocks.push(projectList(page, listFragments, evidence));
      continue;
    }
    const linked = fragmentRuns(page, fragment);
    const headingLevel = headingLevelByFont.get(fragment.fontSizePoints);
    const id = `${fragment.id}:${headingLevel ? `heading-${headingLevel}` : "paragraph"}`;
    blocks.push(headingLevel
      ? { id, type: "heading", level: headingLevel, runs: linked.runs, sourceRefs: [fragment.id] }
      : { id, type: "paragraph", runs: linked.runs, sourceRefs: [fragment.id] });
    evidence.push({
      sourceId: fragment.id,
      targetNodeId: id,
      locator: {
        ...evidenceLocator(page, fragment),
        ...(linked.annotationId ? { annotationId: linked.annotationId } : {}),
      },
      basis: [
        "text-geometry",
        ...(headingLevel ? ["font-evidence" as const] : []),
        ...(linked.annotationId ? ["annotation" as const] : []),
      ],
      confidence: headingLevel ? 0.97 : 0.99,
      decisionCode: headingLevel ? "pdf/geometry-heading-native" : "pdf/geometry-paragraph-native",
      outcome: "native",
      analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
    });
    index += 1;
  }
  insertTableBefore();
  return blocks;
}

function visibleCharacterIndexes(page: PdfPageFactsV1): number[] {
  return page.characters.filter((character) =>
    character.value !== "\r"
    && character.value !== "\n"
    && character.value.replace(/[\s\u00ad]/gu, "").length > 0
  ).map((character) => character.index);
}

export function pageHasQualifiedDigitalLayout(page: PdfPageFactsV1): boolean {
  if (page.kind === "digital") return true;
  if (page.kind !== "mixed" || page.text.trim().length === 0) return false;
  return page.images.length > 0 && page.images.every((image) =>
    image.bbox !== null && image.bbox.width * image.bbox.height < 0.6
  );
}

export async function normalizeUntaggedPdfFacts(
  facts: PdfFactsV1,
  factsDigest: string,
  options: { allowTagged?: boolean } = {},
): Promise<PdfUntaggedSemanticsV1> {
  if (await digestPdfFacts(facts) !== factsDigest) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF facts differ from the digest supplied to geometry normalization.",
    );
  }
  const rawAnalyses = facts.pages.map((page) => analyzeGeometryReadingOrder(page));
  const tables = rawAnalyses.map((analysis) => analyzeUntaggedTable(facts.pages[analysis.pageIndex]!, analysis));
  const analyses = facts.pages.map((page) => {
    const table = tables[page.index]!;
    return analyzeGeometryReadingOrder(
      page,
      table.mode === "native" ? new Set(table.fragmentIds) : new Set(),
    );
  });
  const repeated = detectRepeatedRegions(analyses);
  const automaticallySuppressed = new Set<string>([
    ...repeated,
    ...analyses.flatMap((analysis) => analysis.fragments
      .filter((fragment) => fragment.furniture || fragment.duplicateOf)
      .map((fragment) => fragment.id)),
  ]);
  const bodyFont = geometryBodyFontSize(analyses);
  const headingLevelByFont = headingLevels(analyses, automaticallySuppressed, bodyFont);
  const blocks: ImportBlock[] = [];
  const evidence: PdfDecisionEvidenceV1[] = [];
  const issues: ImportIssue[] = facts.issues.map(({ pageIndex, ...issue }) => ({
    ...issue,
    ...(pageIndex === undefined ? {} : { context: { ...issue.context, pageIndex } }),
  }));
  const pageOutcomes: PdfUntaggedPageOutcomeV1[] = [];
  const requiresFallbackPages: number[] = [];
  for (const analysis of analyses) {
    const page = facts.pages[analysis.pageIndex]!;
    const table = tables[analysis.pageIndex]!;
    evidence.push(...table.evidence);
    issues.push(...table.issues);
    const reasons = new Set(analysis.qualificationReasons);
    if (facts.tagged && !options.allowTagged) reasons.add("tagged-document-routed-to-geometry");
    if (!pageHasQualifiedDigitalLayout(page)) reasons.add(`page-kind-${page.kind}`);
    const suppressed = analysis.fragments.filter((fragment) => automaticallySuppressed.has(fragment.id));
    for (const fragment of suppressed) {
      const reason = fragment.furniture
        ? "page-furniture"
        : fragment.duplicateOf
          ? "overlap-duplicate"
          : "repeated-region";
      evidence.push(suppressedEvidence(page, fragment, reason));
    }
    if (suppressed.length > 0) {
      issues.push({
        code: "pdf-import/geometry-regions-suppressed",
        severity: "info",
        outcome: "approximated",
        message: "Page furniture, repeated regions, or exact overlapping duplicates were suppressed with source evidence.",
        sourceRefs: suppressed.map((fragment) => fragment.id),
        context: { pageIndex: page.index, regions: suppressed.length },
      });
    }
    const blockStart = blocks.length;
    if (reasons.size === 0) {
      blocks.push(...projectQualifiedPage(
        page,
        analysis,
        automaticallySuppressed,
        headingLevelByFont,
        evidence,
        table,
      ));
    } else {
      requiresFallbackPages.push(page.index);
      if (table.mode === "linearized-render-required") blocks.push(...table.blocks);
      const tableFragmentIds = new Set(table.fragmentIds);
      const fallbackFragments = analysis.fragments.filter((fragment) =>
        !automaticallySuppressed.has(fragment.id) && !tableFragmentIds.has(fragment.id)
      );
      for (const fragment of fallbackFragments) {
        evidence.push({
          sourceId: fragment.id,
          locator: evidenceLocator(page, fragment),
          basis: ["text-geometry"],
          confidence: 0,
          decisionCode: "pdf/geometry-page-fallback-required",
          outcome: "reported",
          analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
        });
      }
      issues.push({
        code: "pdf-import/geometry-page-fallback-required",
        severity: "warning",
        outcome: "reported",
        message: "The untagged page did not meet the conservative native-layout qualification policy.",
        sourceRefs: [`pdf:p${page.index}`],
        context: { pageIndex: page.index, reasons: [...reasons].sort().join(",") },
      });
    }
    if (blocks.length > blockStart && page.index > 0) blocks[blockStart]!.pageBoundaryBefore = true;
    const accounted = new Set(analysis.fragments.flatMap((fragment) =>
      fragment.characters.map((character) => character.index)
    ));
    const visible = visibleCharacterIndexes(page);
    const unaccounted = visible.filter((index) => !accounted.has(index));
    if (unaccounted.length > 0 && !reasons.has("missing-geometry")) {
      throw new PdfImportError("pdf/incomplete", "Geometry normalization left visible source characters unaccounted.", {
        pageIndex: page.index,
        characters: unaccounted.length,
      });
    }
    pageOutcomes.push({
      pageIndex: page.index,
      mode: reasons.size === 0 ? "geometry-native" : "fallback-required",
      projectedNodeIds: blocks.slice(blockStart).map((block) => block.id),
      columnCount: analysis.columnCount,
      sourceFragmentCount: analysis.fragments.length,
      suppressedFragmentCount: suppressed.length,
      accountedCharacterCount: accounted.size,
      unaccountedCharacterCount: unaccounted.length,
      qualificationReasons: [...reasons].sort(),
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
  const digestInput = {
    schema: PDF_UNTAGGED_SEMANTICS_SCHEMA_V1,
    factsDigest,
    policyRevision: PDF_GEOMETRY_POLICY_REVISION,
    document,
    evidence,
    pageOutcomes,
    requiresFallbackPages,
  };
  return { ...digestInput, semanticDigest: await digestPdfCanonical(digestInput) };
}
