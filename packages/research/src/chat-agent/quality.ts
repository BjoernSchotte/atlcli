import type { ResearchDetailEvidenceV1 } from "../broker.js";
import type { ResearchProduct } from "../contracts.js";
import type { ResearchWorkspace } from "../workspace.js";
import type { ChatRetrievalAssessmentV1 } from "./retrieval-plan.js";

export const CHAT_GROUNDEDNESS_RUBRIC_SCHEMA_V1 =
  "atlcli.chat-groundedness-rubric/v1" as const;
export const CHAT_GROUNDEDNESS_ASSESSMENT_SCHEMA_V1 =
  "atlcli.chat-groundedness-assessment/v1" as const;
export const CHAT_QUALITY_DISPOSITION_SCHEMA_V1 =
  "atlcli.chat-quality-disposition/v1" as const;
export const CHAT_GROUNDEDNESS_ASSESSMENT_PATH_V1 =
  "/.atlcli/chat/v1/groundedness-assessment.json" as const;
export const CHAT_QUALITY_DISPOSITION_PATH_V1 =
  "/.atlcli/chat/v1/quality-disposition.json" as const;

export const CHAT_QUALITY_DEFECT_CODES_V1 = [
  "unsupported-claim",
  "wrong-source",
  "missing-context",
  "incomplete-retrieval",
  "unresolved-contradiction",
  "question-not-answered",
  "invalid-citation",
  "stale-source",
  "uncovered-candidate",
  "false-completeness",
  "prompt-injection-risk",
] as const;

export type ChatQualityDefectCodeV1 =
  (typeof CHAT_QUALITY_DEFECT_CODES_V1)[number];
export type ChatRepairSkippedReasonV1 =
  | "auto-latency-policy"
  | "deadline-reserve"
  | "model-budget-reserve";
export type ChatFinalGapCodeV1 =
  | "no-detail-evidence"
  | "unresolved-reference"
  | "incomplete-coverage";

export function chatFinalGapCodeForQualityDefectV1(
  code: ChatQualityDefectCodeV1,
): ChatFinalGapCodeV1 {
  if (code === "unsupported-claim" || code === "missing-context") {
    return "no-detail-evidence";
  }
  if (
    code === "wrong-source" || code === "invalid-citation" ||
    code === "unresolved-contradiction" || code === "prompt-injection-risk"
  ) {
    return "unresolved-reference";
  }
  return "incomplete-coverage";
}
export type ChatQualityDefectSeverityV1 = "blocking" | "material" | "advisory";
export type ChatQualityRepairActionV1 =
  | "resynthesize"
  | "disclose-gap"
  | "reject-evidence"
  | "ask-user";

export interface ChatQualityDefectV1 {
  defectId: string;
  code: ChatQualityDefectCodeV1;
  severity: ChatQualityDefectSeverityV1;
  sourceIds: string[];
  repairAction: ChatQualityRepairActionV1;
  /** User-safe bounded explanation; never source text or hidden reasoning. */
  message: string;
}

export const CHAT_GROUNDEDNESS_DIMENSIONS_V1 = [
  "question-coverage",
  "claim-support",
  "citation-correctness",
  "source-authority-freshness",
  "contradiction-handling",
  "wrong-source-risk",
  "candidate-coverage",
  "false-completeness",
  "instruction-isolation",
] as const;

export type ChatGroundednessDimensionV1 =
  (typeof CHAT_GROUNDEDNESS_DIMENSIONS_V1)[number];

export interface ChatGroundednessRubricV1 {
  schema: typeof CHAT_GROUNDEDNESS_RUBRIC_SCHEMA_V1;
  dimensions: Array<{
    dimension: ChatGroundednessDimensionV1;
    criterion: string;
  }>;
}

