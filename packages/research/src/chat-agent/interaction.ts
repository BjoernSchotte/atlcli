import { ChatContractError } from "./contracts.js";
import type { ChatSessionBindingV1 } from "./session.js";
import type { ResearchWorkspace } from "../workspace.js";
import { normalizeResearchRequestV1, type ResearchRequestV1 } from "../contracts.js";
import {
  normalizeChatQualityPolicyV1,
  type ChatQualityPolicyV1,
} from "../quality-policy.js";

export const CHAT_INTERACTION_STATE_SCHEMA_V1 =
  "atlcli.chat-interaction-state/v1" as const;
export const CHAT_USER_QUESTION_SCHEMA_V1 =
  "atlcli.chat-user-question/v1" as const;
export const CHAT_USER_QUESTION_ANSWER_SCHEMA_V1 =
  "atlcli.chat-user-question-answer/v1" as const;
export const CHAT_INTERACTION_STATE_PATH_V1 =
  "/.atlcli/chat/v1/interaction.json" as const;

const MAX_QUEUE_ITEMS = 32;
const MAX_RESOLVED_QUESTIONS = 32;
const MAX_OPTIONS = 12;

export interface ChatUserQuestionOptionV1 {
  id: string;
  label: string;
  description?: string;
}

export type ChatUserQuestionV1 = {
  schema: typeof CHAT_USER_QUESTION_SCHEMA_V1;
  id: string;
  prompt: string;
  required: boolean;
} & (
  | { responseKind: "free_text"; maxLength: number }
  | {
      responseKind: "single_choice";
      options: ChatUserQuestionOptionV1[];
    }
  | {
      responseKind: "multiple_choice";
      options: ChatUserQuestionOptionV1[];
      minSelections: number;
      maxSelections: number;
    }
  | {
      responseKind: "mixed";
      options: ChatUserQuestionOptionV1[];
      minSelections: number;
      maxSelections: number;
      maxLength: number;
    }
  | {
      responseKind: "assumption";
      assumption: string;
    }
);

export type ChatUserQuestionAnswerValueV1 =
  | { kind: "text"; text: string }
  | { kind: "selection"; optionIds: string[] }
  | { kind: "mixed"; optionIds: string[]; text?: string }
  | { kind: "assumption"; decision: "accepted" | "rejected" };

export interface ChatUserQuestionAnswerV1 {
  schema: typeof CHAT_USER_QUESTION_ANSWER_SCHEMA_V1;
  questionId: string;
  value: ChatUserQuestionAnswerValueV1;
}

export interface ChatResumeEnvelopeV1 {
  request: ResearchRequestV1;
  qualityPolicy: ChatQualityPolicyV1;
}

/** Portable pause signal projected by every Chat host shape. */
export class ChatUserQuestionRequiredError extends ChatContractError {
  readonly question: ChatUserQuestionV1;

  constructor(question: ChatUserQuestionV1) {
    super("clarification-required", "Chat requires a durable user answer before it can continue.");
    this.name = "ChatUserQuestionRequiredError";
    this.question = structuredClone(question);
  }
}

export interface ChatQueuedFollowUpV1 {
  id: string;
  revision: number;
  content: string;
  enqueuedAt: string;
  updatedAt: string;
}

export interface ChatPendingSteeringV1 {
  id: string;
  revision: number;
  instruction: string;
  requestedAt: string;
}

export interface ChatStopRequestV1 {
  revision: number;
  requestedAt: string;
  acknowledgedAt?: string;
}

export interface ChatInteractionStateV1 {
  schema: typeof CHAT_INTERACTION_STATE_SCHEMA_V1;
  conversationId: string;
  revision: number;
  binding: ChatSessionBindingV1;
  updatedAt: string;
  queue: ChatQueuedFollowUpV1[];
  pendingSteering?: ChatPendingSteeringV1;
  stop?: ChatStopRequestV1;
  pendingQuestion?: {
    turnId: string;
    question: ChatUserQuestionV1;
    askedAt: string;
    resume: ChatResumeEnvelopeV1;
  };
  resolvedQuestions: Array<{
    turnId: string;
    question: ChatUserQuestionV1;
    answer: ChatUserQuestionAnswerV1;
    resolvedAt: string;
  }>;
}

