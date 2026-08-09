import {
  scoreChatEvaluationV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationScenarioV1,
} from "../evaluation.js";
import {
  finalizeChatReleaseCandidateProofV1,
  finalizeChatReleaseCandidateRunV1,
  type ChatReleaseCandidateCheckResultV1,
  type ChatReleaseCandidateFailureCodeV1,
  type ChatReleaseCandidateProofV1,
  type ChatReleaseCandidateRunV1,
} from "../release-candidate-matrix.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./gold-scenarios.js";
import { runChatRuntimeObservationV1 } from "./runtime-runner.js";

function check(
  name: ChatReleaseCandidateCheckResultV1["check"],
  passed: boolean,
): ChatReleaseCandidateCheckResultV1 {
  return { check: name, status: passed ? "passed" : "failed" };
}

function notApplicable(
  name: ChatReleaseCandidateCheckResultV1["check"],
): ChatReleaseCandidateCheckResultV1 {
  return { check: name, status: "not-applicable" };
}

function failureCodes(
  checks: readonly ChatReleaseCandidateCheckResultV1[],
): ChatReleaseCandidateFailureCodeV1[] {
  const failed = new Set(checks.filter((entry) => entry.status === "failed").map((entry) => entry.check));
  const codes: ChatReleaseCandidateFailureCodeV1[] = [];
  if (failed.has("source-selection")) codes.push("wrong-source");
  if (failed.has("detail-coverage")) codes.push("detail-coverage-missing");
  if (failed.has("citation-support")) codes.push("citation-invalid");
  if (failed.has("claim-support")) codes.push("unsupported-claim");
  if (failed.has("relationship-coverage")) codes.push("relationship-missed");
  if (failed.has("contradiction-coverage")) codes.push("contradiction-missed");
  if (failed.has("gap-disclosure")) codes.push("gap-missed");
  if (failed.has("outcome")) codes.push("outcome-incorrect");
  if (failed.has("strategy")) codes.push("strategy-incorrect");
  if (failed.has("no-false-completeness")) codes.push("false-completeness");
  if (failed.has("mode-isolation")) codes.push("mode-isolation-failed");
  return codes;
}

export async function chatReleaseRunFromObservationV1(input: {
  scenario: ChatEvaluationScenarioV1;
  observation: ChatEvaluationObservationV1;
}): Promise<ChatReleaseCandidateRunV1> {
  const metrics = scoreChatEvaluationV1(input.scenario, input.observation);
  const checks = [
    check("source-selection", metrics.sourceRecall === 1 && metrics.wrongSources === 0),
    check("detail-coverage", metrics.detailRecall === 1 && metrics.detailCoverage === 1),
    check("citation-support", metrics.citationPrecision === 1),
    check(
      "claim-support",
      metrics.unsupportedAssertions === 0 &&
        (input.observation.qualityMode === "quick" || metrics.supportedAssertionRecall === 1),
    ),
    input.observation.qualityMode === "quick" &&
        Object.keys(input.scenario.gold.relationshipSupport).length > 0
      ? notApplicable("relationship-coverage")
      : check("relationship-coverage", metrics.relationshipRecall === 1),
    check("contradiction-coverage", metrics.contradictionRecall === 1),
    check("gap-disclosure", metrics.gapRecall === 1),
    check("outcome", metrics.outcomeCorrect),
    check("strategy", metrics.strategyCorrect),
    check("no-false-completeness", !metrics.falseCompleteness),
    check(
      "mode-isolation",
      input.observation.variant === input.observation.qualityMode &&
        input.observation.workflow.runtimePath === "chat-agent" &&
        input.observation.workflow.researchReportFinalizations === 0,
    ),
  ];
  const failures = failureCodes(checks);
  return finalizeChatReleaseCandidateRunV1({
    schema: "atlcli.chat-release-candidate-run/v1",
    caseId: input.scenario.id,
    variant: input.observation.qualityMode,
    status: failures.length === 0 ? "passed" : "failed",
    checks,
    failureCodes: failures,
    measurements: {
      durationMs: input.observation.latencyMs,
      modelCalls: input.observation.calls.model,
      ptcCalls: input.observation.calls.ptc,
      httpCalls: input.observation.calls.http,
      inputTokens: input.observation.tokens.input,
      outputTokens: input.observation.tokens.output,
      costMicros: input.observation.modelCostMicros,
    },
  });
}

export async function runChatProductionRuntimeProofV1(input: {
  producedAt: string;
  sourceRevision: string;
  manifestFingerprint: string;
}): Promise<ChatReleaseCandidateProofV1> {
  const runs: ChatReleaseCandidateRunV1[] = [];
  for (const scenario of CHAT_RECOVERY_GOLD_SCENARIOS_V1) {
    for (const mode of ["quick", "auto", "deep"] as const) {
      const observation = await runChatRuntimeObservationV1({ scenario, mode });
      runs.push(await chatReleaseRunFromObservationV1({ scenario, observation }));
    }
  }
  return finalizeChatReleaseCandidateProofV1({
    proofId: "runtime-chat-quality",
    producer: "bun-production-runtime",
    producedAt: input.producedAt,
    sourceRevision: input.sourceRevision,
    manifestFingerprint: input.manifestFingerprint,
    runs,
  });
}
