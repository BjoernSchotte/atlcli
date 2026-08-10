import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";

export const CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1 =
  "atlcli.chat-release-candidate-matrix/v1" as const;
export const CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1 =
  "atlcli.chat-release-candidate-proof/v1" as const;
export const CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1 =
  "atlcli.chat-release-candidate-run/v1" as const;

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
  "required-fact-coverage",
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
  "answer-integrity",
] as const;
export type ChatReleaseCandidateCheckV1 =
  (typeof CHAT_RELEASE_CANDIDATE_CHECKS_V1)[number];

export const CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1 = [
  "command-failed",
  "case-coverage-missing",
  "run-coverage-missing",
  "variant-coverage-missing",
  "wrong-source",
  "detail-coverage-missing",
  "unsupported-claim",
  "citation-invalid",
  "required-fact-missing",
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
  "source-revision-mismatch",
  "manifest-mismatch",
  "fingerprint-mismatch",
  "stale-proof",
  "latency-exceeded",
  "cost-exceeded",
  "answer-integrity-failed",
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

export interface ChatReleaseCandidateCheckResultV1 {
  check: ChatReleaseCandidateCheckV1;
  status: "passed" | "not-applicable" | "failed";
}

export interface ChatReleaseCandidateRunV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1;
  caseId: string;
  variant: ChatReleaseCandidateVariantV1;
  status: "passed" | "failed";
  checks: ChatReleaseCandidateCheckResultV1[];
  failureCodes: ChatReleaseCandidateFailureCodeV1[];
  measurements: {
    durationMs: number;
    modelCalls?: number;
    ptcCalls?: number;
    httpCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
  };
  evidenceFingerprint: string;
}

export interface ChatReleaseCandidateProofV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1;
  proofId: ChatReleaseCandidateProofIdV1;
  producer:
    | "bun-production-runtime"
    | "packed-production-mv3"
    | "private-cli-runner"
    | "installed-production-mv3"
    | "operator-review";
  producedAt: string;
  sourceRevision: string;
  manifestFingerprint: string;
  status: "passed" | "failed";
  caseIds: string[];
  variants: ChatReleaseCandidateVariantV1[];
  checks: ChatReleaseCandidateCheckV1[];
  failureCodes: ChatReleaseCandidateFailureCodeV1[];
  runs: ChatReleaseCandidateRunV1[];
  measurements: {
    caseCount: number;
    runCount: number;
    durationMs: number;
    modelCalls: number;
    ptcCalls: number;
    httpCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  };
  evidenceFingerprint: string;
}

export interface ChatReleaseCandidateMatrixV1 {
  schema: typeof CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1;
  generatedAt: string;
  sourceRevision: string;
  manifestFingerprint: string;
  proofs: ChatReleaseCandidateProofV1[];
  receiptFingerprint: string;
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
    costMicros: number;
  };
}

interface ProofRequirementV1 {
  proofId: ChatReleaseCandidateProofIdV1;
  producer: ChatReleaseCandidateProofV1["producer"];
  minimumCases: number;
  requiredCaseIds?: readonly string[];
  requiredRuns?: readonly {
    caseId: string;
    variant: ChatReleaseCandidateVariantV1;
  }[];
  requiredVariants: readonly ChatReleaseCandidateVariantV1[];
  requiredChecks: readonly ChatReleaseCandidateCheckV1[];
  maximumDurationMs: Partial<Record<ChatReleaseCandidateVariantV1, number>>;
  maximumCostMicros?: Partial<Record<ChatReleaseCandidateVariantV1, number>>;
}

const GOLD_CASE_IDS = CHAT_RECOVERY_GOLD_SCENARIOS_V1.map((scenario) => scenario.id);

const CHAT_LIMITS = Object.freeze({ quick: 120_000, auto: 180_000, deep: 180_000 });
const ALL_LIMITS = Object.freeze({ ...CHAT_LIMITS, "deep-research": 600_000 });
const LIVE_COST_LIMITS = Object.freeze({
  quick: 500_000,
  auto: 2_000_000,
  deep: 2_000_000,
  "deep-research": 2_000_000,
});

