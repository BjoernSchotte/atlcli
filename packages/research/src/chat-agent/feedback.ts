import type { ResearchWorkspace } from "../workspace.js";
import { ChatContractError } from "./contracts.js";

export const CHAT_ANSWER_FEEDBACK_SCHEMA_V1 =
  "atlcli.chat-answer-feedback/v1" as const;
export const CHAT_ANSWER_FEEDBACK_JOURNAL_SCHEMA_V1 =
  "atlcli.chat-answer-feedback-journal/v1" as const;
export const CHAT_ANSWER_FEEDBACK_JOURNAL_PATH_V1 =
  "/.atlcli/chat/v1/answer-feedback.json" as const;

export const CHAT_ANSWER_FEEDBACK_RATINGS_V1 = [
  "helpful",
  "not-helpful",
] as const;
export type ChatAnswerFeedbackRatingV1 =
  (typeof CHAT_ANSWER_FEEDBACK_RATINGS_V1)[number];

export const CHAT_ANSWER_FEEDBACK_REASON_CODES_V1 = [
  "incorrect",
  "incomplete",
  "wrong-source",
  "citation-problem",
  "unclear",
  "too-slow",
  "other",
] as const;
export type ChatAnswerFeedbackReasonCodeV1 =
  (typeof CHAT_ANSWER_FEEDBACK_REASON_CODES_V1)[number];

export interface ChatAnswerFeedbackV1 {
  schema: typeof CHAT_ANSWER_FEEDBACK_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  revision: number;
  updatedAt: string;
  rating: ChatAnswerFeedbackRatingV1;
  reasonCodes: ChatAnswerFeedbackReasonCodeV1[];
}

export interface ChatAnswerFeedbackJournalV1 {
  schema: typeof CHAT_ANSWER_FEEDBACK_JOURNAL_SCHEMA_V1;
  conversationId: string;
  revision: number;
  feedback: ChatAnswerFeedbackV1[];
}

const MAXIMUM_CHAT_ANSWER_FEEDBACK_ENTRIES_V1 = 256;

function boundedToken(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return value;
}

function normalizeReasonCodes(
  value: unknown,
): ChatAnswerFeedbackReasonCodeV1[] {
  if (!Array.isArray(value) || value.length > CHAT_ANSWER_FEEDBACK_REASON_CODES_V1.length) {
    throw new ChatContractError("invalid-request", "Chat answer feedback reasons are invalid.");
  }
  const allowed = new Set<string>(CHAT_ANSWER_FEEDBACK_REASON_CODES_V1);
  const normalized = [...new Set(value.map((reason) => {
    if (typeof reason !== "string" || !allowed.has(reason)) {
      throw new ChatContractError("invalid-request", "Chat answer feedback reason is invalid.");
    }
    return reason as ChatAnswerFeedbackReasonCodeV1;
  }))].sort();
  return normalized;
}

export function normalizeChatAnswerFeedbackV1(value: unknown): ChatAnswerFeedbackV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat answer feedback is invalid.");
  }
  const feedback = value as Record<string, unknown>;
  const allowed = [
    "schema",
    "conversationId",
    "turnId",
    "revision",
    "updatedAt",
    "rating",
    "reasonCodes",
  ];
  if (
    Object.keys(feedback).some((key) => !allowed.includes(key)) ||
    feedback.schema !== CHAT_ANSWER_FEEDBACK_SCHEMA_V1 ||
    !CHAT_ANSWER_FEEDBACK_RATINGS_V1.includes(
      feedback.rating as ChatAnswerFeedbackRatingV1,
    )
  ) {
    throw new ChatContractError("invalid-request", "Chat answer feedback is invalid.");
  }
  return {
    schema: CHAT_ANSWER_FEEDBACK_SCHEMA_V1,
    conversationId: boundedToken(feedback.conversationId, "Chat conversation ID"),
    turnId: boundedToken(feedback.turnId, "Chat turn ID"),
    revision: positiveInteger(feedback.revision, "Chat answer feedback revision"),
    updatedAt: timestamp(feedback.updatedAt, "Chat answer feedback time"),
    rating: feedback.rating as ChatAnswerFeedbackRatingV1,
    reasonCodes: normalizeReasonCodes(feedback.reasonCodes),
  };
}

