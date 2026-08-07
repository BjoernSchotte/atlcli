import { describe, expect, test } from "bun:test";

import {
  RESEARCH_REPORT_SCHEMA_V1,
  RESEARCH_REPORT_SCHEMA_V2,
  type ResearchReport,
  type ResearchScopeV1,
  type ResearchSourceReferenceV1,
} from "../contracts.js";
import {
  CHAT_EVALUATION_SCHEMA_V1,
  CHAT_EVALUATION_VARIANTS_V1,
  CHAT_RELEASE_EVALUATION_VARIANTS_V1,
  chatEvaluationScenarioFingerprintV1,
  normalizeChatEvaluationObservationV1,
  normalizeChatEvaluationScenarioV1,
  runChatLegacyEffortComparisonV1,
  runChatReleaseComparisonV1,
  scoreChatEvaluationV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationScenarioV1,
  type ChatEvaluationVariantV1,
  type ChatReleaseEvaluationVariantV1,
} from "./evaluation.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";
import { legacyResearchReportToChatObservationV1 } from "./testing/legacy-evaluation-adapter.js";

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

function reportScope(): ResearchScopeV1 {
  return {
    siteOrigin: "https://chat-eval.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["KB"],
  };
}

function sourceReference(
  source: ChatEvaluationScenarioV1["sources"][number],
  privateMarker: string,
): ResearchSourceReferenceV1 {
  return {
    id: source.id,
    product: source.product,
    title: privateMarker,
    url: source.canonicalUrl,
    excerpt: privateMarker,
  };
}