export const CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1: readonly ProofRequirementV1[] = Object.freeze([
  {
    proofId: "runtime-chat-quality",
    producer: "bun-production-runtime",
    minimumCases: GOLD_CASE_IDS.length,
    requiredCaseIds: GOLD_CASE_IDS,
    requiredVariants: ["quick", "auto", "deep"],
    requiredChecks: [
      "source-selection", "detail-coverage", "citation-support", "claim-support",
      "relationship-coverage", "contradiction-coverage", "gap-disclosure", "outcome",
      "strategy", "no-false-completeness", "mode-isolation",
    ],
    maximumDurationMs: CHAT_LIMITS,
  },
  {
    proofId: "runtime-deep-research-control",
    producer: "bun-production-runtime",
    minimumCases: 3,
    requiredCaseIds: [
      "research:single-worker-control",
      "research:parallel-workers-control",
      "research:reconciliation-control",
    ],
    requiredVariants: ["deep-research"],
    requiredChecks: [
      "source-selection", "detail-coverage", "citation-support", "claim-support",
      "gap-disclosure", "outcome", "mode-isolation",
    ],
    maximumDurationMs: { "deep-research": 600_000 },
  },
  {
    proofId: "packed-mv3-quality",
    producer: "packed-production-mv3",
    minimumCases: 6,
    requiredRuns: [
      { caseId: "packed:exact-page", variant: "quick" },
      { caseId: "packed:exact-issue", variant: "quick" },
      { caseId: "packed:mode-simple", variant: "quick" },
      { caseId: "packed:mode-simple", variant: "auto" },
      { caseId: "packed:mode-simple", variant: "deep" },
      { caseId: "packed:mode-complex", variant: "quick" },
      { caseId: "packed:mode-complex", variant: "auto" },
      { caseId: "packed:mode-complex", variant: "deep" },
      { caseId: "packed:deep-research", variant: "deep-research" },
      { caseId: "packed:host-parity", variant: "deep-research" },
    ],
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "source-selection", "detail-coverage", "citation-support", "outcome", "strategy",
      "mode-isolation", "host-parity", "credential-redaction", "safe-markdown",
    ],
    maximumDurationMs: ALL_LIMITS,
  },
  {
    proofId: "packed-mv3-lifecycle",
    producer: "packed-production-mv3",
    minimumCases: 6,
    requiredRuns: [
      { caseId: "lifecycle:three-turn", variant: "quick" },
      { caseId: "lifecycle:hitl", variant: "quick" },
      { caseId: "lifecycle:steering", variant: "deep" },
      { caseId: "lifecycle:stop", variant: "auto" },
      { caseId: "lifecycle:stream-recovery", variant: "auto" },
      { caseId: "lifecycle:worker-recreation", variant: "deep" },
    ],
    requiredVariants: ["quick", "auto", "deep"],
    requiredChecks: [
      "three-turn-new-acquisition", "hitl-resume", "steering", "stop",
      "stream-recovery", "worker-recreation",
    ],
    maximumDurationMs: CHAT_LIMITS,
  },
  {
    proofId: "private-cli-quality",
    producer: "private-cli-runner",
    minimumCases: 2,
    requiredRuns: [
      { caseId: "private:CASE01", variant: "quick" },
      { caseId: "private:CASE01", variant: "auto" },
      { caseId: "private:CASE01", variant: "deep" },
      { caseId: "private:CASE02", variant: "quick" },
      { caseId: "private:CASE02", variant: "auto" },
      { caseId: "private:CASE02", variant: "deep" },
      { caseId: "private:CASE02", variant: "deep-research" },
    ],
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "source-selection", "citation-support", "required-fact-coverage", "claim-support", "outcome", "mode-isolation",
      "three-turn-new-acquisition", "follow-up-coherence", "answer-integrity",
    ],
    maximumDurationMs: ALL_LIMITS,
    maximumCostMicros: LIVE_COST_LIMITS,
  },
  {
    proofId: "private-installed-mv3",
    producer: "installed-production-mv3",
    minimumCases: 2,
    requiredRuns: [
      { caseId: "private:CASE01", variant: "quick" },
      { caseId: "private:CASE01", variant: "auto" },
      { caseId: "private:CASE02", variant: "deep" },
    ],
    requiredVariants: ["quick", "auto", "deep"],
    requiredChecks: [
      "source-selection", "citation-support", "outcome", "mode-isolation", "visible-activity",
    ],
    maximumDurationMs: CHAT_LIMITS,
    maximumCostMicros: LIVE_COST_LIMITS,
  },
  {
    proofId: "private-operator-review",
    producer: "operator-review",
    minimumCases: 2,
    requiredRuns: [
      { caseId: "private:CASE01", variant: "quick" },
      { caseId: "private:CASE01", variant: "auto" },
      { caseId: "private:CASE01", variant: "deep" },
      { caseId: "private:CASE02", variant: "quick" },
      { caseId: "private:CASE02", variant: "auto" },
      { caseId: "private:CASE02", variant: "deep" },
      { caseId: "private:CASE02", variant: "deep-research" },
    ],
    requiredVariants: ["quick", "auto", "deep", "deep-research"],
    requiredChecks: [
      "usefulness", "source-selection", "citation-support", "visible-activity",
      "follow-up-coherence", "latency-cost-tradeoff",
    ],
    maximumDurationMs: ALL_LIMITS,
  },
]);

