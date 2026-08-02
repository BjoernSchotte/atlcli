import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import {
  RESEARCH_ONE_SHOT_REQUEST_PATH_V1,
  RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1,
  ResearchSessionDispatchJournalV1,
  InMemoryResearchSessionStoreV1,
  assessResearchRetrievalV1,
  createMemoryResearchWorkspace,
  createResearchBriefV1,
  createResearchSessionV1,
  encodeResearchTaskDescriptionV1,
  initializeResearchSessionTurnV1,
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
} from "./index.js";
import { runResearchAgent as runBrowserResearchAgent } from "./agent-runtime.browser.js";
import { runResearchAgent as runNodeResearchAgent } from "./agent-runtime.node.js";
import {
  composeResearchGraphV1,
} from "./graph.js";
import {
  RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
  RESEARCH_CRITIQUE_SCHEMA_V1,
  RESEARCH_WORKER_PACKET_SCHEMA_V1,
  researchSubagentTypeForNodeV1,
  researchTaskIdForNodeV1,
} from "./dynamic-subagents.js";

const request = normalizeResearchRequestV1({
  schema: "atlcli.research-request/v1",
  question: "How does bounded synthetic Jira work relate to Confluence content?",
  scope: {
    siteOrigin: "https://synthetic.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  wikiProvider: "rest",
});

const graph = composeResearchGraphV1(createResearchBriefV1({
  sessionId: "research-session:host-parity",
  turnId: "research-turn:host-parity",
  objective: request.question,
  scope: request.scope,
  sourceClasses: ["jira", "confluence"],
  asOf: "2026-07-31T12:00:00.000Z",
  timezone: "UTC",
  requestedEffort: "deep",
  requestedPlanApproval: "automatic",
  requestedReconciliation: "auto",
}));
const jiraNode = graph.nodes.find((node) => node.id === "research-node:jira-research")!;
const wikiNode = graph.nodes.find((node) => node.id === "research-node:wiki-research")!;
const joinNode = graph.nodes.find((node) => node.id === "research-node:cross-product-join")!;
const coverageNode = graph.nodes.find((node) => node.id === "research-node:coverage-moderation")!;
const reconciliationNode = graph.nodes.find((node) => node.roleId === "reconciler")!;
const synthesizerNode = graph.nodes.find((node) => node.roleId === "synthesizer")!;

const draft = {
  title: "Cross-host synthetic report",
  executiveSummary: "No source evidence was supplied to this parity run.",
  selectedClaimIds: [],
  findings: [],
  relationships: [],
  limitations: ["Synthetic host-parity scenario."],
};

const emptyPacket = (answeredQuestion: string) => ({
  schema: "atlcli.research-packet-body/v1",
  answeredQuestion,
  sourceIds: [],
  findingCandidates: [],
  relationshipCandidates: [],
  gaps: [],
  proposedFollowUps: [],
  coverageLimits: ["Synthetic host-parity scenario."],
});

const critique = {
  schema: "atlcli.reconciliation-body/v1",
  defects: [{
    id: "defect:host-parity-coverage",
    severity: "important",
    target: { kind: "coverage", id: "coverage:primary-question" },
    code: "missing_coverage",
    references: [],
    explanation: "The synthetic host-parity scenario contains no source evidence.",
    suggestedAction: "abstain",
  }],
  proposedFollowUps: [],
};

function model() {
  const selectedNodeIds = new Set(graph.nodes
    .filter((node) => node.kind !== "repair")
    .map((node) => node.id));
  const proposal = {
    basedOnBriefRevision: graph.basedOnBriefRevision,
    basedOnGraphRevision: graph.revision,
    nodes: graph.nodes.filter((node) => selectedNodeIds.has(node.id)).map((node) => ({
      nodeId: node.id,
      dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
      reasonCodes: [node.reasonCodes[0]!],
    })),
  };
  const taskId = (node: typeof jiraNode) => researchTaskIdForNodeV1(graph, node);
  const subagentType = (node: typeof jiraNode) => researchSubagentTypeForNodeV1(node);
  const code = `
    const acceptedGraph = JSON.parse(await tools.researchGraphPropose(${JSON.stringify(proposal)}));
    const packets = await Promise.all([
      task({
        description: ${JSON.stringify(encodeResearchTaskDescriptionV1({
          taskId: taskId(jiraNode),
          objective: jiraNode.objective,
        }))},
        subagentType: ${JSON.stringify(subagentType(jiraNode))},
        responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
      }),
      task({
        description: ${JSON.stringify(encodeResearchTaskDescriptionV1({
          taskId: taskId(wikiNode),
          objective: wikiNode.objective,
        }))},
        subagentType: ${JSON.stringify(subagentType(wikiNode))},
        responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
      })
    ]);
    const joined = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: ${JSON.stringify(taskId(joinNode))},
        objective: ${JSON.stringify(joinNode.objective)},
        dependencyResults: [
          { taskId: ${JSON.stringify(taskId(jiraNode))}, result: packets[0] },
          { taskId: ${JSON.stringify(taskId(wikiNode))}, result: packets[1] }
        ]
      }),
      subagentType: ${JSON.stringify(subagentType(joinNode))},
      responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)}
    });
    const coverage = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: ${JSON.stringify(taskId(coverageNode))},
        objective: ${JSON.stringify(coverageNode.objective)},
        dependencyResults: [
          { taskId: ${JSON.stringify(taskId(jiraNode))}, result: packets[0] },
          { taskId: ${JSON.stringify(taskId(wikiNode))}, result: packets[1] },
          { taskId: ${JSON.stringify(taskId(joinNode))}, result: joined }
        ]
      }),
      subagentType: ${JSON.stringify(subagentType(coverageNode))},
      responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)}
    });
    const critique = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: ${JSON.stringify(taskId(reconciliationNode))},
        objective: ${JSON.stringify(reconciliationNode.objective)},
        dependencyResults: [
          { taskId: ${JSON.stringify(taskId(jiraNode))}, result: packets[0] },
          { taskId: ${JSON.stringify(taskId(wikiNode))}, result: packets[1] },
          { taskId: ${JSON.stringify(taskId(joinNode))}, result: joined },
          { taskId: ${JSON.stringify(taskId(coverageNode))}, result: coverage }
        ]
      }),
      subagentType: ${JSON.stringify(subagentType(reconciliationNode))},
      responseSchema: ${JSON.stringify(RESEARCH_CRITIQUE_SCHEMA_V1)}
    });
    JSON.parse(await tools.researchReconciliationDispositions({
      basedOnGraphRevision: ${graph.revision},
      reconciliationTaskId: ${JSON.stringify(taskId(reconciliationNode))},
      decisions: [{
        defectId: "defect:host-parity-coverage",
        decision: "abstain",
        reasonCode: "material_defect"
      }]
    }));
    const finalDraft = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: ${JSON.stringify(taskId(synthesizerNode))},
        objective: ${JSON.stringify(synthesizerNode.objective)},
        dependencyResults: [
          { taskId: ${JSON.stringify(taskId(jiraNode))}, result: packets[0] },
          { taskId: ${JSON.stringify(taskId(wikiNode))}, result: packets[1] },
          { taskId: ${JSON.stringify(taskId(joinNode))}, result: joined },
          { taskId: ${JSON.stringify(taskId(coverageNode))}, result: coverage },
          { taskId: ${JSON.stringify(taskId(reconciliationNode))}, result: critique }
        ]
      }),
      subagentType: ${JSON.stringify(researchSubagentTypeForNodeV1(synthesizerNode))},
      responseSchema: ${JSON.stringify(RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1)}
    });
    finalDraft;
  `;
  return fakeModel()
    .respondWithTools([{ name: "eval", args: { code } }])
    .respondWithTools([{ name: "AtlcliDynamicResearchAgentDraftV1", args: draft }]);
}

function subagentModels() {
  const packetModel = (answeredQuestion: string) => fakeModel()
    .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket(answeredQuestion) }]);
  return {
    [jiraNode.id]: packetModel("Jira branch"),
    [wikiNode.id]: packetModel("Confluence branch"),
    [joinNode.id]: packetModel("Joined branch"),
    [coverageNode.id]: packetModel("Coverage branch"),
    [reconciliationNode.id]: fakeModel()
      .respondWithTools([{ name: "ReconciliationBodyV1", args: critique }]),
    [synthesizerNode.id]: fakeModel()
      .respondWithTools([{ name: "AtlcliDynamicResearchAgentDraftV1", args: draft }]),
  };
}