/**
 * Host-neutral, revision-fenced controls for a live ordinary-Chat turn.
 * Presenters may request these mutations, but only the host that owns the
 * active workspace is allowed to apply them.
 */
export type ChatInteractionControlV1 =
  | {
      kind: "enqueue";
      expectedRevision: number;
      messageId: string;
      content: string;
      at: string;
    }
  | {
      kind: "edit";
      expectedRevision: number;
      messageId: string;
      expectedMessageRevision: number;
      content: string;
      at: string;
    }
  | {
      kind: "remove";
      expectedRevision: number;
      messageId: string;
      expectedMessageRevision: number;
      at: string;
    }
  | {
      kind: "steer";
      expectedRevision: number;
      steeringId: string;
      instruction: string;
      at: string;
    }
  | {
      kind: "consume_steering";
      expectedRevision: number;
      steeringId: string;
      expectedSteeringRevision: number;
      at: string;
    }
  | {
      kind: "edit_steering";
      expectedRevision: number;
      steeringId: string;
      expectedSteeringRevision: number;
      instruction: string;
      at: string;
    }
  | {
      kind: "remove_steering";
      expectedRevision: number;
      steeringId: string;
      expectedSteeringRevision: number;
      at: string;
    };

/** Presenter-safe form; the trusted host supplies the durable timestamp. */
export type ChatInteractionCommandV1 =
  | Omit<Extract<ChatInteractionControlV1, { kind: "enqueue" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "edit" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "remove" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "steer" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "consume_steering" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "edit_steering" }>, "at">
  | Omit<Extract<ChatInteractionControlV1, { kind: "remove_steering" }>, "at">;

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return normalized;
}

function id(value: unknown, label: string): string {
  const normalized = text(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(normalized)) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return normalized;
}

function iso(value: unknown, label: string): string {
  const normalized = text(value, label, 64);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized < 1) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return normalized;
}

export function normalizeChatInteractionControlV1(
  value: unknown,
): ChatInteractionControlV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat interaction control is invalid.");
  }
  const control = value as Record<string, unknown>;
  const expectedRevision = positiveInteger(
    control.expectedRevision,
    "Chat interaction expected revision",
  );
  const at = iso(control.at, "Chat interaction control time");
  if (control.kind === "enqueue") {
    return {
      kind: "enqueue",
      expectedRevision,
      messageId: id(control.messageId, "Chat queued message ID"),
      content: text(control.content, "Chat queued message", 2_000),
      at,
    };
  }
  if (control.kind === "edit") {
    return {
      kind: "edit",
      expectedRevision,
      messageId: id(control.messageId, "Chat queued message ID"),
      expectedMessageRevision: positiveInteger(
        control.expectedMessageRevision,
        "Chat queued message expected revision",
      ),
      content: text(control.content, "Chat queued message", 2_000),
      at,
    };
  }
  if (control.kind === "remove") {
    return {
      kind: "remove",
      expectedRevision,
      messageId: id(control.messageId, "Chat queued message ID"),
      expectedMessageRevision: positiveInteger(
        control.expectedMessageRevision,
        "Chat queued message expected revision",
      ),
      at,
    };
  }
  if (control.kind === "steer") {
    return {
      kind: "steer",
      expectedRevision,
      steeringId: id(control.steeringId, "Chat steering ID"),
      instruction: text(control.instruction, "Chat steering instruction", 2_000),
      at,
    };
  }
  if (control.kind === "consume_steering") {
    return {
      kind: "consume_steering",
      expectedRevision,
      steeringId: id(control.steeringId, "Chat steering ID"),
      expectedSteeringRevision: positiveInteger(
        control.expectedSteeringRevision,
        "Chat steering expected revision",
      ),
      at,
    };
  }
  if (control.kind === "edit_steering") {
    return {
      kind: "edit_steering",
      expectedRevision,
      steeringId: id(control.steeringId, "Chat steering ID"),
      expectedSteeringRevision: positiveInteger(
        control.expectedSteeringRevision,
        "Chat steering expected revision",
      ),
      instruction: text(control.instruction, "Chat steering instruction", 2_000),
      at,
    };
  }
  if (control.kind === "remove_steering") {
    return {
      kind: "remove_steering",
      expectedRevision,
      steeringId: id(control.steeringId, "Chat steering ID"),
      expectedSteeringRevision: positiveInteger(
        control.expectedSteeringRevision,
        "Chat steering expected revision",
      ),
      at,
    };
  }
  throw new ChatContractError("invalid-request", "Chat interaction control is invalid.");
}

