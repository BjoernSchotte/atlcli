import type { ChatQualityModeV1 } from "../quality-policy.js";

export const CHAT_EVALUATION_SCHEMA_V1 = "atlcli.chat-evaluation/v1" as const;

export const CHAT_EVALUATION_VARIANTS_V1 = [
  "legacy-chat",
  "quick-effort-only",
  "auto-effort-only",
  "deep-effort-only",
] as const;

export type ChatEvaluationVariantV1 =
  (typeof CHAT_EVALUATION_VARIANTS_V1)[number];

export type ChatEvaluationOutcomeV1 =
  | "answer"
  | "abstained"
  | "failed"
  | "paused";

export type ChatEvaluationStrategyExecutionV1 = "direct" | "agentic";

export interface ChatEvaluationSourceV1 {
  id: string;
  product: "jira" | "confluence";
  canonicalUrl: string;
  /** Opaque committed-fixture identity; never the source body. */
  contentFingerprint: string;
}

export interface ChatEvaluationBudgetV1 {
  maxModelCalls: number;
  maxPtcCalls: number;
  maxHttpCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxDurationMs: number;
}

export interface ChatEvaluationGoldV1 {
  expectedOutcome: ChatEvaluationOutcomeV1;
  relevantSourceIds: readonly string[];
  requiredDetailSourceIds: readonly string[];
  forbiddenSourceIds: readonly string[];
  assertionSupport: Readonly<Record<string, readonly string[]>>;
  requiredGapIds: readonly string[];
  expectedStrategyByMode: Readonly<
    Record<ChatQualityModeV1, ChatEvaluationStrategyExecutionV1>
  >;
}

export interface ChatEvaluationScenarioV1 {
  schema: typeof CHAT_EVALUATION_SCHEMA_V1;
  id: string;
  question: string;
  tenantOrigin: string;
  scope: {
    exactAnchorSourceIds: readonly string[];
    jiraProjectKeys: readonly string[];
    confluenceSpaceKeys: readonly string[];
  };
  sources: readonly ChatEvaluationSourceV1[];
  budget: ChatEvaluationBudgetV1;
  gold: ChatEvaluationGoldV1;
}

export interface ChatEvaluationCitationV1 {
  targetId: string;
  sourceId: string;
  canonicalUrl: string;
}

export interface ChatEvaluationGapV1 {
  id: string;
  kind:
    | "missing-evidence"
    | "incomplete-retrieval"
    | "unresolved-contradiction"
    | "scope-ambiguity"
    | "deadline";
}

export interface ChatEvaluationObservationV1 {
  schema: typeof CHAT_EVALUATION_SCHEMA_V1;
  scenarioId: string;
  scenarioFingerprint: string;
  variant: ChatEvaluationVariantV1;
  outcome: ChatEvaluationOutcomeV1;
  qualityMode: ChatQualityModeV1;
  providerReasoningPreference: "fast" | "balanced" | "thorough";
  strategy: {
    execution: ChatEvaluationStrategyExecutionV1;
    reasonCodes: readonly string[];
  };
  workflow: {
    runtimePath: "legacy-chat-via-research" | "chat-agent";
    rootExecutions: number;
    subagentTasks: number;
    synthesizerTasks: number;
    researchReportFinalizations: number;
  };
  selectedSourceIds: readonly string[];
  detailedSourceIds: readonly string[];
  publishedAssertionIds: readonly string[];
  citations: readonly ChatEvaluationCitationV1[];
  gaps: readonly ChatEvaluationGapV1[];
  calls: {
    model: number;
    ptc: number;
    http: number;
  };
  tokens: {
    input: number;
    output: number;
  };
  latencyMs: number;
  finalMarkdownChars: number;
}

