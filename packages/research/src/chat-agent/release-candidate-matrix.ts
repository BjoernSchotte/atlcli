import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";

export const CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1 =
  "atlcli.chat-release-candidate-matrix/v1" as const;
export const CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1 =
  "atlcli.chat-release-candidate-proof/v1" as const;

export const CHAT_RELEASE_CANDIDATE_VARIANTS_V1 = [
  "quick",
  "auto",
  "deep",
  "deep-research",
] as const;
export type ChatReleaseCandidateVariantV1 =
  (typeof CHAT_RELEASE_CANDIDATE_VARIANTS_V1)[number];

export const CHAT_RELEASE_CANDIDATE_CHECKS_V1 = [
  "source-selection",
  "detail-coverage",
  "citation-support",
  "claim-support",
  "relationship-coverage",
  "contradiction-coverage",
  "gap-disclosure",
  "outcome",
  "strategy",
  "no-false-completeness",
  "mode-isolation",
  "three-turn-new-acquisition",
  "hitl-resume",
  "steering",
  "stop",
  "stream-recovery",
  "worker-recreation",
  "credential-redaction",
  "safe-markdown",
  "host-parity",
  "usefulness",
  "visible-activity",
  "follow-up-coherence",
  "latency-cost-tradeoff",
] as const;
export type ChatReleaseCandidateCheckV1 =
  (typeof CHAT_RELEASE_CANDIDATE_CHECKS_V1)[number];

export const CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1 = [
  "command-failed",
  "case-coverage-missing",
  "variant-coverage-missing",
  "wrong-source",
  "detail-coverage-missing",
  "unsupported-claim",
  "citation-invalid",
  "relationship-missed",
  "contradiction-missed",
  "gap-missed",
  "false-completeness",
  "outcome-incorrect",
  "strategy-incorrect",
  "mode-isolation-failed",
  "lifecycle-failed",
  "host-parity-failed",
  "operator-review-rejected",
  "privacy-rejected",
] as const;
export type ChatReleaseCandidateFailureCodeV1 =
  (typeof CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1)[number];

export const CHAT_RELEASE_CANDIDATE_PROOF_IDS_V1 = [
  "runtime-chat-quality",
  "runtime-deep-research-control",
  "packed-mv3-quality",
  "packed-mv3-lifecycle",
  "private-cli-quality",
  "private-installed-mv3",
  "private-operator-review",
] as const;
export type ChatReleaseCandidateProofIdV1 =
  (typeof CHAT_RELEASE_CANDIDATE_PROOF_IDS_V1)[number];

export interface ChatReleaseCandidateProofV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1;
  proofId: ChatReleaseCandidateProofIdV1;
  producer:
    | "bun-production-runtime"
    | "packed-production-mv3"
    | "private-cli-runner"
    | "installed-production-mv3"
    | "operator-review";
  status: "passed" | "failed";
  caseIds: string[];
  variants: ChatReleaseCandidateVariantV1[];
  checks: ChatReleaseCandidateCheckV1[];
  failureCodes: ChatReleaseCandidateFailureCodeV1[];
  measurements: {
    caseCount: number;
    runCount: number;
    durationMs: number;
    modelCalls?: number;
    ptcCalls?: number;
    httpCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    maximumCostMicros?: number;
  };
  evidenceFingerprint: string;
}

export interface ChatReleaseCandidateMatrixV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1;
  generatedAt: string;
  proofs: ChatReleaseCandidateProofV1[];
}

export interface ChatReleaseCandidateMatrixResultV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1;
  passed: boolean;
  proofCount: number;
  failedProofIds: ChatReleaseCandidateProofIdV1[];
  failureCodes: ChatReleaseCandidateFailureCodeV1[];
  aggregate: {
    caseCount: number;
    runCount: number;
    durationMs: number;
    modelCalls: number;
    ptcCalls: number;
    httpCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}

interface ProofRequirementV1 {
  proofId: ChatReleaseCandidateProofIdV1;
  producer: ChatReleaseCandidateProofV1["producer"];
  minimumCases: number;
  requiredCaseIds?: readonly string[];
  requiredVariants: readonly ChatReleaseCandidateVariantV1[];
  requiredChecks: readonly ChatReleaseCandidateCheckV1[];
}

const GOLD_CASE_IDS = CHAT_RECOVERY_GOLD_SCENARIOS_V1.map((scenario) => scenario.id);

