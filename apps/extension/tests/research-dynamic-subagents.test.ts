import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { fakeModel } from "@langchain/core/testing";
import { tool } from "@langchain/core/tools";
import { ReplSession, validateResponseSchema } from "@langchain/quickjs";
import {
  RESEARCH_GRAPH_SCHEMA_V1,
  acceptResearchGraphProposalV1,
  composeResearchGraphV1,
  composeStandardResearchGraphV1,
  type ResearchBriefV1,
  type ResearchGraphNodeV1,
  type ResearchGraphV1,
} from "@atlcli/research/graph";
import {
  ResearchCapabilityBroker,
  RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
  createResearchBriefV1,
  encodeResearchTaskDescriptionV1,
  projectResearchReconciliationInputV1,
  type ResearchAcceptedPacketV1,
  type ResearchOneShotEventV1,
} from "@atlcli/research";
import {
  RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
} from "@atlcli/research";
import {
  buildDynamicSupervisorPrompt,
  createResearchGraphProposalPtcTool,
  createResearchReconciliationDispositionPtcTool,
  researchRecursionLimitV1,
  runResearchAgent,
} from "@atlcli/research/browser/agent";
import { runResearchAgent as runNodeResearchAgent } from "@atlcli/research/node";
import {
  RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
  RESEARCH_CRITIQUE_SCHEMA_V1,
  RESEARCH_WORKER_PACKET_SCHEMA_V1,
  buildResearchAcquisitionProgram,
  compileDynamicResearchSubagents,
  createBoundedResearchSubagentMiddleware,
  createResearchNodePtcToolsV1,
  providerCompatibleResearchSchema,
  researchPtcToolNamesForNodeV1,
  researchSubagentTypeForNodeV1,
  researchTaskIdForNodeV1,
  responseSchemaForResearchRole,
} from "@atlcli/research/browser/agent";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { createMemoryResearchWorkspace } from "@atlcli/research";
import { ResearchScopeCatalogBroker } from "@atlcli/research/scope-catalog-broker";
import { z } from "zod/v4";

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "Which Confluence content relates to Jira tickets?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

const broker = new ResearchCapabilityBroker(request, {
  jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
  wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
});

const model = {
  invoke: async () => undefined,
} as unknown as BaseChatModel;

function crossProductGraph() {
  return composeResearchGraphV1(graphBrief(request.question, ["jira", "confluence"], "deep"));
}

function graphBrief(
  objective: string,
  sourceClasses: ("jira" | "confluence")[],
  requestedEffort: "lookup" | "analysis" | "deep" = "analysis",
  requestedReconciliation: "off" | "auto" | "required" = "auto",
): ResearchBriefV1 {
  return createResearchBriefV1({
    sessionId: "research-session:extension-test",
    turnId: "research-turn:extension-test",
    objective,
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: sourceClasses.includes("jira") ? ["DEMO"] : [],
      confluenceSpaceKeys: sourceClasses.includes("confluence") ? ["KB"] : [],
    },
    sourceClasses,
    asOf: "2026-01-01T00:00:00.000Z",
    timezone: "UTC",
    requestedEffort,
    requestedPlanApproval: "automatic",
    requestedReconciliation,
  });
}

function synthesisOnlyGraph(): ResearchGraphV1 {
  const production = composeResearchGraphV1(graphBrief(
    "Get the exact bounded Jira item.",
    ["jira"],
    "lookup",
    "off",
  ));
  // Keep the isolated synthesis-admission fixtures intentionally body-free.
  // Productive lookup graphs use a focused researcher; these unit tests retain
  // one non-subagent predecessor solely to exercise synthesizer middleware.
  const nodes = production.nodes.map((node) => {
    if (node.id !== "research-node:jira-lookup") return node;
    const { roleId: _roleId, ...withoutRole } = node;
    return { ...withoutRole, executor: "ptc" as const };
  });
  return {
    ...production,
    nodes,
    roleDecisions: production.roleDecisions.map((decision) =>
      decision.roleId === "focused-researcher"
        ? { roleId: decision.roleId, decision: "omitted" as const, reasonCodes: ["not_applicable" as const] }
        : decision
    ),
  };
}

function jiraAndSynthesisGraph(): ResearchGraphV1 {
  return composeResearchGraphV1(graphBrief(
    "Analyze bounded Jira work.",
    ["jira"],
    "analysis",
    "off",
  ));
}

function taskEnvelope(
  graph: ResearchGraphV1,
  nodeId: string,
  dependencyResults?: Array<{ taskId: string; result: unknown }>,
): { description: string; subagentType: string } {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node?.roleId) throw new Error(`Missing subagent node: ${nodeId}`);
  return {
    description: encodeResearchTaskDescriptionV1({
      taskId: researchTaskIdForNodeV1(graph, node),
      objective: node.objective,
      ...(dependencyResults?.length ? { dependencyResults } : {}),
    }),
    subagentType: researchSubagentTypeForNodeV1(node),
  };
}

function graphProposalInput(
  graph: ResearchGraphV1,
  selectedNodeIds: readonly string[] = graph.nodes
    .filter((node) => node.kind !== "repair")
    .map((node) => node.id),
) {
  const selected = new Set(selectedNodeIds);
  return {
    basedOnBriefRevision: graph.basedOnBriefRevision,
    basedOnGraphRevision: graph.revision,
    nodes: graph.nodes
      .filter((node) => selected.has(node.id))
      .map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => selected.has(dependency)),
        reasonCodes: [node.reasonCodes[0]!],
      })),
  };
}

function graphProposalPrelude(
  graph: ResearchGraphV1,
  selectedNodeIds?: readonly string[],
): string {
  return `const acceptedGraph = JSON.parse(await tools.researchGraphPropose(${JSON.stringify(
    graphProposalInput(graph, selectedNodeIds),
  )}));`;
}

test("derives a bounded LangGraph super-step allowance from the admitted workflow", () => {
  expect(researchRecursionLimitV1()).toBe(24);
  expect(researchRecursionLimitV1(synthesisOnlyGraph())).toBe(40);
  expect(researchRecursionLimitV1(crossProductGraph())).toBe(70);
});

