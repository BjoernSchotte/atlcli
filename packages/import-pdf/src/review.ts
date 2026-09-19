import { sha256Hex } from "@atlcli/core";
import type { ImportBlock, ImportDocumentV2, ImportIssue } from "@atlcli/import-core";
import { digestPdfCanonical } from "./canonical.js";
import {
  PDF_GEOMETRY_POLICY_REVISION,
  PDF_TAGGED_POLICY_REVISION,
  type PdfDecisionEvidenceV1,
  type PdfDecisionEvidenceV2,
  type PdfFactsAdapter,
  type PdfFactsAdapterV2,
  type PdfFactsV1,
  type PdfFactsV2,
  type PdfCharacterOwnershipV2,
  type PdfHybridPageOutcomeV2,
  type PdfTaggedPageOutcomeV2,
  type PdfUntaggedPageOutcomeV2,
} from "./contracts.js";
import { preservePdfFigures, preservePdfFiguresV2 } from "./figures.js";
import {
  PDF_FALLBACK_PRESENTATION_REVISION,
  applyPdfFallbackPresentation,
  type PdfVisualFallbackPlacementV1,
} from "./fallback-presentation.js";
import {
  PDF_VISUAL_FALLBACK_POLICY_REVISION,
  assessPdfVisualFallbacks,
  fallbackAssessmentPageIndexes,
  type PdfFallbackScopeV1,
} from "./fallback-policy.js";
import { PdfImportError } from "./issues.js";
import { auditPdfCharacterOwnershipV2, normalizeHybridPdfFactsV2 } from "./hybrid.js";
import { normalizeTaggedPdfFacts, normalizeTaggedPdfFactsV2 } from "./normalize.js";
import {
  applyPdfImportOverrides,
  type AppliedPdfImportOverridesV1,
  type ParsedPdfImportOverridesV1,
} from "./overrides.js";
import {
  planPdfSplit,
  summarizePdfPlannedPage,
  type PdfSplitPlanV1,
  type PdfSplitPolicyV1,
} from "./split.js";
import type { PdfTextBoundaryDecisionV2, PdfTextTransformationV2 } from "./text-assembly.js";
import { normalizeUntaggedPdfFacts, normalizeUntaggedPdfFactsV2 } from "./untagged.js";
import { materializePdfVisualFallbacks, materializePdfVisualFallbacksV2 } from "./visual-fallbacks.js";

export const PDF_IMPORT_REVIEW_SCHEMA_V1 = "atlcli.pdf-import-review/1" as const;
export const PDF_IMPORT_PLAN_SCHEMA_V1 = "atlcli.pdf-import-plan/1" as const;
export const PDF_IMPORT_REVIEW_SCHEMA_V2 = "atlcli.pdf-import-review/2" as const;
export const PDF_IMPORT_PLAN_SCHEMA_V2 = "atlcli.pdf-import-plan/2" as const;
export const PDF_IMPORT_REVIEW_SCHEMA_V3 = "atlcli.pdf-import-review/3" as const;
export const PDF_IMPORT_PLAN_SCHEMA_V3 = "atlcli.pdf-import-plan/3" as const;

export const PDF_SOURCE_FIDELITY_ACCOUNTED_DECISION_V3 = "pdf/source-fidelity-accounted" as const;
export const PDF_TEXT_BOUNDARY_UNRESOLVED_DECISION_V3 = "pdf/text-boundary-unresolved" as const;
export const PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3 = "pdf/character-ownership-failed" as const;
export const PDF_IMPORT_REVIEW_POLICY_REVISION_V3 = "atlcli.pdf-import-review-policy/3" as const;

export type PdfReadingOrderModeV1 = "auto" | "tags" | "geometry";
export type PdfScanPolicyV1 = "fail" | "page-image" | "report";
export type PdfVisualFallbackModeV1 = "auto" | PdfVisualFallbackPlacementV1;

export interface PdfReviewTargetV1 {
  spaceKey: string;
  title: string;
  parentId?: string;
  deployment: "cloud" | "data-center" | "unresolved-offline";
  supportsPageTree: boolean | null;
  evidence: "profile" | "offline-unresolved";
}

export interface PdfPageReviewSummaryV1 {
  pageIndex: number;
  pageLabel: string;
  kind: PdfFactsV1["pages"][number]["kind"];
  outcomes: Record<string, number>;
  minimumConfidence: number | null;
  issueCount: number;
  fallback: "none" | "required" | "page-image" | "reported";
  fallbackScope: PdfFallbackScopeV1;
  fallbackReasons: string[];
}

export interface PdfPageReviewSummaryV2 extends PdfPageReviewSummaryV1 {
  boundaryDecisionCount: number;
  unresolvedBoundaryCount: number;
  visibleCharacterCount: number;
  uniquelyOwnedCharacterCount: number;
  explicitBoundaryCount: number;
  inferredBoundaryCount: number;
  geometryRepairedCharacterCount: number;
  geometryRepairRegionCount: number;
  duplicateOwnershipAttemptCount: number;
  residualReportedCharacterCount: number;
  normalizedFallbackArea: number;
}

export type PdfSourceFidelityDecisionCodeV3 =
  | typeof PDF_SOURCE_FIDELITY_ACCOUNTED_DECISION_V3
  | typeof PDF_TEXT_BOUNDARY_UNRESOLVED_DECISION_V3
  | typeof PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3;

export interface PdfPageReviewSummaryV3 extends PdfPageReviewSummaryV2 {
  /** A separately visible subset of inferred boundary decisions. */
  dehyphenatedBoundaryCount: number;
  taggedOwnedCharacterCount: number;
  geometryOwnedCharacterCount: number;
  fallbackOwnedCharacterCount: number;
  unownedCharacterCount: number;
  fidelityDecisionCodes: PdfSourceFidelityDecisionCodeV3[];
}

