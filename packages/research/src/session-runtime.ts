import {
  approveResearchBriefWholeScopeExpansionV1,
  briefRequiresClarificationV1,
  prepareResearchBriefPreflightV1,
  type ResearchBriefAssumptionDecisionV1,
  type ResearchBriefClarificationResponseV1,
  type ResearchBriefV1,
} from "./brief.js";
import {
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  type ResearchOneShotPolicyV1,
  type ResearchRequestV1,
  type ResearchScopeBindingV1,
} from "./contracts.js";
import {
  createStandardResearchBriefV1,
  composeResearchGraphV1,
  stageResearchGraphForDurableSessionV1,
  type ResearchGraphCompositionOptionsV1,
  type ResearchGraphV1,
} from "./graph.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
} from "./workflow-contracts.js";
import type { ResearchSessionStoreV1 } from "./session-store.js";
import {
  RESEARCH_RESUMABLE_SESSION_SCHEMA_V1,
  type ResearchSessionScopeClarificationV1,
  type ResearchResumableSessionV1,
  type ResearchSessionTurnV1,
  type ResearchSessionV1,
} from "./session.js";
import type {
  ResearchScopeCandidateSelectionV1,
  ResearchScopeClarificationRequiredV1,
} from "./scope-resolution.js";
import type { ResearchScopeCandidateV1 } from "./scope-discovery.js";

export interface InitializeResearchSessionTurnInputV1 {
  store: ResearchSessionStoreV1;
  session: ResearchSessionV1;
  brief: ResearchBriefV1;
  graph: ResearchGraphV1;
  /** Host policy: an explicit automatic plan gets a separately journaled host approval. */
  approveAutomatically: boolean;
  at: string;
}

export interface InitializeResearchSessionClarificationWaitInputV1 {
  store: ResearchSessionStoreV1;
  session: ResearchSessionV1;
  /** The exact host-owned brief that contains the required questions/decisions. */
  brief: ResearchBriefV1;
  at: string;
}

export interface AppendResearchSessionTurnInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  brief: ResearchBriefV1;
  graph: ResearchGraphV1;
  /** Host policy: an explicit automatic plan gets a separately journaled host approval. */
  approveAutomatically: boolean;
  at: string;
}

export interface RecoverResearchSessionForResumeInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  ownerId: string;
  leaseExpiresAt: string;
  at: string;
}

/**
 * Conservative lost-run recovery for hosts whose worker/process may disappear
 * between durable journal writes. It deliberately never retries a provider
 * request: only an undispatched approved plan or a fully-settled retrieval
 * checkpoint with one unconsumed continuation can be released.
 */
export interface RecoverExpiredResearchSessionsAtSafeBoundaryInputV1 {
  store: ResearchSessionStoreV1;
  /** A short-lived host owner used only to fence the atomic recovery writes. */
  ownerId: string;
  /** Duration of that temporary recovery lease. Must be positive. */
  leaseDurationMs: number;
  /** One host-observed instant for the complete sweep. */
  at: string;
}

export interface ProposeResearchGraphForReadyBriefInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  packetOutputSchema?: ResearchGraphCompositionOptionsV1["packetOutputSchema"];
  approveAutomatically: boolean;
  /** A control command has no live runner, so its approved plan must be reclaimable. */
  releaseApprovedLease?: boolean;
  at: string;
}

export interface ResolveResearchSessionClarificationsInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  briefRevision: number;
  answers: Array<Pick<ResearchBriefClarificationResponseV1, "questionId" | "response">>;
  assumptionDecisions: ResearchBriefAssumptionDecisionV1[];
  approveAutomatically: boolean;
  /** A browser control command must leave its approved successor resumable. */
  releaseApprovedLease?: boolean;
  at: string;
}

export interface ContinueResearchSessionClarificationPlanningInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  briefRevision: number;
  approveAutomatically: boolean;
  releaseApprovedLease?: boolean;
  at: string;
}