const PRIVATE_CASE_ID = /^private:CASE[0-9]{2,4}$/u;
const PUBLIC_CASE_ID = /^(?:chat-gold|research|packed|lifecycle):[a-z0-9][a-z0-9:-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{40}$/u;
const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withoutFingerprint<T extends { evidenceFingerprint: string }>(value: T): Omit<T, "evidenceFingerprint"> {
  const { evidenceFingerprint: _ignored, ...rest } = value;
  return rest;
}

export async function fingerprintChatReleaseCandidateRunV1(
  run: ChatReleaseCandidateRunV1,
): Promise<string> {
  return sha256(withoutFingerprint(run));
}

export async function fingerprintChatReleaseCandidateProofV1(
  proof: ChatReleaseCandidateProofV1,
): Promise<string> {
  return sha256(withoutFingerprint(proof));
}

export async function finalizeChatReleaseCandidateRunV1(
  input: Omit<ChatReleaseCandidateRunV1, "evidenceFingerprint">,
): Promise<ChatReleaseCandidateRunV1> {
  const run: ChatReleaseCandidateRunV1 = {
    ...structuredClone(input),
    evidenceFingerprint: "0".repeat(64),
  };
  run.evidenceFingerprint = await fingerprintChatReleaseCandidateRunV1(run);
  return parseChatReleaseCandidateRunV1(run);
}

export async function finalizeChatReleaseCandidateProofV1(input: {
  proofId: ChatReleaseCandidateProofIdV1;
  producer: ChatReleaseCandidateProofV1["producer"];
  producedAt: string;
  sourceRevision: string;
  manifestFingerprint: string;
  runs: readonly ChatReleaseCandidateRunV1[];
}): Promise<ChatReleaseCandidateProofV1> {
  const runs = input.runs.map((run) => structuredClone(run));
  const proof: ChatReleaseCandidateProofV1 = {
    schema: CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
    proofId: input.proofId,
    producer: input.producer,
    producedAt: input.producedAt,
    sourceRevision: input.sourceRevision,
    manifestFingerprint: input.manifestFingerprint,
    status: runs.every((run) => run.status === "passed") ? "passed" : "failed",
    caseIds: [...new Set(runs.map((run) => run.caseId))].sort(),
    variants: [...new Set(runs.map((run) => run.variant))].sort(),
    checks: [...new Set(runs.flatMap((run) =>
      run.checks.filter((entry) => entry.status === "passed").map((entry) => entry.check)
    ))].sort(),
    failureCodes: [...new Set(runs.flatMap((run) => run.failureCodes))].sort(),
    runs,
    measurements: sumsForRuns(runs),
    evidenceFingerprint: "0".repeat(64),
  };
  proof.evidenceFingerprint = await fingerprintChatReleaseCandidateProofV1(proof);
  return parseChatReleaseCandidateProofV1(proof);
}

export async function fingerprintChatReleaseCandidateManifestV1(): Promise<string> {
  return sha256({
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    requirements: CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1,
    scenarios: CHAT_RECOVERY_GOLD_SCENARIOS_V1,
  });
}

export async function fingerprintChatReleaseCandidateMatrixV1(
  matrix: ChatReleaseCandidateMatrixV1,
): Promise<string> {
  const { receiptFingerprint: _ignored, ...rest } = matrix;
  return sha256(rest);
}

function uniqueKnown<T extends string>(values: unknown, allowed: readonly T[], label: string): T[] {
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

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return new Date(value).toISOString();
}

function parseCaseId(value: unknown): string {
  if (typeof value !== "string" || !(PRIVATE_CASE_ID.test(value) || PUBLIC_CASE_ID.test(value))) {
    throw new Error("Release candidate case ID is invalid.");
  }
  return value;
}

function parseRunMeasurements(value: unknown): ChatReleaseCandidateRunV1["measurements"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release run measurements are invalid.");
  const record = value as Record<string, unknown>;
  const allowed = ["durationMs", "modelCalls", "ptcCalls", "httpCalls", "inputTokens", "outputTokens", "costMicros"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Release run measurements contain an unknown field.");
  const parsed: ChatReleaseCandidateRunV1["measurements"] = {
    durationMs: boundedCount(record.durationMs, "Release run durationMs"),
  };
  for (const key of allowed.slice(1) as Array<Exclude<keyof ChatReleaseCandidateRunV1["measurements"], "durationMs">>) {
    if (record[key] !== undefined) parsed[key] = boundedCount(record[key], `Release run ${key}`);
  }
  return parsed;
}

function parseCheckResults(value: unknown): ChatReleaseCandidateCheckResultV1[] {
  if (!Array.isArray(value)) throw new Error("Release run checks are invalid.");
  const checks = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Release run check is invalid.");
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["check", "status"].includes(key)) ||
        !CHAT_RELEASE_CANDIDATE_CHECKS_V1.includes(record.check as ChatReleaseCandidateCheckV1) ||
        !["passed", "not-applicable", "failed"].includes(record.status as string)) {
      throw new Error("Release run check is invalid.");
    }
    return { check: record.check as ChatReleaseCandidateCheckV1, status: record.status as ChatReleaseCandidateCheckResultV1["status"] };
  });
  if (new Set(checks.map((entry) => entry.check)).size !== checks.length) throw new Error("Release run checks contain duplicates.");
  return checks;
}

