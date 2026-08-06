import { describe, expect, test } from "bun:test";
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
import type { ChatQualityDispositionV1 } from "./quality.js";
import {
  CHAT_WORKFLOW_STATE_PATH_V1,
  createChatAgenticWorkflowRuntimeV1,
  normalizeKnownSourceReferencesV1,
  type ChatSubagentEvalDiagnosticV1,
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
  searchProducts?: Array<"jira" | "confluence">;
  withRetrievalAssessment?: boolean;
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
    exactContextProducts: [],
    searchProducts: input.searchProducts ?? [],
    boundProjectKeys: [],
    boundSpaceKeys: [],
    signal: new AbortController().signal,
    beforeSynthesis: input.beforeSynthesis,
    ...(input.decideRepairAdmission
      ? { decideRepairAdmission: input.decideRepairAdmission }
      : {}),
    ...(input.withRetrievalAssessment
      ? {
          retrievalLedger: {
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
    expect(byName.get("chat-synthesizer-v1")).toBe(thorough);
  });

  test("streams body-free child eval lifecycle and fails a looping ninth reader eval closed", async () => {
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
    await expect(guard.wrapToolCall(request, async () => ({ content: "ignored" })))
      .rejects.toThrow("bounded eval step limit");
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

  test("uses repairable tool packets internally and native streaming only for synthesis", async () => {
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
    expect(synthesisFormat?.constructor.name).toBe("ProviderStrategy");
    const providerSchema = (synthesisFormat as { schema: unknown }).schema;
    expect(JSON.stringify(dispatch.responseSchema)).toContain("maxItems");
    expect(JSON.stringify((internalFormat as Array<{ schema: unknown }>)[0]?.schema)).toContain("maxItems");
    expect(JSON.stringify(providerSchema)).not.toContain("maxItems");
    expect(providerSchema).toMatchObject({
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
      .toEqual(["task:comparison", "task:critic", "task:draft", "task:relationships"]);
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

  test("fails closed on a forged schema and duplicate dispatch", async () => {
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
    })).rejects.toThrow("response schema");
    // Static rejection did not start an upstream task and therefore must not
    // consume its immutable dispatch slot. The corrected admitted request may
    // run once; a real duplicate remains rejected.
    await invokeDispatch(harness.runtime, forgedAnalysis);
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
        if (taskInput.subagent_type === "chat-synthesizer-v1") return repairedDraft;
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