export interface InitializeResearchSessionScopeClarificationWaitInputV1 {
  store: ResearchSessionStoreV1;
  session: ResearchSessionV1;
  request: ResearchRequestV1;
  policy: ResearchOneShotPolicyV1;
  clarification: ResearchScopeClarificationRequiredV1;
  candidateChoices: ResearchScopeCandidateV1[];
  at: string;
}

export interface RefreshResearchSessionScopeClarificationInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  clarification: ResearchScopeClarificationRequiredV1;
  candidateChoices: ResearchScopeCandidateV1[];
  at: string;
}

export interface ResolveResearchSessionScopeClarificationInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  selection: ResearchScopeCandidateSelectionV1;
  resolvedRequest: ResearchRequestV1;
  packetOutputSchema?: ResearchGraphCompositionOptionsV1["packetOutputSchema"];
  releaseApprovedLease?: boolean;
  at: string;
}

export interface ContinueResearchSessionScopeClarificationInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  packetOutputSchema?: ResearchGraphCompositionOptionsV1["packetOutputSchema"];
  releaseApprovedLease?: boolean;
  at: string;
}

/**
 * The host-side atomic boundary for a user-approved discovered scope. A whole
 * project or space always supplies the replacement graph in the same durable
 * event as the approval; an exact page or issue deliberately does not widen
 * the brief or replace its graph.
 */
export interface ApproveResearchScopeExpansionInputV1 {
  store: ResearchSessionStoreV1;
  sessionId: string;
  proposalId: string;
  binding: ResearchScopeBindingV1;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  at: string;
}

function activeTurn(session: ResearchSessionV1): ResearchSessionTurnV1 | undefined {
  return session.activeTurnId
    ? session.turns.find((turn) => turn.id === session.activeTurnId)
    : undefined;
}

function isUndispatchedApprovedTurn(turn: ResearchSessionTurnV1): boolean {
  return turn.tasks.length === 0 &&
    turn.acceptedPackets.length === 0 &&
    turn.graphSelectionCommittedAt === undefined &&
    turn.graph?.approvalEnvelope.status === "approved" &&
    turn.graph.status === "approved";
}

function isSettledIssuedRetrievalCheckpoint(turn: ResearchSessionTurnV1): boolean {
  if (!turn.graph || turn.graph.approvalEnvelope.status !== "approved" ||
      turn.graph.status !== "running" || turn.tasks.length === 0 ||
      turn.acceptedPackets.length === 0 || !turn.budgetState) {
    return false;
  }
  if (turn.tasks.some((task) =>
    task.status === "ready" || task.status === "running" || task.status === "outcome_unknown",
  )) {
    return false;
  }
  const assessments = turn.retrievalAssessments ?? [];
  const issued = assessments.filter((assessment) =>
    assessment.graphRevision === turn.graph!.revision &&
    assessment.continuation?.status === "issued",
  );
  return issued.length === 1 && !assessments.some((assessment) =>
    assessment.continuation?.status === "consumed" || assessment.assessment.action === "stop",
  );
}

/**
 * The continuation itself was consumed, but no subsequent task was admitted
 * and no packet was accepted. Retrying its disposable supervisor evaluation is
 * therefore safe: every provider/subagent execution has an earlier durable
 * task-admission boundary. Legacy continuations lack the captured counts and
 * intentionally do not qualify.
 */
export function isRecoverableConsumedRetrievalContinuationV1(
  turn: ResearchSessionTurnV1,
): boolean {
  const graph = turn.graph;
  if (!graph || graph.approvalEnvelope.status !== "approved" ||
      graph.status !== "running" || turn.tasks.length === 0 ||
      turn.acceptedPackets.length === 0 || !turn.budgetState ||
      turn.tasks.some((task) =>
        task.status === "ready" || task.status === "running" || task.status === "outcome_unknown"
      )) {
    return false;
  }
  const consumed = (turn.retrievalAssessments ?? []).filter((assessment) =>
    assessment.graphRevision === graph.revision &&
    assessment.continuation?.status === "consumed" &&
    assessment.continuation.consumedTaskCount === turn.tasks.length &&
    assessment.continuation.consumedPacketCount === turn.acceptedPackets.length,
  );
  return consumed.length === 1 && !(turn.retrievalAssessments ?? []).some((assessment) =>
    assessment.assessment.action === "stop",
  );
}