export function parseChatReleaseCandidateRunV1(value: unknown): ChatReleaseCandidateRunV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release candidate run is invalid.");
  const record = value as Record<string, unknown>;
  const fields = ["schema", "caseId", "variant", "status", "checks", "failureCodes", "measurements", "evidenceFingerprint"];
  if (Object.keys(record).some((key) => !fields.includes(key)) || record.schema !== CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1 ||
      !CHAT_RELEASE_CANDIDATE_VARIANTS_V1.includes(record.variant as ChatReleaseCandidateVariantV1) ||
      !["passed", "failed"].includes(record.status as string) || typeof record.evidenceFingerprint !== "string" ||
      !SHA256.test(record.evidenceFingerprint)) {
    throw new Error("Release candidate run contract is invalid.");
  }
  return {
    schema: CHAT_RELEASE_CANDIDATE_RUN_SCHEMA_V1,
    caseId: parseCaseId(record.caseId),
    variant: record.variant as ChatReleaseCandidateVariantV1,
    status: record.status as ChatReleaseCandidateRunV1["status"],
    checks: parseCheckResults(record.checks),
    failureCodes: uniqueKnown(record.failureCodes, CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1, "Release run failure codes"),
    measurements: parseRunMeasurements(record.measurements),
    evidenceFingerprint: record.evidenceFingerprint,
  };
}

