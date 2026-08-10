import {
  RESEARCH_REPORT_SCHEMA_V1,
  type ResearchReport,
} from "../../contracts.js";
import {
  CHAT_EVALUATION_SCHEMA_V1,
  chatEvaluationScenarioFingerprintV1,
  normalizeChatEvaluationObservationV1,
  type ChatEvaluationGapV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationOutcomeV1,
  type ChatEvaluationScenarioV1,
  type ChatEvaluationVariantV1,
} from "../evaluation.js";

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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

/**
 * Temporary C0-only observer for the path being replaced in C1.
 *
 * The adapter deliberately accepts a Research report because that is the
 * defect C0 must measure. It emits only IDs, canonical URLs, counters, and
 * sizes. Report prose, source excerpts, prompts, and hidden reasoning never
 * cross the evaluation boundary.
 */
export function legacyResearchReportToChatObservationV1(input: {
  scenario: ChatEvaluationScenarioV1;
  variant: ChatEvaluationVariantV1;
  report: ResearchReport;
  detailedSourceIds: readonly string[];
  modelCalls: number;
  outcome?: ChatEvaluationOutcomeV1;
  gaps?: readonly ChatEvaluationGapV1[];
}): ChatEvaluationObservationV1 {
  const sourceUrls = new Map(
    input.report.sources.map((source) => [source.id, source.url]),
  );
  const assertionSources = input.report.schema === RESEARCH_REPORT_SCHEMA_V1
    ? input.report.findings.map((finding) => ({
          id: finding.id,
          sourceIds: finding.sourceIds,
        }))
    : input.report.claims.map((claim) => ({
        id: claim.id,
        sourceIds: claim.sourceIds,
      }));
  const relationshipSources = input.report.schema === RESEARCH_REPORT_SCHEMA_V1
    ? input.report.relationships.map((relationship) => ({
        id: relationship.id,
        sourceIds: relationship.sourceIds,
      }))
    : [];
  const publishedAssertionIds = uniqueSorted(
    assertionSources.map((assertion) => assertion.id),
  );
  const publishedRelationshipIds = uniqueSorted(
    relationshipSources.map((relationship) => relationship.id),
  );
  const citations = [...assertionSources, ...relationshipSources].flatMap((assertion) =>
    assertion.sourceIds.map((sourceId) => ({
      targetId: assertion.id,
      sourceId,
      canonicalUrl: sourceUrls.get(sourceId) ?? "",
    }))
  ).sort((left, right) =>
    `${left.targetId}:${left.sourceId}`.localeCompare(
      `${right.targetId}:${right.sourceId}`,
      "en-US",
    ));

  return normalizeChatEvaluationObservationV1({
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: input.scenario.id,
    scenarioFingerprint: chatEvaluationScenarioFingerprintV1(input.scenario),
    variant: input.variant,
    outcome: input.outcome ?? (publishedAssertionIds.length > 0 ? "answer" : "abstained"),
    qualityMode: QUALITY_BY_VARIANT[input.variant],
    providerReasoningPreference: REASONING_BY_VARIANT[input.variant],
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
    discoveredSourceIds: uniqueSorted(input.report.sources.map((source) => source.id)),
    selectedSourceIds: uniqueSorted(input.report.sources.map((source) => source.id)),
    detailedSourceIds: uniqueSorted(input.detailedSourceIds),
    publishedAssertionIds,
    publishedRelationshipIds,
    citations,
    gaps: [...(input.gaps ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id, "en-US")),
    calls: {
      model: input.modelCalls,
      ptc: input.report.run.counts.ptcCalls,
      http: input.report.run.counts.httpCalls,
    },
    tokens: {
      input: input.report.run.usage?.inputTokens ?? 0,
      output: input.report.run.usage?.outputTokens ?? 0,
    },
    modelCostMicros: 0,
    peakSupervisorInputTokens: input.report.run.usage?.inputTokens ?? 0,
    latencyMs: input.report.run.durationMs,
    finalMarkdownChars: input.report.markdown.length,
  }, input.scenario);
}
