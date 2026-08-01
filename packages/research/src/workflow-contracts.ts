import {
  parseResearchAgentDraftV1,
  type ResearchAgentDraftV1,
} from "./agent-draft.js";
import { ResearchContractError } from "./contracts.js";
import type { ResearchGraphCapabilityV1 } from "./graph.js";
import type {
  ResearchResolvedEffortV1,
  ResearchScopeDiscoveryPolicyV1,
} from "./brief.js";
import type {
  ResearchClaimCandidateV2,
  ResearchEvidenceQuoteCandidateV2,
} from "./claim-candidate-normalizer.js";

export const RESEARCH_PACKET_BODY_SCHEMA_V1 =
  "atlcli.research-packet-body/v1" as const;
export const RESEARCH_PACKET_BODY_SCHEMA_V2 =
  "atlcli.research-packet-body/v2" as const;
export const RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2 =
  "atlcli.research-packet-reference-model/v2" as const;
export const RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1 =
  "atlcli.reconciliation-input/v1" as const;
export const RESEARCH_RECONCILIATION_BODY_SCHEMA_V1 =
  "atlcli.reconciliation-body/v1" as const;
export const RESEARCH_ACCEPTED_PACKET_SCHEMA_V1 =
  "atlcli.accepted-research-packet/v1" as const;
export const RESEARCH_TASK_ATTEMPT_SCHEMA_V1 =
  "atlcli.research-task-attempt/v1" as const;
export const RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1 =
  "atlcli.reconciliation-disposition/v1" as const;
export const RESEARCH_RECONCILIATION_DECISIONS_V1 = [
  "reject_defect",
  "revise",
  "downgrade",
  "add_follow_up",
  "abstain",
  "no_change",
] as const;
export const RESEARCH_RECONCILIATION_REASON_CODES_V1 = [
  "invalid_reference",
  "already_resolved",
  "supported_by_evidence",
  "material_defect",
  "insufficient_budget",
  "outside_approval_envelope",
] as const;
export const RESEARCH_APPROVAL_ENVELOPE_SCHEMA_V1 =
  "atlcli.research-approval-envelope/v1" as const;

export const RESEARCH_SUBAGENT_ROLE_IDS_V1 = [
  "focused-researcher",
  "document-distiller",
  "contradiction-verifier",
  "coverage-moderator",
  "outline-planner",
  "reconciler",
  "synthesizer",
] as const;
export type ResearchSubagentRoleIdV1 =
  (typeof RESEARCH_SUBAGENT_ROLE_IDS_V1)[number];

export type ResearchTaskOutputSchemaV1 =
  | typeof RESEARCH_PACKET_BODY_SCHEMA_V1
  | typeof RESEARCH_PACKET_BODY_SCHEMA_V2
  | typeof RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2
  | typeof RESEARCH_RECONCILIATION_BODY_SCHEMA_V1
  | "atlcli.research-agent-draft/v1";

export interface ResearchNodeBudgetV1 {
  maxCapabilityCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxResultBytes: number;
  maxDurationMs: number;
  maxCostMicros: number;
}

export type ResearchReconciliationTriggerV1 =
  | "multi_branch"
  | "low_coverage"
  | "contradiction"
  | "negative_claim"
  | "high_impact_claim"
  | "stale_or_truncated"
  | "user_requested";

export interface ResearchGraphReconciliationPolicyV1 {
  mode: "off" | "auto" | "required";
  triggers: ResearchReconciliationTriggerV1[];
  maxPasses: 0 | 1;
  minimumRemainingBudget: ResearchNodeBudgetV1;
}

export interface ResearchTaskUsageV1 {
  capabilityCalls: number;
  inputTokens: number;
  outputTokens: number;
  resultBytes: number;
  durationMs: number;
  costMicros: number;
}

const RESEARCH_BUDGET_KEYS_V1 = [
  "maxCapabilityCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxResultBytes",
  "maxDurationMs",
  "maxCostMicros",
] as const satisfies readonly (keyof ResearchNodeBudgetV1)[];

export function validateResearchNodeBudgetV1(
  budget: ResearchNodeBudgetV1,
  label = "Research node budget",
): void {
  for (const key of RESEARCH_BUDGET_KEYS_V1) {
    const value = budget[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      invalid(`${label} ${key} is invalid.`);
    }
  }
}

export function validateResearchTaskUsageV1(
  usage: ResearchTaskUsageV1,
  budget: ResearchNodeBudgetV1,
): void {
  validateResearchNodeBudgetV1(budget);
  const dimensions: Array<{
    usage: keyof ResearchTaskUsageV1;
    budget: keyof ResearchNodeBudgetV1;
  }> = [
    { usage: "capabilityCalls", budget: "maxCapabilityCalls" },
    { usage: "inputTokens", budget: "maxInputTokens" },
    { usage: "outputTokens", budget: "maxOutputTokens" },
    { usage: "resultBytes", budget: "maxResultBytes" },
    { usage: "durationMs", budget: "maxDurationMs" },
    { usage: "costMicros", budget: "maxCostMicros" },
  ];
  for (const dimension of dimensions) {
    const observed = usage[dimension.usage];
    if (!Number.isSafeInteger(observed) || observed < 0) {
      invalid(`Research task usage ${dimension.usage} is invalid.`);
    }
    if (observed > budget[dimension.budget]) {
      invalid(`Research task usage exceeds ${dimension.budget}.`);
    }
  }
}

export interface ResearchSubagentRoleV1 {
  id: ResearchSubagentRoleIdV1;
  description: string;
  phase: "acquisition" | "analysis" | "verification" | "reconciliation" | "synthesis";
  availableFromPhase: "T3" | "T5";
  allowedCapabilityIds: ResearchGraphCapabilityV1[];
  supportedOutputSchemas: ResearchTaskOutputSchemaV1[];
  maxBudget: ResearchNodeBudgetV1;
  mayProposeFollowUps: boolean;
}

const DEFAULT_ROLE_BUDGET_V1: ResearchNodeBudgetV1 = {
  maxCapabilityCalls: 16,
  maxInputTokens: 24_000,
  maxOutputTokens: 4_000,
  maxResultBytes: 64_000,
  maxDurationMs: 180_000,
  maxCostMicros: 2_000_000,
};

function role(
  input: Omit<ResearchSubagentRoleV1, "maxBudget"> & {
    maxBudget?: Partial<ResearchNodeBudgetV1>;
  },
): ResearchSubagentRoleV1 {
  return {
    ...input,
    maxBudget: { ...DEFAULT_ROLE_BUDGET_V1, ...input.maxBudget },
  };
}

/** Reviewed code registry. The supervisor selects roles; it cannot invent them. */
export const RESEARCH_SUBAGENT_ROLE_REGISTRY_V1: Readonly<
  Record<ResearchSubagentRoleIdV1, ResearchSubagentRoleV1>
