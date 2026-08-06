import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  CHAT_USER_QUESTION_SCHEMA_V1,
  recordChatUserQuestionV1,
  resolveChatUserQuestionV1,
  type ChatUserQuestionAnswerV1,
  type ChatUserQuestionV1,
  type WorkspaceChatInteractionControllerV1,
} from "./interaction.js";
import { ChatContractError } from "./contracts.js";

export class ChatUserQuestionRequiredError extends ChatContractError {
  readonly question: ChatUserQuestionV1;

  constructor(question: ChatUserQuestionV1) {
    super("clarification-required", "Chat requires a durable user answer before it can continue.");
    this.name = "ChatUserQuestionRequiredError";
    this.question = structuredClone(question);
  }
}

const optionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(320).optional(),
}).strict();

const questionProposalSchema = z.discriminatedUnion("responseKind", [
  z.object({
    responseKind: z.literal("free_text"),
    prompt: z.string().min(1).max(800),
    required: z.boolean(),
    maxLength: z.number().int().min(1).max(4_000),
  }).strict(),
  z.object({
    responseKind: z.literal("single_choice"),
    prompt: z.string().min(1).max(800),
    required: z.boolean(),
    options: z.array(optionSchema).min(2).max(12),
  }).strict(),
  z.object({
    responseKind: z.literal("multiple_choice"),
    prompt: z.string().min(1).max(800),
    required: z.boolean(),
    options: z.array(optionSchema).min(2).max(12),
    minSelections: z.number().int().min(0).max(12),
    maxSelections: z.number().int().min(1).max(12),
  }).strict(),
  z.object({
    responseKind: z.literal("mixed"),
    prompt: z.string().min(1).max(800),
    required: z.boolean(),
    options: z.array(optionSchema).min(2).max(12),
    minSelections: z.number().int().min(0).max(12),
    maxSelections: z.number().int().min(1).max(12),
    maxLength: z.number().int().min(1).max(4_000),
  }).strict(),
  z.object({
    responseKind: z.literal("assumption"),
    prompt: z.string().min(1).max(800),
    required: z.boolean(),
    assumption: z.string().min(1).max(800),
  }).strict(),
]);

function stableQuestionId(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `chat-question:${hash.toString(16).padStart(8, "0")}`;
}

export function createChatAskUserQuestionToolV1(input: {
  turnId: string;
  interactions: WorkspaceChatInteractionControllerV1;
  now?: () => number;
  onQuestion?: (question: ChatUserQuestionV1) => void;
  onResolved?: (answer: ChatUserQuestionAnswerV1) => void;
}): DynamicStructuredTool {
  const now = input.now ?? Date.now;
  return tool(async (proposal) => {
    const question = {
      schema: CHAT_USER_QUESTION_SCHEMA_V1,
      id: stableQuestionId(proposal),
      ...proposal,
    } as ChatUserQuestionV1;
    const before = input.interactions.snapshot();
    const completed = [...before.resolvedQuestions].reverse().find((entry) =>
      entry.turnId === input.turnId && entry.question.id === question.id
    );
    if (completed) {
      return JSON.stringify({ status: "answered", answer: completed.answer.value });
    }
    if (before.pendingQuestion &&
        (before.pendingQuestion.turnId !== input.turnId ||
          before.pendingQuestion.question.id !== question.id)) {
      throw new ChatContractError(
        "clarification-required",
        "Chat already awaits a different durable user answer.",
      );
    }
    if (!before.pendingQuestion) {
      const recorded = await input.interactions.update((state) =>
        recordChatUserQuestionV1({
          state,
          expectedRevision: state.revision,
          turnId: input.turnId,
          question,
          at: new Date(now()).toISOString(),
        })
      );
      input.onQuestion?.(recorded.pendingQuestion!.question);
    }

    // LangGraph persists this exact tool-node checkpoint. On resume the node
    // restarts, sees the idempotently recorded question, and receives the
    // Command(resume=...) value here. Never wrap this call in try/catch.
    const answer = interrupt<ChatUserQuestionV1, ChatUserQuestionAnswerV1>(question);
    const resolved = await input.interactions.update((state) =>
      resolveChatUserQuestionV1({
        state,
        expectedRevision: state.revision,
        turnId: input.turnId,
        answer,
        at: new Date(now()).toISOString(),
      })
    );
    const accepted = resolved.resolvedQuestions.at(-1)?.answer;
    if (!accepted) {
      throw new ChatContractError("invalid-request", "Chat user answer was not durably recorded.");
    }
    input.onResolved?.(accepted);
    return JSON.stringify({ status: "answered", answer: accepted.value });
  }, {
    name: "ask_user_question",
    description: [
      "Pause this Chat turn only when a materially ambiguous user choice would change scope or the answer.",
      "Supports free text, one choice, multiple choices, a constrained choice plus free text, or explicit acceptance/rejection of a declared assumption.",
      "Do not ask ceremonial questions and do not use this tool when an exact attached source already resolves the user's request.",
    ].join(" "),
    schema: questionProposalSchema,
  });
}
