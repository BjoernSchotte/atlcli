import { sha256Hex } from "@atlcli/core";
import type { ImportAsset, ImportBlock, ImportDocumentV2, ImportIssue } from "@atlcli/import-core";
import {
  PDF_ASSET_MATERIALIZER_REVISION,
  PDF_VISUAL_FALLBACK_POLICY_REVISION,
  type PdfAssetMaterializationRequestV1,
  type PdfDecisionEvidenceV1,
  type PdfFactsAdapter,
  type PdfMaterializedAssetV1,
  type PdfNormalizedRect,
} from "./contracts.js";
import { expandNormalizedRect, rectsTouch } from "./fallbacks.js";
import type { PdfPageFallbackAssessmentV1 } from "./fallback-policy.js";
import { mergePdfBlocksByEvidence } from "./figures.js";
import { PdfImportError } from "./issues.js";
import { unionRects } from "./text.js";

export const PDF_VISUAL_FALLBACK_RENDER_DPI = 144;
export const PDF_VISUAL_FALLBACK_JOIN_GAP = 0.012;
export const PDF_VISUAL_FALLBACK_MARGIN = 0.008;

interface FallbackCandidate {
  id: string;
  pageIndex: number;
  kind: "page" | "region";
  regionIndex: number;
  bbox: PdfNormalizedRect;
  sourceRefs: string[];
  request: PdfAssetMaterializationRequestV1;
}

