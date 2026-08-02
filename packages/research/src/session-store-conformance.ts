import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1, type ResearchGraphProposalV1, type ResearchGraphV1 } from "./graph.js";
import { ResearchSessionDispatchJournalV1 } from "./session-dispatch-journal.js";
import { initializeResearchSessionTurnV1 } from "./session-runtime.js";
import {
  createResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import type {
  ResearchSessionStoreFailureInjectionV1,
  ResearchSessionStoreV1,
} from "./session-store.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  type ResearchTaskAttemptV1,
} from "./workflow-contracts.js";

export interface ResearchSessionStoreConformanceFactoryV1 {
  create(options?: { failureInjection?: ResearchSessionStoreFailureInjectionV1 }): ResearchSessionStoreV1 | Promise<ResearchSessionStoreV1>;
}

export interface ResearchSessionStoreConformanceResultV1 {
  aggregateCommit: "passed";
  staleCas: "passed";
  failureAtomicity: "passed";
  packetPublicationAtomicity: "passed";
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Research session store conformance failed: ${message}`);
}

function session(id: string): ResearchSessionV1 {
  return createResearchSessionV1({
    sessionId: id,
    ownerId: "owner:conformance",
    createdAt: "2026-08-01T11:00:00.000Z",
    leaseExpiresAt: "2026-08-01T11:10:00.000Z",
  });
}

function createTurnUpdate(current: ResearchSessionV1, at: string): ResearchSessionUpdateV1 {
  return {
    kind: "create_turn",
    turnId: "research-turn:conformance",
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at,
  };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function selectedGraphProposal(graph: ResearchGraphV1): ResearchGraphProposalV1 {
  return {
    schema: "atlcli.research-graph-proposal/v1",
    basedOnBriefRevision: graph.basedOnBriefRevision,
    basedOnGraphRevision: graph.revision,
    nodes: graph.nodes
      .filter((node) => node.kind !== "repair")
      .map((node) => ({
        nodeId: node.id,
        dependencies: [...node.dependencies],
        reasonCodes: [...node.reasonCodes],
      })),
  };
}

function acceptedPacketAttempt(graph: ResearchGraphV1): ResearchTaskAttemptV1 {
  const node = graph.nodes.find((candidate) =>
    candidate.status === "ready" && candidate.executor === "subagent" && candidate.roleId !== "reconciler",
  );
  assert(node, "a synthetic packet publication graph has no ready retrieval node");
  return {
    schema: "atlcli.research-task-attempt/v1",
    taskId: `task:conformance-${node.id.replace("research-node:", "")}`,
    nodeId: node.id,
    graphRevision: graph.revision,
    attempt: 1,
    executor: node.executor,
    ...(node.roleId ? { roleId: node.roleId } : {}),
    grantedCapabilityIds: [...node.grantedCapabilityIds],
    typedIntentRefs: [...node.typedIntentRefs],
    expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    budget: { ...node.budget },
    status: "ready",
    dispatchState: "not_started",
    createdAt: graph.createdAt,
  };
}

async function preparePacketPublicationV1(input: {
  store: ResearchSessionStoreV1;
  sessionId: string;
}): Promise<{
  journal: ResearchSessionDispatchJournalV1;
  turnId: string;
  task: ResearchTaskAttemptV1;
  accept: Parameters<ResearchSessionDispatchJournalV1["acceptPacket"]>[0];
}> {
  const turnId = "research-turn:conformance-packet";
  const at = "2026-08-01T11:00:00.000Z";
  const brief = createResearchBriefV1({
    sessionId: input.sessionId,
    turnId,
    objective: "Prove synthetic Jira and Confluence packet publication atomicity.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: at,
    timezone: "UTC",
    requestedPlanApproval: "automatic",
    requestedReconciliation: "off",
  });
  const initialized = await initializeResearchSessionTurnV1({
    store: input.store,
    session: session(input.sessionId),
    brief,
    graph: composeResearchGraphV1(brief),
    approveAutomatically: true,
    at,
  });
  const journal = new ResearchSessionDispatchJournalV1({
    store: input.store,
    sessionId: initialized.sessionId,
    turnId,
    now: () => at,
  });
  const catalog = initialized.turns.find((candidate) => candidate.id === turnId)?.graph;
  assert(catalog, "approved packet publication graph is missing");
  const graph = await journal.commitGraphSelection(selectedGraphProposal(catalog));
  const task = acceptedPacketAttempt(graph);
  await journal.admitAndStart(task);
  const body = {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: "No source content is used by this synthetic publication check.",
    sourceIds: [],
    findingCandidates: [],
    relationshipCandidates: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: ["Synthetic store conformance fixture."],
  };
  return {
    journal,
    turnId,
    task,
    accept: {
      taskId: task.taskId,
      graphRevision: graph.revision,
      body,
      usage: {
        capabilityCalls: 0,
        inputTokens: 1,
        outputTokens: 1,
        resultBytes: bytes(body),
        durationMs: 1,
        costMicros: 0,
      },
      availableSourceIds: [],
      maximumResultBytes: task.budget.maxResultBytes,
    },
  };
}

/**
 * Run the portable T4 contract checks. Physical adapters call this exact
 * function with their test-only failure injector instead of duplicating an
 * approximation of the CAS/journal boundary in every host test suite.
 */
export async function verifyResearchSessionStoreConformanceV1(
  factory: ResearchSessionStoreConformanceFactoryV1,
  prefix = "research-session:conformance",
): Promise<ResearchSessionStoreConformanceResultV1> {
  const store = await factory.create();
  const initial = await store.create(session(`${prefix}-commit`));
  const committed = await store.commit(initial.sessionId, createTurnUpdate(initial, "2026-08-01T11:00:01.000Z"));
  assert(committed.session.revision === 2 && committed.session.status === "planning", "committed snapshot is missing");
  const events = await store.events(initial.sessionId);
  assert(events.length === 1 && events[0]?.sessionRevision === 2 && events[0]?.kind === "create_turn", "journal event does not match committed state");

  let staleRejected = false;
  try {
    await store.commit(initial.sessionId, createTurnUpdate(initial, "2026-08-01T11:00:02.000Z"));
  } catch {
    staleRejected = true;
  }
  assert(staleRejected, "stale compare-and-swap write was accepted");
  const afterStale = await store.read(initial.sessionId);
  assert(afterStale?.revision === 2 && (await store.events(initial.sessionId)).length === 1, "stale write mutated session or journal");

  const failing = await factory.create({
    failureInjection: {
      onStage(stage) {
        if (stage === "before_event_append") throw new Error("conformance injected journal failure");
      },
    },
  });
  const failureInitial = await failing.create(session(`${prefix}-failure`));
  let failureRaised = false;
  try {
    await failing.commit(failureInitial.sessionId, createTurnUpdate(failureInitial, "2026-08-01T11:00:01.000Z"));
  } catch {
    failureRaised = true;
  }
  assert(failureRaised, "failure injector was not observed");
  const afterFailure = await failing.read(failureInitial.sessionId);
  assert(afterFailure?.revision === 1 && (await failing.events(failureInitial.sessionId)).length === 0, "failed aggregate commit leaked partial state");

  for (const stage of ["before_state_commit", "before_event_append"] as const) {
    let injected = false;
    const publishing = await factory.create({
      failureInjection: {
        onStage(currentStage, _sessionId, context) {
          if (!injected && currentStage === stage && context?.updateKind === "accept_packet") {
            injected = true;
            throw new Error(`conformance injected ${stage} packet publication failure`);
          }
        },
      },
    });
    const prepared = await preparePacketPublicationV1({
      store: publishing,
      sessionId: `${prefix}-packet-${stage}`,
    });
    let publicationRaised = false;
    try {
      await prepared.journal.acceptPacket(prepared.accept);
    } catch {
      publicationRaised = true;
    }
    assert(injected && publicationRaised, `${stage} packet publication failure was not observed`);
    const beforeRecovery = await publishing.read(`${prefix}-packet-${stage}`);
    const beforeTurn = beforeRecovery?.turns.find((candidate) => candidate.id === prepared.turnId);
    assert(beforeTurn, `${stage} packet publication turn is missing before recovery`);
    const beforeTask = beforeTurn?.tasks.find((candidate) => candidate.taskId === prepared.task.taskId);
    const beforeNode = beforeTurn?.graph?.nodes.find((candidate) => candidate.id === prepared.task.nodeId);
    assert(
      beforeTask?.status === "running" && beforeTask.dispatchState === "dispatch_started" &&
        beforeNode?.status === "running" && beforeTurn.acceptedPackets.length === 0,
      `${stage} leaked a terminal packet state before aggregate publication`,
    );
    assert(
      (await publishing.events(`${prefix}-packet-${stage}`)).filter((event) => event.kind === "accept_packet").length === 0,
      `${stage} leaked an accepted-packet journal event`,
    );

    // A fresh journal instance represents recovery of the local publisher after
    // the failed aggregate transaction. Its durable attempt is still running.
    const recoveredJournal = new ResearchSessionDispatchJournalV1({
      store: publishing,
      sessionId: `${prefix}-packet-${stage}`,
      turnId: prepared.turnId,
      now: () => "2026-08-01T11:00:01.000Z",
    });
    const accepted = await recoveredJournal.acceptPacket(prepared.accept);
    let duplicateRejected = false;
    try {
      await recoveredJournal.acceptPacket(prepared.accept);
    } catch {
      duplicateRejected = true;
    }
    const afterRecovery = await publishing.read(`${prefix}-packet-${stage}`);
    const afterTurn = afterRecovery?.turns.find((candidate) => candidate.id === prepared.turnId);
    assert(afterTurn, `${stage} packet publication turn is missing after recovery`);
    const afterTask = afterTurn?.tasks.find((candidate) => candidate.taskId === prepared.task.taskId);
    const afterNode = afterTurn?.graph?.nodes.find((candidate) => candidate.id === prepared.task.nodeId);
    assert(
      duplicateRejected && afterTask?.status === "complete" && afterTask.dispatchState === "result_committed" &&
        afterNode?.status === "complete" && afterNode.packetRef === accepted.packetRef &&
        afterTurn.acceptedPackets.filter((packet) => packet.packetRef === accepted.packetRef).length === 1,
      `${stage} recovery did not retain exactly one accepted packet with its terminal graph node`,
    );
    assert(
      (await publishing.events(`${prefix}-packet-${stage}`)).filter((event) => event.kind === "accept_packet").length === 1,
      `${stage} recovery did not retain exactly one accepted-packet journal event`,
    );
  }

  return {
    aggregateCommit: "passed",
    staleCas: "passed",
    failureAtomicity: "passed",
    packetPublicationAtomicity: "passed",
  };
}