export interface ChatEvaluationMetricsV1 {
  schema: typeof CHAT_EVALUATION_SCHEMA_V1;
  sourceRecall: number;
  detailRecall: number;
  citationPrecision: number;
  supportedAssertionRecall: number;
  unsupportedAssertions: number;
  wrongSources: number;
  gapRecall: number;
  outcomeCorrect: boolean;
  strategyCorrect: boolean;
  calls: ChatEvaluationObservationV1["calls"] & { total: number };
  tokens: ChatEvaluationObservationV1["tokens"] & { total: number };
  latencyMs: number;
  finalMarkdownChars: number;
}

export interface ChatEvaluationRunInputV1 {
  schema: typeof CHAT_EVALUATION_SCHEMA_V1;
  variant: ChatEvaluationVariantV1;
  scenario: Readonly<ChatEvaluationScenarioV1>;
  scenarioFingerprint: string;
}

export interface ChatEvaluationComparisonResultV1 {
  schema: typeof CHAT_EVALUATION_SCHEMA_V1;
  scenarioId: string;
  scenarioFingerprint: string;
  providerEffortOnlyWorkflowEquivalent: boolean;
  runs: Readonly<
    Record<
      ChatEvaluationVariantV1,
      { observation: ChatEvaluationObservationV1; metrics: ChatEvaluationMetricsV1 }
    >
  >;
}

export type ChatEvaluationVariantRunnerV1 = (
  input: ChatEvaluationRunInputV1,
) => Promise<ChatEvaluationObservationV1>;

const QUALITY_BY_VARIANT = {
  "legacy-chat": "auto",
  "quick-effort-only": "quick",
  "auto-effort-only": "auto",
  "deep-effort-only": "deep",
} as const satisfies Record<ChatEvaluationVariantV1, ChatQualityModeV1>;

const REASONING_BY_VARIANT = {
  "legacy-chat": "balanced",
  "quick-effort-only": "fast",
  "auto-effort-only": "balanced",
  "deep-effort-only": "thorough",
} as const satisfies Record<
  ChatEvaluationVariantV1,
  ChatEvaluationObservationV1["providerReasoningPreference"]
>;

const OBSERVATION_KEYS = new Set([
  "schema",
  "scenarioId",
  "scenarioFingerprint",
  "variant",
  "outcome",
  "qualityMode",
  "providerReasoningPreference",
  "strategy",
  "workflow",
  "selectedSourceIds",
  "detailedSourceIds",
  "publishedAssertionIds",
  "citations",
  "gaps",
  "calls",
  "tokens",
  "latencyMs",
  "finalMarkdownChars",
]);

