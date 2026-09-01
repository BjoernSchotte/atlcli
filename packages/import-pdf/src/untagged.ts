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
  PDF_GEOMETRY_POLICY_REVISION_V2,
  PDF_UNTAGGED_SEMANTICS_SCHEMA_V1,
  PDF_UNTAGGED_SEMANTICS_SCHEMA_V2,
  type PdfDecisionEvidenceV1,
  type PdfDecisionEvidenceV2,
  type PdfFactsV1,
  type PdfFactsV2,
  type PdfPageFactsV1,
  type PdfPageFactsV2,
  type PdfUntaggedPageOutcomeV1,
  type PdfUntaggedPageOutcomeV2,
  type PdfUntaggedSemanticsV1,
  type PdfUntaggedSemanticsV2,
} from "./contracts.js";
import { digestPdfCanonical, digestPdfFacts, digestPdfFactsV2 } from "./canonical.js";
import { PdfImportError } from "./issues.js";
import { taggedRuns, taggedRunsV2 } from "./links.js";
import {
  PDF_GEOMETRY_POLICY_V1,
  PDF_GEOMETRY_POLICY_V2,
  analyzeGeometryReadingOrder,
  analyzeGeometryReadingOrderV2,
  assembleGeometryFragmentsV2,
  calibrateGeometryFontSizesV2,
  geometryBodyFontSize,
  geometryBodyFontSizeV2,
  type PdfGeometryFragmentV1,
  type PdfGeometryFragmentV2,
  type PdfReadingOrderPageV1,
  type PdfReadingOrderPageV2,
} from "./reading-order.js";
import { detectRepeatedRegions } from "./repeated-regions.js";
import {
  analyzeUntaggedTable,
  analyzeUntaggedTableV2,
  type PdfTableProjectionV1,
  type PdfTableProjectionV2,
} from "./tables.js";
import {
  appendPdfTextAssemblyV2,
  pdfTextAssemblyConfidenceV2,
  pdfTextAssemblyIssuesV2,
  pdfTextAssemblyOutcomeV2,
  pdfTextBoundaryDecisionIdsV2,
} from "./assembly-evidence.js";
import {
  PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
  type PdfTextAssemblyV2,
  type PdfTextBoundaryDecisionV2,
  type PdfTextTransformationV2,
} from "./text-assembly.js";

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