test("repairs one synthesizer schema failure and fails fast after the bounded retry", async () => {
  const graph = synthesisOnlyGraph();
  const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
  const validDraft = JSON.stringify({
    title: "Repaired",
    executiveSummary: "No supported relationship was found.",
    findings: [],
    relationships: [],
    limitations: ["No Jira detail evidence was retrieved."],
  });
  const diagnostics: string[] = [];
  let invokes = 0;
  let fatal: unknown;
  const upstreamTask = tool(async () => {
    invokes += 1;
    if (invokes === 1) throw new Error("Failed to parse structured output for response schema.");
    return validDraft;
  }, {
    name: "task",
    description: "Synthetic upstream task.",
    schema: z.object({
      description: z.string(),
      subagent_type: z.string(),
    }),
  });
  const middleware = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    [{
      name: "synthesizer",
      description: "Synthetic synthesizer.",
      systemPrompt: "Return a draft.",
      tools: [],
    }],
    {
      createSubAgentMiddleware: (() => ({
        name: "subAgentMiddleware",
        tools: [upstreamTask],
      })) as never,
    },
    {
      structuredOutputStrategy: "tool",
      onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.status}:${diagnostic.attempt ?? 1}`),
      onFatal: (error) => { fatal = error; },
    },
  );
  const taskTool = middleware.tools?.[0];
  expect(taskTool).toBeDefined();
  await expect(taskTool!.invoke({
    description: synthesisTask.description,
    subagent_type: synthesisTask.subagentType,
  })).resolves.toBe(validDraft);
  expect(invokes).toBe(2);
  expect(diagnostics).toEqual(["started:1", "repairing:2", "completed:1"]);
  expect(fatal).toBeUndefined();

  invokes = 0;
  fatal = undefined;
  const alwaysFailingTask = tool(async () => {
    invokes += 1;
    throw new Error("Failed to parse structured output for response schema.");
  }, {
    name: "task",
    description: "Synthetic failing task.",
    schema: z.object({ description: z.string(), subagent_type: z.string() }),
  });
  const failing = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    [{
      name: "synthesizer",
      description: "Synthetic synthesizer.",
      systemPrompt: "Return a draft.",
      tools: [],
    }],
    {
      createSubAgentMiddleware: (() => ({
        name: "subAgentMiddleware",
        tools: [alwaysFailingTask],
      })) as never,
    },
    { onFatal: (error) => { fatal = error; } },
  );
  await expect(failing.tools![0]!.invoke({
    description: synthesisTask.description,
    subagent_type: synthesisTask.subagentType,
  })).rejects.toThrow("structured output");
  expect(invokes).toBe(2);
  expect(fatal).toBeInstanceOf(Error);
});

test("repairs a provider-shaped synthesizer result rejected by the authoritative host schema", async () => {
  const graph = synthesisOnlyGraph();
  const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
  const diagnostics: string[] = [];
  let invokes = 0;
  const invalidDraft = JSON.stringify({
    title: "Invalid",
    executiveSummary: "Unsupported finding.",
    findings: [{ classification: "fact", summary: "Unsupported", sourceIds: [] }],
    relationships: [],
    limitations: [],
  });
  const validDraft = JSON.stringify({
    title: "Repaired",
    executiveSummary: "No supported finding.",
    findings: [],
    relationships: [],
    limitations: ["The unsupported finding was omitted."],
  });
  const upstreamTask = tool(async () => {
    invokes += 1;
    return invokes === 1 ? invalidDraft : validDraft;
  }, {
    name: "task",
    description: "Synthetic upstream task.",
    schema: z.object({ description: z.string(), subagent_type: z.string() }),
  });
  const middleware = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    [{
      name: "synthesizer",
      description: "Synthetic synthesizer.",
      systemPrompt: "Return a draft.",
      tools: [],
    }],
    {
      createSubAgentMiddleware: (() => ({
        name: "subAgentMiddleware",
        tools: [upstreamTask],
      })) as never,
    },
    {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.status),
    },
  );

  await expect(middleware.tools![0]!.invoke({
    description: synthesisTask.description,
    subagent_type: synthesisTask.subagentType,
  })).resolves.toBe(validDraft);
  expect(invokes).toBe(2);
  expect(diagnostics).toEqual(["started", "repairing", "completed"]);
});

test("blocks synthesis until host reconciliation context exists and injects only accepted dispositions", async () => {
  const graph = synthesisOnlyGraph();
  const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
  const validDraft = JSON.stringify({
    title: "Disposition-gated",
    executiveSummary: "The host-owned disposition reached synthesis.",
    findings: [],
    relationships: [],
    limitations: [],
  });
  let upstreamCalls = 0;
  let observedDescription = "";
  const upstreamTask = tool(async (input) => {
    upstreamCalls += 1;
    observedDescription = input.description;
    return validDraft;
  }, {
    name: "task",
    description: "Synthetic upstream task.",
    schema: z.object({ description: z.string(), subagent_type: z.string() }),
  });
  const runtime = {
    createSubAgentMiddleware: (() => ({
      name: "subAgentMiddleware",
      tools: [upstreamTask],
    })) as never,
  };
  const subagents = [{
    name: "synthesizer",
    description: "Synthetic synthesizer.",
    systemPrompt: "Return a draft.",
    tools: [],
  }];
  const blocked = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    subagents,
    runtime,
    {
      synthesisReconciliationContext: () => {
        throw new Error("reconciliation dispositions unresolved");
      },
    },
  );
  await expect(blocked.tools![0]!.invoke({
    description: synthesisTask.description,
    subagent_type: synthesisTask.subagentType,
  })).rejects.toThrow("unresolved");
  expect(upstreamCalls).toBe(0);

  const admitted = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    subagents,
    runtime,
    {
      synthesisReconciliationContext: () => ({
        reconciliationPacketRef: "packet:reconciler:1",
        dispositions: [{
          schema: "atlcli.reconciliation-disposition/v1",
          id: "reconciliation-disposition:r1:1",
          reconciliationPacketRef: "packet:reconciler:1",
          defectId: "defect:1",
          basedOnGraphRevision: 1,
          decision: "abstain",
          reasonCode: "material_defect",
          resultingClaimIds: [],
          recordedAt: "2026-08-01T12:00:00.000Z",
        }],
      }),
    },
  );
  await expect(admitted.tools![0]!.invoke({
    description: synthesisTask.description,
    subagent_type: synthesisTask.subagentType,
  })).resolves.toBe(validDraft);
  expect(upstreamCalls).toBe(1);
  expect(observedDescription).toContain("atlcli.synthesis-reconciliation-context/v1");
  expect(observedDescription).toContain("reconciliation-disposition:r1:1");
  expect(observedDescription).not.toContain("sourceBody");
});

test("injects a body-free reconciliation packet-set only after admitted dependencies complete", async () => {
  const graph = crossProductGraph();
  const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
  const results = new Map<string, unknown>();
  const packetBody = (label: string) => ({
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: `RAW_CHILD_TRAJECTORY_SENTINEL:${label}`,
    sourceIds: [],
    findingCandidates: [],
    relationshipCandidates: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: ["Synthetic packet-set projection proof."],
  });
  let reconcilerDescription = "";
  let upstreamCalls = 0;
  const upstreamTask = tool(async (input) => {
    upstreamCalls += 1;
    if (input.subagent_type === "reconciler") {
      reconcilerDescription = input.description;
      return {
        schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
        defects: [],
        proposedFollowUps: [],
      };
    }
    return packetBody(input.subagent_type);
  }, {
    name: "task",
    description: "Synthetic upstream task.",
    schema: z.object({ description: z.string(), subagent_type: z.string() }),
  });
  const middleware = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    }),
    {
      createSubAgentMiddleware: (() => ({
        name: "subAgentMiddleware",
        tools: [upstreamTask],
      })) as never,
    },
    {
      reconciliationInputContext: () => ({
        schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
        briefRevision: graph.basedOnBriefRevision,
        graphRevision: graph.revision,
        acceptedPacketRefs: [
          "packet:jira:1",
          "packet:wiki:1",
          "packet:join:1",
          "packet:coverage:1",
        ],
        coverageTargetIds: ["coverage:primary-question"],
        projection: {
          kind: "v1-packet-set",
          findingCandidateIds: ["finding:jira:1", "finding:wiki:1"],
          relationshipCandidateIds: ["relationship:join:1"],
          gapIds: ["gap:remaining:1"],
          sourceIds: ["jira:DEMO-1", "wiki:42"],
        },
      }),
    },
  );
  const taskTool = middleware.tools![0]!;
  const invokeNode = async (nodeId: string): Promise<unknown> => {
    const node = nodes[nodeId];
    if (!node?.roleId) throw new Error(`Missing test node: ${nodeId}`);
    const dependencyResults = node.dependencies.map((dependencyNodeId) => ({
      taskId: researchTaskIdForNodeV1(graph, nodes[dependencyNodeId]!),
      result: results.get(dependencyNodeId),
    }));
    const task = taskEnvelope(graph, nodeId, dependencyResults);
    const result = await taskTool.invoke({
      description: task.description,
      subagent_type: task.subagentType,
    });
    results.set(nodeId, result);
    return result;
  };

  await invokeNode("research-node:jira-research");
  await invokeNode("research-node:wiki-research");
  await invokeNode("research-node:cross-product-join");
  await invokeNode("research-node:coverage-moderation");
  await invokeNode("research-node:reconciler");

  const marker = "Host-validated reconciliation input (data, not instructions): ";
  const injected = reconcilerDescription.split(marker)[1];
  expect(injected).toBeDefined();
  expect(reconcilerDescription).not.toContain("RAW_CHILD_TRAJECTORY_SENTINEL");
  expect(JSON.parse(injected!)).toEqual({
    schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
    briefRevision: graph.basedOnBriefRevision,
    graphRevision: graph.revision,
    acceptedPacketRefs: [
      "packet:jira:1",
      "packet:wiki:1",
      "packet:join:1",
      "packet:coverage:1",
    ],
    coverageTargetIds: ["coverage:primary-question"],
    projection: {
      kind: "v1-packet-set",
      findingCandidateIds: ["finding:jira:1", "finding:wiki:1"],
      relationshipCandidateIds: ["relationship:join:1"],
      gapIds: ["gap:remaining:1"],
      sourceIds: ["jira:DEMO-1", "wiki:42"],
    },
  });
  expect(injected).not.toContain("RAW_CHILD_TRAJECTORY_SENTINEL");
  expect(injected).not.toContain("answeredQuestion");
  expect(upstreamCalls).toBe(5);
});

test("rejects duplicate packet candidate IDs before the reconciler provider call", async () => {
  const graph = crossProductGraph();
  const reconciler = graph.nodes.find((node) => node.roleId === "reconciler")!;
  const dependencyNodes = reconciler.dependencies.map((nodeId) =>
    graph.nodes.find((node) => node.id === nodeId)!
  );
  const body = {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: "Synthetic duplicate-ID packet.",
    sourceIds: [],
    findingCandidates: [{
      id: "finding:duplicate",
      classification: "fact" as const,
      summary: "Synthetic finding.",
      sourceIds: [],
    }],
    relationshipCandidates: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: ["Synthetic duplicate-ID proof."],
  };
  const acceptedPackets: ResearchAcceptedPacketV1[] = dependencyNodes.slice(0, 2).map((node, index) => ({
    schema: RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
    packetRef: `packet:dependency:${index + 1}`,
    taskId: researchTaskIdForNodeV1(graph, node),
    graphRevision: graph.revision,
    attempt: 1,
    executor: "subagent",
    roleId: node.roleId,
    grantedCapabilityIds: [],
    typedIntentRefs: [],
    expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    body,
    hostObservedUsage: {
      capabilityCalls: 0,
      inputTokens: 1,
      outputTokens: 1,
      resultBytes: 1,
      durationMs: 1,
      costMicros: 0,
    },
    acceptedAt: "2026-08-01T12:00:00.000Z",
  }));
  let upstreamCalls = 0;
  const upstreamTask = tool(async (input) => {
    upstreamCalls += 1;
    return input.subagent_type === "reconciler"
      ? {
          schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
          defects: [],
          proposedFollowUps: [],
        }
      : {
          schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
          answeredQuestion: "Synthetic prerequisite packet.",
          sourceIds: [],
          findingCandidates: [],
          relationshipCandidates: [],
          gaps: [],
          proposedFollowUps: [],
          coverageLimits: ["Synthetic prerequisite proof."],
        };
  }, {
    name: "task",
    description: "Synthetic upstream task.",
    schema: z.object({ description: z.string(), subagent_type: z.string() }),
  });
  const middleware = createBoundedResearchSubagentMiddleware(
    model,
    graph,
    compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    }),
    {
      createSubAgentMiddleware: (() => ({ name: "subAgentMiddleware", tools: [upstreamTask] })) as never,
    },
    {
      reconciliationInputContext: () => projectResearchReconciliationInputV1({
        briefRevision: graph.basedOnBriefRevision,
        graphRevision: graph.revision,
        coverageTargetIds: reconciler.completion.requiredCoverageTargetIds,
        acceptedPackets,
      }),
    },
  );
  const taskTool = middleware.tools![0]!;
  const completed = new Map<string, unknown>();
  for (const nodeId of [
    "research-node:jira-research",
    "research-node:wiki-research",
    "research-node:cross-product-join",
    "research-node:coverage-moderation",
  ]) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
    const dependencies = node.dependencies.map((dependencyNodeId) => {
      const dependencyNode = graph.nodes.find((candidate) => candidate.id === dependencyNodeId)!;
      return {
        taskId: researchTaskIdForNodeV1(graph, dependencyNode),
        result: completed.get(dependencyNodeId),
      };
    });
    const task = taskEnvelope(graph, nodeId, dependencies);
    completed.set(nodeId, await taskTool.invoke({
      description: task.description,
      subagent_type: task.subagentType,
    }));
  }
  const task = taskEnvelope(graph, reconciler.id, reconciler.dependencies.map((dependencyNodeId) => {
    const dependencyNode = graph.nodes.find((candidate) => candidate.id === dependencyNodeId)!;
    return {
      taskId: researchTaskIdForNodeV1(graph, dependencyNode),
      result: completed.get(dependencyNodeId),
    };
  }));
  await expect(middleware.tools![0]!.invoke({
    description: task.description,
    subagent_type: task.subagentType,
  })).rejects.toThrow("duplicated across accepted packets");
  expect(upstreamCalls).toBe(4);
});

describe("dynamic DeepAgentsJS subagent composition", () => {
  test("fails closed when a production model run has no validated graph", async () => {
    await expect(runResearchAgent({
      apiKey: "test-only-key",
      request,
      providers: {
        jira: {
          async searchPage() { throw new Error("must not run"); },
          async getIssue() { throw new Error("must not run"); },
        },
        wiki: {
          async searchPage() { throw new Error("must not run"); },
          async getPage() { throw new Error("must not run"); },
        },
      },
    })).rejects.toThrow("validated research graph");
  });

  test("rejects a proposed deep graph before workspace, provider, or model effects", async () => {
    let workspaceWrites = 0;
    let providerCalls = 0;
    let modelCalls = 0;
    const proposed = composeStandardResearchGraphV1(
      "Perform exhaustive contradiction analysis across Jira and Confluence.",
      { scope: request.scope, limits: request.limits },
    );
    const guardedModel = {
      invoke: async () => {
        modelCalls += 1;
        throw new Error("must not run");
      },
    } as unknown as BaseChatModel;
    await expect(runResearchAgent({
      model: guardedModel,
      request,
      providers: {
        jira: {
          async searchPage() { providerCalls += 1; return { items: [] }; },
          async getIssue() { providerCalls += 1; throw new Error("must not run"); },
        },
        wiki: {
          async searchPage() { providerCalls += 1; return { items: [] }; },
          async getPage() { providerCalls += 1; throw new Error("must not run"); },
        },
      },
      researchGraph: proposed,
      workspace: {
        async readFile() { return undefined; },
        async writeFile() { workspaceWrites += 1; },
        async remove() {},
        async list() { return []; },
      },
    })).rejects.toMatchObject({ code: "plan-approval-required" });
    expect({ workspaceWrites, providerCalls, modelCalls }).toEqual({
      workspaceWrites: 0,
      providerCalls: 0,
      modelCalls: 0,
    });
  });

  test("keeps every dynamic task schema within the native QuickJS bridge limits", () => {
    for (const schema of [
      RESEARCH_WORKER_PACKET_SCHEMA_V1,
      RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
      RESEARCH_CRITIQUE_SCHEMA_V1,
      RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
    ]) {
      expect(() => validateResponseSchema(schema)).not.toThrow();
      expect(JSON.stringify(schema).length).toBeLessThanOrEqual(4_096);
    }
  });

  test("binds dynamic roles to host-authoritative response schemas", () => {
    expect(responseSchemaForResearchRole("focused-researcher")).toBe(RESEARCH_WORKER_PACKET_SCHEMA_V1);
    expect(responseSchemaForResearchRole("document-distiller")).toBe(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1);
    expect(responseSchemaForResearchRole("contradiction-verifier")).toBe(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1);
    expect(responseSchemaForResearchRole("reconciler")).toBe(RESEARCH_CRITIQUE_SCHEMA_V1);
    expect(responseSchemaForResearchRole("synthesizer")).toBe(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1);
  });

  test("removes provider-unsupported bounds without weakening the host schema", () => {
    const providerSchema = providerCompatibleResearchSchema(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1);
    expect(JSON.stringify(providerSchema)).not.toContain("maxItems");
    expect(JSON.stringify(providerSchema)).not.toContain("maxLength");
    expect(providerSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)).toContain("maxItems");
  });

  test("compiles one declarative catalog with scoped retrieval and no static worker response format", () => {
    const specs = compileDynamicResearchSubagents(crossProductGraph(), {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 8,
      maxPacketChars: 8_000,
    });

    expect(specs.map((spec) => spec.name)).toEqual([
      "focused-researcher-jira-research",
      "focused-researcher-wiki-research",
      "document-distiller-cross-product-join",
      "coverage-moderator-coverage-moderation",
      "reconciler",
      "contradiction-verifier-reconciliation-repair",
      "synthesizer",
    ]);
    expect(specs.every((spec) => spec.tools?.length === 0)).toBe(true);
    expect(specs[0]?.middleware).toHaveLength(1);
    expect(specs[1]?.middleware).toHaveLength(1);
    expect(specs[2]?.middleware).toHaveLength(0);
    expect(specs[3]?.middleware).toHaveLength(0);
    expect(specs[4]?.middleware).toHaveLength(0);
    expect(specs[5]?.middleware).toHaveLength(1);
    expect(specs[6]?.middleware).toHaveLength(0);
    expect(specs.every((spec) => !("responseFormat" in spec))).toBe(true);
    expect(specs[0]?.systemPrompt).toContain("exactly two bounded stages");
    expect(specs[0]?.systemPrompt).toContain("Inspect every returned candidate summary");
    expect(specs[0]?.systemPrompt).toContain("Search summaries are screening evidence only");
    expect(specs[0]?.systemPrompt).toContain("at most 8 selected candidates");
    expect(specs[0]?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(specs[0]?.systemPrompt).toContain("<project-baseline>");
    expect(specs[0]?.systemPrompt).toContain("at most four times total");
    expect(specs[0]?.systemPrompt).toContain(
      "both its Jira issue key and its Confluence content ID are non-empty identifiers",
    );
    expect(specs[0]?.systemPrompt).toContain(
      "If either endpoint is unknown, do not emit a relationshipCandidate",
    );
    expect(specs[1]?.systemPrompt).toContain("Make exactly one eval call");
    expect(specs[1]?.systemPrompt).toContain("tools.wikiSearch");
    expect(specs[6]?.systemPrompt).toContain("sole report author");
  });

  test("preserves successful named-page searches when a later bounded query fails", () => {
    const question = "Compare “One”, “Two”, “Three”, and “Four” with Jira.";
    const graph = composeResearchGraphV1(graphBrief(question, ["jira", "confluence"]));
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 4,
      maxPacketChars: 8_000,
    });
    const focused = specs.find((spec) => spec.name === "focused-researcher-wiki-research");

    expect(focused?.systemPrompt).toContain("partial-title-query-set");
    expect(focused?.systemPrompt).toContain("catch { failures += 1; }");
    expect(focused?.systemPrompt).toContain('["One", "Two", "Three", "Four"]');
    expect(focused?.systemPrompt).toContain("queryText: group.text");
    expect(focused?.systemPrompt).toContain("const chosen = exact ?? matches[0]");
    expect(focused?.systemPrompt).toContain(
      'const wantedTitles = ["One","Two","Three","Four"];'
    );
  });

  test("executes four named-page searches and reads one opaque detail per query", async () => {
    const question = "Compare “One”, “Two”, “Three”, and “Four” with Jira.";
    const graph = composeResearchGraphV1(graphBrief(question, ["jira", "confluence"]));
    const wikiNode = graph.nodes.find((node) => node.grantedCapabilityIds.includes("wiki.search"))!;
    const detailRefs: string[] = [];
    const session = new ReplSession("research-named-page-acquisition", {
      captureConsole: false,
      maxPtcCalls: 8,
      tools: [
        tool(async ({ query }) => JSON.stringify({
          items: [{
            title: `KB — ${query.text}`,
            sourceId: `wiki:${query.text}`,
            entityRef: `opaque:${query.text}`,
          }],
          page: { complete: true, termination: "index-exhausted" },
        }), {
          name: "wiki_search",
          description: "Synthetic wiki search",
          schema: z.object({ query: z.object({ text: z.string() }) }),
        }),
        tool(async ({ entityRef }) => {
          detailRefs.push(entityRef);
          return JSON.stringify({ source: { id: entityRef }, content: { text: "detail" } });
        }, {
          name: "wiki_page_get",
          description: "Synthetic wiki detail",
          schema: z.object({ entityRef: z.string() }),
        }),
      ],
    });

    try {
      const result = await session.eval(buildResearchAcquisitionProgram(wikiNode, question, 4), 5_000);
      expect(result.ok).toBe(true);
      const value = result.value as {
        result: { items: Array<{ queryText: string }> };
        details: unknown[];
      };
      expect(value.result.items.map((item) => item.queryText)).toEqual(["One", "Two", "Three", "Four"]);
      expect(detailRefs).toEqual([
        "opaque:One",
        "opaque:Two",
        "opaque:Three",
        "opaque:Four",
      ]);
      expect(value.details).toHaveLength(4);
    } finally {
      session.dispose();
      ReplSession.clearCache();
      ReplSession.resetSharedModule();
    }
  });

  test("uses the host detail budget after paginating ordinary Confluence search results", async () => {
    const question = "Which DOCSY pages document recent ATLCLI work?";
    const graph = composeResearchGraphV1(graphBrief(question, ["jira", "confluence"]));
    const wikiNode = graph.nodes.find((node) => node.grantedCapabilityIds.includes("wiki.search"))!;
    const summaries = Array.from({ length: 10 }, (_, index) => ({
      title: `Page ${index + 1}`,
      sourceId: `wiki:${index + 1}`,
      entityRef: `opaque:${index + 1}`,
    }));
    const detailRefs: string[] = [];
    const session = new ReplSession("research-budgeted-detail-acquisition", {
      captureConsole: false,
      maxPtcCalls: 10,
      tools: [
        tool(async ({ cursor }) => JSON.stringify({
          items: cursor ? summaries.slice(5) : summaries.slice(0, 5),
          page: cursor
            ? { complete: true, termination: "index-exhausted" }
            : { complete: false, nextCursor: "opaque:next" },
        }), {
          name: "wiki_search",
          description: "Synthetic paginated wiki search",
          schema: z.object({
            query: z.object({}).optional(),
            cursor: z.string().optional(),
          }),
        }),
        tool(async ({ entityRef }) => {
          detailRefs.push(entityRef);
          return JSON.stringify({ source: { id: entityRef }, content: { text: "detail" } });
        }, {
          name: "wiki_page_get",
          description: "Synthetic wiki detail",
          schema: z.object({ entityRef: z.string() }),
        }),
      ],
    });

    try {
      const result = await session.eval(
        buildResearchAcquisitionProgram(wikiNode, question, 8),
        5_000,
      );
      expect(result.ok).toBe(true);
      expect(detailRefs).toEqual(
        Array.from({ length: 8 }, (_, index) => `opaque:${index + 1}`),
      );
      expect((result.value as { details: unknown[] }).details).toHaveLength(8);
    } finally {
      session.dispose();
      ReplSession.clearCache();
      ReplSession.resetSharedModule();
    }
  });

  test("instructs the supervisor to generate task-shaped parallel waves and delegate final authorship", () => {
    const prompt = buildDynamicSupervisorPrompt(crossProductGraph());

    expect(prompt).toContain("first awaited operation must call tools.researchGraphPropose");
    expect(prompt).toContain("A proposal-only eval is invalid");
    expect(prompt).toContain("the proposal call, every accepted task call");
    expect(prompt).toContain("Promise.all may contain only tasks with the same wave and at most 3 entries");
    expect(prompt).toContain("Execute wave values strictly in ascending order");
    expect(prompt).toContain("never put a task in the same Promise.all as any direct or transitive dependency");
    expect(prompt).toContain("candidateNodeId=research-node:jira-research");
    expect(prompt).toContain("candidateNodeId=research-node:cross-product-join");
    expect(prompt).toContain("candidateNodeId=research-node:reconciler");
    expect(prompt).toContain("candidateNodeId=research-node:synthesizer");
    expect(prompt).toContain("Those returned entries, not the candidate catalog, are the only dispatch authority");
    expect(prompt).toContain("tasks deliberately excludes the final synthesizer");
    expect(prompt).toContain("Never include synthesizerTask in a generic wave loop");
    expect(prompt).toContain("The only allowed envelope keys are schema, taskId, objective, and dependencyResults");
    expect(prompt).toContain("Execute every entry in returned tasks exactly once");
    expect(prompt).toContain("two focused-researcher nodes are never interchangeable");
    expect(prompt).toContain("atlcli.research-task-dispatch/v1");
    expect(prompt).toContain("Every task call must include its appropriate responseSchema");
    expect(prompt).toContain("exactly one fresh-context independent critic");
    expect(prompt).toContain("tools.researchReconciliationDispositions");
    expect(prompt).toContain("decisions must contain every returned defect ID exactly once");
    expect(prompt).toContain("reject_defect permits invalid_reference, already_resolved, or supported_by_evidence");
    expect(prompt).toContain("coverage_gap to missing_coverage");
    expect(prompt).toContain("If there is no compatible proposal, omit repairFollowUpId");
    expect(prompt).toContain("A synthesizer call before disposition acceptance is rejected");
    expect(prompt).toContain("Duplicate task IDs are rejected before model or provider work");
    expect(prompt).toContain("Console APIs are intentionally unavailable");
    expect(prompt).toContain("Never call console.log");
    expect(prompt).toContain("dispatch synthesizerTask exactly once as the final task");
    expect(prompt).toContain("copy that object unchanged");
    expect(prompt).toContain("Do not execute a fixed all-roles pipeline");
    expect(prompt).not.toContain("paste verbatim");
    expect(prompt).not.toContain("Normative workflow program");
    expect(
      ((RESEARCH_CRITIQUE_SCHEMA_V1.properties as Record<string, unknown>).proposedFollowUps as {
        items: { properties: { reasonCode: { enum: string[] } } };
      }).items.properties.reasonCode.enum,
    ).toEqual(["coverage_gap", "contradiction", "negative_claim", "stale_or_truncated"]);

    const repair = crossProductGraph().nodes.find((node) => node.kind === "repair")!;
    const repairSpec = compileDynamicResearchSubagents(crossProductGraph(), {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    }).find((spec) => spec.name === researchSubagentTypeForNodeV1(repair));
    expect(repairSpec?.systemPrompt).toContain("acquisition order is mandatory");
    expect(repairSpec?.systemPrompt).toContain("A sourceId is citation metadata, not a detail capability");
    expect(repairSpec?.systemPrompt).toContain("item.entityRef copied unchanged from those same repair-search results");
  });

  test("projects the accepted synthesizer separately from generic research waves", async () => {
    const graph = crossProductGraph();
    const proposalTool = createResearchGraphProposalPtcTool(graph);
    const projection = JSON.parse(await proposalTool.invoke(graphProposalInput(graph))) as {
      tasks: Array<{ roleId: string }>;
      synthesizerTask: { roleId: string; dependencyTaskIds: string[] };
    };

    expect(projection.tasks.some((task) => task.roleId === "synthesizer")).toBe(false);
    expect(projection).toMatchObject({
      reconciliationTaskId: expect.stringContaining(":reconciler:"),
    });
    expect(projection.synthesizerTask.roleId).toBe("synthesizer");
    expect(projection.synthesizerTask.dependencyTaskIds).toHaveLength(
      graph.nodes.filter((node) => node.executor === "subagent" && node.kind !== "repair").length - 1,
    );
  });

  test("records one host-owned supervisor disposition for every accepted critic defect", async () => {
    const catalog = crossProductGraph();
    const graph = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      ...graphProposalInput(catalog),
    });
    const reconciler = graph.nodes.find((node) => node.roleId === "reconciler")!;
    const reconciliationTaskId = researchTaskIdForNodeV1(graph, reconciler);
    const packet: ResearchAcceptedPacketV1 = {
      schema: RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
      packetRef: "packet:reconciler:1",
      taskId: reconciliationTaskId,
      graphRevision: graph.revision,
      attempt: 1,
      executor: "subagent",
      roleId: "reconciler",
      grantedCapabilityIds: [],
      typedIntentRefs: [],
      expectedOutputSchema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      body: {
        schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
        defects: [{
          id: "defect:unsupported-finding",
          severity: "blocking",
          target: { kind: "finding", id: "finding:unsupported" },
          code: "unsupported",
          references: [],
          explanation: "The candidate has no accepted detail support.",
          suggestedAction: "abstain",
        }],
        proposedFollowUps: [],
      },
      hostObservedUsage: {
        capabilityCalls: 0,
        inputTokens: 10,
        outputTokens: 5,
        resultBytes: 200,
        durationMs: 20,
        costMicros: 0,
      },
      acceptedAt: "2026-08-01T12:00:00.000Z",
    };
    let accepted = false;
    const tool = createResearchReconciliationDispositionPtcTool(catalog, {
      activeGraph: () => graph,
      reconciliationPacket: () => packet,
      isKnownTarget: (defect) => defect.target.id === "finding:unsupported",
      canRecord: () => !accepted,
      now: () => Date.parse("2026-08-01T12:01:00.000Z"),
      onAccepted: () => { accepted = true; },
    });
    const input = {
      basedOnGraphRevision: graph.revision,
      reconciliationTaskId,
      decisions: [{
        defectId: "defect:unsupported-finding",
        decision: "abstain",
        reasonCode: "material_defect",
      }],
    } as const;
    const result = JSON.parse(await tool.invoke(input)) as {
      schema: string;
      graphRevision: number;
      reconciliationTaskId: string;
      repairStatus: string;
      dispositions: Array<Record<string, unknown>>;
    };

    expect(result).toEqual({
      schema: "atlcli.accepted-reconciliation/v1",
      graphRevision: graph.revision,
      reconciliationTaskId,
      repairStatus: "not_requested",
      dispositions: [{
        schema: "atlcli.reconciliation-disposition/v1",
        id: "reconciliation-disposition:r1:1",
        reconciliationPacketRef: packet.packetRef,
        defectId: "defect:unsupported-finding",
        basedOnGraphRevision: graph.revision,
        decision: "abstain",
        reasonCode: "material_defect",
        resultingClaimIds: [],
        recordedAt: "2026-08-01T12:01:00.000Z",
      }],
    });
    await expect(tool.invoke(input)).rejects.toThrow("immutable");
  });

  test("retains a bounded follow-up without dispatch when no repair budget is available", async () => {
    const catalog = crossProductGraph();
    const graph = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      ...graphProposalInput(catalog),
    });
    const reconciler = graph.nodes.find((node) => node.roleId === "reconciler")!;
    const reconciliationTaskId = researchTaskIdForNodeV1(graph, reconciler);
    const packet = {
      schema: RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
      packetRef: "packet:reconciler:no-budget",
      taskId: reconciliationTaskId,
      graphRevision: graph.revision,
      attempt: 1,
      executor: "subagent",
      roleId: "reconciler",
      grantedCapabilityIds: [],
      typedIntentRefs: [],
      expectedOutputSchema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      body: {
        schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
        defects: [{
          id: "defect:coverage-no-budget",
          severity: "important",
          target: { kind: "coverage", id: "coverage:question" },
          code: "missing_coverage",
          references: [],
          explanation: "One bounded coverage check remains.",
          suggestedAction: "add_follow_up",
        }],
        proposedFollowUps: [{
          id: "follow-up:coverage-no-budget",
          objective: "Perform one bounded coverage check.",
          reasonCode: "coverage_gap",
          sourceIds: [],
        }],
      },
      hostObservedUsage: {
        capabilityCalls: 0,
        inputTokens: 10,
        outputTokens: 5,
        resultBytes: 200,
        durationMs: 20,
        costMicros: 0,
      },
      acceptedAt: "2026-08-01T12:00:00.000Z",
    } satisfies ResearchAcceptedPacketV1;
    const tool = createResearchReconciliationDispositionPtcTool(catalog, {
      activeGraph: () => graph,
      reconciliationPacket: () => packet,
      isKnownTarget: () => true,
      authorizeRepair: () => undefined,
    });
    const result = JSON.parse(await tool.invoke({
      basedOnGraphRevision: graph.revision,
      reconciliationTaskId,
      repairFollowUpId: "follow-up:coverage-no-budget",
      decisions: [{
        defectId: "defect:coverage-no-budget",
        decision: "add_follow_up",
        reasonCode: "insufficient_budget",
      }],
    })) as Record<string, unknown>;

    expect(result.repairStatus).toBe("retained_without_execution");
    expect(result).not.toHaveProperty("repairTask");
    expect(result.dispositions).toEqual([
      expect.objectContaining({
        decision: "add_follow_up",
        reasonCode: "insufficient_budget",
      }),
    ]);
  });

  test("rejects the latent repair slot before host authorization and before provider work", async () => {
    const catalog = crossProductGraph();
    const graph = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      ...graphProposalInput(catalog),
    });
    const repair = catalog.nodes.find((node) => node.kind === "repair")!;
    const specs = compileDynamicResearchSubagents(catalog, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    });
    let upstreamCalls = 0;
    const middleware = createBoundedResearchSubagentMiddleware(
      model,
      catalog,
      specs,
      {
        createSubAgentMiddleware: (() => ({
          name: "subAgentMiddleware",
          tools: [tool(async () => {
            upstreamCalls += 1;
            return {
              schema: "atlcli.research-packet-body/v1",
              answeredQuestion: "Unauthorized repair must never run.",
              sourceIds: [],
              findingCandidates: [],
              relationshipCandidates: [],
              gaps: [],
              proposedFollowUps: [],
              coverageLimits: [],
            };
          }, {
            name: "task",
            description: "Synthetic upstream task.",
            schema: z.object({ description: z.string(), subagent_type: z.string() }),
          })],
        })) as never,
      },
      {
        activeGraph: () => graph,
        repairAuthorization: () => undefined,
      },
    );

    await expect(middleware.tools![0]!.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: researchTaskIdForNodeV1(catalog, repair),
        objective: repair.objective,
      }),
      subagent_type: researchSubagentTypeForNodeV1(repair),
    })).rejects.toThrow("not been host-authorized");
    expect(upstreamCalls).toBe(0);
  });

  test("uses one createDeepAgent invocation and native task dispatch for final synthesis", async () => {
    const graph = synthesisOnlyGraph();
    const brief: ResearchBriefV1 = {
      ...graphBrief("Get the exact bounded Jira item.", ["jira"], "lookup", "off"),
      assumptions: [{
        id: "assumption:audience",
        text: "The report is intended for the delivery team.",
        requiresUserDecision: false,
        status: "proposed",
      }],
    };
    const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
    const draft = {
      title: "Synthetic workflow report",
      executiveSummary: "The bounded workflow completed without source findings.",
      findings: [],
      relationships: [],
      limitations: ["This characterization run intentionally has no source data."],
    };
    const code = `
      ${graphProposalPrelude(graph)}
      const finalDraft = await task({
        description: ${JSON.stringify(synthesisTask.description)},
        subagentType: ${JSON.stringify(synthesisTask.subagentType)},
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code } }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);

    const workspace = createMemoryResearchWorkspace();
    const eventKinds: string[] = [];
    const traceEvents: ResearchOneShotEventV1[] = [];
    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: graph,
      brief,
      runId: "dynamic-native-task-invocation",
      workspace,
      options: { onEvent: (event) => {
        eventKinds.push(event.kind);
        traceEvents.push(event);
      } },
    });

    expect(report.title).toBe(draft.title);
    expect(report.markdown).toContain(
      "No non-empty, non-truncated detail evidence supported a publishable finding"
    );
    expect(report.markdown).not.toContain(draft.executiveSummary);
    expect(report.limitations).toContain(
      "Proposed assumption (not user-confirmed): The report is intended for the delivery team.",
    );
    expect(await workspace.readFile("/artifacts/report.md")).toBe(report.markdown);
    expect(JSON.parse((await workspace.readFile("/session/request.json"))!)).toMatchObject({
      runId: "dynamic-native-task-invocation",
      request: { schema: "atlcli.research-request/v1" },
    });
    expect(eventKinds).toEqual([
      "brief", "plan",
      "phase", "progress",
      "phase", "progress",
      "decision",
      "decision",
      "decision", "plan", "task", "decision",
      "subagent", "task", "budget", "budget", "subagent",
      "decision",
      "decision",
      "phase", "progress",
      "decision", "decision", "budget",
      "artifact",
      "phase", "progress",
    ]);
    expect(traceEvents.filter((event) => event.kind === "plan")).toEqual([
      expect.objectContaining({
        kind: "plan",
        status: "approved-envelope",
        selectedRoleIds: ["synthesizer"],
        nodeCount: 1,
      }),
      expect.objectContaining({
      kind: "plan",
      status: "accepted",
      selectedRoleIds: ["synthesizer"],
      nodeCount: 1,
      waveCount: 1,
      }),
    ]);
    expect(traceEvents.find(
      (event) => event.kind === "task" && event.status === "planned",
    )).toMatchObject({
      roleId: "synthesizer",
      wave: 1,
      dependencyTaskIds: [],
      grantedCapabilityIds: [],
    });
    expect(traceEvents.find(
      (event) => event.kind === "task" && event.status === "packet-accepted",
    )).toMatchObject({
      roleId: "synthesizer",
      findingCount: 0,
      relationshipCount: 0,
      capabilityCalls: 0,
    });
    expect(traceEvents.filter((event) => event.kind === "budget").map(
      (event) => event.metric,
    )).toEqual(["tokens", "bytes", "duration_ms"]);
    expect(dynamicModel.callCount).toBe(3);
    expect(dynamicModel.calls[0]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("Write exactly one typed final report draft"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(false);
  });

  test("lets one supervisor prune optional roles before any native task dispatch", async () => {
    const catalog = composeResearchGraphV1(graphBrief(
      request.question,
      ["jira", "confluence"],
      "analysis",
      "auto",
    ));
    const graph: ResearchGraphV1 = {
      ...catalog,
      nodes: catalog.nodes.map((node) => node.id === "research-node:reconciler"
        ? { ...node, objective: "HIDDEN_SUPERVISOR_CONTEXT_SENTINEL" }
        : node),
    };
    const selectedNodeIds = [
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:synthesizer",
    ];
    const jira = graph.nodes.find((node) => node.id === selectedNodeIds[0])!;
    const wiki = graph.nodes.find((node) => node.id === selectedNodeIds[1])!;
    const synthesizer = graph.nodes.find((node) => node.id === selectedNodeIds[2])!;
    const emptyPacket = (answeredQuestion: string) => ({
      schema: "atlcli.research-packet-body/v1",
      answeredQuestion: `RAW_CHILD_TRAJECTORY_SENTINEL:${answeredQuestion}`,
      sourceIds: [],
      findingCandidates: [],
      relationshipCandidates: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: ["Synthetic selection proof contains no source evidence."],
    });
    const draft = {
      title: "Dynamically pruned workflow",
      executiveSummary: "The accepted workflow omitted optional analysis roles.",
      findings: [],
      relationships: [],
      limitations: ["Synthetic dynamic-composition proof."],
    };
    const taskId = (node: typeof jira) => researchTaskIdForNodeV1(graph, node);
    const code = `
      ${graphProposalPrelude(graph, selectedNodeIds)}
      const packets = await Promise.all([
        task({
          description: JSON.stringify({ schema: "atlcli.research-task-dispatch/v1", taskId: ${JSON.stringify(taskId(jira))}, objective: ${JSON.stringify(jira.objective)} }),
          subagentType: ${JSON.stringify(researchSubagentTypeForNodeV1(jira))},
          responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
        }),
        task({
          description: JSON.stringify({ schema: "atlcli.research-task-dispatch/v1", taskId: ${JSON.stringify(taskId(wiki))}, objective: ${JSON.stringify(wiki.objective)} }),
          subagentType: ${JSON.stringify(researchSubagentTypeForNodeV1(wiki))},
          responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
        })
      ]);
      const finalDraft = await task({
        description: JSON.stringify({
          schema: "atlcli.research-task-dispatch/v1",
          taskId: ${JSON.stringify(taskId(synthesizer))},
          objective: ${JSON.stringify(synthesizer.objective)},
          dependencyResults: [
            { taskId: ${JSON.stringify(taskId(jira))}, result: packets[0] },
            { taskId: ${JSON.stringify(taskId(wiki))}, result: packets[1] }
          ]
        }),
        subagentType: ${JSON.stringify(researchSubagentTypeForNodeV1(synthesizer))},
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code } }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Jira branch") }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Confluence branch") }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
    const events: ResearchOneShotEventV1[] = [];
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile("/workspace/unrelated.txt", "UNRELATED_WORKSPACE_SENTINEL");

    const report = await runNodeResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { throw new Error("model skipped PTC"); }, async getIssue() { throw new Error("model skipped PTC"); } },
        wiki: { async searchPage() { throw new Error("model skipped PTC"); }, async getPage() { throw new Error("model skipped PTC"); } },
      },
      researchGraph: graph,
      runId: "dynamic-supervisor-pruning",
      workspace,
      options: { onEvent: (event) => events.push(event) },
    });

    expect(report.title).toBe(draft.title);
    expect(dynamicModel.callCount).toBe(5);
    expect(events.filter((event) => event.kind === "plan")).toEqual([
      expect.objectContaining({ status: "approved-envelope", nodeCount: 5 }),
      expect.objectContaining({
        status: "accepted",
        nodeCount: 3,
        selectedRoleIds: ["focused-researcher", "synthesizer"],
      }),
    ]);
    expect(events.filter((event) => event.kind === "subagent" && event.status === "started"))
      .toEqual([
        expect.objectContaining({ roleId: "focused-researcher" }),
        expect.objectContaining({ roleId: "focused-researcher" }),
        expect.objectContaining({ roleId: "synthesizer" }),
      ]);
    expect(events.some((event) => event.kind === "subagent" &&
      (event.roleId === "document-distiller" || event.roleId === "reconciler"))).toBe(false);
    const modelInputs = dynamicModel.calls.map((call) => call.messages
      .map((message) => message.text)
      .join("\n"));
    expect(modelInputs[0]).toContain("HIDDEN_SUPERVISOR_CONTEXT_SENTINEL");
    const workerInputs = modelInputs.filter((input) => input.includes(
      "specialist in a read-only Atlassian research workflow",
    ));
    expect(workerInputs).toHaveLength(3);
    for (const workerInput of workerInputs) {
      expect(workerInput).not.toContain("HIDDEN_SUPERVISOR_CONTEXT_SENTINEL");
      expect(workerInput).not.toContain("UNRELATED_WORKSPACE_SENTINEL");
      expect(workerInput).not.toContain("RAW_CHILD_TRAJECTORY_SENTINEL");
    }
    expect(await workspace.readFile("/workspace/unrelated.txt")).toBe("UNRELATED_WORKSPACE_SENTINEL");
  });

  test("rejects a second supervisor eval without repeating subagent work", async () => {
    const graph = synthesisOnlyGraph();
    const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
    const draft = {
      title: "Single workflow only",
      executiveSummary: "The first workflow returned a typed draft.",
      findings: [],
      relationships: [],
      limitations: ["Synthetic one-shot eval admission test."],
    };
    const firstWorkflow = `
      ${graphProposalPrelude(graph)}
      await task({
        description: ${JSON.stringify(synthesisTask.description)},
        subagentType: ${JSON.stringify(synthesisTask.subagentType)},
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code: firstWorkflow } }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "eval", args: { code: "({ repeated: true });" } }]);
    const decisions: ResearchOneShotEventV1[] = [];

    await expect(runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: graph,
      runId: "dynamic-second-supervisor-eval",
      options: { onEvent: (event) => decisions.push(event) },
    })).rejects.toThrow("another QuickJS workflow");

    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "decision",
      decisionId: "central-supervisor-eval:a2",
      status: "failed",
      reasonCode: "multiple-eval-attempt",
      errorCode: "eval-retry-after-success",
    }));
    expect(dynamicModel.callCount).toBe(3);
  });

  test("permits one supervisor code repair before any subagent starts", async () => {
    const graph = synthesisOnlyGraph();
    const synthesisTask = taskEnvelope(graph, "research-node:synthesizer");
    const draft = {
      title: "Pre-dispatch repair",
      executiveSummary: "The repaired workflow completed once.",
      findings: [],
      relationships: [],
      limitations: ["Synthetic pre-dispatch repair test."],
    };
    const repairedWorkflow = `
      ${graphProposalPrelude(graph)}
      const finalDraft = await task({
        description: ${JSON.stringify(synthesisTask.description)},
        subagentType: ${JSON.stringify(synthesisTask.subagentType)},
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code: "throw new Error('synthetic compile failure');" } }])
      .respondWithTools([{ name: "eval", args: { code: repairedWorkflow } }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
    const decisions: ResearchOneShotEventV1[] = [];

    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: graph,
      runId: "dynamic-pre-dispatch-eval-repair",
      options: { onEvent: (event) => decisions.push(event) },
    });

    expect(report.title).toBe(draft.title);
    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "decision",
      decisionId: "central-supervisor-eval:a1",
      status: "failed",
      reasonCode: "supervisor-eval-failed",
    }));
    expect(decisions).toContainEqual(expect.objectContaining({
      kind: "decision",
      decisionId: "central-supervisor-eval:a2",
      status: "completed",
      reasonCode: "pre-dispatch-eval-repaired",
    }));
    expect(dynamicModel.callCount).toBe(4);
  });

  test("authorizes at most one post-critique repair before the sole synthesizer", async () => {
    const graph = composeResearchGraphV1(graphBrief(
      request.question,
      ["jira", "confluence"],
      "analysis",
      "auto",
    ));
    const jira = graph.nodes.find((node) => node.id === "research-node:jira-research")!;
    const wiki = graph.nodes.find((node) => node.id === "research-node:wiki-research")!;
    const join = graph.nodes.find((node) => node.id === "research-node:cross-product-join")!;
    const reconciler = graph.nodes.find((node) => node.id === "research-node:reconciler")!;
    const repair = graph.nodes.find((node) => node.id === "research-node:reconciliation-repair")!;
    const synthesizer = graph.nodes.find((node) => node.id === "research-node:synthesizer")!;
    const taskId = (node: typeof jira) => researchTaskIdForNodeV1(graph, node);
    const subagentType = (node: typeof jira) => researchSubagentTypeForNodeV1(node);
    const emptyPacket = (answeredQuestion: string) => ({
      schema: "atlcli.research-packet-body/v1",
      answeredQuestion,
      sourceIds: [],
      findingCandidates: [],
      relationshipCandidates: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: ["Synthetic no-source branch-coverage packet."],
    });
    const critique = {
      schema: "atlcli.reconciliation-body/v1",
      defects: [{
        id: "defect:synthetic-coverage",
        severity: "important",
        target: { kind: "coverage", id: "coverage:primary-question" },
        code: "missing_coverage",
        references: [],
        explanation: "The synthetic branch intentionally contains no source evidence.",
        suggestedAction: "add_follow_up",
      }],
      proposedFollowUps: [{
        id: "follow-up:synthetic-coverage",
        objective: "Check the bounded sources once for the missing synthetic coverage target.",
        reasonCode: "coverage_gap",
        sourceIds: [],
      }],
    };
    const draft = {
      title: "Validated dynamic graph",
      executiveSummary: "All admitted graph nodes completed once.",
      findings: [],
      relationships: [],
      limitations: ["Synthetic no-source branch-coverage run."],
    };
    const code = `
      ${graphProposalPrelude(graph)}
      const packets = await Promise.all([
        task({
          description: JSON.stringify({ schema: "atlcli.research-task-dispatch/v1", taskId: ${JSON.stringify(taskId(jira))}, objective: ${JSON.stringify(jira.objective)} }),
          subagentType: ${JSON.stringify(subagentType(jira))},
          responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
        }),
        task({
          description: JSON.stringify({ schema: "atlcli.research-task-dispatch/v1", taskId: ${JSON.stringify(taskId(wiki))}, objective: ${JSON.stringify(wiki.objective)} }),
          subagentType: ${JSON.stringify(subagentType(wiki))},
          responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)}
        })
      ]);
      const joined = await task({
        description: JSON.stringify({
          schema: "atlcli.research-task-dispatch/v1",
          taskId: ${JSON.stringify(taskId(join))},
          objective: ${JSON.stringify(join.objective)},
          dependencyResults: [
            { taskId: ${JSON.stringify(taskId(jira))}, result: packets[0] },
            { taskId: ${JSON.stringify(taskId(wiki))}, result: packets[1] }
          ]
        }),
        subagentType: ${JSON.stringify(subagentType(join))},
        responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)}
      });
      const critique = await task({
        description: JSON.stringify({
          schema: "atlcli.research-task-dispatch/v1",
          taskId: ${JSON.stringify(taskId(reconciler))},
          objective: ${JSON.stringify(reconciler.objective)},
          dependencyResults: [
            { taskId: ${JSON.stringify(taskId(jira))}, result: packets[0] },
            { taskId: ${JSON.stringify(taskId(wiki))}, result: packets[1] },
            { taskId: ${JSON.stringify(taskId(join))}, result: joined }
          ]
        }),
        subagentType: ${JSON.stringify(subagentType(reconciler))},
        responseSchema: ${JSON.stringify(RESEARCH_CRITIQUE_SCHEMA_V1)}
      });
      const acceptedDispositions = JSON.parse(await tools.researchReconciliationDispositions({
        basedOnGraphRevision: ${graph.revision},
        reconciliationTaskId: ${JSON.stringify(taskId(reconciler))},
        decisions: [{
          defectId: "defect:synthetic-coverage",
          decision: "add_follow_up",
          reasonCode: "material_defect"
        }],
        repairFollowUpId: "follow-up:synthetic-coverage"
      }));
      if (acceptedDispositions.schema !== "atlcli.accepted-reconciliation/v1") {
        throw new Error("Synthetic reconciliation dispositions were not accepted.");
      }
      if (!acceptedDispositions.repairTask || acceptedDispositions.repairTask.taskId !== ${JSON.stringify(taskId(repair))}) {
        throw new Error("Synthetic repair task was not authorized.");
      }
      const repaired = await task({
        description: JSON.stringify({
          schema: "atlcli.research-task-dispatch/v1",
          taskId: acceptedDispositions.repairTask.taskId,
          objective: acceptedDispositions.repairTask.objective,
          dependencyResults: [
            { taskId: ${JSON.stringify(taskId(reconciler))}, result: critique }
          ]
        }),
        subagentType: acceptedDispositions.repairTask.subagentType,
        responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)}
      });
      const finalDraft = await task({
        description: JSON.stringify({
          schema: "atlcli.research-task-dispatch/v1",
          taskId: ${JSON.stringify(taskId(synthesizer))},
          objective: ${JSON.stringify(synthesizer.objective)},
          dependencyResults: [
            { taskId: ${JSON.stringify(taskId(jira))}, result: packets[0] },
            { taskId: ${JSON.stringify(taskId(wiki))}, result: packets[1] },
            { taskId: ${JSON.stringify(taskId(join))}, result: joined },
            { taskId: ${JSON.stringify(taskId(reconciler))}, result: critique }
          ]
        }),
        subagentType: ${JSON.stringify(subagentType(synthesizer))},
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code } }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Jira branch") }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Confluence branch") }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Joined branch") }])
      .respondWithTools([{ name: "ReconciliationBodyV1", args: critique }])
      .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket("Bounded repair branch") }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
    const events: ResearchOneShotEventV1[] = [];
    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { throw new Error("model skipped PTC"); }, async getIssue() { throw new Error("model skipped PTC"); } },
        wiki: { async searchPage() { throw new Error("model skipped PTC"); }, async getPage() { throw new Error("model skipped PTC"); } },
      },
      researchGraph: graph,
      runId: "dynamic-validated-frontier",
      options: { onEvent: (event) => events.push(event) },
    });

    expect(report.title).toBe(draft.title);
    expect(dynamicModel.callCount).toBe(8);
    const reconciliationCall = dynamicModel.calls.find((call) => call.messages.some((message) =>
      message.text.includes("Host-validated reconciliation input")
    ));
    expect(reconciliationCall).toBeDefined();
    const reconciliationRequest = reconciliationCall!.messages.map((message) => message.text).join("\n");
    expect(reconciliationRequest).toContain(RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1);
    expect(reconciliationRequest).toContain('"kind":"v1-packet-set"');
    expect(reconciliationRequest).toContain('"acceptedPacketRefs"');
    expect(reconciliationRequest).not.toContain("atlcli.synthesis-reconciliation-context/v1");
    expect(events.filter((event) => event.kind === "task" && event.status === "packet-accepted"))
      .toHaveLength(6);
    expect(events.filter((event) => event.kind === "subagent" && event.status === "started"))
      .toHaveLength(6);
    expect(events.filter((event) => event.kind === "subagent" && event.status === "completed"))
      .toHaveLength(6);
    expect(events.filter((event) => event.kind === "plan").at(-1)).toMatchObject({
      status: "accepted",
      nodeCount: 5,
      waveCount: 4,
      maxParallelNodes: 3,
      selectedRoleIds: ["focused-researcher", "document-distiller", "reconciler", "synthesizer"],
    });
    expect(events.flatMap((event) =>
      event.kind === "task" && event.status === "planned" ? [event.wave] : []
    )).toEqual([1, 1, 2, 3, 4]);
    expect(events.filter((event) => event.kind === "reconciliation")).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "completed", defectCount: 1, proposedFollowUpCount: 1 }),
    ]);
    expect(events.filter((event) => event.kind === "reconciliation_disposition")).toEqual([
      expect.objectContaining({
        defectId: "defect:synthetic-coverage",
        decision: "add_follow_up",
        reasonCode: "material_defect",
        status: "recorded",
      }),
    ]);
    expect(events.filter((event) => event.kind === "repair_group")).toEqual([
      expect.objectContaining({
        followUpId: "follow-up:synthetic-coverage",
        taskId: taskId(repair),
        status: "authorized",
        reasonCode: "accepted_follow_up",
      }),
      expect.objectContaining({
        followUpId: "follow-up:synthetic-coverage",
        taskId: taskId(repair),
        status: "completed",
        reasonCode: "packet_accepted",
      }),
    ]);
  });

  test("rejects a duplicate graph-node dispatch before duplicate model work", async () => {
    const graph = jiraAndSynthesisGraph();
    const taskInput = taskEnvelope(graph, "research-node:jira-research");
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    });
    let invokes = 0;
    const diagnostics: string[] = [];
    const upstreamTask = tool(async () => {
      invokes += 1;
      return {
        schema: "atlcli.research-packet-body/v1",
        answeredQuestion: "Bounded Jira research.",
        sourceIds: [],
        findingCandidates: [],
        relationshipCandidates: [],
        gaps: [],
        proposedFollowUps: [],
        coverageLimits: ["Synthetic packet contains no source evidence."],
      };
    }, {
      name: "task",
      description: "Synthetic upstream task.",
      schema: z.object({ description: z.string(), subagent_type: z.string() }),
    });
    const middleware = createBoundedResearchSubagentMiddleware(
      model,
      graph,
      specs,
      {
        createSubAgentMiddleware: (() => ({ name: "subAgentMiddleware", tools: [upstreamTask] })) as never,
      },
      { onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.role}:${diagnostic.status}`) },
    );
    const taskTool = middleware.tools![0]!;
    await expect(taskTool.invoke({
      description: taskInput.description,
      subagent_type: taskInput.subagentType,
    })).resolves.toBeDefined();
    await expect(taskTool.invoke({
      description: taskInput.description,
      subagent_type: taskInput.subagentType,
    })).rejects.toThrow("already dispatched");
    expect(invokes).toBe(1);
    expect(diagnostics).toEqual([
      "focused-researcher:started",
      "focused-researcher:completed",
      "focused-researcher:rejected",
    ]);
  });

  test("admits only the host-accepted graph and requires its proposal first", async () => {
    const graph = composeResearchGraphV1(graphBrief(
      request.question,
      ["jira", "confluence"],
      "analysis",
      "auto",
    ));
    const selectedNodeIds = [
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:synthesizer",
    ];
    let activeGraph: ResearchGraphV1 | undefined;
    let invokes = 0;
    const upstreamTask = tool(async () => {
      invokes += 1;
      return {
        schema: "atlcli.research-packet-body/v1",
        answeredQuestion: "Bounded selected branch.",
        sourceIds: [],
        findingCandidates: [],
        relationshipCandidates: [],
        gaps: [],
        proposedFollowUps: [],
        coverageLimits: ["Synthetic active-graph admission proof."],
      };
    }, {
      name: "task",
      description: "Synthetic upstream task.",
      schema: z.object({ description: z.string(), subagent_type: z.string() }),
    });
    const middleware = createBoundedResearchSubagentMiddleware(
      model,
      graph,
      compileDynamicResearchSubagents(graph, {
        model,
        broker,
        question: request.question,
        maxInterpreterMs: 5_000,
        maxInterpreterMemoryBytes: 8_000_000,
        maxPtcCalls: 8,
        maxSearchPagesPerProduct: 2,
        maxDetailItemsPerProduct: 5,
        maxPacketChars: 8_000,
      }),
      {
        createSubAgentMiddleware: (() => ({ name: "subAgentMiddleware", tools: [upstreamTask] })) as never,
      },
      { activeGraph: () => activeGraph },
    );
    const taskTool = middleware.tools![0]!;
    const jiraTask = taskEnvelope(graph, "research-node:jira-research");
    const omittedJoin = taskEnvelope(graph, "research-node:cross-product-join");

    await expect(taskTool.invoke({
      description: jiraTask.description,
      subagent_type: jiraTask.subagentType,
    })).rejects.toMatchObject({ code: "graph-proposal-required" });
    expect(invokes).toBe(0);

    activeGraph = acceptResearchGraphProposalV1(
      graph,
      { schema: "atlcli.research-graph-proposal/v1", ...graphProposalInput(graph, selectedNodeIds) },
    );
    await expect(taskTool.invoke({
      description: omittedJoin.description,
      subagent_type: omittedJoin.subagentType,
    })).rejects.toMatchObject({ code: "unknown-task" });
    await expect(taskTool.invoke({
      description: jiraTask.description,
      subagent_type: jiraTask.subagentType,
    })).resolves.toBeDefined();
    expect(invokes).toBe(1);
  });

  test("runs independent native task calls concurrently before critique and synthesis", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const responseSchemas: unknown[] = [];
    const session = new ReplSession("research-dynamic-wave-contract", {
      captureConsole: false,
      subagentBridge: {
        maxConcurrency: 3,
        dispatch: async ({ subagentType, responseSchema }) => {
          responseSchemas.push(responseSchema);
          events.push(`start:${subagentType}`);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          events.push(`end:${subagentType}`);
          if (subagentType === "reconciler") {
            return { status: "satisfied", assessment: "covered", defects: [], suggestedRepairTasks: [] };
          }
          if (subagentType === "synthesizer") {
            return { summary: "final", findings: [], relationships: [], limitations: [] };
          }
          return { role: subagentType, summary: `${subagentType} evidence`, findings: [], limitations: [] };
        },
      },
    });
    const workerSchema = JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1);
    const critiqueSchema = JSON.stringify(RESEARCH_CRITIQUE_SCHEMA_V1);
    const finalSchema = JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1);

    try {
      const result = await session.eval(`
        const workerSchema = ${workerSchema};
        const critiqueSchema = ${critiqueSchema};
        const finalSchema = ${finalSchema};
        const packets = await Promise.all([
          task({ description: "Research Jira", subagentType: "focused-researcher", responseSchema: workerSchema }),
          task({ description: "Research Confluence", subagentType: "focused-researcher", responseSchema: workerSchema })
        ]);
        const critique = await task({
          description: "Critique " + JSON.stringify(packets),
          subagentType: "reconciler",
          responseSchema: critiqueSchema
        });
        const finalDraft = await task({
          description: "Synthesize " + JSON.stringify({ packets, critique }),
          subagentType: "synthesizer",
          responseSchema: finalSchema
        });
        finalDraft;
      `, 5_000);

      expect(result).toMatchObject({ ok: true, value: { summary: "final" } });
      expect(maxActive).toBe(2);
      expect(events.slice(0, 2).every((event) => event.startsWith("start:"))).toBe(true);
      expect(events.indexOf("start:reconciler")).toBeGreaterThan(events.lastIndexOf("end:focused-researcher"));
      expect(events.indexOf("start:synthesizer")).toBeGreaterThan(events.indexOf("end:reconciler"));
      expect(responseSchemas).toEqual([
        RESEARCH_WORKER_PACKET_SCHEMA_V1,
        RESEARCH_WORKER_PACKET_SCHEMA_V1,
        RESEARCH_CRITIQUE_SCHEMA_V1,
        RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
      ]);
    } finally {
      session.dispose();
      ReplSession.clearCache();
      ReplSession.resetSharedModule();
    }
  });

  test("does not expose catalog tools unless the graph explicitly grants them", () => {
    const graph = composeResearchGraphV1(graphBrief(
      "Find the project and space first.",
      ["jira", "confluence"],
      "analysis",
      "off",
    ));
    const names = graph.nodes.flatMap(researchPtcToolNamesForNodeV1);
    expect(names).not.toContain("jira_project_search");
    expect(names).not.toContain("wiki_space_search");
    expect(names).not.toContain("atlassian_reference_resolve");
  });

  test("projects only explicitly granted catalog tools into a dynamic node allowlist", async () => {
    expect(researchPtcToolNamesForNodeV1({
      grantedCapabilityIds: [
        "jira.issue.search",
        "jira.project.search",
        "atlassian.reference.resolve",
      ],
    })).toEqual([
      "jira_issue_search",
      "jira_project_search",
      "atlassian_reference_resolve",
    ]);

    const graph = composeResearchGraphV1(graphBrief(
      "Resolve one related Jira project without widening content scope.",
      ["jira"],
      "analysis",
      "off",
    ));
    const node: ResearchGraphNodeV1 = {
      ...graph.nodes.find((candidate) => candidate.roleId === "focused-researcher")!,
      grantedCapabilityIds: [
        "jira.project.search",
        "atlassian.reference.resolve",
      ],
    };
    const scopeCatalog = new ResearchScopeCatalogBroker({
      tenantOrigin: request.scope.siteOrigin,
      providers: {
        jira: {
          async listProjects() {
            return {
              candidates: [{
                schema: "atlcli.research-scope-candidate/v1",
                id: "research-scope-candidate:jira-project-related",
                tenantOrigin: request.scope.siteOrigin,
                product: "jira",
                entityKind: "project",
                entityRef: "research-scope-entity:jira-project-related",
                key: "RELATED",
                name: "Related project",
                status: "current",
                accessible: true,
                providerFreshnessAt: "2026-08-01T12:00:00.000Z",
              }],
            };
          },
        },
        confluence: { async listSpaces() { return { candidates: [] }; } },
        async resolveReference() { return undefined; },
      },
    });
    const session = new ReplSession("dynamic-node-catalog-grant", {
      tools: createResearchNodePtcToolsV1(
        node,
        broker,
        { broker: scopeCatalog, tenantOrigin: request.scope.siteOrigin },
      ),
      maxPtcCalls: 2,
      captureConsole: false,
    });
    try {
      const result = await session.eval(`
        const page = JSON.parse(await tools.jiraProjectSearch({}));
        ({
          names: Object.keys(tools).sort(),
          key: page.candidates[0].key,
          wikiToolType: typeof tools.wikiSpaceSearch,
          issueToolType: typeof tools.jiraIssueSearch
        });
      `, 5_000);
      expect(result).toMatchObject({
        ok: true,
        value: {
          names: ["atlassianReferenceResolve", "jiraProjectSearch"],
          key: "RELATED",
          wikiToolType: "undefined",
          issueToolType: "undefined",
        },
      });
    } finally {
      session.dispose();
      scopeCatalog.cancel();
    }
  });

  test("does not reference a detail capability removed by the host grant intersection", () => {
    const graph = composeResearchGraphV1(graphBrief(
      "List Jira tickets.",
      ["jira"],
      "analysis",
      "off",
    ), {
      grants: { "focused-researcher": ["jira.issue.search"] },
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 5,
      maxPacketChars: 8_000,
    });
    const jira = specs.find((spec) => spec.name === "focused-researcher-jira-research");

    expect(jira?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(jira?.systemPrompt).not.toContain("tools.jiraIssueGet");
    expect(jira?.systemPrompt).toContain("return no source-backed findings");
  });
});
