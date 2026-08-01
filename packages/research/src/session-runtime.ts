import type { ResearchBriefV1 } from "./brief.js";
import {
  stageResearchGraphForDurableSessionV1,
  type ResearchGraphV1,
} from "./graph.js";
import type { ResearchSessionStoreV1 } from "./session-store.js";
import type { ResearchSessionV1 } from "./session.js";

export interface InitializeResearchSessionTurnInputV1 {
  store: ResearchSessionStoreV1;
  session: ResearchSessionV1;
  brief: ResearchBriefV1;
  graph: ResearchGraphV1;
  /** Host policy: an explicit automatic plan gets a separately journaled host approval. */
  approveAutomatically: boolean;
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