export function normalizeChatInteractionCommandV1(
  value: unknown,
): ChatInteractionCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat interaction command is invalid.");
  }
  const command = value as Record<string, unknown>;
  return (({ at: _at, ...normalized }) => normalized)(
    normalizeChatInteractionControlV1({
      ...command,
      at: "2000-01-01T00:00:00.000Z",
    }),
  );
}

export function stampChatInteractionCommandV1(
  command: ChatInteractionCommandV1,
  at: string,
): ChatInteractionControlV1 {
  return normalizeChatInteractionControlV1({ ...command, at });
}

function assertRevision(state: ChatInteractionStateV1, expectedRevision: number): void {
  if (state.revision !== expectedRevision) {
    throw new ChatContractError("invalid-request", "Chat interaction revision is stale.");
  }
}

function next(
  state: ChatInteractionStateV1,
  updatedAt: string,
  update: Partial<Omit<ChatInteractionStateV1, "schema" | "conversationId" | "binding">>,
): ChatInteractionStateV1 {
  return {
    ...state,
    ...update,
    revision: state.revision + 1,
    updatedAt: iso(updatedAt, "Chat interaction update time"),
  };
}

function normalizeOptions(value: unknown): ChatUserQuestionOptionV1[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_OPTIONS) {
    throw new ChatContractError("invalid-request", "Chat question options are invalid.");
  }
  const options = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ChatContractError("invalid-request", "Chat question option is invalid.");
    }
    const option = candidate as Partial<ChatUserQuestionOptionV1>;
    return {
      id: id(option.id, "Chat question option ID"),
      label: text(option.label, "Chat question option label", 160),
      ...(option.description === undefined
        ? {}
        : { description: text(option.description, "Chat question option description", 320) }),
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new ChatContractError("invalid-request", "Chat question option IDs must be unique.");
  }
  return options;
}

export function normalizeChatUserQuestionV1(value: unknown): ChatUserQuestionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat user question is invalid.");
  }
  const question = value as Record<string, unknown>;
  if (question.schema !== CHAT_USER_QUESTION_SCHEMA_V1 ||
      typeof question.required !== "boolean") {
    throw new ChatContractError("invalid-request", "Chat user question is invalid.");
  }
  const base = {
    schema: CHAT_USER_QUESTION_SCHEMA_V1,
    id: id(question.id, "Chat user question ID"),
    prompt: text(question.prompt, "Chat user question prompt", 800),
    required: question.required,
  } as const;
  if (question.responseKind === "free_text") {
    const maximum = positiveInteger(question.maxLength, "Chat answer length");
    if (maximum > 4_000) throw new ChatContractError("invalid-request", "Chat answer length is invalid.");
    return { ...base, responseKind: "free_text", maxLength: maximum };
  }
  if (question.responseKind === "assumption") {
    return {
      ...base,
      responseKind: "assumption",
      assumption: text(question.assumption, "Chat declared assumption", 800),
    };
  }
  if (typeof question.responseKind !== "string" ||
      !["single_choice", "multiple_choice", "mixed"].includes(question.responseKind)) {
    throw new ChatContractError("invalid-request", "Chat question response kind is invalid.");
  }
  const options = normalizeOptions(question.options);
  if (question.responseKind === "single_choice") {
    return { ...base, responseKind: "single_choice", options };
  }
  const minSelections = nonNegativeInteger(
    question.minSelections,
    "Chat minimum selections",
  );
  const maxSelections = positiveInteger(
    question.maxSelections,
    "Chat maximum selections",
  );
  if (minSelections > maxSelections || maxSelections > options.length) {
    throw new ChatContractError("invalid-request", "Chat selection bounds are invalid.");
  }
  if (question.responseKind === "multiple_choice") {
    return {
      ...base,
      responseKind: "multiple_choice",
      options,
      minSelections,
      maxSelections,
    };
  }
  const maxLength = positiveInteger(question.maxLength, "Chat mixed answer length");
  if (maxLength > 4_000) {
    throw new ChatContractError("invalid-request", "Chat mixed answer length is invalid.");
  }
  return {
    ...base,
    responseKind: "mixed",
    options,
    minSelections,
    maxSelections,
    maxLength,
  };
}

