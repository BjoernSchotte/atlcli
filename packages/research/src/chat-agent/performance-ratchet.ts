import { ResearchContractError } from "../contracts.js";
import type { ResearchModelCallObservationV1 } from "../model-budget-middleware.js";

export const CHAT_PERFORMANCE_RECEIPT_SCHEMA_V1 =
  "atlcli.chat-performance-receipt/v1" as const;

export const CHAT_PERFORMANCE_BENCHMARK_IDS_V1 = [
  "deep-single-anchor",
  "deep-two-anchor-comparison",
  "deep-explicit-contradiction",
  "deep-cross-product-relationship",
  "deep-quality-repair",
  "deep-follow-up-reuse",
  "auto-simple-control",
  "research-isolation-control",
] as const;

export type ChatPerformanceBenchmarkIdV1 =
  (typeof CHAT_PERFORMANCE_BENCHMARK_IDS_V1)[number];

export const CHAT_PERFORMANCE_BENCHMARK_MATRIX_V1: Readonly<Record<
  ChatPerformanceBenchmarkIdV1,
  {
    mode: "auto" | "deep" | "research";
    strategy: "direct" | "agentic" | "research";
    requiredSignals: readonly (
      | "anchors"
      | "citations"
      | "contradiction"
      | "relationship"
      | "repair"
      | "reuse"
      | "report-isolation"
    )[];
  }
>> = Object.freeze({
  "deep-single-anchor": { mode: "deep", strategy: "direct", requiredSignals: ["anchors", "citations"] },
  "deep-two-anchor-comparison": { mode: "deep", strategy: "agentic", requiredSignals: ["anchors", "citations"] },
  "deep-explicit-contradiction": { mode: "deep", strategy: "agentic", requiredSignals: ["anchors", "citations", "contradiction"] },
  "deep-cross-product-relationship": { mode: "deep", strategy: "agentic", requiredSignals: ["anchors", "citations", "relationship"] },
  "deep-quality-repair": { mode: "deep", strategy: "agentic", requiredSignals: ["anchors", "citations", "repair"] },
  "deep-follow-up-reuse": { mode: "deep", strategy: "agentic", requiredSignals: ["anchors", "citations", "reuse"] },
  "auto-simple-control": { mode: "auto", strategy: "direct", requiredSignals: ["anchors", "citations"] },
  "research-isolation-control": { mode: "research", strategy: "research", requiredSignals: ["report-isolation"] },
});

export interface ChatPerformanceQualityMetricsV1 {
  expectedTrajectory: boolean;
  exactAnchorCoveragePermille: number;
  detailReadCoveragePermille: number;
  citationPrecisionPermille: number;
  supportedAssertionPermille: number;
  wrongSourceCount: number;
  contradictionRecallPermille: number;
  relationshipRecallPermille: number;
  materialGapRecallPermille: number;
  falseCompletenessCount: number;
  answerStreamingObserved: boolean;
}

export interface ChatPerformanceMetricsV1 {
  durationMs: number;
  modelCriticalPathMs: number;
  exactReaderPrimaryMs: number;
  exactReaderRecoveryMs: number;
  modelCalls: number;
  failedModelCalls: number;
  unresolvedReservations: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  requestBytes: {
    system: number;
    messages: number;
    tools: number;
    responseFormat: number;
    total: number;
  };
  ptcCalls: number;
  httpCalls: number;
  callsByRole: Record<string, number>;
  callsByProfile: Record<string, number>;
  callsByPhase: Record<string, number>;
  callsByEffectiveModel: Record<string, number>;
  callsByRoute: Record<string, number>;
  callsByEffectivePreference: Record<string, number>;
  callsByThinkingMode: Record<string, number>;
  callsByFinalizationCorridor: Record<string, number>;
}

export interface ChatPerformanceReceiptV1 {
  schema: typeof CHAT_PERFORMANCE_RECEIPT_SCHEMA_V1;
  benchmarkId: ChatPerformanceBenchmarkIdV1;
  benchmarkFingerprint: string;
  sample: "warmup" | "measured";
  mode: "quick" | "auto" | "deep" | "research";
  strategy: "direct" | "agentic" | "research";
  modelId: string;
  metrics: ChatPerformanceMetricsV1;
  quality: ChatPerformanceQualityMetricsV1;
}

