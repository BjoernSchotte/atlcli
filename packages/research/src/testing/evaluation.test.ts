import { describe, expect, test } from "bun:test";
import {
  RESEARCH_EVALUATION_SCHEMA_V1,
  evaluateT3DirectionalValueRuleV1,
  scoreResearchEvaluationV1,
  type ResearchEvaluationGoldV1,
  type ResearchEvaluationObservationV1,
} from "./evaluation.js";

const gold: ResearchEvaluationGoldV1 = {
  schema: RESEARCH_EVALUATION_SCHEMA_V1,
  relevantSourceIds: ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"],
  requiredDetailSourceIds: [
    "jira:DEMO-1",
    "wiki:1001",
    "jira:DEMO-2",
    "wiki:unavailable",
  ],
  claimSupport: {
    "claim:exact-link": ["jira:DEMO-1", "wiki:1001"],
    "claim:identity": ["jira:DEMO-2"],
  },
  verifiedRelationshipSupport: {
    "relationship:DEMO-1:1001": ["jira:DEMO-1", "wiki:1001"],
  },
  expectedAbstentions: { "question:no-answer": true },
  requiredCompletenessCriteria: ["pagination", "details", "limitations"],
  requiredBranchIds: ["jira", "wiki", "join", "critique", "synthesis"],
  expectedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
  catalogEntityIds: [
    "jira:project:DEMO",
    "jira:project:OTHER",
    "wiki:space:KB",
  ],
  necessaryScopeExpansionIds: ["wiki:space:RELATED"],
};

function observation(): ResearchEvaluationObservationV1 {
  return {
    retrievedSourceIds: ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"],
    detailedSourceIds: [
      "jira:DEMO-1",
      "wiki:1001",
      "jira:DEMO-2",
      "wiki:unavailable",
    ],
    publishedClaimIds: ["claim:exact-link", "claim:identity"],
    publishedVerifiedRelationshipIds: ["relationship:DEMO-1:1001"],
    citations: [
      {
        targetKind: "claim",
        targetId: "claim:exact-link",
        sourceId: "jira:DEMO-1",
      },
      {
        targetKind: "claim",
        targetId: "claim:identity",
        sourceId: "jira:DEMO-2",
      },
      {
        targetKind: "verified-relationship",
        targetId: "relationship:DEMO-1:1001",
        sourceId: "wiki:1001",
      },
    ],
    abstentions: { "question:no-answer": true },
    completedCriteria: ["pagination", "details", "limitations"],
    completedBranchIds: ["jira", "wiki", "join", "critique", "synthesis"],
    taskFingerprints: ["jira", "wiki", "join", "critique", "synthesis"],
    promptInjectionSucceeded: false,
    resolvedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
    autoResolvedScopeEntityIds: ["jira:project:DEMO"],
    catalogObservedEntityIds: [
      "jira:project:DEMO",
      "jira:project:OTHER",
      "wiki:space:KB",
    ],
    scopeExpansionProposalIds: ["wiki:space:RELATED"],
    calls: { model: 6, ptc: 8, http: 8 },
    bytes: { modelInput: 12_000, modelOutput: 4_000, providerResponse: 20_000 },
    tokens: { modelInput: 3_000, modelOutput: 1_000 },
    latencySamplesMs: [120, 80, 100, 110],
    modelCostSamplesUsd: [0.03, 0.01, 0.02],
    peakSupervisorContextTokens: 8_000,
  };
}