function invalid(message: string): never {
  throw new Error(`Invalid Chat evaluation: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    invalid(`${label} keys differ.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${label} is invalid.`);
  }
  return value as number;
}

function uniqueSortedStrings(
  value: unknown,
  label: string,
  maximumItems = 200,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(`${label} is invalid.`);
  }
  const normalized = value.map((entry) => boundedString(entry, label));
  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function assertAlreadyNormalized(
  original: readonly string[],
  normalized: readonly string[],
  label: string,
): void {
  if (JSON.stringify(original) !== JSON.stringify(normalized)) {
    invalid(`${label} is not normalized.`);
  }
}

function normalizedHttpsUrl(value: unknown, label: string): string {
  const text = boundedString(value, label, 8_000);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return invalid(`${label} is not a URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    invalid(`${label} must be a credential-free HTTPS URL without a fragment.`);
  }
  return parsed.href;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("non-finite number in fingerprint input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) invalid("non-JSON fingerprint input");
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function normalizeBudget(value: unknown): ChatEvaluationBudgetV1 {
  if (!isRecord(value)) invalid("scenario budget is invalid");
  exactKeys(value, [
    "maxModelCalls",
    "maxPtcCalls",
    "maxHttpCalls",
    "maxInputTokens",
    "maxOutputTokens",
    "maxDurationMs",
  ], "scenario budget");
  return {
    maxModelCalls: safeInteger(value.maxModelCalls, "maxModelCalls", 1),
    maxPtcCalls: safeInteger(value.maxPtcCalls, "maxPtcCalls", 1),
    maxHttpCalls: safeInteger(value.maxHttpCalls, "maxHttpCalls", 1),
    maxInputTokens: safeInteger(value.maxInputTokens, "maxInputTokens", 1),
    maxOutputTokens: safeInteger(value.maxOutputTokens, "maxOutputTokens", 1),
    maxDurationMs: safeInteger(value.maxDurationMs, "maxDurationMs", 1),
  };
}

/** Normalize one customer-free or private scenario into deterministic order. */
export function normalizeChatEvaluationScenarioV1(
  value: ChatEvaluationScenarioV1,
): ChatEvaluationScenarioV1 {
  if (!isRecord(value) || value.schema !== CHAT_EVALUATION_SCHEMA_V1) {
    invalid("scenario schema differs");
  }
  exactKeys(value, [
    "schema",
    "id",
    "question",
    "tenantOrigin",
    "scope",
    "sources",
    "budget",
    "gold",
  ], "scenario");
  if (!isRecord(value.scope)) invalid("scenario scope is invalid");
  exactKeys(value.scope, [
    "exactAnchorSourceIds",
    "jiraProjectKeys",
    "confluenceSpaceKeys",
  ], "scenario scope");
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    invalid("scenario sources are invalid");
  }
  const tenantOrigin = new URL(normalizedHttpsUrl(value.tenantOrigin, "tenant origin")).origin;
  const sources = value.sources.map((source) => {
    if (!isRecord(source)) invalid("scenario source is invalid");
    exactKeys(source, ["id", "product", "canonicalUrl", "contentFingerprint"], "scenario source");
    const id = boundedString(source.id, "source id", 200);
    if (source.product !== "jira" && source.product !== "confluence") {
      invalid("source product is invalid");
    }
    const canonicalUrl = normalizedHttpsUrl(source.canonicalUrl, "source canonical URL");
    if (new URL(canonicalUrl).origin !== tenantOrigin) {
      invalid("source canonical URL is outside the scenario tenant");
    }
    return {
      id,
      product: source.product,
      canonicalUrl,
      contentFingerprint: boundedString(
        source.contentFingerprint,
        "content fingerprint",
        200,
      ),
    } satisfies ChatEvaluationSourceV1;
  }).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    invalid("scenario source ids are not unique");
  }
  if (!isRecord(value.gold)) invalid("scenario gold is invalid");
  exactKeys(value.gold, [
    "expectedOutcome",
    "relevantSourceIds",
    "requiredDetailSourceIds",
    "forbiddenSourceIds",
    "assertionSupport",
    "requiredGapIds",
    "expectedStrategyByMode",
  ], "scenario gold");
  if (!["answer", "abstained", "failed", "paused"].includes(value.gold.expectedOutcome)) {
    invalid("expected outcome is invalid");
  }
  if (!isRecord(value.gold.assertionSupport)) invalid("assertion support is invalid");
  const assertionSupport = Object.fromEntries(
    Object.entries(value.gold.assertionSupport)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([assertionId, sourceIds]) => [
        boundedString(assertionId, "assertion id", 200),
        uniqueSortedStrings(sourceIds, `support for ${assertionId}`),
      ]),
  );
  if (!isRecord(value.gold.expectedStrategyByMode)) {
    invalid("expected strategy is invalid");
  }
  exactKeys(value.gold.expectedStrategyByMode, ["quick", "auto", "deep"], "expected strategy");
  for (const mode of ["quick", "auto", "deep"] as const) {
    if (!["direct", "agentic"].includes(value.gold.expectedStrategyByMode[mode])) {
      invalid(`expected ${mode} strategy is invalid`);
    }
  }
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const relevantSourceIds = uniqueSortedStrings(value.gold.relevantSourceIds, "relevant sources");
  const requiredDetailSourceIds = uniqueSortedStrings(value.gold.requiredDetailSourceIds, "required details");
  const forbiddenSourceIds = uniqueSortedStrings(value.gold.forbiddenSourceIds, "forbidden sources");
  const exactAnchorSourceIds = uniqueSortedStrings(value.scope.exactAnchorSourceIds, "exact anchors");
  for (const [label, ids] of Object.entries({
    relevantSourceIds,
    requiredDetailSourceIds,
    forbiddenSourceIds,
    exactAnchorSourceIds,
    supportSourceIds: Object.values(assertionSupport).flat(),
  })) {
    if (ids.some((id) => !knownSourceIds.has(id))) {
      invalid(`${label} contains an unknown source`);
    }
  }
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    id: boundedString(value.id, "scenario id", 200),
    question: boundedString(value.question, "scenario question", 2_000),
    tenantOrigin,
    scope: {
      exactAnchorSourceIds,
      jiraProjectKeys: uniqueSortedStrings(value.scope.jiraProjectKeys, "Jira project keys", 20),
      confluenceSpaceKeys: uniqueSortedStrings(value.scope.confluenceSpaceKeys, "Confluence space keys", 20),
    },
    sources,
    budget: normalizeBudget(value.budget),
    gold: {
      expectedOutcome: value.gold.expectedOutcome,
      relevantSourceIds,
      requiredDetailSourceIds,
      forbiddenSourceIds,
      assertionSupport,
      requiredGapIds: uniqueSortedStrings(value.gold.requiredGapIds, "required gaps"),
      expectedStrategyByMode: {
        quick: value.gold.expectedStrategyByMode.quick,
        auto: value.gold.expectedStrategyByMode.auto,
        deep: value.gold.expectedStrategyByMode.deep,
      },
    },
  };
}

