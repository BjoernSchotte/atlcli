import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  type ResearchOneShotPolicyV1,
  type ResearchRequestV1,
  type ResearchScopeBindingV1,
} from "./contracts.js";
import {
  approveResearchBriefWholeScopeExpansionV1,
  reviseResearchBriefPlanV1,
  resolveResearchBriefClarificationsV1,
  type ResearchBriefAssumptionDecisionV1,
  type ResearchBriefClarificationResponseV1,
  type ResearchBriefV1,
} from "./brief.js";
import {
  acceptResearchGraphProposalV1,
  diffResearchPlansV1,
  reduceResearchGraphV1,
  validateResearchGraphV1,
  type ResearchPlanDiffV1,
  type ResearchGraphNodeV1,
  type ResearchGraphProposalV1,
  type ResearchGraphV1,
} from "./graph.js";
import type {
  ResearchScopeCandidateV1,
  ResearchScopeExpansionProposalV1,
  ResearchScopeResolutionV1,
} from "./scope-discovery.js";
import type {
  ResearchScopeCandidateSelectionV1,
  ResearchScopeClarificationRequiredV1,
} from "./scope-resolution.js";
import {
  reduceResearchAcceptedPacketV1,
  reduceResearchTaskAttemptV1,
} from "./task-ledger.js";
import {
  RESEARCH_RETRIEVAL_ASSESSMENT_REASONS_V1,
  parseResearchRetrievalAssessmentV1,
  type ResearchRetrievalAssessmentReasonV1,
  type ResearchRetrievalAssessmentV1,
} from "./retrieval-assessment.js";
import {
  parseResearchReconciliationDispositionV1,
  type ResearchAcceptedPacketV1,
  type ResearchReconciliationFollowUpProposalV1,
  type ResearchReconciliationDefectV1,
  type ResearchReconciliationDispositionV1,
  type ResearchTaskAttemptV1,
  type ResearchTaskUsageV1,
} from "./workflow-contracts.js";
import {
  parseResearchRunBudgetStateV1,
  type ResearchRunBudgetStateV1,
} from "./budget.js";

/**
 * The durable, host-neutral state envelope. It intentionally stores only
 * bounded contracts and opaque references: V1 source bodies, provider
 * credentials, cursors, prompts, and model trajectories do not belong here.
 */
export const RESEARCH_SESSION_SCHEMA_V1 = "atlcli.research-session/v1" as const;
export const RESEARCH_SESSION_CHECKPOINT_SCHEMA_V1 =
  "atlcli.research-session-checkpoint/v1" as const;
export const RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1 =
  "atlcli.research-session-retrieval-assessment/v1" as const;
export const RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1 =
  "atlcli.research-session-retrieval-continuation/v1" as const;
export const RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1 =
  "atlcli.research-session-graph-revision/v1" as const;
export const RESEARCH_SESSION_PLAN_REVISION_SCHEMA_V1 =
  "atlcli.research-session-plan-revision/v1" as const;
export const RESEARCH_SESSION_SCOPE_REVISION_SCHEMA_V1 =
  "atlcli.research-session-scope-revision/v1" as const;
export const RESEARCH_SESSION_SCOPE_CLARIFICATION_SCHEMA_V1 =
  "atlcli.research-session-scope-clarification/v1" as const;
export const RESEARCH_RESUMABLE_SESSION_SCHEMA_V1 =
  "atlcli.research-resumable-session/v1" as const;

export type ResearchSessionStatusV1 =
  | "idle"
  | "planning"
  | "waiting_scope_clarification"
  | "waiting_clarification"
  | "waiting_plan_approval"
  | "waiting_plan_revision"
  | "waiting_scope_approval"
  | "waiting_steering"
  | "pause_requested"
  | "paused"
  | "running"
  | "waiting_authentication"
  | "waiting_quota"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "failed"
  | "deleted";

