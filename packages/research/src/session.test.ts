import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import {
  composeResearchGraphV1,
  type ResearchGraphProposalV1,
} from "./graph.js";
import {
  createResearchSessionV1,
  reduceResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import { RESEARCH_PACKET_BODY_SCHEMA_V1, type ResearchTaskAttemptV1 } from "./workflow-contracts.js";

const createdAt = "2026-08-01T09:00:00.000Z";

function session(): ResearchSessionV1 {
  return createResearchSessionV1({
    sessionId: "research-session:durable-test",
    ownerId: "owner:test",
    createdAt,
    leaseExpiresAt: "2026-08-01T09:10:00.000Z",
  });
}

function update<T extends Omit<ResearchSessionUpdateV1, "expectedRevision" | "expectedLeaseEpoch" | "at">>(
  current: ResearchSessionV1,
  value: T,
  at: string,
): ResearchSessionV1 {
  return reduceResearchSessionV1(current, {
    ...value,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at,
  } as ResearchSessionUpdateV1);
}

function brief() {
  return createResearchBriefV1({
    sessionId: "research-session:durable-test",
    turnId: "research-turn:one",
    objective: "Which Jira work item relates to this Confluence page?",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: createdAt,
    timezone: "UTC",
    requestedPlanApproval: "required",
    requestedReconciliation: "off",
  });
}

function admittedTask(current: ResearchSessionV1): ResearchTaskAttemptV1 {
  const node = current.turns[0]!.graph!.nodes.find((candidate) => candidate.status === "ready")!;
  return {
    schema: "atlcli.research-task-attempt/v1",
    taskId: "task:durable-1",
    nodeId: node.id,
    graphRevision: current.turns[0]!.graph!.revision,
    attempt: 1,
    executor: node.executor,
    ...(node.roleId ? { roleId: node.roleId } : {}),
    grantedCapabilityIds: [...node.grantedCapabilityIds],
    typedIntentRefs: [...node.typedIntentRefs],
    expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    budget: { ...node.budget },
    status: "ready",
    dispatchState: "not_started",
    createdAt,
  };
}

function readyToRun(): ResearchSessionV1 {
  let current = session();
  current = update(current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T09:00:01.000Z");
  const acceptedBrief = brief();
  current = update(current, { kind: "record_brief", brief: acceptedBrief }, "2026-08-01T09:00:02.000Z");
  const graph = composeResearchGraphV1(acceptedBrief);
  current = update(current, { kind: "propose_graph", graph }, "2026-08-01T09:00:03.000Z");
  return update(current, { kind: "approve_graph", graphRevision: graph.revision }, "2026-08-01T09:00:04.000Z");
}

function fullGraphProposal(current: ResearchSessionV1): ResearchGraphProposalV1 {
  const graph = current.turns[0]!.graph!;
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

describe("durable host-neutral research session reducer", () => {
  test("persists a revision-fenced accepted turn and plan before any dispatch", () => {
    const running = readyToRun();
    const turn = running.turns[0]!;
    expect(running).toMatchObject({ status: "running", revision: 5, activeTurnId: "research-turn:one" });
    expect(turn.brief?.objective).toContain("Jira work item");
    expect(turn.graph).toMatchObject({ status: "approved", approvalEnvelope: { status: "approved" } });
    expect(turn.graph?.nodes.some((node) => node.status === "ready")).toBe(true);
  });

  test("accepts a packet atomically with its task and graph node", () => {
    let current = readyToRun();
    const task = admittedTask(current);
    current = update(current, { kind: "admit_tasks", graphRevision: task.graphRevision, tasks: [task] }, "2026-08-01T09:00:05.000Z");
    current = update(current, { kind: "dispatch_started", taskId: task.taskId, graphRevision: task.graphRevision, providerRequestId: "request:1" }, "2026-08-01T09:00:06.000Z");
    current = update(current, {
      kind: "accept_packet",
      taskId: task.taskId,
      graphRevision: task.graphRevision,
      body: {
        schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
        answeredQuestion: "The source contains a supported relationship.",
        sourceIds: ["jira:DEMO-1"],
        findingCandidates: [{ id: "finding:durable-1", classification: "fact", summary: "Supported finding.", sourceIds: ["jira:DEMO-1"] }],
        relationshipCandidates: [],
        gaps: [],
        proposedFollowUps: [],
        coverageLimits: [],
      },
      usage: { capabilityCalls: 1, inputTokens: 12, outputTokens: 8, resultBytes: 1_000, durationMs: 100, costMicros: 1 },
      availableSourceIds: ["jira:DEMO-1"],
      maximumResultBytes: 8_192,
    }, "2026-08-01T09:00:07.000Z");

    const turn = current.turns[0]!;
    expect(turn.tasks).toMatchObject([{ status: "complete", dispatchState: "result_committed", acceptedPacketRef: "packet:task:durable-1:1" }]);
    expect(turn.acceptedPackets).toHaveLength(1);
    expect(turn.graph?.nodes.find((node) => node.id === task.nodeId)).toMatchObject({ status: "complete", packetRef: "packet:task:durable-1:1" });
  });

  test("commits the exact supervisor graph selection before task admission", () => {
    let current = readyToRun();
    current = update(current, {
      kind: "commit_graph_selection",
      proposal: fullGraphProposal(current),
    }, "2026-08-01T09:00:04.500Z");

    const turn = current.turns[0]!;
    expect(turn.graphSelectionCommittedAt).toBe("2026-08-01T09:00:04.500Z");
    expect(turn.graph?.nodes.every((node) => node.kind !== "repair")).toBe(true);
    expect(turn.graph?.nodes.some((node) => node.status === "ready")).toBe(true);
    expect(() => update(current, {
      kind: "commit_graph_selection",
      proposal: fullGraphProposal(current),
    }, "2026-08-01T09:00:04.600Z")).toThrow("immutable");
  });

  test("rejects stale writers without mutating its input", () => {
    const current = session();
    const snapshot = structuredClone(current);
    expect(() => reduceResearchSessionV1(current, {
      kind: "create_turn",
      turnId: "research-turn:one",
      expectedRevision: 99,
      expectedLeaseEpoch: current.lease.epoch,
      at: "2026-08-01T09:00:01.000Z",
    })).toThrow("stale");
    expect(current).toEqual(snapshot);
  });

  test("fences recovery with an incremented lease epoch after expiry", () => {
    const current = session();
    const recovered = update(current, {
      kind: "recover",
      ownerId: "owner:recovered",
      expiresAt: "2026-08-01T09:20:00.000Z",
    }, "2026-08-01T09:11:00.000Z");
    expect(recovered).toMatchObject({ revision: 2, lease: { epoch: 2, ownerId: "owner:recovered" } });
    expect(() => reduceResearchSessionV1(recovered, {
      kind: "create_turn",
      turnId: "research-turn:stale-owner",
      expectedRevision: recovered.revision,
      expectedLeaseEpoch: 1,
      at: "2026-08-01T09:12:00.000Z",
    })).toThrow("lease epoch is stale");
  });

  test("records an epoch-fenced heartbeat without taking ownership away from its lease holder", () => {
    const current = session();
    const heartbeated = update(current, {
      kind: "heartbeat",
      leaseExpiresAt: "2026-08-01T09:15:00.000Z",
    }, "2026-08-01T09:05:00.000Z");
    expect(heartbeated).toMatchObject({
      revision: 2,
      lease: {
        epoch: 1,
        ownerId: "owner:test",
        heartbeatAt: "2026-08-01T09:05:00.000Z",
        expiresAt: "2026-08-01T09:15:00.000Z",
      },
    });
  });

  test("persists a pause acknowledgement rather than treating sidebar loss as cancellation", () => {
    let current = readyToRun();
    current = update(current, { kind: "request_pause" }, "2026-08-01T09:00:05.000Z");
    current = update(current, { kind: "acknowledge_pause" }, "2026-08-01T09:00:06.000Z");
    expect(current).toMatchObject({ status: "paused" });
    expect(current.turns[0]!.pausedAt).toBe("2026-08-01T09:00:06.000Z");
  });
});
