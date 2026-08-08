import { describe, expect, test } from "bun:test";
import {
  CHAT_PERFORMANCE_BENCHMARK_IDS_V1,
  CHAT_PERFORMANCE_BENCHMARK_MATRIX_V1,
  createChatPerformanceReceiptV1,
  evaluateChatPerformanceRatchetV1,
  parseChatPerformanceReceiptV1,
  type ChatPerformanceQualityMetricsV1,
} from "./performance-ratchet.js";
import type { ResearchModelCallObservationV1 } from "../model-budget-middleware.js";

const quality: ChatPerformanceQualityMetricsV1 = {
  expectedTrajectory: true,
  exactAnchorCoveragePermille: 1_000,
  detailReadCoveragePermille: 1_000,
  citationPrecisionPermille: 1_000,
  supportedAssertionPermille: 1_000,
  wrongSourceCount: 0,
  contradictionRecallPermille: 1_000,
  relationshipRecallPermille: 1_000,
  materialGapRecallPermille: 1_000,
  falseCompletenessCount: 0,
  answerStreamingObserved: true,
};

function observation(input: Partial<ResearchModelCallObservationV1> = {}): ResearchModelCallObservationV1 {
  return {
    schema: "atlcli.research-model-call-observation/v1",
    sequence: 1,
    role: "subagent",
    status: "completed",
    durationMs: 1_000,
    middlewareName: "synthetic",
    modelName: "synthetic-model",
    modelId: "synthetic-model",
    profileId: "comparison-analyst",
    phase: "analysis",
    wave: 1,
    attempt: 1,
    preference: "balanced",
    routeRole: "analysis",
    effectivePreference: "balanced",
    thinkingMode: "adaptive-summary",
    finalizationCorridor: "standard",
    requestBytes: {
      systemBytes: 100,
      messageBytes: 200,
      toolBytes: 0,
      responseFormatBytes: 100,
      totalBytes: 400,
    },
    reservation: { inputTokens: 500, outputTokens: 200 },
    observedUsage: {
      inputTokens: 300,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 600,
      outputTokens: 100,
    },
    ...input,
  };
}

function receipt(observations: ResearchModelCallObservationV1[]) {
  return createChatPerformanceReceiptV1({
    benchmarkId: "deep-two-anchor-comparison",
    benchmarkFingerprint: "a".repeat(64),
    sample: "measured",
    mode: "deep",
    strategy: "agentic",
    modelId: "synthetic-model",
    durationMs: 10_000,
    observations,
    ptcCalls: 2,
    httpCalls: 2,
    quality,
  });
}

describe("Deep Chat performance ratchet", () => {
  test("freezes all eight benchmark trajectories and their hand-labelled quality signals", () => {
    expect(Object.keys(CHAT_PERFORMANCE_BENCHMARK_MATRIX_V1))
      .toEqual([...CHAT_PERFORMANCE_BENCHMARK_IDS_V1]);
    expect(CHAT_PERFORMANCE_BENCHMARK_MATRIX_V1["deep-explicit-contradiction"])
      .toMatchObject({ strategy: "agentic", requiredSignals: ["anchors", "citations", "contradiction"] });
    expect(CHAT_PERFORMANCE_BENCHMARK_MATRIX_V1["research-isolation-control"])
      .toMatchObject({ mode: "research", strategy: "research" });
  });

  test("aggregates body-free call, cache, byte, role, phase, and critical-path metrics", () => {
    const value = receipt([
      observation(),
      observation({ sequence: 2, profileId: "contradiction-analyst", durationMs: 1_500 }),
      observation({ sequence: 3, role: "root", profileId: undefined, phase: undefined, wave: undefined, durationMs: 500 }),
    ]);
    expect(value.metrics).toMatchObject({
      modelCalls: 3,
      inputTokens: 900,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 1_800,
      outputTokens: 300,
      modelCriticalPathMs: 2_000,
      callsByRole: { subagent: 2, root: 1 },
      callsByProfile: { "comparison-analyst": 1, "contradiction-analyst": 1 },
      callsByPhase: { analysis: 2 },
      callsByEffectiveModel: { "synthetic-model": 3 },
      callsByRoute: { analysis: 3 },
      callsByEffectivePreference: { balanced: 3 },
      callsByThinkingMode: { "adaptive-summary": 3 },
      callsByFinalizationCorridor: { standard: 3 },
    });
    expect(JSON.stringify(value)).not.toContain("prompt");
    expect(JSON.stringify(value)).not.toContain("source");
  });

  test("rejects content fields, unknown metadata, and changed benchmark fingerprints", () => {
    const value = receipt([observation()]);
    expect(() => parseChatPerformanceReceiptV1({ ...value, prompt: "private" }))
      .toThrow("receipt is invalid");
    expect(() => evaluateChatPerformanceRatchetV1(
      value,
      { ...value, benchmarkFingerprint: "b".repeat(64) },
      {
        minimumCallReduction: 0,
        minimumFreshInputReductionPermille: 0,
        minimumDurationReductionPermille: 0,
        maximumFreshInputRegressionPermille: 0,
        maximumDurationRegressionPermille: 0,
      },
    )).toThrow("same frozen benchmark");
  });

  test("fails closed on quality regression or a missed performance ceiling", () => {
    const before = receipt([observation(), observation({ sequence: 2 })]);
    const after = {
      ...receipt([observation()]),
      quality: { ...quality, citationPrecisionPermille: 900 },
      metrics: { ...receipt([observation()]).metrics, durationMs: 11_000 },
    };
    const result = evaluateChatPerformanceRatchetV1(before, after, {
      minimumCallReduction: 1,
      minimumFreshInputReductionPermille: 400,
      minimumDurationReductionPermille: 0,
      maximumFreshInputRegressionPermille: 50,
      maximumDurationRegressionPermille: 50,
    });
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain("citation precision regressed");
    expect(result.failures).toContain("duration reduction missed");
    expect(result.failures).toContain("duration regression exceeded tolerance");
  });
});