export interface ResearchSessionLeaseV1 {
  epoch: number;
  ownerId: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface ResearchSessionRetentionV1 {
  state: "active" | "retained" | "deletion_requested" | "deleted";
  retainedUntil?: string;
}

export interface ResearchSessionClarificationV1 {
  briefRevision: number;
  questionId: string;
  response: string;
  assumptionId?: string;
  assumptionDecision?: "accepted" | "rejected";
  answeredAt: string;
}

export interface ResearchSessionAssumptionDecisionV1 {
  briefRevision: number;
  assumptionId: string;
  decision: "accepted" | "rejected";
  decidedAt: string;
}

/**
 * The tenant-bound, pre-brief state for an ambiguous natural-language scope.
 * It retains the bounded user request and catalog candidates, never content
 * bodies, credentials, provider cursors, prompts, or model trajectories.
 */
export interface ResearchSessionScopeClarificationV1 {
  schema: typeof RESEARCH_SESSION_SCOPE_CLARIFICATION_SCHEMA_V1;
  state: "waiting_choice" | "choice_resolved";
  request: ResearchRequestV1;
  policy: ResearchOneShotPolicyV1;
  clarification: ResearchScopeClarificationRequiredV1;
  candidateChoices: ResearchScopeCandidateV1[];
  selection?: ResearchScopeCandidateSelectionV1;
  resolvedRequest?: ResearchRequestV1;
}

export interface ResearchSessionSteeringV1 {
  id: string;
  request: string;
  /** The immutable graph the user inspected when submitting this control. */
  basedOnGraphRevision: number;
  requestedAt: string;
  state: "requested" | "applied";
  appliedAt?: string;
  appliedGraphRevision?: number;
  /** Body-free projection of the one host-validated in-envelope revision. */
  planDiff?: ResearchPlanDiffV1;
}

export interface ResearchSessionCheckpointV1 {
  schema: typeof RESEARCH_SESSION_CHECKPOINT_SCHEMA_V1;
  id: string;
  sessionRevision: number;
  turnId: string;
  graphRevision?: number;
  kind: "turn_accepted" | "brief" | "plan" | "dispatch" | "packet" | "reconciliation" | "pause" | "terminal";
  recordedAt: string;
  artifactRefs: string[];
}

/**
 * Host-recorded context for the one optional repair node. Its follow-up is
 * copied from an already accepted reconciliation packet; it is never a model
 * authored durable command.
 */
export interface ResearchSessionRepairAuthorizationV1 {
  schema: "atlcli.research-session-repair-authorization/v1";
  nodeId: string;
  reconciliationTaskId: string;
  followUp: ResearchReconciliationFollowUpProposalV1;
  authorizedAt: string;
}

/**
 * A one-time host lease for the next disposable supervisor evaluation. It is
 * issued both for a retrieval replan and for terminal finalization: the
 * latter may render only already accepted compact packets and cannot reopen
 * retrieval.
 */
export interface ResearchSessionRetrievalContinuationV1 {
  schema: typeof RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1;
  /** Deterministic from graph revision and wave; it carries no provider/model data. */
  id: string;
  status: "issued" | "consumed";
  issuedAt: string;
  consumedAt?: string;
}

/**
 * A durable, body-free record of the host's retrieval decision after a graph
 * state has settled. It is deliberately insufficient to recreate source
 * content, search terms, or model reasoning. A continuation is issued for the
 * next disposable supervisor eval, whether that eval replans retrieval or
 * only finalizes accepted results. Consuming it is revision-fenced and exactly
 * once.
 */
export interface ResearchSessionRetrievalAssessmentV1 {
  schema: typeof RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1;
  graphRevision: number;
  /**
   * Host-owned retrieval checkpoint within one immutable graph envelope.
   * Undefined denotes an assessment written before multi-wave checkpoints;
   * readers treat it as wave 1 and upgrade it on the next write.
   */
  wave?: number;
  assessment: ResearchRetrievalAssessmentV1;
  continuation?: ResearchSessionRetrievalContinuationV1;
  recordedAt: string;
}

/**
 * A bounded, body-free graph snapshot for inspection and deterministic
 * recovery. Evidence/gap identifiers explain the host-triggered revision;
 * neither source bodies nor model rationale are retained here.
 */
export interface ResearchSessionGraphRevisionV1 {
  schema: typeof RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1;
  graph: ResearchGraphV1;
  evidenceIds: string[];
  gapIds: string[];
  reason: ResearchGraphRevisionReasonV1;
  steeringId?: string;
  planDiff?: ResearchPlanDiffV1;
  recordedAt: string;
}

/**
 * Retrieval assessments remain evidence-derived. A user steering request is a
 * separate durable control cause; it must never be forged as a retrieval
 * assessment merely to branch the scheduler.
 */
export type ResearchGraphRevisionReasonV1 =
  | ResearchRetrievalAssessmentReasonV1
  | "user_steering";

const RESEARCH_GRAPH_REVISION_REASONS_V1: readonly ResearchGraphRevisionReasonV1[] = [
  ...RESEARCH_RETRIEVAL_ASSESSMENT_REASONS_V1,
  "user_steering",
];

/**
 * Durable history for one rejected plan and its user-requested replacement.
 * It holds only bounded user control text and immutable version references;
 * source material and model reasoning never enter this record.
 */
export interface ResearchSessionPlanRevisionV1 {
  schema: typeof RESEARCH_SESSION_PLAN_REVISION_SCHEMA_V1;
  id: string;
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  rejectionReason: string;
  requestedAt: string;
  /** Immutable inputs from the rejected review boundary; no source bodies. */
  rejectedBrief: ResearchBriefV1;
  rejectedGraph: ResearchGraphV1;
  state: "rejected" | "revision_requested" | "proposed" | "approved";
  instruction?: string;
  revisedBriefRevision?: number;
  proposedGraphRevision?: number;
  planDiff?: ResearchPlanDiffV1;
  approvedAt?: string;
}

/**
 * Durable replacement-plan lineage for an approved whole-project/space scope
 * discovery. Exact-entity approvals do not widen the brief and therefore do
 * not create this record.
 */
export interface ResearchSessionScopeRevisionV1 {
  schema: typeof RESEARCH_SESSION_SCOPE_REVISION_SCHEMA_V1;
  id: string;
  proposalId: string;
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  expansionKind: "whole_scope";
  approvedBinding: ResearchScopeBindingV1;
  previousBrief: ResearchBriefV1;
  previousGraph: ResearchGraphV1;
  state: "proposed" | "approved";
  revisedBriefRevision: number;
  proposedGraphRevision?: number;
  planDiff?: ResearchPlanDiffV1;
  approvedAt?: string;
}

export interface ResearchSessionTurnV1 {
  id: string;
  revision: number;
  createdAt: string;
  brief?: ResearchBriefV1;
  graph?: ResearchGraphV1;
  /**
   * The supervisor's selected executable subset was committed under the
   * already approved graph envelope. The session revision, rather than the
   * envelope's graph revision, fences this one pre-dispatch selection.
   */
  graphSelectionCommittedAt?: string;
  /** The approved catalog's repair node, retained until a disposition activates it. */
  latentRepairNode?: ResearchGraphNodeV1;
  /** Present only after the latent node has entered the execution graph. */
  repairAuthorization?: ResearchSessionRepairAuthorizationV1;
  scopeCandidates: ResearchScopeCandidateV1[];
  scopeBindings: ResearchScopeBindingV1[];
  scopeResolutions: ResearchScopeResolutionV1[];
  scopeExpansionProposals: ResearchScopeExpansionProposalV1[];
  clarifications: ResearchSessionClarificationV1[];
  assumptionDecisions: ResearchSessionAssumptionDecisionV1[];
  /** Undefined denotes a pre-plan-revision legacy turn. */
  planRevisions?: ResearchSessionPlanRevisionV1[];
  /** Undefined denotes a pre-whole-scope-revision legacy turn. */
  scopeRevisions?: ResearchSessionScopeRevisionV1[];
  steering: ResearchSessionSteeringV1[];
  tasks: ResearchTaskAttemptV1[];
  acceptedPackets: ResearchAcceptedPacketV1[];
  reconciliationDispositions: ResearchReconciliationDispositionV1[];
  /** Latest body-free counter projection, used to fence a resumed provider budget. */
  budgetState?: ResearchRunBudgetStateV1;
  reconciliationCommittedAt?: string;
  /** Undefined is a legacy turn that predates durable dynamic graph revisions. */
  graphRevisions?: ResearchSessionGraphRevisionV1[];
  /** Undefined is a pre-assessment legacy turn; new turns always initialize it. */
  retrievalAssessments?: ResearchSessionRetrievalAssessmentV1[];
  checkpoints: ResearchSessionCheckpointV1[];
  pauseRequestedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failureReason?: string;
}

export interface ResearchSessionV1 {
  schema: typeof RESEARCH_SESSION_SCHEMA_V1;
  sessionId: string;
  revision: number;
  status: ResearchSessionStatusV1;
  lease: ResearchSessionLeaseV1;
  retention: ResearchSessionRetentionV1;
  /** Present only for a durable natural-language scope preflight. */
  scopeClarification?: ResearchSessionScopeClarificationV1;
  activeTurnId?: string;
  turns: ResearchSessionTurnV1[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A tenant-filtered, body-free projection that a host may show to its current
 * user as a safe resume affordance. It deliberately omits source references,
 * packets, prompts, events, credentials, and the tenant origin itself.
 */
export interface ResearchResumableSessionV1 {
  schema: typeof RESEARCH_RESUMABLE_SESSION_SCHEMA_V1;
  sessionId: string;
  /**
   * Opaque optimistic-concurrency fence for a host action. It conveys no
   * research content and prevents an older sidebar view from changing a
   * session after another action has advanced it.
   */
  revision: number;
  turnId: string;
  status: Extract<
    ResearchSessionStatusV1,
    "waiting_authentication" | "waiting_quota" | "waiting_steering" | "paused" | "running"
  >;
  updatedAt: string;
  question: string;
  scope: {
    jiraProjectKeys: string[];
    confluenceSpaceKeys: string[];
  };
}

interface ResearchSessionFencedUpdateV1 {
  expectedRevision: number;
  expectedLeaseEpoch: number;
  at: string;
}

/** A closed command union; stores must never accept ad-hoc mutation objects. */
export type ResearchSessionUpdateV1 =
  | (ResearchSessionFencedUpdateV1 & { kind: "create_turn"; turnId: string })
  | (ResearchSessionFencedUpdateV1 & {
      /** Persist an unresolved natural-language scope before any brief exists. */
      kind: "record_scope_clarification";
      request: ResearchRequestV1;
      policy: ResearchOneShotPolicyV1;
      clarification: ResearchScopeClarificationRequiredV1;
      candidateChoices: ResearchScopeCandidateV1[];
    })
  | (ResearchSessionFencedUpdateV1 & {
      /** Replace stale catalog candidates while preserving the original request. */
      kind: "refresh_scope_clarification";
      clarification: ResearchScopeClarificationRequiredV1;
      candidateChoices: ResearchScopeCandidateV1[];
    })
  | (ResearchSessionFencedUpdateV1 & {
      /** Commit exactly one persisted candidate choice and its host-resolved scope. */
      kind: "resolve_scope_clarification";
      selection: ResearchScopeCandidateSelectionV1;
      resolvedRequest: ResearchRequestV1;
    })
  | (ResearchSessionFencedUpdateV1 & {
      /** Atomically materialize the first brief only from a committed scope choice. */
      kind: "initialize_scope_brief";
      brief: ResearchBriefV1;
      scopeCandidates?: ResearchScopeCandidateV1[];
      scopeBindings?: ResearchScopeBindingV1[];
      scopeResolutions?: ResearchScopeResolutionV1[];
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "record_brief";
      brief: ResearchBriefV1;
      scopeCandidates?: ResearchScopeCandidateV1[];
      scopeBindings?: ResearchScopeBindingV1[];
      scopeResolutions?: ResearchScopeResolutionV1[];
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "propose_graph";
      graph: ResearchGraphV1;
      /** Only the in-process automatic approval hand-off may retain the lease. */
      retainLeaseForImmediateApproval?: true;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "approve_graph"; graphRevision: number })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "commit_graph_selection";
      proposal: ResearchGraphProposalV1;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "revise_graph"; graph: ResearchGraphV1 })
  | (ResearchSessionFencedUpdateV1 & {
      /** Apply a host-validated incremental graph revision while the turn is running. */
      kind: "apply_graph_revision";
      graph: ResearchGraphV1;
      evidenceIds: string[];
      gapIds: string[];
      reason: ResearchGraphRevisionReasonV1;
      /** Present only for the pending steering control that this exact revision resolves. */
      steeringId?: string;
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "record_clarification";
      briefRevision: number;
      questionId: string;
      response: string;
      assumptionId?: string;
      assumptionDecision?: "accepted" | "rejected";
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "record_assumption_decision";
      briefRevision: number;
      assumptionId: string;
      decision: "accepted" | "rejected";
    })
  | (ResearchSessionFencedUpdateV1 & {
      /** Atomically records one complete answer set and materializes a new brief revision. */
      kind: "resolve_clarifications";
      briefRevision: number;
      answers: Array<Pick<ResearchBriefClarificationResponseV1, "questionId" | "response">>;
      assumptionDecisions: ResearchBriefAssumptionDecisionV1[];
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "reject_plan"; graphRevision: number; reason: string })
  | (ResearchSessionFencedUpdateV1 & {
      /** Materialize a user-controlled correction after the exact graph was rejected. */
      kind: "request_plan_revision";
      graphRevision: number;
      instruction: string;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "propose_scope_expansion"; proposal: ResearchScopeExpansionProposalV1 })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "approve_scope_expansion";
      proposalId: string;
      binding: ResearchScopeBindingV1;
      /** Required for a whole project/space, forbidden for an exact entity. */
      replacementGraph?: ResearchGraphV1;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "reject_scope_expansion"; proposalId: string })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "request_steering";
      steeringId: string;
      basedOnGraphRevision: number;
      request: string;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "request_pause" })
  | (ResearchSessionFencedUpdateV1 & { kind: "acknowledge_pause" })
  | (ResearchSessionFencedUpdateV1 & { kind: "admit_tasks"; graphRevision: number; tasks: ResearchTaskAttemptV1[] })
  | (ResearchSessionFencedUpdateV1 & { kind: "dispatch_started"; taskId: string; graphRevision: number; providerRequestId?: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "outcome_unknown"; taskId: string; graphRevision: number })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "accept_packet";
      taskId: string;
      graphRevision: number;
      body: unknown;
      usage: ResearchTaskUsageV1;
      availableSourceIds: string[];
      maximumResultBytes: number;
      budgetState?: ResearchRunBudgetStateV1;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "quarantine_packet"; taskId: string; graphRevision: number; reason: string })
  | (ResearchSessionFencedUpdateV1 & {
      /** One supervisor decision set, atomically coupled to optional repair activation. */
      kind: "record_reconciliation";
      dispositions: unknown[];
      repair?: {
        nodeId: string;
        reconciliationTaskId: string;
        followUpId: string;
      };
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "record_retrieval_assessment";
      graphRevision: number;
      assessment: unknown;
      issueContinuation?: boolean;
      budgetState?: ResearchRunBudgetStateV1;
    })
  | (ResearchSessionFencedUpdateV1 & {
      kind: "consume_retrieval_continuation";
      graphRevision: number;
      wave: number;
      continuationId: string;
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "record_checkpoint"; checkpoint: Omit<ResearchSessionCheckpointV1, "schema" | "sessionRevision"> })
  | (ResearchSessionFencedUpdateV1 & { kind: "resume" })
  | (ResearchSessionFencedUpdateV1 & { kind: "wait_authentication" })
  | (ResearchSessionFencedUpdateV1 & { kind: "wait_quota" })
  | (ResearchSessionFencedUpdateV1 & { kind: "release_lease" })
  | (ResearchSessionFencedUpdateV1 & { kind: "heartbeat"; leaseExpiresAt: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "recover"; ownerId: string; expiresAt: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "cancel" })
  | (ResearchSessionFencedUpdateV1 & { kind: "complete" })
  | (ResearchSessionFencedUpdateV1 & { kind: "fail"; reason: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "retain"; retainedUntil?: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "request_deletion" })
  | (ResearchSessionFencedUpdateV1 & { kind: "delete" });

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function validId(value: string, prefix: string, maximum = 160): boolean {
  return new RegExp(`^${prefix}[A-Za-z0-9._-]{1,${maximum}}$`).test(value);
}

function timestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(`${label} is invalid.`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateBodyFreeReferenceIds(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 64 ||
      value.some((entry) => typeof entry !== "string" ||
        !/^(?:evidence|claim|gap|coverage|contradiction):[A-Za-z0-9._:-]{1,180}$/.test(entry)) ||
      new Set(value).size !== value.length) {
    invalid(`${label} is invalid.`);
  }
}

function sameScopeClarificationRequest(
  original: ResearchRequestV1,
  resolved: ResearchRequestV1,
): boolean {
  const includesAll = (required: readonly string[], actual: readonly string[]) =>
    required.every((entry) => actual.includes(entry));
  const originalSeeds = original.scopeSeeds ?? [];
  const resolvedSeeds = resolved.scopeSeeds ?? [];
  // Scope precedence remains meaningful on the recovery boundary. A natural
  // name may replace a lower-precedence profile/global/current-context default,
  // but it may never replace an explicit CLI/UI binding or an already-resolved
  // natural/exact binding from the accepted question. Legacy requests without
  // provenance retain their complete raw V1 scope as the conservative default.
  const protectedSeeds = originalSeeds.filter((seed) =>
    seed.binding.authority === "locked" ||
    ["cli_flag", "ui_added", "natural_language", "exact_link"].includes(seed.binding.source),
  );
  const protectedKeys = (
    product: "jira" | "confluence",
    entityKind: "project" | "space",
    rawKeys: readonly string[],
  ) => {
    const scopedSeeds = originalSeeds.filter((seed) =>
      seed.binding.product === product && seed.binding.entityKind === entityKind,
    );
    const seededKeys = protectedSeeds
      .filter((seed) => seed.binding.product === product && seed.binding.entityKind === entityKind)
      .flatMap((seed) => seed.binding.key === undefined ? [] : [seed.binding.key]);
    return scopedSeeds.length === 0 ? [...new Set([...seededKeys, ...rawKeys])] : seededKeys;
  };
  return original.question === resolved.question &&
    original.scope.siteOrigin === resolved.scope.siteOrigin &&
    original.wikiProvider === resolved.wikiProvider &&
    JSON.stringify(original.limits) === JSON.stringify(resolved.limits) &&
    JSON.stringify(original.scope.timeWindow ?? {}) === JSON.stringify(resolved.scope.timeWindow ?? {}) &&
    includesAll(
      protectedKeys("jira", "project", original.scope.jiraProjectKeys),
      resolved.scope.jiraProjectKeys,
    ) &&
    includesAll(
      protectedKeys("confluence", "space", original.scope.confluenceSpaceKeys),
      resolved.scope.confluenceSpaceKeys,
    ) &&
    protectedSeeds.every((seed) => resolvedSeeds.some((candidate) =>
      candidate.binding.id === seed.binding.id && JSON.stringify(candidate) === JSON.stringify(seed)
    ));
}