> = {
  "focused-researcher": role({
    id: "focused-researcher",
    description: "Acquire bounded Jira or Confluence evidence for one focused branch.",
    phase: "acquisition",
    availableFromPhase: "T3",
    allowedCapabilityIds: [
      "jira.issue.search",
      "jira.issue.get",
      "wiki.search",
      "wiki.page.get",
      "jira.project.search",
      "wiki.space.search",
      "atlassian.reference.resolve",
    ],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1, RESEARCH_PACKET_BODY_SCHEMA_V2, RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2],
    mayProposeFollowUps: true,
  }),
  "document-distiller": role({
    id: "document-distiller",
    description: "Distill already accepted source projections without widening scope.",
    phase: "analysis",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1, RESEARCH_PACKET_BODY_SCHEMA_V2, RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2],
    mayProposeFollowUps: true,
  }),
  "contradiction-verifier": role({
    id: "contradiction-verifier",
    description: "Verify a bounded contradiction against approved read capabilities.",
    phase: "verification",
    availableFromPhase: "T3",
    allowedCapabilityIds: [
      "jira.issue.search",
      "jira.issue.get",
      "wiki.search",
      "wiki.page.get",
    ],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1, RESEARCH_PACKET_BODY_SCHEMA_V2, RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2],
    mayProposeFollowUps: true,
  }),
  "coverage-moderator": role({
    id: "coverage-moderator",
    description: "Assess bounded coverage and abstention gaps from accepted packets.",
    phase: "verification",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1, RESEARCH_PACKET_BODY_SCHEMA_V2, RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2],
    mayProposeFollowUps: true,
  }),
  "outline-planner": role({
    id: "outline-planner",
    description: "Propose a claim-linked report outline after the V2 evidence store exists.",
    phase: "analysis",
    availableFromPhase: "T5",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2],
    mayProposeFollowUps: false,
  }),
  reconciler: role({
    id: "reconciler",
    description: "Critique accepted packets in a fresh context and return typed defects.",
    phase: "reconciliation",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_RECONCILIATION_BODY_SCHEMA_V1],
    mayProposeFollowUps: true,
  }),
  synthesizer: role({
    id: "synthesizer",
    description: "Author the one typed report draft from accepted evidence and dispositions.",
    phase: "synthesis",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: ["atlcli.research-agent-draft/v1"],
    maxBudget: { maxOutputTokens: 8_000, maxResultBytes: 128_000 },
    mayProposeFollowUps: false,
  }),
};

export interface ResearchGapV1 {
  id: string;
  summary: string;
  targetId?: string;
  sourceIds: string[];
}

export interface ResearchFollowUpProposalV1 {
  id: string;
  objective: string;
  reasonCode:
    | "coverage_gap"
    | "contradiction"
    | "negative_claim"
    | "stale_or_truncated";
  sourceIds: string[];
}

export interface ResearchFindingCandidateV1 {
  id: string;
  classification: "fact" | "inference";
  summary: string;
  sourceIds: string[];
}

export interface ResearchRelationshipCandidateV1 {
  id: string;
  classification: "verified" | "hypothesis";
  jiraIssueKey: string;
  confluenceContentId: string;
  summary: string;
  sourceIds: string[];
}

export interface ResearchPacketBodyV1 {
  schema: typeof RESEARCH_PACKET_BODY_SCHEMA_V1;
  answeredQuestion: string;
  sourceIds: string[];
  findingCandidates: ResearchFindingCandidateV1[];
  relationshipCandidates: ResearchRelationshipCandidateV1[];
  gaps: ResearchGapV1[];
  proposedFollowUps: ResearchFollowUpProposalV1[];
  coverageLimits: string[];
  abstentionReason?: string;
}

/**
 * Ephemeral provider/model shape. Every `quote` must be resolved by the host
 * against private evidence before this response can enter the durable packet
 * journal. It must never be stored as an accepted packet body.
 */
export interface ResearchPacketModelBodyV2 {
  schema: typeof RESEARCH_PACKET_BODY_SCHEMA_V2;
  claimCandidates: ResearchClaimCandidateV2[];
  contradictionCandidates: Array<{
    id: string;
    claimCandidateIds: string[];
    summary: string;
  }>;
  outlineProposals: Array<{
    id: string;
    sectionId: string;
    title: string;
    question: string;
    claimCandidateIds: string[];
    dependsOnSectionIds: string[];
    coverageTargetIds: string[];
  }>;
  gaps: ResearchGapV1[];
  proposedFollowUps: ResearchFollowUpProposalV1[];
  coverageLimits: string[];
  abstentionReason?: string;
}

/**
 * Ephemeral analysis output. Unlike `ResearchPacketModelBodyV2`, this shape
 * cannot make a new factual claim: it can only arrange exact Claim IDs that
 * the host previously projected from admitted dependencies.
 */
export interface ResearchPacketReferenceModelBodyV2 {
  schema: typeof RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2;
  claimIds: string[];
  contradictions: Array<{
    id: string;
    claimIds: string[];
    summary: string;
  }>;
  outlineProposals: Array<{
    id: string;
    sectionId: string;
    title: string;
    question: string;
    claimIds: string[];
    dependsOnSectionIds: string[];
    coverageTargetIds: string[];
  }>;
  gaps: ResearchGapV1[];
  proposedFollowUps: ResearchFollowUpProposalV1[];
  coverageLimits: string[];
  abstentionReason?: string;
}

/**
 * Canonical accepted V2 packet. It contains only stable Claim/Evidence IDs
 * and host-derived spans; no model quote or caller-supplied hash/offset.
 */
export interface ResearchPacketBodyV2 {
  schema: typeof RESEARCH_PACKET_BODY_SCHEMA_V2;
  claims: Array<{
    candidateId: string;
    claimId: string;
  }>;
  /** Current claims carried forward by an analysis-only V2 node. */
  referencedClaimIds: string[];
  contradictions: Array<{
    id: string;
    claimIds: string[];
    evidenceIds: string[];
    summary: string;
  }>;
  outlineProposals: Array<{
    id: string;
    sectionId: string;
    title: string;
    question: string;
    claimIds: string[];
    evidenceIds: string[];
    dependsOnSectionIds: string[];
    coverageTargetIds: string[];
  }>;
  gaps: ResearchGapV1[];
  proposedFollowUps: ResearchFollowUpProposalV1[];
  coverageLimits: string[];
  abstentionReason?: string;
}

export interface ResearchReconciliationInputV1 {
  schema: typeof RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1;
  briefRevision: number;
  graphRevision: number;
  acceptedPacketRefs: string[];
  coverageTargetIds: string[];
  projection:
    | {
        kind: "v1-packet-set";
        findingCandidateIds: string[];
        relationshipCandidateIds: string[];
        gapIds: string[];
        sourceIds: string[];
      }
    | {
        /**
         * V2 exposes durable identities only. Reconciliation can challenge a
         * Claim or point to an Evidence record, but never receives source
         * text, model quotes, or a child agent's tool trajectory.
         */
        kind: "v2-claim-set";
        claimIds: string[];
        evidenceIds: string[];
        gapIds: string[];
      };
}

export type ResearchSupportRefV1 =
  | { kind: "source"; id: string }
  | { kind: "evidence"; id: string };

