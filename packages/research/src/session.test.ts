import { describe, expect, test } from "bun:test";
import {
  approveResearchBriefWholeScopeExpansionV1,
  createResearchBriefV1,
} from "./brief.js";
import {
  RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1,
  acceptResearchGraphProposalV1,
  composeResearchGraphV1,
  reviseResearchGraphSelectionV1,
  type ResearchGraphProposalV1,
} from "./graph.js";
import { assessResearchRetrievalV1 } from "./retrieval-assessment.js";
import { createResearchScopeExpansionProposalV1 } from "./scope-discovery.js";
import {
  createResearchSessionV1,
  reduceResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import { RESEARCH_PACKET_BODY_SCHEMA_V1, type ResearchTaskAttemptV1 } from "./workflow-contracts.js";
import type { ResearchScopeCandidateV1 } from "./scope-discovery.js";

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

function brief(input: Partial<Parameters<typeof createResearchBriefV1>[0]> = {}) {
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
    ...input,
  });
}

function scopeCandidate(input: Partial<ResearchScopeCandidateV1> = {}): ResearchScopeCandidateV1 {
  return {
    schema: "atlcli.research-scope-candidate/v1",
    id: "research-scope-candidate:confluence-space-related",
    tenantOrigin: "https://example.atlassian.net",
    product: "confluence",
    entityKind: "space",
    entityRef: "research-scope-entity:confluence-space-related",
    key: "RELATED",
    name: "Related documentation",
    status: "current",
    accessible: true,
    providerFreshnessAt: "2026-08-01T09:00:00.000Z",
    ...input,
  };
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

function readyToRun(acceptedBrief = brief()): ResearchSessionV1 {
  let current = session();
  current = update(current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T09:00:01.000Z");
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

/** Build the only checkpoint from which a user may steer: a completed retrieval wave. */
function settledPausedSteeringCheckpoint(): {
  catalog: ReturnType<typeof composeResearchGraphV1>;
  current: ResearchSessionV1;
} {
  let current = readyToRun();
  const catalog = current.turns[0]!.graph!;
  current = update(current, {
    kind: "commit_graph_selection",
    proposal: fullGraphProposal(current),
  }, "2026-08-01T09:00:04.500Z");
  const task = admittedTask(current);
  current = update(current, {
    kind: "admit_tasks",
    graphRevision: task.graphRevision,
    tasks: [task],
  }, "2026-08-01T09:00:04.600Z");
  current = update(current, {
    kind: "dispatch_started",
    taskId: task.taskId,
    graphRevision: task.graphRevision,
  }, "2026-08-01T09:00:04.700Z");
  const budgetState = {
    schema: "atlcli.research-run-budget/v1" as const,
    ptcCalls: 1,
    httpAttempts: 1,
    responseBytes: 256,
    pages: { jira: 1, confluence: 0 },
    items: { jira: 1, confluence: 0 },
    details: { jira: 1, confluence: 0 },
  };
  current = update(current, {
    kind: "accept_packet",
    taskId: task.taskId,
    graphRevision: task.graphRevision,
    body: {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      answeredQuestion: "The bounded retrieval wave completed.",
      sourceIds: [],
      findingCandidates: [],
      relationshipCandidates: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: [],
    },
    usage: { capabilityCalls: 1, inputTokens: 1, outputTokens: 1, resultBytes: 256, durationMs: 1, costMicros: 0 },
    availableSourceIds: [],
    maximumResultBytes: task.budget.maxResultBytes,
    budgetState,
  }, "2026-08-01T09:00:04.800Z");
  current = update(current, {
    kind: "record_retrieval_assessment",
    graphRevision: task.graphRevision,
    assessment: assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1"],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 2,
      httpAttemptsRemaining: 2,
    }),
    issueContinuation: true,
    budgetState,
  }, "2026-08-01T09:00:04.900Z");
  current = update(current, { kind: "request_pause" }, "2026-08-01T09:00:05.000Z");
  current = update(current, { kind: "acknowledge_pause" }, "2026-08-01T09:00:05.100Z");
  return { catalog, current };
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

  test("upgrades a legacy running turn when it records its first retrieval assessment", () => {
    let current = readyToRun();
    delete current.turns[0]!.retrievalAssessments;
    const graphRevision = current.turns[0]!.graph!.revision;
    const assessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: [],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: false,
      }],
      ptcCallsRemaining: 0,
      httpAttemptsRemaining: 0,
    });

    current = update(current, {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment,
    }, "2026-08-01T09:00:05.000Z");

    expect(current.turns[0]!.retrievalAssessments!).toEqual([
      expect.objectContaining({ graphRevision, wave: 1, assessment }),
    ]);
    expect(current.turns[0]!.graph?.researchWavesCompleted).toBe(1);
  });

  test("records contiguous retrieval waves and stops after a terminal decision", () => {
    let current = readyToRun();
    const graphRevision = current.turns[0]!.graph!.revision;
    const continueAssessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1"],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 2,
      httpAttemptsRemaining: 2,
    });
    const stopAssessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1"],
        detailedSourceIds: ["jira:DEMO-1"],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: false,
      }],
      ptcCallsRemaining: 0,
      httpAttemptsRemaining: 0,
    });

    current = update(current, {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment: continueAssessment,
    }, "2026-08-01T09:00:05.000Z");
    current = update(current, {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment: stopAssessment,
    }, "2026-08-01T09:00:06.000Z");

    expect(current.turns[0]!.retrievalAssessments).toEqual([
      expect.objectContaining({ wave: 1, assessment: continueAssessment }),
      expect.objectContaining({ wave: 2, assessment: stopAssessment }),
    ]);
    expect(current.turns[0]!.graph?.researchWavesCompleted).toBe(2);
    expect(() => update(current, {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment: continueAssessment,
    }, "2026-08-01T09:00:07.000Z")).toThrow("terminal decision");
  });

  test("issues one revision-fenced continuation for replan or terminal finalization", () => {
    let current = readyToRun();
    const graphRevision = current.turns[0]!.graph!.revision;
    const continueAssessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1"],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 2,
      httpAttemptsRemaining: 2,
    });
    const stopAssessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: [],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: false,
      }],
      ptcCallsRemaining: 0,
      httpAttemptsRemaining: 0,
    });

    current = update(current, {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment: continueAssessment,
      issueContinuation: true,
    }, "2026-08-01T09:00:05.000Z");
    const issued = current.turns[0]!.retrievalAssessments![0]!.continuation!;
    expect(issued).toMatchObject({
      id: `research-continuation:${graphRevision}.1`,
      status: "issued",
    });

    current = update(current, {
      kind: "consume_retrieval_continuation",
      graphRevision,
      wave: 1,
      continuationId: issued.id,
    }, "2026-08-01T09:00:06.000Z");
    expect(current.turns[0]!.retrievalAssessments![0]!.continuation).toMatchObject({
      status: "consumed",
      consumedAt: "2026-08-01T09:00:06.000Z",
    });
    expect(() => update(current, {
      kind: "consume_retrieval_continuation",
      graphRevision,
      wave: 1,
      continuationId: issued.id,
    }, "2026-08-01T09:00:07.000Z")).toThrow("already consumed");
    expect(() => update(current, {
      kind: "request_pause",
    }, "2026-08-01T09:00:08.000Z")).toThrow("continuation is consumed");

    const terminal = update(readyToRun(), {
      kind: "record_retrieval_assessment",
      graphRevision,
      assessment: stopAssessment,
      issueContinuation: true,
    }, "2026-08-01T09:00:05.000Z");
    expect(terminal.turns[0]!.retrievalAssessments![0]!.continuation).toMatchObject({
      id: `research-continuation:${graphRevision}.1`,
      status: "issued",
    });
  });

  test("persists a checkpoint-caused graph revision with bounded evidence and gap identifiers", () => {
    let current = readyToRun();
    const catalog = current.turns[0]!.graph!;
    const selectedIds = catalog.nodes
      .filter((node) => node.kind === "search" || node.roleId === "synthesizer")
      .map((node) => node.id);
    const selected = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      basedOnBriefRevision: catalog.basedOnBriefRevision,
      basedOnGraphRevision: catalog.revision,
      nodes: catalog.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.roleId === "synthesizer"
          ? selectedIds.filter((candidate) => candidate !== node.id)
          : [],
        reasonCodes: [...node.reasonCodes],
      })),
    });
    current = update(current, {
      kind: "commit_graph_selection",
      proposal: {
        schema: "atlcli.research-graph-proposal/v1",
        basedOnBriefRevision: catalog.basedOnBriefRevision,
        basedOnGraphRevision: catalog.revision,
        nodes: selected.nodes.map((node) => ({
          nodeId: node.id,
          dependencies: [...node.dependencies],
          reasonCodes: [...node.reasonCodes],
        })),
      },
    }, "2026-08-01T09:00:05.000Z");
    const active = current.turns[0]!.graph!;
    const revised = reviseResearchGraphSelectionV1(catalog, active, {
      schema: RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1,
      basedOnBriefRevision: active.basedOnBriefRevision,
      basedOnGraphRevision: active.revision,
      nodes: catalog.nodes.filter((node) => [
        ...selectedIds,
        "research-node:cross-product-join",
      ].includes(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.roleId === "synthesizer"
          ? [
              ...selectedIds.filter((candidate) => candidate !== node.id),
              "research-node:cross-product-join",
            ]
          : node.id === "research-node:cross-product-join"
            ? selectedIds.filter((candidate) => candidate !== "research-node:synthesizer")
            : [],
        reasonCodes: [...node.reasonCodes],
        priority: node.priority,
      })),
      prune: [],
    });
    current = update(current, {
      kind: "apply_graph_revision",
      graph: revised,
      evidenceIds: ["evidence:wave-one"],
      gapIds: ["gap:coverage-one"],
      reason: "coverage_gap",
    }, "2026-08-01T09:00:06.000Z");

    expect(current.turns[0]!.graph).toMatchObject({ revision: active.revision + 1 });
    expect(current.turns[0]!.graphRevisions).toEqual([
      expect.objectContaining({ graph: expect.objectContaining({ revision: active.revision }) }),
      expect.objectContaining({
        graph: expect.objectContaining({ revision: active.revision + 1 }),
        evidenceIds: ["evidence:wave-one"],
        gapIds: ["gap:coverage-one"],
        reason: "coverage_gap",
      }),
    ]);
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
    expect(current).toMatchObject({
      status: "pause_requested",
      lease: { expiresAt: "2026-08-01T09:00:03.000Z" },
    });
    current = update(current, { kind: "acknowledge_pause" }, "2026-08-01T09:00:06.000Z");
    expect(current).toMatchObject({
      status: "paused",
      lease: { expiresAt: "2026-08-01T09:00:06.000Z" },
    });
    expect(current.turns[0]!.pausedAt).toBe("2026-08-01T09:00:06.000Z");
  });

  test("atomically materializes all clarification answers before a graph can be proposed", () => {
    const waitingBrief = createResearchBriefV1({
      ...brief(),
      clarificationQuestions: [{
        id: "clarification:window",
        prompt: "Which reporting window should be used?",
        required: true,
      }],
      assumptions: [{
        id: "assumption:archive",
        text: "Include archived items.",
        requiresUserDecision: true,
        status: "proposed",
      }],
    });
    let current = session();
    current = update(current, { kind: "create_turn", turnId: waitingBrief.turnId }, "2026-08-01T09:00:01.000Z");
    current = update(current, { kind: "record_brief", brief: waitingBrief }, "2026-08-01T09:00:02.000Z");

    expect(() => update(current, {
      kind: "resolve_clarifications",
      briefRevision: waitingBrief.revision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [],
    }, "2026-08-01T09:00:03.000Z")).toThrow("incomplete");

    current = update(current, {
      kind: "resolve_clarifications",
      briefRevision: waitingBrief.revision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [{ assumptionId: "assumption:archive", decision: "rejected" }],
    }, "2026-08-01T09:00:04.000Z");

    expect(current).toMatchObject({
      status: "planning",
      turns: [{
        brief: {
          revision: 2,
          clarificationResponses: [{ questionId: "clarification:window", response: "Use the latest week." }],
          assumptions: [{ id: "assumption:archive", status: "rejected" }],
        },
      }],
    });
    expect(current.turns[0]!.clarifications).toHaveLength(1);
    expect(current.turns[0]!.assumptionDecisions).toHaveLength(1);
  });

  test("releases every persisted user wait without weakening its revision fence", () => {
    const waitingBrief = createResearchBriefV1({
      ...brief(),
      clarificationQuestions: [{
        id: "clarification:scope",
        prompt: "Which exact project should be searched?",
        required: true,
      }],
    });
    let clarification = session();
    clarification = update(clarification, { kind: "create_turn", turnId: waitingBrief.turnId }, "2026-08-01T09:00:01.000Z");
    clarification = update(clarification, { kind: "record_brief", brief: waitingBrief }, "2026-08-01T09:00:02.000Z");
    expect(clarification).toMatchObject({
      status: "waiting_clarification",
      revision: 3,
      lease: { expiresAt: "2026-08-01T09:00:02.000Z" },
    });
    expect(() => reduceResearchSessionV1(clarification, {
      kind: "cancel",
      expectedRevision: 2,
      expectedLeaseEpoch: clarification.lease.epoch,
      at: "2026-08-01T09:00:03.000Z",
    })).toThrow("revision is stale");

    let plan = session();
    plan = update(plan, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T09:00:01.000Z");
    const acceptedBrief = brief();
    plan = update(plan, { kind: "record_brief", brief: acceptedBrief }, "2026-08-01T09:00:02.000Z");
    plan = update(plan, { kind: "propose_graph", graph: composeResearchGraphV1(acceptedBrief) }, "2026-08-01T09:00:03.000Z");
    expect(plan).toMatchObject({
      status: "waiting_plan_approval",
      lease: { expiresAt: "2026-08-01T09:00:03.000Z" },
    });
    const graph = plan.turns[0]!.graph!;
    plan = update(plan, { kind: "reject_plan", graphRevision: graph.revision, reason: "Needs scope review." }, "2026-08-01T09:00:04.000Z");
    expect(plan).toMatchObject({
      status: "waiting_plan_revision",
      lease: { expiresAt: "2026-08-01T09:00:04.000Z" },
    });

    const pausedSteering = settledPausedSteeringCheckpoint();
    let steering = pausedSteering.current;
    const steeringGraph = steering.turns[0]!.graph!;
    steering = update(steering, {
      kind: "request_steering",
      steeringId: "steering:focus-links",
      basedOnGraphRevision: steeringGraph.revision,
      request: "Prioritize exact linked Jira and Confluence items.",
    }, "2026-08-01T09:00:05.000Z");
    expect(steering).toMatchObject({
      status: "waiting_steering",
      lease: { expiresAt: "2026-08-01T09:00:05.000Z" },
    });
    expect(steering.turns[0]!.steering).toEqual([
      expect.objectContaining({
        id: "steering:focus-links",
        basedOnGraphRevision: steeringGraph.revision,
        state: "requested",
      }),
    ]);

    let scope = readyToRun(brief({ scopeCandidates: [scopeCandidate()] }));
    const scopeTurn = scope.turns[0]!;
    scope = update(scope, {
      kind: "propose_scope_expansion",
      proposal: createResearchScopeExpansionProposalV1({
        id: "scope-expansion:related-space",
        sessionId: scope.sessionId,
        turnId: scopeTurn.id,
        basedOnBriefRevision: scopeTurn.brief!.revision,
        basedOnGraphRevision: scopeTurn.graph!.revision,
        candidateId: "research-scope-candidate:confluence-space-related",
        expansionKind: "whole_scope",
        reason: "A retained link targets a related approved space.",
        provenanceRefs: ["source:wiki-related"],
        status: "proposed",
      }),
    }, "2026-08-01T09:00:06.000Z");
    expect(scope).toMatchObject({
      status: "waiting_scope_approval",
      lease: { expiresAt: "2026-08-01T09:00:06.000Z" },
    });
  });

  test("applies one user steering graph diff atomically at its resumed checkpoint", () => {
    const checkpoint = settledPausedSteeringCheckpoint();
    let current = update(checkpoint.current, {
      kind: "request_steering",
      steeringId: "steering:prioritize-join",
      basedOnGraphRevision: checkpoint.current.turns[0]!.graph!.revision,
      request: "Prioritize the approved cross-product relationship analysis.",
    }, "2026-08-01T09:00:05.200Z");
    current = update(current, { kind: "resume" }, "2026-08-01T09:00:05.300Z");
    const active = current.turns[0]!.graph!;
    const revised = reviseResearchGraphSelectionV1(checkpoint.catalog, active, {
      schema: RESEARCH_GRAPH_REVISION_PROPOSAL_SCHEMA_V1,
      basedOnBriefRevision: active.basedOnBriefRevision,
      basedOnGraphRevision: active.revision,
      nodes: active.nodes.map((node) => ({
        nodeId: node.id,
        dependencies: [...node.dependencies],
        reasonCodes: [...node.reasonCodes],
        priority: node.id === "research-node:cross-product-join" ? 100 : node.priority,
      })),
      prune: [],
    });
    current = update(current, {
      kind: "apply_graph_revision",
      graph: revised,
      evidenceIds: [],
      gapIds: [],
      reason: "user_steering",
      steeringId: "steering:prioritize-join",
    }, "2026-08-01T09:00:05.400Z");

    const turn = current.turns[0]!;
    expect(current.status).toBe("running");
    expect(turn.graph).toMatchObject({ revision: active.revision + 1 });
    expect(turn.steering).toEqual([expect.objectContaining({
      id: "steering:prioritize-join",
      state: "applied",
      appliedGraphRevision: active.revision + 1,
      planDiff: expect.objectContaining({
        reprioritizedNodeIds: ["research-node:cross-product-join"],
        exceededApprovalEnvelopeFields: [],
      }),
    })]);
    expect(turn.graphRevisions?.at(-1)).toMatchObject({
      reason: "user_steering",
      steeringId: "steering:prioritize-join",
      graph: { revision: active.revision + 1 },
      planDiff: expect.objectContaining({ exceededApprovalEnvelopeFields: [] }),
    });
  });

  test("widens a discovered whole scope only through a replacement graph and renewed approval", () => {
    const candidate = scopeCandidate({
      id: "research-scope-candidate:jira-project-other",
      product: "jira",
      entityKind: "project",
      entityRef: "research-scope-entity:jira-project-other",
      key: "OTHER",
      name: "Other delivery work",
    });
    let current = readyToRun(brief({
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      sourceClasses: ["jira"],
      scopeCandidates: [candidate],
    }));
    const initialTurn = current.turns[0]!;
    current = update(current, {
      kind: "propose_scope_expansion",
      proposal: createResearchScopeExpansionProposalV1({
        id: "scope-expansion:other-project",
        sessionId: current.sessionId,
        turnId: initialTurn.id,
        basedOnBriefRevision: initialTurn.brief!.revision,
        basedOnGraphRevision: initialTurn.graph!.revision,
        candidateId: candidate.id,
        expansionKind: "whole_scope",
        reason: "A cited link requires a project-level follow-up.",
        provenanceRefs: ["source:related-project"],
        status: "proposed",
      }),
    }, "2026-08-01T09:00:05.000Z");
    const binding = {
      schema: "atlcli.research-scope-binding/v1" as const,
      id: "scope-binding:research-scope-candidate:jira-project-other",
      tenantOrigin: candidate.tenantOrigin,
      product: candidate.product,
      entityKind: candidate.entityKind,
      entityRef: candidate.entityRef,
      key: candidate.key,
      name: candidate.name,
      source: "research_discovery" as const,
      authority: "approved" as const,
      candidateId: candidate.id,
      approvedAt: "2026-08-01T09:00:06.000Z",
    };
    const revisedBrief = approveResearchBriefWholeScopeExpansionV1({
      brief: initialTurn.brief!,
      binding,
    });
    current = update(current, {
      kind: "approve_scope_expansion",
      proposalId: "scope-expansion:other-project",
      binding,
      replacementGraph: composeResearchGraphV1(revisedBrief, { graphRevision: 2 }),
    }, "2026-08-01T09:00:06.000Z");

    expect(current).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, scope: { jiraProjectKeys: ["DEMO", "OTHER"] } },
        graph: { revision: 2, status: "proposed" },
        scopeRevisions: [{
          id: "scope-revision:other-project",
          state: "proposed",
          basedOnGraphRevision: 1,
          proposedGraphRevision: 2,
          revisedBriefRevision: 2,
          planDiff: {
            requiresApproval: true,
            scopeFingerprintChanged: true,
            addedScopeBindingIds: ["scope-binding:research-scope-candidate:jira-project-other"],
          },
        }],
      }],
    });
    current = update(current, { kind: "approve_graph", graphRevision: 2 }, "2026-08-01T09:00:07.000Z");
    expect(current).toMatchObject({
      status: "running",
      turns: [{ graph: { revision: 2, status: "approved" }, scopeRevisions: [{
        state: "approved",
        approvedAt: "2026-08-01T09:00:07.000Z",
      }] }],
    });
  });

  test("retains an approved exact discovered entity without widening the brief scope", () => {
    const candidate = scopeCandidate({
      id: "research-scope-candidate:confluence-page-linked",
      entityKind: "page",
      entityRef: "research-scope-entity:confluence-page-linked",
      key: undefined,
      name: "Linked page",
    });
    let current = readyToRun(brief({ scopeCandidates: [candidate] }));
    const initialTurn = current.turns[0]!;
    current = update(current, {
      kind: "propose_scope_expansion",
      proposal: createResearchScopeExpansionProposalV1({
        id: "scope-expansion:linked-page",
        sessionId: current.sessionId,
        turnId: initialTurn.id,
        basedOnBriefRevision: initialTurn.brief!.revision,
        basedOnGraphRevision: initialTurn.graph!.revision,
        candidateId: candidate.id,
        expansionKind: "exact_entity",
        reason: "A retained link names one page outside the selected space.",
        provenanceRefs: ["source:linked-page"],
        status: "proposed",
      }),
    }, "2026-08-01T09:00:05.000Z");
    current = update(current, {
      kind: "approve_scope_expansion",
      proposalId: "scope-expansion:linked-page",
      binding: {
        schema: "atlcli.research-scope-binding/v1",
        id: "scope-binding:research-scope-candidate:confluence-page-linked",
        tenantOrigin: candidate.tenantOrigin,
        product: candidate.product,
        entityKind: candidate.entityKind,
        entityRef: candidate.entityRef,
        name: candidate.name,
        source: "research_discovery",
        authority: "approved",
        candidateId: candidate.id,
        approvedAt: "2026-08-01T09:00:06.000Z",
      },
    }, "2026-08-01T09:00:06.000Z");

    expect(current).toMatchObject({
      status: "running",
      turns: [{
        brief: { revision: 1, scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCS"] } },
        scopeBindings: [{ entityKind: "page", authority: "approved" }],
        scopeRevisions: [],
      }],
    });
  });

  test("requires a rejected graph and durable correction before staging the next plan revision", () => {
    let current = session();
    current = update(current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T10:00:01.000Z");
    const originalBrief = brief();
    current = update(current, { kind: "record_brief", brief: originalBrief }, "2026-08-01T10:00:02.000Z");
    const firstGraph = composeResearchGraphV1(originalBrief);
    current = update(current, { kind: "propose_graph", graph: firstGraph }, "2026-08-01T10:00:03.000Z");
    current = update(current, {
      kind: "reject_plan",
      graphRevision: firstGraph.revision,
      reason: "Show exact links separately from inferred relationships.",
    }, "2026-08-01T10:00:04.000Z");

    expect(current).toMatchObject({
      status: "waiting_plan_revision",
      turns: [{
        planRevisions: [{
          basedOnBriefRevision: 1,
          basedOnGraphRevision: 1,
          state: "rejected",
          rejectionReason: "Show exact links separately from inferred relationships.",
        }],
      }],
    });
    const invalidRevision = composeResearchGraphV1(originalBrief, { graphRevision: 2 });
    expect(() => update(current, { kind: "revise_graph", graph: invalidRevision }, "2026-08-01T10:00:05.000Z"))
      .toThrow("cannot transition");

    current = update(current, {
      kind: "request_plan_revision",
      graphRevision: 1,
      instruction: "Show exact links separately from inferred relationships.",
    }, "2026-08-01T10:00:06.000Z");
    const revisedBrief = current.turns[0]!.brief!;
    expect(current).toMatchObject({
      status: "planning",
      turns: [{
        brief: { revision: 2, planRevisionInstructions: [{ basedOnGraphRevision: 1 }] },
        planRevisions: [{ state: "revision_requested", revisedBriefRevision: 2 }],
      }],
    });
    expect(revisedBrief.scope).toEqual(originalBrief.scope);
    expect(revisedBrief.limits).toEqual(originalBrief.limits);

    const revisedGraph = composeResearchGraphV1(revisedBrief, { graphRevision: 2 });
    current = update(current, { kind: "revise_graph", graph: revisedGraph }, "2026-08-01T10:00:07.000Z");
    expect(current).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        graph: { revision: 2, basedOnBriefRevision: 2, status: "proposed" },
        planRevisions: [{ state: "proposed", proposedGraphRevision: 2 }],
      }],
    });
    current = update(current, { kind: "approve_graph", graphRevision: 2 }, "2026-08-01T10:00:08.000Z");
    expect(current).toMatchObject({
      status: "running",
      turns: [{ planRevisions: [{ state: "approved", approvedAt: "2026-08-01T10:00:08.000Z" }] }],
    });
  });

  test("releases durable authentication and quota waits before a fresh owner recovers it", () => {
    let current = readyToRun();
    current = update(current, { kind: "wait_authentication" }, "2026-08-01T09:00:05.000Z");
    expect(current).toMatchObject({
      status: "waiting_authentication",
      lease: { epoch: 1, expiresAt: "2026-08-01T09:00:05.000Z" },
    });
    current = update(current, {
      kind: "recover",
      ownerId: "owner:resumed",
      expiresAt: "2026-08-01T09:10:00.000Z",
    }, "2026-08-01T09:00:05.001Z");
    current = update(current, { kind: "resume" }, "2026-08-01T09:00:05.002Z");
    expect(current).toMatchObject({
      status: "running",
      lease: { epoch: 2, ownerId: "owner:resumed" },
    });

    let quota = readyToRun();
    quota = update(quota, { kind: "wait_quota" }, "2026-08-01T09:00:05.000Z");
    expect(quota).toMatchObject({
      status: "waiting_quota",
      lease: { epoch: 1, expiresAt: "2026-08-01T09:00:05.000Z" },
    });
  });
});
