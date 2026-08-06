import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  CHAT_USER_QUESTION_SCHEMA_V1,
  recordChatUserQuestionV1,
  resolveChatUserQuestionV1,
  type ChatUserQuestionAnswerV1,
  type ChatUserQuestionV1,
  type ChatResumeEnvelopeV1,
  type WorkspaceChatInteractionControllerV1,
} from "./interaction.js";
import { ChatContractError } from "./contracts.js";

const optionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(320).optional(),
}).strict();

/**
 * Keep the provider-visible root an object. Anthropic rejects root unions as a
 * custom-tool input schema because their JSON Schema has `oneOf` but no
 * top-level `type: object`. Cross-field refinement preserves the same five
 * typed question shapes without changing the model-facing argument names.
 */
const questionProposalSchema = z.object({
  responseKind: z.enum([
    "free_text",
    "single_choice",
    "multiple_choice",
    "mixed",
    "assumption",
  ]),
  prompt: z.string().min(1).max(800),
  required: z.boolean(),
  options: z.array(optionSchema).min(2).max(12).optional(),
  minSelections: z.number().int().min(0).max(12).optional(),
  maxSelections: z.number().int().min(1).max(12).optional(),
  maxLength: z.number().int().min(1).max(4_000).optional(),
  assumption: z.string().min(1).max(800).optional(),
}).strict().superRefine((proposal, context) => {
  const requireField = (field: keyof typeof proposal): void => {
    if (proposal[field] !== undefined) return;
    context.addIssue({
      code: "custom",
      path: [field],
      message: `${field} is required for ${proposal.responseKind}.`,
    });
  };
  if (proposal.responseKind === "free_text") requireField("maxLength");
  if (["single_choice", "multiple_choice", "mixed"].includes(proposal.responseKind)) {
    requireField("options");
  }
  if (proposal.responseKind === "multiple_choice" || proposal.responseKind === "mixed") {
    requireField("minSelections");
    requireField("maxSelections");
    if (
      proposal.minSelections !== undefined &&
      proposal.maxSelections !== undefined &&
      proposal.minSelections > proposal.maxSelections
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxSelections"],
        message: "maxSelections must be greater than or equal to minSelections.",
      });
    }
  }
  if (proposal.responseKind === "mixed") requireField("maxLength");
  if (proposal.responseKind === "assumption") requireField("assumption");
});

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
  resume: ChatResumeEnvelopeV1;
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
          resume: input.resume,
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