export interface ResearchReconciliationDefectV1 {
  id: string;
  severity: "blocking" | "important" | "minor";
  target: {
    kind: "finding" | "relationship" | "claim" | "section" | "node" | "coverage";
    id: string;
  };
  code:
    | "unsupported"
    | "contradicted"
    | "missing_coverage"
    | "overstated"
    | "instruction_mismatch"
    | "duplicate"
    | "stale";
  references: ResearchSupportRefV1[];
  explanation: string;
  suggestedAction: "accept" | "revise" | "downgrade" | "add_follow_up" | "abstain";
}

export interface ReconciliationBodyV1 {
  schema: typeof RESEARCH_RECONCILIATION_BODY_SCHEMA_V1;
  defects: ResearchReconciliationDefectV1[];
  proposedFollowUps: ResearchFollowUpProposalV1[];
}

export interface ResearchTaskAttemptV1 {
  schema: typeof RESEARCH_TASK_ATTEMPT_SCHEMA_V1;
  taskId: string;
  nodeId: string;
  graphRevision: number;
  attempt: number;
  executor: "ptc" | "subagent";
  roleId?: ResearchSubagentRoleIdV1;
  grantedCapabilityIds: ResearchGraphCapabilityV1[];
  typedIntentRefs: string[];
  expectedOutputSchema: ResearchTaskOutputSchemaV1;
  budget: ResearchNodeBudgetV1;
  status: "ready" | "running" | "outcome_unknown" | "complete" | "failed" | "cancelled" | "quarantined";
  dispatchState: "not_started" | "dispatch_started" | "result_committed" | "outcome_unknown";
  providerRequestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  acceptedPacketRef?: string;
  hostObservedUsage?: ResearchTaskUsageV1;
}

export interface ResearchAcceptedPacketV1 {
  schema: typeof RESEARCH_ACCEPTED_PACKET_SCHEMA_V1;
  packetRef: string;
  taskId: string;
  graphRevision: number;
  attempt: number;
  executor: "ptc" | "subagent";
  roleId?: ResearchSubagentRoleIdV1;
  grantedCapabilityIds: ResearchGraphCapabilityV1[];
  typedIntentRefs: string[];
  expectedOutputSchema: ResearchTaskOutputSchemaV1;
  body: ResearchPacketBodyV1 | ResearchPacketBodyV2 | ReconciliationBodyV1 | ResearchAgentDraftV1;
  hostObservedUsage: ResearchTaskUsageV1;
  acceptedAt: string;
}

/** Narrow a heterogeneous accepted task result to one canonical research packet. */
export function isResearchPacketBodyV1(
  body: ResearchAcceptedPacketV1["body"],
): body is ResearchPacketBodyV1 {
  return "schema" in body && body.schema === RESEARCH_PACKET_BODY_SCHEMA_V1;
}

/** Narrow a heterogeneous accepted task result to one canonical V2 research packet. */
export function isResearchPacketBodyV2(
  body: ResearchAcceptedPacketV1["body"],
): body is ResearchPacketBodyV2 {
  return "schema" in body && body.schema === RESEARCH_PACKET_BODY_SCHEMA_V2;
}

export interface ResearchReconciliationDispositionV1 {
  schema: typeof RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1;
  id: string;
  reconciliationPacketRef: string;
  defectId: string;
  basedOnGraphRevision: number;
  decision: (typeof RESEARCH_RECONCILIATION_DECISIONS_V1)[number];
  reasonCode: (typeof RESEARCH_RECONCILIATION_REASON_CODES_V1)[number];
  resultingGraphRevision?: number;
  resultingNodeId?: string;
  resultingClaimIds: string[];
  recordedAt: string;
}

export interface ResearchApprovalEnvelopeV1 {
  schema: typeof RESEARCH_APPROVAL_ENVELOPE_SCHEMA_V1;
  id: string;
  status: "proposed" | "approved";
  basedOnGraphRevision: number;
  basedOnBriefRevision: number;
  scopeFingerprint: string;
  scopeBindingFingerprint: string;
  allowedScopeBindingIds: string[];
  scopeDiscoveryPolicy: ResearchScopeDiscoveryPolicyV1;
  coverageTargetFingerprint: string;
  allowedCoverageTargetIds: string[];
  resolvedEffort: ResearchResolvedEffortV1;
  allowedRoleIds: ResearchSubagentRoleIdV1[];
  allowedCapabilityIds: ResearchGraphCapabilityV1[];
  totalBudgetCeiling: ResearchNodeBudgetV1;
  maxParallelNodes: number;
  maxResearchWaves: number;
  maxReconciliationWaves: number;
  maxDepth: 0 | 1;
  reconciliationPolicy: ResearchGraphReconciliationPolicyV1;
  approvedAt?: string;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-report", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    invalid(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array.`);
  const result = value.map((item, index) => boundedString(item, `${label}[${index}]`, 240));
  if (new Set(result).size !== result.length) invalid(`${label} must not contain duplicates.`);
  return result;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) invalid(`${label} contains an unexpected field: ${unexpected}.`);
}

function parseFindingCandidate(value: unknown): ResearchFindingCandidateV1 {
  const item = object(value, "Research finding candidate");
  assertKeys(item, ["id", "classification", "summary", "sourceIds"], "Research finding candidate");
  if (item.classification !== "fact" && item.classification !== "inference") invalid("Research finding candidate classification is invalid.");
  return {
    id: boundedString(item.id, "Research finding candidate id", 160),
    classification: item.classification,
    summary: boundedString(item.summary, "Research finding candidate summary", 800),
    sourceIds: stringArray(item.sourceIds, "Research finding candidate sourceIds", 12),
  };
}

function parseRelationshipCandidate(value: unknown): ResearchRelationshipCandidateV1 {
  const item = object(value, "Research relationship candidate");
  assertKeys(item, ["id", "classification", "jiraIssueKey", "confluenceContentId", "summary", "sourceIds"], "Research relationship candidate");
  if (item.classification !== "verified" && item.classification !== "hypothesis") invalid("Research relationship candidate classification is invalid.");
  return {
    id: boundedString(item.id, "Research relationship candidate id", 160),
    classification: item.classification,
    jiraIssueKey: boundedString(item.jiraIssueKey, "Research relationship Jira key", 80),
    confluenceContentId: boundedString(item.confluenceContentId, "Research relationship content id", 120),
    summary: boundedString(item.summary, "Research relationship summary", 800),
    sourceIds: stringArray(item.sourceIds, "Research relationship sourceIds", 12),
  };
}

function parseGap(value: unknown): ResearchGapV1 {
  const item = object(value, "Research gap");
  assertKeys(item, ["id", "summary", "targetId", "sourceIds"], "Research gap");
  return {
    id: boundedString(item.id, "Research gap id", 160),
    summary: boundedString(item.summary, "Research gap summary", 600),
    ...(item.targetId === undefined ? {} : { targetId: boundedString(item.targetId, "Research gap targetId", 160) }),
    sourceIds: stringArray(item.sourceIds, "Research gap sourceIds", 12),
  };
}

