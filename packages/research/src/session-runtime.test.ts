import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import {
  composeResearchGraphV1,
  type ResearchGraphProposalV1,
} from "./graph.js";
import {
  appendResearchSessionTurnV1,
  initializeResearchSessionTurnV1,
  recoverResearchSessionForResumeV1,
} from "./session-runtime.js";
import { InMemoryResearchSessionStoreV1 } from "./session-store.js";
import { createResearchSessionV1 } from "./session.js";

function brief(approval: "automatic" | "required", turnId = "research-turn:runtime-test") {
  return createResearchBriefV1({
    sessionId: "research-session:runtime-test",
    turnId,
    objective: "Find the related Jira work item.",
    scope: { siteOrigin: "https://example.atlassian.net", jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCS"] },
    asOf: "2026-08-01T15:00:00.000Z",
    timezone: "UTC",
    requestedPlanApproval: approval,
  });
}

function session() {
  return createResearchSessionV1({
    sessionId: "research-session:runtime-test",
    ownerId: "owner:runtime",
    createdAt: "2026-08-01T15:00:00.000Z",
    leaseExpiresAt: "2026-08-01T15:10:00.000Z",
  });
}

describe("durable research session execution gate", () => {
  test("persists an accepted turn, brief, exact proposed graph, and separate automatic approval before execution", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({ status: "running", revision: 5 });
    expect(result.turns[0]).toMatchObject({ brief: { objective: "Find the related Jira work item." }, graph: { status: "approved" } });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph", "approve_graph"]);
  });

  test("leaves a required plan durably waiting without any approval transition", async () => {
    const requiredBrief = brief("required");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: requiredBrief,
      graph: composeResearchGraphV1(requiredBrief),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({ status: "waiting_plan_approval", revision: 4 });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph"]);
  });

  test("appends an approved follow-up turn without replacing terminal turn history", async () => {
    const firstBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: firstBrief,
      graph: composeResearchGraphV1(firstBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const terminal = await store.commit(initialized.sessionId, {
      kind: "fail",
      reason: "Synthetic terminal first turn.",
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });
    const nextBrief = brief("automatic", "research-turn:runtime-follow-up");
    const appended = await appendResearchSessionTurnV1({
      store,
      sessionId: terminal.session.sessionId,
      brief: nextBrief,
      graph: composeResearchGraphV1(nextBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:03.000Z",
    });
    expect(appended).toMatchObject({
      status: "running",
      activeTurnId: "research-turn:runtime-follow-up",
    });
    expect(appended.turns).toHaveLength(2);
    expect(appended.turns[0]).toMatchObject({
      id: "research-turn:runtime-test",
      failureReason: "Synthetic terminal first turn.",
    });
    expect(appended.turns[1]).toMatchObject({
      id: "research-turn:runtime-follow-up",
      graph: { status: "approved" },
    });
  });

  test("commits the supervisor-selected subset with its journal event before task admission", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const graph = initialized.turns[0]!.graph!;
    const selectedNodeIds = new Set(graph.nodes
      .filter((node) => node.kind !== "repair")
      .map((node) => node.id));
    const proposal: ResearchGraphProposalV1 = {
      schema: "atlcli.research-graph-proposal/v1",
      basedOnBriefRevision: graph.basedOnBriefRevision,
      basedOnGraphRevision: graph.revision,
      nodes: graph.nodes.filter((node) => selectedNodeIds.has(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
        reasonCodes: [...node.reasonCodes],
      })),
    };

    const committed = await store.commit(initialized.sessionId, {
      kind: "commit_graph_selection",
      proposal,
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });

    expect(committed.session.turns[0]).toMatchObject({
      graphSelectionCommittedAt: "2026-08-01T15:00:02.000Z",
      tasks: [],
    });
    expect(committed.session.turns[0]!.graph?.nodes).toHaveLength(proposal.nodes.length);
    expect((await store.events(initialized.sessionId)).at(-1)).toMatchObject({
      kind: "commit_graph_selection",
      sessionRevision: committed.session.revision,
    });
  });

  test("reclaims a released authentication wait with a new lease epoch before resuming", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const waiting = await store.commit(initialized.sessionId, {
      kind: "wait_authentication",
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });
    const resumed = await recoverResearchSessionForResumeV1({
      store,
      sessionId: initialized.sessionId,
      ownerId: "owner:resumed",
      leaseExpiresAt: "2026-08-01T15:10:00.000Z",
      at: "2026-08-01T15:00:02.001Z",
    });
    expect(waiting.session).toMatchObject({ status: "waiting_authentication", lease: { epoch: 1 } });
    expect(resumed).toMatchObject({ status: "running", lease: { epoch: 2, ownerId: "owner:resumed" } });
    expect((await store.events(initialized.sessionId)).slice(-2).map((event) => event.kind))
      .toEqual(["recover", "resume"]);
  });
});
