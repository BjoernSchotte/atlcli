import {
  RESEARCH_ACTIVITY_CODES_V1,
  type ResearchActivityCodeV1,
} from "../contracts.js";
import type { ResearchWorkspace } from "../workspace.js";
import { ChatContractError } from "./contracts.js";

export const CHAT_ACTIVITY_JOURNAL_SCHEMA_V1 =
  "atlcli.chat-activity-journal/v1" as const;
export const CHAT_ACTIVITY_EVENT_SCHEMA_V1 =
  "atlcli.chat-activity-event/v1" as const;
export const CHAT_ACTIVITY_JOURNAL_PATH_V1 =
  "/.atlcli/chat/v1/activity.json" as const;

const MAXIMUM_CHAT_ACTIVITY_EVENTS_V1 = 768;
const MAXIMUM_CHAT_ACTIVITY_EVENTS_PER_TURN_V1 = 64;

export interface ChatActivityEventV1 {
  schema: typeof CHAT_ACTIVITY_EVENT_SCHEMA_V1;
  id: string;
  conversationId: string;
  turnId: string;
  revision: number;
  at: string;
  code: ResearchActivityCodeV1;
  status: "started" | "completed" | "failed";
}

export interface ChatActivityJournalV1 {
  schema: typeof CHAT_ACTIVITY_JOURNAL_SCHEMA_V1;
  conversationId: string;
  revision: number;
  events: ChatActivityEventV1[];
}

function boundedToken(value: unknown, label: string, maximum = 200): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
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

export function normalizeChatActivityEventV1(value: unknown): ChatActivityEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat activity event is invalid.");
  }
  const event = value as Record<string, unknown>;
  const allowed = [
    "schema",
    "id",
    "conversationId",
    "turnId",
    "revision",
    "at",
    "code",
    "status",
  ];
  if (Object.keys(event).some((key) => !allowed.includes(key)) ||
      event.schema !== CHAT_ACTIVITY_EVENT_SCHEMA_V1 ||
      !RESEARCH_ACTIVITY_CODES_V1.includes(
        event.code as (typeof RESEARCH_ACTIVITY_CODES_V1)[number],
      ) ||
      !["started", "completed", "failed"].includes(String(event.status))) {
    throw new ChatContractError("invalid-request", "Chat activity event is invalid.");
  }
  const normalized: ChatActivityEventV1 = {
    schema: CHAT_ACTIVITY_EVENT_SCHEMA_V1,
    id: boundedToken(event.id, "Chat activity event ID", 360),
    conversationId: boundedToken(event.conversationId, "Chat conversation ID"),
    turnId: boundedToken(event.turnId, "Chat turn ID"),
    revision: positiveInteger(event.revision, "Chat activity revision"),
    at: timestamp(event.at, "Chat activity time"),
    code: event.code as ResearchActivityCodeV1,
    status: event.status as ChatActivityEventV1["status"],
  };
  if (normalized.id !== `chat-activity:${normalized.turnId}:${normalized.revision}`) {
    throw new ChatContractError("invalid-request", "Chat activity event identity is invalid.");
  }
  return normalized;
}

export function normalizeChatActivityJournalV1(
  value: unknown,
): ChatActivityJournalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Chat activity journal is invalid.");
  }
  const journal = value as Record<string, unknown>;
  if (
    Object.keys(journal).some((key) =>
      !["schema", "conversationId", "revision", "events"].includes(key)
    ) ||
    journal.schema !== CHAT_ACTIVITY_JOURNAL_SCHEMA_V1 ||
    !Array.isArray(journal.events) ||
    journal.events.length > MAXIMUM_CHAT_ACTIVITY_EVENTS_V1
  ) {
    throw new ChatContractError("invalid-request", "Chat activity journal is invalid.");
  }
  const conversationId = boundedToken(
    journal.conversationId,
    "Chat activity conversation ID",
  );
  const events = journal.events.map(normalizeChatActivityEventV1);
  if (events.some((event) => event.conversationId !== conversationId)) {
    throw new ChatContractError("access-denied", "Chat activity journal binding is invalid.");
  }
  const ids = new Set(events.map((event) => event.id));
  if (ids.size !== events.length) {
    throw new ChatContractError("invalid-request", "Chat activity journal contains duplicate events.");
  }
  return {
    schema: CHAT_ACTIVITY_JOURNAL_SCHEMA_V1,
    conversationId,
    revision: positiveInteger(journal.revision, "Chat activity journal revision"),
    events,
  };
}

