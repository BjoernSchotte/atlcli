import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1, type ResearchGraphProposalV1 } from "./graph.js";
import { initializeResearchSessionTurnV1 } from "./session-runtime.js";
import { ResearchSessionDispatchJournalV1 } from "./session-dispatch-journal.js";
import { InMemoryResearchSessionStoreV1 } from "./session-store.js";
import { createResearchSessionV1 } from "./session.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  type ResearchTaskAttemptV1,
} from "./workflow-contracts.js";

const createdAt = "2026-08-01T16:00:00.000Z";

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function initializedJournal() {
  const brief = createResearchBriefV1({
    sessionId: "research-session:dispatch-journal",
    turnId: "research-turn:dispatch-journal",
    objective: "Find related Jira and Confluence records.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: createdAt,
    timezone: "UTC",
    requestedPlanApproval: "automatic",
    requestedReconciliation: "off",
  });
  const store = new InMemoryResearchSessionStoreV1();
  const session = await initializeResearchSessionTurnV1({
    store,
    session: createResearchSessionV1({
      sessionId: brief.sessionId,
      ownerId: "owner:dispatch-journal",
      createdAt,
      leaseExpiresAt: "2026-08-01T16:10:00.000Z",
    }),
    brief,
    graph: composeResearchGraphV1(brief),
    approveAutomatically: true,
    at: createdAt,
  });
  const journal = new ResearchSessionDispatchJournalV1({
    store,
    sessionId: session.sessionId,
    turnId: brief.turnId,
    now: (() => {
      let sequence = 0;
      return () => `2026-08-01T16:00:${String(++sequence).padStart(2, "0")}.000Z`;
    })(),
  });
  const catalog = session.turns[0]!.graph!;
  const selectedNodeIds = new Set(catalog.nodes
    .filter((node) => node.kind !== "repair")
    .map((node) => node.id));
  const proposal: ResearchGraphProposalV1 = {
    schema: "atlcli.research-graph-proposal/v1",
    basedOnBriefRevision: catalog.basedOnBriefRevision,
    basedOnGraphRevision: catalog.revision,
    nodes: catalog.nodes.filter((node) => selectedNodeIds.has(node.id)).map((node) => ({
      nodeId: node.id,
      dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
      reasonCodes: [...node.reasonCodes],
    })),
  };
  const graph = await journal.commitGraphSelection(proposal);
  return { store, sessionId: session.sessionId, turnId: brief.turnId, journal, graph };
}

function attemptFor(
  graph: Awaited<ReturnType<typeof initializedJournal>>["graph"],
  nodeId: string,
): ResearchTaskAttemptV1 {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
  return {
    schema: "atlcli.research-task-attempt/v1",
    taskId: `task:dispatch-${node.id.replace("research-node:", "")}`,
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

describe("durable research task dispatch journal", () => {
  test("commits selected graph, ready task, dispatch start, and accepted packet through one session journal", async () => {
    const { store, sessionId, turnId, journal, graph } = await initializedJournal();
    const node = graph.nodes.find((candidate) => candidate.status === "ready")!;
    const attempt = attemptFor(graph, node.id);

    await expect(journal.admitAndStart(attempt)).resolves.toMatchObject({
      taskId: attempt.taskId,
      status: "running",
      dispatchState: "dispatch_started",
    });
    const body = {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      answeredQuestion: "No detail-backed relationship was observed.",
      sourceIds: [],
      findingCandidates: [],
      relationshipCandidates: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: ["No details were available."],
    };
    const packet = await journal.acceptPacket({
      taskId: attempt.taskId,
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
      maximumResultBytes: attempt.budget.maxResultBytes,
    });

    const stored = await store.read(sessionId);
    const turn = stored!.turns.find((candidate) => candidate.id === turnId)!;
    expect(packet).toMatchObject({ taskId: attempt.taskId, packetRef: `packet:${attempt.taskId}:1` });
    expect(turn.tasks).toMatchObject([{ taskId: attempt.taskId, status: "complete", dispatchState: "result_committed" }]);
    expect(turn.acceptedPackets).toMatchObject([{ packetRef: packet.packetRef }]);
    expect(turn.graph?.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      status: "complete",
      packetRef: packet.packetRef,
    });
    expect((await store.events(sessionId)).map((event) => event.kind).slice(-4)).toEqual([
      "commit_graph_selection",
      "admit_tasks",
      "dispatch_started",
      "accept_packet",
    ]);
  });

  test("serializes concurrently scheduled ready nodes instead of racing the session CAS", async () => {
    const { store, sessionId, journal, graph } = await initializedJournal();
    const ready = graph.nodes.filter((node) => node.status === "ready");
    expect(ready).toHaveLength(2);

    const started = await Promise.all(ready.map((node) => journal.admitAndStart(attemptFor(graph, node.id))));

    expect(started.map((attempt) => attempt.status)).toEqual(["running", "running"]);
    const stored = await store.read(sessionId);
    expect(stored?.turns[0]?.tasks.map((attempt) => attempt.status)).toEqual(["running", "running"]);
    expect((await store.events(sessionId)).filter((event) => event.kind === "dispatch_started")).toHaveLength(2);
  });

  test("records an unknown provider outcome and then quarantines the active graph node", async () => {
    const { store, sessionId, journal, graph } = await initializedJournal();
    const node = graph.nodes.find((candidate) => candidate.status === "ready")!;
    const attempt = attemptFor(graph, node.id);
    await journal.admitAndStart(attempt);
    await expect(journal.markOutcomeUnknown(attempt.taskId, graph.revision)).resolves.toMatchObject({
      status: "outcome_unknown",
      dispatchState: "outcome_unknown",
    });
    await expect(journal.quarantine(attempt.taskId, graph.revision, "late-result")).resolves.toMatchObject({
      status: "quarantined",
    });

    const stored = await store.read(sessionId);
    expect(stored?.turns[0]?.graph?.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      status: "quarantined",
      stopReason: "late-result",
    });
  });
});
