import {
  normalizeResearchRequestV1,
  type ResearchRequestV1,
} from "../contracts.js";
import {
  RESEARCH_EVALUATION_SCHEMA_V1,
  evaluateT3DirectionalValueRuleV1,
  scoreResearchEvaluationV1,
  type ResearchEvaluationGoldV1,
  type ResearchEvaluationMetricsV1,
  type ResearchEvaluationObservationV1,
  type T3DirectionalValueDecisionV1,
} from "./evaluation.js";

export const RESEARCH_T3_COMPARISON_SCHEMA_V1 =
  "atlcli.research-t3-comparison/v1" as const;

export const RESEARCH_T3_COMPARISON_VARIANTS_V1 = [
  "S0",
  "S1",
  "S2",
  "S3",
] as const;

export type ResearchT3ComparisonVariantV1 =
  (typeof RESEARCH_T3_COMPARISON_VARIANTS_V1)[number];

/**
 * A single customer-free or private gold scenario measured by every T3
 * orchestration variant. Its request is the authoritative, normalized budget
 * envelope: a runner may not quietly change scope, limits, or provider.
 */
export interface ResearchT3ComparisonScenarioV1 {
  schema: typeof RESEARCH_T3_COMPARISON_SCHEMA_V1;
  id: string;
  request: ResearchRequestV1;
  gold: ResearchEvaluationGoldV1;
}

export interface ResearchT3ComparisonRunInputV1 {
  schema: typeof RESEARCH_T3_COMPARISON_SCHEMA_V1;
  scenarioId: string;
  variant: ResearchT3ComparisonVariantV1;
  /** A frozen clone of the normalized scenario request. */
  request: Readonly<ResearchRequestV1>;
  requestFingerprint: string;
}

/**
 * Body-free execution facts needed to prove that the requested comparison
 * variant, rather than a look-alike fixed pipeline, actually ran.
 */
export interface ResearchT3CompositionEvidenceV1 {
  execution: "single-agent" | "dynamic-graph";
  researchWorkerTaskCount: number;
  synthesizerTaskCount: number;
  reconciliation: "not-admitted" | "not-needed" | "completed";
  maxConcurrentSubagents: number;
  maxConcurrentPtcCalls: number;
  reportPublications: number;
  markdownChars: number;
}

export interface ResearchT3ComparisonRunEvidenceV1 {
  schema: typeof RESEARCH_T3_COMPARISON_SCHEMA_V1;
  scenarioId: string;
  variant: ResearchT3ComparisonVariantV1;
  /** The request the runner actually submitted to its host/runtime. */
  request: ResearchRequestV1;
  observation: ResearchEvaluationObservationV1;
  composition: ResearchT3CompositionEvidenceV1;
}

export type ResearchT3VariantRunnerV1 = (
  input: ResearchT3ComparisonRunInputV1,
) => Promise<ResearchT3ComparisonRunEvidenceV1>;

export interface ResearchT3ComparisonRunV1 {
  evidence: ResearchT3ComparisonRunEvidenceV1;
  metrics: ResearchEvaluationMetricsV1;
}

export interface ResearchT3CandidateDecisionV1 {
  variant: "S2" | "S3";
  valueAgainstS1: T3DirectionalValueDecisionV1;
  deterministicGateFailuresAgainstS0: string[];
  accepted: boolean;
}

