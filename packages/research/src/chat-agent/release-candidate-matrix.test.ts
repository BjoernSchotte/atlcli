import { describe, expect, test } from "bun:test";
import {
  CHAT_RELEASE_CANDIDATE_CHECKS_V1,
  CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
  CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
  CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1,
  evaluateChatReleaseCandidateMatrixV1,
  parseChatReleaseCandidateProofV1,
  type ChatReleaseCandidateProofV1,
} from "./release-candidate-matrix.js";

function proof(
  requirement: (typeof CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1)[number],
): ChatReleaseCandidateProofV1 {
  const privateProof = requirement.proofId.startsWith("private-");
  const caseIds = requirement.requiredCaseIds
    ? [...requirement.requiredCaseIds]
    : Array.from({ length: requirement.minimumCases }, (_, index) =>
      privateProof ? `private:CASE${index + 1}` : `packed:case-${index + 1}`);
  return {
    schema: CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
    proofId: requirement.proofId,
    producer: requirement.producer,
    status: "passed",
    caseIds,
    variants: [...requirement.requiredVariants],
    checks: [...requirement.requiredChecks],
    failureCodes: [],
    measurements: {
      caseCount: caseIds.length,
      runCount: Math.max(caseIds.length, requirement.requiredVariants.length),
      durationMs: 1_000,
      modelCalls: 1,
      ptcCalls: 1,
      httpCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
    },
    evidenceFingerprint: "a".repeat(64),
  };
}

function matrix() {
  return {
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    generatedAt: "2026-08-09T12:00:00.000Z",
    proofs: CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.map(proof),
  };
}

describe("release-candidate quality matrix contract", () => {
  test("accepts only a complete quality, lifecycle, host, live, and review envelope", () => {
    const result = evaluateChatReleaseCandidateMatrixV1(matrix());
    expect(result).toMatchObject({
      passed: true,
      proofCount: CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.length,
      failedProofIds: [],
      failureCodes: [],
    });
    expect(result.aggregate.caseCount).toBeGreaterThanOrEqual(20);
  });

  test("fails independently for missing case, variant, lifecycle, MV3, and operator proof", () => {
    const cases = [
      ["runtime-chat-quality", "case-coverage-missing"],
      ["runtime-deep-research-control", "variant-coverage-missing"],
      ["packed-mv3-quality", "host-parity-failed"],
      ["packed-mv3-lifecycle", "lifecycle-failed"],
      ["private-operator-review", "operator-review-rejected"],
    ] as const;
    for (const [proofId, expectedFailure] of cases) {
      const value = matrix();
      const target = value.proofs.find((entry) => entry.proofId === proofId)!;
      if (expectedFailure === "case-coverage-missing") target.caseIds.pop();
      else if (expectedFailure === "variant-coverage-missing") target.variants = [];
      else target.checks = [];
      target.measurements.caseCount = target.caseIds.length;
      const result = evaluateChatReleaseCandidateMatrixV1(value);
      expect(result.passed).toBe(false);
      expect(result.failureCodes).toContain(expectedFailure);
      expect(result.failedProofIds).toContain(proofId);
    }
  });

  test("propagates the existing blocking answer-quality failure taxonomy", () => {
    for (const code of [
      "wrong-source",
      "unsupported-claim",
      "false-completeness",
      "citation-invalid",
    ] as const) {
      const value = matrix();
      const runtime = value.proofs.find((entry) => entry.proofId === "runtime-chat-quality")!;
      runtime.status = "failed";
      runtime.failureCodes = [code];
      const result = evaluateChatReleaseCandidateMatrixV1(value);
      expect(result.passed).toBe(false);
      expect(result.failureCodes).toContain(code);
    }
  });

  test("rejects free-form, tenant, URL, answer, and mismatched measurement fields", () => {
    const base = proof(CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1[0]!);
    for (const forbidden of [
      { question: "private question" },
      { answer: "private answer" },
      { tenantOrigin: "https://tenant.example" },
      { sourceUrls: ["https://tenant.example/wiki"] },
      { reviewerText: "looks good" },
    ]) {
      expect(() => parseChatReleaseCandidateProofV1({ ...base, ...forbidden }))
        .toThrow("contract");
    }
    expect(() => parseChatReleaseCandidateProofV1({
      ...base,
      measurements: { ...base.measurements, caseCount: 999 },
    })).toThrow("caseCount");
    expect(() => parseChatReleaseCandidateProofV1({
      ...base,
      checks: [...CHAT_RELEASE_CANDIDATE_CHECKS_V1, "raw-content-reviewed"],
    })).toThrow("checks");
  });
});