const providers = {
  jira: {
    async searchPage() { return { items: [] }; },
    async getIssue() { throw new Error("not reached"); },
  },
  wiki: {
    async searchPage() { return { items: [] }; },
    async getPage() { throw new Error("not reached"); },
  },
};

describe("research one-shot host parity", () => {
  test("produces schema-equivalent reports and byte-identical Markdown in Node and browser runtimes", async () => {
    const nodeWorkspace = createMemoryResearchWorkspace();
    const browserWorkspace = createMemoryResearchWorkspace();
    const nodeEvents: ResearchOneShotEventV1[] = [];
    const browserEvents: ResearchOneShotEventV1[] = [];
    const common = {
      request,
      providers,
      researchGraph: graph,
      runId: "host-parity",
      now: () => Date.parse("2026-07-31T12:00:00.000Z"),
    };

    const [nodeReport, browserReport] = await Promise.all([
      runNodeResearchAgent({
        ...common,
        model: model(),
        subagentModelsByNode: subagentModels(),
        workspace: nodeWorkspace,
        options: { onEvent: (event) => nodeEvents.push(event) },
      }),
      runBrowserResearchAgent({
        ...common,
        model: model(),
        subagentModelsByNode: subagentModels(),
        workspace: browserWorkspace,
        options: { onEvent: (event) => browserEvents.push(event) },
      }),
    ]);
    expect(nodeReport).toEqual(browserReport);
    expect(new TextEncoder().encode(nodeReport.markdown)).toEqual(
      new TextEncoder().encode(browserReport.markdown),
    );
    expect(await nodeWorkspace.readFile("/artifacts/report.md")).toBe(nodeReport.markdown);
    expect(await browserWorkspace.readFile("/artifacts/report.md")).toBe(browserReport.markdown);
    expect(await nodeWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1)).toBe(
      await browserWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1),
    );
    expect(JSON.parse((await nodeWorkspace.readFile(RESEARCH_ONE_SHOT_REQUEST_PATH_V1))!)).toEqual({
      runId: "host-parity",
      request,
    });
    expect(nodeEvents).toEqual(browserEvents);
    expect(nodeEvents.map((event) => event.seq)).toEqual(
      nodeEvents.map((_, index) => index + 1),
    );
    expect(nodeEvents).toContainEqual(expect.objectContaining({
      kind: "artifact",
      path: "/artifacts/report.md",
    }));
    expect(nodeEvents).toContainEqual(expect.objectContaining({
      kind: "reconciliation_disposition",
      defectId: "defect:host-parity-coverage",
      decision: "abstain",
      reasonCode: "material_defect",
    }));
    expect(JSON.stringify(nodeEvents)).not.toMatch(/question|sourceBody|cursor|credential|prompt/i);
  });
});

