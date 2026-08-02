import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1, type ResearchGraphProposalV1 } from "./graph.js";
import { assessResearchRetrievalV1 } from "./retrieval-assessment.js";
import { initializeResearchSessionTurnV1 } from "./session-runtime.js";
import { ResearchSessionDispatchJournalV1 } from "./session-dispatch-journal.js";
import { InMemoryResearchSessionStoreV1 } from "./session-store.js";
import { createResearchSessionV1 } from "./session.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
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
    requestedReconciliation: "required",
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
  return {
    store,
    sessionId: session.sessionId,
    turnId: brief.turnId,
    journal,
    catalog,
    graph,
  };
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
    expectedOutputSchema: node.roleId === "reconciler"
      ? RESEARCH_RECONCILIATION_BODY_SCHEMA_V1
      : RESEARCH_PACKET_BODY_SCHEMA_V1,
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
    expect(packet.graph.nodes.find((candidate) => candidate.id === node.id)?.status).toBe("complete");
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

  test("marks a durable run failed when execution ends before report validation", async () => {
    const { store, sessionId, journal } = await initializedJournal();

    await expect(journal.fail()).resolves.toMatchObject({ status: "failed" });
    expect((await store.read(sessionId))?.turns[0]?.failureReason)
      .toBe("Research execution ended before report validation.");
  });

  test("records body-free retrieval assessments at contiguous settled-wave checkpoints", async () => {
    const { store, sessionId, turnId, journal, graph } = await initializedJournal();
    const assessment = assessResearchRetrievalV1({
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

    await expect(journal.recordRetrievalAssessment({
      graphRevision: graph.revision,
      assessment,
    })).resolves.toMatchObject({
      graphRevision: graph.revision,
      wave: 1,
      assessment: { action: assessment.action, reason: assessment.reason },
    });

    const stored = await store.read(sessionId);
    const turn = stored!.turns.find((candidate) => candidate.id === turnId)!;
    expect(turn.retrievalAssessments).toEqual([expect.objectContaining({
      graphRevision: graph.revision,
      wave: 1,
      assessment,
    })]);
    expect(turn.graph?.researchWavesCompleted).toBe(1);
    await expect(journal.recordRetrievalAssessment({
      graphRevision: graph.revision,
      assessment,
    })).rejects.toThrow("terminal decision");
    expect((await store.events(sessionId)).at(-1)?.kind).toBe("record_retrieval_assessment");
  });

  test("issues and atomically consumes one durable continuation for a non-terminal wave", async () => {
    const { store, sessionId, turnId, journal, graph } = await initializedJournal();
    const assessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1", "jira:DEMO-2"],
        detailedSourceIds: ["jira:DEMO-1"],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 2,
      httpAttemptsRemaining: 2,
    });
    expect(assessment).toMatchObject({ action: "continue", reason: "unread_ranked_candidates" });

    const issued = await journal.recordRetrievalAssessment({
      graphRevision: graph.revision,
      assessment,
      issueContinuation: true,
    });
    expect(issued.continuation).toMatchObject({
      id: `research-continuation:${graph.revision}.1`,
      status: "issued",
    });

    const resumedJournal = new ResearchSessionDispatchJournalV1({
      store,
      sessionId,
      turnId,
      now: () => "2026-08-01T16:01:00.000Z",
    });
    await expect(resumedJournal.consumeRetrievalContinuation({
      graphRevision: graph.revision,
      wave: issued.wave!,
      continuationId: issued.continuation!.id,
    })).resolves.toMatchObject({
      id: issued.continuation!.id,
      status: "consumed",
      graph: { researchWavesCompleted: 1 },
    });
    await expect(journal.consumeRetrievalContinuation({
      graphRevision: graph.revision,
      wave: issued.wave!,
      continuationId: issued.continuation!.id,
    })).rejects.toThrow("already consumed");

    const turn = (await store.read(sessionId))!.turns.find((candidate) => candidate.id === turnId)!;
    expect(turn.retrievalAssessments?.[0]?.continuation).toMatchObject({
      id: issued.continuation!.id,
      status: "consumed",
    });
    expect((await store.events(sessionId)).slice(-2).map((event) => event.kind)).toEqual([
      "record_retrieval_assessment",
      "consume_retrieval_continuation",
    ]);
  });

  test("commits every reconciliation disposition and the optional repair activation in one CAS event", async () => {
    const { store, sessionId, turnId, journal, catalog, graph } = await initializedJournal();
    const reconciliationNode = graph.nodes.find((node) => node.roleId === "reconciler")!;
    const repairNode = catalog.nodes.find((node) => node.kind === "repair")!;
    let reconciliationPacketRef = "";

    for (const node of graph.nodes.filter((candidate) => candidate.roleId !== "synthesizer")) {
      const attempt = attemptFor(graph, node.id);
      await journal.admitAndStart(attempt);
      const body = node.roleId === "reconciler"
        ? {
            schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
            defects: [{
              id: "defect:coverage-gap",
              severity: "important",
              target: { kind: "coverage", id: "coverage:question" },
              code: "missing_coverage",
              references: [],
              explanation: "One bounded coverage check remains.",
              suggestedAction: "add_follow_up",
            }],
            proposedFollowUps: [{
              id: "follow-up:coverage-gap",
              defectId: "defect:coverage-gap",
              objective: "Perform one bounded coverage check.",
              reasonCode: "coverage_gap",
              sourceIds: [],
            }],
          }
        : {
            schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
            answeredQuestion: "No further detail was available.",
            sourceIds: [],
            findingCandidates: [],
            relationshipCandidates: [],
            gaps: [],
            proposedFollowUps: [],
            coverageLimits: [],
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
      if (node.id === reconciliationNode.id) reconciliationPacketRef = packet.packetRef;
    }

    const recorded = await journal.recordReconciliation({
      dispositions: [{
        schema: "atlcli.reconciliation-disposition/v1",
        id: "reconciliation-disposition:r1:1",
        reconciliationPacketRef,
        defectId: "defect:coverage-gap",
        basedOnGraphRevision: graph.revision,
        decision: "add_follow_up",
        reasonCode: "material_defect",
        resultingGraphRevision: graph.revision,
        resultingNodeId: repairNode.id,
        resultingClaimIds: [],
        recordedAt: "2026-08-01T16:02:00.000Z",
      }],
      repair: {
        nodeId: repairNode.id,
        reconciliationTaskId: `task:dispatch-${reconciliationNode.id.replace("research-node:", "")}`,
        followUpId: "follow-up:coverage-gap",
      },
    });

    expect(recorded.dispositions).toHaveLength(1);
    expect(recorded.repairAuthorization).toMatchObject({
      nodeId: repairNode.id,
      reconciliationTaskId: `task:dispatch-${reconciliationNode.id.replace("research-node:", "")}`,
      followUp: { id: "follow-up:coverage-gap" },
    });
    expect(recorded.graph.nodes.find((node) => node.id === repairNode.id)).toMatchObject({
      status: "ready",
      dependencies: [reconciliationNode.id],
    });
    expect(recorded.graph.nodes.find((node) => node.roleId === "synthesizer")).toMatchObject({
      status: "blocked",
      dependencies: expect.arrayContaining([repairNode.id]),
    });

    const stored = await store.read(sessionId);
    const turn = stored!.turns.find((candidate) => candidate.id === turnId)!;
    expect(turn).toMatchObject({
      reconciliationCommittedAt: expect.any(String),
      repairAuthorization: { nodeId: repairNode.id },
    });
    expect(turn.latentRepairNode).toBeUndefined();
    expect((await store.events(sessionId)).at(-1)?.kind).toBe("record_reconciliation");
  });
});
