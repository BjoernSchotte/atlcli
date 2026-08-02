import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import {
  RESEARCH_ONE_SHOT_REQUEST_PATH_V1,
  RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1,
  createMemoryResearchWorkspace,
  createResearchBriefV1,
  encodeResearchTaskDescriptionV1,
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