export interface ChatPerformanceRatchetPolicyV1 {
  minimumCallReduction: number;
  minimumFreshInputReductionPermille: number;
  minimumDurationReductionPermille: number;
  maximumFreshInputRegressionPermille: number;
  maximumDurationRegressionPermille: number;
}

export interface ChatPerformanceRatchetResultV1 {
  accepted: boolean;
  failures: string[];
  changes: {
    modelCalls: number;
    freshInputPermille: number;
    durationPermille: number;
  };
}

/**
 * Frozen release ceilings for the fixed two-anchor Deep Chat benchmark. Cache
 * reads use Anthropic's current five-minute prompt-cache multiplier only as a
 * stable comparison metric; this is not an invoice or a provider contract.
 */
export const CHAT_DEEP_FINAL_CEILINGS_V1 = Object.freeze({
  measuredSamples: 3,
  maximumModelCallsWithoutRepair: 10,
  maximumModelCallsWithRepair: 11,
  maximumBilledEquivalentInputTokens: 120_000,
  maximumFreshInputTokens: 109_756,
  maximumOutputTokens: 15_000,
  maximumMedianDurationMs: 120_000,
  maximumWorstDurationMs: 180_000,
  maximumHttpCalls: 2,
  requiredCoveragePermille: 1_000,
  maximumWrongSourceCount: 0,
  maximumFalseCompletenessCount: 0,
} as const);

export interface ChatDeepFinalCeilingResultV1 {
  accepted: boolean;
  failures: string[];
  medianDurationMs: number;
  worstDurationMs: number;
  maximumFreshInputTokens: number;
  maximumBilledEquivalentInputTokens: number;
  maximumOutputTokens: number;
  maximumModelCalls: number;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return value as number;
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return record;
}

function countMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!SAFE_ID.test(key)) {
      throw new ResearchContractError("invalid-request", `${label} is invalid.`);
    }
    output[key] = integer(count, label);
  }
  return output;
}

function qualityMetrics(value: unknown): ChatPerformanceQualityMetricsV1 {
  const record = strictRecord(value, [
    "expectedTrajectory",
    "exactAnchorCoveragePermille",
    "detailReadCoveragePermille",
    "citationPrecisionPermille",
    "supportedAssertionPermille",
    "wrongSourceCount",
    "contradictionRecallPermille",
    "relationshipRecallPermille",
    "materialGapRecallPermille",
    "falseCompletenessCount",
    "answerStreamingObserved",
  ], "Chat performance quality metrics");
  if (typeof record.expectedTrajectory !== "boolean" ||
      typeof record.answerStreamingObserved !== "boolean") {
    throw new ResearchContractError("invalid-request", "Chat performance quality metrics are invalid.");
  }
  return {
    expectedTrajectory: record.expectedTrajectory,
    exactAnchorCoveragePermille: integer(record.exactAnchorCoveragePermille, "Exact-anchor coverage", 1_000),
    detailReadCoveragePermille: integer(record.detailReadCoveragePermille, "Detail-read coverage", 1_000),
    citationPrecisionPermille: integer(record.citationPrecisionPermille, "Citation precision", 1_000),
    supportedAssertionPermille: integer(record.supportedAssertionPermille, "Supported-assertion score", 1_000),
    wrongSourceCount: integer(record.wrongSourceCount, "Wrong-source count"),
    contradictionRecallPermille: integer(record.contradictionRecallPermille, "Contradiction recall", 1_000),
    relationshipRecallPermille: integer(record.relationshipRecallPermille, "Relationship recall", 1_000),
    materialGapRecallPermille: integer(record.materialGapRecallPermille, "Material-gap recall", 1_000),
    falseCompletenessCount: integer(record.falseCompletenessCount, "False-completeness count"),
    answerStreamingObserved: record.answerStreamingObserved,
  };
}

