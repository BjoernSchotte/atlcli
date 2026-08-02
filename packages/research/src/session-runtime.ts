import {
  approveResearchBriefWholeScopeExpansionV1,
  briefRequiresClarificationV1,
  type ResearchBriefV1,
} from "./brief.js";
import type { ResearchScopeBindingV1 } from "./contracts.js";
import {
  composeResearchGraphV1,
  stageResearchGraphForDurableSessionV1,
  type ResearchGraphCompositionOptionsV1,
  type ResearchGraphV1,
} from "./graph.js";
import type { ResearchSessionStoreV1 } from "./session-store.js";
import {
  RESEARCH_RESUMABLE_SESSION_SCHEMA_V1,
  type ResearchResumableSessionV1,
  type ResearchSessionTurnV1,
  type ResearchSessionV1,
} from "./session.js";

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

function isResumableStatus(
  status: ResearchSessionV1["status"],
): status is ResearchResumableSessionV1["status"] {
  return [
    "waiting_authentication",
    "waiting_quota",
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
  if (!undispatched && !checkpointResumable) return undefined;
  if (turn.graph.approvalEnvelope.status !== "approved" ||
      (undispatched ? turn.graph.status !== "approved" : turn.graph.status !== "running")) {
    return undefined;
  }
  return {
    schema: RESEARCH_RESUMABLE_SESSION_SCHEMA_V1,
    sessionId: session.sessionId,
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
    ? composeResearchGraphV1(approveResearchBriefWholeScopeExpansionV1({
        brief,
        binding: input.binding,
        existingBindings: active.scopeBindings,
      }), { graphRevision: graph.revision + 1 })
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
  const resumesWait = ["paused", "waiting_authentication", "waiting_quota"].includes(current.status);
  if (!current.activeTurnId || (!resumesWait && current.status !== "running")) {
    throw new Error("Research session is not in a resumable durable state.");
  }
  if (Date.parse(input.at) < Date.parse(current.lease.expiresAt)) {
    throw new Error("Research session lease has not been released or expired.");
  }
  const recovered = await input.store.commit(input.sessionId, {
    kind: "recover",
    ownerId: input.ownerId,
    expiresAt: input.leaseExpiresAt,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  });
  if (!resumesWait) return recovered.session;
  return (await input.store.commit(input.sessionId, {
    kind: "resume",
    expectedRevision: recovered.session.revision,
    expectedLeaseEpoch: recovered.session.lease.epoch,
    at: input.at,
  })).session;
}
