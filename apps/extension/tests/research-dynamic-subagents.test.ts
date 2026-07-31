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
import { ResearchCapabilityBroker, createResearchBriefV1 } from "@atlcli/research";
import {
  RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1,
} from "@atlcli/research";
import {
  buildDynamicSupervisorPrompt,
  researchRecursionLimitV1,
  runResearchAgent,
} from "@atlcli/research/browser/agent";
import {
  RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
  RESEARCH_CRITIQUE_SCHEMA_V1,
  RESEARCH_WORKER_PACKET_SCHEMA_V1,
  buildResearchAcquisitionProgram,
  compileDynamicResearchSubagents,
  createBoundedResearchSubagentMiddleware,
  providerCompatibleResearchSchema,
  responseSchemaForResearchRole,
} from "@atlcli/research/browser/agent";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { createMemoryResearchWorkspace } from "@atlcli/research";
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
  return composeResearchGraphV1(graphBrief(
    "Get the exact bounded Jira item.",
    ["jira"],
    "lookup",
    "off",
  ));
}

function jiraAndSynthesisGraph(): ResearchGraphV1 {
  return composeResearchGraphV1(graphBrief(
    "Analyze bounded Jira work.",
    ["jira"],
    "analysis",
    "off",
  ));
}

test("derives a bounded LangGraph super-step allowance from the admitted workflow", () => {
  expect(researchRecursionLimitV1()).toBe(24);
  expect(researchRecursionLimitV1(synthesisOnlyGraph())).toBe(40);
  expect(researchRecursionLimitV1(crossProductGraph())).toBe(64);
});

test("repairs one synthesizer schema failure and fails fast after the bounded retry", async () => {
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
    description: "Write the report.",
    subagent_type: "synthesizer",
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
    description: "Write the report.",
    subagent_type: "synthesizer",
  })).rejects.toThrow("structured output");
  expect(invokes).toBe(2);
  expect(fatal).toBeInstanceOf(Error);
});