function parseProofMeasurements(value: unknown): ChatReleaseCandidateProofV1["measurements"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release proof measurements are invalid.");
  const record = value as Record<string, unknown>;
  const keys = ["caseCount", "runCount", "durationMs", "modelCalls", "ptcCalls", "httpCalls", "inputTokens", "outputTokens", "costMicros"] as const;
  if (Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))) throw new Error("Release proof measurements contain an unknown field.");
  return Object.fromEntries(keys.map((key) => [key, boundedCount(record[key], `Release proof ${key}`)])) as unknown as ChatReleaseCandidateProofV1["measurements"];
}

export function parseChatReleaseCandidateProofV1(value: unknown): ChatReleaseCandidateProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release candidate proof is invalid.");
  const record = value as Record<string, unknown>;
  const fields = [
    "schema", "proofId", "producer", "producedAt", "sourceRevision", "manifestFingerprint", "status",
    "caseIds", "variants", "checks", "failureCodes", "runs", "measurements", "evidenceFingerprint",
  ];
  if (Object.keys(record).some((key) => !fields.includes(key)) || record.schema !== CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1 ||
      !CHAT_RELEASE_CANDIDATE_PROOF_IDS_V1.includes(record.proofId as ChatReleaseCandidateProofIdV1)) {
    throw new Error("Release candidate proof contract is invalid.");
  }
  const requirement = CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.find((entry) => entry.proofId === record.proofId)!;
  if (record.producer !== requirement.producer || !["passed", "failed"].includes(record.status as string) ||
      typeof record.sourceRevision !== "string" || !GIT_REVISION.test(record.sourceRevision) ||
      typeof record.manifestFingerprint !== "string" || !SHA256.test(record.manifestFingerprint) ||
      typeof record.evidenceFingerprint !== "string" || !SHA256.test(record.evidenceFingerprint) || !Array.isArray(record.runs)) {
    throw new Error("Release candidate proof authority is invalid.");
  }
  const caseIds = (record.caseIds as unknown[] | undefined)?.map(parseCaseId);
  if (!caseIds?.length || new Set(caseIds).size !== caseIds.length) throw new Error("Release candidate proof case IDs are invalid.");
  return {
    schema: CHAT_RELEASE_CANDIDATE_PROOF_SCHEMA_V1,
    proofId: record.proofId as ChatReleaseCandidateProofIdV1,
    producer: record.producer as ChatReleaseCandidateProofV1["producer"],
    producedAt: parseTimestamp(record.producedAt, "Release proof producedAt"),
    sourceRevision: record.sourceRevision,
    manifestFingerprint: record.manifestFingerprint,
    status: record.status as ChatReleaseCandidateProofV1["status"],
    caseIds,
    variants: uniqueKnown(record.variants, CHAT_RELEASE_CANDIDATE_VARIANTS_V1, "Release proof variants"),
    checks: uniqueKnown(record.checks, CHAT_RELEASE_CANDIDATE_CHECKS_V1, "Release proof checks"),
    failureCodes: uniqueKnown(record.failureCodes, CHAT_RELEASE_CANDIDATE_FAILURE_CODES_V1, "Release proof failure codes"),
    runs: record.runs.map(parseChatReleaseCandidateRunV1),
    measurements: parseProofMeasurements(record.measurements),
    evidenceFingerprint: record.evidenceFingerprint,
  };
}