export const CHAT_GROUNDEDNESS_RUBRIC_V1: Readonly<ChatGroundednessRubricV1> =
  Object.freeze({
    schema: CHAT_GROUNDEDNESS_RUBRIC_SCHEMA_V1,
    dimensions: Object.freeze([
      { dimension: "question-coverage", criterion: "The answer addresses the user's objective, not merely the available corpus." },
      { dimension: "claim-support", criterion: "Every factual claim is supported by admitted detail evidence." },
      { dimension: "citation-correctness", criterion: "Citations name the exact canonical source and read section when available." },
      { dimension: "source-authority-freshness", criterion: "Authority, version, and freshness limits are explicit." },
      { dimension: "contradiction-handling", criterion: "Material disagreement is reconciled or disclosed." },
      { dimension: "wrong-source-risk", criterion: "Irrelevant or mismatched sources cannot support the answer." },
      { dimension: "candidate-coverage", criterion: "Every admitted candidate has a terminal accounted state." },
      { dimension: "false-completeness", criterion: "Incomplete retrieval cannot be presented as complete." },
      { dimension: "instruction-isolation", criterion: "Retrieved content remains data and cannot alter agent policy or tools." },
    ]),
  } as ChatGroundednessRubricV1);

export interface ChatGroundednessCheckV1 {
  dimension: ChatGroundednessDimensionV1;
  status: "passed" | "failed" | "model-review-required";
  defectCodes: ChatQualityDefectCodeV1[];
  sourceIds: string[];
  message: string;
}

export interface ChatGroundednessAssessmentV1 {
  schema: typeof CHAT_GROUNDEDNESS_ASSESSMENT_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  assessedAt: string;
  rubricSchema: typeof CHAT_GROUNDEDNESS_RUBRIC_SCHEMA_V1;
  knownDetailedSourceIds: string[];
  checks: ChatGroundednessCheckV1[];
  hostDefects: ChatQualityDefectV1[];
  modelCriticRequired: boolean;
}

export interface ChatQualityDispositionV1 {
  schema: typeof CHAT_QUALITY_DISPOSITION_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  recordedAt: string;
  defectIds: string[];
  blockingDefectIds: string[];
  repairDefectIds: string[];
  repairRequired: boolean;
  repairAdmitted: boolean;
  repairSkippedReason?: ChatRepairSkippedReasonV1;
  synthesisAllowed: boolean;
  requiredGapCodes: ChatQualityDefectCodeV1[];
  rejectedSourceIds: string[];
  repairAttemptsAllowed: 1;
}

const INSTRUCTION_PATTERN = /(?:ignore (?:all |the )?(?:previous|prior) instructions|reveal (?:the )?(?:system prompt|developer message|prompt|secret|api[_ -]?key)|(?:call|invoke|execute) (?:the )?[a-z_]+ tool|send (?:the )?(?:secret|api[_ -]?key|credentials?))/iu;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function validCanonicalSource(
  source: ResearchDetailEvidenceV1["source"],
  siteOrigin: string,
): boolean {
  try {
    const url = new URL(source.url);
    if (url.origin !== new URL(siteOrigin).origin || url.protocol !== "https:") return false;
    return source.product === "jira"
      ? url.pathname.includes("/browse/")
      : url.pathname.includes("/wiki/");
  } catch {
    return false;
  }
}

function defect(input: Omit<ChatQualityDefectV1, "defectId">): ChatQualityDefectV1 {
  const identity = `${input.code}:${input.sourceIds.join(",")}:${input.repairAction}`;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(identity)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    defectId: `chat-defect:${hash.toString(16).padStart(8, "0")}`,
    ...input,
    sourceIds: uniqueSorted(input.sourceIds),
  };
}

