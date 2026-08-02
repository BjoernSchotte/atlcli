import { ResearchContractError, type ResearchScopeBindingV1 } from "./contracts.js";
import type { ResearchBriefV1 } from "./brief.js";
import {
  acceptResearchGraphProposalV1,
  reduceResearchGraphV1,
  validateResearchGraphV1,
  type ResearchGraphNodeV1,
  type ResearchGraphProposalV1,
  type ResearchGraphV1,
} from "./graph.js";
import type {
  ResearchScopeCandidateV1,
  ResearchScopeExpansionProposalV1,
  ResearchScopeResolutionV1,
} from "./scope-discovery.js";
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
export const RESEARCH_RESUMABLE_SESSION_SCHEMA_V1 =
  "atlcli.research-resumable-session/v1" as const;

export type ResearchSessionStatusV1 =
  | "idle"
  | "planning"
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

export interface ResearchSessionSteeringV1 {
  id: string;
  request: string;
  requestedAt: string;
  acknowledgedAt?: string;
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
  reason: ResearchRetrievalAssessmentReasonV1;
  recordedAt: string;
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
  turnId: string;
  status: Extract<
    ResearchSessionStatusV1,
    "waiting_authentication" | "waiting_quota" | "paused" | "running"
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
      kind: "record_brief";
      brief: ResearchBriefV1;
      scopeCandidates?: ResearchScopeCandidateV1[];
      scopeBindings?: ResearchScopeBindingV1[];
      scopeResolutions?: ResearchScopeResolutionV1[];
    })
  | (ResearchSessionFencedUpdateV1 & { kind: "propose_graph"; graph: ResearchGraphV1 })
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
      reason: ResearchRetrievalAssessmentReasonV1;
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
  | (ResearchSessionFencedUpdateV1 & { kind: "reject_plan"; graphRevision: number; reason: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "propose_scope_expansion"; proposal: ResearchScopeExpansionProposalV1 })
  | (ResearchSessionFencedUpdateV1 & { kind: "approve_scope_expansion"; proposalId: string; binding: ResearchScopeBindingV1 })
  | (ResearchSessionFencedUpdateV1 & { kind: "reject_scope_expansion"; proposalId: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "request_steering"; steeringId: string; request: string })
  | (ResearchSessionFencedUpdateV1 & { kind: "acknowledge_steering"; steeringId: string })
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

function requireGraph(current: ResearchSessionTurnV1, graphRevision?: number): ResearchGraphV1 {
  if (!current.graph) invalid("Research session turn does not have a graph.");
  if (graphRevision !== undefined && current.graph.revision !== graphRevision) invalid("Research graph revision is stale.");
  return current.graph;
}

