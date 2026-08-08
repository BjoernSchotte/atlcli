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
  ResearchContractError,
  type ResearchOneShotEventV1,
  type ResearchRequestV1,
} from "../contracts.js";
import { isResearchOneShotEventV1 } from "../events.js";
import { ResearchRunBudget } from "../budget.js";
import { createResearchKeyScopeSeedV1 } from "../scope-discovery.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
} from "../quality-policy.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import type { ChatTurnRequestV1 } from "./contracts.js";
import { WorkspaceChatActivityJournalV1 } from "./activity.js";
import {
  assertChatFinalReviewReserveV1,
  chatModelCallLimitV1,
  chatRootPlanningPreferenceV1,
  chatRootOutputTokenLimitV1,
  createKiteweaveChatAgent,
  decideChatRepairAdmissionV1,
  isChatAnswerStructuredOutputErrorV1,
} from "./runtime.js";
import {
  CHAT_INTERACTION_STATE_PATH_V1,
  CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
  ChatUserQuestionRequiredError,
  WorkspaceChatInteractionControllerV1,
  bindChatSteeringResumeV1,
  consumeChatSteeringV1,
  requestChatSteeringV1,
  type ChatInteractionStateV1,
} from "./interaction.js";
import { CHAT_SESSION_PATH_V1, type ChatSessionV1 } from "./session.js";
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
    { taskId: "task:contradiction", profileId: "contradiction-checker", objective: "Check the bounded synthetic positions for contradictions.", dependencyTaskIds: ["task:compare"] },
    { taskId: "task:draft", profileId: "answer-drafter", objective: "Draft the bounded synthetic answer.", dependencyTaskIds: ["task:compare", "task:contradiction"] },
    { taskId: "task:critic", profileId: "answer-critic", objective: "Check the bounded synthetic evidence state.", dependencyTaskIds: ["task:draft"] },
    { taskId: "task:synth", profileId: "chat-synthesizer", objective: "Write the conversational answer.", dependencyTaskIds: ["task:draft", "task:critic"] }
  ],
  maxConcurrency: 1
}));
globalThis.syntheticWorkflowRun = JSON.parse(await tools.chatWorkflowRun({}));
syntheticWorkflowRun;`;
    return built
      .respondWithTools([{ name: "eval", args: { code: proposalCode } }])
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
          blocks: [{
            id: "answer-block:provisional",
            markdown: "A bounded provisional synthetic answer.",
            sourceRefs: [],
            assertion: "none",
            scope: "none",
          }],
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
        name: "ChatAnswerDraftV2",
        args: {
          blocks: [{
            id: "answer-block:agentic",
            markdown: "A bounded synthetic agentic Chat answer.",
            sourceRefs: [],
            assertion: "none",
            scope: "none",
          }],
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
    name: "ChatAnswerDraftV2",
    args: {
      blocks: [{
        id: "answer-block:direct",
        markdown: "A bounded synthetic Chat answer.",
        sourceRefs: [],
        assertion: "none",
        scope: "none",
      }],
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
    expect(middlewareNames.indexOf("ChatDirectToolSurfaceMiddleware"))
      .toBeLessThan(middlewareNames.indexOf("ChatRootModelBudgetMiddleware"));
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

  test("Quick delegates scoped discovery to one host-owned acquisition controller", async () => {
    const input = request("Summarize the bounded design page in the approved space.");
    input.turn = {
      ...input.turn,
      scope: { ...input.turn.scope, confluenceSpaceKeys: ["KB"] },
    };
    input.brokerRequest = {
      ...input.brokerRequest,
      scope: { ...input.brokerRequest.scope, confluenceSpaceKeys: ["KB"] },
      scopeSeeds: [createResearchKeyScopeSeedV1({
        tenantOrigin: input.brokerRequest.scope.siteOrigin,
        product: "confluence",
        key: "KB",
        source: "cli_flag",
        authority: "approved",
      })],
    };
    const calls: string[] = [];
    const scopedProviders = {
      jira: providers.jira,
      wiki: {
        async searchPage(search: { cql: string }) {
          calls.push(`search:${search.cql}`);
          return {
            items: [{ contentId: "1001", spaceKey: "KB", title: "Bounded design" }],
          };
        },
        async getPage(page: { contentId: string }) {
          calls.push(`detail:${page.contentId}`);
          return {
            contentId: page.contentId,
            spaceKey: "KB",
            title: "Bounded design",
            content: {
              text: "The bounded design establishes the accepted architecture.",
              linkTargets: [],
              truncated: false,
              inputBytes: 59,
            },
          };
        },
      },
    };
    const directModel = fakeModel()
      .respondWithTools([{
        name: "eval",
        args: {
          code: "JSON.parse(await tools.chatConfluenceRetrievalAcquire({}))",
        },
      }])
      .respondWithTools([{
        name: "ChatAnswerDraftV2",
        args: {
          blocks: [{
            id: "answer-block:bounded-design",
            markdown: "The bounded design establishes the accepted architecture.",
            sourceRefs: ["wiki:1001"],
            assertion: "positive",
            scope: "none",
          }],
          gaps: [],
        },
      }]);

    const answer = await runtime.runChatAgent({
      ...input,
      model: directModel,
      providers: scopedProviders,
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("quick"),
    });

    expect(answer.strategy).toMatchObject({ path: "direct", delegated: false });
    expect(answer.citations).toEqual([
      expect.objectContaining({ sourceId: "wiki:1001", product: "confluence" }),
    ]);
    expect(calls.filter((entry) => entry.startsWith("search:"))).toHaveLength(1);
    expect(calls).toContain("detail:1001");
    expect(answer.run.retrieval).toMatchObject({
      discoveredCandidates: 1,
      detailReadCandidates: 1,
      detailReadCoverage: 1,
    });
  });

  test("pauses and resumes the production Chat root through one durable askUserQuestion checkpoint", async () => {
    const input = request("Use the approved reporting window.");
    const workspace = createMemoryResearchWorkspace();
    const askingModel = fakeModel().respondWithTools([{
      name: "ask_user_question",
      args: {
        responseKind: "single_choice",
        prompt: "Which approved reporting window should I use?",
        required: true,
        options: [
          { id: "window:seven", label: "Seven days" },
          { id: "window:thirty", label: "Thirty days" },
        ],
      },
    }]);
    let required: ChatUserQuestionRequiredError | undefined;
    try {
      await runtime.runChatAgent({
        ...input,
        model: askingModel,
        providers,
        workspace,
        qualityPolicy: chatQualityPolicyV1("quick"),
      });
    } catch (error) {
      if (!(error instanceof ChatUserQuestionRequiredError)) throw error;
      required = error;
    }
    expect(required?.question.responseKind).toBe("single_choice");
    expect(askingModel.callCount).toBe(1);
    const waitingSession = JSON.parse(
      (await workspace.readFile(CHAT_SESSION_PATH_V1))!,
    ) as ChatSessionV1;
    expect(waitingSession.operations.activeTurnId).toBe(input.turn.turnId);
    expect(waitingSession.conversation.recentTurns.at(-1)?.status).toBe("waiting");
    const waitingInteraction = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(waitingInteraction.pendingQuestion?.question.id).toBe(required?.question.id);

    const resumedModel = model(false);
    const answer = await runtime.runChatAgent({
      ...input,
      model: resumedModel,
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      resumeAnswer: {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: required!.question.id,
        value: { kind: "selection", optionIds: ["window:seven"] },
      },
    });
    expect(answer.messageMarkdown).toBe("A bounded synthetic Chat answer.");
    expect(resumedModel.callCount).toBe(1);
    const completedInteraction = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(completedInteraction.pendingQuestion).toBeUndefined();
    expect(completedInteraction.resolvedQuestions.at(-1)?.answer.value)
      .toEqual({ kind: "selection", optionIds: ["window:seven"] });
  });

  test("replans the same durable turn after host-accepted steering", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const binding = {
      ...hostIdentity,
      threadId: input.turn.conversationId,
      tenantOrigin: input.turn.scope.siteOrigin,
    };
    const interactions = await WorkspaceChatInteractionControllerV1.bind({
      workspace,
      conversationId: input.turn.conversationId,
      binding,
      at: "2026-08-06T12:30:00.000Z",
    });
    const requested = await interactions.update((state) =>
      requestChatSteeringV1({
        state,
        expectedRevision: state.revision,
        steeringId: "chat-steering:runtime",
        instruction: "Focus on the open decision.",
        at: "2026-08-06T12:30:01.000Z",
      })
    );
    await interactions.update((state) =>
      bindChatSteeringResumeV1({
        state,
        expectedRevision: state.revision,
        steeringId: requested.pendingSteering!.id,
        expectedSteeringRevision: requested.pendingSteering!.revision,
        turnId: input.turn.turnId,
        resume: {
          request: input.brokerRequest,
          qualityPolicy: chatQualityPolicyV1("quick"),
        },
        at: "2026-08-06T12:30:02.000Z",
      })
    );
    const interrupted = new AbortController();
    interrupted.abort(new ResearchContractError(
      "paused",
      "The Chat turn reached its steering checkpoint.",
    ));
    await expect(runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      signal: interrupted.signal,
    })).rejects.toMatchObject({ code: "paused" });
    const waiting = JSON.parse(
      (await workspace.readFile(CHAT_SESSION_PATH_V1))!,
    ) as ChatSessionV1;
    expect(waiting.conversation.recentTurns.at(-1)).toMatchObject({
      status: "waiting",
      waitingReason: "steering",
    });

    const restoredInteractions = await WorkspaceChatInteractionControllerV1.bind({
      workspace,
      conversationId: input.turn.conversationId,
      binding,
      at: "2026-08-06T12:30:03.000Z",
    });
    await restoredInteractions.update((state) =>
      consumeChatSteeringV1({
        state,
        expectedRevision: state.revision,
        steeringId: state.pendingSteering!.id,
        expectedSteeringRevision: state.pendingSteering!.revision,
        at: "2026-08-06T12:30:04.000Z",
      }).state
    );
    const resumed = await runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      resumeCheckpoint: { kind: "steering" },
    });
    expect(resumed.messageMarkdown).toBe("A bounded synthetic Chat answer.");
    const completedInteractions = await WorkspaceChatInteractionControllerV1.bind({
      workspace,
      conversationId: input.turn.conversationId,
      binding,
      at: "2026-08-06T12:30:05.000Z",
    });
    expect(completedInteractions.snapshot().acceptedSteering).toBeUndefined();
  });

  test("resumes a failed model stream from the same durable checkpoint", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const interruptedModel = fakeModel().respond(new Error("synthetic provider stream disconnected"));

    await expect(runtime.runChatAgent({
      ...input,
      model: interruptedModel,
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
    })).rejects.toMatchObject({
      code: "paused",
      message: expect.stringContaining("durable checkpoint"),
    });
    const waiting = JSON.parse(
      (await workspace.readFile(CHAT_SESSION_PATH_V1))!,
    ) as ChatSessionV1;
    expect(waiting.conversation.recentTurns.at(-1)).toMatchObject({
      status: "waiting",
      waitingReason: "stream-interruption",
    });
    const interruption = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(interruption.streamInterruption).toMatchObject({
      kind: "stream-interruption",
      turnId: input.turn.turnId,
      resumeAttempts: 0,
    });

    const recoveredModel = model(false);
    const answer = await runtime.runChatAgent({
      ...input,
      model: recoveredModel,
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      resumeCheckpoint: { kind: "stream-interruption" },
    });
    expect(answer.messageMarkdown).toBe("A bounded synthetic Chat answer.");
    expect(interruptedModel.callCount).toBe(1);
    expect(recoveredModel.callCount).toBe(1);
    const completedInteraction = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(completedInteraction.streamInterruption).toBeUndefined();
  });

  test("does not misclassify an invalid structured answer as a resumable provider stream", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const invalidModel = fakeModel()
      .respondWithTools([{ name: "ChatAnswerDraftV2", args: {} }])
      .respondWithTools([{ name: "ChatAnswerDraftV2", args: {} }]);

    await expect(runtime.runChatAgent({
      ...input,
      model: invalidModel,
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
    })).rejects.toMatchObject({ code: "invalid-report" });

    const interaction = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(interaction.streamInterruption).toBeUndefined();
    expect(invalidModel.callCount).toBe(2);
  });

  test("repairs one invalid provider-native terminal answer without repeating retrieval", async () => {
    const input = request("Answer this simple conversational question.");
    const workspace = createMemoryResearchWorkspace();
    const nativeModel = fakeModel()
      .respond(new AIMessage("not valid structured JSON"))
      .respond(new AIMessage(JSON.stringify({
        blocks: [{
          id: "answer-block:native-repair",
          markdown: "A repaired native Chat answer.",
          sourceRefs: [],
          assertion: "none",
          scope: "none",
        }],
        gaps: [],
      })));

    const answer = await runtime.runChatAgent({
      ...input,
      modelBinding: {
        model: nativeModel,
        modelId: "synthetic-native-model",
        qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
        structuredOutput: "native",
      },
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
    });

    expect(answer.messageMarkdown).toBe("A repaired native Chat answer.");
    expect(nativeModel.callCount).toBe(2);
    const interaction = JSON.parse(
      (await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1))!,
    ) as ChatInteractionStateV1;
    expect(interaction.streamInterruption).toBeUndefined();
  });

  test("keeps enough root output budget for a complete Quick structured answer", () => {
    expect(chatRootOutputTokenLimitV1({
      configuredMaxOutputTokens: 8_000,
      qualityMode: "quick",
    })).toBe(4_096);
    expect(chatRootOutputTokenLimitV1({
      configuredMaxOutputTokens: 3_000,
      qualityMode: "quick",
    })).toBe(3_000);
    expect(isChatAnswerStructuredOutputErrorV1(new Error(
      "Failed to parse structured output for tool 'ChatAnswerDraftV2'",
    ))).toBe(true);
    expect(isChatAnswerStructuredOutputErrorV1(new Error(
      "Failed to parse structured output for tool 'providerStrategy'",
    ))).toBe(true);
  });

  test("emits durable user-facing milestones around analysis and answer validation", async () => {
    const input = request("Answer this simple conversational question.");
    const events: Array<{ kind: string; phase?: string; code?: string; status?: string }> = [];
    const workspace = createMemoryResearchWorkspace();

    await runtime.runChatAgent({
      ...input,
      model: model(false),
      providers,
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.kind === "phase").map((event) => event.phase))
      .toEqual(["preparing", "checking", "rendering"]);
    expect(events.filter((event) => event.kind === "activity").map((event) => [
      event.code,
      event.status,
    ])).toEqual([
      ["strategy", "started"],
      ["strategy", "completed"],
      ["model-assessing", "started"],
      ["model-assessing", "completed"],
      ["synthesis", "started"],
      ["synthesis", "completed"],
      ["completion", "completed"],
    ]);
    const session = JSON.parse((await workspace.readFile(CHAT_SESSION_PATH_V1))!) as ChatSessionV1;
    const completedTurn = session.conversation.recentTurns.at(-1)!;
    expect(completedTurn.finalAnswer?.messageMarkdown).toBe("A bounded synthetic Chat answer.");
    const journal = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId: input.turn.conversationId,
    });
    const replayedActivity: Array<[string, string]> = journal
      .eventsForReferences(completedTurn.activityRefs)
      .map((event) => [event.code, event.status]);
    const emittedActivity: Array<[string, string]> = events
      .filter((event) => event.kind === "activity")
      .map((event) => [event.code!, event.status!]);
    expect(replayedActivity).toEqual(emittedActivity);
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
      const events: ResearchOneShotEventV1[] = [];
      const observations: Array<{ role: string }> = [];
      const trajectoryModel = model(true, true);
      const answer = await runtime.runChatAgent({
        ...input,
        model: trajectoryModel,
        providers,
        workspace,
        qualityPolicy: chatQualityPolicyV1(mode),
        onEvent: (event) => events.push(event),
        onModelCallObservation: (observation) => {
          observations.push(observation);
        },
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
      expect(observations.filter((observation) => observation.role === "root")).toHaveLength(1);
      expect(trajectoryModel.callCount).toBeLessThanOrEqual(10);
      expect(events.every(isResearchOneShotEventV1)).toBe(true);
      expect(events.filter((event) => event.kind === "activity").map((event) => event.code))
        .toEqual(expect.arrayContaining([
          "strategy",
          "child-work",
          "critique",
          "synthesis",
          "completion",
        ]));
    }
  });

  test("repairs one Auto response that initially bypasses its required strategy decision", async () => {
    const input = request("Answer this simple conversational question.");
    const bypassThenRepair = fakeModel()
      .respondWithTools([{
        name: "ChatAnswerDraftV2",
        args: {
          blocks: [{
            id: "answer-block:premature",
            markdown: "This premature answer must not be accepted.",
            sourceRefs: [],
            assertion: "none",
            scope: "none",
          }],
          gaps: [],
        },
      }])
      .respondWithTools([{
        name: "eval",
        args: { code: "JSON.parse(await tools.chatStrategyDecide({}))" },
      }])
      .respondWithTools([{
        name: "ChatAnswerDraftV2",
        args: {
          blocks: [{
            id: "answer-block:repaired",
            markdown: "A bounded synthetic Chat answer.",
            sourceRefs: [],
            assertion: "none",
            scope: "none",
          }],
          gaps: [],
        },
      }]);
    const answer = await runtime.runChatAgent({
      ...input,
      model: bypassThenRepair,
      providers,
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("auto"),
    });
    expect(answer.strategy).toMatchObject({ path: "direct", qualityMode: "auto" });
    expect(answer.messageMarkdown).toBe("A bounded synthetic Chat answer.");
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

  test("gives default agentic Chat enough calls for ToolStrategy repair and synthesis", () => {
    expect(chatModelCallLimitV1({
      configuredMaxModelCalls: DEFAULT_RESEARCH_LIMITS_V1.maxModelCalls,
      qualityMode: "deep",
      execution: "agentic",
    })).toBe(28);
    expect(chatModelCallLimitV1({
      configuredMaxModelCalls: DEFAULT_RESEARCH_LIMITS_V1.maxModelCalls,
      qualityMode: "auto",
      execution: "agentic",
    })).toBe(28);
    expect(chatModelCallLimitV1({
      configuredMaxModelCalls: 12,
      qualityMode: "deep",
      execution: "agentic",
    })).toBe(12);
  });

  test("keeps direct Deep thorough while agentic depth uses bounded root planning", () => {
    expect(chatRootPlanningPreferenceV1({
      qualityMode: "deep",
      execution: "direct",
    })).toBe("thorough");
    expect(chatRootPlanningPreferenceV1({
      qualityMode: "deep",
      execution: "agentic",
    })).toBe("balanced");
    expect(chatRootPlanningPreferenceV1({
      qualityMode: "auto",
      execution: "agentic",
    })).toBe("balanced");
    expect(chatRootPlanningPreferenceV1({
      qualityMode: "quick",
      execution: "direct",
    })).toBe("fast");
  });

  test("keeps Auto conversational while Deep may admit one bounded repair", () => {
    expect(decideChatRepairAdmissionV1({
      qualityMode: "auto",
      remainingMs: 120_000,
      hasModelReserve: true,
    })).toEqual({ admit: false, reason: "auto-latency-policy" });
    expect(decideChatRepairAdmissionV1({
      qualityMode: "deep",
      remainingMs: 120_000,
      hasModelReserve: true,
    })).toEqual({ admit: true });
    expect(decideChatRepairAdmissionV1({
      qualityMode: "deep",
      remainingMs: 29_999,
      hasModelReserve: true,
    })).toEqual({ admit: false, reason: "deadline-reserve" });
    expect(decideChatRepairAdmissionV1({
      qualityMode: "deep",
      remainingMs: 120_000,
      hasModelReserve: false,
    })).toEqual({ admit: false, reason: "model-budget-reserve" });
  });
});
