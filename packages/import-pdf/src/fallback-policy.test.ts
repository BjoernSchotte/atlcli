import { describe, expect, it } from "bun:test";
import type {
  PdfDecisionEvidenceV1,
  PdfFactsV1,
  PdfTaggedPageOutcomeV1,
  PdfUntaggedPageOutcomeV1,
} from "./contracts.js";
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

  it("uses explicit dimension and area limits for degenerate boxes", () => {
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.01, height: 0.01 })).toBe(true);
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.2, height: 0.002 })).toBe(false);
    expect(isDegenerateTagRegion({ x: 0, y: 0, width: 0.02, height: 0.02 })).toBe(false);
  });
});
