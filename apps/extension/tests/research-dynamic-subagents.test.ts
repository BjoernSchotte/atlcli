import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { fakeModel } from "@langchain/core/testing";
import { tool } from "@langchain/core/tools";
import { ReplSession, validateResponseSchema } from "@langchain/quickjs";
import {
  RESEARCH_GRAPH_SCHEMA_V1,
  composeResearchGraphV1,
  type ResearchBriefV1,
  type ResearchGraphV1,
} from "@atlcli/research/graph";
import { ResearchCapabilityBroker } from "../utils/research/broker.js";
import {
  RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
} from "../utils/research/agent-draft.js";
import {
  buildDynamicSupervisorPrompt,
  runResearchAgent,
} from "../utils/research/agent-runtime.js";
import {
  RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
  RESEARCH_CRITIQUE_SCHEMA_V1,
  RESEARCH_WORKER_PACKET_SCHEMA_V1,
  buildResearchAcquisitionProgram,
  compileDynamicResearchSubagents,
  providerCompatibleResearchSchema,
  responseSchemaForResearchRole,
} from "../utils/research/dynamic-subagents.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
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
  const brief: ResearchBriefV1 = {
    schema: "atlcli.research-brief/v1",
    question: request.question,
    products: ["jira", "confluence"],
    effort: "deep",
    reconciliation: "auto",
  };
  return composeResearchGraphV1(brief);
}

function synthesisOnlyGraph(): ResearchGraphV1 {
  return {
    schema: RESEARCH_GRAPH_SCHEMA_V1,
    briefRevision: 1,
    graphRevision: 1,
    nodes: [{
      id: "research-node:synthesizer",
      role: "synthesizer",
      dependsOn: [],
      requestedCapabilityIds: [],
      grantedCapabilityIds: [],
      depth: 0,
      phase: "synthesis",
    }],
    selectedRoleIds: ["synthesizer"],
    maxResearchWaves: 2,
    maxReconciliationWaves: 1,
  };
}

function jiraAndSynthesisGraph(): ResearchGraphV1 {
  return {
    schema: RESEARCH_GRAPH_SCHEMA_V1,
    briefRevision: 1,
    graphRevision: 1,
    nodes: [
      {
        id: "research-node:jira-retrieval",
        role: "jira-retrieval",
        dependsOn: [],
        requestedCapabilityIds: ["jira.issue.search", "jira.issue.get"],
        grantedCapabilityIds: ["jira.issue.search", "jira.issue.get"],
        depth: 0,
        phase: "research",
      },
      {
        id: "research-node:synthesizer",
        role: "synthesizer",
        dependsOn: ["research-node:jira-retrieval"],
        requestedCapabilityIds: [],
        grantedCapabilityIds: [],
        depth: 0,
        phase: "synthesis",
      },
    ],
    selectedRoleIds: ["jira-retrieval", "synthesizer"],
    maxResearchWaves: 2,
    maxReconciliationWaves: 1,
  };
}

