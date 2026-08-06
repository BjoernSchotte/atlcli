import { describe, expect, test } from "bun:test";
import {
  CHAT_SESSION_PATH_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  InMemoryResearchSessionStoreV1,
  WorkspaceChatActivityJournalV1,
  WorkspaceChatInteractionControllerV1,
  beginChatTurnV1,
  chatQualityPolicyForModeV1,
  chatScopeFingerprintV1,
  completeChatTurnV1,
  createChatSessionV1,
  createResearchSessionV1,
  type ChatAnswerV1,
  type ResearchRequestV1,
} from "@atlcli/research";
import { createCliChatAgentPortV1 } from "./chat-agent-port.js";

const siteOrigin = "https://tenant-a.atlassian.net";
const conversationId = "research-session:cli-port";
const turnId = "research-turn:cli-port";
const identity = {
  userId: "principal:cli-port",
  providerCacheIdentity: "provider-cache:cli-port",
};
const request: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: "Summarize DOCSY.",
  scope: {
    siteOrigin,
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["DOCSY"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 60_000 },
  wikiProvider: "rest",
};
const answer: ChatAnswerV1 = {
  schema: "atlcli.chat-answer/v1",
  messageMarkdown: "# DOCSY\n\nA bounded answer.",
  citations: [],
  evidenceRefs: [],
  gaps: [],
  strategy: {
    qualityMode: "auto",
    path: "direct",
    delegated: false,
    reasonCode: "auto-direct",
    reasonCodes: ["single-exact-context"],
    ambiguityDisposition: "none",
    requiredCapabilities: ["chat-answer"],
    expectedComplexity: "simple",
    qualityRisks: [],
  },
  run: {
    model: "synthetic-port-model",
    startedAt: "2026-08-06T10:00:00.000Z",
    completedAt: "2026-08-06T10:00:01.000Z",
    durationMs: 1_000,
    counts: {
      ptcCalls: 0,
      httpCalls: 0,
      jiraItems: 0,
      confluenceItems: 0,
    },
  },
};

async function fixture() {
  const store = new InMemoryResearchSessionStoreV1();
  await store.create(createResearchSessionV1({
    sessionId: conversationId,
    ownerId: "owner:cli-port",
    createdAt: "2026-08-06T10:00:00.000Z",
    leaseExpiresAt: "2026-08-06T10:10:00.000Z",
  }));
  return { store, workspace: await store.workspace(conversationId) };
}

