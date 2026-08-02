import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import {
  composeResearchGraphV1,
  type ResearchGraphProposalV1,
} from "./graph.js";
import {
  appendResearchSessionTurnV1,
  initializeResearchSessionClarificationWaitV1,
  initializeResearchSessionTurnV1,
  proposeResearchGraphForReadyBriefV1,
  projectResearchResumableSessionV1,
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
  test("persists a required clarification as a released body-free wait before graph construction", async () => {
    const requiredClarification = createResearchBriefV1({
      ...brief("automatic"),
      clarificationQuestions: [{
        id: "clarification:scope",
        prompt: "Which exact project should be searched?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: requiredClarification,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({
      status: "waiting_clarification",
      revision: 3,
      lease: { expiresAt: "2026-08-01T15:00:01.000Z" },
      turns: [{
        brief: { revision: 1, clarificationQuestions: [{ id: "clarification:scope" }] },
      }],
    });
    expect((await store.events(result.sessionId)).map((event) => event.kind))
      .toEqual(["create_turn", "record_brief"]);
  });

  test("proposes a graph only after a committed clarification materializes a ready brief", async () => {
    const pending = createResearchBriefV1({
      ...brief("required"),
      clarificationQuestions: [{
        id: "clarification:window",
        prompt: "Which reporting window should be used?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: pending,
      at: "2026-08-01T15:00:01.000Z",
    });
    const resolved = (await store.commit(waiting.sessionId, {
      kind: "resolve_clarifications",
      briefRevision: pending.revision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [],
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const proposed = await proposeResearchGraphForReadyBriefV1({
      store,
      sessionId: resolved.sessionId,
      expectedRevision: resolved.revision,
      expectedLeaseEpoch: resolved.lease.epoch,
      approveAutomatically: false,
      at: "2026-08-01T15:00:03.000Z",
    });

    expect(proposed).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, clarificationResponses: [{ response: "Use the latest week." }] },
        graph: { basedOnBriefRevision: 2, status: "proposed" },
      }],
    });
    expect((await store.events(proposed.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "resolve_clarifications",
      "propose_graph",
    ]);
  });

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
    expect(result).toMatchObject({
      status: "waiting_plan_approval",
      revision: 4,
      lease: { expiresAt: "2026-08-01T15:00:01.000Z" },
    });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph"]);
  });

  test("rebuilds a rejected plan from its committed correction and never auto-approves it", async () => {
    const requiredBrief = brief("required");
    const store = new InMemoryResearchSessionStoreV1();
    const initial = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: requiredBrief,
      graph: composeResearchGraphV1(requiredBrief),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    const firstGraph = initial.turns[0]!.graph!;
    const rejected = (await store.commit(initial.sessionId, {
      kind: "reject_plan",
      graphRevision: firstGraph.revision,
      reason: "Separate direct evidence from inferred relationships.",
      expectedRevision: initial.revision,
      expectedLeaseEpoch: initial.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const requested = (await store.commit(rejected.sessionId, {
      kind: "request_plan_revision",
      graphRevision: firstGraph.revision,
      instruction: "Separate direct evidence from inferred relationships.",
      expectedRevision: rejected.revision,
      expectedLeaseEpoch: rejected.lease.epoch,
      at: "2026-08-01T15:00:03.000Z",
    })).session;
    const rebuilt = await proposeResearchGraphForReadyBriefV1({
      store,
      sessionId: requested.sessionId,
      expectedRevision: requested.revision,
      expectedLeaseEpoch: requested.lease.epoch,
      approveAutomatically: true,
      at: "2026-08-01T15:00:04.000Z",
    });

    expect(rebuilt).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, planRevisionInstructions: [{ basedOnGraphRevision: 1 }] },
        graph: { revision: 2, basedOnBriefRevision: 2, status: "proposed" },
        planRevisions: [{ state: "proposed", proposedGraphRevision: 2 }],
      }],
    });
    expect((await store.events(rebuilt.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "propose_graph",
      "reject_plan",
      "request_plan_revision",
      "revise_graph",
    ]);
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

  test("projects only expired, tenant-bound durable resumes without source or provider data", async () => {
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

    expect(projectResearchResumableSessionV1(waiting.session, {
      tenantOrigin: "https://example.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toEqual({
      schema: "atlcli.research-resumable-session/v1",
      sessionId: initialized.sessionId,
      turnId: "research-turn:runtime-test",
      status: "waiting_authentication",
      updatedAt: "2026-08-01T15:00:02.000Z",
      question: "Find the related Jira work item.",
      scope: {
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
    });
    expect(projectResearchResumableSessionV1(waiting.session, {
      tenantOrigin: "https://other.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toBeUndefined();
    expect(projectResearchResumableSessionV1(initialized, {
      tenantOrigin: "https://example.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toBeUndefined();
  });
});
