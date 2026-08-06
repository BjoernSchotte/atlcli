import { describe, expect, test } from "bun:test";
import {
  CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
  CHAT_USER_QUESTION_SCHEMA_V1,
  WorkspaceChatInteractionControllerV1,
  acknowledgeChatStopV1,
  admitNextChatFollowUpV1,
  assertChatInteractionBindingV1,
  bindChatSteeringResumeV1,
  completeChatSteeringV1,
  completeChatStreamInterruptionV1,
  consumeChatSteeringV1,
  createChatInteractionStateV1,
  editChatFollowUpV1,
  editChatSteeringV1,
  enqueueChatFollowUpV1,
  parseChatInteractionStateV1,
  recordChatUserQuestionV1,
  recordChatStreamInterruptionV1,
  removeChatFollowUpV1,
  removeChatSteeringV1,
  requestChatSteeringV1,
  requestChatStopV1,
  resolveChatUserQuestionV1,
  type ChatUserQuestionV1,
} from "./interaction.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import { DEFAULT_RESEARCH_LIMITS_V1, RESEARCH_REQUEST_SCHEMA_V1 } from "../contracts.js";
import { chatQualityPolicyV1 } from "../quality-policy.js";

const binding = {
  userId: "principal:interaction-test",
  providerCacheIdentity: "provider-cache:interaction-test",
  threadId: "research-session:interaction-test",
  tenantOrigin: "https://example.atlassian.net",
} as const;
const at = (second: number) => `2026-08-06T10:00:${String(second).padStart(2, "0")}.000Z`;
const resume = {
  request: {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: "Which bounded direction should Kiteweave use?",
    scope: { siteOrigin: binding.tenantOrigin, jiraProjectKeys: [], confluenceSpaceKeys: [] },
    reportLanguage: "en" as const,
    limits: DEFAULT_RESEARCH_LIMITS_V1,
    wikiProvider: "rest" as const,
  },
  qualityPolicy: chatQualityPolicyV1("auto"),
  exactAnchors: [{
    anchorRef: "research-anchor:durable-interaction-anchor",
    bindingId: "scope-binding:current:page-1001",
  }],
};

function state() {
  return createChatInteractionStateV1({
    conversationId: binding.threadId,
    binding,
    createdAt: at(0),
  });
}

function question(
  responseKind: ChatUserQuestionV1["responseKind"],
): ChatUserQuestionV1 {
  const base = {
    schema: CHAT_USER_QUESTION_SCHEMA_V1,
    id: `chat-question:${responseKind}`,
    prompt: "Which bounded direction should Kiteweave use?",
    required: true,
  } as const;
  const options = [
    { id: "option:one", label: "First direction" },
    { id: "option:two", label: "Second direction", description: "Use the alternate scope." },
  ];
  if (responseKind === "free_text") return { ...base, responseKind, maxLength: 500 };
  if (responseKind === "single_choice") return { ...base, responseKind, options };
  if (responseKind === "multiple_choice") {
    return { ...base, responseKind, options, minSelections: 1, maxSelections: 2 };
  }
  if (responseKind === "mixed") {
    return {
      ...base,
      responseKind,
      options,
      minSelections: 0,
      maxSelections: 2,
      maxLength: 500,
    };
  }
  return {
    ...base,
    responseKind: "assumption",
    assumption: "Continue using the current seven-day reporting window.",
  };
}