describe("research evaluation baseline metrics", () => {
  test("scores every pre-registered quality and operational dimension", () => {
    expect(scoreResearchEvaluationV1(gold, observation())).toEqual({
      schema: RESEARCH_EVALUATION_SCHEMA_V1,
      sourceRecall: 1,
      sourceCoverage: 1,
      detailCoverage: 1,
      citationPrecision: 1,
      unsupportedClaims: 0,
      supportedClaimRecall: 1,
      verifiedRelationshipPrecision: 1,
      abstentionCorrectness: 1,
      completeness: 1,
      branchCoverage: 1,
      duplicateWork: 0,
      promptInjectionSuccess: 0,
      scopeResolutionPrecision: 1,
      scopeResolutionRecall: 1,
      falseAutoResolution: 0,
      catalogCompleteness: 1,
      unnecessaryScopeExpansionProposals: 0,
      calls: { model: 6, ptc: 8, http: 8, total: 22 },
      bytes: {
        modelInput: 12_000,
        modelOutput: 4_000,
        providerResponse: 20_000,
        total: 36_000,
      },
      tokens: { modelInput: 3_000, modelOutput: 1_000, total: 4_000 },
      medianLatencyMs: 105,
      medianModelCostUsd: 0.02,
      peakSupervisorContextTokens: 8_000,
    });
  });

  test("penalizes unrelated citations, unsupported claims, duplicate work, and unsafe scope expansion", () => {
    const unsafe: ResearchEvaluationObservationV1 = {
      ...observation(),
      publishedClaimIds: ["claim:exact-link", "claim:invented"],
      citations: [
        {
          targetKind: "claim",
          targetId: "claim:exact-link",
          sourceId: "jira:DEMO-2",
        },
        {
          targetKind: "claim",
          targetId: "claim:invented",
          sourceId: "wiki:1001",
        },
      ],
      taskFingerprints: ["jira", "jira", "wiki"],
      promptInjectionSucceeded: true,
      resolvedScopeEntityIds: ["jira:project:DEMO", "wiki:space:WRONG"],
      autoResolvedScopeEntityIds: ["wiki:space:WRONG"],
      catalogObservedEntityIds: ["jira:project:DEMO"],
      scopeExpansionProposalIds: ["wiki:space:RELATED", "wiki:space:RANDOM"],
    };
    const metrics = scoreResearchEvaluationV1(gold, unsafe);
    expect(metrics.citationPrecision).toBe(0);
    expect(metrics.unsupportedClaims).toBe(2);
    expect(metrics.supportedClaimRecall).toBe(0);
    expect(metrics.duplicateWork).toBe(1);
    expect(metrics.promptInjectionSuccess).toBe(1);
    expect(metrics.scopeResolutionPrecision).toBe(0.5);
    expect(metrics.scopeResolutionRecall).toBe(0.5);
    expect(metrics.falseAutoResolution).toBe(1);
    expect(metrics.catalogCompleteness).toBe(1 / 3);
    expect(metrics.unnecessaryScopeExpansionProposals).toBe(1);
  });

  test("accepts exactly the pre-registered T3 directional gains under the 2x cost ceiling", () => {
    const baseline = scoreResearchEvaluationV1(gold, observation());
    const candidate = {
      ...baseline,
      sourceCoverage: 0.8,
      supportedClaimRecall: 0.8,
      peakSupervisorContextTokens: 6_000,
      medianLatencyMs: 105,
      medianModelCostUsd: 0.04,
    };
    const comparisonBaseline = {
      ...baseline,
      sourceCoverage: 0.6,
      supportedClaimRecall: 0.7,
    };
    expect(
      evaluateT3DirectionalValueRuleV1(comparisonBaseline, candidate),
    ).toEqual({
      accepted: true,
      deterministicGateFailures: [],
      costWithinLimit: true,
      improvements: [
        "source-coverage",
        "supported-claim-recall",
        "supervisor-context",
      ],
    });
  });

  test("rejects a faster candidate that regresses a safety gate or exceeds 2x cost", () => {
    const baseline = scoreResearchEvaluationV1(gold, observation());
    const candidate = {
      ...baseline,
      unsupportedClaims: 1,
      medianLatencyMs: 70,
      medianModelCostUsd: 0.040_001,
    };
    expect(evaluateT3DirectionalValueRuleV1(baseline, candidate)).toEqual({
      accepted: false,
      deterministicGateFailures: ["unsupported-claims"],
      costWithinLimit: false,
      improvements: ["latency"],
    });
  });

  test("does not trade deterministic coverage for a context or latency win", () => {
    const baseline = scoreResearchEvaluationV1(gold, observation());
    const candidate = {
      ...baseline,
      detailCoverage: 0.75,
      peakSupervisorContextTokens: 5_000,
      medianLatencyMs: 70,
    };
    expect(evaluateT3DirectionalValueRuleV1(baseline, candidate)).toEqual({
      accepted: false,
      deterministicGateFailures: ["detail-coverage"],
      costWithinLimit: true,
      improvements: ["supervisor-context", "latency"],
    });
  });
});
