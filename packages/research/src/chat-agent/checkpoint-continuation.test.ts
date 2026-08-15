import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents/node";
import { ChatTurnWorkspaceCheckpointerV1 } from "../workspace-checkpointer.js";
import { createMemoryResearchWorkspace } from "../workspace.js";

describe("DeepAgentsJS Chat checkpoint continuation", () => {
  test("a fresh host can retry a failed model node and inject bounded steering", async () => {
    const workspace = createMemoryResearchWorkspace();
    const conversationId = "chat-conversation:checkpoint-continuation";
    const turnId = "chat-turn:checkpoint-continuation";
    const firstCheckpointer = new ChatTurnWorkspaceCheckpointerV1({
      conversationId,
      turnId,
      workspace,
    });
    const firstModel = fakeModel().respond(new Error("synthetic stream disconnected"));
    const firstAgent = createDeepAgent({
      name: "chat-checkpoint-continuation-proof",
      model: firstModel,
      tools: [],
      checkpointer: firstCheckpointer,
    });

    await expect(firstAgent.invoke({
      messages: [new HumanMessage("Summarize the attached page.")],
    }, {
      configurable: { thread_id: firstCheckpointer.threadId },
    })).rejects.toThrow("synthetic stream disconnected");

    const secondCheckpointer = new ChatTurnWorkspaceCheckpointerV1({
      conversationId,
      turnId,
      workspace,
    });
    const secondModel = fakeModel().respond((messages) => {
      const text = messages.map((message) => message.text).join("\n");
      return new AIMessage(
        text.includes("Focus on the open decision")
          ? "Recovered with the accepted steering instruction."
          : new Error("The steering instruction was not restored."),
      );
    });
    const secondAgent = createDeepAgent({
      name: "chat-checkpoint-continuation-proof",
      model: secondModel,
      tools: [],
      checkpointer: secondCheckpointer,
    });
    const resumed = await secondAgent.invoke(new Command({
      update: {
        messages: [new HumanMessage(
          "Steering instruction: Focus on the open decision.",
        )],
      },
    }), {
      configurable: { thread_id: secondCheckpointer.threadId },
    });

    expect(resumed.messages.at(-1)?.text).toBe(
      "Recovered with the accepted steering instruction.",
    );
    expect(firstModel.callCount).toBe(1);
    expect(secondModel.callCount).toBe(1);
  });
});