describe("CLI ChatAgentPortV1 adapter", () => {
  test("forwards every provider-neutral quality mode through the same durable conversation", async () => {
    const { store, workspace } = await fixture();
    const observed: Array<{ mode: string; conversationId: string; turnId: string }> = [];
    let turnSequence = 0;
    const port = createCliChatAgentPortV1({
      store,
      workspace,
      conversationId,
      siteOrigin,
      hostIdentity: identity,
      createTurnId: () => `research-turn:cli-quality-${++turnSequence}`,
      async execute(input) {
        observed.push({
          mode: input.qualityPolicy.mode,
          conversationId: input.conversationId,
          turnId: input.turnId,
        });
        return {
          ...answer,
          strategy: {
            ...answer.strategy,
            qualityMode: input.qualityPolicy.mode,
          },
        };
      },
    });

    for (const mode of ["quick", "auto", "deep"] as const) {
      await port.startTurn({
        request,
        conversationId,
        qualityPolicy: chatQualityPolicyForModeV1(mode),
      });
    }

    expect(observed).toEqual([
      { mode: "quick", conversationId, turnId: "research-turn:cli-quality-1" },
      { mode: "auto", conversationId, turnId: "research-turn:cli-quality-2" },
      { mode: "deep", conversationId, turnId: "research-turn:cli-quality-3" },
    ]);
  });

  test("projects the same history, replay, artifact, sources and controls contract", async () => {
    const { store, workspace } = await fixture();
    const port = createCliChatAgentPortV1({
      store,
      workspace,
      conversationId,
      siteOrigin,
      hostIdentity: identity,
      createTurnId: () => turnId,
      async execute(input) {
        const startedAt = "2026-08-06T10:00:00.000Z";
        let session = createChatSessionV1({
          conversationId,
          identity,
          tenantOrigin: siteOrigin,
          createdAt: startedAt,
        });
        session = beginChatTurnV1({
          session,
          expectedSessionRevision: session.revision,
          turnId: input.turnId,
          objective: input.request.question,
          qualityMode: input.qualityPolicy.mode,
          scopeFingerprint: await chatScopeFingerprintV1({
            scope: input.request.scope,
            scopeBindings: [],
          }),
          startedAt,
        });
        const journal = await WorkspaceChatActivityJournalV1.open({
          workspace,
          conversationId,
        });
        journal.record({
          turnId: input.turnId,
          at: "2026-08-06T10:00:00.500Z",
          code: "model-assessing",
          status: "completed",
        });
        await journal.flush();
        session = completeChatTurnV1({
          session,
          expectedSessionRevision: session.revision,
          turnId: input.turnId,
          answer,
          acceptedStrategy: answer.strategy,
          activityRefs: journal.referencesForTurn(input.turnId),
          evidenceRecords: [],
          completedAt: "2026-08-06T10:00:01.000Z",
        });
        await workspace.writeFile(CHAT_SESSION_PATH_V1, JSON.stringify(session));
        return answer;
      },
    });

    const started: string[] = [];
    await port.startTurn(
      { request, qualityPolicy: chatQualityPolicyForModeV1("auto") },
      { onSessionStart: (session) => started.push(`${session.conversationId}/${session.turnId}`) },
    );
    expect(started).toEqual([`${conversationId}/${turnId}`]);
    expect(await port.listHistory(siteOrigin)).toEqual([expect.objectContaining({
      conversationId,
      latestTurnId: turnId,
      latestObjective: request.question,
      status: "complete",
    })]);
    expect(await port.replay({ siteOrigin })).toMatchObject({
      conversationId,
      turnId,
      objective: request.question,
      events: [{ code: "model-assessing", status: "completed" }],
      finalAnswer: { messageMarkdown: answer.messageMarkdown },
    });
    expect(await port.artifact({ siteOrigin, conversationId, turnId })).toEqual({
      conversationId,
      turnId,
      mediaType: "text/markdown",
      markdown: answer.messageMarkdown,
    });
    expect(await port.sources({ siteOrigin, conversationId, turnId })).toEqual({
      conversationId,
      turnId,
      sources: [],
    });

    const initial = await port.getInteraction(siteOrigin);
    expect(initial).toBeNull();
    const queued = await port.control({
      kind: "enqueue",
      expectedRevision: 1,
      messageId: "chat-message:one",
      content: "Follow up.",
    });
    expect(queued.queue).toEqual([expect.objectContaining({
      id: "chat-message:one",
      content: "Follow up.",
    })]);
    const edited = await port.control({
      kind: "edit",
      expectedRevision: queued.revision,
      messageId: "chat-message:one",
      expectedMessageRevision: 1,
      content: "Edited follow up.",
    });
    const removed = await port.control({
      kind: "remove",
      expectedRevision: edited.revision,
      messageId: "chat-message:one",
      expectedMessageRevision: 2,
    });
    expect(removed.queue).toEqual([]);
  });

  test("stops the active provider-neutral execution", async () => {
    const { store, workspace } = await fixture();
    const port = createCliChatAgentPortV1({
      store,
      workspace,
      conversationId,
      siteOrigin,
      hostIdentity: identity,
      createTurnId: () => turnId,
      execute: ({ signal }) => new Promise<ChatAnswerV1>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const running = port.startTurn({
      request,
      qualityPolicy: chatQualityPolicyForModeV1("quick"),
    });
    await Promise.resolve();
    expect(await port.stop()).toBe("stop_requested");
    await expect(running).rejects.toBeInstanceOf(DOMException);
  });

  test("binds active steering to the durable resume envelope and resumes the same turn", async () => {
    const { store, workspace } = await fixture();
    const port = createCliChatAgentPortV1({
      store,
      workspace,
      conversationId,
      siteOrigin,
      hostIdentity: identity,
      createTurnId: () => turnId,
      async execute(input) {
        if (input.resumeCheckpoint?.kind === "steering") return answer;
        const interactions = await WorkspaceChatInteractionControllerV1.bind({
          workspace,
          conversationId,
          binding: {
            ...identity,
            threadId: conversationId,
            tenantOrigin: siteOrigin,
          },
          at: "2026-08-06T10:00:00.000Z",
        });
        input.onInteractionReady?.(interactions);
        input.onResumeEnvelopeReady?.({
          request: input.request,
          qualityPolicy: input.qualityPolicy,
        });
        return new Promise<ChatAnswerV1>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), {
            once: true,
          });
        });
      },
      now: () => new Date("2026-08-06T10:00:01.000Z"),
    });

    const running = port.startTurn({
      request,
      qualityPolicy: chatQualityPolicyForModeV1("deep"),
    });
    const paused = running.catch((error: unknown) => error);
    await Promise.resolve();
    const steered = await port.control({
      kind: "steer",
      expectedRevision: 1,
      steeringId: "chat-steering:cli-port",
      instruction: "Prioritize the explicit contradiction.",
    });
    expect(steered.pendingSteering).toMatchObject({
      id: "chat-steering:cli-port",
      turnId,
      instruction: "Prioritize the explicit contradiction.",
      resume: {
        request,
        qualityPolicy: { mode: "deep" },
      },
    });
    expect(await paused).toMatchObject({ code: "paused" });
    const accepted = await port.control({
      kind: "consume_steering",
      expectedRevision: steered.revision,
      steeringId: steered.pendingSteering!.id,
      expectedSteeringRevision: steered.pendingSteering!.revision,
    });
    expect(accepted.acceptedSteering).toMatchObject({
      id: "chat-steering:cli-port",
      turnId,
    });

    await expect(port.resumeTurn({
      siteOrigin,
      conversationId,
      turnId,
      kind: "steering",
    })).resolves.toEqual(answer);
  });
});