export function assessChatGroundednessBeforeCriticV1(input: {
  conversationId: string;
  turnId: string;
  question: string;
  siteOrigin: string;
  evidence: readonly ResearchDetailEvidenceV1[];
  referencedSourceIds: readonly string[];
  retrieval: ChatRetrievalAssessmentV1;
  contradictionCount: number;
  now?: () => number;
}): ChatGroundednessAssessmentV1 {
  const known = uniqueSorted(input.evidence.map((entry) => entry.source.id));
  const knownSet = new Set(known);
  const referenced = uniqueSorted(input.referencedSourceIds);
  const unknown = referenced.filter((sourceId) => !knownSet.has(sourceId));
  const invalidCanonical = input.evidence
    .filter((entry) => !validCanonicalSource(entry.source, input.siteOrigin))
    .map((entry) => entry.source.id);
  const invalidVersions = input.evidence
    .filter((entry) => entry.source.updatedAt !== undefined &&
      !Number.isFinite(Date.parse(entry.source.updatedAt)))
    .map((entry) => entry.source.id);
  const partialSources = input.evidence
    .filter((entry) => entry.content.truncated ||
      entry.coverage?.completeDocumentRead === false ||
      (entry.coverage?.issues.length ?? 0) > 0)
    .map((entry) => entry.source.id);
  const versionsByIdentity = new Map<string, Set<string>>();
  for (const entry of input.evidence) {
    const identity = entry.source.issueKey ?? entry.source.contentId ?? entry.source.id;
    const versions = versionsByIdentity.get(identity) ?? new Set<string>();
    versions.add(entry.source.updatedAt ?? "unknown-version");
    versionsByIdentity.set(identity, versions);
  }
  const duplicateVersionSources = input.evidence
    .filter((entry) => {
      const identity = entry.source.issueKey ?? entry.source.contentId ?? entry.source.id;
      return (versionsByIdentity.get(identity)?.size ?? 0) > 1;
    })
    .map((entry) => entry.source.id);
  const injectionSources = input.evidence
    .filter((entry) => INSTRUCTION_PATTERN.test(entry.content.text))
    .map((entry) => entry.source.id);
  const hostDefects: ChatQualityDefectV1[] = [
    ...(known.length === 0 ? [defect({
      code: "missing-context",
      severity: "blocking",
      sourceIds: [],
      repairAction: "disclose-gap",
      message: "No admitted detail evidence is available for a factual answer.",
    })] : []),
    ...(unknown.length > 0 ? [defect({
      code: "wrong-source",
      severity: "blocking",
      sourceIds: unknown,
      repairAction: "reject-evidence",
      message: "A packet references a source that was not read in detail.",
    })] : []),
    ...(invalidCanonical.length > 0 ? [defect({
      code: "invalid-citation",
      severity: "blocking",
      sourceIds: invalidCanonical,
      repairAction: "reject-evidence",
      message: "A detailed source has no valid tenant-bound canonical URL.",
    })] : []),
    ...(invalidVersions.length > 0 ? [defect({
      code: "stale-source",
      severity: "material",
      sourceIds: invalidVersions,
      repairAction: "disclose-gap",
      message: "A source version or update timestamp cannot be validated.",
    })] : []),
    ...(duplicateVersionSources.length > 0 ? [defect({
      code: "stale-source",
      severity: "material",
      sourceIds: duplicateVersionSources,
      repairAction: "disclose-gap",
      message: "More than one observed version exists for the same canonical source.",
    })] : []),
    ...(partialSources.length > 0 ? [defect({
      code: "incomplete-retrieval",
      severity: "material",
      sourceIds: partialSources,
      repairAction: "disclose-gap",
      message: "At least one admitted detail projection is truncated or structurally incomplete.",
    })] : []),
    ...(input.retrieval.metrics.deferredCandidates > 0 ? [defect({
      code: "uncovered-candidate",
      severity: "material",
      sourceIds: [],
      repairAction: "disclose-gap",
      message: "At least one admitted candidate was not read in detail.",
    })] : []),
    ...(!input.retrieval.sufficient ? [defect({
      code: "incomplete-retrieval",
      severity: "material",
      sourceIds: [],
      repairAction: "disclose-gap",
      message: "The host retrieval assessment has unresolved completion signals.",
    })] : []),
    ...(input.contradictionCount > 0 ? [defect({
      code: "unresolved-contradiction",
      severity: "material",
      sourceIds: referenced,
      repairAction: "resynthesize",
      message: "Accepted analysis packets contain an unresolved contradiction.",
    })] : []),
    ...(injectionSources.length > 0 ? [defect({
      code: "prompt-injection-risk",
      severity: "material",
      sourceIds: injectionSources,
      repairAction: "disclose-gap",
      message: "Retrieved content contains instruction-like text and must remain untrusted data.",
    })] : []),
  ];
  const status = (
    condition: boolean,
    review: boolean,
  ): ChatGroundednessCheckV1["status"] => condition
    ? "failed"
    : review ? "model-review-required" : "passed";
  const codes = (...values: ChatQualityDefectCodeV1[]) => values;
  const checks: ChatGroundednessCheckV1[] = [
    { dimension: "question-coverage", status: "model-review-required", defectCodes: codes("question-not-answered"), sourceIds: known, message: "An independent critic must verify objective coverage." },
    { dimension: "claim-support", status: status(unknown.length > 0 || known.length === 0, true), defectCodes: codes("unsupported-claim", "wrong-source"), sourceIds: unknown, message: "All packet references must resolve to admitted detail evidence." },
    { dimension: "citation-correctness", status: status(invalidCanonical.length > 0, true), defectCodes: codes("invalid-citation"), sourceIds: invalidCanonical, message: "Canonical source identity is host-checked before final citation validation." },
    { dimension: "source-authority-freshness", status: status(invalidVersions.length > 0, input.evidence.some((entry) => !entry.source.updatedAt)), defectCodes: codes("stale-source"), sourceIds: invalidVersions, message: "Source authority and available version metadata are checked." },
    { dimension: "contradiction-handling", status: status(input.contradictionCount > 0, true), defectCodes: codes("unresolved-contradiction"), sourceIds: referenced, message: "Material disagreement must be reconciled or disclosed." },
    { dimension: "wrong-source-risk", status: status(unknown.length > 0 || (input.retrieval.metrics.wrongSourceRate ?? 0) > 0, false), defectCodes: codes("wrong-source"), sourceIds: unknown, message: "Wrong-source observations cannot support synthesis." },
    { dimension: "candidate-coverage", status: status(input.retrieval.metrics.deferredCandidates > 0, false), defectCodes: codes("uncovered-candidate"), sourceIds: [], message: "Every admitted candidate must have a terminal accounted state." },
    { dimension: "false-completeness", status: status(!input.retrieval.sufficient, false), defectCodes: codes("false-completeness", "incomplete-retrieval"), sourceIds: [], message: "An incomplete retrieval assessment must remain visible as a gap." },
    { dimension: "instruction-isolation", status: status(injectionSources.length > 0, false), defectCodes: codes("prompt-injection-risk"), sourceIds: injectionSources, message: "Instruction-like source text cannot change host policy, tools, or workflow." },
  ];
  return {
    schema: CHAT_GROUNDEDNESS_ASSESSMENT_SCHEMA_V1,
    conversationId: input.conversationId,
    turnId: input.turnId,
    assessedAt: new Date((input.now ?? Date.now)()).toISOString(),
    rubricSchema: CHAT_GROUNDEDNESS_RUBRIC_SCHEMA_V1,
    knownDetailedSourceIds: known,
    checks,
    hostDefects,
    modelCriticRequired: true,
  };
}