function runSummary() {
  return {
    model: "test-model",
    wikiProvider: "rest" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2_000,
    complete: true,
    counts: { ptcCalls: 2, httpCalls: 2, jiraItems: 0, confluenceItems: 1 },
    usage: { inputTokens: 1_200, outputTokens: 300 },
    warnings: [],
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

  test("rejects a non-normalized comparison request", async () => {
    const attachedPage = scenario("chat-gold:attached-page");
    const nonNormalized = {
      ...attachedPage,
      sources: [...attachedPage.sources].reverse(),
    };
    await expect(runChatLegacyEffortComparisonV1({
      scenario: nonNormalized,
      runners: Object.fromEntries(CHAT_EVALUATION_VARIANTS_V1.map((variant) => [
        variant,
        async () => directObservation({ scenario: attachedPage, variant }),
      ])) as never,
    })).rejects.toThrow("scenario is not normalized");
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

  test("freezes scope, corpus, question, and budget for effort-only comparison", async () => {
    const attachedPage = scenario("chat-gold:attached-page");
    const received: Array<{ variant: string; scenario: string; frozen: boolean }> = [];
    const runners = Object.fromEntries(CHAT_EVALUATION_VARIANTS_V1.map((variant) => [
      variant,
      async (input: Parameters<Parameters<typeof runChatLegacyEffortComparisonV1>[0]["runners"][ChatEvaluationVariantV1]>[0]) => {
        received.push({
          variant,
          scenario: JSON.stringify(input.scenario),
          frozen: Object.isFrozen(input) && Object.isFrozen(input.scenario) &&
            Object.isFrozen(input.scenario.budget),
        });
        return directObservation({ scenario: attachedPage, variant });
      },
    ])) as Parameters<typeof runChatLegacyEffortComparisonV1>[0]["runners"];

    const result = await runChatLegacyEffortComparisonV1({
      scenario: attachedPage,
      runners,
    });

    expect(received).toHaveLength(4);
    expect(new Set(received.map((entry) => entry.scenario)).size).toBe(1);
    expect(received.every((entry) => entry.frozen)).toBe(true);
    expect(result.providerEffortOnlyWorkflowEquivalent).toBe(true);
    expect(Object.keys(result.runs)).toEqual([...CHAT_EVALUATION_VARIANTS_V1]);
  });

  test("compares legacy, Chat qualities, and explicit Deep Research in one frozen envelope", async () => {
    const attachedPage = scenario("chat-gold:attached-page");
    const received: string[] = [];
    const result = await runChatReleaseComparisonV1({
      scenario: attachedPage,
      runners: Object.fromEntries(CHAT_RELEASE_EVALUATION_VARIANTS_V1.map((variant) => [
        variant,
        async (input: { scenario: Readonly<ChatEvaluationScenarioV1> }) => {
          expect(Object.isFrozen(input.scenario)).toBe(true);
          received.push(JSON.stringify(input.scenario));
          return releaseObservation(attachedPage, variant);
        },
      ])) as unknown as Parameters<typeof runChatReleaseComparisonV1>[0]["runners"],
    });

    expect(received).toHaveLength(5);
    expect(new Set(received).size).toBe(1);
    expect(result.runs.quick.observation.workflow).toMatchObject({
      runtimePath: "chat-agent",
      researchReportFinalizations: 0,
    });
    expect(result.runs["deep-research"].observation.workflow).toMatchObject({
      runtimePath: "deep-research",
      researchReportFinalizations: 1,
    });
    expect(result.runs.deep.metrics).toMatchObject({
      candidateRecall: 1,
      detailCoverage: 1,
      citationPrecision: 1,
      modelCostMicros: 12_000,
      peakSupervisorInputTokens: 1_000,
    });
  });

  test("legacy V1 adapter emits body-free IDs, citations, counters, and sizes", () => {
    const attachedPage = scenario("chat-gold:attached-page");
    const source = attachedPage.sources.find((entry) => entry.id === "wiki:1001")!;
    const privateMarker = "DO-NOT-LEAK-PRIVATE-BODY";
    const report: ResearchReport = {
      schema: RESEARCH_REPORT_SCHEMA_V1,
      title: privateMarker,
      question: privateMarker,
      scope: reportScope(),
      executiveSummary: privateMarker,
      findings: [{
        id: "assertion:release-scope",
        classification: "fact",
        summary: privateMarker,
        sourceIds: [source.id],
      }],
      relationships: [],
      limitations: [privateMarker],
      sources: [sourceReference(source, privateMarker)],
      run: runSummary(),
      markdown: privateMarker.repeat(3),
    };

    const observation = legacyResearchReportToChatObservationV1({
      scenario: attachedPage,
      variant: "legacy-chat",
      report,
      detailedSourceIds: [source.id],
      modelCalls: 1,
    });

    expect(observation).toMatchObject({
      outcome: "answer",
      selectedSourceIds: [source.id],
      detailedSourceIds: [source.id],
      publishedAssertionIds: ["assertion:release-scope"],
      calls: { model: 1, ptc: 2, http: 2 },
      tokens: { input: 1_200, output: 300 },
      latencyMs: 2_000,
      finalMarkdownChars: privateMarker.repeat(3).length,
    });
    expect(JSON.stringify(observation)).not.toContain(privateMarker);
  });

  test("legacy V2 adapter captures current claim finalization without prose", () => {
    const attachedIssue = scenario("chat-gold:attached-issue");
    const source = attachedIssue.sources.find((entry) => entry.id === "jira:DEMO-17")!;
    const privateMarker = "DO-NOT-LEAK-V2-BODY";
    const report: ResearchReport = {
      schema: RESEARCH_REPORT_SCHEMA_V2,
      title: privateMarker,
      question: privateMarker,
      scope: reportScope(),
      executiveSummaryClaimIds: ["assertion:issue-delivery"],
      claims: [{
        id: "assertion:issue-delivery",
        classification: "fact",
        statement: privateMarker,
        freshness: "current",
        evidenceIds: ["evidence:1"],
        sourceIds: [source.id],
      }],
      sections: [],
      coverage: [],
      limitations: [privateMarker],
      sources: [sourceReference(source, privateMarker)],
      run: { ...runSummary(), counts: { ...runSummary().counts, jiraItems: 1, confluenceItems: 0 } },
      markdown: privateMarker.repeat(2),
    };

    const observation = legacyResearchReportToChatObservationV1({
      scenario: attachedIssue,
      variant: "deep-effort-only",
      report,
      detailedSourceIds: [source.id],
      modelCalls: 2,
    });

    expect(observation).toMatchObject({
      qualityMode: "deep",
      providerReasoningPreference: "thorough",
      workflow: {
        runtimePath: "legacy-chat-via-research",
        researchReportFinalizations: 1,
      },
      publishedAssertionIds: ["assertion:issue-delivery"],
    });
    expect(JSON.stringify(observation)).not.toContain(privateMarker);
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