export interface ResearchT3ComparisonResultV1 {
  schema: typeof RESEARCH_T3_COMPARISON_SCHEMA_V1;
  scenarioId: string;
  requestFingerprint: string;
  runs: Readonly<Record<ResearchT3ComparisonVariantV1, ResearchT3ComparisonRunV1>>;
  candidateDecisions: readonly ResearchT3CandidateDecisionV1[];
  recommendedDefault: "S1" | "S2" | "S3";
  decision: "go" | "hold";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid T3 comparison: ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assert(Number.isFinite(value), "request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  assert(isPlainRecord(value), "request contains a non-JSON value");
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * A stable opaque comparison identity for an exact normalized request.
 * It is a correlation fingerprint, not a cryptographic security boundary.
 */
export function researchT3RequestFingerprintV1(request: ResearchRequestV1): string {
  return fnv1a32(stableJson(request));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function assertNonNegativeInteger(value: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

function assertNonNegativeFinite(value: number, label: string): void {
  assert(Number.isFinite(value) && value >= 0, `${label} must be a non-negative finite number`);
}

function assertRatio(value: number, label: string): void {
  assertNonNegativeFinite(value, label);
  assert(value <= 1, `${label} must be at most one`);
}

function assertMetrics(
  metrics: ResearchEvaluationMetricsV1,
  request: ResearchRequestV1,
): void {
  assert(metrics.schema === RESEARCH_EVALUATION_SCHEMA_V1, "metrics schema differs");
  for (const [label, value] of Object.entries({
    sourceRecall: metrics.sourceRecall,
    sourceCoverage: metrics.sourceCoverage,
    detailCoverage: metrics.detailCoverage,
    citationPrecision: metrics.citationPrecision,
    supportedClaimRecall: metrics.supportedClaimRecall,
    verifiedRelationshipPrecision: metrics.verifiedRelationshipPrecision,
    abstentionCorrectness: metrics.abstentionCorrectness,
    completeness: metrics.completeness,
    branchCoverage: metrics.branchCoverage,
    promptInjectionSuccess: metrics.promptInjectionSuccess,
    scopeResolutionPrecision: metrics.scopeResolutionPrecision,
    scopeResolutionRecall: metrics.scopeResolutionRecall,
    catalogCompleteness: metrics.catalogCompleteness,
  })) assertRatio(value, label);
  for (const [label, value] of Object.entries({
    unsupportedClaims: metrics.unsupportedClaims,
    duplicateWork: metrics.duplicateWork,
    falseAutoResolution: metrics.falseAutoResolution,
    unnecessaryScopeExpansionProposals: metrics.unnecessaryScopeExpansionProposals,
    modelCalls: metrics.calls.model,
    ptcCalls: metrics.calls.ptc,
    httpCalls: metrics.calls.http,
    totalCalls: metrics.calls.total,
    modelInputBytes: metrics.bytes.modelInput,
    modelOutputBytes: metrics.bytes.modelOutput,
    providerResponseBytes: metrics.bytes.providerResponse,
    totalBytes: metrics.bytes.total,
    modelInputTokens: metrics.tokens.modelInput,
    modelOutputTokens: metrics.tokens.modelOutput,
    totalTokens: metrics.tokens.total,
    medianLatencyMs: metrics.medianLatencyMs,
    medianModelCostUsd: metrics.medianModelCostUsd,
    peakSupervisorContextTokens: metrics.peakSupervisorContextTokens,
    peakSupervisorContextBytes: metrics.peakSupervisorContextBytes,
  })) assertNonNegativeFinite(value, label);
  assert(metrics.calls.ptc <= request.limits.maxPtcCalls, "PTC budget exceeded");
  assert(metrics.calls.http <= request.limits.maxHttpCalls, "HTTP budget exceeded");
  assert(
    metrics.tokens.modelInput <= request.limits.maxModelInputTokens,
    "model input token budget exceeded",
  );
  assert(
    metrics.tokens.modelOutput <= request.limits.maxModelOutputTokens,
    "model output token budget exceeded",
  );
  assert(metrics.medianLatencyMs <= request.limits.maxRunMs, "run deadline exceeded");
  assert(
    metrics.peakSupervisorContextTokens <= request.limits.maxModelInputTokens,
    "supervisor context token ceiling exceeded",
  );
}

function assertComposition(
  variant: ResearchT3ComparisonVariantV1,
  composition: ResearchT3CompositionEvidenceV1,
  request: ResearchRequestV1,
): void {
  for (const [label, value] of Object.entries({
    researchWorkerTaskCount: composition.researchWorkerTaskCount,
    synthesizerTaskCount: composition.synthesizerTaskCount,
    maxConcurrentSubagents: composition.maxConcurrentSubagents,
    maxConcurrentPtcCalls: composition.maxConcurrentPtcCalls,
    reportPublications: composition.reportPublications,
    markdownChars: composition.markdownChars,
  })) assertNonNegativeInteger(value, label);
  assert(
    composition.maxConcurrentPtcCalls <= request.limits.maxConcurrentCalls,
    "PTC concurrency ceiling exceeded",
  );
  assert(composition.markdownChars <= request.limits.maxReportChars, "report size ceiling exceeded");
  assert(composition.reportPublications === 1, "each variant must publish exactly one report");

  if (variant === "S0") {
    assert(composition.execution === "single-agent", "S0 must use the single-agent path");
    assert(composition.researchWorkerTaskCount === 0, "S0 must not dispatch workers");
    assert(composition.synthesizerTaskCount === 0, "S0 must not dispatch a synthesizer task");
    assert(composition.reconciliation === "not-admitted", "S0 must not admit reconciliation");
    return;
  }

  assert(composition.execution === "dynamic-graph", `${variant} must use a dynamic graph`);
  assert(composition.synthesizerTaskCount === 1, `${variant} must dispatch one synthesizer`);
  if (variant === "S1") {
    assert(composition.researchWorkerTaskCount === 1, "S1 must dispatch one worker");
    assert(composition.reconciliation === "not-admitted", "S1 must not admit reconciliation");
    return;
  }

  assert(composition.researchWorkerTaskCount >= 2, `${variant} must dispatch bounded subagents`);
  if (variant === "S2") {
    assert(composition.reconciliation === "not-admitted", "S2 must not admit reconciliation");
  } else {
    assert(
      composition.reconciliation === "not-needed" || composition.reconciliation === "completed",
      "S3 must evaluate conditional reconciliation",
    );
  }
}

function normalizeScenarioRequest(scenario: ResearchT3ComparisonScenarioV1): ResearchRequestV1 {
  assert(scenario.schema === RESEARCH_T3_COMPARISON_SCHEMA_V1, "scenario schema differs");
  assert(scenario.id.trim().length > 0, "scenario id is blank");
  assert(scenario.gold.schema === RESEARCH_EVALUATION_SCHEMA_V1, "gold schema differs");
  const normalized = normalizeResearchRequestV1(scenario.request);
  assert(
    stableJson(normalized) === stableJson(scenario.request),
    "scenario request is not normalized",
  );
  return normalized;
}

function validateRun(
  scenario: ResearchT3ComparisonScenarioV1,
  variant: ResearchT3ComparisonVariantV1,
  request: ResearchRequestV1,
  evidence: ResearchT3ComparisonRunEvidenceV1,
): ResearchT3ComparisonRunV1 {
  assert(evidence.schema === RESEARCH_T3_COMPARISON_SCHEMA_V1, `${variant} run schema differs`);
  assert(evidence.scenarioId === scenario.id, `${variant} run has a foreign scenario id`);
  assert(evidence.variant === variant, `${variant} runner returned a different variant`);
  const executedRequest = normalizeResearchRequestV1(evidence.request);
  assert(
    stableJson(executedRequest) === stableJson(request),
    `${variant} changed scope, budget, or provider`,
  );
  const metrics = scoreResearchEvaluationV1(scenario.gold, evidence.observation);
  assertMetrics(metrics, request);
  assertComposition(variant, evidence.composition, request);
  return { evidence, metrics };
}

/**
 * Runs the four variants serially against one frozen, normalized scenario.
 * Serial execution is intentional: equal-budget real-provider measurements
 * must not influence each other through concurrent rate limits or index state.
 */
export async function runResearchT3ComparisonV1(input: {
  scenario: ResearchT3ComparisonScenarioV1;
  runners: Readonly<Record<ResearchT3ComparisonVariantV1, ResearchT3VariantRunnerV1>>;
}): Promise<ResearchT3ComparisonResultV1> {
  const request = normalizeScenarioRequest(input.scenario);
  const requestFingerprint = researchT3RequestFingerprintV1(request);
  const runs = {} as Record<ResearchT3ComparisonVariantV1, ResearchT3ComparisonRunV1>;
  for (const variant of RESEARCH_T3_COMPARISON_VARIANTS_V1) {
    const runner = input.runners[variant];
    assert(typeof runner === "function", `missing ${variant} runner`);
    const runnerInput = deepFreeze({
      schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
      scenarioId: input.scenario.id,
      variant,
      request: cloneJson(request),
      requestFingerprint,
    });
    const evidence = await runner(runnerInput);
    runs[variant] = validateRun(
      input.scenario,
      variant,
      request,
      evidence,
    );
  }

  const s0 = runs.S0!.metrics;
  const s1 = runs.S1!.metrics;
  const candidateDecisions = (["S2", "S3"] as const).map((variant) => {
    const candidate = runs[variant]!.metrics;
    const valueAgainstS1 = evaluateT3DirectionalValueRuleV1(s1, candidate);
    const deterministicGateFailuresAgainstS0 =
      evaluateT3DirectionalValueRuleV1(s0, candidate).deterministicGateFailures;
    return {
      variant,
      valueAgainstS1,
      deterministicGateFailuresAgainstS0,
      accepted:
        valueAgainstS1.accepted && deterministicGateFailuresAgainstS0.length === 0,
    } satisfies ResearchT3CandidateDecisionV1;
  });
  const acceptedS3 = candidateDecisions.find((decision) => decision.variant === "S3")!;
  const acceptedS2 = candidateDecisions.find((decision) => decision.variant === "S2")!;
  const recommendedDefault = acceptedS3.accepted
    ? "S3"
    : acceptedS2.accepted
      ? "S2"
      : "S1";

  return {
    schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
    scenarioId: input.scenario.id,
    requestFingerprint,
    runs,
    candidateDecisions,
    recommendedDefault,
    decision: recommendedDefault === "S1" ? "hold" : "go",
  };
}
