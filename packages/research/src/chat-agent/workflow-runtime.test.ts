import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { ResearchCapabilityBroker } from "../broker.js";
import { ResearchModelRunBudget, ResearchRunBudget } from "../budget.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchRequestV1,
} from "../contracts.js";
import { DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY } from "../dispatch-adapter.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import type { ChatWorkflowDispatchV1 } from "./workflow.js";
import {
  providerCompatibleChatJsonSchemaV1,
  type ChatAgentDraftV1,
} from "./contracts.js";
import type { ChatCandidateLedgerControllerV1 } from "./retrieval-plan.js";
import {
  ChatCandidateLedgerControllerV1 as CandidateLedgerController,
  createChatRetrievalPlanV1,
} from "./retrieval-plan.js";
import { createChatPtcToolsV1 } from "./retrieval.js";
import type { ChatQualityDispositionV1 } from "./quality.js";
import {
  CHAT_WORKFLOW_STATE_PATH_V1,
  createChatAgenticWorkflowRuntimeV1,
  createPlannedSearchAcquisitionToolV1,
  normalizeKnownSourceReferencesV1,
  type ChatSubagentEvalDiagnosticV1,
  type ChatSubagentModelStreamEventV1,
} from "./workflow-runtime.js";

const strategy: ChatStrategyDecisionV1 = {
  schema: "atlcli.chat-strategy-decision/v1",
  qualityMode: "deep",
  execution: "agentic",
  reasonCodes: ["multi-source-comparison"],
  ambiguityDisposition: "none",
  requiredCapabilities: ["comparison-analysis"],
  expectedComplexity: "complex",
  qualityRisks: ["multiple-sources"],
};

const request: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: "Compare the two bounded synthetic positions.",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: [],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 30_000 },
  wikiProvider: "rest",
};

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

function analysisPacket() {
  return {
    schema: "atlcli.chat-analysis-packet/v1",
    claimRefs: [],
    relationshipRefs: [],
    contradictions: [],
    gaps: [],
  };
}

function answerDraft() {
  return {
    messageMarkdown: "A bounded synthetic answer.",
    citationSourceIds: [],
    gaps: [],
  };
}

function critiquePacket() {
  return {
    schema: "atlcli.chat-critique-packet/v1" as const,
    defects: [],
    readyForSynthesis: true,
  };
}