export interface PdfImportReviewV1 {
  schema: typeof PDF_IMPORT_REVIEW_SCHEMA_V1;
  source: { sha256: string; byteLength: number; pageCount: number; classification: PdfFactsV1["classification"] };
  facts: PdfFactsV1;
  factsDigest: string;
  document: ImportDocumentV2;
  evidence: PdfDecisionEvidenceV1[];
  semanticDigest: string;
  override: AppliedPdfImportOverridesV1;
  options: {
    readingOrder: PdfReadingOrderModeV1;
    scanPolicy: PdfScanPolicyV1;
    visualFallback: PdfVisualFallbackModeV1;
    visualFallbackPlacement: PdfVisualFallbackPlacementV1;
    unsupported: "report" | "fail";
    attachSource: boolean;
  };
  target: PdfReviewTargetV1;
  pages: PdfPageReviewSummaryV1[];
  split: PdfSplitPlanV1;
  blockers: string[];
  assetDigests: string[];
  issueDigest: string;
  planDigest: string;
}

export interface PdfImportReviewV2
  extends Omit<PdfImportReviewV1, "schema" | "facts" | "evidence" | "pages"> {
  schema: typeof PDF_IMPORT_REVIEW_SCHEMA_V2;
  facts: PdfFactsV2;
  evidence: PdfDecisionEvidenceV2[];
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
  ownership: PdfCharacterOwnershipV2[];
  pages: PdfPageReviewSummaryV2[];
}

export interface PdfImportReviewV3 extends Omit<PdfImportReviewV2, "schema" | "pages"> {
  schema: typeof PDF_IMPORT_REVIEW_SCHEMA_V3;
  pages: PdfPageReviewSummaryV3[];
}

export interface PdfImportReviewBuildOptionsV2 {
  target: PdfReviewTargetV1;
  splitPolicy: PdfSplitPolicyV1;
  titleConflict?: "fail" | "rename";
  readingOrder?: PdfReadingOrderModeV1;
  scanPolicy?: PdfScanPolicyV1;
  visualFallback?: PdfVisualFallbackModeV1;
  unsupported?: "report" | "fail";
  attachSource?: boolean;
  overrides?: ParsedPdfImportOverridesV1;
}

type PdfImportReview = PdfImportReviewV1 | PdfImportReviewV2 | PdfImportReviewV3;

function reviewInvalid(message: string): never {
  throw new PdfImportError("pdf/override-invalid", message);
}

function sanitizedDocument(document: ImportDocumentV2): Record<string, unknown> {
  return {
    ...document,
    assets: document.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      sourceRefs: asset.sourceRefs,
      byteLength: asset.bytes.byteLength,
    })),
  };
}

function pageSummaries(
  facts: PdfFactsV1 | PdfFactsV2,
  evidence: readonly (PdfDecisionEvidenceV1 | PdfDecisionEvidenceV2)[],
  issues: readonly ImportIssue[],
  assessments: ReturnType<typeof assessPdfVisualFallbacks>,
  policy: PdfScanPolicyV1,
): PdfPageReviewSummaryV1[] {
  return facts.pages.map((page) => {
    const entries = evidence.filter((item) => item.locator.pageIndex === page.index);
    const outcomes: Record<string, number> = {};
    for (const entry of entries) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    const assessment = assessments.find((item) => item.pageIndex === page.index)!;
    const fallbackRequired = assessment.scope === "region" || assessment.scope === "page";
    return {
      pageIndex: page.index,
      pageLabel: page.label ?? String(page.index + 1),
      kind: page.kind,
      outcomes,
      minimumConfidence: entries.length > 0 ? Math.min(...entries.map((entry) => entry.confidence)) : null,
      issueCount: issues.filter((issue) => issue.context?.pageIndex === page.index).length,
      fallback: !fallbackRequired ? "none" : policy === "page-image" ? "page-image" : policy === "report" ? "reported" : "required",
      fallbackScope: assessment.scope,
      fallbackReasons: assessment.reasonCodes,
    };
  });
}

