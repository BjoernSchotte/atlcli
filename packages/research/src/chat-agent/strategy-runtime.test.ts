import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import {
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
} from "deepagents/node";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchRequestV1,
} from "../contracts.js";
import { ResearchRunBudget } from "../budget.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
} from "../quality-policy.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import type { ChatTurnRequestV1 } from "./contracts.js";
import {
  assertChatFinalReviewReserveV1,
  createKiteweaveChatAgent,
} from "./runtime.js";
import {
  CHAT_STRATEGY_STATE_PATH_V1,
  deriveChatStrategyDecisionV1,
  type ChatStrategyRecordV1,
} from "./strategy.js";

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

const hostIdentity = {
  userId: "principal:strategy-test",
  providerCacheIdentity: "provider-cache:strategy-test",
} as const;

function request(question: string): {
  turn: ChatTurnRequestV1;
  brokerRequest: ResearchRequestV1;
  hostIdentity: typeof hostIdentity;
} {
  const scope = {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [] as string[],
    confluenceSpaceKeys: [] as string[],
  };
  // FakeModel responses do not carry provider usage metadata, so the shared
  // fail-closed budget intentionally retains each pessimistic reservation.
  // Keep this trajectory test focused on orchestration while production/live
  // tests exercise the normal cost ceiling with observed provider usage.
  const limits = {
    ...DEFAULT_RESEARCH_LIMITS_V1,
    maxRunMs: 30_000,
    maxTotalModelInputTokens: 1_000_000,
    maxTotalModelOutputTokens: 128_000,
    maxModelCostMicros: 100_000_000,
  };
  return {
    hostIdentity,
    turn: {
      schema: "atlcli.chat-turn-request/v1",
      conversationId: "chat-conversation:strategy",
      turnId: `chat-turn:${question.includes("Compare") ? "complex" : "simple"}`,
      question,
      scope,
      limits,
      wikiProvider: "rest",
    },
    brokerRequest: {
      schema: "atlcli.research-request/v1",
      question,
      scope,
      limits,
      wikiProvider: "rest",
    },
  };
}