function parseFollowUp(value: unknown): ResearchFollowUpProposalV1 {
  const item = object(value, "Research follow-up proposal");
  assertKeys(item, ["id", "objective", "reasonCode", "sourceIds"], "Research follow-up proposal");
  const reasonCodes = ["coverage_gap", "contradiction", "negative_claim", "stale_or_truncated"] as const;
  if (!reasonCodes.includes(item.reasonCode as typeof reasonCodes[number])) invalid("Research follow-up reason code is invalid.");
  return {
    id: boundedString(item.id, "Research follow-up id", 160),
    objective: boundedString(item.objective, "Research follow-up objective", 1_000),
    reasonCode: item.reasonCode as typeof reasonCodes[number],
    sourceIds: stringArray(item.sourceIds, "Research follow-up sourceIds", 12),
  };
}

export function parseResearchPacketBodyV1(value: unknown): ResearchPacketBodyV1 {
  const packet = object(value, "Research packet body");
  assertKeys(packet, ["schema", "answeredQuestion", "sourceIds", "findingCandidates", "relationshipCandidates", "gaps", "proposedFollowUps", "coverageLimits", "abstentionReason"], "Research packet body");
  if (packet.schema !== RESEARCH_PACKET_BODY_SCHEMA_V1) invalid("Unsupported research packet body schema.");
  if (!Array.isArray(packet.findingCandidates) || packet.findingCandidates.length > 24) invalid("Research finding candidates are invalid.");
  if (!Array.isArray(packet.relationshipCandidates) || packet.relationshipCandidates.length > 24) invalid("Research relationship candidates are invalid.");
  if (!Array.isArray(packet.gaps) || packet.gaps.length > 16) invalid("Research gaps are invalid.");
  if (!Array.isArray(packet.proposedFollowUps) || packet.proposedFollowUps.length > 3) invalid("Research follow-up proposals are invalid.");
  const result: ResearchPacketBodyV1 = {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: boundedString(packet.answeredQuestion, "Research answered question", 2_000),
    sourceIds: stringArray(packet.sourceIds, "Research packet sourceIds", 64),
    findingCandidates: packet.findingCandidates.map(parseFindingCandidate),
    relationshipCandidates: packet.relationshipCandidates.map(parseRelationshipCandidate),
    gaps: packet.gaps.map(parseGap),
    proposedFollowUps: packet.proposedFollowUps.map(parseFollowUp),
    coverageLimits: stringArray(packet.coverageLimits, "Research coverage limits", 16),
    ...(packet.abstentionReason === undefined ? {} : { abstentionReason: boundedString(packet.abstentionReason, "Research abstention reason", 1_000) }),
  };
  const referenced = new Set([
    ...result.findingCandidates.flatMap((item) => item.sourceIds),
    ...result.relationshipCandidates.flatMap((item) => item.sourceIds),
    ...result.gaps.flatMap((item) => item.sourceIds),
    ...result.proposedFollowUps.flatMap((item) => item.sourceIds),
  ]);
  for (const sourceId of referenced) if (!result.sourceIds.includes(sourceId)) invalid("Research packet references an undeclared sourceId.");
  return result;
}

function requiredStringArray(value: unknown, label: string, maximum: number): string[] {
  const result = stringArray(value, label, maximum);
  if (result.length === 0) invalid(`${label} must not be empty.`);
  return result;
}

function claimReferenceId(value: unknown, label: string): string {
  const id = boundedString(value, label, 96);
  if (!/^claim:[a-f0-9]{48}$/.test(id)) invalid(`${label} is invalid.`);
  return id;
}

function evidenceReferenceId(value: unknown, label: string): string {
  const id = boundedString(value, label, 96);
  if (!/^evidence:[a-f0-9]{48}$/.test(id)) invalid(`${label} is invalid.`);
  return id;
}

function parseResearchQuoteCandidateV2(value: unknown): ResearchEvidenceQuoteCandidateV2 {
  const support = object(value, "Research V2 claim support");
  assertKeys(support, ["sourceId", "quote"], "Research V2 claim support");
  return {
    sourceId: boundedString(support.sourceId, "Research V2 claim support sourceId", 200),
    quote: boundedString(support.quote, "Research V2 claim support quote", 640),
  };
}

function parseResearchClaimCandidateV2(value: unknown): ResearchClaimCandidateV2 {
  const candidate = object(value, "Research V2 claim candidate");
  assertKeys(candidate, ["id", "classification", "summary", "support"], "Research V2 claim candidate");
  if (candidate.classification !== "fact" && candidate.classification !== "inference") {
    invalid("Research V2 claim candidate classification is invalid.");
  }
  if (!Array.isArray(candidate.support) || candidate.support.length === 0 || candidate.support.length > 12) {
    invalid("Research V2 claim candidate support is invalid.");
  }
  const support = candidate.support.map(parseResearchQuoteCandidateV2);
  const supportKeys = support.map((entry) => `${entry.sourceId}\u0000${entry.quote}`);
  if (new Set(supportKeys).size !== supportKeys.length) invalid("Research V2 claim candidate support is duplicated.");
  return {
    id: boundedString(candidate.id, "Research V2 claim candidate id", 160),
    classification: candidate.classification,
    summary: boundedString(candidate.summary, "Research V2 claim candidate summary", 2_000),
    support,
  };
}

/**
 * Parses the transient model result before the host turns each exact quote into
 * a private evidence span. Callers must not persist this return value.
 */