function pageSummariesV2(
  facts: PdfFactsV2,
  evidence: readonly PdfDecisionEvidenceV2[],
  issues: readonly ImportIssue[],
  assessments: ReturnType<typeof assessPdfVisualFallbacks>,
  policy: PdfScanPolicyV1,
  pageOutcomes: readonly (PdfTaggedPageOutcomeV2 | PdfUntaggedPageOutcomeV2 | PdfHybridPageOutcomeV2)[],
  boundaries: readonly PdfTextBoundaryDecisionV2[],
  ownership: readonly PdfCharacterOwnershipV2[],
  duplicateOwnershipAttemptsByPage: readonly { pageIndex: number; count: number }[],
): PdfPageReviewSummaryV2[] {
  const summaries = pageSummaries(
    facts,
    evidence,
    issues,
    assessments,
    policy,
  );
  return summaries.map((summary) => {
    const outcome = pageOutcomes.find((candidate) => candidate.pageIndex === summary.pageIndex);
    const hybrid = outcome && "fallbackScope" in outcome ? outcome : null;
    const pageBoundaryIds = new Set(evidence.filter((entry) => entry.locator.pageIndex === summary.pageIndex)
      .flatMap((entry) => entry.boundaryDecisionIds));
    const pageBoundaries = boundaries.filter((boundary) => pageBoundaryIds.has(boundary.id));
    const explicitBoundaryCount = hybrid?.explicitBoundaryCount
      ?? pageBoundaries.filter((boundary) => boundary.action === "preserve-explicit-space").length;
    const unresolvedBoundaryCount = hybrid?.unresolvedBoundaryCount
      ?? pageBoundaries.filter((boundary) => boundary.action === "unresolved").length;
    const pageOwnership = ownership.filter((entry) => entry.pageIndex === summary.pageIndex);
    const assessment = assessments.find((entry) => entry.pageIndex === summary.pageIndex)!;
    const repairedEvidence = evidence.filter((entry) =>
      entry.locator.pageIndex === summary.pageIndex
      && entry.decisionCode === "pdf/hybrid-geometry-repair"
    );
    const semanticBoundaryDecisionCount = outcome && "boundaryDecisionCount" in outcome
      ? outcome.boundaryDecisionCount
      : pageBoundaries.length;
    return {
      ...summary,
      boundaryDecisionCount: hybrid
        ? hybrid.explicitBoundaryCount + hybrid.inferredBoundaryCount + hybrid.unresolvedBoundaryCount
        : semanticBoundaryDecisionCount,
      unresolvedBoundaryCount,
      visibleCharacterCount: hybrid?.visibleCharacterCount
        ?? facts.pages[summary.pageIndex]!.characters.filter((character) =>
          character.value !== "\r"
          && character.value !== "\n"
          && character.value.replace(/[\s\u00ad]/gu, "").length > 0
        ).length,
      uniquelyOwnedCharacterCount: hybrid?.uniquelyOwnedCharacterCount ?? pageOwnership.length,
      explicitBoundaryCount,
      inferredBoundaryCount: hybrid?.inferredBoundaryCount
        ?? pageBoundaries.length - explicitBoundaryCount - unresolvedBoundaryCount,
      geometryRepairedCharacterCount: hybrid?.geometryRepairedCharacterCount
        ?? new Set(repairedEvidence.flatMap((entry) => entry.locator.characterIndexes ?? [])).size,
      geometryRepairRegionCount: hybrid?.geometryRepairRegionCount ?? repairedEvidence.length,
      duplicateOwnershipAttemptCount: hybrid?.duplicateOwnershipAttemptCount
        ?? duplicateOwnershipAttemptsByPage.find((entry) => entry.pageIndex === summary.pageIndex)?.count
        ?? 0,
      residualReportedCharacterCount: pageOwnership.filter((entry) => entry.outcome === "reported").length,
      normalizedFallbackArea: hybrid?.normalizedFallbackArea
        ?? (assessment.scope === "page" ? 1 : assessment.regionLocators.reduce((sum, locator) =>
          sum + (locator.bbox ? locator.bbox.width * locator.bbox.height : 0), 0)),
    };
  });
}

function standardIssue(issue: ImportIssue): Record<string, unknown> {
  return {
    code: issue.code,
    severity: issue.severity,
    outcome: issue.outcome,
    message: issue.message,
    sourceRefs: issue.sourceRefs,
    context: issue.context,
  };
}

export async function buildPdfImportReview(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapter,
  options: {
    target: PdfReviewTargetV1;
    splitPolicy: PdfSplitPolicyV1;
    titleConflict?: "fail" | "rename";
    readingOrder?: PdfReadingOrderModeV1;
    scanPolicy?: PdfScanPolicyV1;
    visualFallback?: PdfVisualFallbackModeV1;
    unsupported?: "report" | "fail";
    attachSource?: boolean;
    overrides?: ParsedPdfImportOverridesV1;
  },
): Promise<PdfImportReviewV1> {
  const readingOrder = options.readingOrder ?? "auto";
  const scanPolicy = options.scanPolicy ?? "fail";
  const visualFallback = options.visualFallback ?? (scanPolicy === "page-image" ? "inline" : "auto");
  const visualFallbackPlacement: PdfVisualFallbackPlacementV1 = visualFallback === "auto" ? "collapsed" : visualFallback;
  const unsupported = options.unsupported ?? "report";
  if (!["auto", "tags", "geometry"].includes(readingOrder)) reviewInvalid("readingOrder must be auto, tags, or geometry.");
  if (!["fail", "page-image", "report"].includes(scanPolicy)) reviewInvalid("scanPolicy must be fail, page-image, or report.");
  if (!["auto", "inline", "collapsed", "appendix"].includes(visualFallback)) {
    reviewInvalid("visualFallback must be auto, inline, collapsed, or appendix.");
  }
  if (!["report", "fail"].includes(unsupported)) reviewInvalid("unsupported must be report or fail.");
  const analyzed = await adapter.analyze(sourceBytes);
  if (readingOrder === "tags" && !analyzed.facts.tagged) {
    throw new PdfImportError("pdf/incomplete", "--reading-order tags requires a tagged PDF.");
  }
  const normalizeWithTags = readingOrder === "tags" || (readingOrder === "auto" && analyzed.facts.tagged);
  const base = normalizeWithTags
    ? await normalizeTaggedPdfFacts(analyzed.facts, analyzed.factsDigest)
    : await normalizeUntaggedPdfFacts(analyzed.facts, analyzed.factsDigest, { allowTagged: readingOrder === "geometry" });
  const visual = await preservePdfFigures(
    analyzed.facts,
    analyzed.factsDigest,
    sourceBytes,
    adapter,
    base,
  );
  const fallbackAssessments = assessPdfVisualFallbacks(analyzed.facts, {
    ...base,
    evidence: visual.evidence,
  });
  const pagesRequiringFallback = fallbackAssessmentPageIndexes(fallbackAssessments);
  const withPageImages = scanPolicy === "page-image"
    ? await materializePdfVisualFallbacks(sourceBytes, adapter, visual.document, visual.evidence, fallbackAssessments)
    : { document: visual.document, evidence: visual.evidence };
  const appliedOverride = await applyPdfImportOverrides(withPageImages.document, options.overrides);
  const override: AppliedPdfImportOverridesV1 = {
    ...appliedOverride,
    document: applyPdfFallbackPresentation(appliedOverride.document, visualFallbackPlacement),
  };
  const semanticDigest = await digestPdfCanonical({
    factsDigest: analyzed.factsDigest,
    policyRevision: normalizeWithTags ? PDF_TAGGED_POLICY_REVISION : PDF_GEOMETRY_POLICY_REVISION,
    visualFallbackPolicyRevision: PDF_VISUAL_FALLBACK_POLICY_REVISION,
    fallbackPresentationRevision: PDF_FALLBACK_PRESENTATION_REVISION,
    visualFallback,
    visualFallbackPlacement,
    overrideDigest: override.digest,
    document: sanitizedDocument(override.document),
    evidence: withPageImages.evidence,
  });
  const resolvedTitle = override.titleCandidate ?? options.target.title;
  const split = await planPdfSplit(analyzed.facts, override.document, withPageImages.evidence, {
    rootTitle: resolvedTitle,
    policy: options.splitPolicy,
    titleConflict: options.titleConflict,
  });
  const blockers = [...split.blockers];
  if (scanPolicy === "fail") {
    for (const pageIndex of pagesRequiringFallback) blockers.push(`Source page ${pageIndex + 1} requires a fallback; --scan-policy fail blocks publication.`);
  }
  if (unsupported === "fail") {
    const reported = override.document.issues.filter((issue) =>
      issue.severity !== "info" && (issue.outcome === "reported" || issue.outcome === "rejected")
    );
    if (reported.length > 0) blockers.push(`--unsupported fail rejects ${reported.length} reported or rejected outcome(s).`);
  }
  const issueDigest = await digestPdfCanonical(override.document.issues.map(standardIssue));
  const sourceSha256 = await sha256Hex(sourceBytes);
  const assetDigests = await Promise.all(override.document.assets.map((asset) => sha256Hex(asset.bytes)));
  const target = { ...options.target, title: resolvedTitle };
  const planInput = {
    schema: PDF_IMPORT_PLAN_SCHEMA_V1,
    source: { sha256: sourceSha256, byteLength: sourceBytes.byteLength },
    factsDigest: analyzed.factsDigest,
    semanticDigest,
    overrideDigest: override.digest,
    target,
    options: {
      readingOrder,
      scanPolicy,
      visualFallback,
      visualFallbackPlacement,
      unsupported,
      attachSource: options.attachSource ?? false,
    },
    visualFallbackPolicyRevision: PDF_VISUAL_FALLBACK_POLICY_REVISION,
    fallbackPresentationRevision: PDF_FALLBACK_PRESENTATION_REVISION,
    fallbackAssessments,
    splitDigest: split.digest,
    issueDigest,
    assetDigests: [...assetDigests].sort(),
    blockers,
  };
  return {
    schema: PDF_IMPORT_REVIEW_SCHEMA_V1,
    source: {
      sha256: sourceSha256,
      byteLength: sourceBytes.byteLength,
      pageCount: analyzed.facts.pageCount,
      classification: analyzed.facts.classification,
    },
    facts: analyzed.facts,
    factsDigest: analyzed.factsDigest,
    document: override.document,
    evidence: withPageImages.evidence,
    semanticDigest,
    override,
    options: {
      readingOrder,
      scanPolicy,
      visualFallback,
      visualFallbackPlacement,
      unsupported,
      attachSource: options.attachSource ?? false,
    },
    target,
    pages: pageSummaries(
      analyzed.facts,
      withPageImages.evidence,
      override.document.issues,
      fallbackAssessments,
      scanPolicy,
    ),
    split,
    blockers,
    assetDigests,
    issueDigest,
    planDigest: await digestPdfCanonical(planInput),
  };
}

