import { describe, expect, test } from "bun:test";
import { SYNTHETIC_RESEARCH_SCENARIO_V1 } from "./deterministic-scenario.js";
import {
  RESEARCH_EVALUATION_SCHEMA_V1,
  type ResearchEvaluationGoldV1,
  type ResearchEvaluationObservationV1,
} from "./evaluation.js";
import {
  RESEARCH_T3_COMPARISON_SCHEMA_V1,
  researchT3RequestFingerprintV1,
  runResearchT3ComparisonV1,
  type ResearchT3ComparisonRunEvidenceV1,
  type ResearchT3ComparisonScenarioV1,
  type ResearchT3ComparisonVariantV1,
  type ResearchT3VariantRunnerV1,
} from "./t3-comparison.js";

const gold: ResearchEvaluationGoldV1 = {
  schema: RESEARCH_EVALUATION_SCHEMA_V1,
  relevantSourceIds: ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"],
  requiredDetailSourceIds: ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"],
  claimSupport: { "claim:exact-link": ["jira:DEMO-1", "wiki:1001"] },
  verifiedRelationshipSupport: {},
  expectedAbstentions: { "question:no-answer": true },
  requiredCompletenessCriteria: ["pagination", "details", "limitations"],
  requiredBranchIds: ["jira", "wiki", "join", "synthesis"],
  expectedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
  catalogEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
  necessaryScopeExpansionIds: [],
};