function model(requiresStrategy: boolean, requiresReview = false) {
  const built = fakeModel();
  if (requiresReview) {
    const proposalCode = `
const acceptedStrategy = JSON.parse(await tools.chatStrategyDecide({}));
globalThis.syntheticWorkflow = JSON.parse(await tools.chatWorkflowPropose({
  tasks: [
    { taskId: "task:compare", profileId: "comparison-analyst", objective: "Compare the bounded synthetic positions.", dependencyTaskIds: [] },
    { taskId: "task:draft", profileId: "answer-drafter", objective: "Draft the bounded synthetic answer.", dependencyTaskIds: ["task:compare"] },
    { taskId: "task:critic", profileId: "answer-critic", objective: "Check the bounded synthetic evidence state.", dependencyTaskIds: ["task:draft"] },
    { taskId: "task:synth", profileId: "chat-synthesizer", objective: "Write the conversational answer.", dependencyTaskIds: ["task:draft", "task:critic"] }
  ],
  maxConcurrency: 1
}));
syntheticWorkflow;`;
    const taskCode = `
const workflow = globalThis.syntheticWorkflow;
const review = JSON.parse(await tools.chatStrategyReview({}));
const runDispatch = (dispatch) => task({
  description: dispatch.description,
  subagentType: dispatch.subagentType,
  responseSchema: dispatch.responseSchema
});
await runDispatch(workflow.dispatches.find((entry) => entry.taskId === "task:compare"));
await runDispatch(workflow.dispatches.find((entry) => entry.taskId === "task:draft"));
await runDispatch(workflow.dispatches.find((entry) => entry.taskId === "task:critic"));
const quality = JSON.parse(await tools.chatQualityReview({}));
let finalDraft;
for (const dispatch of quality.dispatches) {
  finalDraft = await runDispatch(dispatch);
}
finalDraft;`;
    return built
      .respondWithTools([{ name: "eval", args: { code: proposalCode } }])
      .respondWithTools([{ name: "eval", args: { code: taskCode } }])
      .respondWithTools([{
        name: "ChatAnalysisPacketV1",
        args: {
          schema: "atlcli.chat-analysis-packet/v1",
          claimRefs: [],
          relationshipRefs: [],
          contradictions: [],
          gaps: [],
        },
      }])
      .respondWithTools([{
        name: "ChatProvisionalAnswerDraftV1",
        args: {
          messageMarkdown: "A bounded provisional synthetic answer.",
          citationSourceIds: [],
          gaps: [{
            code: "no-detail-evidence",
            message: "The synthetic agentic fixture has no detailed source evidence.",
            sourceIds: [],
          }, {
            code: "incomplete-coverage",
            message: "The synthetic agentic fixture cannot establish complete retrieval coverage.",
            sourceIds: [],
          }],
        },
      }])
      .respondWithTools([{
        name: "ChatCritiquePacketV1",
        args: {
          schema: "atlcli.chat-critique-packet/v1",
          defects: [],
          readyForSynthesis: true,
        },
      }])
      .respondWithTools([{
        name: "ChatAnswerDraftV1",
        args: {
          messageMarkdown: "A bounded synthetic agentic Chat answer.",
          citationSourceIds: [],
          gaps: [{
            code: "no-detail-evidence",
            message: "The synthetic agentic fixture has no detailed source evidence.",
            sourceIds: [],
          }, {
            code: "incomplete-coverage",
            message: "The synthetic agentic fixture cannot establish complete retrieval coverage.",
            sourceIds: [],
          }],
        },
      }])
      // The deliberately verbose, real DeepAgents trajectory crosses the
      // built-in summarization threshold of the profile-free FakeModel. Keep
      // that middleware path realistic: first answer its compaction request,
      // then let the root supervisor close the accepted workflow.
      .respond(new AIMessage("The accepted workflow and quality disposition are preserved."))
      .respond(new AIMessage("The host-admitted agentic workflow is complete."));
  }
  if (requiresStrategy) {
    built.respondWithTools([{
      name: "eval",
      args: { code: "JSON.parse(await tools.chatStrategyDecide({}))" },
    }]);
  }
  return built.respondWithTools([{
    name: "ChatAnswerDraftV1",
    args: {
      messageMarkdown: "A bounded synthetic Chat answer.",
      citationSourceIds: [],
      gaps: [],
    },
  }]);
}