export function parseResearchPacketModelBodyV2(value: unknown): ResearchPacketModelBodyV2 {
  const packet = object(value, "Research V2 model packet body");
  assertKeys(packet, [
    "schema", "claimCandidates", "contradictionCandidates",
    "outlineProposals", "gaps", "proposedFollowUps", "coverageLimits",
    "abstentionReason",
  ], "Research V2 model packet body");
  if (packet.schema !== RESEARCH_PACKET_BODY_SCHEMA_V2 ||
      !Array.isArray(packet.claimCandidates) || packet.claimCandidates.length > 20 ||
      !Array.isArray(packet.contradictionCandidates) || packet.contradictionCandidates.length > 12 ||
      !Array.isArray(packet.outlineProposals) || packet.outlineProposals.length > 12 ||
      !Array.isArray(packet.gaps) || packet.gaps.length > 16 ||
      !Array.isArray(packet.proposedFollowUps) || packet.proposedFollowUps.length > 3) {
    invalid("Research V2 model packet body is invalid.");
  }
  const claimCandidates = packet.claimCandidates.map(parseResearchClaimCandidateV2);
  const candidateIds = new Set(claimCandidates.map((candidate) => candidate.id));
  if (candidateIds.size !== claimCandidates.length) invalid("Research V2 claim candidate IDs are duplicated.");
  const contradictionIds = new Set<string>();
  const contradictionCandidates = packet.contradictionCandidates.map((value) => {
    const candidate = object(value, "Research V2 contradiction candidate");
    assertKeys(candidate, ["id", "claimCandidateIds", "summary"], "Research V2 contradiction candidate");
    const id = boundedString(candidate.id, "Research V2 contradiction candidate id", 160);
    if (contradictionIds.has(id)) invalid("Research V2 contradiction candidate IDs are duplicated.");
    contradictionIds.add(id);
    const claimCandidateIds = requiredStringArray(candidate.claimCandidateIds, "Research V2 contradiction claim candidate IDs", 8);
    if (claimCandidateIds.length < 2 || claimCandidateIds.some((claimId) => !candidateIds.has(claimId))) {
      invalid("Research V2 contradiction references an unknown or insufficient claim candidate.");
    }
    return {
      id,
      claimCandidateIds,
      summary: boundedString(candidate.summary, "Research V2 contradiction summary", 1_200),
    };
  });
  const outlineIds = new Set<string>();
  const outlineProposals = packet.outlineProposals.map((value) => {
    const proposal = object(value, "Research V2 outline proposal");
    assertKeys(proposal, [
      "id", "sectionId", "title", "question", "claimCandidateIds",
      "dependsOnSectionIds", "coverageTargetIds",
    ], "Research V2 outline proposal");
    const id = boundedString(proposal.id, "Research V2 outline proposal id", 160);
    if (outlineIds.has(id)) invalid("Research V2 outline proposal IDs are duplicated.");
    outlineIds.add(id);
    const claimCandidateIds = stringArray(proposal.claimCandidateIds, "Research V2 outline claim candidate IDs", 20);
    if (claimCandidateIds.some((claimId) => !candidateIds.has(claimId))) {
      invalid("Research V2 outline references an unknown claim candidate.");
    }
    return {
      id,
      sectionId: boundedString(proposal.sectionId, "Research V2 outline section ID", 160),
      title: boundedString(proposal.title, "Research V2 outline title", 240),
      question: boundedString(proposal.question, "Research V2 outline question", 1_200),
      claimCandidateIds,
      dependsOnSectionIds: stringArray(proposal.dependsOnSectionIds, "Research V2 outline dependencies", 12),
      coverageTargetIds: stringArray(proposal.coverageTargetIds, "Research V2 outline coverage targets", 32),
    };
  });
  return {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claimCandidates,
    contradictionCandidates,
    outlineProposals,
    gaps: packet.gaps.map(parseGap),
    proposedFollowUps: packet.proposedFollowUps.map(parseFollowUp),
    coverageLimits: stringArray(packet.coverageLimits, "Research V2 coverage limits", 16),
    ...(packet.abstentionReason === undefined ? {} : { abstentionReason: boundedString(packet.abstentionReason, "Research V2 abstention reason", 1_000) }),
  };
}

/**
 * Parses an analysis-only V2 model packet. The subsequent host normalizer
 * verifies that every Claim ID belongs to an admitted dependency and is still
 * current before it derives the canonical V2 packet.
 */
export function parseResearchPacketReferenceModelBodyV2(
  value: unknown,
): ResearchPacketReferenceModelBodyV2 {
  const packet = object(value, "Research V2 reference model packet body");
  assertKeys(packet, [
    "schema", "claimIds", "contradictions", "outlineProposals", "gaps",
    "proposedFollowUps", "coverageLimits", "abstentionReason",
  ], "Research V2 reference model packet body");
  if (packet.schema !== RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2 ||
      !Array.isArray(packet.contradictions) || packet.contradictions.length > 12 ||
      !Array.isArray(packet.outlineProposals) || packet.outlineProposals.length > 12 ||
      !Array.isArray(packet.gaps) || packet.gaps.length > 16 ||
      !Array.isArray(packet.proposedFollowUps) || packet.proposedFollowUps.length > 3) {
    invalid("Research V2 reference model packet body is invalid.");
  }
  const claimIds = stringArray(packet.claimIds, "Research V2 reference claim IDs", 48)
    .map((claimId) => claimReferenceId(claimId, "Research V2 reference claim ID"));
  const knownClaims = new Set(claimIds);
  const contradictionIds = new Set<string>();
  const contradictions = packet.contradictions.map((value) => {
    const candidate = object(value, "Research V2 reference contradiction");
    assertKeys(candidate, ["id", "claimIds", "summary"], "Research V2 reference contradiction");
    const id = boundedString(candidate.id, "Research V2 reference contradiction ID", 160);
    if (contradictionIds.has(id)) invalid("Research V2 reference contradiction IDs are duplicated.");
    contradictionIds.add(id);
    const contradictionClaimIds = requiredStringArray(
      candidate.claimIds,
      "Research V2 reference contradiction claim IDs",
      8,
    ).map((claimId) => claimReferenceId(claimId, "Research V2 reference contradiction claim ID"));
    if (contradictionClaimIds.length < 2 || contradictionClaimIds.some((claimId) => !knownClaims.has(claimId))) {
      invalid("Research V2 reference contradiction references an unknown or insufficient claim.");
    }
    return {
      id,
      claimIds: contradictionClaimIds,
      summary: boundedString(candidate.summary, "Research V2 reference contradiction summary", 1_200),
    };
  });
  const proposalIds = new Set<string>();
  const outlineProposals = packet.outlineProposals.map((value) => {
    const proposal = object(value, "Research V2 reference outline proposal");
    assertKeys(proposal, [
      "id", "sectionId", "title", "question", "claimIds",
      "dependsOnSectionIds", "coverageTargetIds",
    ], "Research V2 reference outline proposal");
    const id = boundedString(proposal.id, "Research V2 reference outline proposal ID", 160);
    if (proposalIds.has(id)) invalid("Research V2 reference outline proposal IDs are duplicated.");
    proposalIds.add(id);
    const proposalClaimIds = stringArray(
      proposal.claimIds,
      "Research V2 reference outline claim IDs",
      20,
    ).map((claimId) => claimReferenceId(claimId, "Research V2 reference outline claim ID"));
    if (proposalClaimIds.some((claimId) => !knownClaims.has(claimId))) {
      invalid("Research V2 reference outline references an unknown claim.");
    }
    return {
      id,
      sectionId: boundedString(proposal.sectionId, "Research V2 reference outline section ID", 160),
      title: boundedString(proposal.title, "Research V2 reference outline title", 240),
      question: boundedString(proposal.question, "Research V2 reference outline question", 1_200),
      claimIds: proposalClaimIds,
      dependsOnSectionIds: stringArray(proposal.dependsOnSectionIds, "Research V2 reference outline dependencies", 12),
      coverageTargetIds: stringArray(proposal.coverageTargetIds, "Research V2 reference outline coverage targets", 32),
    };
  });
  return {
    schema: RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
    claimIds,
    contradictions,
    outlineProposals,
    gaps: packet.gaps.map(parseGap),
    proposedFollowUps: packet.proposedFollowUps.map(parseFollowUp),
    coverageLimits: stringArray(packet.coverageLimits, "Research V2 reference coverage limits", 16),
    ...(packet.abstentionReason === undefined
      ? {}
      : { abstentionReason: boundedString(packet.abstentionReason, "Research V2 reference abstention reason", 1_000) }),
  };
}