function mergeRegions(rects: readonly PdfNormalizedRect[]): PdfNormalizedRect[] {
  const remaining = rects.map((rect) => ({ ...rect }));
  const merged: PdfNormalizedRect[] = [];
  while (remaining.length > 0) {
    const component = [remaining.shift()!];
    for (let index = 0; index < remaining.length;) {
      if (component.some((rect) => rectsTouch(rect, remaining[index]!, PDF_VISUAL_FALLBACK_JOIN_GAP))) {
        component.push(remaining.splice(index, 1)[0]!);
        index = 0;
      } else index += 1;
    }
    const union = unionRects(component);
    if (union) merged.push(expandNormalizedRect(union, PDF_VISUAL_FALLBACK_MARGIN));
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function pdfVisualFallbackRegions(
  assessment: PdfPageFallbackAssessmentV1,
): PdfNormalizedRect[] {
  if (assessment.scope !== "region") return [];
  return mergeRegions(assessment.regionLocators.flatMap((locator) => locator.bbox ? [locator.bbox] : []));
}

function fallbackCandidates(assessments: readonly PdfPageFallbackAssessmentV1[]): FallbackCandidate[] {
  const candidates: FallbackCandidate[] = [];
  for (const assessment of assessments) {
    if (assessment.scope === "page") {
      const id = `pdf:p${assessment.pageIndex}:page-image`;
      const bbox = { x: 0, y: 0, width: 1, height: 1 };
      candidates.push({
        id,
        pageIndex: assessment.pageIndex,
        kind: "page",
        regionIndex: 0,
        bbox,
        sourceRefs: [`pdf:p${assessment.pageIndex}`],
        request: {
          id,
          pageIndex: assessment.pageIndex,
          kind: "rendered-region" as const,
          bbox,
          dpi: PDF_VISUAL_FALLBACK_RENDER_DPI,
        },
      });
      continue;
    }
    for (const [regionIndex, bbox] of pdfVisualFallbackRegions(assessment).entries()) {
      const id = `pdf:p${assessment.pageIndex}:fallback-region:${regionIndex}`;
      const sourceRefs = assessment.regionLocators.flatMap((locator) =>
        locator.bbox && rectsTouch(locator.bbox, bbox, 0) && locator.structurePath
          ? [locator.structurePath]
          : []
      );
      candidates.push({
        id,
        pageIndex: assessment.pageIndex,
        kind: "region",
        regionIndex,
        bbox,
        sourceRefs: sourceRefs.length > 0 ? sourceRefs : [`pdf:p${assessment.pageIndex}`],
        request: {
          id,
          pageIndex: assessment.pageIndex,
          kind: "rendered-region" as const,
          bbox,
          dpi: PDF_VISUAL_FALLBACK_RENDER_DPI,
        },
      });
    }
  }
  return candidates;
}

function verifiedMaterialized(
  candidate: FallbackCandidate,
  byRequest: ReadonlyMap<string, PdfMaterializedAssetV1>,
): PdfMaterializedAssetV1 {
  const asset = byRequest.get(candidate.request.id);
  if (!asset || asset.materializerRevision !== PDF_ASSET_MATERIALIZER_REVISION || asset.mediaType !== "image/png") {
    throw new PdfImportError("pdf/incomplete", "Visual fallback failed materializer verification.");
  }
  return asset;
}

export async function materializePdfVisualFallbacks(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapter,
  document: ImportDocumentV2,
  evidence: readonly PdfDecisionEvidenceV1[],
  assessments: readonly PdfPageFallbackAssessmentV1[],
): Promise<{ document: ImportDocumentV2; evidence: PdfDecisionEvidenceV1[] }> {
  const candidates = fallbackCandidates(assessments);
  if (candidates.length === 0) return { document, evidence: [...evidence] };
  const materialized = await adapter.materialize(sourceBytes, candidates.map((candidate) => candidate.request));
  if (materialized.length !== candidates.length) {
    throw new PdfImportError("pdf/incomplete", "Visual fallback did not materialize every requested region.");
  }
  const byRequest = new Map(materialized.map((asset) => [asset.requestId, asset]));
  const assets = new Map<string, ImportAsset>(document.assets.map((asset) => [asset.id, asset]));
  const additions: Array<{ block: ImportBlock; pageIndex: number; y: number; x: number; height: number }> = [];
  const nextEvidence = [...evidence];
  const issues: ImportIssue[] = document.issues.map((issue) => {
    if (issue.outcome !== "reported" || issue.code !== "pdf-import/tagged-node-demoted") return issue;
    const covered = candidates.some((candidate) =>
      candidate.kind === "region" && candidate.sourceRefs.some((sourceRef) => issue.sourceRefs?.includes(sourceRef))
    );
    return covered ? { ...issue, outcome: "attached" as const } : issue;
  });
  const pageCovered = new Set(candidates.filter((candidate) => candidate.kind === "page").map((candidate) => candidate.pageIndex));
  const pageCoveredCodes = new Set([
    "pdf-import/image-only-page",
    "pdf-import/geometry-page-fallback-required",
    "pdf-import/tagged-structure-missing",
    "pdf-import/tagged-text-unclaimed",
    "pdf-import/tagged-node-demoted",
  ]);
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index]!;
    if (
      issue.outcome === "reported"
      && pageCoveredCodes.has(issue.code)
      && typeof issue.context?.pageIndex === "number"
      && pageCovered.has(issue.context.pageIndex)
    ) issues[index] = { ...issue, outcome: "attached" };
  }

  for (const candidate of candidates) {
    const asset = verifiedMaterialized(candidate, byRequest);
    if (await sha256Hex(asset.bytes) !== asset.sha256) {
      throw new PdfImportError("pdf/incomplete", "Visual fallback asset failed digest verification.");
    }
    const assetId = `pdf:asset:${asset.sha256}`;
    if (!assets.has(assetId)) {
      assets.set(assetId, {
        id: assetId,
        sourceRefs: candidate.sourceRefs,
        fileName: candidate.kind === "page"
          ? `pdf-page-${String(candidate.pageIndex + 1).padStart(3, "0")}-${asset.sha256.slice(0, 12)}.png`
          : `pdf-page-${String(candidate.pageIndex + 1).padStart(3, "0")}-region-${String(candidate.regionIndex + 1).padStart(2, "0")}-${asset.sha256.slice(0, 12)}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array(asset.bytes),
      });
    }
    const blockId = `${candidate.id}:block`;
    const captionId = `${candidate.id}:caption`;
    const caption = candidate.kind === "page"
      ? `Original visual view of source page ${candidate.pageIndex + 1}.`
      : `Visual fallback for source page ${candidate.pageIndex + 1}, region ${candidate.regionIndex + 1}.`;
    additions.push({
      block: {
        id: blockId,
        type: "image",
        assetId,
        presentation: candidate.kind === "page" ? "page-fallback" : "region-fallback",
        alt: caption,
        captionBlockId: captionId,
        sourceRefs: candidate.sourceRefs,
      },
      pageIndex: candidate.pageIndex,
      y: candidate.kind === "page" ? Number.MAX_SAFE_INTEGER - 1 : candidate.bbox.y,
      x: candidate.bbox.x,
      height: candidate.kind === "page" ? 0 : candidate.bbox.height,
    });
    additions.push({
      block: {
        id: captionId,
        type: "paragraph",
        runs: [{ kind: "text", text: caption, marks: { italic: true } }],
        sourceRefs: candidate.sourceRefs,
      },
      pageIndex: candidate.pageIndex,
      y: candidate.kind === "page" ? Number.MAX_SAFE_INTEGER : candidate.bbox.y + candidate.bbox.height + 0.001,
      x: candidate.bbox.x,
      height: 0,
    });
    nextEvidence.push({
      sourceId: candidate.id,
      targetNodeId: blockId,
      locator: { pageIndex: candidate.pageIndex, bbox: candidate.bbox },
      basis: ["rendered-region"],
      confidence: 1,
      decisionCode: candidate.kind === "page"
        ? "pdf/page-image-fallback-attached"
        : "pdf/region-image-fallback-attached",
      outcome: "attached",
      analyzerRevision: PDF_VISUAL_FALLBACK_POLICY_REVISION,
    });
    issues.push({
      code: candidate.kind === "page"
        ? "pdf-import/page-image-fallback-attached"
        : "pdf-import/region-image-fallback-attached",
      severity: "warning",
      outcome: "attached",
      message: candidate.kind === "page"
        ? "The source page is preserved as a rendered image and is not accessible editable text."
        : "A bounded source region preserves visual fidelity where semantic extraction was unsafe.",
      sourceRefs: candidate.sourceRefs,
      context: { pageIndex: candidate.pageIndex, width: asset.width, height: asset.height },
    });
  }
  return {
    document: {
      ...document,
      blocks: mergePdfBlocksByEvidence(document.blocks, additions, nextEvidence),
      assets: [...assets.values()],
      issues,
    },
    evidence: nextEvidence,
  };
}
