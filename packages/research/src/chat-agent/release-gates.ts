import {
  CHAT_EVALUATION_SCHEMA_V1,
  chatEvaluationScenarioFingerprintV1,
  normalizeChatEvaluationObservationV1,
  scoreChatEvaluationV1,
  type ChatEvaluationMetricsV1,
  type ChatEvaluationScenarioV1,
  type ChatReleaseEvaluationComparisonResultV1,
  type ChatReleaseEvaluationVariantV1,
} from "./evaluation.js";

export const CHAT_RELEASE_GATE_SCHEMA_V1 =
  "atlcli.chat-release-gate/v1" as const;

/**
 * Model judges are intentionally absent from blocking evidence. A future judge
 * remains diagnostic until a separately reviewed hand-labelled calibration
 * establishes acceptable agreement, error, and confusion thresholds.
 */
export const CHAT_RELEASE_MODEL_JUDGE_POLICY_V1 =
  "diagnostic-only-after-reviewed-calibration" as const;

export interface ChatReleaseGatePolicyV1 {
  schema: typeof CHAT_RELEASE_GATE_SCHEMA_V1;
  minimumExactContextQuality: number;
  minimumAutoQualityGainOverLegacy: number;
  minimumDeepComplexQualityGainOverQuick: number;
  maximumDeepSimpleQualityRegression: number;
}

export const DEFAULT_CHAT_RELEASE_GATE_POLICY_V1 = Object.freeze({
  schema: CHAT_RELEASE_GATE_SCHEMA_V1,
  minimumExactContextQuality: 0.9,
  minimumAutoQualityGainOverLegacy: 0.05,
  minimumDeepComplexQualityGainOverQuick: 0.05,
  maximumDeepSimpleQualityRegression: 0,
} satisfies ChatReleaseGatePolicyV1);

export type ChatReleaseGateFailureCodeV1 =
  | "comparison-identity-invalid"
  | "wrong-source"
  | "unsupported-assertion"
  | "false-completeness"
  | "outcome-incorrect"
  | "strategy-incorrect"
  | "exact-context-quality"
  | "citation-precision"
  | "source-recall"
  | "detail-recall"
  | "relationship-recall"
  | "gap-recall"
  | "auto-not-better-than-legacy"
  | "deep-not-better-on-complex"
  | "deep-regressed-on-simple";

export interface ChatReleaseGateFailureV1 {
  code: ChatReleaseGateFailureCodeV1;
  scenarioIds: string[];
}

export interface ChatReleaseGateResultV1 {
  schema: typeof CHAT_RELEASE_GATE_SCHEMA_V1;
  passed: boolean;
  modelJudgePolicy: typeof CHAT_RELEASE_MODEL_JUDGE_POLICY_V1;
  scenarioCount: number;
  simpleScenarioCount: number;
  complexScenarioCount: number;
  failures: ChatReleaseGateFailureV1[];
  aggregate: {
    legacyQuality: number;
    autoQuality: number;
    quickSimpleQuality: number;
    deepSimpleQuality: number;
    quickComplexQuality: number;
    deepComplexQuality: number;
  };
}

const CHAT_VARIANTS = ["quick", "auto", "deep"] as const;

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 1
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addFailure(
  failures: Map<ChatReleaseGateFailureCodeV1, Set<string>>,
  code: ChatReleaseGateFailureCodeV1,
  scenarioId: string,
): void {
  const scenarios = failures.get(code) ?? new Set<string>();
  scenarios.add(scenarioId);
  failures.set(code, scenarios);
}

function metricsFor(
  scenario: ChatEvaluationScenarioV1,
  comparison: ChatReleaseEvaluationComparisonResultV1,
  variant: ChatReleaseEvaluationVariantV1,
): ChatEvaluationMetricsV1 {
  const observation = normalizeChatEvaluationObservationV1(
    comparison.runs[variant].observation,
    scenario,
  );
  return scoreChatEvaluationV1(scenario, observation);
}

function normalizedPolicy(
  policy: ChatReleaseGatePolicyV1,
): ChatReleaseGatePolicyV1 {
  if (
    policy.schema !== CHAT_RELEASE_GATE_SCHEMA_V1 ||
    [
      policy.minimumExactContextQuality,
      policy.minimumAutoQualityGainOverLegacy,
      policy.minimumDeepComplexQualityGainOverQuick,
      policy.maximumDeepSimpleQualityRegression,
    ].some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("Invalid Chat release gate policy.");
  }
  return { ...policy };
}

/**
 * Evaluate body-free, deterministic release evidence across the complete gold
 * registry. Observations are normalized and re-scored; supplied metric objects
 * are never trusted as release authority.
 */