function validateScopeClarification(
  session: ResearchSessionV1,
  value: ResearchSessionScopeClarificationV1,
): void {
  if (value.schema !== RESEARCH_SESSION_SCOPE_CLARIFICATION_SCHEMA_V1 ||
      (value.state !== "waiting_choice" && value.state !== "choice_resolved")) {
    invalid("Research session scope clarification is invalid.");
  }
  let request: ResearchRequestV1;
  try {
    request = normalizeResearchRequestV1(value.request);
    normalizeResearchOneShotPolicyV1(value.policy);
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Research session scope clarification is invalid.");
  }
  const clarification = value.clarification;
  if (clarification.schema !== "atlcli.research-clarification-required/v1" ||
      !/^mention:[A-Za-z0-9._-]{1,120}$/.test(clarification.mentionId) ||
      !["ambiguous", "weak_match", "archived_only", "unavailable", "incomplete", "not_found"].includes(clarification.reason) ||
      !Array.isArray(clarification.candidateIds) || clarification.candidateIds.length > 8 ||
      new Set(clarification.candidateIds).size !== clarification.candidateIds.length ||
      clarification.candidateIds.some((id) => !/^research-scope-candidate:[A-Za-z0-9._-]{1,200}$/.test(id)) ||
      !Array.isArray(clarification.rerunGuidance) || clarification.rerunGuidance.length > 8 ||
      clarification.rerunGuidance.some((entry) => !entry.trim() || entry.length > 500)) {
    invalid("Research session scope clarification is invalid.");
  }
  if (!Array.isArray(value.candidateChoices) || value.candidateChoices.length > 8 ||
      new Set(value.candidateChoices.map((candidate) => candidate.id)).size !== value.candidateChoices.length ||
      value.candidateChoices.some((candidate) =>
        candidate.schema !== "atlcli.research-scope-candidate/v1" ||
        !/^research-scope-candidate:[A-Za-z0-9._-]{1,200}$/.test(candidate.id) ||
        candidate.tenantOrigin !== request.scope.siteOrigin ||
        candidate.accessible !== true || !candidate.name.trim() || candidate.name.length > 500 ||
        !Number.isFinite(Date.parse(candidate.providerFreshnessAt)) ||
        !clarification.candidateIds.includes(candidate.id)
      )) {
    invalid("Research session scope clarification candidates are invalid.");
  }
  if (value.state === "waiting_choice") {
    if (session.status !== "waiting_scope_clarification" || session.activeTurnId ||
        value.selection !== undefined || value.resolvedRequest !== undefined) {
      invalid("Research session scope clarification wait is invalid.");
    }
    return;
  }
  if (value.selection?.schema !== "atlcli.research-scope-candidate-selection/v1" ||
      value.selection.mentionId !== clarification.mentionId ||
      !clarification.candidateIds.includes(value.selection.candidateId) ||
      !value.resolvedRequest) {
    invalid("Research session scope clarification resolution is invalid.");
  }
  let resolved: ResearchRequestV1;
  try {
    resolved = normalizeResearchRequestV1(value.resolvedRequest);
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Research session scope clarification resolution is invalid.");
  }
  if (!sameScopeClarificationRequest(request, resolved) ||
      (!session.activeTurnId && session.status !== "idle")) {
    invalid("Research session scope clarification resolution is invalid.");
  }
}

function turn(session: ResearchSessionV1): ResearchSessionTurnV1 {
  if (!session.activeTurnId) invalid("Research session does not have an active turn.");
  const found = session.turns.find((candidate) => candidate.id === session.activeTurnId);
  if (!found) invalid("Research session active turn is missing.");
  return found;
}

function replaceTurn(session: ResearchSessionV1, replacement: ResearchSessionTurnV1): ResearchSessionTurnV1[] {
  return session.turns.map((candidate) => candidate.id === replacement.id ? replacement : candidate);
}

function ensureActive(session: ResearchSessionV1, allowed: readonly ResearchSessionStatusV1[]): ResearchSessionTurnV1 {
  if (!allowed.includes(session.status)) invalid(`Research session cannot transition from ${session.status}.`);
  return turn(session);
}

function ensureFence(session: ResearchSessionV1, update: ResearchSessionFencedUpdateV1): void {
  if (session.revision !== update.expectedRevision) invalid("Research session update revision is stale.");
  if (session.lease.epoch !== update.expectedLeaseEpoch) invalid("Research session update lease epoch is stale.");
  timestamp(update.at, "Research session update timestamp");
}

function withNext(
  session: ResearchSessionV1,
  update: ResearchSessionFencedUpdateV1,
  patch: Pick<ResearchSessionV1, "status"> & Partial<Omit<ResearchSessionV1, "schema" | "sessionId" | "revision" | "createdAt" | "updatedAt" | "lease" | "status">>,
): ResearchSessionV1 {
  return {
    ...session,
    ...patch,
    revision: session.revision + 1,
    updatedAt: update.at,
  };
}

/**
 * A durable user/host wait cannot depend on the process that created it.  The
 * active owner is therefore immediately recoverable by a fresh host while the
 * session revision and lease epoch remain the CAS fence for that recovery.
 */
function withReleasedDurableWait(
  session: ResearchSessionV1,
  update: ResearchSessionFencedUpdateV1,
  patch: Parameters<typeof withNext>[2],
): ResearchSessionV1 {
  const next = withNext(session, update, patch);
  const releasedAt = Math.max(
    Date.parse(update.at),
    Date.parse(session.lease.heartbeatAt) + 1,
  );
  return {
    ...next,
    lease: {
      ...session.lease,
      expiresAt: new Date(releasedAt).toISOString(),
    },
  };
}

function requireGraph(current: ResearchSessionTurnV1, graphRevision?: number): ResearchGraphV1 {
  if (!current.graph) invalid("Research session turn does not have a graph.");
  if (graphRevision !== undefined && current.graph.revision !== graphRevision) invalid("Research graph revision is stale.");
  return current.graph;
}

function repairFollowUpMatchesDefect(
  defect: ResearchReconciliationDefectV1,
  followUp: ResearchReconciliationFollowUpProposalV1,
): boolean {
  if (followUp.defectId !== defect.id) return false;
  switch (defect.code) {
    case "missing_coverage": return followUp.reasonCode === "coverage_gap";
    case "contradicted": return followUp.reasonCode === "contradiction";
    case "stale": return followUp.reasonCode === "stale_or_truncated";
    case "unsupported":
    case "overstated": return followUp.reasonCode === "negative_claim";
    case "instruction_mismatch":
    case "duplicate": return false;
  }
}

