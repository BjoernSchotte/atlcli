import { describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod/v4";
import { ResearchCapabilityBroker } from "../broker.js";
import { ResearchRunBudget } from "../budget.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchRequestV1,
} from "../contracts.js";
import { DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY } from "../dispatch-adapter.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import type { ChatWorkflowDispatchV1 } from "./workflow.js";
import {
  CHAT_WORKFLOW_STATE_PATH_V1,
  createChatAgenticWorkflowRuntimeV1,
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
  invoke?(input: { description: string; subagent_type: string }): Promise<unknown>;
  beforeSynthesis?: () => void;
} = {}) {
  const budget = new ResearchRunBudget(request.limits);
  const broker = new ResearchCapabilityBroker(request, providers, { budget });
  const workspace = createMemoryResearchWorkspace();
  let compiledSubagents: Array<{
    name: string;
    systemPrompt?: string;
    tools?: unknown[];
    middleware?: Array<{ name?: string; tools?: Array<{ name: string }> }>;
  }> = [];
  const upstreamTask = tool(input.invoke ?? (async (taskInput) =>
    taskInput.subagent_type === "chat-synthesizer-v1"
      ? {
          messageMarkdown: "A bounded synthetic answer.",
          citationSourceIds: [],
          gaps: [],
        }
      : analysisPacket()), {
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
    strategy,
    budget,
    broker,
    workspace,
    conversationId: "chat-conversation:workflow",
    turnId: "chat-turn:workflow",
    taskContext: JSON.stringify({ question: request.question }),
    limits: request.limits,
    exactContextProducts: [],
    searchProducts: [],
    signal: new AbortController().signal,
    beforeSynthesis: input.beforeSynthesis,
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

describe("Chat agentic workflow runtime", () => {
  test("compiles all eight depth-one profiles without a general-purpose or nested task surface", () => {
    const harness = createHarness({ invoke: async () => analysisPacket() });
    expect(harness.compiledSubagents.map((entry) => entry.name)).toEqual([
      "chat-exact-context-reader-v1",
      "chat-confluence-search-reader-v1",
      "chat-jira-search-reader-v1",
      "chat-relationship-tracer-v1",
      "chat-comparison-analyst-v1",
      "chat-contradiction-checker-v1",
      "chat-answer-critic-v1",
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
  });

  test("runs a real two-sibling frontier concurrently, hydrates only admitted dependencies, and persists one synthesizer", async () => {
    let active = 0;
    let maximumActive = 0;
    let reviewComplete = false;
    const seenDescriptions = new Map<string, string>();
    const harness = createHarness({
      beforeSynthesis: () => {
        if (!reviewComplete) throw new Error("review pending");
      },
      async invoke(taskInput) {
        seenDescriptions.set(taskInput.subagent_type, taskInput.description);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (taskInput.subagent_type === "chat-synthesizer-v1") {
          return {
            messageMarkdown: "A bounded synthetic comparison.",
            citationSourceIds: [],
            gaps: [],
          };
        }
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: [
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
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write one answer.",
          dependencyTaskIds: ["task:relationships", "task:comparison"],
        },
      ],
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
    reviewComplete = true;
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:synth"));
    const synthDescription = JSON.parse(
      seenDescriptions.get("chat-synthesizer-v1")!,
    );
    expect(synthDescription.dependencyResults.map((entry: { taskId: string }) => entry.taskId).sort())
      .toEqual(["task:comparison", "task:relationships"]);
    expect(harness.runtime.assertComplete()).toMatchObject({
      messageMarkdown: "A bounded synthetic comparison.",
    });
    expect(harness.runtime.dispatchSnapshot()).toMatchObject({
      dispatchedTasks: 3,
      activeInvocations: 0,
      taskStatuses: {
        "task:relationships": "completed",
        "task:comparison": "completed",
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
      tasks: [
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write answer.",
          dependencyTaskIds: ["task:analysis"],
        },
      ],
      maxConcurrency: 1,
    }));
    const synth = response.dispatches.find(
      (entry: { taskId: string }) => entry.taskId === "task:synth",
    );
    await expect(invokeDispatch(harness.runtime, synth)).rejects.toThrow("incomplete dependency");
  });

  test("fails closed on a forged schema and duplicate dispatch", async () => {
    const harness = createHarness();
    const forgedResponse = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: [
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write answer.",
          dependencyTaskIds: ["task:analysis"],
        },
      ],
      maxConcurrency: 1,
    }));
    const forgedAnalysis = forgedResponse.dispatches.find(
      (entry: { taskId: string }) => entry.taskId === "task:analysis",
    );
    await expect(invokeDispatch(harness.runtime, {
      ...forgedAnalysis,
      responseSchema: { type: "object" },
    })).rejects.toThrow("response schema");

    const duplicateHarness = createHarness();
    const duplicateResponse = JSON.parse(await duplicateHarness.runtime.proposalTool.invoke({
      tasks: [
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write answer.",
          dependencyTaskIds: ["task:analysis"],
        },
      ],
      maxConcurrency: 1,
    }));
    const analysis = duplicateResponse.dispatches.find(
      (entry: { taskId: string }) => entry.taskId === "task:analysis",
    );
    await invokeDispatch(duplicateHarness.runtime, analysis);
    await expect(invokeDispatch(duplicateHarness.runtime, analysis))
      .rejects.toThrow("already dispatched");
  });

  test("rejects an oversized synthesizer packet", async () => {
    const harness = createHarness({
      async invoke(taskInput) {
        if (taskInput.subagent_type === "chat-synthesizer-v1") {
          return {
            messageMarkdown: "x".repeat(30_000),
            citationSourceIds: [],
            gaps: [],
          };
        }
        return analysisPacket();
      },
    });
    const response = JSON.parse(await harness.runtime.proposalTool.invoke({
      tasks: [
        {
          taskId: "task:analysis",
          profileId: "comparison-analyst",
          objective: "Compare claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write answer.",
          dependencyTaskIds: ["task:analysis"],
        },
      ],
      maxConcurrency: 1,
    }));
    const byId = new Map<string, ChatWorkflowDispatchV1>(
      response.dispatches.map((entry: ChatWorkflowDispatchV1) => [entry.taskId, entry]),
    );
    await invokeDispatch(harness.runtime, requireDispatch(byId, "task:analysis"));
    await expect(invokeDispatch(harness.runtime, requireDispatch(byId, "task:synth")))
      .rejects.toThrow(/exceeds|invalid structured packet/u);
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
      tasks: [
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
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write answer.",
          dependencyTaskIds: ["task:comparison", "task:contradictions"],
        },
      ],
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
