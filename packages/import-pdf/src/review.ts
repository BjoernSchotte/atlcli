import { sha256Hex } from "@atlcli/core";
import type { ImportAsset, ImportBlock, ImportDocumentV2, ImportIssue } from "@atlcli/import-core";
import { digestPdfCanonical } from "./canonical.js";
import {
  PDF_ASSET_MATERIALIZER_REVISION,
  PDF_GEOMETRY_POLICY_REVISION,
  PDF_TAGGED_POLICY_REVISION,
  type PdfDecisionEvidenceV1,
  type PdfFactsAdapter,
  type PdfFactsV1,
  type PdfMaterializedAssetV1,
} from "./contracts.js";
import { preservePdfFigures } from "./figures.js";
import { PdfImportError } from "./issues.js";
import { normalizeTaggedPdfFacts } from "./normalize.js";
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
import { normalizeUntaggedPdfFacts } from "./untagged.js";

export const PDF_IMPORT_REVIEW_SCHEMA_V1 = "atlcli.pdf-import-review/1" as const;
export const PDF_IMPORT_PLAN_SCHEMA_V1 = "atlcli.pdf-import-plan/1" as const;

export type PdfReadingOrderModeV1 = "auto" | "tags" | "geometry";
export type PdfScanPolicyV1 = "fail" | "page-image" | "report";

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

function reviewInvalid(message: string): never {
  throw new PdfImportError("pdf/override-invalid", message);
}