export function parseChatReleaseCandidateMatrixV1(value: unknown): ChatReleaseCandidateMatrixV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release candidate matrix is invalid.");
  const record = value as Record<string, unknown>;
  const fields = ["schema", "generatedAt", "sourceRevision", "manifestFingerprint", "proofs", "receiptFingerprint"];
  if (Object.keys(record).some((key) => !fields.includes(key)) || record.schema !== CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1 ||
      typeof record.sourceRevision !== "string" || !GIT_REVISION.test(record.sourceRevision) ||
      typeof record.manifestFingerprint !== "string" || !SHA256.test(record.manifestFingerprint) ||
      typeof record.receiptFingerprint !== "string" || !SHA256.test(record.receiptFingerprint) || !Array.isArray(record.proofs)) {
    throw new Error("Release candidate matrix contract is invalid.");
  }
  const proofs = record.proofs.map(parseChatReleaseCandidateProofV1);
  if (new Set(proofs.map((proof) => proof.proofId)).size !== proofs.length) throw new Error("Release candidate matrix contains duplicate proof identities.");
  return {
    schema: CHAT_RELEASE_CANDIDATE_MATRIX_SCHEMA_V1,
    generatedAt: parseTimestamp(record.generatedAt, "Release matrix generatedAt"),
    sourceRevision: record.sourceRevision,
    manifestFingerprint: record.manifestFingerprint,
    proofs,
    receiptFingerprint: record.receiptFingerprint,
  };
}