test("repairs a provider-shaped synthesizer result rejected by the authoritative host schema", async () => {
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
    description: "Write the report.",
    subagent_type: "synthesizer",
  })).resolves.toBe(validDraft);
  expect(invokes).toBe(2);
  expect(diagnostics).toEqual(["started", "repairing", "completed"]);
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
      "focused-researcher",
      "document-distiller",
      "coverage-moderator",
      "reconciler",
      "synthesizer",
    ]);
    expect(specs.every((spec) => spec.tools?.length === 0)).toBe(true);
    expect(specs[0]?.middleware).toHaveLength(1);
    expect(specs[1]?.middleware).toHaveLength(0);
    expect(specs[2]?.middleware).toHaveLength(0);
    expect(specs[3]?.middleware).toHaveLength(0);
    expect(specs[4]?.middleware).toHaveLength(0);
    expect(specs.every((spec) => !("responseFormat" in spec))).toBe(true);
    expect(specs[0]?.systemPrompt).toContain("exactly two bounded stages");
    expect(specs[0]?.systemPrompt).toContain("Inspect every returned candidate summary");
    expect(specs[0]?.systemPrompt).toContain("Search summaries are screening evidence only");
    expect(specs[0]?.systemPrompt).toContain("at most 8 selected candidates");
    expect(specs[0]?.systemPrompt).toContain("Make exactly one eval call");
    expect(specs[0]?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(specs[4]?.systemPrompt).toContain("sole report author");
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
    const focused = specs.find((spec) => spec.name === "focused-researcher");

    expect(focused?.systemPrompt).toContain("partial-title-query-set");
    expect(focused?.systemPrompt).toContain("catch { failures += 1; }");
    expect(focused?.systemPrompt).toContain('["One", "Two", "Three", "Four"]');
    expect(focused?.systemPrompt).toContain("queryText: group.text");
    expect(focused?.systemPrompt).toContain("const chosen = exact ?? matches[0]");
    expect(focused?.systemPrompt).toContain(
      'const requiredQueryTexts = ["One","Two","Three","Four"];'
    );
    expect(focused?.systemPrompt).toContain(
      "Do not omit, rewrite, or reorder requiredQueryTexts"
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

    expect(prompt).toContain("Write the JavaScript yourself for this question");
    expect(prompt).toContain("Promise.all groups of at most 3");
    expect(prompt).toContain("Execute only the host-admitted graph nodes");
    expect(prompt).toContain("focused-researcher acquires Jira or Confluence evidence");
    expect(prompt).toContain("Every task call must include its appropriate responseSchema");
    expect(prompt).toContain("exactly one fresh-context independent critic");
    expect(prompt).toContain("Do not repeat focused-researcher nodes");
    expect(prompt).toContain("exactly one synthesizer as the final task");
    expect(prompt).toContain("copy that object unchanged");
    expect(prompt).toContain("do not execute a fixed all-roles pipeline");
    expect(prompt).not.toContain("paste verbatim");
    expect(prompt).not.toContain("Normative workflow program");
    expect(
      ((RESEARCH_CRITIQUE_SCHEMA_V1.properties as Record<string, unknown>).suggestedRepairTasks as {
        items: { properties: { subagentType: { enum: string[] } } };
      }).items.properties.subagentType.enum,
    ).toEqual(["document-distiller", "contradiction-verifier"]);
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

    const workspace = createMemoryResearchWorkspace();
    const eventKinds: string[] = [];
    const report = await runResearchAgent({
      model: dynamicModel,
      request,
      providers: {
        jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
        wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
      },
      researchGraph: synthesisOnlyGraph(),
      runId: "dynamic-native-task-invocation",
      workspace,
      options: { onEvent: (event) => eventKinds.push(event.kind) },
    });

    expect(report.title).toBe(draft.title);
    expect(report.markdown).toContain(
      "No non-empty, non-truncated detail evidence supported a publishable finding"
    );
    expect(report.markdown).not.toContain(draft.executiveSummary);
    expect(await workspace.readFile("/artifacts/report.md")).toBe(report.markdown);
    expect(JSON.parse((await workspace.readFile("/session/request.json"))!)).toMatchObject({
      runId: "dynamic-native-task-invocation",
      request: { schema: "atlcli.research-request/v1" },
    });
    expect(eventKinds).toEqual([
      "phase", "progress",
      "phase", "progress",
      "decision",
      "subagent", "subagent",
      "decision",
      "phase", "progress",
      "decision", "decision",
      "artifact",
      "phase", "progress",
    ]);
    expect(dynamicModel.callCount).toBe(3);
    expect(dynamicModel.calls[0]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("empty accepted packet set"))).toBe(true);
    expect(dynamicModel.calls[1]?.messages.some((message) => message.text.includes("Run this as a workflow"))).toBe(false);
  });

  test("coalesces duplicate singleton retrieval dispatches before model or provider work", async () => {
    const packet = {
      role: "coverage-moderator",
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
        task({ description: "Run singleton coverage check A.", subagentType: "coverage-moderator", responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)} }),
        task({ description: "Run singleton coverage check B.", subagentType: "coverage-moderator", responseSchema: ${JSON.stringify(RESEARCH_ANALYSIS_PACKET_SCHEMA_V1)} })
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
      .respondWithTools([{ name: "AtlcliResearchAnalysisPacketV1", args: packet }])
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
      researchGraph: crossProductGraph(),
      runId: "dynamic-singleton-coalescing",
      onSubagentDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.role}:${diagnostic.status}`),
    });

    expect(report.title).toBe(draft.title);
    expect(dynamicModel.callCount).toBe(4);
    expect(dynamicModel.calls.filter((call) => call.messages.some((message) => message.text.includes("Run singleton coverage check")))).toHaveLength(1);
    expect(diagnostics).toEqual([
      "coverage-moderator:started",
      "coverage-moderator:coalesced",
      "coverage-moderator:completed",
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
    expect(specs.flatMap((spec) => spec.tools?.map((candidate) => candidate.name) ?? [])).not.toContain("jira_project_search");
    expect(specs.flatMap((spec) => spec.tools?.map((candidate) => candidate.name) ?? [])).not.toContain("wiki_space_search");
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
    const jira = specs.find((spec) => spec.name === "focused-researcher");

    expect(jira?.systemPrompt).toContain("tools.jiraIssueSearch");
    expect(jira?.systemPrompt).not.toContain("tools.jiraIssueGet");
    expect(jira?.systemPrompt).toContain("return no source-backed findings");
  });
});