const resumedRequest = normalizeResearchRequestV1({
  schema: "atlcli.research-request/v1",
  question: "How does a recovered synthetic Jira branch relate to a recovered Confluence branch?",
  scope: {
    siteOrigin: "https://synthetic.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  wikiProvider: "rest",
});

const resumedDraft = {
  title: "Recovered cross-host synthetic report",
  executiveSummary: "The recovered branches contain no source evidence.",
  selectedClaimIds: [],
  findings: [],
  relationships: [],
  limitations: ["Synthetic resumed host-parity scenario."],
};

const resumedCritique = {
  schema: "atlcli.reconciliation-body/v1",
  defects: [{
    id: "defect:resumed-host-parity-coverage",
    severity: "important",
    target: { kind: "coverage", id: "coverage:primary-question" },
    code: "missing_coverage",
    references: [],
    explanation: "The recovered synthetic scenario contains no source evidence.",
    suggestedAction: "abstain",
  }],
  proposedFollowUps: [],
};

function resumedPacket(answeredQuestion: string) {
  return emptyPacket(answeredQuestion);
}

async function createResumedRuntimeInput() {
  const sessionId = "research-session:host-resume-parity";
  const turnId = "research-turn:host-resume-parity";
  const at = "2026-07-31T12:00:00.000Z";
  const brief = createResearchBriefV1({
    sessionId,
    turnId,
    objective: resumedRequest.question,
    scope: resumedRequest.scope,
    asOf: at,
    timezone: "UTC",
    requestedEffort: "deep",
    requestedPlanApproval: "automatic",
    requestedReconciliation: "auto",
  });
  const initialGraph = composeResearchGraphV1(brief);
  const store = new InMemoryResearchSessionStoreV1();
  await initializeResearchSessionTurnV1({
    store,
    session: createResearchSessionV1({
      sessionId,
      ownerId: "owner:interrupted-host-parity",
      createdAt: at,
      leaseExpiresAt: "2026-07-31T12:10:00.000Z",
    }),
    brief,
    graph: initialGraph,
    approveAutomatically: true,
    at,
  });
  const journal = new ResearchSessionDispatchJournalV1({
    store,
    sessionId,
    turnId,
    now: () => at,
  });
  const selectedNodeIds = new Set(initialGraph.nodes
    .filter((node) => node.kind !== "repair")
    .map((node) => node.id));
  let graph = await journal.commitGraphSelection({
    schema: "atlcli.research-graph-proposal/v1",
    basedOnBriefRevision: initialGraph.basedOnBriefRevision,
    basedOnGraphRevision: initialGraph.revision,
    nodes: initialGraph.nodes
      .filter((node) => node.kind !== "repair")
      .map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
        reasonCodes: [...node.reasonCodes],
      })),
  });
  const initialNodes = [
    graph.nodes.find((node) => node.id === "research-node:jira-research"),
    graph.nodes.find((node) => node.id === "research-node:wiki-research"),
  ];
  if (initialNodes.some((node) => !node)) throw new Error("Expected two initial deep-research nodes.");
  for (const node of initialNodes) {
    const taskId = researchTaskIdForNodeV1(graph, node!);
    await journal.admitAndStart({
      schema: "atlcli.research-task-attempt/v1",
      taskId,
      nodeId: node!.id,
      graphRevision: graph.revision,
      attempt: 1,
      executor: node!.executor,
      ...(node!.roleId ? { roleId: node!.roleId } : {}),
      grantedCapabilityIds: [...node!.grantedCapabilityIds],
      typedIntentRefs: [...node!.typedIntentRefs],
      expectedOutputSchema: node!.outputSchema,
      budget: { ...node!.budget },
      status: "ready",
      dispatchState: "not_started",
      createdAt: at,
    });
    const body = resumedPacket(`${node!.id} completed before interruption.`);
    await journal.acceptPacket({
      taskId,
      graphRevision: graph.revision,
      body,
      usage: {
        capabilityCalls: 0,
        inputTokens: 1,
        outputTokens: 1,
        resultBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
        durationMs: 1,
        costMicros: 0,
      },
      availableSourceIds: [],
      maximumResultBytes: node!.budget.maxResultBytes,
      budgetState: {
        schema: "atlcli.research-run-budget/v1",
        ptcCalls: 0,
        httpAttempts: 0,
        responseBytes: 0,
        pages: { jira: 0, confluence: 0 },
        items: { jira: 0, confluence: 0 },
        details: { jira: 0, confluence: 0 },
      },
    });
  }
  const checkpoint = await journal.recordRetrievalAssessment({
    graphRevision: graph.revision,
    assessment: assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1"],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }, {
        product: "confluence",
        rankedSourceIds: ["wiki:1001"],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 1,
      httpAttemptsRemaining: 1,
    }),
    issueContinuation: true,
  });
  if (!checkpoint.continuation) throw new Error("Expected one durable continuation.");
  graph = checkpoint.graph;

  const supervisorCode = `
    const continuation = JSON.parse(await tools.researchRetrievalContinue({
      graphRevision: ${graph.revision},
      wave: ${checkpoint.wave},
      continuationId: ${JSON.stringify(checkpoint.continuation.id)}
    }));
    const responseSchemas = ${JSON.stringify({
      "atlcli.research-packet-body/v1": RESEARCH_WORKER_PACKET_SCHEMA_V1,
      "atlcli.reconciliation-body/v1": RESEARCH_CRITIQUE_SCHEMA_V1,
      "atlcli.research-agent-draft/v1": RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1,
    })};
    const joinFrontier = JSON.parse(await tools.researchReadyFrontier({ graphRevision: continuation.graphRevision }));
    const joinTask = joinFrontier.tasks[0];
    const joined = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: joinTask.taskId,
        objective: joinTask.objective,
        dependencyResults: joinTask.dependencyResults
      }),
      subagentType: joinTask.subagentType,
      responseSchema: responseSchemas[joinTask.outputSchema]
    });
    const coverageFrontier = JSON.parse(await tools.researchReadyFrontier({ graphRevision: continuation.graphRevision }));
    const coverageTask = coverageFrontier.tasks[0];
    const covered = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: coverageTask.taskId,
        objective: coverageTask.objective,
        dependencyResults: coverageTask.dependencyResults
      }),
      subagentType: coverageTask.subagentType,
      responseSchema: responseSchemas[coverageTask.outputSchema]
    });
    const reconciliationFrontier = JSON.parse(await tools.researchReadyFrontier({ graphRevision: continuation.graphRevision }));
    const critiqueTask = reconciliationFrontier.tasks[0];
    const critique = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: critiqueTask.taskId,
        objective: critiqueTask.objective,
        dependencyResults: critiqueTask.dependencyResults
      }),
      subagentType: critiqueTask.subagentType,
      responseSchema: responseSchemas[critiqueTask.outputSchema]
    });
    JSON.parse(await tools.researchReconciliationDispositions({
      basedOnGraphRevision: continuation.graphRevision,
      reconciliationTaskId: critiqueTask.taskId,
      decisions: [{
        defectId: "defect:resumed-host-parity-coverage",
        decision: "abstain",
        reasonCode: "material_defect"
      }]
    }));
    const synthesisFrontier = JSON.parse(await tools.researchReadyFrontier({ graphRevision: continuation.graphRevision }));
    const synthesisTask = synthesisFrontier.tasks[0];
    const finalDraft = await task({
      description: JSON.stringify({
        schema: "atlcli.research-task-dispatch/v1",
        taskId: synthesisTask.taskId,
        objective: synthesisTask.objective,
        dependencyResults: synthesisTask.dependencyResults
      }),
      subagentType: synthesisTask.subagentType,
      responseSchema: responseSchemas[synthesisTask.outputSchema]
    });
    finalDraft;
  `;
  const model = fakeModel()
    .respondWithTools([{ name: "eval", args: { code: supervisorCode } }])
    .respondWithTools([{ name: "AtlcliDynamicResearchAgentDraftV1", args: resumedDraft }]);
  const subagentModelsByNode = {
    ["research-node:cross-product-join"]: fakeModel().respondWithTools([{
      name: "ResearchPacketBodyV1",
      args: resumedPacket("Recovered join branch."),
    }]),
    ["research-node:coverage-moderation"]: fakeModel().respondWithTools([{
      name: "ResearchPacketBodyV1",
      args: resumedPacket("Recovered coverage branch."),
    }]),
    ["research-node:reconciler"]: fakeModel().respondWithTools([{
      name: "ReconciliationBodyV1",
      args: resumedCritique,
    }]),
    ["research-node:synthesizer"]: fakeModel().respondWithTools([{
      name: "AtlcliDynamicResearchAgentDraftV1",
      args: resumedDraft,
    }]),
  };
  return {
    request: resumedRequest,
    store,
    sessionId,
    turnId,
    brief,
    graph,
    model,
    subagentModelsByNode,
  };
}

