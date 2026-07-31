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

export const RESEARCH_PACKET_BODY_SCHEMA_V1 =
  "atlcli.research-packet-body/v1" as const;
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
  | "atlcli.research-packet-body/v2"
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
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1],
    mayProposeFollowUps: true,
  }),
  "document-distiller": role({
    id: "document-distiller",
    description: "Distill already accepted source projections without widening scope.",
    phase: "analysis",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1],
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
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1],
    mayProposeFollowUps: true,
  }),
  "coverage-moderator": role({
    id: "coverage-moderator",
    description: "Assess bounded coverage and abstention gaps from accepted packets.",
    phase: "verification",
    availableFromPhase: "T3",
    allowedCapabilityIds: [],
    supportedOutputSchemas: [RESEARCH_PACKET_BODY_SCHEMA_V1],
    mayProposeFollowUps: true,
  }),
  "outline-planner": role({
    id: "outline-planner",
    description: "Propose a claim-linked report outline after the V2 evidence store exists.",
    phase: "analysis",
    availableFromPhase: "T5",
    allowedCapabilityIds: [],
    supportedOutputSchemas: ["atlcli.research-packet-body/v2"],
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

export interface ResearchReconciliationInputV1 {
  schema: typeof RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1;
  briefRevision: number;
  graphRevision: number;
  acceptedPacketRefs: string[];
  coverageTargetIds: string[];
  projection: {
    kind: "v1-packet-set";
    findingCandidateIds: string[];
    relationshipCandidateIds: string[];
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
  body: ResearchPacketBodyV1 | ReconciliationBodyV1 | ResearchAgentDraftV1;
  hostObservedUsage: ResearchTaskUsageV1;
  acceptedAt: string;
}

export interface ResearchReconciliationDispositionV1 {
  schema: typeof RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1;
  id: string;
  reconciliationPacketRef: string;
  defectId: string;
  basedOnGraphRevision: number;
  decision: "reject_defect" | "revise" | "downgrade" | "add_follow_up" | "abstain" | "no_change";
  reasonCode:
    | "invalid_reference"
    | "already_resolved"
    | "supported_by_evidence"
    | "material_defect"
    | "insufficient_budget"
    | "outside_approval_envelope";
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

export function parseResearchTaskBodyV1(
  schema: ResearchTaskOutputSchemaV1,
  value: unknown,
): ResearchPacketBodyV1 | ReconciliationBodyV1 | ResearchAgentDraftV1 {
  if (schema === RESEARCH_PACKET_BODY_SCHEMA_V1) return parseResearchPacketBodyV1(value);
  if (schema === RESEARCH_RECONCILIATION_BODY_SCHEMA_V1) return parseReconciliationBodyV1(value);
  if (schema === "atlcli.research-agent-draft/v1") return parseResearchAgentDraftV1(value);
  invalid("ResearchPacketBodyV2 is unavailable before T5.");
}

export function validateResearchTaskAdmissionV1(input: {
  executor: "ptc" | "subagent";
  roleId?: ResearchSubagentRoleIdV1;
  expectedOutputSchema: ResearchTaskOutputSchemaV1;
  grantedCapabilityIds: readonly ResearchGraphCapabilityV1[];
  phase?: "T3" | "T5";
}): void {
  if (input.executor === "ptc") {
    if (input.roleId) invalid("A PTC task cannot carry a subagent role.");
    if (input.expectedOutputSchema !== RESEARCH_PACKET_BODY_SCHEMA_V1) invalid("A T3 PTC task must return ResearchPacketBodyV1.");
    return;
  }
  if (!input.roleId) invalid("A subagent task requires a role.");
  const registered = RESEARCH_SUBAGENT_ROLE_REGISTRY_V1[input.roleId];
  if (!registered) invalid("Research subagent role is not registered.");
  if ((input.phase ?? "T3") === "T3" && registered.availableFromPhase !== "T3") invalid("Research subagent role is unavailable in T3.");
  if (!registered.supportedOutputSchemas.includes(input.expectedOutputSchema)) invalid("Research subagent output schema is not allowed for its role.");
  for (const capability of input.grantedCapabilityIds) {
    if (!registered.allowedCapabilityIds.includes(capability)) invalid("Research subagent capability is not allowed for its role.");
  }
}
