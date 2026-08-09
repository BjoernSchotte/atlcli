import { describe, expect, test } from "bun:test";
import {
  CHAT_RELEASE_CANDIDATE_CHECKS_V1,
  CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
  CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
  CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1,
  CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1,
  evaluateChatReleaseCandidateMatrixV1,
  fingerprintChatReleaseCandidateManifestV1,
  fingerprintChatReleaseCandidateMatrixV1,
  fingerprintChatReleaseCandidateProofV1,
  fingerprintChatReleaseCandidateRunV1,
  parseChatReleaseCandidateProofV1,
  type ChatReleaseCandidateMatrixV1,
  type ChatReleaseCandidateProofV1,
  type ChatReleaseCandidateRunV1,
} from "./release-candidate-matrix.js";

const SOURCE_REVISION = "1".repeat(40);
const NOW = new Date("2026-08-09T12:00:00.000Z");

async function proof(
  requirement: (typeof CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1)[number],
): Promise<ChatReleaseCandidateProofV1> {
  const privateProof = requirement.proofId.startsWith("private-");
  const caseIds = requirement.requiredRuns
    ? [...new Set(requirement.requiredRuns.map((run) => run.caseId))]
    : requirement.requiredCaseIds
      ? [...requirement.requiredCaseIds]
      : Array.from({ length: requirement.minimumCases }, (_, index) =>
        privateProof ? `private:CASE${String(index + 1).padStart(2, "0")}` : `packed:case-${index + 1}`);
  const requiredRuns = requirement.requiredRuns ?? caseIds.flatMap((caseId) =>
    requirement.requiredVariants.map((variant) => ({ caseId, variant }))
  );
  const runs: ChatReleaseCandidateRunV1[] = [];
  for (const { caseId, variant } of requiredRuns) {
    const run: ChatReleaseCandidateRunV1 = {
      schema: CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1,
      caseId,
      variant,
      status: "passed",
      checks: requirement.requiredChecks.map((check) => ({ check, status: "passed" })),
      failureCodes: [],
      measurements: {
        durationMs: 1_000,
        modelCalls: 1,
        ptcCalls: 1,
        httpCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        ...(requirement.maximumCostMicros ? { costMicros: 1 } : {}),
      },
      evidenceFingerprint: "0".repeat(64),
    };
    run.evidenceFingerprint = await fingerprintChatReleaseCandidateRunV1(run);
    runs.push(run);
  }
  const sum = (key: keyof ChatReleaseCandidateRunV1["measurements"]) =>
    runs.reduce((total, run) => total + (run.measurements[key] ?? 0), 0);
  const value: ChatReleaseCandidateProofV1 = {
    schema: CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
    proofId: requirement.proofId,
    producer: requirement.producer,
    producedAt: NOW.toISOString(),
    sourceRevision: SOURCE_REVISION,
    manifestFingerprint: await fingerprintChatReleaseCandidateManifestV1(),
    status: "passed",
    caseIds,
    variants: [...requirement.requiredVariants],
    checks: [...requirement.requiredChecks],
    failureCodes: [],
    runs,
    measurements: {
      caseCount: caseIds.length,
      runCount: runs.length,
      durationMs: sum("durationMs"),
      modelCalls: sum("modelCalls"),
      ptcCalls: sum("ptcCalls"),
      httpCalls: sum("httpCalls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      costMicros: sum("costMicros"),
    },
    evidenceFingerprint: "0".repeat(64),
  };
  value.evidenceFingerprint = await fingerprintChatReleaseCandidateProofV1(value);
  return value;
}

async function matrix(): Promise<ChatReleaseCandidateMatrixV1> {
  const value: ChatReleaseCandidateMatrixV1 = {
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    generatedAt: NOW.toISOString(),
    sourceRevision: SOURCE_REVISION,
    manifestFingerprint: await fingerprintChatReleaseCandidateManifestV1(),
    proofs: await Promise.all(CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.map(proof)),
    receiptFingerprint: "0".repeat(64),
  };
  value.receiptFingerprint = await fingerprintChatReleaseCandidateMatrixV1(value);
  return value;
}

async function evaluate(value: ChatReleaseCandidateMatrixV1) {
  return evaluateChatReleaseCandidateMatrixV1(value, { expectedSourceRevision: SOURCE_REVISION, now: NOW });
}

async function resign(value: ChatReleaseCandidateMatrixV1): Promise<void> {
  for (const proofValue of value.proofs) {
    for (const run of proofValue.runs) run.evidenceFingerprint = await fingerprintChatReleaseCandidateRunV1(run);
    proofValue.evidenceFingerprint = await fingerprintChatReleaseCandidateProofV1(proofValue);
  }
  value.receiptFingerprint = await fingerprintChatReleaseCandidateMatrixV1(value);
}

describe("release-candidate quality matrix contract", () => {
  test("accepts only a complete per-case, per-variant quality and lifecycle envelope", async () => {
    const result = await evaluate(await matrix());
    expect(result).toMatchObject({ passed: true, proofCount: CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.length, failedProofIds: [], failureCodes: [] });
    expect(result.aggregate.runCount).toBeGreaterThanOrEqual(60);
  });

  test("fails independently for missing case, run variant, lifecycle, MV3, and operator proof", async () => {
    const cases = [
      ["runtime-chat-quality", "case-coverage-missing"],
      ["runtime-deep-research-control", "run-coverage-missing"],
      ["packed-mv3-quality", "host-parity-failed"],
      ["packed-mv3-lifecycle", "lifecycle-failed"],
      ["private-operator-review", "operator-review-rejected"],
    ] as const;
    for (const [proofId, expectedFailure] of cases) {
      const value = await matrix();
      const target = value.proofs.find((entry) => entry.proofId === proofId)!;
      if (expectedFailure === "case-coverage-missing") {
        const removed = target.caseIds.pop()!;
        target.runs = target.runs.filter((run) => run.caseId !== removed);
        target.measurements.caseCount -= 1;
        target.measurements.runCount = target.runs.length;
        target.measurements.durationMs = target.runs.length * 1_000;
      } else if (expectedFailure === "run-coverage-missing") {
        target.runs.pop();
        target.measurements.runCount = target.runs.length;
        target.measurements.durationMs = target.runs.length * 1_000;
      } else {
        target.checks = [];
      }
      await resign(value);
      const result = await evaluate(value);
      expect(result.passed).toBe(false);
      expect(result.failureCodes).toContain(expectedFailure);
      expect(result.failedProofIds).toContain(proofId);
    }
  });

  test("requires only the explicit packed MV3 run pairs and rejects a missing pair", async () => {
    const value = await matrix();
    const packed = value.proofs.find((entry) => entry.proofId === "packed-mv3-quality")!;
    expect(packed.runs.map(({ caseId, variant }) => `${caseId}:${variant}`)).toEqual([
      "packed:exact-page:quick",
      "packed:exact-issue:quick",
      "packed:mode-simple:quick",
      "packed:mode-simple:auto",
      "packed:mode-simple:deep",
      "packed:mode-complex:quick",
      "packed:mode-complex:auto",
      "packed:mode-complex:deep",
      "packed:deep-research:deep-research",
      "packed:host-parity:deep-research",
    ]);
    packed.runs.splice(4, 1);
    packed.measurements.runCount = packed.runs.length;
    packed.measurements.durationMs = packed.runs.length * 1_000;
    await resign(value);
    expect((await evaluate(value)).failureCodes).toContain("run-coverage-missing");
  });

  test("rejects stale, foreign-revision, manifest, receipt, proof, and run fingerprints", async () => {
    for (const mutate of [
      (value: ChatReleaseCandidateMatrixV1) => { value.generatedAt = "2026-08-01T00:00:00.000Z"; },
      (value: ChatReleaseCandidateMatrixV1) => { value.sourceRevision = "2".repeat(40); },
      (value: ChatReleaseCandidateMatrixV1) => { value.manifestFingerprint = "b".repeat(64); },
      (value: ChatReleaseCandidateMatrixV1) => { value.receiptFingerprint = "c".repeat(64); },
      (value: ChatReleaseCandidateMatrixV1) => { value.proofs[0]!.evidenceFingerprint = "d".repeat(64); },
      (value: ChatReleaseCandidateMatrixV1) => { value.proofs[0]!.runs[0]!.evidenceFingerprint = "e".repeat(64); },
    ]) {
      const value = await matrix();
      mutate(value);
      const result = await evaluate(value);
      expect(result.passed).toBe(false);
      expect(result.failureCodes.some((code) => ["stale-proof", "source-revision-mismatch", "manifest-mismatch", "fingerprint-mismatch"].includes(code))).toBe(true);
    }
  });

  test("enforces blocking latency and cost ceilings from individual runs", async () => {
    const value = await matrix();
    const live = value.proofs.find((entry) => entry.proofId === "private-cli-quality")!;
    live.runs.find((run) => run.variant === "deep")!.measurements.durationMs = 181_000;
    live.runs.find((run) => run.variant === "auto")!.measurements.costMicros = 2_000_001;
    live.measurements.durationMs += 180_000;
    live.measurements.costMicros += 2_000_000;
    await resign(value);
    const result = await evaluate(value);
    expect(result.failureCodes).toContain("latency-exceeded");
    expect(result.failureCodes).toContain("cost-exceeded");
  });

  test("propagates blocking answer-quality failures from a concrete run", async () => {
    const value = await matrix();
    const runtime = value.proofs.find((entry) => entry.proofId === "runtime-chat-quality")!;
    const run = runtime.runs[0]!;
    run.status = "failed";
    run.failureCodes = ["wrong-source"];
    run.checks.find((entry) => entry.check === "source-selection")!.status = "failed";
    runtime.status = "failed";
    runtime.failureCodes = ["wrong-source"];
    runtime.checks = runtime.checks.filter((check) => check !== "source-selection");
    await resign(value);
    const result = await evaluate(value);
    expect(result.passed).toBe(false);
    expect(result.failureCodes).toContain("wrong-source");
  });

  test("rejects free-form, tenant, URL, identifying private ID, and mismatched aggregates", async () => {
    const base = await proof(CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1[0]!);
    for (const forbidden of [
      { question: "private question" }, { answer: "private answer" },
      { tenantOrigin: "https://tenant.example" }, { sourceUrls: ["https://tenant.example/wiki"] },
      { reviewerText: "looks good" },
    ]) {
      expect(() => parseChatReleaseCandidateProofV1({ ...base, ...forbidden })).toThrow("contract");
    }
    expect(() => parseChatReleaseCandidateProofV1({ ...base, caseIds: ["private:CUSTOMER"] })).toThrow("case ID");
    expect(() => parseChatReleaseCandidateProofV1({ ...base, measurements: { ...base.measurements, caseCount: 999 } })).not.toThrow();
    const value = await matrix();
    value.proofs[0]!.measurements.caseCount = 999;
    await resign(value);
    expect((await evaluate(value)).failureCodes).toContain("command-failed");
    expect(() => parseChatReleaseCandidateProofV1({ ...base, checks: [...CHAT_RELEASE_CANDIDATE_CHECKS_V1, "raw-content-reviewed"] })).toThrow("checks");
  });
});