function validateSession(session: ResearchSessionV1): void {
  if (session.schema !== RESEARCH_SESSION_SCHEMA_V1 || !/^research-session:[A-Za-z0-9._-]{1,120}$/.test(session.sessionId)) invalid("Research session identity is invalid.");
  if (!Number.isSafeInteger(session.revision) || session.revision < 1) invalid("Research session revision is invalid.");
  timestamp(session.createdAt, "Research session creation timestamp");
  timestamp(session.updatedAt, "Research session update timestamp");
  if (!Number.isSafeInteger(session.lease.epoch) || session.lease.epoch < 1 || !validId(session.lease.ownerId, "owner:")) invalid("Research session lease is invalid.");
  timestamp(session.lease.heartbeatAt, "Research session lease heartbeat");
  timestamp(session.lease.expiresAt, "Research session lease expiry");
  if (Date.parse(session.lease.expiresAt) <= Date.parse(session.lease.heartbeatAt)) invalid("Research session lease expiry must follow heartbeat.");
  if (session.turns.length > 64 || new Set(session.turns.map((candidate) => candidate.id)).size !== session.turns.length) invalid("Research session turns are invalid.");
  if (session.activeTurnId && !session.turns.some((candidate) => candidate.id === session.activeTurnId)) invalid("Research session active turn is invalid.");
  if (session.scopeClarification !== undefined) {
    validateScopeClarification(session, session.scopeClarification);
  } else if (session.status === "waiting_scope_clarification") {
    invalid("A scope-clarification wait requires its durable input.");
  }
  for (const candidate of session.turns) {
    if (candidate.budgetState !== undefined) parseResearchRunBudgetStateV1(candidate.budgetState);
    if (candidate.planRevisions !== undefined) {
      if (!Array.isArray(candidate.planRevisions) || candidate.planRevisions.length > 16 ||
          new Set(candidate.planRevisions.map((revision) => revision.id)).size !== candidate.planRevisions.length) {
        invalid("Research session plan revisions are invalid.");
      }
      let previousGraphRevision = 0;
      for (const revision of candidate.planRevisions) {
        const proposedGraphRevision = revision.proposedGraphRevision;
        if (revision.schema !== RESEARCH_SESSION_PLAN_REVISION_SCHEMA_V1 ||
            !/^plan-revision:[A-Za-z0-9._-]{1,120}$/.test(revision.id) ||
            !Number.isSafeInteger(revision.basedOnBriefRevision) || revision.basedOnBriefRevision < 1 ||
            !Number.isSafeInteger(revision.basedOnGraphRevision) || revision.basedOnGraphRevision < 1 ||
            revision.basedOnGraphRevision <= previousGraphRevision ||
            !revision.rejectionReason.trim() || revision.rejectionReason.length > 1_000 ||
            revision.rejectedBrief.sessionId !== session.sessionId || revision.rejectedBrief.turnId !== candidate.id ||
            revision.rejectedBrief.revision !== revision.basedOnBriefRevision ||
            revision.rejectedGraph.sessionId !== session.sessionId || revision.rejectedGraph.turnId !== candidate.id ||
            revision.rejectedGraph.revision !== revision.basedOnGraphRevision ||
            revision.rejectedGraph.basedOnBriefRevision !== revision.basedOnBriefRevision ||
            !["rejected", "revision_requested", "proposed", "approved"].includes(revision.state)) {
          invalid("Research session plan revision is invalid.");
        }
        validateResearchGraphV1(revision.rejectedGraph);
        timestamp(revision.requestedAt, "Research session plan revision timestamp");
        if (revision.instruction !== undefined && (!revision.instruction.trim() || revision.instruction.length > 2_000)) {
          invalid("Research session plan revision instruction is invalid.");
        }
        const materialized = revision.state === "revision_requested" || revision.state === "proposed" || revision.state === "approved";
        if (materialized !== (revision.instruction !== undefined && revision.revisedBriefRevision !== undefined) ||
            (revision.revisedBriefRevision !== undefined && revision.revisedBriefRevision <= revision.basedOnBriefRevision) ||
            ((revision.state === "proposed" || revision.state === "approved") &&
              (!Number.isSafeInteger(proposedGraphRevision) || (proposedGraphRevision ?? -1) <= revision.basedOnGraphRevision)) ||
            ((revision.state === "proposed" || revision.state === "approved") !== (revision.planDiff !== undefined)) ||
            (revision.planDiff !== undefined &&
              (revision.planDiff.schema !== "atlcli.research-plan-diff/v1" ||
                revision.planDiff.fromRevision !== revision.basedOnGraphRevision ||
                revision.planDiff.toRevision !== (proposedGraphRevision ?? -1))) ||
            (revision.state === "approved" && revision.approvedAt === undefined) ||
            (revision.state !== "approved" && revision.approvedAt !== undefined)) {
          invalid("Research session plan revision transition is invalid.");
        }
        if (revision.approvedAt !== undefined) timestamp(revision.approvedAt, "Research session plan revision approval timestamp");
        previousGraphRevision = revision.basedOnGraphRevision;
      }
    }
    if (candidate.scopeRevisions !== undefined) {
      if (!Array.isArray(candidate.scopeRevisions) || candidate.scopeRevisions.length > 16 ||
          new Set(candidate.scopeRevisions.map((revision) => revision.id)).size !== candidate.scopeRevisions.length) {
        invalid("Research session scope revisions are invalid.");
      }
      let previousGraphRevision = 0;
      for (const revision of candidate.scopeRevisions) {
        const proposedGraphRevision = revision.proposedGraphRevision;
        const binding = revision.approvedBinding;
        const isWholeScopeBinding = (binding.product === "jira" && binding.entityKind === "project") ||
          (binding.product === "confluence" && binding.entityKind === "space");
        if (revision.schema !== RESEARCH_SESSION_SCOPE_REVISION_SCHEMA_V1 ||
            !/^scope-revision:[A-Za-z0-9._-]{1,160}$/.test(revision.id) ||
            !/^scope-expansion:[A-Za-z0-9._-]{1,120}$/.test(revision.proposalId) ||
            revision.expansionKind !== "whole_scope" ||
            !Number.isSafeInteger(revision.basedOnBriefRevision) || revision.basedOnBriefRevision < 1 ||
            !Number.isSafeInteger(revision.basedOnGraphRevision) || revision.basedOnGraphRevision < 1 ||
            revision.basedOnGraphRevision <= previousGraphRevision ||
            !isWholeScopeBinding || !binding.key || binding.authority !== "approved" || binding.source !== "research_discovery" ||
            binding.tenantOrigin !== candidate.brief?.scope.siteOrigin ||
            revision.previousBrief.sessionId !== session.sessionId || revision.previousBrief.turnId !== candidate.id ||
            revision.previousBrief.revision !== revision.basedOnBriefRevision ||
            revision.previousGraph.sessionId !== session.sessionId || revision.previousGraph.turnId !== candidate.id ||
            revision.previousGraph.revision !== revision.basedOnGraphRevision ||
            revision.previousGraph.basedOnBriefRevision !== revision.basedOnBriefRevision ||
            revision.revisedBriefRevision <= revision.basedOnBriefRevision ||
            !["proposed", "approved"].includes(revision.state)) {
          invalid("Research session scope revision is invalid.");
        }
        validateResearchGraphV1(revision.previousGraph);
        if (revision.planDiff === undefined ||
            !Number.isSafeInteger(proposedGraphRevision) || (proposedGraphRevision ?? -1) <= revision.basedOnGraphRevision ||
            (revision.planDiff !== undefined &&
              (revision.planDiff.schema !== "atlcli.research-plan-diff/v1" ||
                revision.planDiff.fromRevision !== revision.basedOnGraphRevision ||
                revision.planDiff.toRevision !== (proposedGraphRevision ?? -1))) ||
            (revision.state === "approved" && revision.approvedAt === undefined) ||
            (revision.state !== "approved" && revision.approvedAt !== undefined)) {
          invalid("Research session scope revision transition is invalid.");
        }
        if (revision.approvedAt !== undefined) timestamp(revision.approvedAt, "Research session scope revision approval timestamp");
        previousGraphRevision = revision.basedOnGraphRevision;
      }
    }
    if (candidate.graphRevisions !== undefined) {
      if (!Array.isArray(candidate.graphRevisions) || candidate.graphRevisions.length > 16) {
        invalid("Research session graph revisions are invalid.");
      }
      let previousRevision = 0;
      for (const revision of candidate.graphRevisions) {
        if (revision.schema !== RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1 ||
            revision.graph.sessionId !== session.sessionId || revision.graph.turnId !== candidate.id ||
            revision.graph.revision <= previousRevision ||
            !RESEARCH_GRAPH_REVISION_REASONS_V1.includes(revision.reason) ||
            (revision.reason === "user_steering" &&
              (revision.steeringId === undefined || revision.planDiff === undefined)) ||
            ((revision.steeringId !== undefined || revision.planDiff !== undefined) &&
              (revision.steeringId === undefined || revision.planDiff === undefined ||
                revision.reason !== "user_steering" ||
                !/^steering:[A-Za-z0-9._-]{1,120}$/.test(revision.steeringId) ||
                revision.planDiff.schema !== "atlcli.research-plan-diff/v1" ||
                revision.planDiff.fromRevision !== revision.graph.revision - 1 ||
                revision.planDiff.toRevision !== revision.graph.revision))) {
          invalid("Research session graph revision is invalid.");
        }
        validateResearchGraphV1(revision.graph);
        validateBodyFreeReferenceIds(revision.evidenceIds, "Research session graph revision evidence IDs");
        validateBodyFreeReferenceIds(revision.gapIds, "Research session graph revision gap IDs");
        timestamp(revision.recordedAt, "Research session graph revision timestamp");
        previousRevision = revision.graph.revision;
      }
    }
    if (!Array.isArray(candidate.steering) || candidate.steering.length > 16 ||
        new Set(candidate.steering.map((steering) => steering.id)).size !== candidate.steering.length) {
      invalid("Research session steering history is invalid.");
    }
    for (const steering of candidate.steering) {
      const applied = steering.state === "applied";
      if (!/^steering:[A-Za-z0-9._-]{1,120}$/.test(steering.id) ||
          !steering.request.trim() || steering.request.length > 2_000 ||
          !Number.isSafeInteger(steering.basedOnGraphRevision) || steering.basedOnGraphRevision < 1 ||
          (steering.state !== "requested" && steering.state !== "applied") ||
          (applied !== (steering.appliedAt !== undefined && steering.appliedGraphRevision !== undefined && steering.planDiff !== undefined)) ||
          (steering.appliedGraphRevision !== undefined && steering.appliedGraphRevision <= steering.basedOnGraphRevision) ||
          (steering.planDiff !== undefined &&
            (steering.planDiff.schema !== "atlcli.research-plan-diff/v1" ||
              steering.planDiff.fromRevision !== steering.basedOnGraphRevision ||
              steering.planDiff.toRevision !== steering.appliedGraphRevision))) {
        invalid("Research session steering record is invalid.");
      }
      timestamp(steering.requestedAt, "Research steering request timestamp");
      if (steering.appliedAt !== undefined) timestamp(steering.appliedAt, "Research steering application timestamp");
    }
    if (candidate.retrievalAssessments !== undefined) {
      if (!Array.isArray(candidate.retrievalAssessments) || candidate.retrievalAssessments.length > 64) {
        invalid("Research session retrieval assessments are invalid.");
      }
      const wavesByGraphRevision = new Map<number, Set<number>>();
      for (const assessment of candidate.retrievalAssessments) {
        if (assessment.schema !== RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1 ||
            !Number.isSafeInteger(assessment.graphRevision) || assessment.graphRevision < 1) {
          invalid("Research session retrieval assessment is invalid or duplicated.");
        }
        const wave = assessment.wave ?? 1;
        if (!Number.isSafeInteger(wave) || wave < 1) {
          invalid("Research session retrieval assessment is invalid or duplicated.");
        }
        const waves = wavesByGraphRevision.get(assessment.graphRevision) ?? new Set<number>();
        if (waves.has(wave)) invalid("Research session retrieval assessment is invalid or duplicated.");
        waves.add(wave);
        wavesByGraphRevision.set(assessment.graphRevision, waves);
        timestamp(assessment.recordedAt, "Research session retrieval assessment timestamp");
        parseResearchRetrievalAssessmentV1(assessment.assessment);
        const continuation = assessment.continuation;
        if (continuation !== undefined) {
          const expectedId = `research-continuation:${assessment.graphRevision}.${wave}`;
          if (continuation.schema !== RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1 ||
              continuation.id !== expectedId ||
              (continuation.status !== "issued" && continuation.status !== "consumed") ||
              (continuation.status === "issued" && continuation.consumedAt !== undefined) ||
              (continuation.status === "consumed" && continuation.consumedAt === undefined)) {
            invalid("Research session retrieval continuation is invalid.");
          }
          timestamp(continuation.issuedAt, "Research session retrieval continuation issuance timestamp");
          if (continuation.consumedAt !== undefined) {
            timestamp(continuation.consumedAt, "Research session retrieval continuation consumption timestamp");
            if (Date.parse(continuation.consumedAt) < Date.parse(continuation.issuedAt)) {
              invalid("Research session retrieval continuation consumption precedes issuance.");
            }
          }
        }
      }
      for (const waves of wavesByGraphRevision.values()) {
        if (Math.max(...waves) !== waves.size) {
          invalid("Research session retrieval assessment waves are not contiguous.");
        }
      }
    }
  }
  if (session.status === "waiting_steering") {
    const active = session.activeTurnId
      ? session.turns.find((turn) => turn.id === session.activeTurnId)
      : undefined;
    if (!active?.graph ||
        active.steering.filter((steering) => steering.state === "requested").length !== 1) {
      invalid("A steering wait requires exactly one pending durable control.");
    }
  }
  if (session.status === "deleted" && session.retention.state !== "deleted") invalid("A deleted research session must have deleted retention.");
}