function isResumableStatus(
  status: ResearchSessionV1["status"],
): status is ResearchResumableSessionV1["status"] {
  return [
    "waiting_authentication",
    "waiting_quota",
    "waiting_steering",
    "paused",
    "running",
  ].includes(status);
}

/**
 * Projects the only durable states this initial recovery policy can resume.
 * The same projection gates the browser's list and its resume endpoint, so a
 * sidebar never advertises a session the host would reject or a foreign tenant
 * session to the active tab.
 */
export function projectResearchResumableSessionV1(
  session: ResearchSessionV1,
  input: { tenantOrigin: string; at: string },
): ResearchResumableSessionV1 | undefined {
  if (!Number.isFinite(Date.parse(input.at))) return undefined;
  const turn = activeTurn(session);
  if (!turn?.brief || !turn.graph || turn.brief.scope.siteOrigin !== input.tenantOrigin) {
    return undefined;
  }
  if (!isResumableStatus(session.status) ||
      Date.parse(input.at) < Date.parse(session.lease.expiresAt)) {
    return undefined;
  }
  const issuedContinuations = turn.retrievalAssessments?.filter((assessment) =>
    assessment.graphRevision === turn.graph!.revision &&
    assessment.continuation?.status === "issued",
  ) ?? [];
  const undispatched = turn.tasks.length === 0 &&
    turn.acceptedPackets.length === 0 &&
    turn.graphSelectionCommittedAt === undefined;
  const checkpointResumable = issuedContinuations.length === 1 &&
    turn.tasks.length > 0 &&
    turn.acceptedPackets.length > 0 &&
    turn.budgetState !== undefined;
  const consumedContinuationRecoverable = isRecoverableConsumedRetrievalContinuationV1(turn);
  if (!undispatched && !checkpointResumable && !consumedContinuationRecoverable) return undefined;
  if (turn.graph.approvalEnvelope.status !== "approved" ||
      (undispatched ? turn.graph.status !== "approved" : turn.graph.status !== "running")) {
    return undefined;
  }
  return {
    schema: RESEARCH_RESUMABLE_SESSION_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    turnId: turn.id,
    status: session.status,
    updatedAt: session.updatedAt,
    question: turn.brief.objective,
    scope: {
      jiraProjectKeys: [...turn.brief.scope.jiraProjectKeys],
      confluenceSpaceKeys: [...turn.brief.scope.confluenceSpaceKeys],
    },
  };
}

/**
 * Persist a brief that requires user input before graph composition.  This is
 * deliberately separate from the execution gate: no graph, workspace,
 * provider, or model can be created until a later revision has resolved the
 * recorded questions and decisions.
 */