export async function buildPdfImportReviewV2(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapterV2,
  options: PdfImportReviewBuildOptionsV2,
): Promise<PdfImportReviewV2> {
  const readingOrder = options.readingOrder ?? "auto";
  const scanPolicy = options.scanPolicy ?? "fail";
  const visualFallback = options.visualFallback ?? (scanPolicy === "page-image" ? "inline" : "auto");
  const visualFallbackPlacement: PdfVisualFallbackPlacementV1 = visualFallback === "auto" ? "collapsed" : visualFallback;
  const unsupported = options.unsupported ?? "report";
  if (!["auto", "tags", "geometry"].includes(readingOrder)) reviewInvalid("readingOrder must be auto, tags, or geometry.");
  if (!["fail", "page-image", "report"].includes(scanPolicy)) reviewInvalid("scanPolicy must be fail, page-image, or report.");
  if (!["auto", "inline", "collapsed", "appendix"].includes(visualFallback)) {
    reviewInvalid("visualFallback must be auto, inline, collapsed, or appendix.");
  }
  if (!["report", "fail"].includes(unsupported)) reviewInvalid("unsupported must be report or fail.");
  const analyzed = await adapter.analyze(sourceBytes);
  if (readingOrder === "tags" && !analyzed.facts.tagged) {
    throw new PdfImportError("pdf/incomplete", "--reading-order tags requires a tagged PDF.");
  }
  const base = readingOrder === "auto" && analyzed.facts.tagged
    ? await normalizeHybridPdfFactsV2(analyzed.facts, analyzed.factsDigest)
    : readingOrder === "tags"
      ? await normalizeTaggedPdfFactsV2(analyzed.facts, analyzed.factsDigest)
      : await normalizeUntaggedPdfFactsV2(analyzed.facts, analyzed.factsDigest, { allowTagged: readingOrder === "geometry" });
  const visual = await preservePdfFiguresV2(
    analyzed.facts,
    analyzed.factsDigest,
    sourceBytes,
    adapter,
    base,
  );
  const fallbackAssessments = assessPdfVisualFallbacks(analyzed.facts, {
    ...base,
    evidence: visual.evidence,
  });
  const pagesRequiringFallback = fallbackAssessmentPageIndexes(fallbackAssessments);
  const withPageImages = scanPolicy === "page-image"
    ? await materializePdfVisualFallbacksV2(sourceBytes, adapter, visual.document, visual.evidence, fallbackAssessments)
    : { document: visual.document, evidence: visual.evidence };
  const ownershipAudit = auditPdfCharacterOwnershipV2(analyzed.facts, base.evidence);
  const attachedFallbackPages = new Set(scanPolicy === "page-image"
    ? fallbackAssessments.filter((assessment) => assessment.scope === "page").map((assessment) => assessment.pageIndex)
    : []);
  const attachedFallbackIndexes = new Set(scanPolicy === "page-image"
    ? fallbackAssessments.flatMap((assessment) => assessment.regionLocators.flatMap((locator) =>
      (locator.characterIndexes ?? []).map((characterIndex) => `${locator.pageIndex}:${characterIndex}`)
    ))
    : []);
  const ownership = ("ownership" in base ? base.ownership : ownershipAudit.ownership).map((entry) => {
    const covered = entry.basis === "fallback"
      || attachedFallbackPages.has(entry.pageIndex)
      || attachedFallbackIndexes.has(`${entry.pageIndex}:${entry.characterIndex}`);
    return covered && scanPolicy === "page-image"
      ? { ...entry, basis: "fallback" as const, outcome: "attached" as const }
      : entry;
  });
  const appliedOverride = await applyPdfImportOverrides(withPageImages.document, options.overrides);
  const override: AppliedPdfImportOverridesV1 = {
    ...appliedOverride,
    document: applyPdfFallbackPresentation(appliedOverride.document, visualFallbackPlacement),
  };
  const semanticDigest = await digestPdfCanonical({
    schema: PDF_IMPORT_REVIEW_SCHEMA_V2,
    factsDigest: analyzed.factsDigest,
    policyRevision: base.policyRevision,
    textAssemblyPolicyRevision: base.textAssemblyPolicyRevision,
    visualFallbackPolicyRevision: PDF_VISUAL_FALLBACK_POLICY_REVISION,
    fallbackPresentationRevision: PDF_FALLBACK_PRESENTATION_REVISION,
    visualFallback,
    visualFallbackPlacement,
    overrideDigest: override.digest,
    document: sanitizedDocument(override.document),
    evidence: withPageImages.evidence,
    boundaries: base.boundaries,
    transformations: base.transformations,
    ownership,
  });
  const resolvedTitle = override.titleCandidate ?? options.target.title;
  const split = await planPdfSplit(analyzed.facts, override.document, withPageImages.evidence, {
    rootTitle: resolvedTitle,
    policy: options.splitPolicy,
    titleConflict: options.titleConflict,
  });
  const blockers = [...split.blockers];
  if (scanPolicy === "fail") {
    for (const pageIndex of pagesRequiringFallback) blockers.push(`Source page ${pageIndex + 1} requires a fallback; --scan-policy fail blocks publication.`);
  }
  if (unsupported === "fail") {
    const reported = override.document.issues.filter((issue) =>
      issue.severity !== "info" && (issue.outcome === "reported" || issue.outcome === "rejected")
    );
    if (reported.length > 0) blockers.push(`--unsupported fail rejects ${reported.length} reported or rejected outcome(s).`);
    if (ownershipAudit.duplicateOwnershipAttemptCount > 0) {
      blockers.push(`--unsupported fail rejects ${ownershipAudit.duplicateOwnershipAttemptCount} duplicate character ownership attempt(s).`);
    }
    const residualReportedCharacterCount = ownership.filter((entry) => entry.outcome === "reported").length;
    if (residualReportedCharacterCount > 0) {
      blockers.push(`--unsupported fail rejects ${residualReportedCharacterCount} residual reported character(s).`);
    }
  }
  const issueDigest = await digestPdfCanonical(override.document.issues.map(standardIssue));
  const sourceSha256 = await sha256Hex(sourceBytes);
  const assetDigests = await Promise.all(override.document.assets.map((asset) => sha256Hex(asset.bytes)));
  const target = { ...options.target, title: resolvedTitle };
  const planInput = {
    schema: PDF_IMPORT_PLAN_SCHEMA_V2,
    source: { sha256: sourceSha256, byteLength: sourceBytes.byteLength },
    factsDigest: analyzed.factsDigest,
    semanticDigest,
    textAssemblyPolicyRevision: base.textAssemblyPolicyRevision,
    boundaryDecisionCount: base.boundaries.length,
    unresolvedBoundaryCount: base.boundaries.filter((boundary) => boundary.action === "unresolved").length,
    transformationCount: base.transformations.length,
    visibleCharacterCount: ownership.length,
    duplicateOwnershipAttemptCount: ownershipAudit.duplicateOwnershipAttemptCount,
    residualReportedCharacterCount: ownership.filter((entry) => entry.outcome === "reported").length,
    overrideDigest: override.digest,
    target,
    options: {
      readingOrder,
      scanPolicy,
      visualFallback,
      visualFallbackPlacement,
      unsupported,
      attachSource: options.attachSource ?? false,
    },
    visualFallbackPolicyRevision: PDF_VISUAL_FALLBACK_POLICY_REVISION,
    fallbackPresentationRevision: PDF_FALLBACK_PRESENTATION_REVISION,
    fallbackAssessments,
    splitDigest: split.digest,
    issueDigest,
    assetDigests: [...assetDigests].sort(),
    blockers,
  };
  return {
    schema: PDF_IMPORT_REVIEW_SCHEMA_V2,
    source: {
      sha256: sourceSha256,
      byteLength: sourceBytes.byteLength,
      pageCount: analyzed.facts.pageCount,
      classification: analyzed.facts.classification,
    },
    facts: analyzed.facts,
    factsDigest: analyzed.factsDigest,
    document: override.document,
    evidence: withPageImages.evidence,
    boundaries: base.boundaries,
    transformations: base.transformations,
    ownership,
    semanticDigest,
    override,
    options: {
      readingOrder,
      scanPolicy,
      visualFallback,
      visualFallbackPlacement,
      unsupported,
      attachSource: options.attachSource ?? false,
    },
    target,
    pages: pageSummariesV2(
      analyzed.facts,
      withPageImages.evidence,
      override.document.issues,
      fallbackAssessments,
      scanPolicy,
      base.pageOutcomes,
      base.boundaries,
      ownership,
      ownershipAudit.duplicateOwnershipAttemptsByPage,
    ),
    split,
    blockers,
    assetDigests,
    issueDigest,
    planDigest: await digestPdfCanonical(planInput),
  };
}