export function chatEvaluationScenarioFingerprintV1(
  scenario: ChatEvaluationScenarioV1,
): string {
  const normalized = normalizeChatEvaluationScenarioV1(scenario);
  return fnv1a32(stableJson(normalized));
}

function assertScenarioAlreadyNormalized(scenario: ChatEvaluationScenarioV1): void {
  const normalized = normalizeChatEvaluationScenarioV1(scenario);
  if (stableJson(scenario) !== stableJson(normalized)) {
    invalid("scenario is not normalized");
  }
}

/** Strictly decode one body-free observation; unknown fields fail closed. */
export function normalizeChatEvaluationObservationV1(
  value: ChatEvaluationObservationV1,
  scenario: ChatEvaluationScenarioV1,
): ChatEvaluationObservationV1 {
  if (!isRecord(value) || value.schema !== CHAT_EVALUATION_SCHEMA_V1) {
    invalid("observation schema differs");
  }
  if (Object.keys(value).some((key) => !OBSERVATION_KEYS.has(key))) {
    invalid("observation contains an unsupported field");
  }
  if (Object.keys(value).length !== OBSERVATION_KEYS.size) {
    invalid("observation is missing a field");
  }
  if (!CHAT_EVALUATION_VARIANTS_V1.includes(value.variant)) {
    invalid("observation variant is invalid");
  }
  if (!["answer", "abstained", "failed", "paused"].includes(value.outcome)) {
    invalid("observation outcome is invalid");
  }
  if (!["quick", "auto", "deep"].includes(value.qualityMode)) {
    invalid("observation quality mode is invalid");
  }
  if (!["fast", "balanced", "thorough"].includes(value.providerReasoningPreference)) {
    invalid("observation provider preference is invalid");
  }
  if (!isRecord(value.strategy)) invalid("observation strategy is invalid");
  exactKeys(value.strategy, ["execution", "reasonCodes"], "observation strategy");
  if (!["direct", "agentic"].includes(value.strategy.execution)) {
    invalid("observation strategy execution is invalid");
  }
  if (!isRecord(value.workflow)) invalid("observation workflow is invalid");
  exactKeys(value.workflow, [
    "runtimePath",
    "rootExecutions",
    "subagentTasks",
    "synthesizerTasks",
    "researchReportFinalizations",
  ], "observation workflow");
  if (!["legacy-chat-via-research", "chat-agent"].includes(value.workflow.runtimePath)) {
    invalid("observation runtime path is invalid");
  }
  if (!isRecord(value.calls)) invalid("observation calls are invalid");
  exactKeys(value.calls, ["model", "ptc", "http"], "observation calls");
  if (!isRecord(value.tokens)) invalid("observation tokens are invalid");
  exactKeys(value.tokens, ["input", "output"], "observation tokens");
  const selectedSourceIds = uniqueSortedStrings(value.selectedSourceIds, "selected sources");
  const detailedSourceIds = uniqueSortedStrings(value.detailedSourceIds, "detailed sources");
  const publishedAssertionIds = uniqueSortedStrings(value.publishedAssertionIds, "published assertions");
  const reasonCodes = uniqueSortedStrings(value.strategy.reasonCodes, "strategy reason codes", 20);
  assertAlreadyNormalized(value.selectedSourceIds, selectedSourceIds, "selected sources");
  assertAlreadyNormalized(value.detailedSourceIds, detailedSourceIds, "detailed sources");
  assertAlreadyNormalized(value.publishedAssertionIds, publishedAssertionIds, "published assertions");
  assertAlreadyNormalized(value.strategy.reasonCodes, reasonCodes, "strategy reason codes");
  const sources = new Map(scenario.sources.map((source) => [source.id, source]));
  for (const sourceId of [...selectedSourceIds, ...detailedSourceIds]) {
    if (!sources.has(sourceId)) invalid("observation references an unknown source");
  }
  if (detailedSourceIds.some((sourceId) => !selectedSourceIds.includes(sourceId))) {
    invalid("a detailed source was not selected");
  }
  if (!Array.isArray(value.citations) || value.citations.length > 200) {
    invalid("observation citations are invalid");
  }
  const citations = value.citations.map((citation) => {
    if (!isRecord(citation)) invalid("observation citation is invalid");
    exactKeys(citation, ["targetId", "sourceId", "canonicalUrl"], "observation citation");
    const targetId = boundedString(citation.targetId, "citation target", 200);
    const sourceId = boundedString(citation.sourceId, "citation source", 200);
    const source = sources.get(sourceId);
    if (!source) invalid("citation references an unknown source");
    if (!publishedAssertionIds.includes(targetId)) {
      invalid("citation target was not published");
    }
    if (!(scenario.gold.assertionSupport[targetId] ?? []).includes(sourceId)) {
      invalid("citation is unsupported by the gold evidence");
    }
    const canonicalUrl = normalizedHttpsUrl(citation.canonicalUrl, "citation URL");
    if (canonicalUrl !== source.canonicalUrl) {
      invalid("citation URL differs from the canonical source URL");
    }
    return { targetId, sourceId, canonicalUrl };
  }).sort((left, right) =>
    `${left.targetId}:${left.sourceId}`.localeCompare(
      `${right.targetId}:${right.sourceId}`,
      "en-US",
    ));
  if (!Array.isArray(value.gaps) || value.gaps.length > 100) {
    invalid("observation gaps are invalid");
  }
  const gaps = value.gaps.map((gap) => {
    if (!isRecord(gap)) invalid("observation gap is invalid");
    exactKeys(gap, ["id", "kind"], "observation gap");
    if (typeof gap.kind !== "string" || ![
      "missing-evidence",
      "incomplete-retrieval",
      "unresolved-contradiction",
      "scope-ambiguity",
      "deadline",
    ].includes(gap.kind)) invalid("observation gap kind is invalid");
    return {
      id: boundedString(gap.id, "gap id", 200),
      kind: gap.kind,
    } as ChatEvaluationGapV1;
  }).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  if (new Set(gaps.map((gap) => gap.id)).size !== gaps.length) {
    invalid("observation gap ids are not unique");
  }
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: boundedString(value.scenarioId, "observation scenario id", 200),
    scenarioFingerprint: boundedString(value.scenarioFingerprint, "scenario fingerprint", 100),
    variant: value.variant,
    outcome: value.outcome,
    qualityMode: value.qualityMode,
    providerReasoningPreference: value.providerReasoningPreference,
    strategy: { execution: value.strategy.execution, reasonCodes },
    workflow: {
      runtimePath: value.workflow.runtimePath,
      rootExecutions: safeInteger(value.workflow.rootExecutions, "root executions", 1),
      subagentTasks: safeInteger(value.workflow.subagentTasks, "subagent tasks"),
      synthesizerTasks: safeInteger(value.workflow.synthesizerTasks, "synthesizer tasks"),
      researchReportFinalizations: safeInteger(
        value.workflow.researchReportFinalizations,
        "research report finalizations",
      ),
    },
    selectedSourceIds,
    detailedSourceIds,
    publishedAssertionIds,
    citations,
    gaps,
    calls: {
      model: safeInteger(value.calls.model, "model calls"),
      ptc: safeInteger(value.calls.ptc, "PTC calls"),
      http: safeInteger(value.calls.http, "HTTP calls"),
    },
    tokens: {
      input: safeInteger(value.tokens.input, "input tokens"),
      output: safeInteger(value.tokens.output, "output tokens"),
    },
    latencyMs: safeInteger(value.latencyMs, "latency"),
    finalMarkdownChars: safeInteger(value.finalMarkdownChars, "Markdown characters"),
  };
}