/** Parses the normalized V2 packet that is safe to retain in a task journal. */
export function parseResearchPacketBodyV2(value: unknown): ResearchPacketBodyV2 {
  const packet = object(value, "Research V2 packet body");
  assertKeys(packet, [
    "schema", "claims", "referencedClaimIds", "contradictions", "outlineProposals",
    "gaps", "proposedFollowUps", "coverageLimits", "abstentionReason",
  ], "Research V2 packet body");
  if (packet.schema !== RESEARCH_PACKET_BODY_SCHEMA_V2 ||
      !Array.isArray(packet.claims) || packet.claims.length > 20 ||
      !Array.isArray(packet.contradictions) || packet.contradictions.length > 12 ||
      !Array.isArray(packet.outlineProposals) || packet.outlineProposals.length > 12 ||
      !Array.isArray(packet.gaps) || packet.gaps.length > 16 ||
      !Array.isArray(packet.proposedFollowUps) || packet.proposedFollowUps.length > 3) {
    invalid("Research V2 packet body is invalid.");
  }
  const claims = packet.claims.map((value) => {
    const claim = object(value, "Research V2 claim reference");
    assertKeys(claim, ["candidateId", "claimId"], "Research V2 claim reference");
    return {
      candidateId: boundedString(claim.candidateId, "Research V2 claim candidate ID", 160),
      claimId: claimReferenceId(claim.claimId, "Research V2 claim ID"),
    };
  });
  if (new Set(claims.map((claim) => claim.candidateId)).size !== claims.length ||
      new Set(claims.map((claim) => claim.claimId)).size !== claims.length) {
    invalid("Research V2 claim references are duplicated.");
  }
  const referencedClaimIds = stringArray(
    packet.referencedClaimIds,
    "Research V2 referenced claim IDs",
    48,
  ).map((claimId) => claimReferenceId(claimId, "Research V2 referenced claim ID"));
  if (referencedClaimIds.some((claimId) => claims.some((claim) => claim.claimId === claimId))) {
    invalid("Research V2 referenced claims duplicate newly normalized claims.");
  }
  const claimIds = new Set([
    ...claims.map((claim) => claim.claimId),
    ...referencedClaimIds,
  ]);
  const contradictionIds = new Set<string>();
  const contradictions = packet.contradictions.map((value) => {
    const contradiction = object(value, "Research V2 contradiction");
    assertKeys(contradiction, ["id", "claimIds", "evidenceIds", "summary"], "Research V2 contradiction");
    const id = boundedString(contradiction.id, "Research V2 contradiction ID", 160);
    if (contradictionIds.has(id)) invalid("Research V2 contradiction IDs are duplicated.");
    contradictionIds.add(id);
    const contradictionClaimIds = requiredStringArray(contradiction.claimIds, "Research V2 contradiction claim IDs", 8).map((claimId) => claimReferenceId(claimId, "Research V2 contradiction claim ID"));
    if (contradictionClaimIds.length < 2 || contradictionClaimIds.some((claimId) => !claimIds.has(claimId))) {
      invalid("Research V2 contradiction references an unknown or insufficient claim.");
    }
    return {
      id,
      claimIds: contradictionClaimIds,
      evidenceIds: requiredStringArray(contradiction.evidenceIds, "Research V2 contradiction evidence IDs", 96).map((evidenceId) => evidenceReferenceId(evidenceId, "Research V2 contradiction evidence ID")),
      summary: boundedString(contradiction.summary, "Research V2 contradiction summary", 1_200),
    };
  });
  const proposalIds = new Set<string>();
  const outlineProposals = packet.outlineProposals.map((value) => {
    const proposal = object(value, "Research V2 outline proposal");
    assertKeys(proposal, [
      "id", "sectionId", "title", "question", "claimIds", "evidenceIds",
      "dependsOnSectionIds", "coverageTargetIds",
    ], "Research V2 outline proposal");
    const id = boundedString(proposal.id, "Research V2 outline proposal ID", 160);
    if (proposalIds.has(id)) invalid("Research V2 outline proposal IDs are duplicated.");
    proposalIds.add(id);
    const proposalClaimIds = stringArray(proposal.claimIds, "Research V2 outline claim IDs", 20).map((claimId) => claimReferenceId(claimId, "Research V2 outline claim ID"));
    if (proposalClaimIds.some((claimId) => !claimIds.has(claimId))) invalid("Research V2 outline references an unknown claim.");
    return {
      id,
      sectionId: boundedString(proposal.sectionId, "Research V2 outline section ID", 160),
      title: boundedString(proposal.title, "Research V2 outline title", 240),
      question: boundedString(proposal.question, "Research V2 outline question", 1_200),
      claimIds: proposalClaimIds,
      evidenceIds: stringArray(proposal.evidenceIds, "Research V2 outline evidence IDs", 96).map((evidenceId) => evidenceReferenceId(evidenceId, "Research V2 outline evidence ID")),
      dependsOnSectionIds: stringArray(proposal.dependsOnSectionIds, "Research V2 outline dependencies", 12),
      coverageTargetIds: stringArray(proposal.coverageTargetIds, "Research V2 outline coverage targets", 32),
    };
  });
  return {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claims,
    referencedClaimIds,
    contradictions,
    outlineProposals,
    gaps: packet.gaps.map(parseGap),
    proposedFollowUps: packet.proposedFollowUps.map(parseFollowUp),
    coverageLimits: stringArray(packet.coverageLimits, "Research V2 coverage limits", 16),
    ...(packet.abstentionReason === undefined ? {} : { abstentionReason: boundedString(packet.abstentionReason, "Research V2 abstention reason", 1_000) }),
  };
}

/** Parse the compact, host-authored packet-set projection supplied to T3 critique. */
export function parseResearchReconciliationInputV1(
  value: unknown,
): ResearchReconciliationInputV1 {
  const input = object(value, "Research reconciliation input");
  assertKeys(input, [
    "schema", "briefRevision", "graphRevision", "acceptedPacketRefs",
    "coverageTargetIds", "projection",
  ], "Research reconciliation input");
  if (input.schema !== RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1 ||
      !Number.isSafeInteger(input.briefRevision) || Number(input.briefRevision) < 1 ||
      !Number.isSafeInteger(input.graphRevision) || Number(input.graphRevision) < 1) {
    invalid("Research reconciliation input envelope is invalid.");
  }
  const acceptedPacketRefs = stringArray(
    input.acceptedPacketRefs,
    "Research reconciliation accepted packet refs",
    8,
  );
  if (acceptedPacketRefs.length === 0) {
    invalid("Research reconciliation input requires accepted packets.");
  }
  const projection = object(input.projection, "Research reconciliation projection");
  let parsedProjection: ResearchReconciliationInputV1["projection"];
  if (projection.kind === "v1-packet-set") {
    assertKeys(projection, [
      "kind", "findingCandidateIds", "relationshipCandidateIds", "gapIds", "sourceIds",
    ], "Research reconciliation projection");
    parsedProjection = {
      kind: "v1-packet-set",
      findingCandidateIds: stringArray(
        projection.findingCandidateIds,
        "Research reconciliation finding candidate ids",
        128,
      ),
      relationshipCandidateIds: stringArray(
        projection.relationshipCandidateIds,
        "Research reconciliation relationship candidate ids",
        128,
      ),
      gapIds: stringArray(projection.gapIds, "Research reconciliation gap ids", 128),
      sourceIds: stringArray(projection.sourceIds, "Research reconciliation source ids", 256),
    };
  } else if (projection.kind === "v2-claim-set") {
    assertKeys(projection, ["kind", "claimIds", "evidenceIds", "gapIds"], "Research reconciliation projection");
    parsedProjection = {
      kind: "v2-claim-set",
      claimIds: stringArray(projection.claimIds, "Research reconciliation V2 claim ids", 128)
        .map((claimId) => claimReferenceId(claimId, "Research reconciliation V2 claim id")),
      evidenceIds: stringArray(projection.evidenceIds, "Research reconciliation V2 evidence ids", 256)
        .map((evidenceId) => evidenceReferenceId(evidenceId, "Research reconciliation V2 evidence id")),
      gapIds: stringArray(projection.gapIds, "Research reconciliation V2 gap ids", 128),
    };
  } else {
    invalid("Research reconciliation projection kind is invalid.");
  }
  return {
    schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
    briefRevision: Number(input.briefRevision),
    graphRevision: Number(input.graphRevision),
    acceptedPacketRefs,
    coverageTargetIds: stringArray(
      input.coverageTargetIds,
      "Research reconciliation coverage target ids",
      32,
    ),
    projection: parsedProjection,
  };
}

