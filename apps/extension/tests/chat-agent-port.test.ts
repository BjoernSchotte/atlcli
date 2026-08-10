import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  chatQualityPolicyForModeV1,
  type ChatAnswerV1,
  type ChatInteractionStateV1,
  type ChatQualityModeV1,
  type ResearchPort,
  type ResearchRequestV1,
  type ResearchRunOptions,
} from "@atlcli/research";
import { chromeChatAgentPort } from "../entrypoints/sidepanel/ports/research.js";

const siteOrigin = "https://tenant-a.atlassian.net";
const conversationId = "research-session:chrome-port";
const turnId = "research-turn:chrome-port";
const request: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: "Summarize the exact attached page.",
  scope: {
    siteOrigin,
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["DOCSY"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 60_000 },
  wikiProvider: "rest",
};

function answer(mode: ChatQualityModeV1): ChatAnswerV1 {
  return {
    schema: "atlcli.chat-answer/v1",
    messageMarkdown: `# ${mode}\n\nA bounded answer.`,
    citations: [],
    evidenceRefs: [],
    gaps: [],
    strategy: {
      qualityMode: mode,
      path: "direct",
      delegated: false,
      reasonCode: `${mode}-direct`,
      reasonCodes: ["single-exact-context"],
      ambiguityDisposition: "none",
      requiredCapabilities: ["exact-read", "chat-answer"],
      expectedComplexity: "simple",
      qualityRisks: [],
    },
    run: {
      model: "synthetic-provider-neutral-model",
      startedAt: "2026-08-06T12:00:00.000Z",
      completedAt: "2026-08-06T12:00:01.000Z",
      durationMs: 1_000,
      counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 0, confluenceItems: 1 },
    },
  };
}

function researchPort(overrides: Partial<ResearchPort> = {}): ResearchPort {
  const base: ResearchPort = {
    async hasApiKey() { return true; },
    async setApiKey() {},
    async clearApiKey() {},
    async resolveScope(input) {
      return {
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request: input,
        mentions: [],
        resolutions: [],
      };
    },
    async run() { return answer("auto"); },
    async copyMarkdown() {},
    async downloadMarkdown() {},
  };
  return Object.assign(base, overrides);
}

describe("Chrome ChatAgentPortV1 adapter", () => {
  test("forwards every quality mode, durable conversation identity, and live stream losslessly", async () => {
    const observed: Array<{
      mode?: string;
      conversationId?: string;
      runMode?: string;
    }> = [];
    const sessions: string[] = [];
    const presentations: string[] = [];
    const port = chromeChatAgentPort(researchPort({
      async run(_input, options) {
        observed.push({
          mode: options?.qualityPolicy?.mode,
          conversationId: options?.conversationId,
          runMode: options?.mode,
        });
        options?.onSessionStart?.({ sessionId: conversationId, turnId });
        options?.onChatPresentation?.({
          kind: "chat-presentation",
          seq: 1,
          at: "2026-08-06T12:00:00.000Z",
          channel: "reasoning-summary",
          status: "delta",
          delta: "Checking the attached page.",
        });
        return answer(options?.qualityPolicy?.mode ?? "auto");
      },
    }));

    for (const mode of ["quick", "auto", "deep"] as const) {
      await port.startTurn({
        request,
        conversationId,
        qualityPolicy: chatQualityPolicyForModeV1(mode),
      }, {
        onSessionStart: (session) => sessions.push(`${session.conversationId}/${session.turnId}`),
        onPresentation: (event) => presentations.push(event.delta ?? ""),
      });
    }

    expect(observed).toEqual([
      { mode: "quick", conversationId, runMode: "chat" },
      { mode: "auto", conversationId, runMode: "chat" },
      { mode: "deep", conversationId, runMode: "chat" },
    ]);
    expect(sessions).toEqual(Array(3).fill(`${conversationId}/${turnId}`));
    expect(presentations).toEqual(Array(3).fill("Checking the attached page."));
  });

  test("resumes HITL and steering from host-owned envelopes instead of presenter input", async () => {
    const runs: Array<Pick<
      ResearchRunOptions,
      "mode" | "conversationId" | "qualityPolicy" | "chatResume" | "chatCheckpointResume"
    >> = [];
    const policy = chatQualityPolicyForModeV1("deep");
    const question = {
      schema: "atlcli.chat-user-question/v1" as const,
      id: "chat-question:audience",
      responseKind: "single_choice" as const,
      prompt: "Which audience should the summary address?",
      required: true,
      options: [
        { id: "audience:leadership", label: "Leadership" },
        { id: "audience:team", label: "Team" },
      ],
    };
    const interaction = {
      conversationId,
      acceptedSteering: {
        id: "chat-steering:one",
        revision: 2,
        turnId,
        instruction: "Focus on the decision.",
        resume: { request, qualityPolicy: policy },
      },
    } as unknown as ChatInteractionStateV1;
    const port = chromeChatAgentPort(researchPort({
      async getPendingChatQuestion() {
        return { conversationId, turnId, question, request, qualityPolicy: policy };
      },
      async getChatInteraction() { return interaction; },
      async run(_input, options) {
        runs.push({
          mode: options?.mode,
          conversationId: options?.conversationId,
          qualityPolicy: options?.qualityPolicy,
          chatResume: options?.chatResume,
          chatCheckpointResume: options?.chatCheckpointResume,
        });
        return answer("deep");
      },
    }));

    await port.answerQuestion({
      siteOrigin,
      conversationId,
      turnId,
      answer: {
        schema: "atlcli.chat-user-question-answer/v1",
        questionId: question.id,
        value: { kind: "selection", optionIds: ["audience:leadership"] },
      },
    });
    await port.resumeTurn({
      siteOrigin,
      conversationId,
      turnId,
      kind: "steering",
    });

    expect(runs[0]).toMatchObject({
      mode: "chat",
      conversationId,
      qualityPolicy: { mode: "deep" },
      chatResume: {
        turnId,
        answer: { questionId: question.id },
      },
    });
    expect(runs[1]).toMatchObject({
      mode: "chat",
      conversationId,
      qualityPolicy: { mode: "deep" },
      chatCheckpointResume: { turnId, kind: "steering" },
    });
  });

  test("delegates queue controls and cooperatively stops only the active Chat turn", async () => {
    const commands: string[] = [];
    let release: (() => void) | undefined;
    const port = chromeChatAgentPort(researchPort({
      async controlActiveChat(command) {
        commands.push(command.kind);
        return { conversationId, revision: 2, queue: [] } as unknown as ChatInteractionStateV1;
      },
      run(_input, options) {
        return new Promise<ChatAnswerV1>((_resolve, reject) => {
          release = () => reject(options?.signal?.reason);
          options?.signal?.addEventListener("abort", release, { once: true });
        });
      },
    }));

    await port.control({
      kind: "enqueue",
      expectedRevision: 1,
      messageId: "chat-message:next",
      content: "Follow up.",
    });
    const running = port.startTurn({
      request,
      conversationId,
      qualityPolicy: chatQualityPolicyForModeV1("auto"),
    });
    await Promise.resolve();
    expect(await port.stop()).toBe("stop_requested");
    await expect(running).rejects.toBeInstanceOf(DOMException);
    expect(commands).toEqual(["enqueue"]);
    expect(release).toBeDefined();
    expect(await port.stop()).toBe("stopped");
  });
});