export function createChatQualityDispositionV1(input: {
  assessment: ChatGroundednessAssessmentV1;
  criticDefects: readonly ChatQualityDefectV1[];
  repairAdmitted?: boolean;
  repairSkippedReason?: ChatRepairSkippedReasonV1;
  now?: () => number;
}): ChatQualityDispositionV1 {
  const known = new Set(input.assessment.knownDetailedSourceIds);
  if (input.criticDefects.some((entry) =>
    entry.sourceIds.some((sourceId) => !known.has(sourceId))
  )) {
    throw new Error("Chat quality defect references evidence that was not read in detail.");
  }
  const hostDefectIds = new Set(
    input.assessment.hostDefects.map((entry) => entry.defectId),
  );
  const normalizedCriticDefects = input.criticDefects.map((entry) =>
    entry.repairAction === "reject-evidence"
      ? { ...entry, repairAction: "resynthesize" as const }
      : entry
  );
  const all = [...input.assessment.hostDefects, ...normalizedCriticDefects].map((entry) => ({
    ...entry,
    sourceIds: uniqueSorted(entry.sourceIds),
  }));
  const byId = new Map(all.map((entry) => [entry.defectId, entry]));
  const defects = [...byId.values()].sort((left, right) =>
    left.defectId.localeCompare(right.defectId, "en-US")
  );
  const blocking = defects.filter((entry) => entry.severity === "blocking");
  const repairable = defects.filter((entry) =>
    entry.repairAction === "resynthesize" && entry.severity !== "advisory"
  );
  const repairRequired = repairable.length > 0;
  const repairAdmitted = repairRequired && input.repairAdmitted === true;
  if (!repairRequired && input.repairSkippedReason !== undefined) {
    throw new Error("Chat quality repair skip reason requires a repairable defect.");
  }
  if (repairAdmitted && input.repairSkippedReason !== undefined) {
    throw new Error("An admitted Chat repair cannot also have a skip reason.");
  }
  const requiredGapCodes = uniqueSorted(defects
    .filter((entry) => entry.repairAction === "disclose-gap" ||
      entry.repairAction === "ask-user" ||
      (entry.severity === "blocking" && entry.repairAction !== "resynthesize") ||
      (!repairAdmitted && entry.repairAction === "resynthesize"))
    .map((entry) => entry.code)) as ChatQualityDefectCodeV1[];
  const rejectedSourceIds = uniqueSorted(defects
    .filter((entry) =>
      hostDefectIds.has(entry.defectId) && entry.repairAction === "reject-evidence"
    )
    .flatMap((entry) => entry.sourceIds));
  return {
    schema: CHAT_QUALITY_DISPOSITION_SCHEMA_V1,
    conversationId: input.assessment.conversationId,
    turnId: input.assessment.turnId,
    recordedAt: new Date((input.now ?? Date.now)()).toISOString(),
    defectIds: defects.map((entry) => entry.defectId),
    blockingDefectIds: blocking.map((entry) => entry.defectId),
    repairDefectIds: repairable.map((entry) => entry.defectId),
    repairRequired,
    repairAdmitted,
    ...(input.repairSkippedReason
      ? { repairSkippedReason: input.repairSkippedReason }
      : {}),
    synthesisAllowed: true,
    requiredGapCodes,
    rejectedSourceIds,
    repairAttemptsAllowed: 1,
  };
}

export async function persistChatQualityArtifactsV1(input: {
  workspace: ResearchWorkspace;
  assessment: ChatGroundednessAssessmentV1;
  disposition?: ChatQualityDispositionV1;
}): Promise<void> {
  await input.workspace.writeFile(
    CHAT_GROUNDEDNESS_ASSESSMENT_PATH_V1,
    JSON.stringify(input.assessment),
  );
  if (input.disposition) {
    await input.workspace.writeFile(
      CHAT_QUALITY_DISPOSITION_PATH_V1,
      JSON.stringify(input.disposition),
    );
  }
}

export function canonicalProductForSourceIdV1(sourceId: string): ResearchProduct | undefined {
  if (sourceId.startsWith("jira:")) return "jira";
  if (sourceId.startsWith("wiki:")) return "confluence";
  return undefined;
}