function fallbackPages(
  facts: PdfFactsV1,
  base: { requiresGeometryPages?: number[]; requiresFallbackPages?: number[] },
): number[] {
  return [...new Set([
    ...(base.requiresGeometryPages ?? []),
    ...(base.requiresFallbackPages ?? []),
    ...facts.pages.filter((page) => page.kind === "image-only").map((page) => page.index),
  ])].filter((pageIndex) => facts.pages[pageIndex]?.kind !== "blank").sort((a, b) => a - b);
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

async function addPageImages(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapter,
  document: ImportDocumentV2,
  evidence: readonly PdfDecisionEvidenceV1[],
  pageIndexes: readonly number[],
): Promise<{ document: ImportDocumentV2; evidence: PdfDecisionEvidenceV1[] }> {
  if (pageIndexes.length === 0) return { document, evidence: [...evidence] };
  const requests = pageIndexes.map((pageIndex) => ({
    id: `pdf:p${pageIndex}:page-image`,
    pageIndex,
    kind: "rendered-region" as const,
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    dpi: 144,
  }));
  const materialized = await adapter.materialize(sourceBytes, requests);
  if (materialized.length !== requests.length) {
    throw new PdfImportError("pdf/incomplete", "Page-image fallback did not materialize every requested page.");
  }
  const assets = new Map<string, ImportAsset>(document.assets.map((asset) => [asset.id, asset]));
  const blocks: ImportBlock[] = [...document.blocks];
  const covered = new Set(pageIndexes);
  const fallbackCoveredCodes = new Set([
    "pdf-import/image-only-page",
    "pdf-import/geometry-page-fallback-required",
    "pdf-import/tagged-structure-missing",
    "pdf-import/tagged-text-unclaimed",
    "pdf-import/tagged-node-demoted",
  ]);
  const issues: ImportIssue[] = document.issues.map((issue) =>
    issue.outcome === "reported"
      && fallbackCoveredCodes.has(issue.code)
      && typeof issue.context?.pageIndex === "number"
      && covered.has(issue.context.pageIndex)
      ? { ...issue, outcome: "attached" }
      : issue
  );
  const nextEvidence = [...evidence];
  for (const pageIndex of pageIndexes) {
    const asset = materialized.find((item) => item.requestId === `pdf:p${pageIndex}:page-image`);
    if (!asset || asset.materializerRevision !== PDF_ASSET_MATERIALIZER_REVISION) {
      throw new PdfImportError("pdf/incomplete", "Page-image fallback failed materializer verification.");
    }
    const id = `pdf:asset:${asset.sha256}`;
    if (!assets.has(id)) assets.set(id, {
      id,
      sourceRefs: [`pdf:p${pageIndex}`],
      fileName: `pdf-page-${String(pageIndex + 1).padStart(3, "0")}-${asset.sha256.slice(0, 12)}.png`,
      mediaType: "image/png",
      bytes: new Uint8Array(asset.bytes),
    });
    const blockId = `pdf:p${pageIndex}:page-image-block`;
    blocks.push({
      id: blockId,
      type: "image",
      assetId: id,
      presentation: "page-fallback",
      sourceRefs: [`pdf:p${pageIndex}`],
      ...(pageIndex > 0 ? { pageBoundaryBefore: true } : {}),
    });
    nextEvidence.push({
      sourceId: `pdf:p${pageIndex}`,
      targetNodeId: blockId,
      locator: { pageIndex, bbox: { x: 0, y: 0, width: 1, height: 1 } },
      basis: ["rendered-region"],
      confidence: 1,
      decisionCode: "pdf/page-image-fallback-attached",
      outcome: "attached",
      analyzerRevision: PDF_GEOMETRY_POLICY_REVISION,
    });
    issues.push({
      code: "pdf-import/page-image-fallback-attached",
      severity: "warning",
      outcome: "attached",
      message: "The source page is preserved as a rendered image and is not accessible editable text.",
      sourceRefs: [`pdf:p${pageIndex}`],
      context: { pageIndex, width: asset.width, height: asset.height },
    });
  }
  return { document: { ...document, blocks, assets: [...assets.values()], issues }, evidence: nextEvidence };
}

function pageSummaries(
  facts: PdfFactsV1,
  evidence: readonly PdfDecisionEvidenceV1[],
  issues: readonly ImportIssue[],
  fallback: ReadonlySet<number>,
  policy: PdfScanPolicyV1,
): PdfPageReviewSummaryV1[] {
  return facts.pages.map((page) => {
    const entries = evidence.filter((item) => item.locator.pageIndex === page.index);
    const outcomes: Record<string, number> = {};
    for (const entry of entries) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    return {
      pageIndex: page.index,
      pageLabel: page.label ?? String(page.index + 1),
      kind: page.kind,
      outcomes,
      minimumConfidence: entries.length > 0 ? Math.min(...entries.map((entry) => entry.confidence)) : null,
      issueCount: issues.filter((issue) => issue.context?.pageIndex === page.index).length,
      fallback: !fallback.has(page.index) ? "none" : policy === "page-image" ? "page-image" : policy === "report" ? "reported" : "required",
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
    unsupported?: "report" | "fail";
    attachSource?: boolean;
    overrides?: ParsedPdfImportOverridesV1;
  },
): Promise<PdfImportReviewV1> {
  const readingOrder = options.readingOrder ?? "auto";
  const scanPolicy = options.scanPolicy ?? "fail";
  const unsupported = options.unsupported ?? "report";
  if (!["auto", "tags", "geometry"].includes(readingOrder)) reviewInvalid("readingOrder must be auto, tags, or geometry.");
  if (!["fail", "page-image", "report"].includes(scanPolicy)) reviewInvalid("scanPolicy must be fail, page-image, or report.");
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
  const pagesRequiringFallback = fallbackPages(analyzed.facts, base);
  const withPageImages = scanPolicy === "page-image"
    ? await addPageImages(sourceBytes, adapter, visual.document, visual.evidence, pagesRequiringFallback)
    : { document: visual.document, evidence: visual.evidence };
  const override = await applyPdfImportOverrides(withPageImages.document, options.overrides);
  const semanticDigest = await digestPdfCanonical({
    factsDigest: analyzed.factsDigest,
    policyRevision: normalizeWithTags ? PDF_TAGGED_POLICY_REVISION : PDF_GEOMETRY_POLICY_REVISION,
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
    options: { readingOrder, scanPolicy, unsupported, attachSource: options.attachSource ?? false },
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
    options: { readingOrder, scanPolicy, unsupported, attachSource: options.attachSource ?? false },
    target,
    pages: pageSummaries(
      analyzed.facts,
      withPageImages.evidence,
      override.document.issues,
      new Set(pagesRequiringFallback),
      scanPolicy,
    ),
    split,
    blockers,
    assetDigests,
    issueDigest,
    planDigest: await digestPdfCanonical(planInput),
  };
}

export function pdfImportReviewReport(review: PdfImportReviewV1): Record<string, unknown> {
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
    } else if (block.type === "blockquote") block.blocks.forEach(count);
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

export function renderPdfImportReview(review: PdfImportReviewV1): string {
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
    lines.push(`  Page ${page.pageLabel}: ${page.kind}; ${outcomes}; fallback ${page.fallback}`);
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