const scenario: ResearchT3ComparisonScenarioV1 = {
  schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
  id: "synthetic-s0-s3-comparison",
  request: SYNTHETIC_RESEARCH_SCENARIO_V1.request,
  gold,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function observation(
  variant: ResearchT3ComparisonVariantV1,
  options: { completeCoverage?: boolean; cost?: number; contextTokens?: number } = {},
): ResearchEvaluationObservationV1 {
  const completeCoverage = options.completeCoverage ?? (
    variant === "S2" || variant === "S3"
  );
  const contextTokens = options.contextTokens ?? (variant === "S0" ? 11_000 : variant === "S1" ? 12_000 : 9_000);
  return {
    retrievedSourceIds: ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"],
    detailedSourceIds: completeCoverage
      ? ["jira:DEMO-1", "wiki:1001", "jira:DEMO-2"]
      : ["jira:DEMO-1", "wiki:1001"],
    publishedClaimIds: ["claim:exact-link"],
    publishedVerifiedRelationshipIds: [],
    citations: [{
      targetKind: "claim",
      targetId: "claim:exact-link",
      sourceId: "jira:DEMO-1",
    }],
    abstentions: { "question:no-answer": true },
    completedCriteria: ["pagination", "details", "limitations"],
    completedBranchIds: ["jira", "wiki", "join", "synthesis"],
    taskFingerprints: variant === "S0"
      ? ["single-agent"]
      : ["jira", "wiki", "synthesis"],
    promptInjectionSucceeded: false,
    resolvedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
    autoResolvedScopeEntityIds: ["jira:project:DEMO"],
    catalogObservedEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
    scopeExpansionProposalIds: [],
    calls: { model: variant === "S0" ? 2 : 4, ptc: 8, http: 8 },
    bytes: { modelInput: 24_000, modelOutput: 2_000, providerResponse: 32_000 },
    tokens: { modelInput: contextTokens, modelOutput: 1_000 },
    latencySamplesMs: [600, 700, 800],
    modelCostSamplesUsd: [options.cost ?? (variant === "S1" ? 0.01 : 0.02)],
    peakSupervisorContextTokens: contextTokens,
    peakSupervisorContextBytes: contextTokens * 4,
  };
}

function composition(variant: ResearchT3ComparisonVariantV1) {
  switch (variant) {
    case "S0":
      return {
        execution: "single-agent" as const,
        researchWorkerTaskCount: 0,
        synthesizerTaskCount: 0,
        reconciliation: "not-admitted" as const,
        maxConcurrentSubagents: 0,
        maxConcurrentPtcCalls: 2,
        reportPublications: 1,
        markdownChars: 1_000,
      };
    case "S1":
      return {
        execution: "dynamic-graph" as const,
        researchWorkerTaskCount: 1,
        synthesizerTaskCount: 1,
        reconciliation: "not-admitted" as const,
        maxConcurrentSubagents: 1,
        maxConcurrentPtcCalls: 2,
        reportPublications: 1,
        markdownChars: 1_000,
      };
    case "S2":
      return {
        execution: "dynamic-graph" as const,
        researchWorkerTaskCount: 2,
        synthesizerTaskCount: 1,
        reconciliation: "not-admitted" as const,
        maxConcurrentSubagents: 2,
        maxConcurrentPtcCalls: 2,
        reportPublications: 1,
        markdownChars: 1_000,
      };
    case "S3":
      return {
        execution: "dynamic-graph" as const,
        researchWorkerTaskCount: 2,
        synthesizerTaskCount: 1,
        reconciliation: "completed" as const,
        maxConcurrentSubagents: 2,
        maxConcurrentPtcCalls: 2,
        reportPublications: 1,
        markdownChars: 1_000,
      };
  }
}

function runners(options: {
  mutateRequestFor?: ResearchT3ComparisonVariantV1;
  compositionOverride?: Partial<Record<ResearchT3ComparisonVariantV1, ReturnType<typeof composition>>>;
  observationOverride?: Partial<Record<ResearchT3ComparisonVariantV1, ResearchEvaluationObservationV1>>;
  onInput?: (variant: ResearchT3ComparisonVariantV1, input: Parameters<ResearchT3VariantRunnerV1>[0]) => void;
} = {}): Record<ResearchT3ComparisonVariantV1, ResearchT3VariantRunnerV1> {
  const create = (variant: ResearchT3ComparisonVariantV1): ResearchT3VariantRunnerV1 => async (input) => {
    options.onInput?.(variant, input);
    const request = clone(input.request);
    if (options.mutateRequestFor === variant) request.limits.maxPtcCalls += 1;
    return {
      schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
      scenarioId: input.scenarioId,
      variant,
      request,
      observation: options.observationOverride?.[variant] ?? observation(variant),
      composition: options.compositionOverride?.[variant] ?? composition(variant),
    } satisfies ResearchT3ComparisonRunEvidenceV1;
  };
  return { S0: create("S0"), S1: create("S1"), S2: create("S2"), S3: create("S3") };
}

describe("T3 S0-S3 comparison harness", () => {
  test("runs every composition with one frozen request/budget envelope and records a directional go decision", async () => {
    const inputs: Array<{
      variant: ResearchT3ComparisonVariantV1;
      requestFingerprint: string;
      requestIsFrozen: boolean;
    }> = [];
    const result = await runResearchT3ComparisonV1({
      scenario,
      runners: runners({
        onInput: (variant, input) => inputs.push({
          variant,
          requestFingerprint: input.requestFingerprint,
          requestIsFrozen: Object.isFrozen(input.request),
        }),
      }),
    });

    expect(inputs).toEqual([
      { variant: "S0", requestFingerprint: researchT3RequestFingerprintV1(scenario.request), requestIsFrozen: true },
      { variant: "S1", requestFingerprint: researchT3RequestFingerprintV1(scenario.request), requestIsFrozen: true },
      { variant: "S2", requestFingerprint: researchT3RequestFingerprintV1(scenario.request), requestIsFrozen: true },
      { variant: "S3", requestFingerprint: researchT3RequestFingerprintV1(scenario.request), requestIsFrozen: true },
    ]);
    expect(result.runs.S0.metrics.peakSupervisorContextBytes).toBe(44_000);
    expect(result.runs.S1.metrics.peakSupervisorContextBytes).toBe(48_000);
    expect(result.runs.S2.metrics.sourceCoverage).toBe(1);
    expect(result.runs.S3.evidence.composition.reconciliation).toBe("completed");
    expect(result.candidateDecisions).toEqual([
      expect.objectContaining({ variant: "S2", accepted: true }),
      expect.objectContaining({ variant: "S3", accepted: true }),
    ]);
    expect(result).toMatchObject({ decision: "go", recommendedDefault: "S3" });
  });

  test("rejects a runner that changes the normalized scope or budget envelope", async () => {
    await expect(runResearchT3ComparisonV1({
      scenario,
      runners: runners({ mutateRequestFor: "S2" }),
    })).rejects.toThrow("S2 changed scope, budget, or provider");
  });

  test("rejects a fake S2 composition that executes only one worker", async () => {
    await expect(runResearchT3ComparisonV1({
      scenario,
      runners: runners({
        compositionOverride: {
          S2: { ...composition("S2"), researchWorkerTaskCount: 1 },
        },
      }),
    })).rejects.toThrow("S2 must dispatch bounded subagents");
  });

  test("holds S1 as default when neither subagent candidate earns the pre-registered gain", async () => {
    const noGainS2 = observation("S2", {
      completeCoverage: false,
      cost: 0.01,
      contextTokens: 12_000,
    });
    const noGainS3 = observation("S3", {
      completeCoverage: false,
      cost: 0.01,
      contextTokens: 12_000,
    });
    const result = await runResearchT3ComparisonV1({
      scenario,
      runners: runners({ observationOverride: { S2: noGainS2, S3: noGainS3 } }),
    });
    expect(result).toMatchObject({ decision: "hold", recommendedDefault: "S1" });
    expect(result.candidateDecisions).toEqual([
      expect.objectContaining({ variant: "S2", accepted: false }),
      expect.objectContaining({ variant: "S3", accepted: false }),
    ]);
  });
});