export function pageHasQualifiedDigitalLayout(
  page: Pick<PdfPageFactsV1, "kind" | "text" | "images">,
): boolean {
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

function evidenceLocatorV2(page: PdfPageFactsV2, fragment: PdfGeometryFragmentV2) {
  return {
    pageIndex: page.index,
    ...(page.label ? { pageLabel: page.label } : {}),
    bbox: fragment.bbox,
    structurePath: fragment.id,
    characterIndexes: fragment.assembly.characterIndexes,
  };
}

function fragmentRunsV2(page: PdfPageFactsV2, assembly: PdfTextAssemblyV2, fragments: readonly PdfGeometryFragmentV2[]) {
  const linked = taggedRunsV2(
    assembly,
    fragments.flatMap((fragment) => fragment.characters),
    page.annotations,
  );
  return {
    runs: linked.runs,
    ...(linked.annotationIds[0] ? { annotationId: linked.annotationIds[0] } : {}),
  };
}

function headingLevelsV2(
  pages: readonly PdfReadingOrderPageV2[],
  suppressed: ReadonlySet<string>,
  bodyFont: number,
): Map<number, 1 | 2 | 3 | 4 | 5 | 6> {
  const sizes = [...new Set(pages.flatMap((page) => page.ordered)
    .filter((fragment) => !suppressed.has(fragment.id))
    .filter((fragment) =>
      fragment.text.length <= PDF_GEOMETRY_POLICY_V2.maximumHeadingLength
      && fragment.fontSizePoints >= Math.max(
        bodyFont * PDF_GEOMETRY_POLICY_V2.headingFontRatio,
        bodyFont + PDF_GEOMETRY_POLICY_V2.headingFontDeltaPoints,
      )
    )
    .map((fragment) => fragment.fontSizePoints))].sort((left, right) => right - left);
  return new Map(sizes.slice(0, 6).map((size, index) => [
    size,
    (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
  ]));
}

function suppressedEvidenceV2(
  page: PdfPageFactsV2,
  fragment: PdfGeometryFragmentV2,
  reason: "page-furniture" | "repeated-region" | "overlap-duplicate",
): PdfDecisionEvidenceV2 {
  return {
    sourceId: fragment.id,
    locator: evidenceLocatorV2(page, fragment),
    basis: ["text-geometry", "text-boundary"],
    confidence: Math.min(
      reason === "overlap-duplicate" ? 0.99 : 0.95,
      pdfTextAssemblyConfidenceV2(fragment.assembly),
    ),
    decisionCode: `pdf/geometry-${reason}-suppressed`,
    outcome: "approximated",
    analyzerRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
    boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(fragment.assembly),
  };
}

function startsLowercaseWord(value: string): boolean {
  const first = [...value.trimStart()][0];
  return first !== undefined && /\p{Ll}/u.test(first);
}

function qualifiedParagraphContinuationV2(
  left: PdfGeometryFragmentV2,
  right: PdfGeometryFragmentV2,
): boolean {
  if (
    left.column !== right.column
    || right.physicalLineIndex !== left.physicalLineIndex + 1
    || Math.abs(left.fontSizePoints - right.fontSizePoints)
      > PDF_GEOMETRY_POLICY_V2.paragraphMaximumFontDeltaPoints
    || Math.abs(left.bbox.x - right.bbox.x)
      > PDF_GEOMETRY_POLICY_V2.paragraphMaximumIndentDelta
    || /[.!?…:;]\s*$/u.test(left.text)
    || !startsLowercaseWord(right.text)
  ) return false;
  const lineGap = right.bbox.y - (left.bbox.y + left.bbox.height);
  return lineGap >= -PDF_GEOMETRY_POLICY_V2.minimumLineClusterTolerance
    && lineGap <= Math.max(left.bbox.height, right.bbox.height)
      * PDF_GEOMETRY_POLICY_V2.paragraphMaximumLineGapGlyphFactor;
}

interface GeometryProjectionV2 {
  blocks: ImportBlock[];
  evidence: PdfDecisionEvidenceV2[];
  issues: ImportIssue[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
  unresolved: boolean;
}

function addAssemblyV2(
  target: Pick<GeometryProjectionV2, "issues" | "boundaries" | "transformations">,
  assembly: PdfTextAssemblyV2,
  pageIndex: number,
  sourceId: string,
): void {
  appendPdfTextAssemblyV2(target, assembly);
  target.issues.push(...pdfTextAssemblyIssuesV2(assembly, pageIndex, sourceId));
}

function projectListV2(
  page: PdfPageFactsV2,
  fragments: PdfGeometryFragmentV2[],
  projection: GeometryProjectionV2,
): ImportListBlock {
  const baseX = Math.min(...fragments.map((fragment) => fragment.bbox.x));
  const root: ImportListBlock = {
    id: `${fragments[0]!.id}:list-v2`,
    type: "list",
    ordered: listMarker(fragments[0]!.text)!.ordered,
    items: [],
    sourceRefs: fragments.map((fragment) => fragment.id),
  };
  let previousRootItem: ImportListBlock["items"][number] | undefined;
  for (const fragment of fragments) {
    const marker = listMarker(fragment.text)!;
    addAssemblyV2(projection, fragment.assembly, page.index, fragment.id);
    const outcome = pdfTextAssemblyOutcomeV2(fragment.assembly);
    if (outcome !== "native") projection.unresolved = true;
    const linked = fragmentRunsV2(page, fragment.assembly, [fragment]);
    const paragraphId = `${fragment.id}:list-item-v2`;
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
    projection.evidence.push({
      sourceId: fragment.id,
      targetNodeId: paragraphId,
      locator: {
        ...evidenceLocatorV2(page, fragment),
        ...(linked.annotationId ? { annotationId: linked.annotationId } : {}),
      },
      basis: [
        "text-geometry",
        "font-evidence",
        "text-boundary",
        ...(linked.annotationId ? ["annotation" as const] : []),
      ],
      confidence: Math.min(0.96, pdfTextAssemblyConfidenceV2(fragment.assembly)),
      decisionCode: outcome === "native"
        ? "pdf/geometry-list-item-native"
        : "pdf/geometry-list-item-boundary-unresolved",
      outcome,
      analyzerRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
      boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(fragment.assembly),
    });
  }
  const itemEvidence = projection.evidence.filter((item) =>
    item.decisionCode.includes("geometry-list-item")
    && fragments.some((fragment) => fragment.id === item.sourceId)
  );
  projection.evidence.push({
    sourceId: root.id,
    targetNodeId: root.id,
    locator: { pageIndex: page.index, ...(page.label ? { pageLabel: page.label } : {}) },
    basis: ["text-geometry", "font-evidence", "text-boundary"],
    confidence: Math.min(0.95, ...itemEvidence.map((item) => item.confidence)),
    decisionCode: itemEvidence.every((item) => item.outcome === "native")
      ? "pdf/geometry-list-native"
      : "pdf/geometry-list-boundary-unresolved",
    outcome: itemEvidence.every((item) => item.outcome === "native") ? "native" : "reported",
    analyzerRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
    boundaryDecisionIds: [...new Set(itemEvidence.flatMap((item) => item.boundaryDecisionIds))],
  });
  return root;
}

function projectQualifiedPageV2(
  page: PdfPageFactsV2,
  analysis: PdfReadingOrderPageV2,
  suppressed: ReadonlySet<string>,
  headingLevelByFont: ReadonlyMap<number, 1 | 2 | 3 | 4 | 5 | 6>,
  table: PdfTableProjectionV2,
): GeometryProjectionV2 {
  const projection: GeometryProjectionV2 = {
    blocks: [],
    evidence: [],
    issues: [],
    boundaries: [],
    transformations: [],
    unresolved: false,
  };
  const available = analysis.ordered.filter((fragment) => !suppressed.has(fragment.id));
  let tableInserted = false;
  const insertTableBefore = (fragment?: PdfGeometryFragmentV2): void => {
    if (
      tableInserted
      || table.mode !== "native"
      || (fragment && table.bbox && table.bbox.y >= fragment.bbox.y)
    ) return;
    projection.blocks.push(...table.blocks);
    tableInserted = true;
  };
  for (let index = 0; index < available.length;) {
    const fragment = available[index]!;
    insertTableBefore(fragment);
    if (listMarker(fragment.text)) {
      const listFragments: PdfGeometryFragmentV2[] = [];
      while (index < available.length && listMarker(available[index]!.text)) {
        listFragments.push(available[index]!);
        index += 1;
      }
      projection.blocks.push(projectListV2(page, listFragments, projection));
      continue;
    }
    const headingLevel = headingLevelByFont.get(fragment.fontSizePoints);
    const group = [fragment];
    if (!headingLevel) {
      while (index + group.length < available.length) {
        const next = available[index + group.length]!;
        if (
          headingLevelByFont.has(next.fontSizePoints)
          || listMarker(next.text)
          || !qualifiedParagraphContinuationV2(group.at(-1)!, next)
        ) break;
        group.push(next);
      }
    }
    const sourceId = group.length === 1
      ? fragment.id
      : `${fragment.id}:through:${group.at(-1)!.id}`;
    const assembly = group.length === 1
      ? fragment.assembly
      : assembleGeometryFragmentsV2(page, sourceId, group);
    addAssemblyV2(projection, assembly, page.index, sourceId);
    const outcome = pdfTextAssemblyOutcomeV2(assembly);
    if (outcome !== "native") projection.unresolved = true;
    const linked = fragmentRunsV2(page, assembly, group);
    const id = `${sourceId}:${headingLevel ? `heading-${headingLevel}` : "paragraph"}`;
    projection.blocks.push(headingLevel
      ? { id, type: "heading", level: headingLevel, runs: linked.runs, sourceRefs: group.map((item) => item.id) }
      : { id, type: "paragraph", runs: linked.runs, sourceRefs: group.map((item) => item.id) });
    projection.evidence.push({
      sourceId,
      targetNodeId: id,
      locator: {
        pageIndex: page.index,
        ...(page.label ? { pageLabel: page.label } : {}),
        ...(assembly.bbox ? { bbox: assembly.bbox } : {}),
        structurePath: sourceId,
        characterIndexes: assembly.characterIndexes,
        ...(linked.annotationId ? { annotationId: linked.annotationId } : {}),
      },
      basis: [
        "text-geometry",
        "text-boundary",
        ...(headingLevel ? ["font-evidence" as const] : []),
        ...(linked.annotationId ? ["annotation" as const] : []),
      ],
      confidence: Math.min(
        headingLevel ? 0.97 : 0.99,
        pdfTextAssemblyConfidenceV2(assembly),
      ),
      decisionCode: outcome === "native"
        ? headingLevel ? "pdf/geometry-heading-native" : "pdf/geometry-paragraph-native"
        : "pdf/geometry-text-boundary-unresolved",
      outcome,
      analyzerRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
      boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(assembly),
    });
    index += group.length;
  }
  insertTableBefore();
  return projection;
}

function visibleCharacterIndexesV2(page: PdfPageFactsV2): number[] {
  return page.characters.filter((character) =>
    character.value !== "\r"
    && character.value !== "\n"
    && character.value.replace(/[\s\u00ad]/gu, "").length > 0
  ).map((character) => character.index);
}

export async function normalizeUntaggedPdfFactsV2(
  facts: PdfFactsV2,
  factsDigest: string,
  options: { allowTagged?: boolean } = {},
): Promise<PdfUntaggedSemanticsV2> {
  if (await digestPdfFactsV2(facts) !== factsDigest) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF V2 facts differ from the digest supplied to geometry normalization.",
    );
  }
  const rawAnalyses = facts.pages.map((page) => analyzeGeometryReadingOrderV2(page));
  const tables = rawAnalyses.map((analysis) =>
    analyzeUntaggedTableV2(facts.pages[analysis.pageIndex]!, analysis)
  );
  const analyses = facts.pages.map((page) => {
    const table = tables[page.index]!;
    return analyzeGeometryReadingOrderV2(
      page,
      table.mode === "native" ? new Set(table.fragmentIds) : new Set(),
    );
  });
  calibrateGeometryFontSizesV2(analyses);
  const repeated = detectRepeatedRegions(analyses);
  const automaticallySuppressed = new Set<string>([
    ...repeated,
    ...analyses.flatMap((analysis) => analysis.fragments
      .filter((fragment) => fragment.furniture || fragment.duplicateOf)
      .map((fragment) => fragment.id)),
  ]);
  const bodyFont = geometryBodyFontSizeV2(analyses);
  const headingLevelByFont = headingLevelsV2(analyses, automaticallySuppressed, bodyFont);
  const blocks: ImportBlock[] = [];
  const evidence: PdfDecisionEvidenceV2[] = [];
  const issues: ImportIssue[] = facts.issues.map(({ pageIndex, ...issue }) => ({
    ...issue,
    ...(pageIndex === undefined ? {} : { context: { ...issue.context, pageIndex } }),
  }));
  const boundaries: PdfTextBoundaryDecisionV2[] = [];
  const transformations: PdfTextTransformationV2[] = [];
  const pageOutcomes: PdfUntaggedPageOutcomeV2[] = [];
  const requiresFallbackPages: number[] = [];
  for (const analysis of analyses) {
    const page = facts.pages[analysis.pageIndex]!;
    const table = tables[analysis.pageIndex]!;
    const boundaryStart = boundaries.length;
    boundaries.push(...table.boundaries);
    transformations.push(...table.transformations);
    evidence.push(...table.evidence);
    issues.push(...table.issues);
    const reasons = new Set(analysis.qualificationReasons);
    if (facts.tagged && !options.allowTagged) reasons.add("tagged-document-routed-to-geometry");
    if (!pageHasQualifiedDigitalLayout(page)) reasons.add(`page-kind-${page.kind}`);
    if (table.mode === "linearized-render-required") reasons.add("table-render-required");
    const suppressed = analysis.fragments.filter((fragment) =>
      automaticallySuppressed.has(fragment.id)
    );
    for (const fragment of suppressed) {
      const reason = fragment.furniture
        ? "page-furniture"
        : fragment.duplicateOf ? "overlap-duplicate" : "repeated-region";
      evidence.push(suppressedEvidenceV2(page, fragment, reason));
      appendPdfTextAssemblyV2({ boundaries, transformations }, fragment.assembly);
      issues.push(...pdfTextAssemblyIssuesV2(fragment.assembly, page.index, fragment.id));
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
    const projection = reasons.size === 0
      ? projectQualifiedPageV2(
          page,
          analysis,
          automaticallySuppressed,
          headingLevelByFont,
          table,
        )
      : null;
    if (projection?.unresolved) reasons.add("unresolved-text-boundary");
    if (reasons.size === 0 && projection) {
      blocks.push(...projection.blocks);
      evidence.push(...projection.evidence);
      issues.push(...projection.issues);
      boundaries.push(...projection.boundaries);
      transformations.push(...projection.transformations);
    } else {
      if (projection) {
        evidence.push(...projection.evidence.filter((item) => item.outcome !== "native"));
        issues.push(...projection.issues);
        boundaries.push(...projection.boundaries);
        transformations.push(...projection.transformations);
      }
      requiresFallbackPages.push(page.index);
      if (table.mode === "linearized-render-required") blocks.push(...table.blocks);
      const tableFragmentIds = new Set(table.fragmentIds);
      const fallbackFragments = analysis.fragments.filter((fragment) =>
        !automaticallySuppressed.has(fragment.id) && !tableFragmentIds.has(fragment.id)
      );
      for (const fragment of fallbackFragments) {
        appendPdfTextAssemblyV2({ boundaries, transformations }, fragment.assembly);
        issues.push(...pdfTextAssemblyIssuesV2(fragment.assembly, page.index, fragment.id));
        evidence.push({
          sourceId: fragment.id,
          locator: evidenceLocatorV2(page, fragment),
          basis: ["text-geometry", "text-boundary"],
          confidence: 0,
          decisionCode: "pdf/geometry-page-fallback-required",
          outcome: "reported",
          analyzerRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
          boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(fragment.assembly),
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
      fragment.assembly.characterIndexes
    ));
    const visible = visibleCharacterIndexesV2(page);
    const unaccounted = visible.filter((index) => !accounted.has(index));
    if (unaccounted.length > 0 && !reasons.has("missing-geometry")) {
      throw new PdfImportError(
        "pdf/incomplete",
        "Geometry V2 normalization left visible source characters unaccounted.",
        { pageIndex: page.index, characters: unaccounted.length },
      );
    }
    const pageBoundaries = boundaries.slice(boundaryStart);
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
      boundaryDecisionCount: pageBoundaries.length,
      unresolvedBoundaryCount: pageBoundaries.filter((boundary) =>
        boundary.action === "unresolved"
      ).length,
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
    schema: PDF_UNTAGGED_SEMANTICS_SCHEMA_V2,
    factsDigest,
    policyRevision: PDF_GEOMETRY_POLICY_REVISION_V2,
    textAssemblyPolicyRevision: PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
    document,
    evidence,
    boundaries,
    transformations,
    pageOutcomes,
    requiresFallbackPages,
  };
  return { ...digestInput, semanticDigest: await digestPdfCanonical(digestInput) };
}
