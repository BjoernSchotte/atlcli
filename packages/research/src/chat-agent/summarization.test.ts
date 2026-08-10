import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { createSummarizationMiddleware } from "deepagents/node";
import { createMemoryResearchWorkspace } from "../workspace.js";
import {
  CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1,
  createChatDurableSummarizationMiddlewareV1,
} from "./summarization.js";

describe("Chat-native DeepAgentsJS summarization", () => {
  test("labels summaries as non-authoritative and hides private history paths", async () => {
    const workspace = createMemoryResearchWorkspace();
    const model = fakeModel().respond(new AIMessage("Synthetic Chat summary."));
    const middleware = createChatDurableSummarizationMiddlewareV1(
      { createSummarizationMiddleware },
      { workspace, model },
    );
    const result = await middleware.wrapModelCall!(
      {
        messages: Array.from(
          { length: 49 },
          (_, index) => new HumanMessage(`Synthetic message ${index + 1}.`),
        ),
        state: {},
        model,
        systemMessage: undefined,
        tools: [],
      } as never,
      async () => new AIMessage("Root response."),
    );
    const activeSummary = (result as {
      update?: { _summarizationEvent?: { summaryMessage?: { content?: unknown } } };
    }).update?._summarizationEvent?.summaryMessage?.content;
    expect(String(activeSummary)).toContain("non-authoritative Chat context");
    expect(String(activeSummary)).not.toContain("/chat_conversation_history/");
    expect(await workspace.list(CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1))
      .not.toHaveLength(0);
    expect(await workspace.list("/.atlcli/deepagents-summarization/v1"))
      .toHaveLength(0);
  });

  test("keeps a 1,000-message Chat execution bounded through native compaction", async () => {
    const workspace = createMemoryResearchWorkspace();
    const model = fakeModel();
    for (let index = 0; index < 48; index += 1) {
      model.respond(new AIMessage(`Synthetic Chat summary ${index + 1}.`));
    }
    const middleware = createChatDurableSummarizationMiddlewareV1(
      { createSummarizationMiddleware },
      { workspace, model },
    );
    const canonicalMessages: HumanMessage[] = [];
    const state: Record<string, unknown> = {};
    let largestVisibleMessageCount = 0;
    let largestVisibleBytes = 0;
    const padding = "x".repeat(800);

    for (let index = 0; index < 1_000; index += 1) {
      canonicalMessages.push(new HumanMessage(
        `Turn ${index + 1}: context marker CHAT-${String(index + 1).padStart(4, "0")}. ${padding}`,
      ));
      const result = await middleware.wrapModelCall!(
        {
          messages: canonicalMessages,
          state,
          model,
          systemMessage: undefined,
          tools: [],
        } as never,
        async (request) => {
          largestVisibleMessageCount = Math.max(
            largestVisibleMessageCount,
            request.messages.length,
          );
          largestVisibleBytes = Math.max(
            largestVisibleBytes,
            new TextEncoder().encode(
              request.messages.map((message) => String(message.content)).join("\n"),
            ).byteLength,
          );
          return new AIMessage("Root response.");
        },
      );
      const update = (result as { update?: Record<string, unknown> }).update;
      if (update) Object.assign(state, update);
    }

    expect(largestVisibleMessageCount).toBeLessThanOrEqual(48);
    expect(largestVisibleBytes).toBeLessThanOrEqual(48_000);
    expect(model.callCount).toBeGreaterThan(12);
    expect(await workspace.list(CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1))
      .not.toHaveLength(0);
  });
});
