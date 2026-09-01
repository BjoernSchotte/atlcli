import { describe, expect, it } from "bun:test";
import type {
  PdfDecisionEvidenceV2,
  PdfDecisionEvidenceV1,
  PdfFactsV1,
  PdfHybridPageOutcomeV2,
  PdfTaggedPageOutcomeV1,
  PdfUntaggedPageOutcomeV1,
} from "./contracts.js";
import { PDF_TAGGED_POLICY_REVISION_V2 } from "./contracts.js";
import {
  assessPdfVisualFallbacks,
  fallbackAssessmentPageIndexes,
  isDegenerateTagRegion,
} from "./fallback-policy.js";

function facts(kind: PdfFactsV1["pages"][number]["kind"] = "digital"): Pick<PdfFactsV1, "pages"> {
  return { pages: [{ index: 0, kind }] as PdfFactsV1["pages"] };
}

function tagged(overrides: Partial<PdfTaggedPageOutcomeV1> = {}): PdfTaggedPageOutcomeV1 {
  return {
    pageIndex: 0,
    mode: "geometry-required",
    projectedNodeIds: [],
    claimedCharacterCount: 20,
    unclaimedCharacterCount: 0,
    corruptTagCount: 1,
    ...overrides,
  };
}

function demoted(bbox?: { x: number; y: number; width: number; height: number }): PdfDecisionEvidenceV1 {
  return {
    sourceId: "neutral:node",
    locator: { pageIndex: 0, ...(bbox ? { bbox } : {}) },
    basis: ["structure-tree", "marked-content"],
    confidence: 0,
    decisionCode: "pdf/tagged-node-demoted",
    outcome: "reported",
    analyzerRevision: "atlcli.pdf-tagged-policy/1",
  };
}

function hybrid(overrides: Partial<PdfHybridPageOutcomeV2> = {}): PdfHybridPageOutcomeV2 {
  return {
    pageIndex: 0,
    mode: "fallback-required",
    projectedNodeIds: [],
    visibleCharacterCount: 12,
    uniquelyOwnedCharacterCount: 12,
    explicitBoundaryCount: 2,
    inferredBoundaryCount: 1,
    unresolvedBoundaryCount: 0,
    geometryRepairedCharacterCount: 0,
    geometryRepairRegionCount: 0,
    duplicateOwnershipAttemptCount: 0,
    residualReportedCharacterCount: 4,
    fallbackScope: "page",
    fallbackReasonCodes: ["dispersed-residual-regions"],
    fallbackRegionLocators: [],
    normalizedFallbackArea: 1,
    ...overrides,
  };
}

function deferredFigure(
  sourceId: string,
  bbox?: { x: number; y: number; width: number; height: number },
): PdfDecisionEvidenceV2 {
  return {
    sourceId,
    locator: { pageIndex: 0, ...(bbox ? { bbox } : {}) },
    basis: ["structure-tree", "marked-content"],
    confidence: 0,
    decisionCode: "pdf/tagged-figure-deferred",
    outcome: "reported",
    analyzerRevision: PDF_TAGGED_POLICY_REVISION_V2,
    boundaryDecisionIds: [],
  };
}

