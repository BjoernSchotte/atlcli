import { describe, expect, test } from "bun:test";

import {
  CHAT_EVALUATION_SCHEMA_V1,
  chatEvaluationScenarioFingerprintV1,
  normalizeChatEvaluationObservationV1,
  normalizeChatEvaluationScenarioV1,
  scoreChatEvaluationV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationScenarioV1,
  type ChatEvaluationVariantV1,
  type ChatReleaseEvaluationVariantV1,
} from "./evaluation.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";

const QUALITY_BY_VARIANT = {
  "legacy-chat": "auto",
  "quick-effort-only": "quick",
  "auto-effort-only": "auto",
  "deep-effort-only": "deep",
} as const;

const REASONING_BY_VARIANT = {
  "legacy-chat": "balanced",
  "quick-effort-only": "fast",
  "auto-effort-only": "balanced",
  "deep-effort-only": "thorough",
} as const;

function scenario(id: string): ChatEvaluationScenarioV1 {
  const result = CHAT_RECOVERY_GOLD_SCENARIOS_V1.find((entry) => entry.id === id);
  if (!result) throw new Error(`Missing test scenario ${id}.`);
  return result;
}

function directObservation(input: {
  scenario: ChatEvaluationScenarioV1;
  variant?: ChatEvaluationVariantV1;
}): ChatEvaluationObservationV1 {
  const variant = input.variant ?? "legacy-chat";
  const assertionId = Object.keys(input.scenario.gold.assertionSupport)[0];
  const sourceId = assertionId
    ? input.scenario.gold.assertionSupport[assertionId]?.[0]
    : undefined;
  const source = input.scenario.sources.find((entry) => entry.id === sourceId);
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: input.scenario.id,
    scenarioFingerprint: chatEvaluationScenarioFingerprintV1(input.scenario),
    variant,
    outcome: input.scenario.gold.expectedOutcome,
    qualityMode: QUALITY_BY_VARIANT[variant],
    providerReasoningPreference: REASONING_BY_VARIANT[variant],
    strategy: {
      execution: "direct",
      reasonCodes: ["legacy-fixed-chat-path"],
    },
    workflow: {
      runtimePath: "legacy-chat-via-research",
      rootExecutions: 1,
      subagentTasks: 0,
      synthesizerTasks: 0,
      researchReportFinalizations: 1,
    },
    discoveredSourceIds: [...input.scenario.gold.relevantSourceIds],
    selectedSourceIds: [...input.scenario.gold.relevantSourceIds],
    detailedSourceIds: [...input.scenario.gold.requiredDetailSourceIds],
    publishedAssertionIds: assertionId ? [assertionId] : [],
    publishedRelationshipIds: [],
    citations: assertionId && sourceId && source
      ? [{ targetId: assertionId, sourceId, canonicalUrl: source.canonicalUrl }]
      : [],
    gaps: input.scenario.gold.requiredGapIds.map((id) => ({
      id,
      kind: id.includes("authority")
        ? "unresolved-contradiction" as const
        : "missing-evidence" as const,
    })),
    calls: { model: 1, ptc: 1, http: 1 },
    tokens: { input: 1_000, output: 200 },
    modelCostMicros: 12_000,
    peakSupervisorInputTokens: 1_000,
    latencyMs: 1_500,
    finalMarkdownChars: 800,
  };
}

function releaseObservation(
  scenario: ChatEvaluationScenarioV1,
  variant: ChatReleaseEvaluationVariantV1,
): ChatEvaluationObservationV1 {
  const base = directObservation({ scenario });
  const qualityMode = variant === "quick"
    ? "quick" as const
    : variant === "auto" || variant === "legacy-chat"
    ? "auto" as const
    : "deep" as const;
  const providerReasoningPreference = qualityMode === "quick"
    ? "fast" as const
    : qualityMode === "auto"
    ? "balanced" as const
    : "thorough" as const;
  const chatVariant = variant === "quick" || variant === "auto" || variant === "deep";
  return {
    ...base,
    variant,
    qualityMode,
    providerReasoningPreference,
    strategy: {
      execution: variant === "deep-research"
        ? "agentic"
        : scenario.gold.expectedStrategyByMode[qualityMode],
      reasonCodes: [variant === "legacy-chat" ? "legacy-fixed-chat-path" : `release:${variant}`],
    },
    workflow: {
      runtimePath: variant === "legacy-chat"
        ? "legacy-chat-via-research"
        : variant === "deep-research"
        ? "deep-research"
        : "chat-agent",
      rootExecutions: 1,
      subagentTasks: chatVariant && qualityMode !== "quick" ? 1 : 0,
      synthesizerTasks: chatVariant && qualityMode !== "quick" ? 1 : 0,
      researchReportFinalizations:
        variant === "legacy-chat" || variant === "deep-research" ? 1 : 0,
    },
  };
}

