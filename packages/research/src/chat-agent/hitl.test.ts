import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents/node";
import { createChatAskUserQuestionToolV1 } from "./hitl.js";
import {
  CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
  WorkspaceChatInteractionControllerV1,
} from "./interaction.js";
import { ChatTurnWorkspaceCheckpointerV1 } from "../workspace-checkpointer.js";
import { createMemoryResearchWorkspace } from "../workspace.js";

const conversationId = "chat-conversation:hitl";
const turnId = "chat-turn:hitl";
const binding = {
  userId: "principal:hitl",
  providerCacheIdentity: "provider-cache:hitl",
  threadId: conversationId,
  tenantOrigin: "https://example.atlassian.net",
} as const;

async function controller(workspace: ReturnType<typeof createMemoryResearchWorkspace>) {
  return WorkspaceChatInteractionControllerV1.bind({
    workspace,
    conversationId,
    binding,
    at: "2026-08-06T12:00:00.000Z",
  });
}

describe("DeepAgentsJS durable Chat HITL", () => {
  test("pauses in a tool checkpoint and resumes in a fresh host without replaying the model decision", async () => {
    const workspace = createMemoryResearchWorkspace();
    const firstInteractions = await controller(workspace);
    const questionToolCall = new AIMessage({
      content: "",
      tool_calls: [{
        id: "ask:one",
        name: "ask_user_question",
        type: "tool_call",
        args: {
          responseKind: "single_choice",
          prompt: "Which approved reporting window should I use?",
          required: true,
          options: [
            { id: "window:seven", label: "Seven days" },
            { id: "window:thirty", label: "Thirty days" },
          ],
        },
      }],
    });
    const firstModel = fakeModel().respond(questionToolCall);
    const firstCheckpointer = new ChatTurnWorkspaceCheckpointerV1({
      conversationId,
      turnId,
      workspace,
    });
    const firstAgent = createDeepAgent({
      name: "chat-hitl-proof",
      model: firstModel,
      tools: [createChatAskUserQuestionToolV1({
        turnId,
        interactions: firstInteractions,
        now: () => Date.parse("2026-08-06T12:00:01.000Z"),
      })],
      checkpointer: firstCheckpointer,
    });
    const config = { configurable: { thread_id: firstCheckpointer.threadId } };
    const interrupted = await firstAgent.invoke({
      messages: [new HumanMessage("Summarize the approved reporting period.")],
    }, config);
    expect(interrupted).toMatchObject({
      __interrupt__: [{ value: { responseKind: "single_choice" } }],
    });
    const pending = firstInteractions.snapshot().pendingQuestion;
    expect(pending?.question.prompt).toBe("Which approved reporting window should I use?");
    expect(firstModel.callCount).toBe(1);

    const secondInteractions = await controller(workspace);
    const secondModel = fakeModel().respond(new AIMessage("The approved window is seven days."));
    const secondCheckpointer = new ChatTurnWorkspaceCheckpointerV1({
      conversationId,
      turnId,
      workspace,
    });
    const secondAgent = createDeepAgent({
      name: "chat-hitl-proof",
      model: secondModel,
      tools: [createChatAskUserQuestionToolV1({
        turnId,
        interactions: secondInteractions,
        now: () => Date.parse("2026-08-06T12:00:02.000Z"),
      })],
      checkpointer: secondCheckpointer,
    });
    const resumed = await secondAgent.invoke(new Command({
      resume: {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: pending!.question.id,
        value: { kind: "selection", optionIds: ["window:seven"] },
      },
    }), { configurable: { thread_id: secondCheckpointer.threadId } });

    expect(resumed.messages.at(-1)?.text).toBe("The approved window is seven days.");
    expect(secondModel.callCount).toBe(1);
    expect(secondInteractions.snapshot().pendingQuestion).toBeUndefined();
    expect(secondInteractions.snapshot()).toMatchObject({
      resolvedQuestions: [{
        turnId,
        answer: { value: { kind: "selection", optionIds: ["window:seven"] } },
      }],
    });
  });
});