describe("durable Chat interaction state", () => {
  test("reopens the same revision-fenced interaction state in a fresh host", async () => {
    const workspace = createMemoryResearchWorkspace();
    const firstHost = await WorkspaceChatInteractionControllerV1.bind({
      workspace,
      conversationId: binding.threadId,
      binding,
      at: at(0),
    });
    const queued = await firstHost.update((current) => enqueueChatFollowUpV1({
      state: current,
      expectedRevision: current.revision,
      messageId: "chat-message:durable",
      content: "Retain this follow-up across host recreation.",
      at: at(1),
    }));
    expect(queued.revision).toBe(2);

    const secondHost = await WorkspaceChatInteractionControllerV1.bind({
      workspace,
      conversationId: binding.threadId,
      binding,
      at: at(2),
    });
    expect(secondHost.snapshot()).toMatchObject({
      revision: 2,
      queue: [{ id: "chat-message:durable", revision: 1 }],
    });
    await expect(secondHost.update((current) => ({ ...current })))
      .rejects.toThrow("did not advance");
  });

  test("keeps FIFO follow-ups editable and removable before admission", () => {
    const first = enqueueChatFollowUpV1({
      state: state(),
      expectedRevision: 1,
      messageId: "chat-message:first",
      content: "First follow-up",
      at: at(1),
    });
    const second = enqueueChatFollowUpV1({
      state: first,
      expectedRevision: first.revision,
      messageId: "chat-message:second",
      content: "Second follow-up",
      at: at(2),
    });
    const edited = editChatFollowUpV1({
      state: second,
      expectedRevision: second.revision,
      messageId: "chat-message:second",
      expectedMessageRevision: 1,
      content: "Edited second follow-up",
      at: at(3),
    });
    const admitted = admitNextChatFollowUpV1({
      state: edited,
      expectedRevision: edited.revision,
      at: at(4),
    });
    expect(admitted.message?.content).toBe("First follow-up");
    expect(admitted.state.queue).toEqual([
      expect.objectContaining({
        id: "chat-message:second",
        revision: 2,
        content: "Edited second follow-up",
      }),
    ]);
    const removed = removeChatFollowUpV1({
      state: admitted.state,
      expectedRevision: admitted.state.revision,
      messageId: "chat-message:second",
      expectedMessageRevision: 2,
      at: at(5),
    });
    expect(removed.queue).toEqual([]);
    expect(() => editChatFollowUpV1({
      state: second,
      expectedRevision: second.revision,
      messageId: "chat-message:second",
      expectedMessageRevision: 7,
      content: "Stale edit",
      at: at(6),
    })).toThrow("revision is stale");
  });

  test("keeps steering separate from FIFO follow-ups and acknowledges stop once", () => {
    const queued = enqueueChatFollowUpV1({
      state: state(),
      expectedRevision: 1,
      messageId: "chat-message:queued",
      content: "Ordinary next turn",
      at: at(1),
    });
    const steered = requestChatSteeringV1({
      state: queued,
      expectedRevision: queued.revision,
      steeringId: "chat-steering:one",
      instruction: "Prioritize the direct contradiction.",
      at: at(2),
    });
    expect(steered.queue.map((entry) => entry.content)).toEqual(["Ordinary next turn"]);
    expect(steered.pendingSteering?.instruction).toBe("Prioritize the direct contradiction.");
    const bound = bindChatSteeringResumeV1({
      state: steered,
      expectedRevision: steered.revision,
      steeringId: "chat-steering:one",
      expectedSteeringRevision: 1,
      turnId: "chat-turn:one",
      resume,
      at: at(3),
    });
    const consumed = consumeChatSteeringV1({
      state: bound,
      expectedRevision: bound.revision,
      steeringId: "chat-steering:one",
      expectedSteeringRevision: 1,
      at: at(4),
    });
    expect(consumed.steering.id).toBe("chat-steering:one");
    expect(consumed.state.pendingSteering).toBeUndefined();
    expect(consumed.state.acceptedSteering).toMatchObject({
      turnId: "chat-turn:one",
      instruction: "Prioritize the direct contradiction.",
      resume: {
        exactAnchors: [{
          anchorRef: "research-anchor:durable-interaction-anchor",
          bindingId: "scope-binding:current:page-1001",
        }],
      },
    });
    expect(consumed.state.queue).toHaveLength(1);
    const steeringComplete = completeChatSteeringV1({
      state: consumed.state,
      expectedRevision: consumed.state.revision,
      steeringId: "chat-steering:one",
      expectedSteeringRevision: 1,
      at: at(5),
    });
    expect(steeringComplete.acceptedSteering).toBeUndefined();
    const stopped = requestChatStopV1({
      state: steeringComplete,
      expectedRevision: steeringComplete.revision,
      at: at(6),
    });
    const acknowledged = acknowledgeChatStopV1({
      state: stopped,
      expectedRevision: stopped.revision,
      expectedStopRevision: 1,
      at: at(7),
    });
    expect(acknowledged.stop).toMatchObject({ revision: 1, acknowledgedAt: at(7) });
    expect(() => acknowledgeChatStopV1({
      state: acknowledged,
      expectedRevision: acknowledged.revision,
      expectedStopRevision: 1,
      at: at(8),
    })).toThrow("stale or unavailable");
  });

  test("persists and clears one revision-fenced model-stream checkpoint", () => {
    const interrupted = recordChatStreamInterruptionV1({
      state: state(),
      expectedRevision: 1,
      turnId: "chat-turn:stream",
      resume,
      at: at(1),
    });
    expect(parseChatInteractionStateV1(interrupted).streamInterruption).toMatchObject({
      kind: "stream-interruption",
      revision: 1,
      turnId: "chat-turn:stream",
      resumeAttempts: 0,
      resume: { exactAnchors: resume.exactAnchors },
    });
    const interruptedAgain = recordChatStreamInterruptionV1({
      state: interrupted,
      expectedRevision: interrupted.revision,
      turnId: "chat-turn:stream",
      resume,
      at: at(2),
    });
    expect(interruptedAgain.streamInterruption).toMatchObject({
      revision: 2,
      resumeAttempts: 1,
    });
    const completed = completeChatStreamInterruptionV1({
      state: interruptedAgain,
      expectedRevision: interruptedAgain.revision,
      turnId: "chat-turn:stream",
      expectedInterruptionRevision: 2,
      at: at(3),
    });
    expect(completed.streamInterruption).toBeUndefined();
  });

  test("edits, removes, and consumes a revision-fenced steering request", () => {
    const initial = createChatInteractionStateV1({
      conversationId: "chat-session:steering-controls",
      binding,
      createdAt: "2026-08-06T10:00:00.000Z",
    });
    const steered = requestChatSteeringV1({
      state: initial,
      expectedRevision: initial.revision,
      steeringId: "chat-steering:1",
      instruction: "Check the linked issue first.",
      at: "2026-08-06T10:00:01.000Z",
    });
    const edited = editChatSteeringV1({
      state: steered,
      expectedRevision: steered.revision,
      steeringId: "chat-steering:1",
      expectedSteeringRevision: 1,
      instruction: "Check the linked page first.",
      at: "2026-08-06T10:00:02.000Z",
    });
    expect(edited.pendingSteering).toMatchObject({
      revision: 2,
      instruction: "Check the linked page first.",
    });
    const removed = removeChatSteeringV1({
      state: edited,
      expectedRevision: edited.revision,
      steeringId: "chat-steering:1",
      expectedSteeringRevision: 2,
      at: "2026-08-06T10:00:03.000Z",
    });
    expect(removed.pendingSteering).toBeUndefined();
    const second = requestChatSteeringV1({
      state: removed,
      expectedRevision: removed.revision,
      steeringId: "chat-steering:2",
      instruction: "Focus on the decision.",
      at: "2026-08-06T10:00:04.000Z",
    });
    const bound = bindChatSteeringResumeV1({
      state: second,
      expectedRevision: second.revision,
      steeringId: "chat-steering:2",
      expectedSteeringRevision: 1,
      turnId: "chat-turn:steering-controls",
      resume,
      at: "2026-08-06T10:00:05.000Z",
    });
    const consumed = consumeChatSteeringV1({
      state: bound,
      expectedRevision: bound.revision,
      steeringId: "chat-steering:2",
      expectedSteeringRevision: 1,
      at: "2026-08-06T10:00:06.000Z",
    });
    expect(consumed.steering.instruction).toBe("Focus on the decision.");
    expect(consumed.state.pendingSteering).toBeUndefined();
  });

  test("durably validates every supported HITL question and answer shape", () => {
    for (const [index, responseKind] of [
      "free_text",
      "single_choice",
      "multiple_choice",
      "mixed",
      "assumption",
    ].entries() as IterableIterator<[number, ChatUserQuestionV1["responseKind"]]>) {
      const initial = state();
      const pending = recordChatUserQuestionV1({
        state: initial,
        expectedRevision: initial.revision,
        turnId: `research-turn:${responseKind}`,
        question: question(responseKind),
        resume,
        at: at(index + 1),
      });
      const value = responseKind === "free_text"
        ? { kind: "text" as const, text: "Use the explicitly approved window." }
        : responseKind === "single_choice"
          ? { kind: "selection" as const, optionIds: ["option:one"] }
          : responseKind === "multiple_choice"
            ? { kind: "selection" as const, optionIds: ["option:one", "option:two"] }
            : responseKind === "mixed"
              ? { kind: "mixed" as const, optionIds: [], text: "Use a different approved path." }
              : { kind: "assumption" as const, decision: "accepted" as const };
      const resolved = resolveChatUserQuestionV1({
        state: pending,
        expectedRevision: pending.revision,
        turnId: `research-turn:${responseKind}`,
        answer: {
          schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
          questionId: `chat-question:${responseKind}`,
          value,
        },
        at: at(index + 10),
      });
      expect(resolved.pendingQuestion).toBeUndefined();
      expect(resolved.resolvedQuestions).toHaveLength(1);
      expect(parseChatInteractionStateV1(JSON.parse(JSON.stringify(resolved))))
        .toEqual(resolved);
    }
  });

  test("fails closed across identity partitions and hostile stale answers", () => {
    const pending = recordChatUserQuestionV1({
      state: state(),
      expectedRevision: 1,
      turnId: "research-turn:pending",
      question: question("single_choice"),
      resume,
      at: at(1),
    });
    expect(() => assertChatInteractionBindingV1({
      state: pending,
      conversationId: pending.conversationId,
      binding: { ...binding, userId: "principal:attacker" },
    })).toThrow("different user, thread, tenant, or provider-cache partition");
    expect(() => resolveChatUserQuestionV1({
      state: pending,
      expectedRevision: pending.revision - 1,
      turnId: "research-turn:pending",
      answer: {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: "chat-question:single_choice",
        value: { kind: "selection", optionIds: ["option:one"] },
      },
      at: at(2),
    })).toThrow("revision is stale");
    expect(() => resolveChatUserQuestionV1({
      state: pending,
      expectedRevision: pending.revision,
      turnId: "research-turn:foreign",
      answer: {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: "chat-question:single_choice",
        value: { kind: "selection", optionIds: ["option:one"] },
      },
      at: at(2),
    })).toThrow("stale or unavailable");
  });
});