export function scoreChatEvaluationV1(
  scenario: ChatEvaluationScenarioV1,
  value: ChatEvaluationObservationV1,
): ChatEvaluationMetricsV1 {
  const observation = normalizeChatEvaluationObservationV1(value, scenario);
  const relevant = new Set(scenario.gold.relevantSourceIds);
  const requiredDetails = new Set(scenario.gold.requiredDetailSourceIds);
  const selected = new Set(observation.selectedSourceIds);
  const detailed = new Set(observation.detailedSourceIds);
  const supportedAssertions = new Set(Object.keys(scenario.gold.assertionSupport));
  const published = new Set(observation.publishedAssertionIds);
  const supportedPublished = [...published].filter((assertionId) =>
    supportedAssertions.has(assertionId) &&
    observation.citations.some((citation) => citation.targetId === assertionId));
  const expectedGaps = new Set(scenario.gold.requiredGapIds);
  const observedGaps = new Set(observation.gaps.map((gap) => gap.id));
  const wrongSources = observation.selectedSourceIds.filter(
    (sourceId) =>
      !relevant.has(sourceId) || scenario.gold.forbiddenSourceIds.includes(sourceId),
  ).length;
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    sourceRecall: ratio(intersectionSize(selected, relevant), relevant.size),
    detailRecall: ratio(
      intersectionSize(detailed, requiredDetails),
      requiredDetails.size,
    ),
    citationPrecision: ratio(observation.citations.length, observation.citations.length),
    supportedAssertionRecall: ratio(
      supportedPublished.length,
      supportedAssertions.size,
    ),
    unsupportedAssertions: published.size - supportedPublished.length,
    wrongSources,
    gapRecall: ratio(
      intersectionSize(observedGaps, expectedGaps),
      expectedGaps.size,
    ),
    outcomeCorrect: observation.outcome === scenario.gold.expectedOutcome,
    strategyCorrect:
      observation.strategy.execution ===
        scenario.gold.expectedStrategyByMode[observation.qualityMode],
    calls: {
      ...observation.calls,
      total: observation.calls.model + observation.calls.ptc + observation.calls.http,
    },
    tokens: {
      ...observation.tokens,
      total: observation.tokens.input + observation.tokens.output,
    },
    latencyMs: observation.latencyMs,
    finalMarkdownChars: observation.finalMarkdownChars,
  };
}

