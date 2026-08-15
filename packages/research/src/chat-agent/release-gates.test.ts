import { describe, expect, test } from "bun:test";
import {
  CHAT_EVALUATION_SCHEMA_V1,
  chatEvaluationScenarioFingerprintV1,
  runChatReleaseComparisonV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationScenarioV1,
  type ChatReleaseEvaluationVariantV1,
} from "./evaluation.js";
import {
  CHAT_RELEASE_MODEL_JUDGE_POLICY_V1,
  evaluateChatReleaseGatesV1,
} from "./release-gates.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";

const simple = CHAT_RECOVERY_GOLD_SCENARIOS_V1.find((scenario) =>
  scenario.id === "chat-gold:attached-page"
)!;
const complex = CHAT_RECOVERY_GOLD_SCENARIOS_V1.find((scenario) =>
  scenario.id === "chat-gold:multi-source-comparison"
)!;

function observation(input: {
  scenario: ChatEvaluationScenarioV1;
  variant: ChatReleaseEvaluationVariantV1;
  omitSupportedAssertions?: boolean;
  wrongSource?: boolean;
}): ChatEvaluationObservationV1 {
  const { scenario, variant } = input;
  const qualityMode = variant === "quick"
    ? "quick"
    : variant === "deep" || variant === "deep-research"
      ? "deep"
      : "auto";
  const runtimePath = variant === "legacy-chat"
    ? "legacy-chat-via-research"
    : variant === "deep-research"
      ? "deep-research"
      : "chat-agent";
  const publishedAssertionIds = input.omitSupportedAssertions
    ? []
    : Object.keys(scenario.gold.assertionSupport);
  const publishedRelationshipIds = input.omitSupportedAssertions
    ? []
    : Object.keys(scenario.gold.relationshipSupport);
  const citations = [
    ...publishedAssertionIds.flatMap((targetId) =>
      (scenario.gold.assertionSupport[targetId] ?? []).map((sourceId) => ({
        targetId,
        sourceId,
        canonicalUrl: scenario.sources.find((source) => source.id === sourceId)!.canonicalUrl,
      }))
    ),
    ...publishedRelationshipIds.flatMap((targetId) =>
      (scenario.gold.relationshipSupport[targetId] ?? []).map((sourceId) => ({
        targetId,
        sourceId,
        canonicalUrl: scenario.sources.find((source) => source.id === sourceId)!.canonicalUrl,
      }))
    ),
  ];
  const wrongSource = input.wrongSource
    ? scenario.sources.find((source) => !scenario.gold.relevantSourceIds.includes(source.id))?.id
    : undefined;
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: scenario.id,
    scenarioFingerprint: chatEvaluationScenarioFingerprintV1(scenario),
    variant,
    outcome: scenario.gold.expectedOutcome,
    qualityMode,
    providerReasoningPreference: variant === "quick"
      ? "fast"
      : variant === "deep" || variant === "deep-research"
        ? "thorough"
        : "balanced",
    strategy: {
      execution: variant === "deep-research"
        ? "agentic"
        : scenario.gold.expectedStrategyByMode[qualityMode],
      reasonCodes: [`release:${variant}`],
    },
    workflow: {
      runtimePath,
      rootExecutions: 1,
      subagentTasks: runtimePath === "chat-agent" && qualityMode !== "quick" ? 2 : 0,
      synthesizerTasks: runtimePath === "chat-agent" && qualityMode !== "quick" ? 1 : 0,
      researchReportFinalizations: runtimePath === "legacy-chat-via-research" ||
          runtimePath === "deep-research"
        ? 1
        : 0,
    },
    selectedSourceIds: [
      ...scenario.gold.relevantSourceIds,
      ...(wrongSource ? [wrongSource] : []),
    ],
    discoveredSourceIds: [
      ...scenario.gold.relevantSourceIds,
      ...(wrongSource ? [wrongSource] : []),
    ],
    detailedSourceIds: [...scenario.gold.requiredDetailSourceIds],
    publishedAssertionIds,
    publishedRelationshipIds,
    citations,
    gaps: scenario.gold.requiredGapIds.map((id) => ({
      id,
      kind: scenario.gold.requiredContradictionIds.includes(id)
        ? "unresolved-contradiction" as const
        : "missing-evidence" as const,
    })),
    calls: { model: 2, ptc: 3, http: 2 },
    tokens: { input: 2_000, output: 500 },
    modelCostMicros: 50_000,
    peakSupervisorInputTokens: 2_000,
    latencyMs: 5_000,
    finalMarkdownChars: 500,
  };
}