describe("real QuickJS Chat strategy trajectory", () => {
  const runtime = createKiteweaveChatAgent({
    StateBackend,
    createDeepAgent,
    createSubAgentMiddleware,
    createSummarizationMiddleware,
    registerHarnessProfile,
  });

  test("Quick replaces the built-in DeepAgents task registry with an empty audited slot", async () => {
    let middlewareNames: string[] = [];
    let taskToolCount = -1;
    const inspected = createKiteweaveChatAgent({
      StateBackend,
      createDeepAgent: ((params: Parameters<typeof createDeepAgent>[0]) => {
        const agent = createDeepAgent(params);
        const options = (agent as unknown as {
          options: { middleware: Array<{ name: string; tools?: Array<{ name: string }> }> };
        }).options;
        middlewareNames = options.middleware.map((entry) => entry.name);
        taskToolCount = options.middleware.flatMap((entry) => entry.tools ?? [])
          .filter((entry) => entry.name === "task").length;
        return agent;
      }) as typeof createDeepAgent,
      createSubAgentMiddleware,
      createSummarizationMiddleware,
      registerHarnessProfile,
    });
    const input = request("Answer this simple conversational question.");
    await inspected.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("quick"),
    });
    expect(middlewareNames.filter((name) => name === "subAgentMiddleware"))
      .toHaveLength(1);
    expect(taskToolCount).toBe(0);
  });

  test("Quick completes without constructing or calling a strategy/task bridge", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const answer = await runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
    });
    expect(answer.strategy).toMatchObject({
      qualityMode: "quick",
      path: "direct",
      delegated: false,
      reasonCodes: ["quick-direct", "no-atlassian-acquisition"],
    });
    expect(answer.run.counts.ptcCalls).toBe(0);
    const record = JSON.parse(
      (await workspace.readFile(CHAT_STRATEGY_STATE_PATH_V1))!,
    ) as ChatStrategyRecordV1;
    expect(record.decision).toMatchObject({ execution: "direct" });
  });

  test("emits durable user-facing milestones around analysis and answer validation", async () => {
    const input = request("Answer this simple conversational question.");
    const events: Array<{ kind: string; phase?: string; code?: string; status?: string }> = [];

    await runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("quick"),
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.kind === "phase").map((event) => event.phase))
      .toEqual(["preparing", "checking", "rendering"]);
    expect(events.filter((event) => event.kind === "activity")).toEqual([
      expect.objectContaining({ code: "model-assessing", status: "started" }),
      expect.objectContaining({ code: "answer-draft-ready", status: "completed" }),
    ]);
  });

  test("Auto records a host-accepted direct strategy through QuickJS", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const answer = await runtime.runChatAgent({
      ...input,
      model: model(true),
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("auto"),
    });
    expect(answer.strategy).toMatchObject({
      qualityMode: "auto",
      path: "direct",
      expectedComplexity: "simple",
      delegated: false,
    });
    expect(answer.run.counts.ptcCalls).toBe(1);
  });

  test("persists the host workflow before applying provider quality controls", async () => {
    const writtenPaths: string[] = [];
    const underlying = createMemoryResearchWorkspace();
    const workspace = {
      ...underlying,
      async writeFile(path: string, contents: string) {
        writtenPaths.push(path);
        await underlying.writeFile(path, contents);
      },
    };
    let factoryCalls = 0;
    const withFactory = createKiteweaveChatAgent({
      StateBackend,
      createDeepAgent,
      createSubAgentMiddleware,
      createSummarizationMiddleware,
      registerHarnessProfile,
    }, {
      defaultModelFactory: ({ qualityPolicy }) => {
        factoryCalls += 1;
        expect(writtenPaths).toContain(CHAT_STRATEGY_STATE_PATH_V1);
        expect(qualityPolicy).toEqual(chatQualityPolicyV1("auto"));
        return {
          model: model(true),
          modelId: "capability-free-test-model",
          qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
          structuredOutput: "tool",
        };
      },
    });
    const input = request("Answer this simple conversational question.");
    const answer = await withFactory.runChatAgent({
      ...input,
      apiKey: "test-only",
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("auto"),
    });
    expect(factoryCalls).toBe(1);
    expect(answer.strategy).toMatchObject({ path: "direct" });
  });

  test("Auto and Deep record the same agentic trajectory without provider effort support", async () => {
    for (const mode of ["auto", "deep"] as const) {
      const input = request("Compare the two policy positions and check for contradictions.");
      const workspace = createMemoryResearchWorkspace();
      const answer = await runtime.runChatAgent({
        ...input,
        model: model(true, true),
        providers,
        workspace,
        qualityPolicy: chatQualityPolicyV1(mode),
      });
      expect(answer.strategy).toMatchObject({
        qualityMode: mode,
        path: "agentic",
        reasonCode: "agentic-required",
        delegated: true,
        expectedComplexity: "complex",
      });
      expect(answer.strategy.reasonCodes).toEqual([
        "no-atlassian-acquisition",
        "multi-source-comparison",
        "contradiction-risk",
      ]);
      expect(answer.run.counts.ptcCalls).toBe(4);
    }
  });

  test("fails closed when Auto bypasses its required strategy decision", async () => {
    const input = request("Answer this simple conversational question.");
    await expect(runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("auto"),
    })).rejects.toThrow("without acknowledging its accepted strategy decision");
  });

  test("reserves the final agentic evidence review instead of letting acquisition exhaust PTC", () => {
    const limits = { ...DEFAULT_RESEARCH_LIMITS_V1, maxPtcCalls: 4 };
    const budget = new ResearchRunBudget(limits);
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("auto"),
      question: "Compare the Jira implementation with the Confluence policy.",
      scope: {
        siteOrigin: "https://tenant-a.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["SPACE"],
      },
      anchors: [],
    });
    budget.beginPtc({ control: "strategy" });
    budget.beginPtc({ content: 1 });
    budget.beginPtc({ content: 2 });
    expect(() => assertChatFinalReviewReserveV1({
      strategy: decision,
      budget,
      maxPtcCalls: limits.maxPtcCalls,
    })).toThrow("reserved final evidence review");
    expect(() => budget.beginPtc({ control: "review" })).not.toThrow();
  });
});