function fidelityPageDigestSummaryV3(page: PdfPageReviewSummaryV3): Record<string, unknown> {
  return {
    pageIndex: page.pageIndex,
    pageLabel: page.pageLabel,
    explicitBoundaryCount: page.explicitBoundaryCount,
    inferredBoundaryCount: page.inferredBoundaryCount,
    dehyphenatedBoundaryCount: page.dehyphenatedBoundaryCount,
    unresolvedBoundaryCount: page.unresolvedBoundaryCount,
    visibleCharacterCount: page.visibleCharacterCount,
    uniquelyOwnedCharacterCount: page.uniquelyOwnedCharacterCount,
    taggedOwnedCharacterCount: page.taggedOwnedCharacterCount,
    geometryOwnedCharacterCount: page.geometryOwnedCharacterCount,
    fallbackOwnedCharacterCount: page.fallbackOwnedCharacterCount,
    duplicateOwnershipAttemptCount: page.duplicateOwnershipAttemptCount,
    unownedCharacterCount: page.unownedCharacterCount,
    residualReportedCharacterCount: page.residualReportedCharacterCount,
    geometryRepairedCharacterCount: page.geometryRepairedCharacterCount,
    geometryRepairRegionCount: page.geometryRepairRegionCount,
    fallbackScope: page.fallbackScope,
    normalizedFallbackArea: page.normalizedFallbackArea,
    fidelityDecisionCodes: page.fidelityDecisionCodes,
  };
}

