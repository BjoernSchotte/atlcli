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
import { DEFAULT_RESEARCH_LIMITS_V1, RESEARCH_REQUEST_SCHEMA_V1 } from "../contracts.js";
import { chatQualityPolicyV1 } from "../quality-policy.js";

const conversationId = "chat-conversation:hitl";
const turnId = "chat-turn:hitl";
const binding = {
  userId: "principal:hitl",
  providerCacheIdentity: "provider-cache:hitl",
  threadId: conversationId,
  tenantOrigin: "https://example.atlassian.net",
} as const;
const resume = {
  request: {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: "Summarize the approved reporting period.",
    scope: { siteOrigin: binding.tenantOrigin, jiraProjectKeys: [], confluenceSpaceKeys: [] },
    reportLanguage: "en" as const,
    limits: DEFAULT_RESEARCH_LIMITS_V1,
    wikiProvider: "rest" as const,
  },
  qualityPolicy: chatQualityPolicyV1("auto"),
};

const scenarios = [
  {
    name: "free text",
    proposal: {
      responseKind: "free_text",
      prompt: "Which approved reporting window should I use?",
      required: true,
      maxLength: 120,
    },
    value: { kind: "text", text: "Use the last seven days." },
  },
  {
    name: "single choice",
    proposal: {
      responseKind: "single_choice",
      prompt: "Which approved reporting window should I use?",
      required: true,
      options: [
        { id: "window:seven", label: "Seven days" },
        { id: "window:thirty", label: "Thirty days" },
      ],
    },
    value: { kind: "selection", optionIds: ["window:seven"] },
  },
  {
    name: "multiple choice",
    proposal: {
      responseKind: "multiple_choice",
      prompt: "Which approved sources should I include?",
      required: true,
      options: [
        { id: "source:jira", label: "Jira" },
        { id: "source:wiki", label: "Confluence" },
      ],
      minSelections: 1,
      maxSelections: 2,
    },
    value: { kind: "selection", optionIds: ["source:jira", "source:wiki"] },
  },
  {
    name: "mixed choice and text",
    proposal: {
      responseKind: "mixed",
      prompt: "Which source and optional focus should I use?",
      required: true,
      options: [
        { id: "source:jira", label: "Jira" },
        { id: "source:wiki", label: "Confluence" },
      ],
      minSelections: 1,
      maxSelections: 2,
      maxLength: 120,
    },
    value: {
      kind: "mixed",
      optionIds: ["source:wiki"],
      text: "Focus on the current process.",
    },
  },
  {
    name: "declared assumption",
    proposal: {
      responseKind: "assumption",
      prompt: "May I continue with the current space only?",
      required: true,
      assumption: "Use only the current Confluence space.",
    },
    value: { kind: "assumption", decision: "accepted" },
  },
] as const;

async function controller(workspace: ReturnType<typeof createMemoryResearchWorkspace>) {
  return WorkspaceChatInteractionControllerV1.bind({
    workspace,
    conversationId,
    binding,
    at: "2026-08-06T12:00:00.000Z",
  });
}

describe("DeepAgentsJS durable Chat HITL", () => {
  for (const scenario of scenarios) {
    test(`pauses and fresh-host resumes ${scenario.name} without replaying the model decision`, async () => {
    const workspace = createMemoryResearchWorkspace();
    const firstInteractions = await controller(workspace);
    const questionToolCall = new AIMessage({
      content: "",
      tool_calls: [{
        id: "ask:one",
        name: "ask_user_question",
        type: "tool_call",
        args: scenario.proposal,
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
        resume,
        now: () => Date.parse("2026-08-06T12:00:01.000Z"),
      })],
      checkpointer: firstCheckpointer,
    });
    const config = { configurable: { thread_id: firstCheckpointer.threadId } };
    const interrupted = await firstAgent.invoke({
      messages: [new HumanMessage("Summarize the approved reporting period.")],
    }, config);
    expect(interrupted).toMatchObject({
      __interrupt__: [{ value: { responseKind: scenario.proposal.responseKind } }],
    });
    const pending = firstInteractions.snapshot().pendingQuestion;
    expect(pending?.question.prompt).toBe(scenario.proposal.prompt);
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
        resume,
        now: () => Date.parse("2026-08-06T12:00:02.000Z"),
      })],
      checkpointer: secondCheckpointer,
    });
    const resumed = await secondAgent.invoke(new Command({
      resume: {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: pending!.question.id,
        value: scenario.value,
      },
    }), { configurable: { thread_id: secondCheckpointer.threadId } });

    expect(resumed.messages.at(-1)?.text).toBe("The approved window is seven days.");
    expect(secondModel.callCount).toBe(1);
    expect(secondInteractions.snapshot().pendingQuestion).toBeUndefined();
    expect(secondInteractions.snapshot()).toMatchObject({
      resolvedQuestions: [{
        turnId,
        answer: { value: scenario.value },
      }],
    });
    });
  }
});