export async function initializeResearchSessionClarificationWaitV1(
  input: InitializeResearchSessionClarificationWaitInputV1,
): Promise<ResearchSessionV1> {
  if (input.brief.sessionId !== input.session.sessionId || !briefRequiresClarificationV1(input.brief)) {
    throw new Error("Durable research clarification wait does not match a required brief.");
  }
  await input.store.create(input.session);
  let current = await input.store.read(input.session.sessionId);
  if (!current) throw new Error("Research clarification session was not created.");
  current = (await input.store.commit(current.sessionId, {
    kind: "create_turn",
    turnId: input.brief.turnId,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  const persisted = (await input.store.commit(current.sessionId, {
    kind: "record_brief",
    brief: input.brief,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  if (persisted.status !== "waiting_clarification") {
    throw new Error("Durable research clarification wait did not persist its required state.");
  }
  return persisted;
}

/**
 * Commit all user answers and decisions before graph construction. If the
 * second operation is interrupted, the resulting ready `planning` state is a
 * durable recovery checkpoint that `continueResearchSessionClarificationPlanningV1`
 * can finish under a new explicit revision fence.
 */
export async function resolveResearchSessionClarificationsV1(
  input: ResolveResearchSessionClarificationsInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch) {
    throw new Error("Research clarification session revision or lease epoch is stale.");
  }
  const turn = activeTurn(current);
  if (current.status !== "waiting_clarification" || !turn?.brief ||
      turn.brief.revision !== input.briefRevision || !briefRequiresClarificationV1(turn.brief)) {
    throw new Error("Research clarification session is not awaiting these answers.");
  }
  const resolved = (await input.store.commit(input.sessionId, {
    kind: "resolve_clarifications",
    briefRevision: input.briefRevision,
    answers: input.answers,
    assumptionDecisions: input.assumptionDecisions,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  return proposeResearchGraphForReadyBriefV1({
    store: input.store,
    sessionId: resolved.sessionId,
    expectedRevision: resolved.revision,
    expectedLeaseEpoch: resolved.lease.epoch,
    approveAutomatically: input.approveAutomatically,
    ...(input.releaseApprovedLease ? { releaseApprovedLease: true } : {}),
    at: input.at,
  });
}

/**
 * Finish the durable post-answer planning checkpoint without accepting a new
 * answer, scope, policy, or graph from the caller.
 */
export async function continueResearchSessionClarificationPlanningV1(
  input: ContinueResearchSessionClarificationPlanningInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch) {
    throw new Error("Research clarification planning revision or lease epoch is stale.");
  }
  const turn = activeTurn(current);
  if (current.status !== "planning" || !turn?.brief || turn.graph ||
      turn.brief.revision !== input.briefRevision || briefRequiresClarificationV1(turn.brief) ||
      (turn.clarifications.length === 0 && turn.assumptionDecisions.length === 0)) {
    throw new Error("Research clarification planning checkpoint is not recoverable.");
  }
  return proposeResearchGraphForReadyBriefV1({
    store: input.store,
    sessionId: current.sessionId,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    approveAutomatically: input.approveAutomatically,
    ...(input.releaseApprovedLease ? { releaseApprovedLease: true } : {}),
    at: input.at,
  });
}

/**
 * Persist an ambiguous natural-language scope before a research brief, graph,
 * workspace, provider, credential lookup, or model is constructed.
 */
export async function initializeResearchSessionScopeClarificationWaitV1(
  input: InitializeResearchSessionScopeClarificationWaitInputV1,
): Promise<ResearchSessionV1> {
  const request = normalizeResearchRequestV1(input.request);
  const policy = normalizeResearchOneShotPolicyV1(input.policy);
  if (input.session.status !== "idle" || input.session.activeTurnId ||
      input.session.scopeClarification !== undefined) {
    throw new Error("New research session must not already contain scope clarification state.");
  }
  await input.store.create(input.session);
  const current = await input.store.read(input.session.sessionId);
  if (!current) throw new Error("Research scope clarification session was not created.");
  const persisted = (await input.store.commit(current.sessionId, {
    kind: "record_scope_clarification",
    request,
    policy,
    clarification: input.clarification,
    candidateChoices: input.candidateChoices,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  if (persisted.status !== "waiting_scope_clarification" ||
      persisted.scopeClarification?.state !== "waiting_choice") {
    throw new Error("Durable research scope clarification wait did not persist its required state.");
  }
  return persisted;
}

/** Refresh only host-fetched catalog candidates at the existing choice fence. */
export async function refreshResearchSessionScopeClarificationV1(
  input: RefreshResearchSessionScopeClarificationInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch ||
      current.status !== "waiting_scope_clarification" ||
      current.scopeClarification?.state !== "waiting_choice") {
    throw new Error("Research scope clarification revision or lease epoch is stale.");
  }
  return (await input.store.commit(input.sessionId, {
    kind: "refresh_scope_clarification",
    clarification: input.clarification,
    candidateChoices: input.candidateChoices,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
}

/**
 * Commit a selection that the host has freshly validated through its catalog,
 * then advance only from the persisted request/policy and exact resolution.
 */
export async function resolveResearchSessionScopeClarificationV1(
  input: ResolveResearchSessionScopeClarificationInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch ||
      current.status !== "waiting_scope_clarification" ||
      current.scopeClarification?.state !== "waiting_choice") {
    throw new Error("Research scope clarification revision or lease epoch is stale.");
  }
  const resolved = (await input.store.commit(input.sessionId, {
    kind: "resolve_scope_clarification",
    selection: input.selection,
    resolvedRequest: normalizeResearchRequestV1(input.resolvedRequest),
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  return continueResearchSessionScopeClarificationV1({
    store: input.store,
    sessionId: resolved.sessionId,
    expectedRevision: resolved.revision,
    expectedLeaseEpoch: resolved.lease.epoch,
    ...(input.packetOutputSchema ? { packetOutputSchema: input.packetOutputSchema } : {}),
    ...(input.releaseApprovedLease ? { releaseApprovedLease: true } : {}),
    at: input.at,
  });
}

/**
 * Finish a persisted post-choice checkpoint without accepting a new request,
 * scope, policy, candidate, brief, or graph from the caller.
 */
export async function continueResearchSessionScopeClarificationV1(
  input: ContinueResearchSessionScopeClarificationInputV1,
): Promise<ResearchSessionV1> {
  let current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch ||
      current.scopeClarification?.state !== "choice_resolved") {
    throw new Error("Research scope clarification continuation is stale.");
  }
  let active = activeTurn(current);
  if (!active) {
    if (current.status !== "idle" || !current.scopeClarification.resolvedRequest) {
      throw new Error("Research scope clarification has no recoverable brief checkpoint.");
    }
    const request = normalizeResearchRequestV1(current.scopeClarification.resolvedRequest);
    const turnId = `research-turn:${current.sessionId.slice("research-session:".length)}`;
    const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(
      request.question,
      {
        sessionId: current.sessionId,
        turnId,
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf: input.at,
        policy: current.scopeClarification.policy,
      },
    ));
    current = (await input.store.commit(current.sessionId, {
      kind: "initialize_scope_brief",
      brief: briefOutcome.brief,
      expectedRevision: current.revision,
      expectedLeaseEpoch: current.lease.epoch,
      at: input.at,
    })).session;
    active = activeTurn(current);
  }
  if (current.status === "waiting_clarification") return current;
  if (current.status !== "planning" || !active?.brief || active.graph ||
      briefRequiresClarificationV1(active.brief)) {
    throw new Error("Research scope clarification has no recoverable plan checkpoint.");
  }
  return proposeResearchGraphForReadyBriefV1({
    store: input.store,
    sessionId: current.sessionId,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    ...(input.packetOutputSchema ? { packetOutputSchema: input.packetOutputSchema } : {}),
    approveAutomatically: active.brief.resolvedPlanApproval === "automatic",
    ...(input.releaseApprovedLease ? { releaseApprovedLease: true } : {}),
    at: input.at,
  });
}

/**
 * Compose and persist a graph only from an already committed, clarification-
 * free brief. A crash between the preceding brief commit and this call leaves
 * a durable `planning` state that a later control command can safely advance.
 * When a rejected plan has materialized a newer brief, it emits the next graph
 * revision and deliberately returns to an explicit approval boundary.
 */
export async function proposeResearchGraphForReadyBriefV1(
  input: ProposeResearchGraphForReadyBriefInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current) throw new Error("Research session was not found.");
  if (current.revision !== input.expectedRevision || current.lease.epoch !== input.expectedLeaseEpoch) {
    throw new Error("Research session revision or lease epoch is stale.");
  }
  const active = activeTurn(current);
  if (current.status !== "planning" || !active?.brief || briefRequiresClarificationV1(active.brief)) {
    throw new Error("Research session does not have a ready brief to plan.");
  }
  const graphRevision = active.graph ? active.graph.revision + 1 : 1;
  if (active.graph) {
    const planRevisionRequested = (active.planRevisions ?? []).some((revision) =>
      revision.state === "revision_requested" &&
      revision.basedOnGraphRevision === active.graph!.revision &&
      revision.revisedBriefRevision === active.brief!.revision,
    );
    if (!planRevisionRequested) {
      throw new Error("Research session does not have a durable plan revision request.");
    }
  }
  const graph = composeResearchGraphV1(active.brief, {
    ...(input.packetOutputSchema ? { packetOutputSchema: input.packetOutputSchema } : {}),
    graphRevision,
  });
  const staged = stageResearchGraphForDurableSessionV1(graph);
  let proposed = (await input.store.commit(input.sessionId, {
    kind: active.graph ? "revise_graph" : "propose_graph",
    graph: staged,
    ...(!active.graph && input.approveAutomatically ? { retainLeaseForImmediateApproval: true as const } : {}),
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  // A user rejected the predecessor; even an otherwise automatic policy must
  // not auto-approve the replacement plan.
  if (!input.approveAutomatically || active.graph) return proposed;
  proposed = (await input.store.commit(input.sessionId, {
    kind: "approve_graph",
    graphRevision: staged.revision,
    expectedRevision: proposed.revision,
    expectedLeaseEpoch: proposed.lease.epoch,
    at: input.at,
  })).session;
  if (!input.releaseApprovedLease) return proposed;
  return (await input.store.commit(input.sessionId, {
    kind: "release_lease",
    expectedRevision: proposed.revision,
    expectedLeaseEpoch: proposed.lease.epoch,
    at: input.at,
  })).session;
}

/**
 * Materialize an approved discovery without leaving an execution-visible
 * state between a widened scope and its replacement plan. The reducer repeats
 * every check, including the candidate/binding identity, before it commits.
 */
export async function approveResearchScopeExpansionV1(
  input: ApproveResearchScopeExpansionInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current) throw new Error("Research session was not found.");
  if (current.revision !== input.expectedRevision || current.lease.epoch !== input.expectedLeaseEpoch) {
    throw new Error("Research session revision or lease epoch is stale.");
  }
  const active = activeTurn(current);
  const graph = active?.graph;
  const brief = active?.brief;
  const proposal = active?.scopeExpansionProposals.find((candidate) => candidate.id === input.proposalId);
  if (current.status !== "waiting_scope_approval" || !active || !graph || !brief || !proposal || proposal.status !== "proposed") {
    throw new Error("Research scope expansion is not awaiting an approval.");
  }
  const replacementGraph = proposal.expansionKind === "whole_scope"
    ? stageResearchGraphForDurableSessionV1(composeResearchGraphV1(
        approveResearchBriefWholeScopeExpansionV1({
          brief,
          binding: input.binding,
          existingBindings: active.scopeBindings,
        }),
        {
          graphRevision: graph.revision + 1,
          ...(graph.nodes.some((node) =>
            node.outputSchema === RESEARCH_PACKET_BODY_SCHEMA_V2 ||
            node.outputSchema === RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
          ) ? { packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2 } : {}),
        },
      ))
    : undefined;
  return (await input.store.commit(input.sessionId, {
    kind: "approve_scope_expansion",
    proposalId: input.proposalId,
    binding: input.binding,
    ...(replacementGraph ? { replacementGraph } : {}),
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
}

/**
 * The durable execution gate. It stores the turn, brief, and exact proposed
 * graph before any host may construct a workspace, provider, model, or agent.
 */
export async function initializeResearchSessionTurnV1(
  input: InitializeResearchSessionTurnInputV1,
): Promise<ResearchSessionV1> {
  await input.store.create(input.session);
  return appendResearchSessionTurnV1({
    store: input.store,
    sessionId: input.session.sessionId,
    brief: input.brief,
    graph: input.graph,
    approveAutomatically: input.approveAutomatically,
    at: input.at,
  });
}

/**
 * Append a fully durable turn to an existing session. The reducer continues to
 * enforce lifecycle state; this helper centralizes the required persistence
 * sequence before a host constructs a workspace, provider, or agent.
 */
export async function appendResearchSessionTurnV1(
  input: AppendResearchSessionTurnInputV1,
): Promise<ResearchSessionV1> {
  if (input.brief.sessionId !== input.sessionId || input.brief.turnId === "" || input.graph.sessionId !== input.sessionId || input.graph.turnId !== input.brief.turnId) {
    throw new Error("Durable research brief or graph does not match the existing session.");
  }
  let current = await input.store.read(input.sessionId);
  if (!current) throw new Error("Research session was not found.");
  if (current.retention.state === "deletion_requested" || current.retention.state === "deleted") {
    throw new Error("Research session is pending deletion and cannot accept a new turn.");
  }
  current = (await input.store.commit(current.sessionId, {
    kind: "create_turn",
    turnId: input.brief.turnId,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  current = (await input.store.commit(current.sessionId, {
    kind: "record_brief",
    brief: input.brief,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  const staged = stageResearchGraphForDurableSessionV1(input.graph);
  current = (await input.store.commit(current.sessionId, {
    kind: "propose_graph",
    graph: staged,
    ...(input.approveAutomatically ? { retainLeaseForImmediateApproval: true as const } : {}),
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  if (!input.approveAutomatically) return current;
  return (await input.store.commit(current.sessionId, {
    kind: "approve_graph",
    graphRevision: staged.revision,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
}

/**
 * Claim a released durable wait, or an undispatched running plan whose manual
 * approver released its lease. The caller must still enforce its host-specific
 * retry policy before dispatching any stored work.
 */
export async function recoverResearchSessionForResumeV1(
  input: RecoverResearchSessionForResumeInputV1,
): Promise<ResearchSessionV1> {
  const current = await input.store.read(input.sessionId);
  if (!current) throw new Error("Research session was not found.");
  const resumesWait = ["paused", "waiting_steering", "waiting_authentication", "waiting_quota"].includes(current.status);
  if (!current.activeTurnId || (!resumesWait && current.status !== "running")) {
    throw new Error("Research session is not in a resumable durable state.");
  }
  if (Date.parse(input.at) < Date.parse(current.lease.expiresAt)) {
    throw new Error("Research session lease has not been released or expired.");
  }
  let recovered = (await input.store.commit(input.sessionId, {
    kind: "recover",
    ownerId: input.ownerId,
    expiresAt: input.leaseExpiresAt,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  if (resumesWait) {
    recovered = (await input.store.commit(input.sessionId, {
      kind: "resume",
      expectedRevision: recovered.revision,
      expectedLeaseEpoch: recovered.lease.epoch,
      at: input.at,
    })).session;
  }
  const turn = activeTurn(recovered);
  if (!turn || !isRecoverableConsumedRetrievalContinuationV1(turn)) return recovered;
  const graph = turn.graph;
  const checkpoint = graph && turn.retrievalAssessments?.find((assessment) =>
    assessment.graphRevision === graph.revision &&
    assessment.continuation?.status === "consumed" &&
    assessment.continuation.consumedTaskCount === turn.tasks.length &&
    assessment.continuation.consumedPacketCount === turn.acceptedPackets.length,
  );
  if (!graph || !checkpoint?.continuation || checkpoint.wave === undefined) {
    throw new Error("Research continuation recovery lost its durable checkpoint.");
  }
  return (await input.store.commit(input.sessionId, {
    kind: "reissue_retrieval_continuation",
    graphRevision: graph.revision,
    wave: checkpoint.wave,
    continuationId: checkpoint.continuation.id,
    expectedRevision: recovered.revision,
    expectedLeaseEpoch: recovered.lease.epoch,
    at: input.at,
  })).session;
}

/**
 * Sweep expired leases after a host/worker restart without pretending an
 * interrupted provider call has a known outcome. An undispatched approved
 * plan is simply released again. A settled retrieval checkpoint is converted
 * to the same durable `paused` state as an acknowledged user pause, preserving
 * its single issued continuation for an explicit later resume. An expired
 * in-flight provider request takes the explicit conservative `abstain`
 * policy: the host records `outcome_unknown` before terminally failing the
 * session. It never retries or accepts a late result, while already accepted
 * packets remain durable for audit and a later user-started turn.
 */
export async function recoverExpiredResearchSessionsAtSafeBoundaryV1(
  input: RecoverExpiredResearchSessionsAtSafeBoundaryInputV1,
): Promise<ResearchSessionV1[]> {
  const recovered: ResearchSessionV1[] = [];
  const atMillis = Date.parse(input.at);
  if (!Number.isFinite(atMillis) || !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0) {
    throw new Error("Research expired-session recovery input is invalid.");
  }
  const temporaryLeaseExpiresAt = new Date(atMillis + input.leaseDurationMs).toISOString();
  let cursor: string | undefined;
  do {
    const page = await input.store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const listed of page.sessions) {
      // Read again immediately before the fenced write: list pages are only a
      // discovery mechanism and can be stale while another host is active.
      const current = await input.store.read(listed.sessionId);
      if (!current || Date.parse(input.at) < Date.parse(current.lease.expiresAt)) continue;
      const turn = activeTurn(current);
      if (!turn) continue;
      const undispatched = current.status === "running" && isUndispatchedApprovedTurn(turn);
      const checkpoint = (current.status === "running" || current.status === "pause_requested") &&
        isSettledIssuedRetrievalCheckpoint(turn);
      const interrupted = (current.status === "running" || current.status === "pause_requested") &&
        turn.tasks.some((task) => task.status === "running" || task.status === "outcome_unknown");
      const continuationRecovery = current.status === "running" &&
        isRecoverableConsumedRetrievalContinuationV1(turn);
      if (!undispatched && !checkpoint && !interrupted && !continuationRecovery) continue;

      let next = (await input.store.commit(current.sessionId, {
        kind: "recover",
        ownerId: input.ownerId,
        expiresAt: temporaryLeaseExpiresAt,
        expectedRevision: current.revision,
        expectedLeaseEpoch: current.lease.epoch,
        at: input.at,
      })).session;

      if (interrupted) {
        // Do not infer whether the provider received or completed this call.
        // Recording the transition before terminal abstention is the durable
        // boundary that prevents a fresh host from publishing a second packet.
        for (const task of next.turns.find((candidate) => candidate.id === next.activeTurnId)?.tasks ?? []) {
          if (task.status !== "running") continue;
          next = (await input.store.commit(next.sessionId, {
            kind: "outcome_unknown",
            taskId: task.taskId,
            graphRevision: task.graphRevision,
            expectedRevision: next.revision,
            expectedLeaseEpoch: next.lease.epoch,
            at: input.at,
          })).session;
        }
        next = (await input.store.commit(next.sessionId, {
          kind: "fail",
          reason: "Research provider outcome was unobservable after host recovery; no automatic retry was attempted.",
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
      } else if (continuationRecovery) {
        const recoveryTurn = activeTurn(next);
        const graph = recoveryTurn?.graph;
        const continuation = graph && recoveryTurn?.retrievalAssessments?.find((assessment) =>
          assessment.graphRevision === graph.revision &&
          assessment.continuation?.status === "consumed" &&
          assessment.continuation.consumedTaskCount === recoveryTurn.tasks.length &&
          assessment.continuation.consumedPacketCount === recoveryTurn.acceptedPackets.length,
        );
        if (!graph || !continuation?.continuation || continuation.wave === undefined) {
          throw new Error("Research continuation recovery lost its durable checkpoint.");
        }
        next = (await input.store.commit(next.sessionId, {
          kind: "reissue_retrieval_continuation",
          graphRevision: graph.revision,
          wave: continuation.wave,
          continuationId: continuation.continuation.id,
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
        next = (await input.store.commit(next.sessionId, {
          kind: "request_pause",
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
        next = (await input.store.commit(next.sessionId, {
          kind: "acknowledge_pause",
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
      } else if (undispatched) {
        next = (await input.store.commit(next.sessionId, {
          kind: "release_lease",
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
      } else {
        if (next.status === "running") {
          next = (await input.store.commit(next.sessionId, {
            kind: "request_pause",
            expectedRevision: next.revision,
            expectedLeaseEpoch: next.lease.epoch,
            at: input.at,
          })).session;
        }
        next = (await input.store.commit(next.sessionId, {
          kind: "acknowledge_pause",
          expectedRevision: next.revision,
          expectedLeaseEpoch: next.lease.epoch,
          at: input.at,
        })).session;
      }
      recovered.push(next);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return recovered;
}