describe("research durable recovery host parity", () => {
  test("resumes one journaled checkpoint to the same report and Markdown in Node and browser runtimes", async () => {
    const node = await createResumedRuntimeInput();
    const browser = await createResumedRuntimeInput();
    const nodeEvents: ResearchOneShotEventV1[] = [];
    const browserEvents: ResearchOneShotEventV1[] = [];
    const common = {
      request: resumedRequest,
      runId: "host-resume-parity",
      now: () => Date.parse("2026-07-31T12:00:00.000Z"),
      providers,
    };

    const [nodeReport, browserReport] = await Promise.all([
      runNodeResearchAgent({
        ...common,
        model: node.model,
        researchGraph: node.graph,
        brief: node.brief,
        durableSession: { store: node.store, sessionId: node.sessionId, turnId: node.turnId },
        subagentModelsByNode: node.subagentModelsByNode,
        options: { onEvent: (event) => nodeEvents.push(event) },
      }),
      runBrowserResearchAgent({
        ...common,
        model: browser.model,
        researchGraph: browser.graph,
        brief: browser.brief,
        durableSession: { store: browser.store, sessionId: browser.sessionId, turnId: browser.turnId },
        subagentModelsByNode: browser.subagentModelsByNode,
        options: { onEvent: (event) => browserEvents.push(event) },
      }),
    ]);

    expect(nodeReport).toEqual(browserReport);
    expect(new TextEncoder().encode(nodeReport.markdown)).toEqual(
      new TextEncoder().encode(browserReport.markdown),
    );
    expect(nodeEvents).toEqual(browserEvents);
    for (const runtime of [node, browser]) {
      const session = await runtime.store.read(runtime.sessionId);
      const turn = session?.turns.find((candidate) => candidate.id === runtime.turnId);
      expect(session?.status).toBe("complete");
      expect(turn?.retrievalAssessments?.[0]?.continuation).toMatchObject({ status: "consumed" });
      expect(turn?.acceptedPackets).toHaveLength(6);
      await expect(runtime.store.workspace(runtime.sessionId).then((workspace) =>
        workspace.readFile("/artifacts/report.md"),
      )).resolves.toBe(nodeReport.markdown);
    }
  });
});