export const CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1 = Object.freeze([
  {
    proofId: "runtime-chat-quality",
    producer: "bun-production-runtime",
    minimumCases: GOLD_CASE_IDS.length,
    requiredCaseIds: GOLD_CASE_IDS,
    requiredVariants: ["quick", "auto", "deep"],
    requiredChecks: [
      "source-selection",
      "detail-coverage",
      "citation-support",
      "claim-support",
      "relationship-coverage",
      "contradiction-coverage",
      "gap-disclosure",
      "outcome",
      "strategy",
      "no-false-completeness",
      "mode-isolation",
    ],
  },
  {
    proofId: "runtime-deep-research-control",
    producer: "bun-production-runtime",
    minimumCases: 3,
    requiredVariants: ["deep-research"],
    requiredChecks: [
      "source-selection",
      "detail-coverage",
      "citation-support",
      "claim-support",
      "gap-disclosure",
      "outcome",
      "mode-isolation",
    ],
  },
  {
    proofId: "packed-mv3-quality",
    producer: "packed-production-mv3",
    minimumCases: 4,
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "source-selection",
      "detail-coverage",
      "citation-support",
      "outcome",
      "strategy",
      "mode-isolation",
      "host-parity",
      "credential-redaction",
      "safe-markdown",
    ],
  },
  {
    proofId: "packed-mv3-lifecycle",
    producer: "packed-production-mv3",
    minimumCases: 6,
    requiredVariants: ["auto", "deep"],
    requiredChecks: [
      "three-turn-new-acquisition",
      "hitl-resume",
      "steering",
      "stop",
      "stream-recovery",
      "worker-recreation",
    ],
  },
  {
    proofId: "private-cli-quality",
    producer: "private-cli-runner",
    minimumCases: 2,
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "source-selection",
      "citation-support",
      "claim-support",
      "outcome",
      "mode-isolation",
      "three-turn-new-acquisition",
      "follow-up-coherence",
    ],
  },
  {
    proofId: "private-installed-mv3",
    producer: "installed-production-mv3",
    minimumCases: 2,
    requiredVariants: ["quick", "auto", "deep"],
    requiredChecks: [
      "source-selection",
      "citation-support",
      "outcome",
      "mode-isolation",
      "visible-activity",
    ],
  },
  {
    proofId: "private-operator-review",
    producer: "operator-review",
    minimumCases: 2,
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "usefulness",
      "source-selection",
      "citation-support",
      "visible-activity",
      "follow-up-coherence",
      "latency-cost-tradeoff",
    ],
  },
] satisfies readonly ProofRequirementV1[]);

const PRIVATE_CASE_ID = /^private:[A-Z][A-Z0-9_-]{0,39}$/u;
const PUBLIC_CASE_ID = /^(?:chat-gold|packed|lifecycle):[a-z0-9][a-z0-9:-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function uniqueKnown<T extends string>(
  values: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !allowed.includes(value as T))) {
    throw new Error(`${label} is invalid.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates.`);
  return [...values] as T[];
}

function boundedCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseMeasurements(value: unknown): ChatReleaseCandidateProofV1["measurements"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release proof measurements are invalid.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "caseCount", "runCount", "durationMs", "modelCalls", "ptcCalls", "httpCalls",
    "inputTokens", "outputTokens", "maximumCostMicros",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Release proof measurements contain an unknown field.");
  }
  const parsed: ChatReleaseCandidateProofV1["measurements"] = {
    caseCount: boundedCount(record.caseCount, "Release proof caseCount"),
    runCount: boundedCount(record.runCount, "Release proof runCount"),
    durationMs: boundedCount(record.durationMs, "Release proof durationMs"),
  };
  for (const key of [
    "modelCalls", "ptcCalls", "httpCalls", "inputTokens", "outputTokens",
    "maximumCostMicros",
  ] as const) {
    if (record[key] !== undefined) parsed[key] = boundedCount(record[key], `Release proof ${key}`);
  }
  return parsed;
}