/**
 * Durable, body-free Chat activity. Provider summaries and answer deltas never
 * enter this journal; only stable semantic milestones are replayable.
 */
export class WorkspaceChatActivityJournalV1 {
  readonly #workspace: ResearchWorkspace;
  #state: ChatActivityJournalV1;
  #persistence: Promise<void> = Promise.resolve();

  private constructor(workspace: ResearchWorkspace, state: ChatActivityJournalV1) {
    this.#workspace = workspace;
    this.#state = state;
  }

  static async open(input: {
    workspace: ResearchWorkspace;
    conversationId: string;
    persistIfMissing?: boolean;
  }): Promise<WorkspaceChatActivityJournalV1> {
    const conversationId = boundedToken(input.conversationId, "Chat conversation ID");
    const raw = await input.workspace.readFile(CHAT_ACTIVITY_JOURNAL_PATH_V1);
    const state = raw === undefined
      ? {
          schema: CHAT_ACTIVITY_JOURNAL_SCHEMA_V1,
          conversationId,
          revision: 1,
          events: [],
        } satisfies ChatActivityJournalV1
      : normalizeChatActivityJournalV1(JSON.parse(raw));
    if (state.conversationId !== conversationId) {
      throw new ChatContractError(
        "access-denied",
        "Chat activity belongs to a different conversation.",
      );
    }
    const journal = new WorkspaceChatActivityJournalV1(input.workspace, state);
    if (raw === undefined && input.persistIfMissing !== false) journal.#scheduleWrite();
    await journal.flush();
    return journal;
  }

  record(input: {
    turnId: string;
    at: string;
    code: ResearchActivityCodeV1;
    status: ChatActivityEventV1["status"];
  }): string {
    const turnId = boundedToken(input.turnId, "Chat turn ID");
    const turnEvents = this.#state.events.filter((event) => event.turnId === turnId);
    const existing = turnEvents.find((event) =>
      event.code === input.code && event.status === input.status
    );
    if (existing) {
      return existing.id;
    }
    if (turnEvents.length >= MAXIMUM_CHAT_ACTIVITY_EVENTS_PER_TURN_V1) {
      throw new ChatContractError("limit-exceeded", "Chat activity event limit exceeded.");
    }
    const revision = (turnEvents.at(-1)?.revision ?? 0) + 1;
    const event = normalizeChatActivityEventV1({
      schema: CHAT_ACTIVITY_EVENT_SCHEMA_V1,
      id: `chat-activity:${turnId}:${revision}`,
      conversationId: this.#state.conversationId,
      turnId,
      revision,
      at: input.at,
      code: input.code,
      status: input.status,
    });
    this.#state = {
      ...this.#state,
      revision: this.#state.revision + 1,
      events: [...this.#state.events, event].slice(-MAXIMUM_CHAT_ACTIVITY_EVENTS_V1),
    };
    this.#scheduleWrite();
    return event.id;
  }

  referencesForTurn(turnId: string): string[] {
    const normalized = boundedToken(turnId, "Chat turn ID");
    return this.#state.events
      .filter((event) => event.turnId === normalized)
      .map((event) => event.id);
  }

  eventsForReferences(references: readonly string[]): ChatActivityEventV1[] {
    const admitted = new Set(
      references.map((reference) => boundedToken(reference, "Chat activity reference", 360)),
    );
    return this.#state.events
      .filter((event) => admitted.has(event.id))
      .map((event) => structuredClone(event));
  }

  async flush(): Promise<void> {
    await this.#persistence;
  }

  #scheduleWrite(): void {
    const snapshot = JSON.stringify(this.#state);
    this.#persistence = this.#persistence.then(() =>
      this.#workspace.writeFile(CHAT_ACTIVITY_JOURNAL_PATH_V1, snapshot)
    );
  }
}