async function comparison(
  scenario: ChatEvaluationScenarioV1,
  overrides: Partial<Record<ChatReleaseEvaluationVariantV1, {
    omitSupportedAssertions?: boolean;
    wrongSource?: boolean;
  }>> = {},
) {
  const runner = (variant: ChatReleaseEvaluationVariantV1) => async () =>
    observation({ scenario, variant, ...overrides[variant] });
  return runChatReleaseComparisonV1({
    scenario,
    runners: {
      "legacy-chat": runner("legacy-chat"),
      quick: runner("quick"),
      auto: runner("auto"),
      deep: runner("deep"),
      "deep-research": runner("deep-research"),
    },
  });
}

describe("deterministic Chat release gates", () => {
  test("passes exact-context correctness and a measurable Deep complex gain", async () => {
    const cases = await Promise.all(CHAT_RECOVERY_GOLD_SCENARIOS_V1.map(async (scenario) => ({
      scenario,
      comparison: await comparison(scenario, {
        "legacy-chat": { omitSupportedAssertions: true },
        ...(scenario.gold.expectedStrategyByMode.auto === "agentic"
          ? { quick: { omitSupportedAssertions: true } }
          : {}),
      }),
    })));
    const result = evaluateChatReleaseGatesV1({
      cases,
    });

    expect(result).toMatchObject({
      passed: true,
      modelJudgePolicy: CHAT_RELEASE_MODEL_JUDGE_POLICY_V1,
      scenarioCount: CHAT_RECOVERY_GOLD_SCENARIOS_V1.length,
      simpleScenarioCount: CHAT_RECOVERY_GOLD_SCENARIOS_V1.filter((scenario) =>
        scenario.gold.expectedStrategyByMode.auto === "direct"
      ).length,
      complexScenarioCount: CHAT_RECOVERY_GOLD_SCENARIOS_V1.filter((scenario) =>
        scenario.gold.expectedStrategyByMode.auto === "agentic"
      ).length,
      failures: [],
    });
    expect(result.aggregate.autoQuality).toBeGreaterThan(result.aggregate.legacyQuality);
    expect(result.aggregate.deepComplexQuality).toBeGreaterThan(
      result.aggregate.quickComplexQuality,
    );
    expect(result.aggregate.deepSimpleQuality).toBe(
      result.aggregate.quickSimpleQuality,
    );
  });

  test("blocks wrong sources and a Deep mode that adds no complex quality", async () => {
    const result = evaluateChatReleaseGatesV1({
      cases: [
        {
          scenario: simple,
          comparison: await comparison(simple, {
            "legacy-chat": { omitSupportedAssertions: true },
          }),
        },
        {
          scenario: complex,
          comparison: await comparison(complex, {
            "legacy-chat": { omitSupportedAssertions: true },
            quick: { omitSupportedAssertions: true },
            auto: { wrongSource: true },
            deep: { omitSupportedAssertions: true },
          }),
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      { code: "deep-not-better-on-complex", scenarioIds: ["aggregate"] },
      { code: "wrong-source", scenarioIds: [complex.id] },
    ]));
  });

  test("rejects duplicate comparison identities and invalid thresholds", async () => {
    const one = await comparison(simple, {
      "legacy-chat": { omitSupportedAssertions: true },
    });
    expect(evaluateChatReleaseGatesV1({
      cases: [
        { scenario: simple, comparison: one },
        { scenario: simple, comparison: one },
      ],
    }).failures).toContainEqual({
      code: "comparison-identity-invalid",
      scenarioIds: [simple.id],
    });
    expect(() => evaluateChatReleaseGatesV1({
      cases: [{ scenario: simple, comparison: one }],
      policy: {
        schema: "atlcli.chat-release-gate/v1",
        minimumExactContextQuality: 2,
        minimumAutoQualityGainOverLegacy: 0.05,
        minimumDeepComplexQualityGainOverQuick: 0.05,
        maximumDeepSimpleQualityRegression: 0,
      },
    })).toThrow("Invalid Chat release gate policy");
  });
});