function assertWithinBudget(
  observation: ChatEvaluationObservationV1,
  budget: ChatEvaluationBudgetV1,
): void {
  if (
    observation.calls.model > budget.maxModelCalls ||
    observation.calls.ptc > budget.maxPtcCalls ||
    observation.calls.http > budget.maxHttpCalls ||
    observation.tokens.input > budget.maxInputTokens ||
    observation.tokens.output > budget.maxOutputTokens ||
    observation.latencyMs > budget.maxDurationMs
  ) {
    invalid("observation exceeds the frozen scenario budget");
  }
}

function workflowFingerprint(observation: ChatEvaluationObservationV1): string {
  return fnv1a32(stableJson({
    strategy: observation.strategy,
    workflow: observation.workflow,
  }));
}

/**
 * Run the current legacy path and provider-effort-only variants serially.
 * Serial execution prevents shared rate limits or cache state from changing the
 * comparison envelope. The scenario is deeply frozen before every runner call.
 */
export async function runChatLegacyEffortComparisonV1(input: {
  scenario: ChatEvaluationScenarioV1;
  runners: Readonly<Record<ChatEvaluationVariantV1, ChatEvaluationVariantRunnerV1>>;
}): Promise<ChatEvaluationComparisonResultV1> {
  assertScenarioAlreadyNormalized(input.scenario);
  const scenarioFingerprint = chatEvaluationScenarioFingerprintV1(input.scenario);
  const runs = {} as ChatEvaluationComparisonResultV1["runs"] & Record<
    ChatEvaluationVariantV1,
    { observation: ChatEvaluationObservationV1; metrics: ChatEvaluationMetricsV1 }
  >;
  const workflowFingerprints: string[] = [];
  for (const variant of CHAT_EVALUATION_VARIANTS_V1) {
    const runner = input.runners[variant];
    if (typeof runner !== "function") invalid(`missing ${variant} runner`);
    const runnerInput = deepFreeze({
      schema: CHAT_EVALUATION_SCHEMA_V1,
      variant,
      scenario: cloneJson(input.scenario),
      scenarioFingerprint,
    } satisfies ChatEvaluationRunInputV1);
    const observed = await runner(runnerInput);
    const observation = normalizeChatEvaluationObservationV1(
      observed,
      input.scenario,
    );
    if (
      observation.scenarioId !== input.scenario.id ||
      observation.scenarioFingerprint !== scenarioFingerprint ||
      observation.variant !== variant
    ) {
      invalid(`${variant} returned a foreign evaluation identity`);
    }
    if (
      observation.qualityMode !== QUALITY_BY_VARIANT[variant] ||
      observation.providerReasoningPreference !== REASONING_BY_VARIANT[variant]
    ) {
      invalid(`${variant} changed its provider-effort-only policy`);
    }
    if (
      observation.workflow.runtimePath !== "legacy-chat-via-research" ||
      observation.strategy.execution !== "direct" ||
      observation.workflow.rootExecutions !== 1 ||
      observation.workflow.subagentTasks !== 0 ||
      observation.workflow.synthesizerTasks !== 0 ||
      observation.workflow.researchReportFinalizations !== 1
    ) {
      invalid(`${variant} is not the frozen legacy direct workflow`);
    }
    assertWithinBudget(observation, input.scenario.budget);
    workflowFingerprints.push(workflowFingerprint(observation));
    runs[variant] = {
      observation,
      metrics: scoreChatEvaluationV1(input.scenario, observation),
    };
  }
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: input.scenario.id,
    scenarioFingerprint,
    providerEffortOnlyWorkflowEquivalent:
      new Set(workflowFingerprints).size === 1,
    runs,
  };
}