export function normalizeChatAnswerFeedbackJournalV1(
  value: unknown,
): ChatAnswerFeedbackJournalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat answer feedback journal is invalid.");
  }
  const journal = value as Record<string, unknown>;
  if (
    Object.keys(journal).some((key) =>
      !["schema", "conversationId", "revision", "feedback"].includes(key)
    ) ||
    journal.schema !== CHAT_ANSWER_FEEDBACK_JOURNAL_SCHEMA_V1 ||
    !Array.isArray(journal.feedback) ||
    journal.feedback.length > MAXIMUM_CHAT_ANSWER_FEEDBACK_ENTRIES_V1
  ) {
    throw new ChatContractError("invalid-request", "Chat answer feedback journal is invalid.");
  }
  const conversationId = boundedToken(
    journal.conversationId,
    "Chat answer feedback conversation ID",
  );
  const feedback = journal.feedback.map(normalizeChatAnswerFeedbackV1);
  if (feedback.some((entry) => entry.conversationId !== conversationId)) {
    throw new ChatContractError(
      "access-denied",
      "Chat answer feedback belongs to a different conversation.",
    );
  }
  if (new Set(feedback.map((entry) => entry.turnId)).size !== feedback.length) {
    throw new ChatContractError(
      "invalid-request",
      "Chat answer feedback contains duplicate turns.",
    );
  }
  return {
    schema: CHAT_ANSWER_FEEDBACK_JOURNAL_SCHEMA_V1,
    conversationId,
    revision: positiveInteger(journal.revision, "Chat answer feedback journal revision"),
    feedback,
  };
}

/**
 * Conversation-local answer feedback. The journal deliberately has no fields
 * for question text, answer text, sources, URLs, tenant identity, provider
 * payloads, or free-form comments.
 */
export class WorkspaceChatAnswerFeedbackJournalV1 {
  readonly #workspace: ResearchWorkspace;
  #state: ChatAnswerFeedbackJournalV1;

  private constructor(
    workspace: ResearchWorkspace,
    state: ChatAnswerFeedbackJournalV1,
  ) {
    this.#workspace = workspace;
    this.#state = state;
  }

  static async open(input: {
    workspace: ResearchWorkspace;
    conversationId: string;
  }): Promise<WorkspaceChatAnswerFeedbackJournalV1> {
    const conversationId = boundedToken(input.conversationId, "Chat conversation ID");
    const raw = await input.workspace.readFile(CHAT_ANSWER_FEEDBACK_JOURNAL_PATH_V1);
    const state = raw === undefined
      ? {
          schema: CHAT_ANSWER_FEEDBACK_JOURNAL_SCHEMA_V1,
          conversationId,
          revision: 1,
          feedback: [],
        } satisfies ChatAnswerFeedbackJournalV1
      : normalizeChatAnswerFeedbackJournalV1(JSON.parse(raw));
    if (state.conversationId !== conversationId) {
      throw new ChatContractError(
        "access-denied",
        "Chat answer feedback belongs to a different conversation.",
      );
    }
    return new WorkspaceChatAnswerFeedbackJournalV1(input.workspace, state);
  }

  async record(input: {
    turnId: string;
    rating: ChatAnswerFeedbackRatingV1;
    reasonCodes?: readonly ChatAnswerFeedbackReasonCodeV1[];
    updatedAt: string;
  }): Promise<ChatAnswerFeedbackV1> {
    const turnId = boundedToken(input.turnId, "Chat turn ID");
    const prior = this.#state.feedback.find((entry) => entry.turnId === turnId);
    const feedback = normalizeChatAnswerFeedbackV1({
      schema: CHAT_ANSWER_FEEDBACK_SCHEMA_V1,
      conversationId: this.#state.conversationId,
      turnId,
      revision: (prior?.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      rating: input.rating,
      reasonCodes: [...(input.reasonCodes ?? [])],
    });
    const entries = this.#state.feedback.filter((entry) => entry.turnId !== turnId);
    this.#state = {
      ...this.#state,
      revision: this.#state.revision + 1,
      feedback: [...entries, feedback].slice(-MAXIMUM_CHAT_ANSWER_FEEDBACK_ENTRIES_V1),
    };
    await this.#workspace.writeFile(
      CHAT_ANSWER_FEEDBACK_JOURNAL_PATH_V1,
      JSON.stringify(this.#state),
    );
    return structuredClone(feedback);
  }

  forTurn(turnId: string): ChatAnswerFeedbackV1 | null {
    const normalized = boundedToken(turnId, "Chat turn ID");
    const feedback = this.#state.feedback.find((entry) => entry.turnId === normalized);
    return feedback ? structuredClone(feedback) : null;
  }
}