function hasUnansweredBriefRequirements(current: ResearchSessionTurnV1): boolean {
  const brief = current.brief;
  if (!brief) return true;
  const unansweredQuestion = brief.clarificationQuestions.some(
    (question) => question.required && !current.clarifications.some((answer) => answer.questionId === question.id),
  );
  const undecidedAssumption = brief.assumptions.some(
    (assumption) => assumption.requiresUserDecision &&
      !current.assumptionDecisions.some((decision) => decision.assumptionId === assumption.id),
  );
  return unansweredQuestion || undecidedAssumption;
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
  for (const candidate of session.turns) {
    if (candidate.budgetState !== undefined) parseResearchRunBudgetStateV1(candidate.budgetState);
    if (candidate.graphRevisions !== undefined) {
      if (!Array.isArray(candidate.graphRevisions) || candidate.graphRevisions.length > 16) {
        invalid("Research session graph revisions are invalid.");
      }
      let previousRevision = 0;
      for (const revision of candidate.graphRevisions) {
        if (revision.schema !== RESEARCH_SESSION_GRAPH_REVISION_SCHEMA_V1 ||
            revision.graph.sessionId !== session.sessionId || revision.graph.turnId !== candidate.id ||
            revision.graph.revision <= previousRevision ||
            !RESEARCH_RETRIEVAL_ASSESSMENT_REASONS_V1.includes(revision.reason)) {
          invalid("Research session graph revision is invalid.");
        }
        validateResearchGraphV1(revision.graph);
        validateBodyFreeReferenceIds(revision.evidenceIds, "Research session graph revision evidence IDs");
        validateBodyFreeReferenceIds(revision.gapIds, "Research session graph revision gap IDs");
        timestamp(revision.recordedAt, "Research session graph revision timestamp");
        previousRevision = revision.graph.revision;
      }
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

  if (update.kind === "create_turn") {
    if (session.status !== "idle" && session.status !== "complete" && session.status !== "cancelled" && session.status !== "failed") invalid("Research session cannot create a turn while active.");
    if (!/^research-turn:[A-Za-z0-9._-]{1,120}$/.test(update.turnId) || session.turns.some((candidate) => candidate.id === update.turnId)) invalid("Research session turn ID is invalid or duplicated.");
    const nextTurn: ResearchSessionTurnV1 = {
      id: update.turnId,
      revision: 1,
      createdAt: update.at,
      scopeCandidates: [], scopeBindings: [], scopeResolutions: [], scopeExpansionProposals: [], clarifications: [], assumptionDecisions: [], steering: [], tasks: [], acceptedPackets: [], reconciliationDispositions: [], retrievalAssessments: [], checkpoints: [],
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
    return withNext(session, update, { status: nextStatus, turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "record_clarification") {
    const current = ensureActive(session, ["waiting_clarification"]);
    if (!current.brief || current.brief.revision !== update.briefRevision || !/^clarification:[A-Za-z0-9._-]{1,120}$/.test(update.questionId) || !update.response.trim() || update.response.length > 2_000) invalid("Research clarification does not match the active brief.");
    const question = current.brief.clarificationQuestions.find((candidate) => candidate.id === update.questionId);
    if (!question || current.clarifications.some((candidate) => candidate.questionId === update.questionId)) invalid("Research clarification question is unknown or already answered.");
    if ((update.assumptionId === undefined) !== (update.assumptionDecision === undefined)) invalid("Research assumption decisions must include both ID and decision.");
    if (update.assumptionId && !current.brief.assumptions.some((assumption) => assumption.id === update.assumptionId && assumption.requiresUserDecision)) invalid("Research clarification assumption is unknown.");
    const nextTurn = { ...current, clarifications: [...current.clarifications, { briefRevision: update.briefRevision, questionId: update.questionId, response: update.response.trim(), ...(update.assumptionId ? { assumptionId: update.assumptionId, assumptionDecision: update.assumptionDecision } : {}), answeredAt: update.at }] };
    return withNext(session, update, { status: hasUnansweredBriefRequirements(nextTurn) ? "waiting_clarification" : "planning", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "record_assumption_decision") {
    const current = ensureActive(session, ["waiting_clarification"]);
    if (!current.brief || current.brief.revision !== update.briefRevision || !/^assumption:[A-Za-z0-9._-]{1,120}$/.test(update.assumptionId)) invalid("Research assumption decision does not match the active brief.");
    const assumption = current.brief.assumptions.find((candidate) => candidate.id === update.assumptionId);
    if (!assumption?.requiresUserDecision || current.assumptionDecisions.some((candidate) => candidate.assumptionId === update.assumptionId)) invalid("Research assumption is unknown or already decided.");
    const nextTurn = { ...current, assumptionDecisions: [...current.assumptionDecisions, { briefRevision: update.briefRevision, assumptionId: update.assumptionId, decision: update.decision, decidedAt: update.at }] };
    return withNext(session, update, { status: hasUnansweredBriefRequirements(nextTurn) ? "waiting_clarification" : "planning", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "propose_graph" || update.kind === "revise_graph") {
    const current = ensureActive(session, update.kind === "propose_graph" ? ["planning"] : ["waiting_plan_revision", "planning"]);
    validateResearchGraphV1(update.graph);
    if (!current.brief || update.graph.sessionId !== session.sessionId || update.graph.turnId !== current.id || update.graph.basedOnBriefRevision !== current.brief.revision || update.graph.status !== "proposed") invalid("Research graph proposal does not match the active brief.");
    if (update.kind === "propose_graph" && current.graph) invalid("Research graph proposal already exists.");
    if (update.kind === "revise_graph" && (!current.graph || update.graph.revision <= current.graph.revision)) invalid("Research graph revision is invalid.");
    const nextTurn = { ...current, graph: clone(update.graph), revision: current.revision + 1 };
    return withNext(session, update, { status: "waiting_plan_approval", turns: replaceTurn(session, nextTurn) });
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
        !RESEARCH_RETRIEVAL_ASSESSMENT_REASONS_V1.includes(update.reason)) {
      invalid("Research graph revision does not match the active durable graph.");
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
      recordedAt: update.at,
    };
    return withNext(session, update, {
      status: "running",
      turns: replaceTurn(session, {
        ...current,
        revision: current.revision + 1,
        graph: clone(update.graph),
        graphRevisions: [...history, record],
      }),
    });
  }

  if (update.kind === "approve_graph") {
    const current = ensureActive(session, ["waiting_plan_approval"]);
    const graph = requireGraph(current, update.graphRevision);
    const nextTurn = { ...current, graph: reduceResearchGraphV1(graph, { kind: "approve", expectedRevision: graph.revision, approvedAt: update.at }) };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "commit_graph_selection") {
    const current = ensureActive(session, ["running"]);
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
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "reject_plan") {
    const current = ensureActive(session, ["waiting_plan_approval"]);
    requireGraph(current, update.graphRevision);
    if (!update.reason.trim() || update.reason.length > 1_000) invalid("Research plan rejection reason is invalid.");
    return withNext(session, update, { status: "waiting_plan_revision" });
  }

  if (update.kind === "propose_scope_expansion") {
    const current = ensureActive(session, ["running", "waiting_steering"]);
    const graph = requireGraph(current);
    if (update.proposal.sessionId !== session.sessionId || update.proposal.turnId !== current.id || update.proposal.basedOnBriefRevision !== current.brief?.revision || update.proposal.basedOnGraphRevision !== graph.revision || update.proposal.status !== "proposed" || current.scopeExpansionProposals.some((proposal) => proposal.id === update.proposal.id)) invalid("Research scope expansion proposal is invalid or stale.");
    const nextTurn = { ...current, scopeExpansionProposals: [...current.scopeExpansionProposals, clone(update.proposal)] };
    return withNext(session, update, { status: "waiting_scope_approval", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "approve_scope_expansion" || update.kind === "reject_scope_expansion") {
    const current = ensureActive(session, ["waiting_scope_approval"]);
    const proposal = current.scopeExpansionProposals.find((candidate) => candidate.id === update.proposalId);
    if (!proposal || proposal.status !== "proposed") invalid("Research scope expansion proposal is unknown or already resolved.");
    const approved = update.kind === "approve_scope_expansion";
    if (approved && (!update.binding || !/^scope-binding:[A-Za-z0-9:._%-]{1,180}$/.test(update.binding.id))) invalid("Research scope expansion binding is invalid.");
    const nextProposal: ResearchScopeExpansionProposalV1 = approved
      ? { ...proposal, status: "approved", approvedBindingId: update.binding.id }
      : { ...proposal, status: "rejected" };
    const nextTurn = {
      ...current,
      scopeExpansionProposals: current.scopeExpansionProposals.map((candidate) => candidate.id === proposal.id ? nextProposal : candidate),
      ...(approved ? { scopeBindings: [...current.scopeBindings, clone(update.binding)] } : {}),
    };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "request_steering") {
    const current = ensureActive(session, ["running"]);
    if (!/^steering:[A-Za-z0-9._-]{1,120}$/.test(update.steeringId) || !update.request.trim() || update.request.length > 2_000 || current.steering.some((steering) => steering.id === update.steeringId)) invalid("Research steering request is invalid or duplicated.");
    const nextTurn = { ...current, steering: [...current.steering, { id: update.steeringId, request: update.request.trim(), requestedAt: update.at }] };
    return withNext(session, update, { status: "waiting_steering", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "acknowledge_steering") {
    const current = ensureActive(session, ["waiting_steering"]);
    const steering = current.steering.find((candidate) => candidate.id === update.steeringId && !candidate.acknowledgedAt);
    if (!steering) invalid("Research steering request is unknown or already acknowledged.");
    const nextTurn = { ...current, steering: current.steering.map((candidate) => candidate.id === steering.id ? { ...candidate, acknowledgedAt: update.at } : candidate) };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "request_pause") {
    const current = ensureActive(session, ["running", "waiting_steering", "waiting_scope_approval", "waiting_authentication", "waiting_quota"]);
    return withNext(session, update, { status: "pause_requested", turns: replaceTurn(session, { ...current, pauseRequestedAt: update.at }) });
  }

  if (update.kind === "acknowledge_pause") {
    const current = ensureActive(session, ["pause_requested"]);
    return withNext(session, update, { status: "paused", turns: replaceTurn(session, { ...current, pausedAt: update.at }) });
  }

  if (update.kind === "admit_tasks") {
    const current = ensureActive(session, ["running"]);
    const graph = requireGraph(current, update.graphRevision);
    if (!Array.isArray(update.tasks) || update.tasks.length === 0 || update.tasks.length > 16) invalid("Research task admission is invalid.");
    const nodeIds = new Set(graph.nodes.filter((node) => node.status === "ready").map((node) => node.id));
    const ids = new Set(current.tasks.map((task) => task.taskId));
    for (const task of update.tasks) {
      if (task.graphRevision !== graph.revision || task.status !== "ready" || task.dispatchState !== "not_started" || !nodeIds.has(task.nodeId) || ids.has(task.taskId)) invalid("Research task admission does not match a ready graph node.");
      ids.add(task.taskId);
    }
    const nextTurn = { ...current, tasks: [...current.tasks, ...clone(update.tasks)] };
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
  }

  if (update.kind === "dispatch_started" || update.kind === "outcome_unknown" || update.kind === "accept_packet" || update.kind === "quarantine_packet") {
    const current = ensureActive(session, ["running"]);
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
    return withNext(session, update, { status: "running", turns: replaceTurn(session, nextTurn) });
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
    const current = ensureActive(session, ["running"]);
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
      status: "running",
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
    // A durable wait has no living owner. Release the current lease at this
    // checkpoint so a fresh CLI process, extension worker, or browser restart
    // can recover it immediately with a new epoch instead of waiting for the
    // former execution deadline to elapse.
    const releasedAt = Math.max(
      Date.parse(update.at),
      Date.parse(session.lease.heartbeatAt) + 1,
    );
    return {
      ...withNext(session, update, {
        status: update.kind === "wait_authentication" ? "waiting_authentication" : "waiting_quota",
      }),
      lease: {
        ...session.lease,
        expiresAt: new Date(releasedAt).toISOString(),
      },
    };
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
    ensureActive(session, ["paused", "waiting_authentication", "waiting_quota"]);
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