describe("PDF visual fallback assessment", () => {
  it("reports degenerate tag residue without requiring a visual fallback", () => {
    const result = assessPdfVisualFallbacks(facts(), {
      evidence: [demoted({ x: 0.4, y: 0.2, width: 0.005, height: 0.00001 })],
      pageOutcomes: [tagged()],
      requiresGeometryPages: [0],
    });
    expect(result[0]).toMatchObject({ scope: "report-only", reasonCodes: ["degenerate-tag-residue"] });
    expect(fallbackAssessmentPageIndexes(result)).toEqual([]);
  });

  it("selects a bounded region for localized meaningful tag corruption", () => {
    const bbox = { x: 0.1, y: 0.2, width: 0.4, height: 0.15 };
    const result = assessPdfVisualFallbacks(facts(), {
      evidence: [demoted(bbox)],
      pageOutcomes: [tagged()],
      requiresGeometryPages: [0],
    });
    expect(result[0]).toMatchObject({
      scope: "region",
      reasonCodes: ["localized-tag-corruption"],
      regionLocators: [{ pageIndex: 0, bbox }],
    });
    expect(fallbackAssessmentPageIndexes(result)).toEqual([0]);
  });

  it("keeps unclaimed text and unlocalized corruption at page scope", () => {
    const unclaimed = assessPdfVisualFallbacks(facts(), {
      evidence: [demoted({ x: 0.1, y: 0.2, width: 0.4, height: 0.15 })],
      pageOutcomes: [tagged({ unclaimedCharacterCount: 2 })],
      requiresGeometryPages: [0],
    });
    expect(unclaimed[0]).toMatchObject({ scope: "page", reasonCodes: ["unclaimed-visible-text"] });
    const unlocalized = assessPdfVisualFallbacks(facts(), {
      evidence: [],
      pageOutcomes: [tagged()],
      requiresGeometryPages: [0],
    });
    expect(unlocalized[0]).toMatchObject({ scope: "page", reasonCodes: ["unlocalized-tag-corruption"] });
  });

  it("keeps failed geometry qualification and image-only pages at page scope", () => {
    const geometry: PdfUntaggedPageOutcomeV1 = {
      pageIndex: 0,
      mode: "fallback-required",
      projectedNodeIds: [],
      columnCount: 0,
      sourceFragmentCount: 0,
      suppressedFragmentCount: 0,
      accountedCharacterCount: 0,
      unaccountedCharacterCount: 0,
      qualificationReasons: ["missing-geometry"],
    };
    expect(assessPdfVisualFallbacks(facts(), {
      evidence: [], pageOutcomes: [geometry], requiresFallbackPages: [0],
    })[0]).toMatchObject({ scope: "page", reasonCodes: ["geometry-qualification-failed"] });
    expect(assessPdfVisualFallbacks(facts("image-only"), {
      evidence: [], pageOutcomes: [geometry], requiresFallbackPages: [0],
    })[0]).toMatchObject({ scope: "page", reasonCodes: ["image-only-page"] });
  });

  it("uses the hybrid reconciler's localized scope and body-free ownership counts", () => {
    const locator = {
      pageIndex: 0,
      structurePath: "neutral:residual",
      characterIndexes: [8, 9, 10, 11],
      bbox: { x: 0.2, y: 0.3, width: 0.2, height: 0.05 },
    };
    const result = assessPdfVisualFallbacks(facts(), {
      evidence: [],
      pageOutcomes: [hybrid({
        fallbackScope: "region",
        fallbackReasonCodes: ["unresolved-text-boundary"],
        fallbackRegionLocators: [locator],
        normalizedFallbackArea: 0.01,
      })],
      requiresFallbackPages: [0],
    });

    expect(result).toEqual([{
      pageIndex: 0,
      scope: "region",
      reasonCodes: ["unresolved-text-boundary"],
      regionLocators: [locator],
      claimedCharacterCount: 8,
      unclaimedCharacterCount: 4,
    }]);
  });

  it("keeps unmatched tagged figures explicit at the narrowest proven fallback scope", () => {
    const none = hybrid({
      mode: "hybrid-native",
      residualReportedCharacterCount: 0,
      fallbackScope: "none",
      fallbackReasonCodes: [],
      normalizedFallbackArea: 0,
    });
    const unlocalized = assessPdfVisualFallbacks(facts(), {
      evidence: [deferredFigure("neutral:figure:unlocalized")],
      pageOutcomes: [none],
      requiresFallbackPages: [],
    });
    expect(unlocalized[0]).toMatchObject({
      scope: "report-only",
      reasonCodes: ["unlocalized-unmatched-figure"],
    });
    expect(fallbackAssessmentPageIndexes(unlocalized)).toEqual([]);

    const bbox = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 };
    const localized = assessPdfVisualFallbacks(facts(), {
      evidence: [deferredFigure("neutral:figure:localized", bbox)],
      pageOutcomes: [none],
      requiresFallbackPages: [],
    });
    expect(localized[0]).toMatchObject({
      scope: "region",
      reasonCodes: ["localized-unmatched-figure"],
      regionLocators: [{ pageIndex: 0, bbox }],
    });
    expect(fallbackAssessmentPageIndexes(localized)).toEqual([0]);

    const partial = assessPdfVisualFallbacks(facts(), {
      evidence: [
        deferredFigure("neutral:figure:localized", bbox),
        deferredFigure("neutral:figure:unlocalized"),
      ],
      pageOutcomes: [none],
      requiresFallbackPages: [],
    });
    expect(partial[0]).toMatchObject({
      scope: "page",
      reasonCodes: ["partially-unlocalized-unmatched-figure"],
    });
  });

  it("uses explicit dimension and area limits for degenerate boxes", () => {
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.01, height: 0.01 })).toBe(true);
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.2, height: 0.002 })).toBe(false);
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.02, height: 0.02 })).toBe(false);
  });
});