describe("dynamic DeepAgentsJS subagent composition", () => {
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
    expect(responseSchemaForResearchRole("jira-retrieval")).toBe(RESEARCH_WORKER_PACKET_SCHEMA_V1);
    expect(responseSchemaForResearchRole("cross-product-join")).toBe(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1);
    expect(responseSchemaForResearchRole("verification")).toBe(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1);
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
      maxPacketChars: 8_000,
    });

    expect(specs.map((spec) => spec.name)).toEqual([
      "jira-retrieval",
      "wiki-retrieval",
      "cross-product-join",
      "reconciler",
      "synthesizer",
    ]);
    expect(specs.every((spec) => spec.tools?.length === 0)).toBe(true);
    expect(specs[0]?.middleware).toHaveLength(1);
    expect(specs[1]?.middleware).toHaveLength(1);
    expect(specs[2]?.middleware).toHaveLength(0);
    expect(specs[3]?.middleware).toHaveLength(0);
    expect(specs[4]?.middleware).toHaveLength(0);
    expect(specs.every((spec) => !("responseFormat" in spec))).toBe(true);
    expect(specs[0]?.systemPrompt).toContain("exactly two bounded stages");
    expect(specs[0]?.systemPrompt).toContain("Inspect every returned candidate summary");
    expect(specs[0]?.systemPrompt).toContain("Search summaries are screening evidence only");
    expect(specs[0]?.systemPrompt).toContain("at most 8 selected candidates");
    expect(specs[1]?.systemPrompt).toContain("Make exactly one eval call");
    expect(specs[0]?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(specs[4]?.systemPrompt).toContain("sole report author");
  });

  test("preserves successful named-page searches when a later bounded query fails", () => {
    const question = "Compare “One”, “Two”, “Three”, and “Four” with Jira.";
    const graph = composeResearchGraphV1({
      schema: "atlcli.research-brief/v1",
      question,
      products: ["jira", "confluence"],
      effort: "standard",
      reconciliation: "auto",
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxPacketChars: 8_000,
    });
    const wiki = specs.find((spec) => spec.name === "wiki-retrieval");
    const jira = specs.find((spec) => spec.name === "jira-retrieval");

    expect(wiki?.systemPrompt).toContain("partial-title-query-set");
    expect(wiki?.systemPrompt).toContain("catch { failures += 1; }");
    expect(wiki?.systemPrompt).toContain('["One", "Two", "Three", "Four"]');
    expect(wiki?.systemPrompt).toContain("queryText: group.text");
    expect(wiki?.systemPrompt).toContain("const chosen = exact ?? matches[0]");
    expect(jira?.systemPrompt).toContain(
      'const requiredQueryTexts = ["One","Two","Three","Four"];'
    );
    expect(jira?.systemPrompt).toContain(
      "Do not omit, rewrite, or reorder requiredQueryTexts"
    );
  });

  test("executes four named-page searches and reads one opaque detail per query", async () => {
    const question = "Compare “One”, “Two”, “Three”, and “Four” with Jira.";
    const graph = composeResearchGraphV1({
      schema: "atlcli.research-brief/v1",
      question,
      products: ["jira", "confluence"],
      effort: "standard",
      reconciliation: "auto",
    });
    const wikiNode = graph.nodes.find((node) => node.role === "wiki-retrieval")!;
    const detailRefs: string[] = [];
    const session = new ReplSession("research-named-page-acquisition", {
      captureConsole: false,
      maxPtcCalls: 8,
      tools: [
        tool(async ({ query }) => JSON.stringify({
          items: [{
            title: `RCM — ${query.text}`,
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
      const result = await session.eval(buildResearchAcquisitionProgram(wikiNode, question), 5_000);
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

  test("instructs the supervisor to generate task-shaped parallel waves and delegate final authorship", () => {
    const prompt = buildDynamicSupervisorPrompt(crossProductGraph());

    expect(prompt).toContain("Write the JavaScript yourself for this question");
    expect(prompt).toContain("Promise.all groups of at most three tasks");
    expect(prompt).toContain("at most one jira-retrieval task and at most one wiki-retrieval task");
    expect(prompt).toContain("run wiki-retrieval first");
    expect(prompt).toContain("include its compact packet in the jira-retrieval task description");
    expect(prompt).toContain("Every task call must include its appropriate responseSchema");
    expect(prompt).toContain("exactly one fresh-context independent critic");
    expect(prompt).toContain("do not repeat jira-retrieval or wiki-retrieval");
    expect(prompt).toContain("exactly one synthesizer as the final task");
    expect(prompt).toContain("copy that object unchanged");
    expect(prompt).toContain("do not execute a fixed all-roles pipeline");
    expect(prompt).not.toContain("paste verbatim");
    expect(prompt).not.toContain("Normative workflow program");
    expect(
      ((RESEARCH_CRITIQUE_SCHEMA_V1.properties as Record<string, unknown>).suggestedRepairTasks as {
        items: { properties: { subagentType: { enum: string[] } } };
      }).items.properties.subagentType.enum,
    ).toEqual(["cross-product-join", "verification"]);
  });

  test("uses one createDeepAgent invocation and native task dispatch for final synthesis", async () => {
    const draft = {
      title: "Synthetic workflow report",
      executiveSummary: "The bounded workflow completed without source findings.",
      findings: [],
      relationships: [],
      limitations: ["This characterization run intentionally has no source data."],
    };
    const code = `
      const finalDraft = await task({
        description: "Write the final bounded report from an empty accepted packet set.",
        subagentType: "synthesizer",
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code } }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);

    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: synthesisOnlyGraph(),
      runId: "dynamic-native-task-invocation",
    });

    expect(report.title).toBe(draft.title);
    expect(report.markdown).toContain(
      "No non-empty, non-truncated detail evidence supported a publishable finding"
    );
    expect(report.markdown).not.toContain(draft.executiveSummary);
    expect(dynamicModel.callCount).toBe(3);
    expect(dynamicModel.calls[0]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("empty accepted packet set"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(false);
  });

  test("coalesces duplicate singleton retrieval dispatches before model or provider work", async () => {
    const packet = {
      role: "jira-retrieval",
      summary: "One bounded Jira packet.",
      findings: [],
      limitations: [],
    };
    const draft = {
      title: "Coalesced workflow report",
      executiveSummary: "Duplicate singleton dispatches used one acquisition result.",
      findings: [],
      relationships: [],
      limitations: [],
    };
    const code = `
      const packets = await Promise.all([
        task({ description: "Run singleton acquisition A.", subagentType: "jira-retrieval", responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)} }),
        task({ description: "Run singleton acquisition B.", subagentType: "jira-retrieval", responseSchema: ${JSON.stringify(RESEARCH_WORKER_PACKET_SCHEMA_V1)} })
      ]);
      const finalDraft = await task({
        description: "Synthesize " + JSON.stringify(packets),
        subagentType: "synthesizer",
        responseSchema: ${JSON.stringify(RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1)}
      });
      finalDraft;
    `;
    const dynamicModel = fakeModel()
      .respondWithTools([{ name: "eval", args: { code } }])
      .respondWithTools([{ name: "AtlcliResearchWorkerPacketV1", args: packet }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
      .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
    const diagnostics: string[] = [];

    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { throw new Error("model skipped PTC"); }, async getIssue() { throw new Error("model skipped PTC"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: jiraAndSynthesisGraph(),
      runId: "dynamic-singleton-coalescing",
      onSubagentDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.role}:${diagnostic.status}`),
    });

    expect(report.title).toBe(draft.title);
    expect(dynamicModel.callCount).toBe(4);
    expect(dynamicModel.calls.filter((call) => call.messages.some((message) => message.text.includes("Run singleton acquisition")))).toHaveLength(1);
    expect(diagnostics).toEqual([
      "jira-retrieval:started",
      "jira-retrieval:coalesced",
      "jira-retrieval:completed",
      "synthesizer:started",
      "synthesizer:completed",
    ]);
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
          task({ description: "Research Jira", subagentType: "jira-retrieval", responseSchema: workerSchema }),
          task({ description: "Research Confluence", subagentType: "wiki-retrieval", responseSchema: workerSchema })
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
      expect(events.indexOf("start:reconciler")).toBeGreaterThan(events.indexOf("end:jira-retrieval"));
      expect(events.indexOf("start:reconciler")).toBeGreaterThan(events.indexOf("end:wiki-retrieval"));
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
    const graph = composeResearchGraphV1({
      schema: "atlcli.research-brief/v1",
      question: "Find the project and space first.",
      products: ["jira", "confluence"],
      effort: "shallow",
      reconciliation: "off",
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxPacketChars: 8_000,
    });
    expect(specs.flatMap((spec) => spec.tools?.map((candidate) => candidate.name) ?? [])).not.toContain("jira_project_search");
    expect(specs.flatMap((spec) => spec.tools?.map((candidate) => candidate.name) ?? [])).not.toContain("wiki_space_search");
  });

  test("does not reference a detail capability removed by the host grant intersection", () => {
    const graph = composeResearchGraphV1({
      schema: "atlcli.research-brief/v1",
      question: "List Jira tickets.",
      products: ["jira"],
      effort: "shallow",
      reconciliation: "off",
    }, {
      grants: { "jira-retrieval": ["jira.issue.search"] },
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      question: request.question,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxPacketChars: 8_000,
    });
    const jira = specs.find((spec) => spec.name === "jira-retrieval");

    expect(jira?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(jira?.systemPrompt).not.toContain("tools.jiraIssueGet");
    expect(jira?.systemPrompt).toContain("return no source-backed findings");
  });
});
