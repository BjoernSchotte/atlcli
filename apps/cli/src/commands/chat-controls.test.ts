import { describe, expect, test } from "bun:test";
import {
  applyChatInteractionControlV1,
  createChatInteractionStateV1,
  defineChatAgentPortV1,
  stampChatInteractionCommandV1,
  type ChatInteractionStateV1,
} from "@atlcli/research";
import { handleCliChatControlLineV1 } from "./chat-controls.js";

const siteOrigin = "https://tenant-a.atlassian.net";

function fixture() {
  let state: ChatInteractionStateV1 | null = null;
  let stopped = false;
  const feedback: Array<{ rating: string; reasonCodes?: readonly string[] }> = [];
  const port = defineChatAgentPortV1({
    async startTurn() { throw new Error("not used"); },
    async answerQuestion() { throw new Error("not used"); },
    async resumeTurn() { throw new Error("not used"); },
    async getPendingQuestion() { return null; },
    async getInteraction() { return state; },
    async control(command) {
      state ??= createChatInteractionStateV1({
        conversationId: "research-session:cli-controls",
        binding: {
          userId: "principal:cli-controls",
          providerCacheIdentity: "provider:cli-controls",
          threadId: "research-session:cli-controls",
          tenantOrigin: siteOrigin,
        },
        createdAt: "2026-08-06T12:00:00.000Z",
      });
      state = applyChatInteractionControlV1(
        state,
        stampChatInteractionCommandV1(command, "2026-08-06T12:00:01.000Z"),
      );
      return state;
    },
    async stop() { stopped = true; return "stop_requested"; },
    async listHistory() { return []; },
    async replay() {
      return {
        conversationId: "research-session:cli-controls",
        turnId: "research-turn:complete",
        objective: "Synthetic question.",
        events: [],
        finalAnswer: {
          schema: "atlcli.chat-answer/v1",
          messageMarkdown: "Synthetic answer.",
          citations: [],
          evidenceRefs: [],
          gaps: [],
          strategy: {
            qualityMode: "quick",
            path: "direct",
            delegated: false,
            reasonCode: "quick-direct",
            reasonCodes: ["quick-direct"],
            ambiguityDisposition: "none",
            requiredCapabilities: ["chat-answer"],
            expectedComplexity: "simple",
            qualityRisks: [],
          },
          run: {
            model: "synthetic",
            startedAt: "2026-08-06T12:00:00.000Z",
            completedAt: "2026-08-06T12:00:01.000Z",
            durationMs: 1_000,
            counts: { ptcCalls: 0, httpCalls: 0, jiraItems: 0, confluenceItems: 0 },
          },
        },
      };
    },
    async artifact() { return null; },
    async sources() { return null; },
    async submitFeedback(input) {
      feedback.push({ rating: input.rating, reasonCodes: input.reasonCodes });
      return {
        schema: "atlcli.chat-answer-feedback/v1",
        conversationId: input.conversationId,
        turnId: input.turnId,
        revision: 1,
        updatedAt: "2026-08-06T12:00:02.000Z",
        rating: input.rating,
        reasonCodes: [...(input.reasonCodes ?? [])],
      };
    },
    async resetConversation() {},
  });
  let id = 0;
  const run = (line: string) => handleCliChatControlLineV1({
    line,
    port,
    siteOrigin,
    createId: (kind) => `chat-${kind}:${++id}`,
  });
  return { run, stopped: () => stopped, feedback };
}

describe("line-oriented CLI Chat controls", () => {
  test("queues, lists, edits and removes a follow-up through the shared port", async () => {
    const controls = fixture();
    const queued = await controls.run("Compare the implementation next.");
    expect(queued).toMatchObject({ kind: "queued" });
    expect(queued.state?.queue[0]).toMatchObject({
      id: "chat-message:1",
      content: "Compare the implementation next.",
    });
    expect((await controls.run("/queue")).message).toContain("chat-message:1");
    const edited = await controls.run("/edit chat-message:1 Focus only on explicit links.");
    expect(edited.state?.queue[0]?.content).toBe("Focus only on explicit links.");
    const removed = await controls.run("/delete chat-message:1");
    expect(removed.state?.queue).toEqual([]);
  });

  test("keeps steering and stop separate from the FIFO queue", async () => {
    const controls = fixture();
    const steering = await controls.run("/steer Check the contradiction first.");
    expect(steering).toMatchObject({ kind: "steered" });
    expect(steering.state?.pendingSteering).toMatchObject({
      id: "chat-steering:1",
      instruction: "Check the contradiction first.",
    });
    expect(steering.state?.queue).toEqual([]);
    await controls.run("/stop");
    expect(controls.stopped()).toBe(true);
  });

  test("rejects stale identifiers, empty edits and unknown commands", async () => {
    const controls = fixture();
    await expect(controls.run("/edit missing text")).rejects.toThrow("unavailable");
    await expect(controls.run("/delete missing")).rejects.toThrow("unavailable");
    await expect(controls.run("/steer")).rejects.toThrow("Missing value");
    await expect(controls.run("/unknown")).rejects.toThrow("Unknown Chat control");
  });

  test("records body-free feedback for the latest completed answer", async () => {
    const controls = fixture();
    expect(await controls.run("/feedback helpful")).toMatchObject({ kind: "feedback" });
    expect(await controls.run("/feedback not-helpful wrong-source,incomplete"))
      .toMatchObject({ kind: "feedback" });
    expect(controls.feedback).toEqual([
      { rating: "helpful", reasonCodes: [] },
      { rating: "not-helpful", reasonCodes: ["wrong-source", "incomplete"] },
    ]);
    await expect(controls.run("/feedback not-helpful private-comment"))
      .rejects.toThrow("Unknown feedback reason");
  });
});