function normalizeAnswer(
  question: ChatUserQuestionV1,
  value: unknown,
): ChatUserQuestionAnswerV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat user answer is invalid.");
  }
  const answer = value as Partial<ChatUserQuestionAnswerV1>;
  if (answer.schema !== CHAT_USER_QUESTION_ANSWER_SCHEMA_V1 ||
      answer.questionId !== question.id || !answer.value ||
      typeof answer.value !== "object") {
    throw new ChatContractError("invalid-request", "Chat user answer is invalid.");
  }
  const raw = answer.value as ChatUserQuestionAnswerValueV1;
  if (question.responseKind === "free_text") {
    if (raw.kind !== "text") throw new ChatContractError("invalid-request", "Chat text answer is invalid.");
    return {
      schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
      questionId: question.id,
      value: { kind: "text", text: text(raw.text, "Chat text answer", question.maxLength) },
    };
  }
  if (question.responseKind === "assumption") {
    if (raw.kind !== "assumption" || !["accepted", "rejected"].includes(raw.decision)) {
      throw new ChatContractError("invalid-request", "Chat assumption decision is invalid.");
    }
    return {
      schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
      questionId: question.id,
      value: { kind: "assumption", decision: raw.decision },
    };
  }
  const mixed = question.responseKind === "mixed";
  if ((!mixed && raw.kind !== "selection") || (mixed && raw.kind !== "mixed")) {
    throw new ChatContractError("invalid-request", "Chat selection answer is invalid.");
  }
  const selection = raw as {
    kind: "selection" | "mixed";
    optionIds?: unknown;
    text?: unknown;
  };
  const optionIds = Array.isArray(selection.optionIds)
    ? selection.optionIds.map((candidate: unknown) => id(candidate, "Chat selected option ID"))
    : [];
  if (new Set(optionIds).size !== optionIds.length ||
      optionIds.some((optionId) => !question.options.some((option) => option.id === optionId))) {
    throw new ChatContractError("invalid-request", "Chat selected options are invalid.");
  }
  const minimum = question.responseKind === "single_choice" ? 1 : question.minSelections;
  const maximum = question.responseKind === "single_choice" ? 1 : question.maxSelections;
  const freeText = mixed && selection.kind === "mixed" && selection.text !== undefined
    ? text(selection.text, "Chat mixed free-text answer", question.maxLength)
    : undefined;
  if (optionIds.length > maximum ||
      (optionIds.length < minimum && freeText === undefined) ||
      (question.required && optionIds.length === 0 && freeText === undefined)) {
    throw new ChatContractError("invalid-request", "Chat selection count is invalid.");
  }
  return {
    schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
    questionId: question.id,
    value: mixed
      ? { kind: "mixed", optionIds, ...(freeText ? { text: freeText } : {}) }
      : { kind: "selection", optionIds },
  };
}

export function createChatInteractionStateV1(input: {
  conversationId: string;
  binding: ChatSessionBindingV1;
  createdAt: string;
}): ChatInteractionStateV1 {
  return {
    schema: CHAT_INTERACTION_STATE_SCHEMA_V1,
    conversationId: id(input.conversationId, "Chat conversation ID"),
    revision: 1,
    binding: structuredClone(input.binding),
    updatedAt: iso(input.createdAt, "Chat interaction creation time"),
    queue: [],
    resolvedQuestions: [],
  };
}

export function assertChatInteractionBindingV1(input: {
  state: ChatInteractionStateV1;
  conversationId: string;
  binding: ChatSessionBindingV1;
}): void {
  const expected = input.binding;
  if (input.state.conversationId !== input.conversationId ||
      input.state.binding.userId !== expected.userId ||
      input.state.binding.threadId !== expected.threadId ||
      input.state.binding.tenantOrigin !== expected.tenantOrigin ||
      input.state.binding.providerCacheIdentity !== expected.providerCacheIdentity) {
    throw new ChatContractError(
      "invalid-request",
      "Chat interaction belongs to a different user, thread, tenant, or provider-cache partition.",
    );
  }
}