export function parseChatPerformanceReceiptV1(value: unknown): ChatPerformanceReceiptV1 {
  const record = strictRecord(value, [
    "schema", "benchmarkId", "benchmarkFingerprint", "sample", "mode", "strategy",
    "modelId", "metrics", "quality",
  ], "Chat performance receipt");
  if (record.schema !== CHAT_PERFORMANCE_RECEIPT_SCHEMA_V1 ||
      !CHAT_PERFORMANCE_BENCHMARK_IDS_V1.includes(record.benchmarkId as ChatPerformanceBenchmarkIdV1) ||
      typeof record.benchmarkFingerprint !== "string" || !SHA256.test(record.benchmarkFingerprint) ||
      (record.sample !== "warmup" && record.sample !== "measured") ||
      !["quick", "auto", "deep", "research"].includes(String(record.mode)) ||
      !["direct", "agentic", "research"].includes(String(record.strategy)) ||
      typeof record.modelId !== "string" || !SAFE_ID.test(record.modelId)) {
    throw new ResearchContractError("invalid-request", "Chat performance receipt is invalid.");
  }
  const metrics = strictRecord(record.metrics, [
    "durationMs", "modelCriticalPathMs", "exactReaderPrimaryMs", "exactReaderRecoveryMs",
    "modelCalls", "failedModelCalls", "unresolvedReservations", "inputTokens",
    "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens", "requestBytes",
    "ptcCalls", "httpCalls", "callsByRole", "callsByProfile", "callsByPhase",
    "callsByEffectiveModel", "callsByRoute", "callsByEffectivePreference",
    "callsByThinkingMode", "callsByFinalizationCorridor",
  ], "Chat performance metrics");
  const bytes = strictRecord(metrics.requestBytes, [
    "system", "messages", "tools", "responseFormat", "total",
  ], "Chat performance request bytes");
  return {
    schema: CHAT_PERFORMANCE_RECEIPT_SCHEMA_V1,
    benchmarkId: record.benchmarkId as ChatPerformanceBenchmarkIdV1,
    benchmarkFingerprint: record.benchmarkFingerprint,
    sample: record.sample as "warmup" | "measured",
    mode: record.mode as ChatPerformanceReceiptV1["mode"],
    strategy: record.strategy as ChatPerformanceReceiptV1["strategy"],
    modelId: record.modelId,
    metrics: {
      durationMs: integer(metrics.durationMs, "Duration"),
      modelCriticalPathMs: integer(metrics.modelCriticalPathMs, "Model critical path"),
      exactReaderPrimaryMs: integer(metrics.exactReaderPrimaryMs, "Exact-reader primary duration"),
      exactReaderRecoveryMs: integer(metrics.exactReaderRecoveryMs, "Exact-reader recovery duration"),
      modelCalls: integer(metrics.modelCalls, "Model call count"),
      failedModelCalls: integer(metrics.failedModelCalls, "Failed model call count"),
      unresolvedReservations: integer(metrics.unresolvedReservations, "Unresolved reservation count"),
      inputTokens: integer(metrics.inputTokens, "Fresh input tokens"),
      cacheCreationInputTokens: integer(metrics.cacheCreationInputTokens, "Cache creation input tokens"),
      cacheReadInputTokens: integer(metrics.cacheReadInputTokens, "Cache read input tokens"),
      outputTokens: integer(metrics.outputTokens, "Output tokens"),
      requestBytes: {
        system: integer(bytes.system, "System bytes"),
        messages: integer(bytes.messages, "Message bytes"),
        tools: integer(bytes.tools, "Tool bytes"),
        responseFormat: integer(bytes.responseFormat, "Response format bytes"),
        total: integer(bytes.total, "Total request bytes"),
      },
      ptcCalls: integer(metrics.ptcCalls, "PTC call count"),
      httpCalls: integer(metrics.httpCalls, "HTTP call count"),
      callsByRole: countMap(metrics.callsByRole, "Call role map"),
      callsByProfile: countMap(metrics.callsByProfile, "Call profile map"),
      callsByPhase: countMap(metrics.callsByPhase, "Call phase map"),
      callsByEffectiveModel: countMap(metrics.callsByEffectiveModel, "Effective model map"),
      callsByRoute: countMap(metrics.callsByRoute, "Model route map"),
      callsByEffectivePreference: countMap(
        metrics.callsByEffectivePreference,
        "Effective preference map",
      ),
      callsByThinkingMode: countMap(metrics.callsByThinkingMode, "Thinking mode map"),
      callsByFinalizationCorridor: countMap(
        metrics.callsByFinalizationCorridor,
        "Finalization corridor map",
      ),
    },
    quality: qualityMetrics(record.quality),
  };
}

