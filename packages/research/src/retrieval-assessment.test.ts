import { describe, expect, test } from "bun:test";
import { assessResearchRetrievalV1 } from "./retrieval-assessment.js";

function input(overrides: Partial<Parameters<typeof assessResearchRetrievalV1>[0]> = {}) {
  return {
    products: [{
      product: "jira" as const,
      rankedSourceIds: ["jira:ATLCLI-1", "jira:ATLCLI-2"],
      detailedSourceIds: ["jira:ATLCLI-1"],
      searchAttempted: true,
      searchComplete: true,
      canSearchMore: false,
      canReadMoreDetails: true,
    }],
    ptcCallsRemaining: 4,
    httpAttemptsRemaining: 4,
    ...overrides,
  };
}

describe("deterministic retrieval assessment", () => {
  test("continues only for unread host-ranked candidates with remaining budgets", () => {
    expect(assessResearchRetrievalV1(input())).toMatchObject({
      action: "continue",
      reason: "unread_ranked_candidates",
      products: [{ unreadRankedCandidateCount: 1 }],
    });
  });

  test("stops visibly at a detail or global capability ceiling", () => {
    expect(assessResearchRetrievalV1(input({
      products: [{ ...input().products[0]!, canReadMoreDetails: false }],
    }))).toMatchObject({ action: "stop", reason: "detail_budget_exhausted" });
    expect(assessResearchRetrievalV1(input({ ptcCallsRemaining: 0 }))).toMatchObject({
      action: "stop",
      reason: "capability_budget_exhausted",
    });
  });

  test("continues a bounded search only before its terminal page and returns its stop cause otherwise", () => {
    const incomplete = {
      ...input(),
      products: [{
        ...input().products[0]!,
        rankedSourceIds: [],
        detailedSourceIds: [],
        searchComplete: false,
        canSearchMore: true,
      }],
    };
    expect(assessResearchRetrievalV1(incomplete)).toMatchObject({
      action: "continue",
      reason: "search_not_terminal",
    });
    expect(assessResearchRetrievalV1({
      ...incomplete,
      products: [{ ...incomplete.products[0]!, canSearchMore: false }],
    })).toMatchObject({ action: "stop", reason: "search_budget_exhausted" });
  });

  test("treats only host-observed novelty, coverage, and contradictions as replan signals", () => {
    const exhausted = input({
      products: [{
        ...input().products[0]!,
        rankedSourceIds: ["jira:ATLCLI-1"],
        detailedSourceIds: ["jira:ATLCLI-1"],
      }],
      priorAcceptedSourceIds: ["jira:ATLCLI-1"],
      unresolvedCoverageTargetIds: ["coverage:relationship"],
    });
    expect(assessResearchRetrievalV1(exhausted)).toMatchObject({
      action: "stop",
      reason: "marginal_evidence",
      newDetailSourceCount: 0,
    });

    const coverageGap = {
      ...exhausted,
      priorAcceptedSourceIds: [],
      products: [{ ...exhausted.products[0]!, detailedSourceIds: ["jira:ATLCLI-1"] }],
    };
    expect(assessResearchRetrievalV1(coverageGap)).toMatchObject({
      action: "replan",
      reason: "coverage_gap",
    });
    expect(assessResearchRetrievalV1({
      ...coverageGap,
      unresolvedContradictionIds: ["contradiction:delivery"],
    })).toMatchObject({ action: "replan", reason: "unresolved_contradiction" });
  });

  test("rejects an impossible complete-before-search observation", () => {
    expect(() => assessResearchRetrievalV1(input({
      products: [{ ...input().products[0]!, searchAttempted: false }],
    }))).toThrow("cannot be complete");
  });
});