export function evaluateChatReleaseGatesV1(input: {
  cases: readonly {
    scenario: ChatEvaluationScenarioV1;
    comparison: ChatReleaseEvaluationComparisonResultV1;
  }[];
  policy?: ChatReleaseGatePolicyV1;
}): ChatReleaseGateResultV1 {
  if (input.cases.length === 0) throw new Error("Chat release gates require scenarios.");
  const policy = normalizedPolicy(input.policy ?? DEFAULT_CHAT_RELEASE_GATE_POLICY_V1);
  const failures = new Map<ChatReleaseGateFailureCodeV1, Set<string>>();
  const legacy: number[] = [];
  const auto: number[] = [];
  const quickSimple: number[] = [];
  const deepSimple: number[] = [];
  const quickComplex: number[] = [];
  const deepComplex: number[] = [];
  const seenScenarios = new Set<string>();

  for (const { scenario, comparison } of input.cases) {
    const fingerprint = chatEvaluationScenarioFingerprintV1(scenario);
    if (
      seenScenarios.has(scenario.id) ||
      comparison.schema !== CHAT_EVALUATION_SCHEMA_V1 ||
      comparison.scenarioId !== scenario.id ||
      comparison.scenarioFingerprint !== fingerprint
    ) {
      addFailure(failures, "comparison-identity-invalid", scenario.id);
      continue;
    }
    seenScenarios.add(scenario.id);
    const metrics = Object.fromEntries(
      (["legacy-chat", ...CHAT_VARIANTS] as const).map((variant) => [
        variant,
        metricsFor(scenario, comparison, variant),
      ]),
    ) as Record<"legacy-chat" | (typeof CHAT_VARIANTS)[number], ChatEvaluationMetricsV1>;
    legacy.push(metrics["legacy-chat"].qualityScore);
    auto.push(metrics.auto.qualityScore);

    const simple = scenario.gold.expectedStrategyByMode.auto === "direct";
    (simple ? quickSimple : quickComplex).push(metrics.quick.qualityScore);
    (simple ? deepSimple : deepComplex).push(metrics.deep.qualityScore);

    for (const variant of CHAT_VARIANTS) {
      const result = metrics[variant];
      if (result.wrongSources > 0) addFailure(failures, "wrong-source", scenario.id);
      if (result.unsupportedAssertions > 0) {
        addFailure(failures, "unsupported-assertion", scenario.id);
      }
      if (result.falseCompleteness) addFailure(failures, "false-completeness", scenario.id);
      if (!result.outcomeCorrect) addFailure(failures, "outcome-incorrect", scenario.id);
      if (!result.strategyCorrect) addFailure(failures, "strategy-incorrect", scenario.id);
      if (result.citationPrecision < 1) {
        addFailure(failures, "citation-precision", scenario.id);
      }
      if (result.sourceRecall < 1) addFailure(failures, "source-recall", scenario.id);
      if (result.detailRecall < 1) addFailure(failures, "detail-recall", scenario.id);
      if (
        Object.keys(scenario.gold.relationshipSupport).length > 0 &&
        result.relationshipRecall < 1 && variant !== "quick"
      ) {
        addFailure(failures, "relationship-recall", scenario.id);
      }
      if (
        scenario.gold.requiredGapIds.length > 0 && result.gapRecall < 1
      ) {
        addFailure(failures, "gap-recall", scenario.id);
      }
      if (
        scenario.scope.exactAnchorSourceIds.length > 0 && simple &&
        result.qualityScore < policy.minimumExactContextQuality
      ) {
        addFailure(failures, "exact-context-quality", scenario.id);
      }
    }
  }

  const aggregate = {
    legacyQuality: mean(legacy),
    autoQuality: mean(auto),
    quickSimpleQuality: mean(quickSimple),
    deepSimpleQuality: mean(deepSimple),
    quickComplexQuality: mean(quickComplex),
    deepComplexQuality: mean(deepComplex),
  };
  if (
    aggregate.autoQuality - aggregate.legacyQuality <
      policy.minimumAutoQualityGainOverLegacy
  ) {
    addFailure(failures, "auto-not-better-than-legacy", "aggregate");
  }
  if (
    aggregate.deepComplexQuality - aggregate.quickComplexQuality <
      policy.minimumDeepComplexQualityGainOverQuick
  ) {
    addFailure(failures, "deep-not-better-on-complex", "aggregate");
  }
  if (
    aggregate.quickSimpleQuality - aggregate.deepSimpleQuality >
      policy.maximumDeepSimpleQualityRegression
  ) {
    addFailure(failures, "deep-regressed-on-simple", "aggregate");
  }

  const normalizedFailures = [...failures.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, scenarioIds]) => ({
      code,
      scenarioIds: [...scenarioIds].sort(),
    }));
  return {
    schema: CHAT_RELEASE_GATE_SCHEMA_V1,
    passed: normalizedFailures.length === 0,
    modelJudgePolicy: CHAT_RELEASE_MODEL_JUDGE_POLICY_V1,
    scenarioCount: seenScenarios.size,
    simpleScenarioCount: quickSimple.length,
    complexScenarioCount: quickComplex.length,
    failures: normalizedFailures,
    aggregate,
  };
}
