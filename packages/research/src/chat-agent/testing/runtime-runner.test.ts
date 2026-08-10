import { describe, expect, test } from "bun:test";
import { SystemMessage } from "@langchain/core/messages";
import { scoreChatEvaluationV1 } from "../evaluation.js";
import { chatQualityPolicyV1 } from "../../quality-policy.js";
import { chatSubagentProfileByIdV1 } from "../workflow.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./gold-scenarios.js";
import { chatRuntimeFixtureV1 } from "./runtime-fixtures.js";
import { createChatRuntimeModelBindingV1 } from "./runtime-models.js";
import { runChatRuntimeObservationV1 } from "./runtime-runner.js";
import {
  fingerprintChatReleaseCandidateManifestV1,
} from "../release-candidate-matrix.js";
import {
  chatReleaseRunFromObservationV1,
  runChatProductionRuntimeProofV1,
} from "./runtime-proof.js";

const attachedPage = CHAT_RECOVERY_GOLD_SCENARIOS_V1.find((scenario) =>
  scenario.id === "chat-gold:attached-page"
)!;

describe("customer-free production Chat runtime", () => {
  test("the exact extraction fixture satisfies the production structured-output corridor", async () => {
    const binding = createChatRuntimeModelBindingV1({
      scenario: attachedPage,
      fixture: chatRuntimeFixtureV1(attachedPage.id),
      mode: "auto",
    });
    const model = binding.modelForRoute!({
      role: "extraction",
      preference: chatQualityPolicyV1("auto").providerReasoningPreference,
      profileId: "exact-context-reader",
    }).model;
    const response = await model.withStructuredOutput(
      chatSubagentProfileByIdV1("exact-context-reader").responseSchema as Record<string, unknown>,
      { name: "KiteweaveExactEvidenceExtractionV1", includeRaw: true, method: "jsonSchema" },
    ).invoke([new SystemMessage("Kiteweave internal exact-evidence extraction boundary")]);
    expect(response).toMatchObject({
      parsed: { schema: "atlcli.chat-evidence-packet/v1", sourceIds: ["wiki:1001"] },
    });
  });

  test("projects an exact attached page from the actual Chat root", async () => {
    const observation = await runChatRuntimeObservationV1({
      scenario: attachedPage,
      mode: "quick",
    });
    expect(observation).toMatchObject({
      outcome: "answer",
      qualityMode: "quick",
      workflow: { runtimePath: "chat-agent", rootExecutions: 1 },
      selectedSourceIds: ["wiki:1001"],
      detailedSourceIds: ["wiki:1001"],
      publishedAssertionIds: ["assertion:release-scope"],
    });
    expect(scoreChatEvaluationV1(attachedPage, observation)).toMatchObject({
      sourceRecall: 1,
      detailRecall: 1,
      citationPrecision: 1,
      supportedAssertionRecall: 1,
      wrongSources: 0,
      outcomeCorrect: true,
      strategyCorrect: true,
    });
  });

  test("rejects a deliberately unsupported production-runtime answer", async () => {
    const observation = await runChatRuntimeObservationV1({
      scenario: attachedPage,
      mode: "quick",
      defectiveAnswer: true,
    });
    const metrics = scoreChatEvaluationV1(attachedPage, observation);

    expect(metrics.unsupportedAssertions).toBe(1);
    expect(metrics.supportedAssertionRecall).toBe(0);
    expect(metrics.citationPrecision).toBe(0);
    expect(metrics.qualityScore).toBeLessThan(1);
    const run = await chatReleaseRunFromObservationV1({
      scenario: attachedPage,
      observation,
    });
    expect(run.status).toBe("failed");
    expect(run.failureCodes).toContain("unsupported-claim");
  });

  test("produces one body-free passing proof for all 20 by 3 Chat runs", async () => {
    const proof = await runChatProductionRuntimeProofV1({
      producedAt: "2026-08-09T12:00:00.000Z",
      sourceRevision: "1".repeat(40),
      manifestFingerprint: await fingerprintChatReleaseCandidateManifestV1(),
    });

    expect(proof.runs.filter((run) => run.status === "failed").map((run) => ({
      caseId: run.caseId,
      variant: run.variant,
      failureCodes: run.failureCodes,
    }))).toEqual([]);
    expect(proof.status).toBe("passed");
    expect(proof.caseIds).toHaveLength(20);
    expect(proof.runs).toHaveLength(60);
    expect(proof.runs.every((run) => run.status === "passed")).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("messageMarkdown");
    expect(JSON.stringify(proof)).not.toContain("canonicalUrl");
  // The proof executes 60 complete runtime observations. Five seconds is too
  // close to the measured serial runtime and would make this release gate
  // machine-load dependent without changing any product deadline.
  }, 10_000);

  for (const scenario of CHAT_RECOVERY_GOLD_SCENARIOS_V1) {
    for (const mode of ["quick", "auto", "deep"] as const) {
      test(`${mode} passes ${scenario.id}`, async () => {
        const observation = await runChatRuntimeObservationV1({ scenario, mode });
        const metrics = scoreChatEvaluationV1(scenario, observation);
        expect(observation.selectedSourceIds).toEqual(
          [...scenario.gold.relevantSourceIds].sort(),
        );
        expect(metrics.wrongSources).toBe(0);
        expect(metrics.sourceRecall).toBe(1);
        expect(metrics.detailRecall).toBe(1);
        expect(metrics.citationPrecision).toBe(1);
        expect(metrics.gapRecall).toBe(1);
        expect(metrics.outcomeCorrect).toBe(true);
        expect(metrics.strategyCorrect).toBe(true);
        if (mode !== "quick") {
          expect(metrics.supportedAssertionRecall).toBe(1);
          expect(metrics.relationshipRecall).toBe(1);
        }
      });
    }
  }
});