/**
 * Build the deterministic, body-free index that tells the T3 reconciler which
 * accepted packet references and candidate IDs it may critique. Packet bodies
 * remain in the admitted dependency envelope; this projection never copies
 * source content or child-agent trajectories.
 */
export function projectResearchReconciliationInputV1(input: {
  briefRevision: number;
  graphRevision: number;
  coverageTargetIds: readonly string[];
  acceptedPackets: readonly ResearchAcceptedPacketV1[];
}): ResearchReconciliationInputV1 {
  function appendUniqueCandidateIds(
    ids: readonly string[],
    seen: Set<string>,
    output: string[],
    label: string,
  ): void {
    for (const id of ids) {
      if (seen.has(id)) invalid(`Research reconciliation ${label} is duplicated across accepted packets: ${id}.`);
      seen.add(id);
      output.push(id);
    }
  }
  const seenTaskIds = new Set<string>();
  const packetBodies = input.acceptedPackets.map((packet) => {
    if (packet.schema !== RESEARCH_ACCEPTED_PACKET_SCHEMA_V1 ||
        packet.graphRevision !== input.graphRevision) {
      invalid("Research reconciliation input contains a stale or invalid accepted packet.");
    }
    if (seenTaskIds.has(packet.taskId)) {
      invalid(`Research reconciliation task is duplicated across accepted packets: ${packet.taskId}.`);
    }
    seenTaskIds.add(packet.taskId);
    if (isResearchPacketBodyV1(packet.body)) return parseResearchPacketBodyV1(packet.body);
    if (isResearchPacketBodyV2(packet.body)) return parseResearchPacketBodyV2(packet.body);
    invalid("Research reconciliation input requires research packets.");
  });
  const usesV2 = packetBodies.some((body) => body.schema === RESEARCH_PACKET_BODY_SCHEMA_V2);
  if (usesV2) {
    if (packetBodies.some((body) => body.schema !== RESEARCH_PACKET_BODY_SCHEMA_V2)) {
      invalid("Research reconciliation input cannot mix V1 and V2 research packets.");
    }
    const claimIds = new Set<string>();
    const evidenceIds = new Set<string>();
    const gapIds: string[] = [];
    const seenGapIds = new Set<string>();
    for (const body of packetBodies) {
      if (body.schema !== RESEARCH_PACKET_BODY_SCHEMA_V2) continue;
      body.claims.forEach((claim) => {
        claimIds.add(claim.claimId);
      });
      body.referencedClaimIds.forEach((claimId) => claimIds.add(claimId));
      body.contradictions.forEach((contradiction) =>
        contradiction.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId)));
      body.outlineProposals.forEach((proposal) =>
        proposal.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId)));
      appendUniqueCandidateIds(
        body.gaps.map((gap) => gap.id),
        seenGapIds,
        gapIds,
        "gap id",
      );
    }
    return parseResearchReconciliationInputV1({
      schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
      briefRevision: input.briefRevision,
      graphRevision: input.graphRevision,
      acceptedPacketRefs: input.acceptedPackets.map((packet) => packet.packetRef),
      coverageTargetIds: [...input.coverageTargetIds],
      projection: {
        kind: "v2-claim-set",
        claimIds: [...claimIds].sort(),
        evidenceIds: [...evidenceIds].sort(),
        gapIds,
      },
    });
  }
  const findingCandidateIds: string[] = [];
  const relationshipCandidateIds: string[] = [];
  const gapIds: string[] = [];
  const sourceIds: string[] = [];
  const seenFindingIds = new Set<string>();
  const seenRelationshipIds = new Set<string>();
  const seenGapIds = new Set<string>();
  const seenSourceIds = new Set<string>();

  for (const packet of input.acceptedPackets) {
    const body = parseResearchPacketBodyV1(packet.body);
    appendUniqueCandidateIds(
      body.findingCandidates.map((candidate) => candidate.id),
      seenFindingIds,
      findingCandidateIds,
      "finding candidate id",
    );
    appendUniqueCandidateIds(
      body.relationshipCandidates.map((candidate) => candidate.id),
      seenRelationshipIds,
      relationshipCandidateIds,
      "relationship candidate id",
    );
    appendUniqueCandidateIds(
      body.gaps.map((gap) => gap.id),
      seenGapIds,
      gapIds,
      "gap id",
    );
    for (const sourceId of body.sourceIds) {
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      sourceIds.push(sourceId);
    }
  }

  return parseResearchReconciliationInputV1({
    schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
    briefRevision: input.briefRevision,
    graphRevision: input.graphRevision,
    acceptedPacketRefs: input.acceptedPackets.map((packet) => packet.packetRef),
    coverageTargetIds: [...input.coverageTargetIds],
    projection: {
      kind: "v1-packet-set",
      findingCandidateIds,
      relationshipCandidateIds,
      gapIds,
      sourceIds,
    },
  });
}