export function enqueueChatFollowUpV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  messageId: string;
  content: string;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  if (input.state.queue.length >= MAX_QUEUE_ITEMS) {
    throw new ChatContractError("limit-exceeded", "The Chat follow-up queue is full.");
  }
  const messageId = id(input.messageId, "Chat queued message ID");
  if (input.state.queue.some((message) => message.id === messageId)) {
    throw new ChatContractError("invalid-request", "Chat queued message ID is duplicated.");
  }
  const at = iso(input.at, "Chat queue time");
  return next(input.state, at, {
    queue: [...input.state.queue, {
      id: messageId,
      revision: 1,
      content: text(input.content, "Chat queued message", 2_000),
      enqueuedAt: at,
      updatedAt: at,
    }],
  });
}

export function editChatFollowUpV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  messageId: string;
  expectedMessageRevision: number;
  content: string;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  const messageId = id(input.messageId, "Chat queued message ID");
  let matched = false;
  const queue = input.state.queue.map((message) => {
    if (message.id !== messageId) return message;
    if (message.revision !== input.expectedMessageRevision) {
      throw new ChatContractError("invalid-request", "Chat queued message revision is stale.");
    }
    matched = true;
    return {
      ...message,
      revision: message.revision + 1,
      content: text(input.content, "Chat queued message", 2_000),
      updatedAt: iso(input.at, "Chat queue edit time"),
    };
  });
  if (!matched) throw new ChatContractError("invalid-request", "Chat queued message is unavailable.");
  return next(input.state, input.at, { queue });
}

export function removeChatFollowUpV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  messageId: string;
  expectedMessageRevision: number;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  const messageId = id(input.messageId, "Chat queued message ID");
  const message = input.state.queue.find((candidate) => candidate.id === messageId);
  if (!message || message.revision !== input.expectedMessageRevision) {
    throw new ChatContractError("invalid-request", "Chat queued message is stale or unavailable.");
  }
  return next(input.state, input.at, {
    queue: input.state.queue.filter((candidate) => candidate.id !== messageId),
  });
}

export function admitNextChatFollowUpV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  at: string;
}): { state: ChatInteractionStateV1; message?: ChatQueuedFollowUpV1 } {
  assertRevision(input.state, input.expectedRevision);
  const message = input.state.queue[0];
  if (!message) return { state: input.state };
  return {
    state: next(input.state, input.at, { queue: input.state.queue.slice(1) }),
    message: structuredClone(message),
  };
}

export function requestChatSteeringV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  steeringId: string;
  instruction: string;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  if (input.state.pendingSteering) {
    throw new ChatContractError("invalid-request", "Chat steering is already pending.");
  }
  return next(input.state, input.at, {
    pendingSteering: {
      id: id(input.steeringId, "Chat steering ID"),
      revision: 1,
      instruction: text(input.instruction, "Chat steering instruction", 2_000),
      requestedAt: iso(input.at, "Chat steering request time"),
    },
  });
}

/** Apply one already-normalized host control to a durable interaction snapshot. */
export function applyChatInteractionControlV1(
  state: ChatInteractionStateV1,
  control: ChatInteractionControlV1,
): ChatInteractionStateV1 {
  switch (control.kind) {
    case "enqueue":
      return enqueueChatFollowUpV1({ state, ...control });
    case "edit":
      return editChatFollowUpV1({ state, ...control });
    case "remove":
      return removeChatFollowUpV1({ state, ...control });
    case "steer":
      return requestChatSteeringV1({ state, ...control });
    case "consume_steering":
      return consumeChatSteeringV1({ state, ...control }).state;
    case "edit_steering":
      return editChatSteeringV1({ state, ...control });
    case "remove_steering":
      return removeChatSteeringV1({ state, ...control });
  }
}

export function consumeChatSteeringV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  steeringId: string;
  expectedSteeringRevision: number;
  at: string;
}): { state: ChatInteractionStateV1; steering: ChatPendingSteeringV1 } {
  assertRevision(input.state, input.expectedRevision);
  const steering = input.state.pendingSteering;
  if (!steering || steering.id !== input.steeringId ||
      steering.revision !== input.expectedSteeringRevision) {
    throw new ChatContractError("invalid-request", "Chat steering is stale or unavailable.");
  }
  const state = next(input.state, input.at, {});
  delete state.pendingSteering;
  return { state, steering: structuredClone(steering) };
}