export function createResearchSessionV1(input: {
  sessionId: string;
  ownerId: string;
  createdAt: string;
  leaseExpiresAt: string;
}): ResearchSessionV1 {
  const session: ResearchSessionV1 = {
    schema: RESEARCH_SESSION_SCHEMA_V1,
    sessionId: input.sessionId,
    revision: 1,
    status: "idle",
    lease: { epoch: 1, ownerId: input.ownerId, heartbeatAt: input.createdAt, expiresAt: input.leaseExpiresAt },
    retention: { state: "active" },
    turns: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  validateSession(session);
  return clone(session);
}

/**
 * Pure session reducer. A caller persists the returned value and its matching
 * journal/outbox event atomically; no mutation is made to the input value.
 */
export function reduceResearchSessionV1(
  value: ResearchSessionV1,
  update: ResearchSessionUpdateV1,
): ResearchSessionV1 {
  const session = clone(value);
  validateSession(session);
  ensureFence(session, update);
  if (session.status === "deleted") invalid("A deleted research session cannot be updated.");

  if (update.kind === "recover") {
    if (Date.parse(update.at) < Date.parse(session.lease.expiresAt)) invalid("Research session lease has not expired.");
    if (!validId(update.ownerId, "owner:") || Date.parse(update.expiresAt) <= Date.parse(update.at)) invalid("Research session recovery lease is invalid.");
    return {
      ...session,
      revision: session.revision + 1,
      lease: { epoch: session.lease.epoch + 1, ownerId: update.ownerId, heartbeatAt: update.at, expiresAt: update.expiresAt },
      updatedAt: update.at,
    };
  }

  if (update.kind === "record_scope_clarification") {
    if (session.status !== "idle" || session.activeTurnId || session.scopeClarification) {
      invalid("Research session cannot record a scope clarification while active.");
    }
    const next: ResearchSessionScopeClarificationV1 = {
      schema: RESEARCH_SESSION_SCOPE_CLARIFICATION_SCHEMA_V1,
      state: "waiting_choice",
      request: clone(normalizeResearchRequestV1(update.request)),
      policy: clone(normalizeResearchOneShotPolicyV1(update.policy)),
      clarification: clone(update.clarification),
      candidateChoices: clone(update.candidateChoices),
    };
    validateScopeClarification(
      { ...session, status: "waiting_scope_clarification", scopeClarification: next },
      next,
    );
    return withReleasedDurableWait(session, update, {
      status: "waiting_scope_clarification",
      scopeClarification: next,
    });
  }

  if (update.kind === "refresh_scope_clarification") {
    const current = session.scopeClarification;
    if (session.status !== "waiting_scope_clarification" || session.activeTurnId ||
        current?.state !== "waiting_choice") {
      invalid("Research session is not awaiting a scope clarification choice.");
    }
    const next: ResearchSessionScopeClarificationV1 = {
      ...current,
      clarification: clone(update.clarification),
      candidateChoices: clone(update.candidateChoices),
    };
    validateScopeClarification(
      { ...session, status: "waiting_scope_clarification", scopeClarification: next },
      next,
    );
    return withReleasedDurableWait(session, update, {
      status: "waiting_scope_clarification",
      scopeClarification: next,
    });
  }

  if (update.kind === "resolve_scope_clarification") {
    const current = session.scopeClarification;
    if (session.status !== "waiting_scope_clarification" || session.activeTurnId ||
        current?.state !== "waiting_choice" ||
        update.selection.schema !== "atlcli.research-scope-candidate-selection/v1" ||
        update.selection.mentionId !== current.clarification.mentionId ||
        !current.clarification.candidateIds.includes(update.selection.candidateId)) {
      invalid("Research session scope clarification choice is stale or invalid.");
    }
    const resolvedRequest = clone(normalizeResearchRequestV1(update.resolvedRequest));
    const next: ResearchSessionScopeClarificationV1 = {
      ...current,
      state: "choice_resolved",
      selection: clone(update.selection),
      resolvedRequest,
    };
    validateScopeClarification(
      { ...session, status: "idle", scopeClarification: next },
      next,
    );
    return withReleasedDurableWait(session, update, {
      status: "idle",
      scopeClarification: next,
    });
  }

  if (update.kind === "initialize_scope_brief") {
    const scopeClarification = session.scopeClarification;
    if (session.status !== "idle" || session.activeTurnId ||
        scopeClarification?.state !== "choice_resolved" ||
        !scopeClarification.resolvedRequest ||
        update.brief.sessionId !== session.sessionId ||
        update.brief.objective !== scopeClarification.resolvedRequest.question ||
        JSON.stringify(update.brief.scope) !== JSON.stringify(scopeClarification.resolvedRequest.scope) ||
        update.brief.turnId === "" ||
        session.turns.some((candidate) => candidate.id === update.brief.turnId)) {
      invalid("Research session scope clarification cannot initialize this brief.");
    }
    const nextTurn: ResearchSessionTurnV1 = {
      id: update.brief.turnId,
      revision: update.brief.revision,
      createdAt: update.at,
      brief: clone(update.brief),
      scopeCandidates: clone(update.scopeCandidates ?? update.brief.scopeCandidates),
      scopeBindings: clone(update.scopeBindings ?? update.brief.scopeBindings),
      scopeResolutions: clone(update.scopeResolutions ?? update.brief.scopeResolutions),
      scopeExpansionProposals: [],
      clarifications: [],
      assumptionDecisions: [],
      planRevisions: [],
      scopeRevisions: [],
      steering: [],
      tasks: [],
      acceptedPackets: [],
      reconciliationDispositions: [],
      retrievalAssessments: [],
      checkpoints: [],
    };
    const needsClarification = update.brief.clarificationQuestions.length > 0 ||
      update.brief.assumptions.some((assumption) =>
        assumption.requiresUserDecision && assumption.status === "proposed"
      );
    const patch = {
      status: needsClarification ? "waiting_clarification" as const : "planning" as const,
      activeTurnId: update.brief.turnId,
      turns: [...session.turns, nextTurn],
    };
    const next = needsClarification
      ? withReleasedDurableWait(session, update, patch)
      : withNext(session, update, patch);
    validateSession(next);
    return next;
  }

  if (update.kind === "create_turn") {
    if (session.status !== "idle" && session.status !== "complete" && session.status !== "cancelled" && session.status !== "failed") invalid("Research session cannot create a turn while active.");
    if (!/^research-turn:[A-Za-z0-9._-]{1,120}$/.test(update.turnId) || session.turns.some((candidate) => candidate.id === update.turnId)) invalid("Research session turn ID is invalid or duplicated.");
    const nextTurn: ResearchSessionTurnV1 = {
      id: update.turnId,
      revision: 1,
      createdAt: update.at,
      scopeCandidates: [], scopeBindings: [], scopeResolutions: [], scopeExpansionProposals: [], clarifications: [], assumptionDecisions: [], planRevisions: [], scopeRevisions: [], steering: [], tasks: [], acceptedPackets: [], reconciliationDispositions: [], retrievalAssessments: [], checkpoints: [],
    };
    return withNext(session, update, { status: "planning", activeTurnId: update.turnId, turns: [...session.turns, nextTurn] });
  }

  if (update.kind === "record_brief") {
    const current = ensureActive(session, ["planning", "waiting_clarification", "waiting_plan_revision"]);
    if (update.brief.sessionId !== session.sessionId || update.brief.turnId !== current.id || update.brief.revision !== current.revision || current.brief) invalid("Research session brief does not match the active draft turn.");
    const nextTurn = {
      ...current,
      brief: clone(update.brief),
      scopeCandidates: clone(update.scopeCandidates ?? update.brief.scopeCandidates),
      scopeBindings: clone(update.scopeBindings ?? update.brief.scopeBindings),
      scopeResolutions: clone(update.scopeResolutions ?? update.brief.scopeResolutions),
    };
    const nextStatus: ResearchSessionStatusV1 = update.brief.clarificationQuestions.length > 0 || update.brief.assumptions.some((assumption) => assumption.requiresUserDecision && assumption.status === "proposed")
      ? "waiting_clarification"
      : "planning";
    const patch = { status: nextStatus, turns: replaceTurn(session, nextTurn) };
    return nextStatus === "waiting_clarification"
      ? withReleasedDurableWait(session, update, patch)
      : withNext(session, update, patch);
  }

  if (update.kind === "record_clarification") {
    const current = ensureActive(session, ["waiting_clarification"]);
    if (!current.brief || current.brief.revision !== update.briefRevision || !/^clarification:[A-Za-z0-9._-]{1,120}$/.test(update.questionId) || !update.response.trim() || update.response.length > 2_000) invalid("Research clarification does not match the active brief.");
    const question = current.brief.clarificationQuestions.find((candidate) => candidate.id === update.questionId);
    if (!question || current.clarifications.some((candidate) => candidate.questionId === update.questionId)) invalid("Research clarification question is unknown or already answered.");
    if ((update.assumptionId === undefined) !== (update.assumptionDecision === undefined)) invalid("Research assumption decisions must include both ID and decision.");
    if (update.assumptionId && (!current.brief.assumptions.some((assumption) => assumption.id === update.assumptionId && assumption.requiresUserDecision) || current.assumptionDecisions.some((decision) => decision.assumptionId === update.assumptionId))) invalid("Research clarification assumption is unknown.");
    const nextTurn = {
      ...current,
      clarifications: [...current.clarifications, {
        briefRevision: update.briefRevision,
        questionId: update.questionId,
        response: update.response.trim(),
        ...(update.assumptionId ? { assumptionId: update.assumptionId, assumptionDecision: update.assumptionDecision } : {}),
        answeredAt: update.at,
      }],
      ...(update.assumptionId ? {
        assumptionDecisions: [...current.assumptionDecisions, {
          briefRevision: update.briefRevision,
          assumptionId: update.assumptionId,
          decision: update.assumptionDecision!,
          decidedAt: update.at,
        }],
      } : {}),
    };
    // Incremental record updates preserve the durable wait. Only the closed
    // batch transition below may materialize a runnable successor brief.
    return withReleasedDurableWait(session, update, {
      status: "waiting_clarification",
      turns: replaceTurn(session, nextTurn),
    });
  }

  if (update.kind === "record_assumption_decision") {
    const current = ensureActive(session, ["waiting_clarification"]);
    if (!current.brief || current.brief.revision !== update.briefRevision || !/^assumption:[A-Za-z0-9._-]{1,120}$/.test(update.assumptionId)) invalid("Research assumption decision does not match the active brief.");
    const assumption = current.brief.assumptions.find((candidate) => candidate.id === update.assumptionId);
    if (!assumption?.requiresUserDecision || current.assumptionDecisions.some((candidate) => candidate.assumptionId === update.assumptionId)) invalid("Research assumption is unknown or already decided.");
    const nextTurn = { ...current, assumptionDecisions: [...current.assumptionDecisions, { briefRevision: update.briefRevision, assumptionId: update.assumptionId, decision: update.decision, decidedAt: update.at }] };
    return withReleasedDurableWait(session, update, {
      status: "waiting_clarification",
      turns: replaceTurn(session, nextTurn),
    });
  }

  if (update.kind === "resolve_clarifications") {
    const current = ensureActive(session, ["waiting_clarification"]);
    if (!current.brief || current.brief.revision !== update.briefRevision) {
      invalid("Research clarification resolution does not match the active brief.");
    }
    const answers = [
      ...current.clarifications.map((answer) => ({
        questionId: answer.questionId,
        response: answer.response,
      })),
      ...update.answers,
    ];
    const assumptionDecisions = [
      ...current.assumptionDecisions.map((decision) => ({
        assumptionId: decision.assumptionId,
        decision: decision.decision,
      })),
      ...update.assumptionDecisions,
    ];
    let resolvedBrief: ResearchBriefV1;
    try {
      resolvedBrief = resolveResearchBriefClarificationsV1({
        brief: current.brief,
        answers,
        assumptionDecisions,
      });
    } catch (error) {
      invalid(error instanceof Error ? error.message : "Research clarification resolution is invalid.");
    }
    const nextTurn = {
      ...current,
      revision: current.revision + 1,
      brief: resolvedBrief!,
      clarifications: [
        ...current.clarifications,
        ...update.answers.map((answer) => ({
          briefRevision: update.briefRevision,
          questionId: answer.questionId,
          response: answer.response.trim(),
          answeredAt: update.at,
        })),
      ],
      assumptionDecisions: [
        ...current.assumptionDecisions,
        ...update.assumptionDecisions.map((decision) => ({
          briefRevision: update.briefRevision,
          assumptionId: decision.assumptionId,
          decision: decision.decision,
          decidedAt: update.at,
        })),
      ],
    };
    return withNext(session, update, {
      status: "planning",
      turns: replaceTurn(session, nextTurn),
    });
  }

  if (update.kind === "propose_graph" || update.kind === "revise_graph") {
    const current = ensureActive(session, ["planning"]);
    validateResearchGraphV1(update.graph);
    if (!current.brief || update.graph.sessionId !== session.sessionId || update.graph.turnId !== current.id || update.graph.basedOnBriefRevision !== current.brief.revision || update.graph.status !== "proposed") invalid("Research graph proposal does not match the active brief.");
    if (update.kind === "propose_graph" && current.graph) invalid("Research graph proposal already exists.");
    const planRevisionRecord = (current.planRevisions ?? []).at(-1);
    const revisingPlan = update.kind === "revise_graph" && Boolean(
      current.graph && planRevisionRecord?.state === "revision_requested" &&
      planRevisionRecord.basedOnGraphRevision === current.graph.revision &&
      planRevisionRecord.revisedBriefRevision === current.brief.revision,
    );
    if (update.kind === "revise_graph" &&
        (!current.graph || update.graph.revision !== current.graph.revision + 1 ||
          !revisingPlan)) {
      invalid("Research graph revision is invalid.");
    }
    const pendingScopeExpansionProposalIds = current.scopeExpansionProposals
      .filter((proposal) => proposal.status === "proposed")
      .map((proposal) => proposal.id);
    const nextTurn = {
      ...current,
      graph: clone(update.graph),
      ...(revisingPlan ? {
        planRevisions: (current.planRevisions ?? []).map((record) => record.id === planRevisionRecord!.id ? {
          ...record,
          state: "proposed" as const,
          proposedGraphRevision: update.graph.revision,
          planDiff: diffResearchPlansV1({
            fromBrief: record.rejectedBrief,
            fromGraph: record.rejectedGraph,
            toBrief: current.brief!,
            toGraph: update.graph,
            scopeExpansionProposalIds: pendingScopeExpansionProposalIds,
          }),
        } : record),
      } : {}),
      revision: current.revision + 1,
    };
    const patch: Parameters<typeof withNext>[2] = {
      status: "waiting_plan_approval",
      turns: replaceTurn(session, nextTurn),
    };
    return update.kind === "propose_graph" && update.retainLeaseForImmediateApproval === true
      ? withNext(session, update, patch)
      : withReleasedDurableWait(session, update, patch);
  }

  if (update.kind === "apply_graph_revision") {
    const current = ensureActive(session, ["running"]);
    const previous = requireGraph(current);
    validateResearchGraphV1(update.graph);
    validateBodyFreeReferenceIds(update.evidenceIds, "Research graph revision evidence IDs");
    validateBodyFreeReferenceIds(update.gapIds, "Research graph revision gap IDs");
    if (update.graph.sessionId !== session.sessionId || update.graph.turnId !== current.id ||
        update.graph.basedOnBriefRevision !== previous.basedOnBriefRevision ||
        update.graph.revision !== previous.revision + 1 ||
        update.graph.status !== "running" || update.graph.approvalEnvelope.status !== "approved" ||
        !RESEARCH_GRAPH_REVISION_REASONS_V1.includes(update.reason)) {
      invalid("Research graph revision does not match the active durable graph.");
    }
    const steering = update.steeringId === undefined
      ? undefined
      : current.steering.find((candidate) => candidate.id === update.steeringId);
    if ((update.steeringId === undefined && update.reason === "user_steering") ||
        (update.steeringId !== undefined &&
          (!steering || steering.state !== "requested" ||
            steering.basedOnGraphRevision !== previous.revision ||
            update.reason !== "user_steering"))) {
      invalid("Research graph revision steering control is invalid or stale.");
    }
    const planDiff = steering
      ? diffResearchPlansV1({
          fromBrief: current.brief!,
          fromGraph: previous,
          toBrief: current.brief!,
          toGraph: update.graph,
        })
      : undefined;
    if (planDiff?.exceededApprovalEnvelopeFields.length) {
      invalid("Research steering revision exceeds the approved graph envelope.");
    }
    const previousHistory = current.graphRevisions ?? [];
    const history = previousHistory.some((record) => record.graph.revision === previous.revision)
      ? previousHistory
      : [
          ...previousHistory,
          {
            schema: RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1,
            graph: clone(previous),
            evidenceIds: [],
            gapIds: [],
            reason: update.reason,
            recordedAt: previous.createdAt,
          },
        ];
    if (history.some((record) => record.graph.revision === update.graph.revision) || history.length >= 16) {
      invalid("Research graph revision history is exhausted or duplicated.");
    }
    const record: ResearchSessionGraphRevisionV1 = {
      schema: RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1,
      graph: clone(update.graph),
      evidenceIds: [...update.evidenceIds],
      gapIds: [...update.gapIds],
      reason: update.reason,
      ...(update.steeringId === undefined ? {} : { steeringId: update.steeringId }),
      ...(planDiff === undefined ? {} : { planDiff }),
      recordedAt: update.at,
    };
    return withNext(session, update, {
      status: "running",
      turns: replaceTurn(session, {
        ...current,
        revision: current.revision + 1,
        graph: clone(update.graph),
        graphRevisions: [...history, record],
        ...(steering ? {
          steering: current.steering.map((candidate) => candidate.id === steering.id
            ? {
                ...candidate,
                state: "applied" as const,
                appliedAt: update.at,
                appliedGraphRevision: update.graph.revision,
                planDiff,
              }
            : candidate),
        } : {}),
      }),
    });
  }

  if (update.kind === "approve_graph") {
    const current = ensureActive(session, ["waiting_plan_approval"]);
    const graph = requireGraph(current, update.graphRevision);
    const nextTurn = {
      ...current,
      graph: reduceResearchGraphV1(graph, { kind: "approve", expectedRevision: graph.revision, approvedAt: update.at }),
      ...(current.planRevisions?.some((record) => record.state === "proposed" && record.proposedGraphRevision === graph.revision) ? {
        planRevisions: current.planRevisions.map((record) =>
          record.state === "proposed" && record.proposedGraphRevision === graph.revision
            ? { ...record, state: "approved" as const, approvedAt: update.at }
            : record,
        ),
      } : {}),
      ...(current.scopeRevisions?.some((record) => record.state === "proposed" && record.proposedGraphRevision === graph.revision) ? {
        scopeRevisions: current.scopeRevisions.map((record) =>
          record.state === "proposed" && record.proposedGraphRevision === graph.revision
            ? { ...record, state: "approved" as const, approvedAt: update.at }
            : record,
        ),
      } : {}),
    };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "commit_graph_selection") {
    const current = ensureActive(session, ["running", "pause_requested"]);
    const graph = requireGraph(current);
    if (current.graphSelectionCommittedAt || current.tasks.length > 0 ||
        current.acceptedPackets.length > 0 || current.reconciliationDispositions.length > 0) {
      invalid("Research graph selection is immutable after it is committed or dispatch begins.");
    }
    const selected = acceptResearchGraphProposalV1(graph, update.proposal);
    const selectedReconciler = selected.nodes.find((node) => node.roleId === "reconciler");
    const latentRepairNode = selectedReconciler
      ? graph.nodes.find((node) => node.kind === "repair")
      : undefined;
    const nextTurn = {
      ...current,
      graph: selected,
      graphSelectionCommittedAt: update.at,
      ...(latentRepairNode ? { latentRepairNode: clone(latentRepairNode) } : {}),
      revision: current.revision + 1,
    };
    return withNext(session, update, { status: session.status, turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "reject_plan") {
    const current = ensureActive(session, ["waiting_plan_approval"]);
    const graph = requireGraph(current, update.graphRevision);
    if (!update.reason.trim() || update.reason.length > 1_000) invalid("Research plan rejection reason is invalid.");
    const planRevisions = current.planRevisions ?? [];
    if (planRevisions.some((record) => record.basedOnGraphRevision === graph.revision)) {
      invalid("Research plan rejection is already recorded for this graph revision.");
    }
    const record: ResearchSessionPlanRevisionV1 = {
      schema: RESEARCH_SESSION_PLAN_REVISION_SCHEMA_V1,
      id: `plan-revision:${graph.revision}`,
      basedOnBriefRevision: current.brief?.revision ?? graph.basedOnBriefRevision,
      basedOnGraphRevision: graph.revision,
      rejectionReason: update.reason.trim(),
      requestedAt: update.at,
      rejectedBrief: clone(current.brief!),
      rejectedGraph: clone(graph),
      state: "rejected",
    };
    return withReleasedDurableWait(session, update, {
      status: "waiting_plan_revision",
      turns: replaceTurn(session, {
        ...current,
        planRevisions: [...planRevisions, record],
        revision: current.revision + 1,
      }),
    });
  }

  if (update.kind === "request_plan_revision") {
    const current = ensureActive(session, ["waiting_plan_revision"]);
    const graph = requireGraph(current, update.graphRevision);
    const instruction = update.instruction.trim();
    const revisionRecord = (current.planRevisions ?? []).find((record) =>
      record.basedOnGraphRevision === graph.revision && record.state === "rejected",
    );
    if (!current.brief || !revisionRecord || !instruction || instruction.length > 2_000) {
      invalid("Research plan revision request is invalid.");
    }
    let revisedBrief: ResearchBriefV1;
    try {
      revisedBrief = reviseResearchBriefPlanV1({
        brief: current.brief,
        basedOnGraphRevision: graph.revision,
        instruction,
        requestedAt: update.at,
      });
    } catch (error) {
      invalid(error instanceof Error ? error.message : "Research plan revision request is invalid.");
    }
    return withNext(session, update, {
      status: "planning",
      turns: replaceTurn(session, {
        ...current,
        brief: revisedBrief!,
        planRevisions: (current.planRevisions ?? []).map((record) => record.id === revisionRecord.id ? {
          ...record,
          state: "revision_requested" as const,
          instruction,
          revisedBriefRevision: revisedBrief!.revision,
        } : record),
        revision: current.revision + 1,
      }),
    });
  }

  if (update.kind === "propose_scope_expansion") {
    const current = ensureActive(session, ["running", "waiting_steering"]);
    const graph = requireGraph(current);
    const candidate = current.scopeCandidates.find((entry) => entry.id === update.proposal.candidateId);
    const validWholeScope = update.proposal.expansionKind === "whole_scope" &&
      ((candidate?.product === "jira" && candidate.entityKind === "project") ||
        (candidate?.product === "confluence" && candidate.entityKind === "space")) && Boolean(candidate?.key);
    const validExactEntity = update.proposal.expansionKind === "exact_entity" &&
      (candidate?.entityKind === "issue" || candidate?.entityKind === "page");
    if (update.proposal.sessionId !== session.sessionId || update.proposal.turnId !== current.id || update.proposal.basedOnBriefRevision !== current.brief?.revision || update.proposal.basedOnGraphRevision !== graph.revision || update.proposal.status !== "proposed" || current.scopeExpansionProposals.some((proposal) => proposal.id === update.proposal.id) || current.brief?.scopeDiscoveryPolicy.expansionMode === "strict" || !candidate || candidate.tenantOrigin !== current.brief?.scope.siteOrigin || candidate.status === "archived" || (!validWholeScope && !validExactEntity)) invalid("Research scope expansion proposal is invalid or stale.");
    const nextTurn = { ...current, scopeExpansionProposals: [...current.scopeExpansionProposals, clone(update.proposal)] };
    return withReleasedDurableWait(session, update, {
      status: "waiting_scope_approval",
      turns: replaceTurn(session, nextTurn),
    });
  }

  if (update.kind === "approve_scope_expansion" || update.kind === "reject_scope_expansion") {
    const current = ensureActive(session, ["waiting_scope_approval"]);
    const proposal = current.scopeExpansionProposals.find((candidate) => candidate.id === update.proposalId);
    if (!proposal || proposal.status !== "proposed") invalid("Research scope expansion proposal is unknown or already resolved.");
    const approved = update.kind === "approve_scope_expansion";
    const candidate = current.scopeCandidates.find((entry) => entry.id === proposal.candidateId);
    const binding = update.kind === "approve_scope_expansion" ? update.binding : undefined;
    const bindingMatchesCandidate = Boolean(binding && candidate &&
      /^scope-binding:[A-Za-z0-9:._%-]{1,180}$/.test(binding.id) &&
      binding.tenantOrigin === candidate.tenantOrigin &&
      binding.product === candidate.product && binding.entityKind === candidate.entityKind &&
      binding.entityRef === candidate.entityRef && binding.candidateId === candidate.id &&
      binding.authority === "approved" && binding.source === "research_discovery" &&
      binding.approvedAt === update.at && binding.key === candidate.key && binding.name === candidate.name);
    if (approved && !bindingMatchesCandidate) invalid("Research scope expansion binding is invalid.");
    const nextProposal: ResearchScopeExpansionProposalV1 = approved
      ? { ...proposal, status: "approved", approvedBindingId: binding!.id }
      : { ...proposal, status: "rejected" };
    if (approved && proposal.expansionKind === "whole_scope") {
      let revisedBrief: ResearchBriefV1;
      try {
        revisedBrief = approveResearchBriefWholeScopeExpansionV1({
          brief: current.brief!,
          binding: binding!,
          existingBindings: current.scopeBindings,
        });
      } catch (error) {
        invalid(error instanceof Error ? error.message : "Research whole-scope expansion is invalid.");
      }
      const scopeRevisions = current.scopeRevisions ?? [];
      if (scopeRevisions.some((record) => record.proposalId === proposal.id)) {
        invalid("Research scope expansion revision is already recorded.");
      }
      const graph = requireGraph(current);
      const replacementGraph = update.replacementGraph;
      if (!replacementGraph || replacementGraph.sessionId !== session.sessionId ||
          replacementGraph.turnId !== current.id ||
          replacementGraph.revision !== graph.revision + 1 ||
          replacementGraph.basedOnBriefRevision !== revisedBrief!.revision ||
          replacementGraph.status !== "proposed") {
        invalid("Research whole-scope replacement graph is invalid.");
      }
      validateResearchGraphV1(replacementGraph);
      const record: ResearchSessionScopeRevisionV1 = {
        schema: RESEARCH_SESSION_SCOPE_REVISION_SCHEMA_V1,
        id: `scope-revision:${proposal.id.slice("scope-expansion:".length)}`,
        proposalId: proposal.id,
        basedOnBriefRevision: current.brief!.revision,
        basedOnGraphRevision: graph.revision,
        expansionKind: "whole_scope",
        approvedBinding: clone(binding!),
        previousBrief: clone(current.brief!),
        previousGraph: clone(graph),
        state: "proposed",
        revisedBriefRevision: revisedBrief!.revision,
        proposedGraphRevision: replacementGraph.revision,
        planDiff: diffResearchPlansV1({
          fromBrief: current.brief!,
          fromGraph: graph,
          toBrief: revisedBrief!,
          toGraph: replacementGraph,
          scopeExpansionProposalIds: [],
        }),
      };
      return withReleasedDurableWait(session, update, {
        status: "waiting_plan_approval",
        turns: replaceTurn(session, {
          ...current,
          brief: revisedBrief!,
          graph: clone(replacementGraph),
          scopeBindings: [...current.scopeBindings, clone(binding!)],
          scopeExpansionProposals: current.scopeExpansionProposals.map((entry) => entry.id === proposal.id ? nextProposal : entry),
          scopeRevisions: [...scopeRevisions, record],
          revision: current.revision + 1,
        }),
      });
    }
    if (approved && update.replacementGraph !== undefined) {
      invalid("Research exact-entity scope approval cannot replace the graph.");
    }
    const nextTurn = {
      ...current,
      scopeExpansionProposals: current.scopeExpansionProposals.map((candidate) => candidate.id === proposal.id ? nextProposal : candidate),
      ...(approved ? { scopeBindings: [...current.scopeBindings, clone(binding!)] } : {}),
    };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "request_steering") {
    const current = ensureActive(session, ["paused"]);
    const graph = requireGraph(current, update.basedOnGraphRevision);
    const issuedContinuation = current.retrievalAssessments?.filter((assessment) =>
      assessment.graphRevision === graph.revision && assessment.continuation?.status === "issued",
    ) ?? [];
    if (!/^steering:[A-Za-z0-9._-]{1,120}$/.test(update.steeringId) ||
        !update.request.trim() || update.request.length > 2_000 ||
        current.steering.some((steering) => steering.id === update.steeringId) ||
        issuedContinuation.length !== 1 ||
        current.tasks.length === 0 || current.acceptedPackets.length === 0 ||
        current.budgetState === undefined ||
        current.tasks.some((task) => task.status === "ready" || task.status === "running" || task.status === "outcome_unknown")) {
      invalid("Research steering request requires one settled durable retrieval checkpoint.");
    }
    const nextTurn = {
      ...current,
      steering: [...current.steering, {
        id: update.steeringId,
        request: update.request.trim(),
        basedOnGraphRevision: graph.revision,
        requestedAt: update.at,
        state: "requested" as const,
      }],
    };
    return withReleasedDurableWait(session, update, {
      status: "waiting_steering",
      turns: replaceTurn(session, nextTurn),
    });
  }

  if (update.kind === "request_pause") {
    // A running owner must retain its lease while it reaches a durable
    // checkpoint. Releasing it here would let another runner reclaim a turn
    // whose provider work has not yet settled.
    const current = ensureActive(session, ["running"]);
    const continuationWasConsumed = current.retrievalAssessments?.some(
      (assessment) => assessment.continuation?.status === "consumed",
    ) ?? false;
    const retrievalAlreadyStopped = current.retrievalAssessments?.some(
      (assessment) => assessment.assessment.action === "stop",
    ) ?? false;
    if (continuationWasConsumed || retrievalAlreadyStopped) {
      invalid("Research pause is only available before the durable retrieval continuation is consumed.");
    }
    return withNext(session, update, {
      status: "pause_requested",
      turns: replaceTurn(session, { ...current, pauseRequestedAt: update.at }),
    });
  }

  if (update.kind === "acknowledge_pause") {
    const current = ensureActive(session, ["pause_requested"]);
    const hasUnsettledWork = current.tasks.some((task) =>
      task.status === "ready" || task.status === "running" || task.status === "outcome_unknown",
    );
    const hasIssuedContinuation = current.retrievalAssessments?.some((assessment) =>
      assessment.continuation?.status === "issued",
    ) ?? false;
    if (hasUnsettledWork || (current.graphSelectionCommittedAt !== undefined && !hasIssuedContinuation)) {
      invalid("Research pause acknowledgement requires a durable retrieval checkpoint without unsettled work.");
    }
    return withReleasedDurableWait(session, update, {
      status: "paused",
      turns: replaceTurn(session, { ...current, pausedAt: update.at }),
    });
  }

  if (update.kind === "admit_tasks") {
    const current = ensureActive(session, ["running", "pause_requested"]);
    if (session.status === "pause_requested" && (current.retrievalAssessments?.length ?? 0) > 0) {
      invalid("Research pause request prevents task admission after the retrieval checkpoint.");
    }
    const graph = requireGraph(current, update.graphRevision);
    if (!Array.isArray(update.tasks) || update.tasks.length === 0 || update.tasks.length > 16) invalid("Research task admission is invalid.");
    const nodeIds = new Set(graph.nodes.filter((node) => node.status === "ready").map((node) => node.id));
    const ids = new Set(current.tasks.map((task) => task.taskId));
    for (const task of update.tasks) {
      if (task.graphRevision !== graph.revision || task.status !== "ready" || task.dispatchState !== "not_started" || !nodeIds.has(task.nodeId) || ids.has(task.taskId)) invalid("Research task admission does not match a ready graph node.");
      ids.add(task.taskId);
    }
    const nextTurn = { ...current, tasks: [...current.tasks, ...clone(update.tasks)] };
    return withNext(session, update, { status: session.status, turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "dispatch_started" || update.kind === "outcome_unknown" || update.kind === "accept_packet" || update.kind === "quarantine_packet") {
    const current = ensureActive(session, ["running", "pause_requested"]);
    if (update.kind === "dispatch_started" && session.status === "pause_requested" &&
        (current.retrievalAssessments?.length ?? 0) > 0) {
      invalid("Research pause request prevents a new task dispatch after the retrieval checkpoint.");
    }
    const graph = requireGraph(current, update.graphRevision);
    const taskIndex = current.tasks.findIndex((task) => task.taskId === update.taskId && task.graphRevision === graph.revision);
    if (taskIndex < 0) invalid("Research task is unknown or stale.");
    const task = current.tasks[taskIndex]!;
    let nextTask: ResearchTaskAttemptV1;
    let nextGraph: ResearchGraphV1;
    let acceptedPackets = current.acceptedPackets;
    if (update.kind === "dispatch_started") {
      nextTask = reduceResearchTaskAttemptV1(task, { kind: "dispatch_started", at: update.at, ...(update.providerRequestId ? { providerRequestId: update.providerRequestId } : {}) });
      nextGraph = reduceResearchGraphV1(graph, { kind: "start_node", expectedRevision: graph.revision, nodeId: task.nodeId });
    } else if (update.kind === "outcome_unknown") {
      nextTask = reduceResearchTaskAttemptV1(task, { kind: "outcome_unknown", at: update.at });
      nextGraph = graph;
    } else if (update.kind === "accept_packet") {
      const reduced = reduceResearchAcceptedPacketV1({ current: task, body: update.body, usage: update.usage, acceptedAt: update.at, availableSourceIds: update.availableSourceIds, maximumResultBytes: update.maximumResultBytes });
      if (current.acceptedPackets.some((packet) => packet.taskId === task.taskId || packet.packetRef === reduced.packet.packetRef)) invalid("Research task already has an accepted packet.");
      nextTask = reduced.attempt;
      nextGraph = reduceResearchGraphV1(graph, { kind: "complete_node", expectedRevision: graph.revision, nodeId: task.nodeId, packetRef: reduced.packet.packetRef });
      acceptedPackets = [...acceptedPackets, reduced.packet];
    } else {
      if (!update.reason.trim() || update.reason.length > 1_000) invalid("Research quarantine reason is invalid.");
      nextTask = reduceResearchTaskAttemptV1(task, { kind: "quarantined", at: update.at });
      nextGraph = reduceResearchGraphV1(graph, { kind: "quarantine_node", expectedRevision: graph.revision, nodeId: task.nodeId, stopReason: update.reason.trim() });
    }
    const nextTasks = [...current.tasks];
    nextTasks[taskIndex] = nextTask;
    const acceptedBudgetState = update.kind === "accept_packet"
      ? update.budgetState
      : undefined;
    const nextTurn = {
      ...current,
      graph: nextGraph,
      tasks: nextTasks,
      acceptedPackets,
      ...(acceptedBudgetState === undefined ? {} : {
        budgetState: parseResearchRunBudgetStateV1(acceptedBudgetState),
      }),
    };
    return withNext(session, update, { status: session.status, turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "record_reconciliation") {
    const current = ensureActive(session, ["running"]);
    const graph = requireGraph(current);
    if (current.reconciliationCommittedAt || !Array.isArray(update.dispositions) ||
        update.dispositions.length > 16) {
      invalid("Research reconciliation dispositions are immutable or invalid.");
    }
    const dispositions = update.dispositions.map(parseResearchReconciliationDispositionV1);
    const reconciliationPacketRefs = new Set(dispositions.map((disposition) =>
      disposition.reconciliationPacketRef
    ));
    const defectIds = new Set(dispositions.map((disposition) => disposition.defectId));
    const dispositionIds = new Set(dispositions.map((disposition) => disposition.id));
    if (reconciliationPacketRefs.size > 1 || defectIds.size !== dispositions.length ||
        dispositionIds.size !== dispositions.length ||
        dispositions.some((disposition) =>
          disposition.basedOnGraphRevision !== graph.revision ||
          current.reconciliationDispositions.some((candidate) =>
            candidate.id === disposition.id || candidate.defectId === disposition.defectId
          )
        )) {
      invalid("Research reconciliation dispositions are stale, dangling, or duplicated.");
    }
    const reconciliationPacket = reconciliationPacketRefs.size === 0
      ? current.acceptedPackets.find((packet) =>
          packet.graphRevision === graph.revision && packet.roleId === "reconciler"
        )
      : current.acceptedPackets.find((packet) => packet.packetRef === [...reconciliationPacketRefs][0]);
    if (!reconciliationPacket || reconciliationPacket.graphRevision !== graph.revision ||
        reconciliationPacket.roleId !== "reconciler" ||
        !("schema" in reconciliationPacket.body) ||
        reconciliationPacket.body.schema !== "atlcli.reconciliation-body/v1") {
      invalid("Research reconciliation dispositions require one accepted reconciliation packet.");
    }
    const reconciliationBody = reconciliationPacket.body;
    if (reconciliationBody.defects.length !== dispositions.length ||
        reconciliationBody.defects.some((defect) => !defectIds.has(defect.id))) {
      invalid("Research reconciliation dispositions must cover every accepted defect exactly once.");
    }
    let nextGraph = graph;
    let repairAuthorization: ResearchSessionRepairAuthorizationV1 | undefined;
    if (update.repair) {
      const latentRepairNode = current.latentRepairNode;
      if (!latentRepairNode || current.repairAuthorization ||
          update.repair.nodeId !== latentRepairNode.id ||
          update.repair.reconciliationTaskId !== reconciliationPacket.taskId) {
        invalid("Research reconciliation repair authorization is invalid or already consumed.");
      }
      const authorizingDisposition = dispositions.filter((disposition) =>
        disposition.decision === "add_follow_up" &&
        disposition.resultingGraphRevision === graph.revision &&
        disposition.resultingNodeId === latentRepairNode.id
      );
      const followUp = reconciliationBody.proposedFollowUps.find((candidate) =>
        candidate.id === update.repair!.followUpId
      );
      const authorizingDefect = authorizingDisposition[0]
        ? reconciliationBody.defects.find((defect) =>
            defect.id === authorizingDisposition[0]!.defectId
          )
        : undefined;
      if (authorizingDisposition.length !== 1 || !followUp || !authorizingDefect ||
          !repairFollowUpMatchesDefect(authorizingDefect, followUp)) {
        invalid("Research reconciliation repair must reference one accepted add-follow-up disposition.");
      }
      nextGraph = reduceResearchGraphV1(graph, {
        kind: "activate_repair",
        expectedRevision: graph.revision,
        repairNode: latentRepairNode,
      });
      repairAuthorization = {
        schema: "atlcli.research-session-repair-authorization/v1",
        nodeId: latentRepairNode.id,
        reconciliationTaskId: reconciliationPacket.taskId,
        followUp: clone(followUp),
        authorizedAt: update.at,
      };
    } else if (dispositions.some((disposition) => disposition.resultingNodeId !== undefined ||
        disposition.resultingGraphRevision !== undefined)) {
      invalid("Research reconciliation cannot record a graph mutation without repair authorization.");
    }
    const nextTurn = {
      ...current,
      graph: nextGraph,
      reconciliationDispositions: [...current.reconciliationDispositions, ...dispositions],
      reconciliationCommittedAt: update.at,
      ...(repairAuthorization ? {
        repairAuthorization,
        latentRepairNode: undefined,
      } : {}),
    };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "record_retrieval_assessment") {
    const current = ensureActive(session, ["running", "pause_requested"]);
    const graph = requireGraph(current, update.graphRevision);
    const retrievalAssessments = (current.retrievalAssessments ?? []).map((candidate) =>
      candidate.wave === undefined ? { ...candidate, wave: 1 } : candidate,
    );
    const priorWaveRecords = retrievalAssessments.filter((candidate) =>
      candidate.graphRevision === graph.revision,
    );
    if (priorWaveRecords.some((candidate) => candidate.assessment.action === "stop") ||
        current.tasks.some((task) => task.graphRevision === graph.revision &&
          (task.status === "running" || task.status === "outcome_unknown"))) {
      invalid("Research retrieval assessment follows a terminal decision or has unresolved work.");
    }
    const wave = Math.max(
      graph.researchWavesCompleted,
      ...priorWaveRecords.map((candidate) => candidate.wave!),
    ) + 1;
    const nextGraph = reduceResearchGraphV1(graph, {
      kind: "complete_research_wave",
      expectedRevision: graph.revision,
      wave,
    });
    const assessment = parseResearchRetrievalAssessmentV1(update.assessment);
    const record: ResearchSessionRetrievalAssessmentV1 = {
      schema: RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
      graphRevision: graph.revision,
      wave,
      assessment,
      ...(update.issueContinuation === true ? {
        continuation: {
          schema: RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1,
          id: `research-continuation:${graph.revision}.${wave}`,
          status: "issued" as const,
          issuedAt: update.at,
        },
      } : {}),
      recordedAt: update.at,
    };
    return withNext(session, update, {
      status: session.status,
      turns: replaceTurn(session, {
        ...current,
        graph: nextGraph,
        retrievalAssessments: [...retrievalAssessments, record],
        ...(update.budgetState === undefined ? {} : {
          budgetState: parseResearchRunBudgetStateV1(update.budgetState),
        }),
      }),
    });
  }

  if (update.kind === "consume_retrieval_continuation") {
    const current = ensureActive(session, ["running"]);
    const graph = requireGraph(current, update.graphRevision);
    if (!Number.isSafeInteger(update.wave) || update.wave < 1 ||
        !/^research-continuation:[1-9][0-9]*\.[1-9][0-9]*$/.test(update.continuationId)) {
      invalid("Research retrieval continuation identity is invalid.");
    }
    const retrievalAssessments = (current.retrievalAssessments ?? []).map((candidate) =>
      candidate.wave === undefined ? { ...candidate, wave: 1 } : candidate,
    );
    const index = retrievalAssessments.findIndex((candidate) =>
      candidate.graphRevision === graph.revision && candidate.wave === update.wave,
    );
    const record = retrievalAssessments[index];
    if (!record?.continuation || record.continuation.id !== update.continuationId ||
        record.continuation.status !== "issued") {
      invalid("Research retrieval continuation is unavailable or already consumed.");
    }
    const nextRecord: ResearchSessionRetrievalAssessmentV1 = {
      ...record,
      continuation: {
        ...record.continuation,
        status: "consumed",
        consumedAt: update.at,
      },
    };
    return withNext(session, update, {
      status: "running",
      turns: replaceTurn(session, {
        ...current,
        retrievalAssessments: retrievalAssessments.map((candidate, candidateIndex) =>
          candidateIndex === index ? nextRecord : candidate,
        ),
      }),
    });
  }

  if (update.kind === "record_checkpoint") {
    const current = ensureActive(session, ["planning", "waiting_clarification", "waiting_plan_approval", "waiting_plan_revision", "waiting_scope_approval", "waiting_steering", "pause_requested", "paused", "running", "waiting_authentication", "waiting_quota", "cancelling", "cancelled", "complete", "failed"]);
    const checkpoint = update.checkpoint;
    if (!/^checkpoint:[A-Za-z0-9._-]{1,160}$/.test(checkpoint.id) || checkpoint.turnId !== current.id || checkpoint.recordedAt !== update.at || checkpoint.artifactRefs.length > 16 || new Set(checkpoint.artifactRefs).size !== checkpoint.artifactRefs.length || current.checkpoints.some((candidate) => candidate.id === checkpoint.id)) invalid("Research checkpoint is invalid or duplicated.");
    if (checkpoint.graphRevision !== undefined && checkpoint.graphRevision !== current.graph?.revision) invalid("Research checkpoint graph revision is stale.");
    const record: ResearchSessionCheckpointV1 = { schema: RESEARCH_SESSION_CHECKPOINT_SCHEMA_V1, ...clone(checkpoint), sessionRevision: session.revision + 1 };
    return withNext(session, update, { status: session.status, turns: replaceTurn(session, { ...current, checkpoints: [...current.checkpoints, record] }) });
  }

  if (update.kind === "wait_authentication" || update.kind === "wait_quota") {
    ensureActive(session, ["running"]);
    return withReleasedDurableWait(session, update, {
      status: update.kind === "wait_authentication" ? "waiting_authentication" : "waiting_quota",
    });
  }

  if (update.kind === "release_lease") {
    const current = ensureActive(session, ["running"]);
    if (current.tasks.length > 0 || current.acceptedPackets.length > 0 || current.graphSelectionCommittedAt) {
      invalid("Only an undispatched research turn may release its lease.");
    }
    const expiresAt = new Date(Math.max(
      Date.parse(update.at),
      Date.parse(session.lease.heartbeatAt) + 1,
    )).toISOString();
    return {
      ...withNext(session, update, { status: "running" }),
      lease: { ...session.lease, expiresAt },
    };
  }

  if (update.kind === "heartbeat") {
    if (Date.parse(update.at) < Date.parse(session.lease.heartbeatAt) || Date.parse(update.leaseExpiresAt) <= Date.parse(update.at)) invalid("Research session heartbeat lease is invalid.");
    return {
      ...session,
      revision: session.revision + 1,
      lease: { ...session.lease, heartbeatAt: update.at, expiresAt: update.leaseExpiresAt },
      updatedAt: update.at,
    };
  }

  if (update.kind === "resume") {
    const current = ensureActive(session, ["paused", "waiting_steering", "waiting_authentication", "waiting_quota"]);
    if (session.status === "waiting_steering" &&
        !current.steering.some((steering) => steering.state === "requested")) {
      invalid("Research steering wait has no pending durable control.");
    }
    return withNext(session, update, { status: "running" });
  }

  if (update.kind === "cancel") {
    const current = ensureActive(session, ["planning", "waiting_clarification", "waiting_plan_approval", "waiting_plan_revision", "waiting_scope_approval", "waiting_steering", "pause_requested", "paused", "running", "waiting_authentication", "waiting_quota"]);
    const graph = current.graph;
    const nextTasks = current.tasks.map((task) => task.status === "running" || task.status === "outcome_unknown" ? reduceResearchTaskAttemptV1(task, { kind: "cancelled", at: update.at }) : task);
    let nextGraph: ResearchGraphV1 | undefined = graph;
    if (graph) {
      for (const task of nextTasks.filter((candidate) => candidate.status === "cancelled")) {
        const activeGraph = nextGraph;
        if (!activeGraph) invalid("Research session graph disappeared during cancellation.");
        const node = activeGraph.nodes.find((candidate) => candidate.id === task.nodeId);
        if (node?.status === "running") nextGraph = reduceResearchGraphV1(activeGraph, { kind: "fail_node", expectedRevision: activeGraph.revision, nodeId: task.nodeId, stopReason: "session cancelled" });
      }
    }
    return withNext(session, update, { status: "cancelled", turns: replaceTurn(session, { ...current, tasks: nextTasks, ...(nextGraph ? { graph: nextGraph } : {}), cancelledAt: update.at }) });
  }

  if (update.kind === "complete") {
    const current = ensureActive(session, ["running"]);
    const graph = requireGraph(current);
    const reconciliationSelected = graph.nodes.some((node) => node.roleId === "reconciler");
    if (graph.status !== "complete" || current.tasks.some((task) => task.status === "running" || task.status === "outcome_unknown") || new Set(current.reconciliationDispositions.map((candidate) => candidate.defectId)).size !== current.reconciliationDispositions.length || (reconciliationSelected && !current.reconciliationCommittedAt)) invalid("Research session cannot complete with unresolved work.");
    return withNext(session, update, { status: "complete", activeTurnId: undefined, turns: replaceTurn(session, { ...current, completedAt: update.at }) });
  }

  if (update.kind === "fail") {
    const current = ensureActive(session, ["planning", "waiting_clarification", "waiting_plan_approval", "waiting_plan_revision", "waiting_scope_approval", "waiting_steering", "pause_requested", "paused", "running", "waiting_authentication", "waiting_quota"]);
    if (!update.reason.trim() || update.reason.length > 1_000) invalid("Research session failure reason is invalid.");
    return withNext(session, update, { status: "failed", activeTurnId: undefined, turns: replaceTurn(session, { ...current, failureReason: update.reason.trim() }) });
  }

  if (update.kind === "retain") {
    if (session.status !== "complete" && session.status !== "cancelled" && session.status !== "failed") invalid("Only terminal research sessions can be retained.");
    if (update.retainedUntil) timestamp(update.retainedUntil, "Research session retention expiry");
    return withNext(session, update, { status: session.status, retention: { state: "retained", ...(update.retainedUntil ? { retainedUntil: update.retainedUntil } : {}) } });
  }

  if (update.kind === "request_deletion") {
    if (session.status !== "complete" && session.status !== "cancelled" && session.status !== "failed") invalid("Only terminal research sessions can be deleted.");
    return withNext(session, update, { status: session.status, retention: { state: "deletion_requested" } });
  }

  if (update.kind === "delete") {
    if (session.retention.state !== "deletion_requested") invalid("Research session deletion was not requested.");
    return withNext(session, update, { status: "deleted", activeTurnId: undefined, retention: { state: "deleted" } });
  }

  return unreachable(update);
}

function unreachable(value: never): never {
  throw new Error(`Unsupported research session update: ${JSON.stringify(value)}`);
}