describe("Chat recovery evaluation V1", () => {
  test("defines twenty normalized customer-free gold cases", () => {
    expect(CHAT_RECOVERY_GOLD_SCENARIOS_V1.map((entry) => entry.id)).toEqual([
      "chat-gold:attached-page",
      "chat-gold:attached-issue",
      "chat-gold:long-page",
      "chat-gold:follow-up",
      "chat-gold:jira-reference-in-page",
      "chat-gold:multi-source-comparison",
      "chat-gold:contradiction",
      "chat-gold:no-evidence",
      "chat-gold:context-switch",
      "chat-gold:later-page-candidate",
      "chat-gold:alternate-title",
      "chat-gold:jira-live-macro",
      "chat-gold:jira-remote-link",
      "chat-gold:stale-duplicate",
      "chat-gold:ambiguous-scope",
      "chat-gold:prompt-injection",
      "chat-gold:deadline-partial",
      "chat-gold:steered-context",
      "chat-gold:exact-link-index-miss",
      "chat-gold:cross-product-chain",
    ]);
    for (const entry of CHAT_RECOVERY_GOLD_SCENARIOS_V1) {
      expect(normalizeChatEvaluationScenarioV1(entry)).toEqual(entry);
      expect(chatEvaluationScenarioFingerprintV1(entry)).toBe(
        chatEvaluationScenarioFingerprintV1(entry),
      );
    }
  });

  test("rejects unknown sources and scores unsupported known-source citations", () => {
    const attachedPage = scenario("chat-gold:attached-page");
    expect(() => normalizeChatEvaluationObservationV1({
      ...directObservation({ scenario: attachedPage }),
      selectedSourceIds: ["wiki:404"],
      detailedSourceIds: [],
    }, attachedPage)).toThrow("unknown source");

    const unsupported = directObservation({ scenario: attachedPage });
    const wrongCitation = normalizeChatEvaluationObservationV1({
      ...unsupported,
      discoveredSourceIds: ["wiki:1001", "wiki:1999"],
      selectedSourceIds: ["wiki:1001", "wiki:1999"],
      citations: [{
        targetId: "assertion:release-scope",
        sourceId: "wiki:1999",
        canonicalUrl: attachedPage.sources.find((entry) => entry.id === "wiki:1999")!.canonicalUrl,
      }],
    }, attachedPage);
    expect(scoreChatEvaluationV1(attachedPage, wrongCitation)).toMatchObject({
      citationPrecision: 0,
      supportedAssertionRecall: 0,
      unsupportedAssertions: 1,
      wrongSources: 1,
    });
  });

  test("scores the same observation deterministically", () => {
    const attachedPage = scenario("chat-gold:attached-page");
    const observation = directObservation({ scenario: attachedPage });
    const first = scoreChatEvaluationV1(attachedPage, observation);
    expect(scoreChatEvaluationV1(attachedPage, observation)).toEqual(first);
    expect(first).toMatchObject({
      sourceRecall: 1,
      detailRecall: 1,
      citationPrecision: 1,
      supportedAssertionRecall: 1,
      wrongSources: 0,
      outcomeCorrect: true,
      strategyCorrect: true,
    });
  });

  test("scores false completeness and multi-source relationship evidence", () => {
    const deadline = scenario("chat-gold:deadline-partial");
    const incomplete = normalizeChatEvaluationObservationV1({
      ...releaseObservation(deadline, "deep"),
      gaps: [],
    }, deadline);
    expect(scoreChatEvaluationV1(deadline, incomplete)).toMatchObject({
      gapRecall: 0,
      falseCompleteness: true,
    });

    const chain = scenario("chat-gold:cross-product-chain");
    const base = releaseObservation(chain, "deep");
    const assertionId = Object.keys(chain.gold.assertionSupport)[0]!;
    const relationshipIds = Object.keys(chain.gold.relationshipSupport);
    const citations = [
      ...chain.gold.assertionSupport[assertionId]!.map((sourceId) => ({
        targetId: assertionId,
        sourceId,
        canonicalUrl: chain.sources.find((source) => source.id === sourceId)!.canonicalUrl,
      })),
      ...relationshipIds.flatMap((targetId) =>
        chain.gold.relationshipSupport[targetId]!.map((sourceId) => ({
          targetId,
          sourceId,
          canonicalUrl: chain.sources.find((source) => source.id === sourceId)!.canonicalUrl,
        }))
      ),
    ].sort((left, right) =>
      `${left.targetId}:${left.sourceId}`.localeCompare(
        `${right.targetId}:${right.sourceId}`,
        "en-US",
      ));
    const complete = normalizeChatEvaluationObservationV1({
      ...base,
      publishedRelationshipIds: relationshipIds,
      citations,
    }, chain);
    expect(scoreChatEvaluationV1(chain, complete)).toMatchObject({
      relationshipRecall: 1,
      supportedAssertionRecall: 1,
      citationPrecision: 1,
      falseCompleteness: false,
    });
  });

  test("committed evaluation fixtures contain neither secrets nor private tenant markers", () => {
    const serialized = JSON.stringify(CHAT_RECOVERY_GOLD_SCENARIOS_V1);
    for (const forbidden of [
      "apiKey",
      "authorization",
      "cookie",
      "rawBody",
      "chainOfThought",
      "hiddenReasoning",
    ]) {
      expect(serialized.toLocaleLowerCase("en-US")).not.toContain(
        forbidden.toLocaleLowerCase("en-US"),
      );
    }
    expect(serialized).toContain("https://chat-eval.atlassian.net");
  });
});