export function editChatSteeringV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  steeringId: string;
  expectedSteeringRevision: number;
  instruction: string;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  const steering = input.state.pendingSteering;
  if (!steering || steering.id !== input.steeringId ||
      steering.revision !== input.expectedSteeringRevision) {
    throw new ChatContractError("invalid-request", "Chat steering is stale or unavailable.");
  }
  return next(input.state, input.at, {
    pendingSteering: {
      ...steering,
      revision: steering.revision + 1,
      instruction: text(input.instruction, "Chat steering instruction", 2_000),
    },
  });
}

export function removeChatSteeringV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  steeringId: string;
  expectedSteeringRevision: number;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  const steering = input.state.pendingSteering;
  if (!steering || steering.id !== input.steeringId ||
      steering.revision !== input.expectedSteeringRevision) {
    throw new ChatContractError("invalid-request", "Chat steering is stale or unavailable.");
  }
  const state = next(input.state, input.at, {});
  delete state.pendingSteering;
  return state;
}

export function requestChatStopV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  if (input.state.stop && !input.state.stop.acknowledgedAt) return input.state;
  return next(input.state, input.at, {
    stop: {
      revision: (input.state.stop?.revision ?? 0) + 1,
      requestedAt: iso(input.at, "Chat stop request time"),
    },
  });
}

export function acknowledgeChatStopV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  expectedStopRevision: number;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  if (!input.state.stop || input.state.stop.revision !== input.expectedStopRevision ||
      input.state.stop.acknowledgedAt) {
    throw new ChatContractError("invalid-request", "Chat stop request is stale or unavailable.");
  }
  return next(input.state, input.at, {
    stop: { ...input.state.stop, acknowledgedAt: iso(input.at, "Chat stop acknowledgement time") },
  });
}

export function recordChatUserQuestionV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  turnId: string;
  question: ChatUserQuestionV1;
  resume: ChatResumeEnvelopeV1;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  if (input.state.pendingQuestion) {
    throw new ChatContractError("invalid-request", "Chat already awaits a user answer.");
  }
  const question = normalizeChatUserQuestionV1(input.question);
  return next(input.state, input.at, {
    pendingQuestion: {
      turnId: id(input.turnId, "Chat turn ID"),
      question,
      askedAt: iso(input.at, "Chat question time"),
      resume: {
        request: normalizeResearchRequestV1(input.resume.request),
        qualityPolicy: normalizeChatQualityPolicyV1(input.resume.qualityPolicy),
      },
    },
  });
}

export function resolveChatUserQuestionV1(input: {
  state: ChatInteractionStateV1;
  expectedRevision: number;
  turnId: string;
  answer: ChatUserQuestionAnswerV1;
  at: string;
}): ChatInteractionStateV1 {
  assertRevision(input.state, input.expectedRevision);
  const pending = input.state.pendingQuestion;
  if (!pending || pending.turnId !== input.turnId) {
    throw new ChatContractError("invalid-request", "Chat user question is stale or unavailable.");
  }
  const answer = normalizeAnswer(pending.question, input.answer);
  const resolvedQuestions = [...input.state.resolvedQuestions, {
    turnId: pending.turnId,
    question: pending.question,
    answer,
    resolvedAt: iso(input.at, "Chat user answer time"),
  }].slice(-MAX_RESOLVED_QUESTIONS);
  const state = next(input.state, input.at, { resolvedQuestions });
  delete state.pendingQuestion;
  return state;
}