export function parseChatReleaseCandidateProofV1(value: unknown): ChatReleaseCandidateProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release candidate proof is invalid.");
  }
  const record = value as Record<string, unknown>;
  const fields = [
    "schema", "proofId", "producer", "status", "caseIds", "variants", "checks",
    "failureCodes", "measurements", "evidenceFingerprint",
  ];
  if (Object.keys(record).some((key) => !fields.includes(key)) ||
      record.schema !== CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1 ||
      !CHAT_RELEASE_CANDIDATE_PROOF_IDS_V1.includes(record.proofId as ChatReleaseCandidateProofIdV1)) {
    throw new Error("Release candidate proof contract is invalid.");
  }
  const requirement = CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.find((entry) => entry.proofId === record.proofId)!;
  if (record.producer !== requirement.producer ||
      (record.status !== "passed" && record.status !== "failed") ||
      typeof record.evidenceFingerprint !== "string" || !SHA256.test(record.evidenceFingerprint)) {
    throw new Error("Release candidate proof authority is invalid.");
  }
  if (!Array.isArray(record.caseIds) || record.caseIds.length === 0 ||
      record.caseIds.some((id) => typeof id !== "string" ||
        !(PRIVATE_CASE_ID.test(id) || PUBLIC_CASE_ID.test(id)))) {
    throw new Error("Release candidate proof case IDs are invalid.");
  }
  if (new Set(record.caseIds).size !== record.caseIds.length) {
    throw new Error("Release candidate proof case IDs contain duplicates.");
  }
  const measurements = parseMeasurements(record.measurements);
  if (measurements.caseCount !== record.caseIds.length) {
    throw new Error("Release proof caseCount does not match its case identities.");
  }
  return {
    schema: CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
    proofId: record.proofId as ChatReleaseCandidateProofIdV1,
    producer: record.producer as ChatReleaseCandidateProofV1["producer"],
    status: record.status,
    caseIds: [...record.caseIds] as string[],
    variants: uniqueKnown(record.variants, CHAT_RELEASE_CANDIDATE_VARIANTS_V1, "Release proof variants"),
    checks: uniqueKnown(record.checks, CHAT_RELEASE_CANDIDATE_CHECKS_V1, "Release proof checks"),
    failureCodes: uniqueKnown(record.failureCodes, CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1, "Release proof failure codes"),
    measurements,
    evidenceFingerprint: record.evidenceFingerprint,
  };
}

export function parseChatReleaseCandidateMatrixV1(value: unknown): ChatReleaseCandidateMatrixV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release candidate matrix is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema", "generatedAt", "proofs"].includes(key)) ||
      record.schema !== CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1 ||
      typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt)) ||
      !Array.isArray(record.proofs)) {
    throw new Error("Release candidate matrix contract is invalid.");
  }
  const proofs = record.proofs.map(parseChatReleaseCandidateProofV1);
  if (new Set(proofs.map((proof) => proof.proofId)).size !== proofs.length) {
    throw new Error("Release candidate matrix contains duplicate proof identities.");
  }
  return {
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    generatedAt: new Date(record.generatedAt).toISOString(),
    proofs,
  };
}

export function evaluateChatReleaseCandidateMatrixV1(
  value: unknown,
): ChatReleaseCandidateMatrixResultV1 {
  const matrix = parseChatReleaseCandidateMatrixV1(value);
  const failureCodes = new Set<ChatReleaseCandidateFailureCodeV1>();
  const failedProofIds = new Set<ChatReleaseCandidateProofIdV1>();
  const byId = new Map(matrix.proofs.map((proof) => [proof.proofId, proof]));
  const aggregate = {
    caseCount: 0,
    runCount: 0,
    durationMs: 0,
    modelCalls: 0,
    ptcCalls: 0,
    httpCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  for (const requirement of CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1) {
    const proof = byId.get(requirement.proofId);
    if (!proof) {
      failedProofIds.add(requirement.proofId);
      failureCodes.add("case-coverage-missing");
      continue;
    }
    for (const key of Object.keys(aggregate) as Array<keyof typeof aggregate>) {
      aggregate[key] += proof.measurements[key] ?? 0;
    }
    let failed = proof.status !== "passed" || proof.failureCodes.length > 0;
    if (proof.caseIds.length < requirement.minimumCases ||
        requirement.requiredCaseIds?.some((id) => !proof.caseIds.includes(id))) {
      failureCodes.add("case-coverage-missing");
      failed = true;
    }
    if (requirement.requiredVariants.some((variant) => !proof.variants.includes(variant))) {
      failureCodes.add("variant-coverage-missing");
      failed = true;
    }
    if (requirement.requiredChecks.some((check) => !proof.checks.includes(check))) {
      failureCodes.add(requirement.proofId === "private-operator-review"
        ? "operator-review-rejected"
        : requirement.proofId.includes("lifecycle")
          ? "lifecycle-failed"
          : requirement.proofId.includes("mv3")
            ? "host-parity-failed"
            : "command-failed");
      failed = true;
    }
    for (const code of proof.failureCodes) failureCodes.add(code);
    if (failed) failedProofIds.add(proof.proofId);
  }

  return {
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    passed: failedProofIds.size === 0 && failureCodes.size === 0,
    proofCount: matrix.proofs.length,
    failedProofIds: [...failedProofIds].sort(),
    failureCodes: [...failureCodes].sort(),
    aggregate,
  };
}
