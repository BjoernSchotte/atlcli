import type {
  PdfDecisionEvidenceV1,
  PdfDecisionEvidenceV2,
  PdfFactsV1,
  PdfFactsV2,
  PdfHybridPageOutcomeV2,
  PdfNormalizedRect,
  PdfSourceLocatorV1,
  PdfTaggedPageOutcomeV1,
  PdfTaggedPageOutcomeV2,
  PdfUntaggedPageOutcomeV1,
  PdfUntaggedPageOutcomeV2,
} from "./contracts.js";
export { PDF_VISUAL_FALLBACK_POLICY_REVISION } from "./contracts.js";

/** Tiny tag boxes are commonly producer residue and must not trigger a visible fallback. */
export const PDF_DEGENERATE_TAG_MAX_AREA = 0.0001;
export const PDF_DEGENERATE_TAG_MAX_WIDTH = 0.01;
export const PDF_DEGENERATE_TAG_MAX_HEIGHT = 0.002;

export type PdfFallbackScopeV1 = "none" | "report-only" | "region" | "page";

export interface PdfPageFallbackAssessmentV1 {
  pageIndex: number;
  scope: PdfFallbackScopeV1;
  reasonCodes: string[];
  regionLocators: PdfSourceLocatorV1[];
  claimedCharacterCount: number;
  unclaimedCharacterCount: number;
}

export type PdfFallbackSemanticBaseV1 = {
  evidence: PdfDecisionEvidenceV1[];
  pageOutcomes: Array<PdfTaggedPageOutcomeV1 | PdfUntaggedPageOutcomeV1>;
  requiresGeometryPages?: number[];
  requiresFallbackPages?: number[];
};

export type PdfFallbackSemanticBaseV2 = {
  evidence: PdfDecisionEvidenceV2[];
  pageOutcomes: Array<PdfTaggedPageOutcomeV2 | PdfUntaggedPageOutcomeV2 | PdfHybridPageOutcomeV2>;
  requiresGeometryPages?: number[];
  requiresFallbackPages?: number[];
};

export function isDegenerateTagRegion(rect: PdfNormalizedRect): boolean {
  const area = rect.width * rect.height;
  return area <= PDF_DEGENERATE_TAG_MAX_AREA
    && (rect.width <= PDF_DEGENERATE_TAG_MAX_WIDTH || rect.height <= PDF_DEGENERATE_TAG_MAX_HEIGHT);
}

function taggedOutcome(
  outcome: PdfTaggedPageOutcomeV1 | PdfUntaggedPageOutcomeV1 | undefined,
): outcome is PdfTaggedPageOutcomeV1 {
  return outcome !== undefined && "corruptTagCount" in outcome;
}

function hybridOutcome(
  outcome: PdfTaggedPageOutcomeV1 | PdfUntaggedPageOutcomeV1 | PdfHybridPageOutcomeV2 | undefined,
): outcome is PdfHybridPageOutcomeV2 {
  return outcome !== undefined && "fallbackScope" in outcome;
}

function uniqueLocators(locators: readonly PdfSourceLocatorV1[]): PdfSourceLocatorV1[] {
  const seen = new Set<string>();
  return locators.filter((locator) => {
    const key = JSON.stringify(locator);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assessPdfVisualFallbacks(
  facts: Pick<PdfFactsV1 | PdfFactsV2, "pages">,
  base: PdfFallbackSemanticBaseV1 | PdfFallbackSemanticBaseV2,
): PdfPageFallbackAssessmentV1[] {
  const geometryRequired = new Set(base.requiresGeometryPages ?? []);
  const fallbackRequired = new Set(base.requiresFallbackPages ?? []);
  return facts.pages.map((page) => {
    const outcome = base.pageOutcomes.find((item) => item.pageIndex === page.index);
    if (hybridOutcome(outcome)) {
      return {
        pageIndex: page.index,
        scope: outcome.fallbackScope,
        reasonCodes: outcome.fallbackReasonCodes,
        regionLocators: outcome.fallbackRegionLocators,
        claimedCharacterCount: outcome.uniquelyOwnedCharacterCount - outcome.residualReportedCharacterCount,
        unclaimedCharacterCount: outcome.residualReportedCharacterCount,
      };
    }
    const claimedCharacterCount = outcome && taggedOutcome(outcome)
      ? outcome.claimedCharacterCount
      : outcome && "accountedCharacterCount" in outcome
        ? outcome.accountedCharacterCount
        : 0;
    const unclaimedCharacterCount = outcome && taggedOutcome(outcome)
      ? outcome.unclaimedCharacterCount
      : outcome && "unaccountedCharacterCount" in outcome
        ? outcome.unaccountedCharacterCount
        : 0;
    const common = { pageIndex: page.index, claimedCharacterCount, unclaimedCharacterCount };

    if (page.kind === "blank") {
      return { ...common, scope: "none" as const, reasonCodes: [], regionLocators: [] };
    }
    if (page.kind === "image-only") {
      return {
        ...common,
        scope: "page" as const,
        reasonCodes: ["image-only-page"],
        regionLocators: [],
      };
    }
    if (fallbackRequired.has(page.index)) {
      return {
        ...common,
        scope: "page" as const,
        reasonCodes: ["geometry-qualification-failed"],
        regionLocators: [],
      };
    }
    if (!taggedOutcome(outcome)) {
      return geometryRequired.has(page.index)
        ? { ...common, scope: "page" as const, reasonCodes: ["unlocalized-semantic-loss"], regionLocators: [] }
        : { ...common, scope: "none" as const, reasonCodes: [], regionLocators: [] };
    }
    if (outcome.unclaimedCharacterCount > 0) {
      return {
        ...common,
        scope: "page" as const,
        reasonCodes: ["unclaimed-visible-text"],
        regionLocators: [],
      };
    }
    if (outcome.corruptTagCount === 0) {
      return { ...common, scope: "none" as const, reasonCodes: [], regionLocators: [] };
    }

    const demoted = base.evidence.filter((item) =>
      item.locator.pageIndex === page.index && item.decisionCode === "pdf/tagged-node-demoted"
    );
    if (demoted.length === 0 || demoted.some((item) => !item.locator.bbox)) {
      return {
        ...common,
        scope: "page" as const,
        reasonCodes: ["unlocalized-tag-corruption"],
        regionLocators: [],
      };
    }
    const meaningful = demoted.filter((item) => !isDegenerateTagRegion(item.locator.bbox!));
    if (meaningful.length > 0) {
      return {
        ...common,
        scope: "region" as const,
        reasonCodes: ["localized-tag-corruption"],
        regionLocators: uniqueLocators(meaningful.map((item) => item.locator)),
      };
    }
    return {
      ...common,
      scope: "report-only" as const,
      reasonCodes: ["degenerate-tag-residue"],
      regionLocators: [],
    };
  });
}

export function fallbackAssessmentPageIndexes(
  assessments: readonly PdfPageFallbackAssessmentV1[],
): number[] {
  return assessments
    .filter((assessment) => assessment.scope === "region" || assessment.scope === "page")
    .map((assessment) => assessment.pageIndex);
}