/** Upgrade a completed V2 analysis without re-reading source bytes or changing publication projection. */
export async function upgradePdfImportReviewV3(review: PdfImportReviewV2): Promise<PdfImportReviewV3> {
  const pages = review.pages.map((page): PdfPageReviewSummaryV3 => {
    const pageBoundaryIds = new Set(review.evidence
      .filter((entry) => entry.locator.pageIndex === page.pageIndex)
      .flatMap((entry) => entry.boundaryDecisionIds));
    const pageBoundaries = review.boundaries.filter((boundary) => pageBoundaryIds.has(boundary.id));
    const pageOwnership = review.ownership.filter((entry) => entry.pageIndex === page.pageIndex);
    const unownedCharacterCount = pageOwnership.filter((entry) => entry.ownerSourceId.endsWith(":unowned")).length;
    const fidelityDecisionCodes: PdfSourceFidelityDecisionCodeV3[] = [];
    if (page.unresolvedBoundaryCount > 0) {
      fidelityDecisionCodes.push(PDF_TEXT_BOUNDARY_UNRESOLVED_DECISION_V3);
    }
    if (unownedCharacterCount > 0 || page.duplicateOwnershipAttemptCount > 0) {
      fidelityDecisionCodes.push(PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3);
    }
    if (fidelityDecisionCodes.length === 0) {
      fidelityDecisionCodes.push(PDF_SOURCE_FIDELITY_ACCOUNTED_DECISION_V3);
    }
    return {
      ...page,
      issueCount: page.issueCount + (fidelityDecisionCodes.includes(PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3) ? 1 : 0),
      dehyphenatedBoundaryCount: pageBoundaries.filter((boundary) => boundary.action === "dehyphenate").length,
      taggedOwnedCharacterCount: pageOwnership.filter((entry) => entry.basis === "tagged").length,
      geometryOwnedCharacterCount: pageOwnership.filter((entry) => entry.basis === "geometry").length,
      fallbackOwnedCharacterCount: pageOwnership.filter((entry) => entry.basis === "fallback").length,
      unownedCharacterCount,
      fidelityDecisionCodes,
    };
  });
  const ownershipIssues: ImportIssue[] = pages
    .filter((page) => page.fidelityDecisionCodes.includes(PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3))
    .map((page) => ({
      code: "pdf-import/character-ownership-failed",
      severity: "warning",
      outcome: "reported",
      message: "Visible source characters do not have exactly one verified semantic or fallback owner.",
      sourceRefs: [`pdf:p${page.pageIndex}`],
      context: {
        pageIndex: page.pageIndex,
        unownedCharacters: page.unownedCharacterCount,
        duplicateOwnershipAttempts: page.duplicateOwnershipAttemptCount,
      },
    }));
  const document: ImportDocumentV2 = {
    ...review.document,
    issues: [...review.document.issues, ...ownershipIssues],
  };
  const blockers = [...review.blockers];
  if (review.options.unsupported === "fail") {
    for (const page of pages) {
      if (page.unresolvedBoundaryCount > 0) {
        blockers.push(
          `Source page ${page.pageLabel}: ${PDF_TEXT_BOUNDARY_UNRESOLVED_DECISION_V3} `
          + `(${page.unresolvedBoundaryCount} unresolved boundary decision(s)).`,
        );
      }
      if (page.unownedCharacterCount > 0 || page.duplicateOwnershipAttemptCount > 0) {
        blockers.push(
          `Source page ${page.pageLabel}: ${PDF_CHARACTER_OWNERSHIP_FAILED_DECISION_V3} `
          + `(${page.unownedCharacterCount} unowned character(s), `
          + `${page.duplicateOwnershipAttemptCount} duplicate ownership attempt(s)).`,
        );
      }
    }
  }
  const fidelityPages = pages.map(fidelityPageDigestSummaryV3);
  const issueDigest = await digestPdfCanonical(document.issues.map(standardIssue));
  const semanticDigest = await digestPdfCanonical({
    schema: PDF_IMPORT_REVIEW_SCHEMA_V3,
    reviewPolicyRevision: PDF_IMPORT_REVIEW_POLICY_REVISION_V3,
    priorSemanticDigest: review.semanticDigest,
    fidelityPages,
    ownershipIssues: ownershipIssues.map(standardIssue),
  });
  const planDigest = await digestPdfCanonical({
    schema: PDF_IMPORT_PLAN_SCHEMA_V3,
    reviewPolicyRevision: PDF_IMPORT_REVIEW_POLICY_REVISION_V3,
    priorPlanDigest: review.planDigest,
    semanticDigest,
    issueDigest,
    fidelityPages,
    blockers,
  });
  return {
    ...review,
    schema: PDF_IMPORT_REVIEW_SCHEMA_V3,
    document,
    override: { ...review.override, document },
    pages,
    blockers,
    issueDigest,
    semanticDigest,
    planDigest,
  };
}