function sumsForRuns(runs: readonly ChatReleaseCandidateRunV1[]): ChatReleaseCandidateProofV1["measurements"] {
  const sum = (key: keyof ChatReleaseCandidateRunV1["measurements"]) =>
    runs.reduce((total, run) => total + (run.measurements[key] ?? 0), 0);
  return {
    caseCount: new Set(runs.map((run) => run.caseId)).size,
    runCount: runs.length,
    durationMs: sum("durationMs"),
    modelCalls: sum("modelCalls"),
    ptcCalls: sum("ptcCalls"),
    httpCalls: sum("httpCalls"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costMicros: sum("costMicros"),
  };
}

function sameNumbers(left: Record<string, number>, right: Record<string, number>): boolean {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export async function evaluateChatReleaseCandidateMatrixV1(
  value: unknown,
  options: { expectedSourceRevision: string; now?: Date },
): Promise<ChatReleaseCandidateMatrixResultV1> {
  if (!GIT_REVISION.test(options.expectedSourceRevision)) throw new Error("Expected source revision is invalid.");
  const matrix = parseChatReleaseCandidateMatrixV1(value);
  const now = options.now ?? new Date();
  const manifestFingerprint = await fingerprintChatReleaseCandidateManifestV1();
  const failureCodes = new Set<ChatReleaseCandidateFailureCodeV1>();
  const failedProofIds = new Set<ChatReleaseCandidateProofIdV1>();
  const byId = new Map(matrix.proofs.map((proof) => [proof.proofId, proof]));
  const aggregate = { caseCount: 0, runCount: 0, durationMs: 0, modelCalls: 0, ptcCalls: 0, httpCalls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };

  const generatedAt = Date.parse(matrix.generatedAt);
  if (generatedAt > now.getTime() + MAX_CLOCK_SKEW_MS || now.getTime() - generatedAt > MAX_PROOF_AGE_MS) failureCodes.add("stale-proof");
  if (matrix.sourceRevision !== options.expectedSourceRevision) failureCodes.add("source-revision-mismatch");
  if (matrix.manifestFingerprint !== manifestFingerprint) failureCodes.add("manifest-mismatch");
  if (matrix.receiptFingerprint !== await fingerprintChatReleaseCandidateMatrixV1(matrix)) failureCodes.add("fingerprint-mismatch");

  for (const requirement of CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1) {
    const proof = byId.get(requirement.proofId);
    if (!proof) {
      failedProofIds.add(requirement.proofId);
      failureCodes.add("case-coverage-missing");
      continue;
    }
    const calculated = sumsForRuns(proof.runs);
    for (const key of Object.keys(aggregate) as Array<keyof typeof aggregate>) aggregate[key] += calculated[key];
    let failed = proof.status !== "passed" || proof.failureCodes.length > 0;
    const producedAt = Date.parse(proof.producedAt);
    if (producedAt > generatedAt + MAX_CLOCK_SKEW_MS || generatedAt - producedAt > MAX_PROOF_AGE_MS) {
      failureCodes.add("stale-proof"); failed = true;
    }
    if (proof.sourceRevision !== matrix.sourceRevision) { failureCodes.add("source-revision-mismatch"); failed = true; }
    if (proof.manifestFingerprint !== manifestFingerprint) { failureCodes.add("manifest-mismatch"); failed = true; }
    if (proof.evidenceFingerprint !== await fingerprintChatReleaseCandidateProofV1(proof)) { failureCodes.add("fingerprint-mismatch"); failed = true; }
    if (!sameNumbers(calculated, proof.measurements)) { failureCodes.add("command-failed"); failed = true; }

    const derivedCaseIds = [...new Set(proof.runs.map((run) => run.caseId))].sort();
    const derivedVariants = [...new Set(proof.runs.map((run) => run.variant))].sort();
    const derivedChecks = [...new Set(proof.runs.flatMap((run) => run.checks.filter((entry) => entry.status === "passed").map((entry) => entry.check)))].sort();
    if (stableJson([...proof.caseIds].sort()) !== stableJson(derivedCaseIds) ||
        stableJson([...proof.variants].sort()) !== stableJson(derivedVariants) ||
        stableJson([...proof.checks].sort()) !== stableJson(derivedChecks)) {
      failureCodes.add("command-failed"); failed = true;
    }
    if (proof.caseIds.length < requirement.minimumCases || requirement.requiredCaseIds?.some((id) => !proof.caseIds.includes(id))) {
      failureCodes.add("case-coverage-missing"); failed = true;
    }
    if (requirement.requiredVariants.some((variant) => !proof.variants.includes(variant))) {
      failureCodes.add("variant-coverage-missing"); failed = true;
    }
    const expectedPairs = requirement.requiredRuns
      ? requirement.requiredRuns.map((run) => `${run.caseId}\u0000${run.variant}`)
      : proof.caseIds.flatMap((caseId) => requirement.requiredVariants.map((variant) => `${caseId}\u0000${variant}`));
    const actualPairs = new Set(proof.runs.map((run) => `${run.caseId}\u0000${run.variant}`));
    if (expectedPairs.some((pair) => !actualPairs.has(pair)) || actualPairs.size !== proof.runs.length) {
      failureCodes.add("run-coverage-missing"); failed = true;
    }
    if (requirement.requiredChecks.some((check) => !proof.checks.includes(check))) {
      failureCodes.add(requirement.proofId === "private-operator-review" ? "operator-review-rejected" : requirement.proofId.includes("lifecycle") ? "lifecycle-failed" : requirement.proofId.includes("mv3") ? "host-parity-failed" : "command-failed");
      failed = true;
    }
    for (const run of proof.runs) {
      if (run.evidenceFingerprint !== await fingerprintChatReleaseCandidateRunV1(run)) { failureCodes.add("fingerprint-mismatch"); failed = true; }
      const requiredStatuses = new Map(run.checks.map((entry) => [entry.check, entry.status]));
      if (requirement.requiredChecks.some((check) => !requiredStatuses.has(check) || requiredStatuses.get(check) === "failed")) {
        failureCodes.add("command-failed"); failed = true;
      }
      if (run.status !== "passed" || run.failureCodes.length > 0 || run.checks.some((entry) => entry.status === "failed")) failed = true;
      const latencyLimit = requirement.maximumDurationMs[run.variant];
      if (latencyLimit !== undefined && run.measurements.durationMs > latencyLimit) { failureCodes.add("latency-exceeded"); failed = true; }
      const costLimit = requirement.maximumCostMicros?.[run.variant];
      if (costLimit !== undefined && (run.measurements.costMicros === undefined || run.measurements.costMicros > costLimit)) { failureCodes.add("cost-exceeded"); failed = true; }
      for (const code of run.failureCodes) failureCodes.add(code);
    }
    for (const code of proof.failureCodes) failureCodes.add(code);
    if (failed) failedProofIds.add(proof.proofId);
  }

  if (failureCodes.has("stale-proof") || failureCodes.has("source-revision-mismatch") || failureCodes.has("manifest-mismatch") || failureCodes.has("fingerprint-mismatch")) {
    for (const proof of matrix.proofs) failedProofIds.add(proof.proofId);
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