function increment(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function sumByWave(observations: readonly ResearchModelCallObservationV1[]): number {
  const sequential = observations.filter((observation) => observation.wave === undefined)
    .reduce((sum, observation) => sum + observation.durationMs, 0);
  const waves = new Map<number, number>();
  for (const observation of observations) {
    if (observation.wave === undefined) continue;
    waves.set(observation.wave, Math.max(waves.get(observation.wave) ?? 0, observation.durationMs));
  }
  return sequential + [...waves.values()].reduce((sum, duration) => sum + duration, 0);
}

export function createChatPerformanceReceiptV1(input: {
  benchmarkId: ChatPerformanceBenchmarkIdV1;
  benchmarkFingerprint: string;
  sample: "warmup" | "measured";
  mode: ChatPerformanceReceiptV1["mode"];
  strategy: ChatPerformanceReceiptV1["strategy"];
  modelId: string;
  durationMs: number;
  observations: readonly ResearchModelCallObservationV1[];
  ptcCalls: number;
  httpCalls: number;
  quality: ChatPerformanceQualityMetricsV1;
}): ChatPerformanceReceiptV1 {
  const callsByRole: Record<string, number> = {};
  const callsByProfile: Record<string, number> = {};
  const callsByPhase: Record<string, number> = {};
  const callsByEffectiveModel: Record<string, number> = {};
  const callsByRoute: Record<string, number> = {};
  const callsByEffectivePreference: Record<string, number> = {};
  const callsByThinkingMode: Record<string, number> = {};
  const callsByFinalizationCorridor: Record<string, number> = {};
  const requestBytes = { system: 0, messages: 0, tools: 0, responseFormat: 0, total: 0 };
  let inputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;
  for (const observation of input.observations) {
    increment(callsByRole, observation.role);
    increment(callsByProfile, observation.profileId);
    increment(callsByPhase, observation.phase);
    increment(callsByEffectiveModel, observation.modelId);
    increment(callsByRoute, observation.routeRole);
    increment(callsByEffectivePreference, observation.effectivePreference);
    increment(callsByThinkingMode, observation.thinkingMode);
    increment(callsByFinalizationCorridor, observation.finalizationCorridor);
    inputTokens += observation.observedUsage?.inputTokens ?? 0;
    cacheCreationInputTokens += observation.observedUsage?.cacheCreationInputTokens ?? 0;
    cacheReadInputTokens += observation.observedUsage?.cacheReadInputTokens ?? 0;
    outputTokens += observation.observedUsage?.outputTokens ?? 0;
    requestBytes.system += observation.requestBytes.systemBytes;
    requestBytes.messages += observation.requestBytes.messageBytes;
    requestBytes.tools += observation.requestBytes.toolBytes;
    requestBytes.responseFormat += observation.requestBytes.responseFormatBytes;
    requestBytes.total += observation.requestBytes.totalBytes;
  }
  return parseChatPerformanceReceiptV1({
    schema: CHAT_PERFORMANCE_RECEIPT_SCHEMA_V1,
    benchmarkId: input.benchmarkId,
    benchmarkFingerprint: input.benchmarkFingerprint,
    sample: input.sample,
    mode: input.mode,
    strategy: input.strategy,
    modelId: input.modelId,
    metrics: {
      durationMs: Math.round(input.durationMs),
      modelCriticalPathMs: sumByWave(input.observations),
      exactReaderPrimaryMs: input.observations
        .filter((observation) => observation.role === "subagent" && observation.profileId === "exact-context-reader")
        .reduce((sum, observation) => sum + observation.durationMs, 0),
      exactReaderRecoveryMs: input.observations
        .filter((observation) => observation.role === "recovery")
        .reduce((sum, observation) => sum + observation.durationMs, 0),
      modelCalls: input.observations.length,
      failedModelCalls: input.observations.filter((observation) => observation.status === "failed").length,
      unresolvedReservations: input.observations.filter((observation) => observation.status === "failed").length,
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      requestBytes,
      ptcCalls: input.ptcCalls,
      httpCalls: input.httpCalls,
      callsByRole,
      callsByProfile,
      callsByPhase,
      callsByEffectiveModel,
      callsByRoute,
      callsByEffectivePreference,
      callsByThinkingMode,
      callsByFinalizationCorridor,
    },
    quality: input.quality,
  });
}

function changePermille(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 1_000;
  return Math.round(((before - after) * 1_000) / before);
}

function billedEquivalentInputTokens(receipt: ChatPerformanceReceiptV1): number {
  return receipt.metrics.inputTokens +
    Math.round(receipt.metrics.cacheCreationInputTokens * 1.25) +
    Math.round(receipt.metrics.cacheReadInputTokens * 0.1);
}

/**
 * Release-blocking final gate for the three measured fixed-comparison samples.
 * It is deliberately independent from the per-slice before/after evaluator so
 * an accepted historical improvement cannot hide a later absolute regression.
 */
export function evaluateChatDeepFinalCeilingsV1(
  values: readonly unknown[],
): ChatDeepFinalCeilingResultV1 {
  const receipts = values.map(parseChatPerformanceReceiptV1);
  if (receipts.length !== CHAT_DEEP_FINAL_CEILINGS_V1.measuredSamples ||
      receipts.some((receipt) =>
        receipt.benchmarkId !== "deep-two-anchor-comparison" ||
        receipt.mode !== "deep" ||
        receipt.strategy !== "agentic" ||
        receipt.sample !== "measured"
      ) ||
      new Set(receipts.map((receipt) => receipt.benchmarkFingerprint)).size !== 1 ||
      new Set(receipts.map((receipt) => receipt.modelId)).size !== 1) {
    throw new ResearchContractError(
      "invalid-request",
      "Deep Chat final receipts do not describe three measured samples of the same fixed comparison.",
    );
  }

  const failures: string[] = [];
  const durations = receipts.map((receipt) => receipt.metrics.durationMs)
    .sort((left, right) => left - right);
  const medianDurationMs = durations[1]!;
  const worstDurationMs = durations[2]!;
  const maximumFreshInputTokens = Math.max(...receipts.map((receipt) =>
    receipt.metrics.inputTokens
  ));
  const maximumBilledEquivalentInputTokens = Math.max(...receipts.map(
    billedEquivalentInputTokens,
  ));
  const maximumOutputTokens = Math.max(...receipts.map((receipt) =>
    receipt.metrics.outputTokens
  ));
  const maximumModelCalls = Math.max(...receipts.map((receipt) => receipt.metrics.modelCalls));

  for (const [index, receipt] of receipts.entries()) {
    const repairAdmitted = (receipt.metrics.callsByProfile["answer-repairer"] ?? 0) > 0;
    const modelCallCeiling = repairAdmitted
      ? CHAT_DEEP_FINAL_CEILINGS_V1.maximumModelCallsWithRepair
      : CHAT_DEEP_FINAL_CEILINGS_V1.maximumModelCallsWithoutRepair;
    if (receipt.metrics.modelCalls > modelCallCeiling) {
      failures.push(`sample ${index + 1} model-call ceiling exceeded`);
    }
    if (receipt.metrics.httpCalls > CHAT_DEEP_FINAL_CEILINGS_V1.maximumHttpCalls) {
      failures.push(`sample ${index + 1} direct-read ceiling exceeded`);
    }
    if (!receipt.quality.expectedTrajectory) {
      failures.push(`sample ${index + 1} expected trajectory failed`);
    }
    if (!receipt.quality.answerStreamingObserved) {
      failures.push(`sample ${index + 1} answer streaming failed`);
    }
    const qualityFloors: Array<[number, string]> = [
      [receipt.quality.exactAnchorCoveragePermille, "exact-anchor coverage"],
      [receipt.quality.detailReadCoveragePermille, "detail-read coverage"],
      [receipt.quality.citationPrecisionPermille, "citation precision"],
      [receipt.quality.supportedAssertionPermille, "supported-assertion score"],
      [receipt.quality.contradictionRecallPermille, "contradiction recall"],
      [receipt.quality.relationshipRecallPermille, "relationship recall"],
      [receipt.quality.materialGapRecallPermille, "material-gap recall"],
    ];
    for (const [value, label] of qualityFloors) {
      if (value < CHAT_DEEP_FINAL_CEILINGS_V1.requiredCoveragePermille) {
        failures.push(`sample ${index + 1} ${label} below floor`);
      }
    }
    if (receipt.quality.wrongSourceCount > CHAT_DEEP_FINAL_CEILINGS_V1.maximumWrongSourceCount) {
      failures.push(`sample ${index + 1} wrong-source ceiling exceeded`);
    }
    if (receipt.quality.falseCompletenessCount >
        CHAT_DEEP_FINAL_CEILINGS_V1.maximumFalseCompletenessCount) {
      failures.push(`sample ${index + 1} false-completeness ceiling exceeded`);
    }
  }
  if (maximumFreshInputTokens > CHAT_DEEP_FINAL_CEILINGS_V1.maximumFreshInputTokens) {
    failures.push("fresh-input ceiling exceeded");
  }
  if (maximumBilledEquivalentInputTokens >
      CHAT_DEEP_FINAL_CEILINGS_V1.maximumBilledEquivalentInputTokens) {
    failures.push("billed-equivalent input ceiling exceeded");
  }
  if (maximumOutputTokens > CHAT_DEEP_FINAL_CEILINGS_V1.maximumOutputTokens) {
    failures.push("output ceiling exceeded");
  }
  if (medianDurationMs > CHAT_DEEP_FINAL_CEILINGS_V1.maximumMedianDurationMs) {
    failures.push("median-duration ceiling exceeded");
  }
  if (worstDurationMs > CHAT_DEEP_FINAL_CEILINGS_V1.maximumWorstDurationMs) {
    failures.push("worst-duration ceiling exceeded");
  }

  return {
    accepted: failures.length === 0,
    failures,
    medianDurationMs,
    worstDurationMs,
    maximumFreshInputTokens,
    maximumBilledEquivalentInputTokens,
    maximumOutputTokens,
    maximumModelCalls,
  };
}

export function evaluateChatPerformanceRatchetV1(
  beforeValue: unknown,
  afterValue: unknown,
  policy: ChatPerformanceRatchetPolicyV1,
): ChatPerformanceRatchetResultV1 {
  const before = parseChatPerformanceReceiptV1(beforeValue);
  const after = parseChatPerformanceReceiptV1(afterValue);
  if (before.benchmarkId !== after.benchmarkId ||
      before.benchmarkFingerprint !== after.benchmarkFingerprint ||
      before.mode !== after.mode || before.modelId !== after.modelId) {
    throw new ResearchContractError(
      "invalid-request",
      "Chat performance receipts do not describe the same frozen benchmark.",
    );
  }
  const failures: string[] = [];
  const qualityFloors: Array<[keyof ChatPerformanceQualityMetricsV1, string]> = [
    ["exactAnchorCoveragePermille", "exact-anchor coverage"],
    ["detailReadCoveragePermille", "detail-read coverage"],
    ["citationPrecisionPermille", "citation precision"],
    ["supportedAssertionPermille", "supported-assertion score"],
    ["contradictionRecallPermille", "contradiction recall"],
    ["relationshipRecallPermille", "relationship recall"],
    ["materialGapRecallPermille", "material-gap recall"],
  ];
  for (const [key, label] of qualityFloors) {
    if ((after.quality[key] as number) < (before.quality[key] as number)) {
      failures.push(`${label} regressed`);
    }
  }
  if (!after.quality.expectedTrajectory) failures.push("expected trajectory failed");
  if (!after.quality.answerStreamingObserved) failures.push("answer streaming was not observed");
  if (after.quality.wrongSourceCount > before.quality.wrongSourceCount) failures.push("wrong-source count regressed");
  if (after.quality.falseCompletenessCount > before.quality.falseCompletenessCount) failures.push("false completeness regressed");

  const changes = {
    modelCalls: before.metrics.modelCalls - after.metrics.modelCalls,
    freshInputPermille: changePermille(before.metrics.inputTokens, after.metrics.inputTokens),
    durationPermille: changePermille(before.metrics.durationMs, after.metrics.durationMs),
  };
  if (changes.modelCalls < policy.minimumCallReduction) failures.push("model-call reduction missed");
  if (changes.freshInputPermille < policy.minimumFreshInputReductionPermille) failures.push("fresh-input reduction missed");
  if (changes.durationPermille < policy.minimumDurationReductionPermille) failures.push("duration reduction missed");
  if (changes.freshInputPermille < -policy.maximumFreshInputRegressionPermille) failures.push("fresh-input regression exceeded tolerance");
  if (changes.durationPermille < -policy.maximumDurationRegressionPermille) failures.push("duration regression exceeded tolerance");
  return { accepted: failures.length === 0, failures, changes };
}