function parseReconciliationDefect(value: unknown): ResearchReconciliationDefectV1 {
  const item = object(value, "Reconciliation defect");
  assertKeys(item, ["id", "severity", "target", "code", "references", "explanation", "suggestedAction"], "Reconciliation defect");
  const severity = ["blocking", "important", "minor"] as const;
  const codes = ["unsupported", "contradicted", "missing_coverage", "overstated", "instruction_mismatch", "duplicate", "stale"] as const;
  const actions = ["accept", "revise", "downgrade", "add_follow_up", "abstain"] as const;
  const target = object(item.target, "Reconciliation defect target");
  assertKeys(target, ["kind", "id"], "Reconciliation defect target");
  const targetKinds = ["finding", "relationship", "claim", "section", "node", "coverage"] as const;
  if (!severity.includes(item.severity as typeof severity[number]) || !codes.includes(item.code as typeof codes[number]) || !actions.includes(item.suggestedAction as typeof actions[number]) || !targetKinds.includes(target.kind as typeof targetKinds[number])) invalid("Reconciliation defect enum value is invalid.");
  if (!Array.isArray(item.references) || item.references.length > 16) invalid("Reconciliation defect references are invalid.");
  const references = item.references.map((value, index): ResearchSupportRefV1 => {
    const reference = object(value, `Reconciliation reference ${index}`);
    assertKeys(reference, ["kind", "id"], `Reconciliation reference ${index}`);
    if (reference.kind !== "source" && reference.kind !== "evidence") invalid("Reconciliation reference kind is invalid.");
    return { kind: reference.kind, id: boundedString(reference.id, "Reconciliation reference id", 200) };
  });
  return {
    id: boundedString(item.id, "Reconciliation defect id", 160),
    severity: item.severity as typeof severity[number],
    target: { kind: target.kind as typeof targetKinds[number], id: boundedString(target.id, "Reconciliation target id", 160) },
    code: item.code as typeof codes[number],
    references,
    explanation: boundedString(item.explanation, "Reconciliation defect explanation", 1_000),
    suggestedAction: item.suggestedAction as typeof actions[number],
  };
}

export function parseReconciliationBodyV1(value: unknown): ReconciliationBodyV1 {
  const body = object(value, "Reconciliation body");
  assertKeys(body, ["schema", "defects", "proposedFollowUps"], "Reconciliation body");
  if (body.schema !== RESEARCH_RECONCILIATION_BODY_SCHEMA_V1) invalid("Unsupported reconciliation body schema.");
  if (!Array.isArray(body.defects) || body.defects.length > 16 || !Array.isArray(body.proposedFollowUps) || body.proposedFollowUps.length > 3) invalid("Reconciliation body arrays are invalid.");
  return {
    schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
    defects: body.defects.map(parseReconciliationDefect),
    proposedFollowUps: body.proposedFollowUps.map(parseFollowUp),
  };
}

/** Parse one host-recorded supervisor disposition; model output is never trusted directly. */
export function parseResearchReconciliationDispositionV1(
  value: unknown,
): ResearchReconciliationDispositionV1 {
  const disposition = object(value, "Research reconciliation disposition");
  assertKeys(disposition, [
    "schema",
    "id",
    "reconciliationPacketRef",
    "defectId",
    "basedOnGraphRevision",
    "decision",
    "reasonCode",
    "resultingGraphRevision",
    "resultingNodeId",
    "resultingClaimIds",
    "recordedAt",
  ], "Research reconciliation disposition");
  if (disposition.schema !== RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1 ||
      !Number.isSafeInteger(disposition.basedOnGraphRevision) ||
      Number(disposition.basedOnGraphRevision) < 1 ||
      !RESEARCH_RECONCILIATION_DECISIONS_V1.includes(
        disposition.decision as (typeof RESEARCH_RECONCILIATION_DECISIONS_V1)[number],
      ) ||
      !RESEARCH_RECONCILIATION_REASON_CODES_V1.includes(
        disposition.reasonCode as (typeof RESEARCH_RECONCILIATION_REASON_CODES_V1)[number],
      ) ||
      (disposition.resultingGraphRevision !== undefined &&
        (!Number.isSafeInteger(disposition.resultingGraphRevision) ||
          Number(disposition.resultingGraphRevision) < 1)) ||
      typeof disposition.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(disposition.recordedAt))) {
    invalid("Research reconciliation disposition envelope is invalid.");
  }
  return {
    schema: RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
    id: boundedString(disposition.id, "Research reconciliation disposition id", 200),
    reconciliationPacketRef: boundedString(
      disposition.reconciliationPacketRef,
      "Research reconciliation packet reference",
      240,
    ),
    defectId: boundedString(disposition.defectId, "Research reconciliation defect id", 160),
    basedOnGraphRevision: disposition.basedOnGraphRevision as number,
    decision: disposition.decision as ResearchReconciliationDispositionV1["decision"],
    reasonCode: disposition.reasonCode as ResearchReconciliationDispositionV1["reasonCode"],
    ...(disposition.resultingGraphRevision === undefined
      ? {}
      : { resultingGraphRevision: disposition.resultingGraphRevision as number }),
    ...(disposition.resultingNodeId === undefined
      ? {}
      : {
          resultingNodeId: boundedString(
            disposition.resultingNodeId,
            "Research reconciliation resulting node id",
            160,
          ),
        }),
    resultingClaimIds: stringArray(
      disposition.resultingClaimIds,
      "Research reconciliation resulting claim ids",
      32,
    ),
    recordedAt: disposition.recordedAt,
  };
}

export function parseResearchTaskBodyV1(
  schema: ResearchTaskOutputSchemaV1,
  value: unknown,
): ResearchPacketBodyV1 | ResearchPacketBodyV2 | ReconciliationBodyV1 | ResearchAgentDraftV1 {
  if (schema === RESEARCH_PACKET_BODY_SCHEMA_V1) return parseResearchPacketBodyV1(value);
  if (schema === RESEARCH_PACKET_BODY_SCHEMA_V2) return parseResearchPacketBodyV2(value);
  if (schema === RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2) return parseResearchPacketBodyV2(value);
  if (schema === RESEARCH_RECONCILIATION_BODY_SCHEMA_V1) return parseReconciliationBodyV1(value);
  if (schema === "atlcli.research-agent-draft/v1") return parseResearchAgentDraftV1(value);
  invalid("Research task output schema is unavailable.");
}

export function validateResearchTaskAdmissionV1(input: {
  executor: "ptc" | "subagent";
  roleId?: ResearchSubagentRoleIdV1;
  expectedOutputSchema: ResearchTaskOutputSchemaV1;
  grantedCapabilityIds: readonly ResearchGraphCapabilityV1[];
  budget: ResearchNodeBudgetV1;
  phase?: "T3" | "T5";
}): void {
  validateResearchNodeBudgetV1(input.budget, "Research task budget");
  if (input.executor === "ptc") {
    if (input.roleId) invalid("A PTC task cannot carry a subagent role.");
    if (input.expectedOutputSchema !== RESEARCH_PACKET_BODY_SCHEMA_V1) invalid("A T3 PTC task must return ResearchPacketBodyV1.");
    return;
  }
  if (!input.roleId) invalid("A subagent task requires a role.");
  const registered = RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[input.roleId];
  if (!registered) invalid("Research subagent role is not registered.");
  // The reference-only V2 schema is the durable-evidence boundary that
  // admits T5-only structural roles. It cannot carry quotes, raw evidence, or
  // new factual claims, and the outline planner supports no other schema.
  const phase = input.phase ?? (
    input.expectedOutputSchema === RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2 ? "T5" : "T3"
  );
  if (phase === "T3" && registered.availableFromPhase !== "T3") invalid("Research subagent role is unavailable in T3.");
  if (!registered.supportedOutputSchemas.includes(input.expectedOutputSchema)) invalid("Research subagent output schema is not allowed for its role.");
  for (const capability of input.grantedCapabilityIds) {
    if (!registered.allowedCapabilityIds.includes(capability)) invalid("Research subagent capability is not allowed for its role.");
  }
}