export async function buildPdfImportReviewV3(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapterV2,
  options: PdfImportReviewBuildOptionsV2,
): Promise<PdfImportReviewV3> {
  return upgradePdfImportReviewV3(await buildPdfImportReviewV2(sourceBytes, adapter, options));
}

export function pdfImportReviewReport(review: PdfImportReviewV1): Record<string, unknown>;
export function pdfImportReviewReport(review: PdfImportReviewV2): Record<string, unknown>;
export function pdfImportReviewReport(review: PdfImportReviewV3): Record<string, unknown>;
export function pdfImportReviewReport(review: PdfImportReview): Record<string, unknown> {
  const outcomeTotals: Record<string, number> = {};
  for (const entry of review.evidence) outcomeTotals[entry.outcome] = (outcomeTotals[entry.outcome] ?? 0) + 1;
  const figureCounts = review.evidence.reduce((counts, item) => {
    if (item.decisionCode === "pdf/figure-raster-native") counts.nativeRaster += 1;
    if (item.decisionCode === "pdf/figure-rendered-region-attached") counts.renderedFallback += 1;
    return counts;
  }, { nativeRaster: 0, renderedFallback: 0 });
  const tableCounts = {
    native: review.document.blocks.filter((block) => block.type === "table").length,
    linearized: new Set(review.document.issues.filter((issue) =>
      issue.code.includes("table") && issue.outcome === "approximated"
    ).flatMap((issue) => issue.sourceRefs ?? [issue.code])).size,
    renderedFallback: new Set(review.evidence.filter((item) =>
      item.decisionCode.includes("table") && item.outcome === "attached"
    ).map((item) => item.sourceId)).size,
  };
  const blockCounts: Record<string, number> = {};
  const count = (block: ImportBlock): void => {
    blockCounts[block.type] = (blockCounts[block.type] ?? 0) + 1;
    if (block.type === "list") {
      for (const item of block.items) {
        item.blocks.forEach(count);
        if (item.child) count(item.child);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) cell.blocks.forEach(count);
    } else if (block.type === "blockquote" || block.type === "disclosure") block.blocks.forEach(count);
  };
  review.document.blocks.forEach(count);
  const outline = review.document.blocks.flatMap((block) =>
    block.type === "heading"
      ? [{ level: block.level, text: block.runs.map((run) => run.kind === "text" ? run.text : " ").join("").trim() }]
      : []
  );
  return {
    mode: "pdf-preview",
    schema: review.schema,
    source: review.source,
    analyzer: review.facts.provenance,
    target: review.target,
    options: review.options,
    overrides: { digest: review.override.digest, applied: review.override.applied },
    content: { blockCounts, outline },
    outcomes: outcomeTotals,
    ...("boundaries" in review ? {
      quality: {
        boundaryDecisionCount: review.boundaries.length,
        unresolvedBoundaryCount: review.boundaries.filter((boundary) => boundary.action === "unresolved").length,
        transformationCount: review.transformations.length,
        visibleCharacterCount: review.pages.reduce((sum, page) => sum + page.visibleCharacterCount, 0),
        uniquelyOwnedCharacterCount: review.pages.reduce((sum, page) => sum + page.uniquelyOwnedCharacterCount, 0),
        explicitBoundaryCount: review.pages.reduce((sum, page) => sum + page.explicitBoundaryCount, 0),
        inferredBoundaryCount: review.pages.reduce((sum, page) => sum + page.inferredBoundaryCount, 0),
        ...(review.schema === PDF_IMPORT_REVIEW_SCHEMA_V3 ? {
          dehyphenatedBoundaryCount: review.pages.reduce((sum, page) =>
            sum + page.dehyphenatedBoundaryCount, 0),
          taggedOwnedCharacterCount: review.pages.reduce((sum, page) =>
            sum + page.taggedOwnedCharacterCount, 0),
          geometryOwnedCharacterCount: review.pages.reduce((sum, page) =>
            sum + page.geometryOwnedCharacterCount, 0),
          fallbackOwnedCharacterCount: review.pages.reduce((sum, page) =>
            sum + page.fallbackOwnedCharacterCount, 0),
          unownedCharacterCount: review.pages.reduce((sum, page) =>
            sum + page.unownedCharacterCount, 0),
        } : {}),
        geometryRepairedCharacterCount: review.pages.reduce((sum, page) =>
          sum + page.geometryRepairedCharacterCount, 0),
        geometryRepairRegionCount: review.pages.reduce((sum, page) => sum + page.geometryRepairRegionCount, 0),
        duplicateOwnershipAttemptCount: review.pages.reduce((sum, page) =>
          sum + page.duplicateOwnershipAttemptCount, 0),
        residualReportedCharacterCount: review.pages.reduce((sum, page) =>
          sum + page.residualReportedCharacterCount, 0),
        normalizedFallbackArea: review.pages.reduce((sum, page) => sum + page.normalizedFallbackArea, 0),
      },
    } : {}),
    pages: review.pages,
    tables: tableCounts,
    figures: figureCounts,
    assets: review.document.assets.map((asset, index) => ({
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      byteLength: asset.bytes.byteLength,
      sha256: review.assetDigests[index],
    })),
    issues: review.document.issues.map(standardIssue),
    reviewRegions: review.evidence.filter((item) => item.confidence < 0.95 || item.outcome === "reported").map((item) => ({
      sourceId: item.sourceId,
      locator: item.locator,
      confidence: item.confidence,
      outcome: item.outcome,
      decisionCode: item.decisionCode,
    })),
    split: {
      requested: review.split.requested,
      resolved: review.split.resolved,
      contentPageCount: review.split.contentPageCount,
      totalWikiPages: review.split.totalWikiPages,
      root: summarizePdfPlannedPage(review.split.root),
      sourceAssignments: review.split.sourceAssignments,
      issues: review.split.issues,
      blockers: review.split.blockers,
      digest: review.split.digest,
    },
    blockers: review.blockers,
    digests: {
      facts: review.factsDigest,
      semantic: review.semanticDigest,
      issues: review.issueDigest,
      split: review.split.digest,
      plan: review.planDigest,
    },
    publication: {
      statePlan: review.split.resolved.kind === "page-tree"
        ? ["preflight", "shells", "assets", "final-bodies", "semantic-readback", "complete"]
        : ["preflight", "shell", "assets", "final-body", "semantic-readback", "complete"],
      rollbackScope: `${review.split.totalWikiPages} owned page(s), child-first`,
      sourceAttachment: review.options.attachSource
        ? "opted-in; hidden metadata/content disclosure acknowledged"
        : "off (default)",
    },
  };
}