function qualityWorkflowTasks(
  leading: Array<{
    taskId: string;
    profileId:
      | "relationship-tracer"
      | "comparison-analyst"
      | "contradiction-checker";
    objective: string;
    dependencyTaskIds: string[];
  }>,
) {
  const leadingIds = leading.map((task) => task.taskId);
  return [
    ...leading,
    {
      taskId: "task:draft",
      profileId: "answer-drafter" as const,
      objective: "Draft a provisional answer.",
      dependencyTaskIds: leadingIds,
    },
    {
      taskId: "task:critic",
      profileId: "answer-critic" as const,
      objective: "Critique the provisional answer.",
      dependencyTaskIds: ["task:draft"],
    },
    {
      taskId: "task:synth",
      profileId: "chat-synthesizer" as const,
      objective: "Write the accepted answer.",
      dependencyTaskIds: ["task:critic"],
    },
  ];
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function analysisPacketNearBytes(targetBytes: number) {
  const packet = {
    ...analysisPacket(),
    contradictions: [] as Array<{ summary: string; sourceIds: string[] }>,
  };
  for (let index = 0; index < 40; index += 1) {
    let acceptedSummary: string | undefined;
    for (let length = 800; length >= 1; length -= 1) {
      const summary = `${index}:`.padEnd(length, "x");
      const candidate = {
        ...packet,
        contradictions: [
          ...packet.contradictions,
          { summary, sourceIds: [] },
        ],
      };
      if (serializedBytes(candidate) <= targetBytes) {
        acceptedSummary = summary;
        break;
      }
    }
    if (!acceptedSummary) break;
    packet.contradictions.push({ summary: acceptedSummary, sourceIds: [] });
  }
  return packet;
}

function requireDispatch(
  dispatches: ReadonlyMap<string, ChatWorkflowDispatchV1>,
  taskId: string,
): ChatWorkflowDispatchV1 {
  const dispatch = dispatches.get(taskId);
  if (!dispatch) {
    throw new Error(`Missing test dispatch: ${taskId}`);
  }
  return dispatch;
}

function createHarness(input: {
  invoke?(
    input: { description: string; subagent_type: string },
    config?: RunnableConfig,
  ): Promise<unknown>;
  beforeSynthesis?: () => void;
  modelForPreference?: (preference: "fast" | "balanced" | "thorough") => BaseChatModel;
  structuredOutput?: "native" | "tool";
  projectResponseSchema?: (
    schema: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  onEvalDiagnostic?: (diagnostic: ChatSubagentEvalDiagnosticV1) => void;
  onModelStreamEvent?: (event: ChatSubagentModelStreamEventV1) => void;
  searchProducts?: Array<"jira" | "confluence">;
  withRetrievalAssessment?: boolean;
  searchExhaustedWithoutCandidates?: boolean;
  searchPlanSaturated?: boolean;
  strategyReviewCurrent?: () => boolean;
  decideRepairAdmission?: (
    disposition: ChatQualityDispositionV1,
  ) => { admit: boolean; reason?: "deadline-reserve" | "model-budget-reserve" };
} = {}) {
  const budget = new ResearchRunBudget(request.limits);
  const modelBudget = new ResearchModelRunBudget(request.limits);
  const broker = new ResearchCapabilityBroker(request, providers, { budget });
  const workspace = createMemoryResearchWorkspace();
  let compiledSubagents: Array<{
    name: string;
    model?: BaseChatModel;
    systemPrompt?: string;
    tools?: unknown[];
    middleware?: Array<{
      name?: string;
      tools?: Array<{ name: string }>;
      wrapToolCall?: (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown>;
    }>;
  }> = [];
  const invoke = input.invoke ?? (async (taskInput: {
    description: string;
    subagent_type: string;
  }) => taskInput.subagent_type === "chat-synthesizer-v1" ||
      taskInput.subagent_type === "chat-answer-drafter-v1" ||
      taskInput.subagent_type === "chat-answer-repairer-v1"
    ? answerDraft()
    : taskInput.subagent_type === "chat-answer-critic-v1"
      ? critiquePacket()
      : analysisPacket());
  const upstreamTask = tool((taskInput, config) => invoke(taskInput, config), {
    name: "task",
    description: "synthetic upstream task",
    schema: z.object({
      description: z.string(),
      subagent_type: z.string(),
    }).strict(),
  });
  const runtime = createChatAgenticWorkflowRuntimeV1({
    runtime: {
      createSubAgentMiddleware: ((options: { subagents?: typeof compiledSubagents }) => {
        compiledSubagents = options.subagents ?? [];
        return { name: "subAgentMiddleware", tools: [upstreamTask] };
      }) as never,
    },
    model: {} as BaseChatModel,
    ...(input.modelForPreference
      ? { modelForPreference: input.modelForPreference }
      : {}),
    structuredOutput: input.structuredOutput ?? "tool",
    ...(input.projectResponseSchema
      ? { projectResponseSchema: input.projectResponseSchema }
      : {}),
    strategy,
    budget,
    modelBudget,
    onModelBudgetSnapshot: async () => {},
    broker,
    workspace,
    conversationId: "chat-conversation:workflow",
    turnId: "chat-turn:workflow",
    question: request.question,
    siteOrigin: request.scope.siteOrigin,
    taskContext: JSON.stringify({ question: request.question }),
    limits: request.limits,
    locale: "de-DE",
    exactContextProducts: [],
    searchProducts: input.searchProducts ?? [],
    boundProjectKeys: [],
    boundSpaceKeys: [],
    signal: new AbortController().signal,
    ...(input.strategyReviewCurrent
      ? { strategyReviewCurrent: input.strategyReviewCurrent }
      : {}),
    beforeSynthesis: input.beforeSynthesis,
    ...(input.decideRepairAdmission
      ? { decideRepairAdmission: input.decideRepairAdmission }
      : {}),
    ...(input.withRetrievalAssessment
      ? {
          retrievalLedger: {
            plan: () => ({
              searches: (input.searchProducts ?? []).map((product) => ({
                product,
                maxPages: 1,
              })),
            }),
            allowedInitialQueries: () => [{ text: "synthetic" }],
            assertToolInput: () => {},
            observe: async () => {},
            isSearchExhaustedWithoutCandidates: () =>
              input.searchExhaustedWithoutCandidates === true,
            isSearchPlanSaturated: () => input.searchPlanSaturated === true,
            assessment: () => ({
              schema: "atlcli.chat-retrieval-assessment/v1",
              sufficient: true,
              reasons: [],
              completionSignals: [],
              metrics: {
                discoveredCandidates: 0,
                admittedCandidates: 0,
                detailReadCandidates: 0,
                excludedCandidates: 0,
                deferredCandidates: 0,
                detailReadCoverage: 1,
                canonicalUrlCorrectness: 1,
                observedRecall: null,
                wrongSourceRate: null,
                atlassianHttpCalls: 0,
                latencyMs: 0,
              },
            }),
          } as unknown as ChatCandidateLedgerControllerV1,
        }
      : {}),
    ...(input.onEvalDiagnostic ? { onEvalDiagnostic: input.onEvalDiagnostic } : {}),
    ...(input.onModelStreamEvent ? { onModelStreamEvent: input.onModelStreamEvent } : {}),
  });
  return { runtime, workspace, compiledSubagents };
}

async function invokeDispatch(
  runtime: ReturnType<typeof createHarness>["runtime"],
  dispatch: {
    description: string;
    subagentType: string;
    responseSchema: Readonly<Record<string, unknown>>;
  },
): Promise<unknown> {
  const taskTool = runtime.middleware.tools?.find((candidate) => candidate.name === "task");
  if (!taskTool) throw new Error("missing bounded task");
  return taskTool.invoke({
    description: dispatch.description,
    subagent_type: dispatch.subagentType,
  }, {
    configurable: {
      [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: dispatch.responseSchema,
    },
  });
}

async function invokeQualityReview(
  runtime: ReturnType<typeof createHarness>["runtime"],
): Promise<{
  dispatches: ChatWorkflowDispatchV1[];
  requiredGapCodes: string[];
}> {
  return JSON.parse(await runtime.qualityReviewTool.invoke({}));
}

describe("Chat agentic workflow runtime", () => {
  test("normalizes only aliases of detail-read sources to canonical source ids", () => {
    const broker = {
      detailEvidenceLedger: () => [{
        source: {
          id: "jira:DEMO-1",
          product: "jira",
          title: "Synthetic implementation",
          url: "https://tenant-a.atlassian.net/browse/DEMO-1",
          issueKey: "DEMO-1",
          projectKey: "DEMO",
        },
      }],
    } as ResearchCapabilityBroker;
    const normalized = normalizeKnownSourceReferencesV1(broker, {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: ["DEMO-1", "UNKNOWN-2"],
      claims: [{ text: "Synthetic claim", sourceIds: ["DEMO-1"] }],
      relationships: [{
        fromSourceId: "https://tenant-a.atlassian.net/browse/DEMO-1",
        toSourceId: "UNKNOWN-2",
        kind: "mentions",
        support: "Synthetic support",
      }],
      gaps: [],
    });
    expect(normalized).toMatchObject({
      sourceIds: ["jira:DEMO-1", "UNKNOWN-2"],
      claims: [{ sourceIds: ["jira:DEMO-1"] }],
      relationships: [{
        fromSourceId: "jira:DEMO-1",
        toSourceId: "UNKNOWN-2",
      }],
    });
  });

  test("compiles all ten depth-one profiles without a general-purpose or nested task surface", () => {
    const harness = createHarness({ invoke: async () => analysisPacket() });
    expect(harness.compiledSubagents.map((entry) => entry.name)).toEqual([
      "chat-exact-context-reader-v1",
      "chat-confluence-search-reader-v1",
      "chat-jira-search-reader-v1",
      "chat-relationship-tracer-v1",
      "chat-comparison-analyst-v1",
      "chat-contradiction-checker-v1",
      "chat-answer-drafter-v1",
      "chat-answer-critic-v1",
      "chat-answer-repairer-v1",
      "chat-synthesizer-v1",
    ]);
    for (const subagent of harness.compiledSubagents) {
      expect(subagent.tools ?? []).toEqual([]);
      expect((subagent.middleware ?? []).flatMap((entry) => entry.tools ?? [])
        .some((entry) => entry.name === "task")).toBe(false);
    }
    const confluenceReader = harness.compiledSubagents.find(
      (entry) => entry.name === "chat-confluence-search-reader-v1",
    );
    expect(confluenceReader?.systemPrompt).toContain("exactly one focused initial search query");
    expect(confluenceReader?.systemPrompt).toContain("return an explicit gap");
    expect(confluenceReader?.systemPrompt).not.toContain("wiki_search");
    expect(harness.compiledSubagents.find((entry) =>
      entry.name === "chat-synthesizer-v1"
    )?.systemPrompt).toContain("[[source:SOURCE_ID]]");
  });

  test("binds every child to its host-owned provider-neutral model preference", () => {
    const fast = { preference: "fast" } as unknown as BaseChatModel;
    const balanced = { preference: "balanced" } as unknown as BaseChatModel;
    const thorough = { preference: "thorough" } as unknown as BaseChatModel;
    const selected = { fast, balanced, thorough };
    const harness = createHarness({
      modelForPreference: (preference) => selected[preference],
    });
    const byName = new Map(
      harness.compiledSubagents.map((entry) => [entry.name, entry.model]),
    );
    expect(byName.get("chat-confluence-search-reader-v1")).toBe(fast);
    expect(byName.get("chat-jira-search-reader-v1")).toBe(fast);
    expect(byName.get("chat-comparison-analyst-v1")).toBe(balanced);
    expect(byName.get("chat-answer-critic-v1")).toBe(balanced);
    expect(byName.get("chat-synthesizer-v1")).toBe(balanced);
  });

  test("streams body-free child eval lifecycle and terminates a looping ninth reader eval", async () => {
    const diagnostics: ChatSubagentEvalDiagnosticV1[] = [];
    const harness = createHarness({
      onEvalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      searchProducts: ["confluence"],
    });
    const reader = harness.compiledSubagents.find(
      (entry) => entry.name === "chat-confluence-search-reader-v1",
    );
    expect(reader?.systemPrompt).toContain("wikiSearch");
    const guard = reader?.middleware?.find((entry) => entry.wrapToolCall !== undefined);
    if (!guard?.wrapToolCall) throw new Error("missing child eval guard");
    const request = {
      toolCall: {
        name: "eval",
        args: { code: "await tools.wikiSearch({ query: { text: 'design' } });" },
      },
    };
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(guard.wrapToolCall(request, async () => ({ content: `step ${attempt}` })))
        .resolves.toEqual({ content: `step ${attempt}` });
    }
    const terminal = await guard.wrapToolCall({
      toolCall: { ...request.toolCall, id: "eval:ninth" },
    }, async () => ({ content: "ignored" }));
    expect(terminal).toBeInstanceOf(ToolMessage);
    expect((terminal as ToolMessage).content).toContain("EVAL_LIMIT_REACHED");
    expect(diagnostics.filter((entry) => entry.status === "started")
      .map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(diagnostics[0]).toMatchObject({
      profileId: "confluence-search-reader",
      status: "started",
      attempt: 1,
      capabilityNames: ["wikiSearch"],
      argumentKeys: ["query", "text"],
    });
    expect(diagnostics.at(-1)).toEqual({
      profileId: "confluence-search-reader",
      status: "error",
      attempt: 9,
      errorCode: "eval-attempt-exceeded",
    });
  });

  test("turns a terminal empty search into one structured stop instruction without another eval", async () => {
    const diagnostics: ChatSubagentEvalDiagnosticV1[] = [];
    const harness = createHarness({
      onEvalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      searchProducts: ["confluence"],
      withRetrievalAssessment: true,
      searchExhaustedWithoutCandidates: true,
    });
    const reader = harness.compiledSubagents.find(
      (entry) => entry.name === "chat-confluence-search-reader-v1",
    );
    const guard = reader?.middleware?.find((entry) => entry.wrapToolCall !== undefined);
    if (!guard?.wrapToolCall) throw new Error("missing child eval guard");
    let invoked = false;
    const result = await guard.wrapToolCall({
      toolCall: {
        id: "eval:terminal",
        name: "eval",
        args: { code: "await tools.wikiSearch({ query: { text: 'invented' } });" },
      },
    }, async () => {
      invoked = true;
      return { content: "should not run" };
    });
    expect(invoked).toBe(false);
    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toContain("SEARCH_PLAN_COMPLETE_WITHOUT_CANDIDATES");
    expect(diagnostics).toEqual([{
      profileId: "confluence-search-reader",
      status: "success",
      attempt: 1,
    }]);
  });

  test("bundles an admitted search, ranking, and detail path behind one reader capability", async () => {
    const harness = createHarness({
      searchProducts: ["confluence"],
      withRetrievalAssessment: true,
    });
    const reader = harness.compiledSubagents.find(
      (entry) => entry.name === "chat-confluence-search-reader-v1",
    );
    expect(reader?.systemPrompt).toContain("chatRetrievalAcquire");
    expect(reader?.systemPrompt).not.toContain("wikiSearch");
    const evaluator = reader?.middleware?.flatMap((entry) => entry.tools ?? [])
      .find((candidate) => candidate.name === "eval") as {
        description?: string;
    } | undefined;
    if (!evaluator) throw new Error("missing planned acquisition evaluator");
    expect(evaluator.description).toContain("sandboxed REPL");
  });

  test("executes planned query variants within one product-wide page budget before ranking and detail reads", async () => {
    const calls: string[] = [];
    const search = tool(async (value: { query?: { text?: string }; cursor?: string }) => {
      const label = value.query?.text ?? value.cursor ?? "unknown";
      calls.push(`search:${label}`);
      return JSON.stringify({
        items: [{ entityRef: `research-entity:${label.replace(/[^A-Za-z0-9-]/gu, "-")}` }],
        page: { complete: true },
      });
    }, {
      name: "wiki_search",
      description: "synthetic search",
      schema: z.object({
        query: z.object({ text: z.string() }).optional(),
        cursor: z.string().optional(),
      }).strict(),
    });
    const rank = tool(async (value: { entityRefs: string[] }) => {
      calls.push(`rank:${value.entityRefs.length}`);
      return JSON.stringify({
        items: value.entityRefs.map((entityRef, index) => ({
          entityRef,
          sourceId: `wiki:${index + 1}`,
          rank: index + 1,
        })),
      });
    }, {
      name: "research_candidate_rank",
      description: "synthetic rank",
      schema: z.object({
        product: z.enum(["jira", "confluence"]),
        entityRefs: z.array(z.string()),
      }).strict(),
    });
    const detail = tool(async (value: { entityRef: string }) => {
      calls.push(`detail:${value.entityRef}`);
      return JSON.stringify({ source: { id: value.entityRef }, content: { text: "detail" } });
    }, {
      name: "wiki_page_get",
      description: "synthetic detail",
      schema: z.object({ entityRef: z.string() }).strict(),
    });
    const acquisition = createPlannedSearchAcquisitionToolV1({
      product: "confluence",
      tools: [search, rank, detail],
      retrievalLedger: {
        plan: () => ({ searches: [{ product: "confluence", maxPages: 1 }] }),
        allowedInitialQueries: () => [
          { text: "first" },
          { text: "second" },
          { text: "third" },
        ],
      } as unknown as ChatCandidateLedgerControllerV1,
      maxSearchPages: 2,
      maxDetails: 2,
    });

    const outerResult = await acquisition.invoke({}, {
      toolCall: { id: "outer-acquisition-call" },
    } as unknown as RunnableConfig);
    expect(outerResult).toBeInstanceOf(ToolMessage);
    const result = JSON.parse(String((outerResult as ToolMessage).content));

    expect(calls).toEqual([
      "search:first",
      "search:second",
      "rank:2",
      "detail:research-entity:first",
      "detail:research-entity:second",
    ]);
    expect(result).toMatchObject({
      pagesRead: 2,
      discoveredCandidates: 2,
      details: [
        { source: { id: "research-entity:first" } },
        { source: { id: "research-entity:second" } },
      ],
    });
  });

  test("runs the compound acquisition through the real broker and durable candidate ledger", async () => {
    const limits = {
      ...request.limits,
      maxSearchPagesPerProduct: 2,
      maxDetailItemsPerProduct: 2,
    };
    const scopedRequest: ResearchRequestV1 = {
      ...request,
      question: "Compare atlcli installation and configuration paths.",
      scope: {
        ...request.scope,
        confluenceSpaceKeys: ["DOCSY"],
      },
      limits,
    };
    const broker = new ResearchCapabilityBroker(scopedRequest, {
      jira: providers.jira,
      wiki: {
        async searchPage(input) {
          return {
            items: input.cql.includes("atlcli")
              ? [{
                  contentId: "1001",
                  spaceKey: "DOCSY",
                  title: "Install atlcli",
                  excerpt: "Install and configure atlcli.",
                }]
              : [],
          };
        },
        async getPage(input) {
          return {
            contentId: input.contentId,
            spaceKey: "DOCSY",
            title: "Install atlcli",
            content: {
              text: "Install atlcli, then configure its profile.",
              linkTargets: [],
              truncated: false,
              inputBytes: 43,
            },
          };
        },
      },
    }, { budget: new ResearchRunBudget(limits) });
    const workspace = createMemoryResearchWorkspace();
    const retrievalLedger = new CandidateLedgerController({
      plan: createChatRetrievalPlanV1({
        conversationId: "conversation:compound",
        turnId: "turn:compound",
        question: scopedRequest.question,
        anchors: [],
        scopeBindings: [],
        boundSpaceKeys: ["DOCSY"],
        searchProducts: ["confluence"],
        exactContextProducts: [],
        limits,
        agentic: true,
        proposal: {
          searches: [{
            searchId: "search:confluence",
            product: "confluence",
            variants: [
              { variantId: "core", query: { text: "atlcli" } },
              { variantId: "alternate", query: { text: "configuration" } },
            ],
            maxPages: 1,
          }],
        },
      }),
      workspace,
      siteOrigin: scopedRequest.scope.siteOrigin,
    });
    await retrievalLedger.initialize();
    const rawTools = createChatPtcToolsV1(broker, {
      searchProducts: ["confluence"],
      boundSpaceKeys: ["DOCSY"],
      beforeInvoke: (capability, value) =>
        retrievalLedger.assertToolInput(capability, value),
      onResult: (capability, result, callId, value) =>
        retrievalLedger.observe(capability, result, callId, value),
    });
    const acquisition = createPlannedSearchAcquisitionToolV1({
      product: "confluence",
      tools: rawTools,
      retrievalLedger,
      maxSearchPages: 2,
      maxDetails: 2,
    });

    const result = JSON.parse(String(await acquisition.invoke({})));

    expect(result).toMatchObject({
      pagesRead: 2,
      discoveredCandidates: 1,
      details: [{
        source: {
          sourceId: "wiki:1001",
          title: "Install atlcli",
        },
        content: { truncated: false },
      }],
      gaps: [],
    });
    expect(retrievalLedger.snapshot()).toMatchObject({
      atlassianHttpCalls: 3,
      candidates: [{
        sourceId: "wiki:1001",
        state: "detail-read",
        admittedRank: 1,
      }],
    });
  });

  test("blocks another search after saturation while preserving later ranking and detail evals", async () => {
    const harness = createHarness({
      searchProducts: ["confluence"],
      withRetrievalAssessment: true,
      searchPlanSaturated: true,
    });
    const reader = harness.compiledSubagents.find(
      (entry) => entry.name === "chat-confluence-search-reader-v1",
    );
    const guard = reader?.middleware?.find((entry) => entry.wrapToolCall !== undefined);
    if (!guard?.wrapToolCall) throw new Error("missing child eval guard");
    let searchInvoked = false;
    const stopped = await guard.wrapToolCall({
      toolCall: {
        id: "eval:saturated",
        name: "eval",
        args: { code: "await tools.wikiSearch({ query: { text: 'another' } });" },
      },
    }, async () => {
      searchInvoked = true;
      return { content: "should not run" };
    });
    expect(searchInvoked).toBe(false);
    expect((stopped as ToolMessage).content).toContain("SEARCH_PLAN_SATURATED");

    await expect(guard.wrapToolCall({
      toolCall: {
        id: "eval:rank",
        name: "eval",
        args: { code: "await tools.researchCandidateRank({ candidates: [] });" },
      },
    }, async () => ({ content: "ranked" }))).resolves.toEqual({ content: "ranked" });
  });

  test("degrades only bounded empty-search acquisition failures to an explicit gap packet", async () => {
    const harness = createHarness({
      searchProducts: ["confluence"],
      async invoke(taskInput) {
        if (taskInput.subagent_type === "chat-confluence-search-reader-v1") {
          throw new Error("Chat search query is not an admitted retrieval-plan variant.");
        }
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: [
        {
          taskId: "task:search",
          profileId: "confluence-search-reader",
          objective: "Search the admitted Confluence scope.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:draft",
          profileId: "answer-drafter",
          objective: "Draft a provisional answer.",
          dependencyTaskIds: ["task:search"],
        },
        {
          taskId: "task:critic",
          profileId: "answer-critic",
          objective: "Critique the provisional answer.",
          dependencyTaskIds: ["task:draft"],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the accepted answer.",
          dependencyTaskIds: ["task:critic"],
        },
      ],
      maxConcurrency: 1,
    }));
    const dispatch = response.dispatches.find((entry: ChatWorkflowDispatchV1) =>
      entry.taskId === "task:search"
    );
    if (!dispatch) throw new Error("missing search dispatch");
    await expect(invokeDispatch(harness.runtime, dispatch)).resolves.toEqual({
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: [],
      claims: [],
      relationships: [],
      gaps: [
        "Confluence discovery exhausted every host-admitted query variant without detail evidence; no broader query or scope was attempted.",
      ],
    });
    expect(harness.runtime.dispatchSnapshot().taskStatuses["task:search"]).toBe("completed");
  });

  test("uses repairable tool packets for every specialist including synthesis", async () => {
    const projectedResponseFormats = new Map<string, unknown>();
    const harness = createHarness({
      structuredOutput: "native",
      withRetrievalAssessment: true,
      projectResponseSchema: providerCompatibleChatJsonSchemaV1,
      async invoke(taskInput, config) {
        projectedResponseFormats.set(taskInput.subagent_type, config?.configurable?.[
          DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY
        ]);
        if (
          taskInput.subagent_type === "chat-synthesizer-v1" ||
          taskInput.subagent_type === "chat-answer-drafter-v1"
        ) return answerDraft();
        if (taskInput.subagent_type === "chat-answer-critic-v1") return critiquePacket();
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare accepted claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const byId = new Map<string, ChatWorkflowDispatchV1>(
      response.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    const dispatch = requireDispatch(byId, "task:analysis");
    await invokeDispatch(harness.runtime, dispatch);
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:draft"));
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:critic"));
    const quality = await invokeQualityReview(harness.runtime);
    const synthDispatch = quality.dispatches.find((entry) => entry.taskId === "task:synth");
    if (!synthDispatch) throw new Error("missing synthesis dispatch");
    await invokeDispatch(harness.runtime, synthDispatch);
    const internalFormat = projectedResponseFormats.get("chat-comparison-analyst-v1");
    const synthesisFormat = projectedResponseFormats.get("chat-synthesizer-v1");
    expect(Array.isArray(internalFormat)).toBe(true);
    expect((internalFormat as unknown[])[0]?.constructor.name).toBe("ToolStrategy");
    expect(Array.isArray(synthesisFormat)).toBe(true);
    expect((synthesisFormat as unknown[])[0]?.constructor.name).toBe("ToolStrategy");
    const synthesisSchema = (synthesisFormat as Array<{ schema: unknown }>)[0]?.schema;
    expect(JSON.stringify(dispatch.responseSchema)).toContain("maxItems");
    expect(JSON.stringify((internalFormat as Array<{ schema: unknown }>)[0]?.schema)).toContain("maxItems");
    expect(JSON.stringify(synthesisSchema)).toContain("maxItems");
    expect(synthesisSchema).toMatchObject({
      type: "object",
      properties: {
        messageMarkdown: {
          type: "string",
          description: expect.stringContaining("[[source:SOURCE_ID]]"),
        },
        citationSourceIds: { type: "array" },
      },
    });
  });

  test("forwards model stream events from host-executed DeepAgents specialists", async () => {
    const streamed: ChatSubagentModelStreamEventV1[] = [];
    const harness = createHarness({
      onModelStreamEvent: (event) => streamed.push(event),
      async invoke(_taskInput, config) {
        const callbacks = config?.callbacks as unknown as {
          handlers?: Array<{
            handleChatModelStreamEvent?: (event: unknown, runId: string) => Promise<void> | void;
          }>;
        };
        const handlers = callbacks?.handlers ?? [];
        for (const handler of handlers) {
          await handler.handleChatModelStreamEvent?.({
            event: "content-block-delta",
            index: 0,
            delta: {
              type: "reasoning-delta",
              reasoning: "Comparing the accepted evidence.",
            },
          }, "synthetic-specialist-model-run");
          await handler.handleChatModelStreamEvent?.({
            event: "message-finish",
            reason: "stop",
          }, "synthetic-specialist-model-run");
        }
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        objective: "Compare accepted claims.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    }));
    const dispatch = response.dispatches.find((entry: ChatWorkflowDispatchV1) =>
      entry.taskId === "task:analysis"
    );
    if (!dispatch) throw new Error("missing analysis dispatch");

    await invokeDispatch(harness.runtime, dispatch);

    expect(streamed).toEqual([
      expect.objectContaining({
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        runId: "synthetic-specialist-model-run",
        event: expect.objectContaining({ event: "content-block-delta" }),
      }),
      expect.objectContaining({
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        runId: "synthetic-specialist-model-run",
        event: expect.objectContaining({ event: "message-finish" }),
      }),
    ]);
  });

  test("runs a real two-sibling frontier concurrently, hydrates only admitted dependencies, and persists one synthesizer", async () => {
    let active = 0;
    let maximumActive = 0;
    let reviewComplete = false;
    const seenDescriptions = new Map<string, string>();
    const harness = createHarness({
      withRetrievalAssessment: true,
      beforeSynthesis: () => {
        if (!reviewComplete) throw new Error("review pending");
      },
      async invoke(taskInput) {
        seenDescriptions.set(taskInput.subagent_type, taskInput.description);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (taskInput.subagent_type === "chat-synthesizer-v1") return {
          messageMarkdown: "A bounded synthetic comparison.",
          citationSourceIds: [],
          gaps: [],
        };
        if (taskInput.subagent_type === "chat-answer-drafter-v1") return answerDraft();
        if (taskInput.subagent_type === "chat-answer-critic-v1") return critiquePacket();
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:relationships",
          profileId: "relationship-tracer",
          objective: "Trace explicit relationships.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:comparison",
          profileId: "comparison-analyst",
          objective: "Compare accepted claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 2,
    }));
    const byId = new Map<string, ChatWorkflowDispatchV1>(
      response.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await Promise.all([
      invokeDispatch(harness.runtime, requireDispatch(byId, "task:relationships")),
      invokeDispatch(harness.runtime, requireDispatch(byId, "task:comparison")),
    ]);
    expect(maximumActive).toBe(2);
    expect(seenDescriptions.get("chat-relationship-tracer-v1"))
      .not.toContain("Compare accepted claims");
    expect(seenDescriptions.get("chat-comparison-analyst-v1"))
      .not.toContain("Trace explicit relationships");
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:draft"));
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:critic"));
    reviewComplete = true;
    const quality = await invokeQualityReview(harness.runtime);
    const finalById = new Map(quality.dispatches.map((entry) => [entry.taskId, entry]));
    await invokeDispatch(harness.runtime, requireDispatch(finalById, "task:synth"));
    const synthDescription = JSON.parse(
      seenDescriptions.get("chat-synthesizer-v1")!,
    );
    expect(synthDescription.dependencyResults.map((entry: { taskId: string }) => entry.taskId).sort())
      .toEqual(["task:critic", "task:draft"]);
    expect(harness.runtime.assertComplete()).toMatchObject({
      messageMarkdown: "A bounded synthetic comparison.",
    });
    expect(harness.runtime.dispatchSnapshot()).toMatchObject({
      dispatchedTasks: 5,
      activeInvocations: 0,
      taskStatuses: {
        "task:relationships": "completed",
        "task:comparison": "completed",
        "task:draft": "completed",
        "task:critic": "completed",
        "task:synth": "completed",
      },
    });
    expect(JSON.parse((await harness.workspace.readFile(CHAT_WORKFLOW_STATE_PATH_V1))!))
      .toMatchObject({
        schema: "atlcli.chat-workflow-state/v1",
        accepted: { synthesizerTaskId: "task:synth" },
        taskStatuses: { "task:synth": "completed" },
      });
  });

  test("advances the dynamic graph through host-owned waves and explicit checkpoints", async () => {
    let reviewCurrent = false;
    let active = 0;
    let maximumActive = 0;
    const invoked: string[] = [];
    const harness = createHarness({
      withRetrievalAssessment: true,
      strategyReviewCurrent: () => reviewCurrent,
      async invoke(taskInput) {
        invoked.push(taskInput.subagent_type);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (taskInput.subagent_type === "chat-answer-drafter-v1") return answerDraft();
        if (taskInput.subagent_type === "chat-answer-critic-v1") return critiquePacket();
        if (taskInput.subagent_type === "chat-synthesizer-v1") return answerDraft();
        return analysisPacket();
      },
    });
    await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:relationships",
          profileId: "relationship-tracer",
          objective: "Trace explicit relationships.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:comparison",
          profileId: "comparison-analyst",
          objective: "Compare accepted claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 2,
    });

    const beforeReview = JSON.parse(await harness.runtime.advanceTool.invoke({}));
    expect(beforeReview).toMatchObject({
      schema: "atlcli.chat-workflow-advance/v1",
      status: "strategy-review-required",
    });
    expect(beforeReview.completedTaskIds.sort()).toEqual([
      "task:comparison",
      "task:relationships",
    ]);
    expect(maximumActive).toBe(2);

    reviewCurrent = true;
    const beforeQuality = JSON.parse(await harness.runtime.advanceTool.invoke({}));
    expect(beforeQuality).toMatchObject({
      status: "quality-review-required",
      completedTaskIds: ["task:draft", "task:critic"],
    });
    await harness.runtime.qualityReviewTool.invoke({});
    const complete = JSON.parse(await harness.runtime.advanceTool.invoke({}));
    expect(complete).toMatchObject({
      status: "complete",
      completedTaskIds: ["task:synth"],
      remainingTaskIds: [],
    });
    expect(invoked).toEqual([
      "chat-relationship-tracer-v1",
      "chat-comparison-analyst-v1",
      "chat-answer-drafter-v1",
      "chat-answer-critic-v1",
      "chat-synthesizer-v1",
    ]);
    expect(harness.runtime.assertComplete()).toEqual(answerDraft());
  });

  test("fails closed when a child bypasses an incomplete dependency", async () => {
    const harness = createHarness();
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const draft = response.dispatches.find(
      (entry: { taskId: string }) => entry.taskId === "task:draft",
    );
    await expect(invokeDispatch(harness.runtime, draft)).rejects.toThrow("incomplete dependency");
  });

  test("hydrates the host schema and still rejects a duplicate dispatch", async () => {
    const harness = createHarness();
    const forgedResponse = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const forgedAnalysis = forgedResponse.dispatches.find(
      (entry: { taskId: string }) => entry.taskId === "task:analysis",
    );
    await expect(invokeDispatch(harness.runtime, {
      ...forgedAnalysis,
      responseSchema: { type: "object" },
    })).resolves.toEqual(analysisPacket());
    // The guest copy is non-authoritative, but the immutable task slot remains
    // single-use after the host-bound schema completed successfully.
    await expect(invokeDispatch(harness.runtime, forgedAnalysis))
      .rejects.toThrow("already dispatched");
  });

  test("accepts a schema-valid packet near its byte limit and rejects one over it", async () => {
    const nearLimitPacket = analysisPacketNearBytes(23_990);
    expect(serializedBytes(nearLimitPacket)).toBeGreaterThan(23_000);
    expect(serializedBytes(nearLimitPacket)).toBeLessThanOrEqual(24_000);
    const acceptedHarness = createHarness({
      async invoke(taskInput) {
        return taskInput.subagent_type === "chat-comparison-analyst-v1"
          ? nearLimitPacket
          : {
              messageMarkdown: "A bounded synthetic answer.",
              citationSourceIds: [],
              gaps: [],
            };
      },
    });
    const acceptedResponse = JSON.parse(await acceptedHarness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const acceptedById = new Map<string, ChatWorkflowDispatchV1>(
      acceptedResponse.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await expect(invokeDispatch(
      acceptedHarness.runtime,
      requireDispatch(acceptedById, "task:analysis"),
    )).resolves.toMatchObject({ schema: "atlcli.chat-analysis-packet/v1" });

    const overLimitPacket = analysisPacketNearBytes(24_100);
    expect(serializedBytes(overLimitPacket)).toBeGreaterThan(24_000);
    const rejectedHarness = createHarness({
      async invoke(taskInput) {
        return taskInput.subagent_type === "chat-comparison-analyst-v1"
          ? overLimitPacket
          : analysisPacket();
      },
    });
    const rejectedResponse = JSON.parse(await rejectedHarness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const rejectedById = new Map<string, ChatWorkflowDispatchV1>(
      rejectedResponse.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await expect(invokeDispatch(
      rejectedHarness.runtime,
      requireDispatch(rejectedById, "task:analysis"),
    )).rejects.toThrow("exceeds 24000 bytes");
  });

  test("rejects an oversized synthesizer packet", async () => {
    const harness = createHarness({
      withRetrievalAssessment: true,
      async invoke(taskInput) {
        if (taskInput.subagent_type === "chat-synthesizer-v1") {
          return {
            messageMarkdown: "x".repeat(30_000),
            citationSourceIds: [],
            gaps: [],
          };
        }
        if (taskInput.subagent_type === "chat-answer-drafter-v1") return answerDraft();
        if (taskInput.subagent_type === "chat-answer-critic-v1") return critiquePacket();
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const byId = new Map<string, ChatWorkflowDispatchV1>(
      response.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:analysis"));
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:draft"));
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:critic"));
    const quality = await invokeQualityReview(harness.runtime);
    const qualityById = new Map(quality.dispatches.map((entry) => [entry.taskId, entry]));
    await expect(invokeDispatch(harness.runtime, requireDispatch(qualityById, "task:synth")))
      .rejects.toThrow(/exceeds|invalid structured packet/u);
  });

  test("improves an intentionally wrong-citation gold answer through one targeted repair", async () => {
    const invoked: string[] = [];
    const seenDescriptions = new Map<string, string>();
    const wrongDraft: ChatAgentDraftV1 = {
      messageMarkdown: "The rollout is complete according to the wrong source.",
      citationSourceIds: [],
      gaps: [],
    };
    const repairedDraft: ChatAgentDraftV1 = {
      messageMarkdown: "The available evidence does not establish that the rollout is complete.",
      citationSourceIds: [],
      gaps: [{
        code: "unresolved-reference",
        message: "The claimed rollout status is not supported by the admitted evidence.",
        sourceIds: [],
      }],
    };
    const goldScore = (draft: ChatAgentDraftV1): number =>
      Number(!draft.messageMarkdown.includes("according to the wrong source")) +
      Number(draft.messageMarkdown.includes("does not establish")) +
      Number(draft.gaps.some((gap) => gap.code === "unresolved-reference"));
    const harness = createHarness({
      withRetrievalAssessment: true,
      async invoke(taskInput) {
        invoked.push(taskInput.subagent_type);
        seenDescriptions.set(taskInput.subagent_type, taskInput.description);
        if (taskInput.subagent_type === "chat-answer-critic-v1") {
          return {
            schema: "atlcli.chat-critique-packet/v1",
            defects: [{
              defectId: "chat-defect:wrong-citation",
              code: "invalid-citation",
              severity: "material",
              sourceIds: [],
              repairAction: "resynthesize",
              message: "The provisional answer uses the wrong citation.",
            }],
            readyForSynthesis: false,
          };
        }
        if (taskInput.subagent_type === "chat-answer-drafter-v1") return wrongDraft;
        if (taskInput.subagent_type === "chat-answer-repairer-v1") return repairedDraft;
        if (taskInput.subagent_type === "chat-synthesizer-v1") {
          return {
            messageMarkdown: "## Empty synthesis regression",
            citationSourceIds: repairedDraft.citationSourceIds,
            gaps: [],
          };
        }
        return analysisPacket();
      },
    });
    const proposal = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        objective: "Compare accepted evidence.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    }));
    const initial = new Map<string, ChatWorkflowDispatchV1>(
      proposal.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:analysis"));
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:draft"));
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:critic"));

    const quality = await invokeQualityReview(harness.runtime);
    expect(quality.dispatches.map((entry) => entry.subagentType)).toEqual([
      "chat-answer-repairer-v1",
      "chat-synthesizer-v1",
    ]);
    const repair = quality.dispatches[0]!;
    const synth = quality.dispatches[1]!;
    await invokeDispatch(harness.runtime, repair);
    await invokeDispatch(harness.runtime, synth);
    await expect(harness.runtime.qualityReviewTool.invoke({}))
      .rejects.toThrow("exactly once");
    expect(invoked.filter((name) => name === "chat-answer-repairer-v1"))
      .toHaveLength(1);
    expect(seenDescriptions.get("chat-answer-repairer-v1"))
      .toContain("chat-defect:wrong-citation");
    const synthDescription = JSON.parse(
      seenDescriptions.get("chat-synthesizer-v1")!,
    );
    expect(synthDescription.dependencyResults.map((entry: { taskId: string }) => entry.taskId))
      .toEqual([repair.taskId]);
    const finalDraft = harness.runtime.assertComplete();
    expect(goldScore(wrongDraft)).toBe(0);
    expect(goldScore(finalDraft)).toBe(3);
    expect(finalDraft).toEqual(repairedDraft);
  });

  test("preserves synthesis when the host denies repair to protect the deadline reserve", async () => {
    const harness = createHarness({
      withRetrievalAssessment: true,
      decideRepairAdmission: () => ({ admit: false, reason: "deadline-reserve" }),
      async invoke(taskInput) {
        if (taskInput.subagent_type === "chat-answer-critic-v1") {
          return {
            schema: "atlcli.chat-critique-packet/v1",
            defects: [{
              defectId: "chat-defect:budgeted-repair",
              code: "question-not-answered",
              severity: "material",
              sourceIds: [],
              repairAction: "resynthesize",
              message: "The provisional answer requires a bounded repair.",
            }],
            readyForSynthesis: false,
          };
        }
        if (taskInput.subagent_type === "chat-answer-drafter-v1") return answerDraft();
        return analysisPacket();
      },
    });
    const proposal = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        objective: "Compare accepted evidence.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    }));
    const initial = new Map<string, ChatWorkflowDispatchV1>(
      proposal.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:analysis"));
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:draft"));
    await invokeDispatch(harness.runtime, requireDispatch(initial, "task:critic"));
    const quality = await invokeQualityReview(harness.runtime);

    expect(quality.dispatches.map((entry) => entry.subagentType)).toEqual([
      "chat-synthesizer-v1",
    ]);
    expect(quality.requiredGapCodes).toContain("question-not-answered");
    expect(harness.runtime.qualityDisposition()).toMatchObject({
      repairRequired: true,
      repairAdmitted: false,
      repairSkippedReason: "deadline-reserve",
      synthesisAllowed: true,
    });
  });

  test("enforces the workflow's admitted concurrency below the host ceiling", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = createHarness({
      async invoke(taskInput) {
        if (taskInput.subagent_type === "chat-comparison-analyst-v1") {
          await firstPending;
        }
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:comparison",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:contradictions",
          profileId: "contradiction-checker",
          objective: "Check contradictions.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    }));
    const byId = new Map<string, ChatWorkflowDispatchV1>(
      response.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    const first = invokeDispatch(harness.runtime, requireDispatch(byId, "task:comparison"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(invokeDispatch(harness.runtime, requireDispatch(byId, "task:contradictions")))
      .rejects.toThrow("concurrency exceeded");
    releaseFirst();
    await first;
  });
});