export function parseChatInteractionStateV1(value: unknown): ChatInteractionStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat interaction state is invalid.");
  }
  const state = structuredClone(value) as ChatInteractionStateV1;
  if (state.schema !== CHAT_INTERACTION_STATE_SCHEMA_V1 ||
      !state.binding || typeof state.binding !== "object" ||
      !Array.isArray(state.queue) || state.queue.length > MAX_QUEUE_ITEMS ||
      !Array.isArray(state.resolvedQuestions) ||
      state.resolvedQuestions.length > MAX_RESOLVED_QUESTIONS) {
    throw new ChatContractError("invalid-request", "Chat interaction state is invalid.");
  }
  id(state.conversationId, "Chat conversation ID");
  positiveInteger(state.revision, "Chat interaction revision");
  iso(state.updatedAt, "Chat interaction update time");
  for (const key of ["userId", "threadId", "tenantOrigin", "providerCacheIdentity"] as const) {
    text(state.binding[key], `Chat interaction binding ${key}`, 512);
  }
  const queueIds = new Set<string>();
  for (const message of state.queue) {
    const messageId = id(message.id, "Chat queued message ID");
    if (queueIds.has(messageId)) throw new ChatContractError("invalid-request", "Chat queue contains duplicate IDs.");
    queueIds.add(messageId);
    positiveInteger(message.revision, "Chat queued message revision");
    text(message.content, "Chat queued message", 2_000);
    iso(message.enqueuedAt, "Chat queue time");
    iso(message.updatedAt, "Chat queue update time");
  }
  if (state.pendingSteering) {
    id(state.pendingSteering.id, "Chat steering ID");
    positiveInteger(state.pendingSteering.revision, "Chat steering revision");
    text(state.pendingSteering.instruction, "Chat steering instruction", 2_000);
    iso(state.pendingSteering.requestedAt, "Chat steering request time");
  }
  if (state.stop) {
    positiveInteger(state.stop.revision, "Chat stop revision");
    iso(state.stop.requestedAt, "Chat stop request time");
    if (state.stop.acknowledgedAt) iso(state.stop.acknowledgedAt, "Chat stop acknowledgement time");
  }
  if (state.pendingQuestion) {
    id(state.pendingQuestion.turnId, "Chat pending question turn ID");
    normalizeChatUserQuestionV1(state.pendingQuestion.question);
    iso(state.pendingQuestion.askedAt, "Chat question time");
    if (!state.pendingQuestion.resume || typeof state.pendingQuestion.resume !== "object") {
      throw new ChatContractError("invalid-request", "Chat resume envelope is invalid.");
    }
    normalizeResearchRequestV1(state.pendingQuestion.resume.request);
    normalizeChatQualityPolicyV1(state.pendingQuestion.resume.qualityPolicy);
  }
  for (const resolved of state.resolvedQuestions) {
    id(resolved.turnId, "Chat resolved question turn ID");
    const question = normalizeChatUserQuestionV1(resolved.question);
    normalizeAnswer(question, resolved.answer);
    iso(resolved.resolvedAt, "Chat resolved question time");
  }
  return state;
}

/**
 * Serializes host-owned interaction changes for one retained Chat workspace.
 * Every mutation is revision-fenced before it is durably published. The class
 * contains no UI, CLI, model, or provider behavior and is therefore shared by
 * every host shape.
 */
export class WorkspaceChatInteractionControllerV1 {
  readonly #workspace: ResearchWorkspace;
  #state: ChatInteractionStateV1;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    workspace: ResearchWorkspace,
    state: ChatInteractionStateV1,
  ) {
    this.#workspace = workspace;
    this.#state = state;
  }

  static async bind(input: {
    workspace: ResearchWorkspace;
    conversationId: string;
    binding: ChatSessionBindingV1;
    at: string;
  }): Promise<WorkspaceChatInteractionControllerV1> {
    const stored = await input.workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1);
    const state = stored === undefined
      ? createChatInteractionStateV1({
          conversationId: input.conversationId,
          binding: input.binding,
          createdAt: input.at,
        })
      : (() => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(stored);
          } catch {
            throw new ChatContractError("invalid-request", "Stored Chat interaction state is invalid.");
          }
          return parseChatInteractionStateV1(parsed);
        })();
    assertChatInteractionBindingV1({
      state,
      conversationId: input.conversationId,
      binding: input.binding,
    });
    if (stored === undefined) {
      await input.workspace.writeFile(CHAT_INTERACTION_STATE_PATH_V1, JSON.stringify(state));
    }
    return new WorkspaceChatInteractionControllerV1(input.workspace, state);
  }

  snapshot(): ChatInteractionStateV1 {
    return structuredClone(this.#state);
  }

  async update(
    mutate: (state: ChatInteractionStateV1) => ChatInteractionStateV1,
  ): Promise<ChatInteractionStateV1> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const nextState = parseChatInteractionStateV1(mutate(this.snapshot()));
      if (nextState.revision <= this.#state.revision) {
        throw new ChatContractError(
          "invalid-request",
          "Chat interaction update did not advance its durable revision.",
        );
      }
      assertChatInteractionBindingV1({
        state: nextState,
        conversationId: this.#state.conversationId,
        binding: this.#state.binding,
      });
      await this.#workspace.writeFile(
        CHAT_INTERACTION_STATE_PATH_V1,
        JSON.stringify(nextState),
      );
      this.#state = nextState;
      return this.snapshot();
    } finally {
      release();
    }
  }
}