export function renderPdfImportReview(review: PdfImportReviewV1): string;
export function renderPdfImportReview(review: PdfImportReviewV2): string;
export function renderPdfImportReview(review: PdfImportReviewV3): string;
export function renderPdfImportReview(review: PdfImportReview): string {
  const lines = [
    "PDF import preview",
    `  Title:  ${review.target.title}`,
    `  Space:  ${review.target.spaceKey}`,
    ...(review.target.parentId ? [`  Parent: ${review.target.parentId}`] : []),
    `  Source: ${review.source.pageCount} page(s), ${review.source.classification}, sha256:${review.source.sha256.slice(0, 16)}…`,
    `  Plan:   sha256:${review.planDigest.slice(0, 16)}…`,
    "",
    `Split: ${review.split.requested.mode.kind} -> ${review.split.resolved.kind} (${review.split.totalWikiPages} wiki page(s))`,
  ];
  const walk = (page: PdfSplitPlanV1["root"], depth: number): void => {
    const range = page.sourcePageLabels.length > 0
      ? ` [source ${page.sourcePageLabels[0]}${page.sourcePageLabels.length > 1 ? `-${page.sourcePageLabels.at(-1)}` : ""}]`
      : " [index]";
    lines.push(`${"  ".repeat(depth + 1)}- ${page.title}${range}; ${page.estimate.editability}, ${page.estimate.nodes} nodes`);
    page.children.forEach((child) => walk(child, depth + 1));
  };
  walk(review.split.root, 0);
  lines.push("", "Page outcomes:");
  for (const page of review.pages) {
    const outcomes = Object.entries(page.outcomes).map(([key, value]) => `${key}:${value}`).join(", ") || "no semantic nodes";
    const scope = page.fallbackScope === "none" ? "" : `; scope ${page.fallbackScope} (${page.fallbackReasons.join(", ")})`;
    const boundaries = "boundaryDecisionCount" in page
      ? ("dehyphenatedBoundaryCount" in page
        ? `; boundaries explicit ${page.explicitBoundaryCount}, inferred ${page.inferredBoundaryCount}`
          + `, dehyphenated ${page.dehyphenatedBoundaryCount}, unresolved ${page.unresolvedBoundaryCount}`
          + `; ownership ${page.uniquelyOwnedCharacterCount}/${page.visibleCharacterCount}`
          + ` (tagged ${page.taggedOwnedCharacterCount}, geometry ${page.geometryOwnedCharacterCount}, `
          + `fallback ${page.fallbackOwnedCharacterCount}, unowned ${page.unownedCharacterCount})`
          + `, duplicates ${page.duplicateOwnershipAttemptCount}, residual ${page.residualReportedCharacterCount}`
          + `; repairs ${page.geometryRepairedCharacterCount} chars/${page.geometryRepairRegionCount} regions`
          + `; fallback area ${page.normalizedFallbackArea.toFixed(4)}`
          + `; decision ${page.fidelityDecisionCodes.join(", ")}`
        : `; boundaries ${page.boundaryDecisionCount}, unresolved ${page.unresolvedBoundaryCount}`
          + `; ownership ${page.uniquelyOwnedCharacterCount}/${page.visibleCharacterCount}`
          + `, duplicates ${page.duplicateOwnershipAttemptCount}, residual ${page.residualReportedCharacterCount}`
          + `; repairs ${page.geometryRepairedCharacterCount} chars/${page.geometryRepairRegionCount} regions`
          + `; fallback area ${page.normalizedFallbackArea.toFixed(4)}`)
      : "";
    lines.push(`  Page ${page.pageLabel}: ${page.kind}; ${outcomes}${boundaries}; fallback ${page.fallback}${scope}`);
  }
  if (review.document.issues.length > 0) {
    lines.push("", `Issues (${review.document.issues.length}):`);
    for (const issue of review.document.issues) lines.push(`  [${issue.severity}/${issue.outcome}] ${issue.code}: ${issue.message}`);
  }
  if (review.blockers.length > 0) {
    lines.push("", `Publication blockers (${review.blockers.length}):`);
    for (const blocker of review.blockers) lines.push(`  - ${blocker}`);
  }
  lines.push(
    "",
    review.options.attachSource
      ? "Original PDF attachment: opted in; hidden metadata and non-visible content may be retained."
      : "Original PDF attachment: off (default).",
    "Dry preview only — nothing was published. Re-run with --confirm after all blockers are resolved.",
  );
  return lines.join("\n");
}
