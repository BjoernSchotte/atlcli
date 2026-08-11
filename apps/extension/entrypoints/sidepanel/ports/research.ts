import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  type ChatAnswerV1,
  type ResearchPort,
  type ResearchReport,
} from "../../../utils/research/contracts.js";
import {
  ChatUserQuestionRequiredError,
  defineChatAgentPortV1,
  type ChatAgentPortV1,
} from "@atlcli/research";
import type {
  ResearchResumableSessionV1,
  ResearchRetainedSessionV1,
  ResearchClarificationReviewResolutionV1,
  ResearchSessionClarificationReviewV1,
  ResearchScopeClarificationReviewResolutionV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
  ChatUserQuestionV1,
  ChatInteractionStateV1,
  ChatActivityEventV1,
} from "@atlcli/research";
import {
  assertChatSessionBindingV1,
  assertChatInteractionBindingV1,
  CHAT_SESSION_PATH_V1,
  CHAT_INTERACTION_STATE_PATH_V1,
  IndexedDbResearchSessionStoreV1,
  parseChatSessionV1,
  parseChatInteractionStateV1,
  WorkspaceChatActivityJournalV1,
  WorkspaceChatAnswerFeedbackJournalV1,
} from "@atlcli/research/browser";
import {
  browserApiKeyPersistenceV1,
  changeBrowserApiKeyPersistenceV1,
  chromeBrowserCredentialStorageV1,
  clearBrowserApiKeyV1,
  readBrowserApiKeyV1,
  storeBrowserApiKeyV1,
} from "../../../utils/research/browser-credential-storage.js";
import {
  isChatPresentationMessage,
  isResearchEvent,
  isResearchProgress,
} from "../../../utils/messages.js";
import {
  ACTIVE_CHAT_CONVERSATION_KEY,
  CHAT_CONVERSATION_ID_PATTERN,
  browserChatHostIdentityV1,
} from "../../../utils/research/browser-chat-host.js";
import { createBrowserChatTurnPortV1 } from "../../../utils/research/chat-turn-port.js";

const MAX_RESEARCH_RESUME_MS = 10 * 60_000;
const RESEARCH_SESSION_ID_PATTERN = CHAT_CONVERSATION_ID_PATTERN;

async function readActiveChatInteractionV1(siteOrigin: string): Promise<{
  conversationId: string;
  state: ChatInteractionStateV1;
} | null> {
  const stored = await chrome.storage.local.get(ACTIVE_CHAT_CONVERSATION_KEY);
  const conversationId = stored[ACTIVE_CHAT_CONVERSATION_KEY];
  if (typeof conversationId !== "string" || !RESEARCH_SESSION_ID_PATTERN.test(conversationId)) {
    return null;
  }
  const identity = await browserChatHostIdentityV1();
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    if (!await store.read(conversationId)) return null;
    const workspace = await store.workspace(conversationId);
    const serialized = await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1);
    if (serialized === undefined) return null;
    const state = parseChatInteractionStateV1(JSON.parse(serialized));
    assertChatInteractionBindingV1({
      state,
      conversationId,
      binding: {
        ...identity,
        threadId: conversationId,
        tenantOrigin: siteOrigin,
      },
    });
    return { conversationId, state };
  } finally {
    store.close();
  }
}

async function readActiveChatReplayV1(siteOrigin: string): Promise<{
  conversationId: string;
  turnId: string;
  objective: string;
  events: ChatActivityEventV1[];
  finalAnswer?: ChatAnswerV1;
} | null> {
  const stored = await chrome.storage.local.get(ACTIVE_CHAT_CONVERSATION_KEY);
  const conversationId = stored[ACTIVE_CHAT_CONVERSATION_KEY];
  if (typeof conversationId !== "string" || !RESEARCH_SESSION_ID_PATTERN.test(conversationId)) {
    return null;
  }
  const identity = await browserChatHostIdentityV1();
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    if (!await store.read(conversationId)) return null;
    const workspace = await store.workspace(conversationId);
    const serialized = await workspace.readFile(CHAT_SESSION_PATH_V1);
    if (serialized === undefined) return null;
    const session = parseChatSessionV1(JSON.parse(serialized));
    assertChatSessionBindingV1({
      session,
      conversationId,
      identity,
      tenantOrigin: siteOrigin,
    });
    const turn = session.conversation.recentTurns.at(-1);
    if (!turn) return null;
    const journal = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId,
      persistIfMissing: false,
    });
    return {
      conversationId,
      turnId: turn.id,
      objective: turn.objective,
      events: journal.eventsForReferences(turn.activityRefs),
      ...(turn.finalAnswer ? { finalAnswer: turn.finalAnswer } : {}),
    };
  } finally {
    store.close();
  }
}

async function readChatSessionProjectionV1(input: {
  siteOrigin: string;
  conversationId: string;
}): Promise<{
  session: import("@atlcli/research").ChatSessionV1;
  eventsForTurn(turnId: string): Promise<ChatActivityEventV1[]>;
} | null> {
  if (!RESEARCH_SESSION_ID_PATTERN.test(input.conversationId)) return null;
  const identity = await browserChatHostIdentityV1();
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    if (!await store.read(input.conversationId)) return null;
    const workspace = await store.workspace(input.conversationId);
    const serialized = await workspace.readFile(CHAT_SESSION_PATH_V1);
    if (serialized === undefined) return null;
    const session = parseChatSessionV1(JSON.parse(serialized));
    assertChatSessionBindingV1({
      session,
      conversationId: input.conversationId,
      identity,
      tenantOrigin: input.siteOrigin,
    });
    const journal = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId: input.conversationId,
      persistIfMissing: false,
    });
    const eventsByTurn = new Map(session.conversation.recentTurns.map((turn) => [
      turn.id,
      journal.eventsForReferences(turn.activityRefs),
    ]));
    return {
      session,
      async eventsForTurn(turnId) {
        return structuredClone(eventsByTurn.get(turnId) ?? []);
      },
    };
  } finally {
    store.close();
  }
}

async function recordBrowserChatAnswerFeedbackV1(
  input: import("@atlcli/research").ChatAgentSubmitFeedbackV1,
): Promise<import("@atlcli/research").ChatAnswerFeedbackV1> {
  if (!RESEARCH_SESSION_ID_PATTERN.test(input.conversationId)) {
    throw new ResearchContractError("invalid-request", "The Chat conversation is invalid.");
  }
  const identity = await browserChatHostIdentityV1();
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    if (!await store.read(input.conversationId)) {
      throw new ResearchContractError("invalid-request", "The Chat conversation is unavailable.");
    }
    const workspace = await store.workspace(input.conversationId);
    const serialized = await workspace.readFile(CHAT_SESSION_PATH_V1);
    if (serialized === undefined) {
      throw new ResearchContractError("invalid-request", "The Chat conversation is unavailable.");
    }
    const session = parseChatSessionV1(JSON.parse(serialized));
    assertChatSessionBindingV1({
      session,
      conversationId: input.conversationId,
      identity,
      tenantOrigin: input.siteOrigin,
    });
    const turn = session.conversation.recentTurns.find((candidate) =>
      candidate.id === input.turnId
    );
    if (!turn?.finalAnswer || turn.status !== "complete") {
      throw new ResearchContractError(
        "invalid-request",
        "Chat answer feedback requires a completed answer.",
      );
    }
    const journal = await WorkspaceChatAnswerFeedbackJournalV1.open({
      workspace,
      conversationId: input.conversationId,
    });
    return await journal.record({
      turnId: input.turnId,
      rating: input.rating,
      reasonCodes: input.reasonCodes,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

async function listChatHistoryV1(siteOrigin: string): Promise<
  import("@atlcli/research").ChatConversationHistoryItemV1[]
> {
  const identity = await browserChatHostIdentityV1();
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    const history: import("@atlcli/research").ChatConversationHistoryItemV1[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const stored of page.sessions) {
        const workspace = await store.workspace(stored.sessionId);
        const serialized = await workspace.readFile(CHAT_SESSION_PATH_V1);
        if (serialized === undefined) continue;
        try {
          const session = parseChatSessionV1(JSON.parse(serialized));
          assertChatSessionBindingV1({
            session,
            conversationId: stored.sessionId,
            identity,
            tenantOrigin: siteOrigin,
          });
          const latest = session.conversation.recentTurns.at(-1);
          history.push({
            conversationId: session.conversationId,
            updatedAt: session.updatedAt,
            ...(latest
              ? {
                  latestTurnId: latest.id,
                  latestObjective: latest.objective,
                  status: latest.status,
                }
              : {}),
          });
        } catch {
          // Foreign principals, tenants and non-Chat sessions remain invisible.
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return history.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } finally {
    store.close();
  }
}

function safeFilename(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized.endsWith(".md") ? normalized : `${normalized || "research-report"}.md`;
}

export function chromeResearchPort(): ResearchPort {
  let activeRunId: string | null = null;
  const credentialStorage = chromeBrowserCredentialStorageV1();

  return {
    async hasApiKey() {
      return (await readBrowserApiKeyV1(credentialStorage)) !== undefined;
    },

    async getApiKeyPersistence() {
      return browserApiKeyPersistenceV1(credentialStorage);
    },

    async setApiKey(value, options) {
      await storeBrowserApiKeyV1(
        credentialStorage,
        value,
        options?.persistence ?? "session",
      );
    },

    async setApiKeyPersistence(persistence) {
      await changeBrowserApiKeyPersistenceV1(credentialStorage, persistence);
    },

    async clearApiKey() {
      await clearBrowserApiKeyV1(credentialStorage);
    },

    async getPendingChatQuestion(siteOrigin) {
      const active = await readActiveChatInteractionV1(siteOrigin);
      if (!active?.state.pendingQuestion) return null;
      return {
        conversationId: active.conversationId,
        turnId: active.state.pendingQuestion.turnId,
        question: active.state.pendingQuestion.question,
        request: active.state.pendingQuestion.resume.request,
        qualityPolicy: active.state.pendingQuestion.resume.qualityPolicy,
      };
    },

    async getChatInteraction(siteOrigin) {
      return (await readActiveChatInteractionV1(siteOrigin))?.state ?? null;
    },

    async getChatReplay(siteOrigin) {
      return readActiveChatReplayV1(siteOrigin);
    },

    async controlActiveChat(command) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:chat-control",
        windowId: window.id,
        command,
      }) as
        | { kind: "research:chat-control-result"; ok: true; state: ChatInteractionStateV1 }
        | {
            kind: "research:chat-control-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:chat-control-result") {
        throw new ResearchContractError(
          "provider-error",
          "The Chat interaction host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.state;
    },

    async resetChatConversation() {
      await chrome.storage.local.remove(ACTIVE_CHAT_CONVERSATION_KEY);
    },

    async resolveScope(request, options) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = (await chrome.runtime.sendMessage({
        kind: "research:resolve-scope",
        windowId: window.id,
        request,
        ...(options ? { options } : {}),
      })) as
        | {
            kind: "research:resolve-scope-result";
            ok: true;
            outcome: Awaited<ReturnType<ResearchPort["resolveScope"]>>;
          }
        | {
            kind: "research:resolve-scope-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:resolve-scope-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async listResumableSessions() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-resumable-sessions",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-resumable-sessions-result";
            ok: true;
            sessions: ResearchResumableSessionV1[];
          }
        | {
            kind: "research:list-resumable-sessions-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-resumable-sessions-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research session host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.sessions;
    },

    async listRetainedSessions() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-retained-sessions",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-retained-sessions-result";
            ok: true;
            sessions: ResearchRetainedSessionV1[];
          }
        | {
            kind: "research:list-retained-sessions-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-retained-sessions-result") {
        throw new ResearchContractError(
          "provider-error",
          "The retained research session host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.sessions;
    },

    async prepareFollowUpTurn(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:prepare-follow-up-turn",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:prepare-follow-up-turn-result";
            ok: true;
            outcome: Awaited<ReturnType<NonNullable<ResearchPort["prepareFollowUpTurn"]>>>;
          }
        | {
            kind: "research:prepare-follow-up-turn-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:prepare-follow-up-turn-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research follow-up host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async requestSteering(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:steer-session",
        windowId: window.id,
        ...input,
      }) as
        | { kind: "research:steer-session-result"; ok: true }
        | {
            kind: "research:steer-session-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:steer-session-result") {
        throw new ResearchContractError("provider-error", "The research steering host returned no result.");
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
    },

    async listScopeReviews() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-scope-reviews",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-scope-reviews-result";
            ok: true;
            reviews: ResearchSessionScopeReviewV1[];
          }
        | {
            kind: "research:list-scope-reviews-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-scope-reviews-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope-review host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.reviews;
    },

    async listScopePlanReviews() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-scope-plan-reviews",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-scope-plan-reviews-result";
            ok: true;
            reviews: ResearchSessionScopeReviewV1[];
          }
        | {
            kind: "research:list-scope-plan-reviews-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-scope-plan-reviews-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope-plan-review host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.reviews;
    },

    async approveScopeReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:approve-scope-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:approve-scope-review-result";
            ok: true;
            review: ResearchSessionScopeReviewV1;
          }
        | {
            kind: "research:approve-scope-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:approve-scope-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope-approval host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async rejectScopeReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:reject-scope-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:reject-scope-review-result";
            ok: true;
            review: ResearchSessionScopeReviewV1;
          }
        | {
            kind: "research:reject-scope-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:reject-scope-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope-rejection host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async approveScopePlanReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:approve-scope-plan-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:approve-scope-plan-review-result";
            ok: true;
            review: ResearchSessionScopeReviewV1;
          }
        | {
            kind: "research:approve-scope-plan-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:approve-scope-plan-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research scope-plan-approval host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async preparePlanReview(request, policy) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:prepare-plan-review",
        windowId: window.id,
        request,
        policy,
      }) as
        | {
            kind: "research:prepare-plan-review-result";
            ok: true;
            review: ResearchSessionPlanReviewV1;
          }
        | {
            kind: "research:prepare-plan-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:prepare-plan-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research plan-preparation host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async listPlanReviews() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-plan-reviews",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-plan-reviews-result";
            ok: true;
            reviews: ResearchSessionPlanReviewV1[];
          }
        | {
            kind: "research:list-plan-reviews-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-plan-reviews-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research plan-review host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.reviews;
    },

    async approvePlanReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:approve-plan-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:approve-plan-review-result";
            ok: true;
            session: ResearchResumableSessionV1;
          }
        | {
            kind: "research:approve-plan-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:approve-plan-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research plan-approval host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.session;
    },

    async rejectPlanReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:reject-plan-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:reject-plan-review-result";
            ok: true;
            review: ResearchSessionPlanReviewV1;
          }
        | {
            kind: "research:reject-plan-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:reject-plan-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research plan-revision host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async prepareClarificationReview(request, policy) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:prepare-clarification-review",
        windowId: window.id,
        request,
        policy,
      }) as
        | {
            kind: "research:prepare-clarification-review-result";
            ok: true;
            review: ResearchSessionClarificationReviewV1;
          }
        | {
            kind: "research:prepare-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:prepare-clarification-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research clarification-preparation host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async listClarificationReviews() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-clarification-reviews",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-clarification-reviews-result";
            ok: true;
            reviews: ResearchSessionClarificationReviewV1[];
          }
        | {
            kind: "research:list-clarification-reviews-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-clarification-reviews-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research clarification-review host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.reviews;
    },

    async resolveClarificationReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:resolve-clarification-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:resolve-clarification-review-result";
            ok: true;
            outcome: ResearchClarificationReviewResolutionV1;
          }
        | {
            kind: "research:resolve-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:resolve-clarification-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research clarification-resolution host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async continueClarificationReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:continue-clarification-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:continue-clarification-review-result";
            ok: true;
            outcome: ResearchClarificationReviewResolutionV1;
          }
        | {
            kind: "research:continue-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:continue-clarification-review-result") {
        throw new ResearchContractError(
          "provider-error",
          "The research clarification-recovery host returned no result.",
        );
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async prepareScopeClarificationReview(request, policy, options) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:prepare-scope-clarification-review",
        windowId: window.id,
        request,
        policy,
        ...(options?.purpose ? { purpose: options.purpose } : {}),
      }) as
        | {
            kind: "research:prepare-scope-clarification-review-result";
            ok: true;
            review: ResearchSessionScopeClarificationReviewV1;
          }
        | {
            kind: "research:prepare-scope-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:prepare-scope-clarification-review-result") {
        throw new ResearchContractError("provider-error", "The research scope-clarification host returned no result.");
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.review;
    },

    async listScopeClarificationReviews() {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:list-scope-clarification-reviews",
        windowId: window.id,
      }) as
        | {
            kind: "research:list-scope-clarification-reviews-result";
            ok: true;
            reviews: ResearchSessionScopeClarificationReviewV1[];
          }
        | {
            kind: "research:list-scope-clarification-reviews-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:list-scope-clarification-reviews-result") {
        throw new ResearchContractError("provider-error", "The research scope-clarification review host returned no result.");
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.reviews;
    },

    async resolveScopeClarificationReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:resolve-scope-clarification-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:resolve-scope-clarification-review-result";
            ok: true;
            outcome: ResearchScopeClarificationReviewResolutionV1;
          }
        | {
            kind: "research:resolve-scope-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:resolve-scope-clarification-review-result") {
        throw new ResearchContractError("provider-error", "The research scope-clarification resolution host returned no result.");
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async continueScopeClarificationReview(input) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:continue-scope-clarification-review",
        windowId: window.id,
        ...input,
      }) as
        | {
            kind: "research:continue-scope-clarification-review-result";
            ok: true;
            outcome: ResearchScopeClarificationReviewResolutionV1;
          }
        | {
            kind: "research:continue-scope-clarification-review-result";
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (!response || response.kind !== "research:continue-scope-clarification-review-result") {
        throw new ResearchContractError("provider-error", "The research scope-clarification recovery host returned no result.");
      }
      if (!response.ok) throw new ResearchContractError(response.code, response.error);
      return response.outcome;
    },

    async run(request, options) {
      if (activeRunId) {
        throw new ResearchContractError(
          "invalid-request",
          "A research run is already active."
        );
      }
      if (options?.signal?.aborted) {
        throw new ResearchContractError("cancelled", "The research run was cancelled.");
      }
      const runId = crypto.randomUUID();
      let sessionId = `research-session:${crypto.randomUUID()}`;
      if (options?.mode === "chat") {
        const stored = await chrome.storage.local.get(ACTIVE_CHAT_CONVERSATION_KEY);
        const retained = stored[ACTIVE_CHAT_CONVERSATION_KEY];
        sessionId = options.conversationId ?? (
          typeof retained === "string" && RESEARCH_SESSION_ID_PATTERN.test(retained)
            ? retained
            : sessionId
        );
        await chrome.storage.local.set({ [ACTIVE_CHAT_CONVERSATION_KEY]: sessionId });
      }
      const turnId = options?.chatResume?.turnId ??
        options?.chatCheckpointResume?.turnId ??
        `research-turn:${crypto.randomUUID()}`;
      const policy = normalizeResearchOneShotPolicyV1(options?.policy);
      const hostIdentity = options?.mode === "chat"
        ? await browserChatHostIdentityV1()
        : undefined;
      activeRunId = runId;
      options?.onSessionStart?.({ sessionId, turnId });
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        activeRunId = null;
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable."
        );
      }
      const onProgress = (message: unknown): void => {
        if (isResearchProgress(message, runId)) {
          options?.onProgress?.(message.progress);
        }
        if (isResearchEvent(message, runId)) {
          options?.onEvent?.(message.event);
        }
        if (isChatPresentationMessage(message, runId)) {
          options?.onChatPresentation?.(message.event);
        }
      };
      const cancel = (): void => {
        void chrome.runtime.sendMessage({
          kind: "research:cancel-session",
          runId,
        }).catch(() => undefined);
      };
      chrome.runtime.onMessage.addListener(onProgress);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      const timeoutId = setTimeout(cancel, request.limits.maxRunMs);
      try {
        let response:
          | {
              kind: "research:run-result";
              runId: string;
              ok: true;
              report: ResearchReport | ChatAnswerV1;
            }
          | {
              kind: "research:run-result";
              runId: string;
              ok: false;
              code: ConstructorParameters<typeof ResearchContractError>[0];
              error: string;
              question?: ChatUserQuestionV1;
            }
          | undefined;
        try {
          response = (await chrome.runtime.sendMessage({
            kind: "research:run",
            runId,
            sessionId,
            turnId,
            windowId: window.id,
            mode: options?.mode ?? "research",
            request,
            policy,
            ...(hostIdentity ? { hostIdentity } : {}),
            ...(options?.qualityPolicy ? { qualityPolicy: options.qualityPolicy } : {}),
            ...(options?.chatResume ? { resumeAnswer: options.chatResume.answer } : {}),
            ...(options?.chatCheckpointResume
              ? { resumeCheckpoint: { kind: options.chatCheckpointResume.kind } }
              : {}),
          })) as typeof response;
        } catch (error) {
          if (options?.signal?.aborted) {
            throw new ResearchContractError("cancelled", "The research run was cancelled.");
          }
          throw error;
        }
        if (options?.signal?.aborted) {
          throw new ResearchContractError("cancelled", "The research run was cancelled.");
        }
        if (
          !response ||
          response.kind !== "research:run-result" ||
          response.runId !== runId
        ) {
          throw new ResearchContractError(
            "provider-error",
            "The research host returned no correlated result."
          );
        }
        if (!response.ok) {
          if (response.question) {
            throw new ChatUserQuestionRequiredError(response.question);
          }
          throw new ResearchContractError(response.code, response.error);
        }
        return response.report;
      } finally {
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(onProgress);
        options?.signal?.removeEventListener("abort", cancel);
        if (activeRunId === runId) activeRunId = null;
      }
    },

    async resume(sessionId, options) {
      if (activeRunId) {
        throw new ResearchContractError(
          "invalid-request",
          "A research run is already active.",
        );
      }
      if (options?.signal?.aborted) {
        throw new ResearchContractError("cancelled", "The research run was cancelled.");
      }
      const runId = crypto.randomUUID();
      activeRunId = runId;
      options?.onSessionStart?.({ sessionId });
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        activeRunId = null;
        throw new ResearchContractError(
          "provider-error",
          "The side panel window is unavailable.",
        );
      }
      const onProgress = (message: unknown): void => {
        if (isResearchProgress(message, runId)) {
          options?.onProgress?.(message.progress);
        }
        if (isResearchEvent(message, runId)) {
          options?.onEvent?.(message.event);
        }
      };
      const cancel = (): void => {
        void chrome.runtime.sendMessage({
          kind: "research:cancel-session",
          runId,
        }).catch(() => undefined);
      };
      chrome.runtime.onMessage.addListener(onProgress);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      const timeoutId = setTimeout(cancel, MAX_RESEARCH_RESUME_MS);
      try {
        let response:
          | {
              kind: "research:resume-result";
              runId: string;
              ok: true;
              report: ResearchReport;
            }
          | {
              kind: "research:resume-result";
              runId: string;
              ok: false;
              code: ConstructorParameters<typeof ResearchContractError>[0];
              error: string;
            }
          | undefined;
        try {
          response = await chrome.runtime.sendMessage({
            kind: "research:resume",
            runId,
            sessionId,
            windowId: window.id,
          }) as typeof response;
        } catch (error) {
          if (options?.signal?.aborted) {
            throw new ResearchContractError("cancelled", "The research run was cancelled.");
          }
          throw error;
        }
        if (options?.signal?.aborted) {
          throw new ResearchContractError("cancelled", "The research run was cancelled.");
        }
        if (
          !response ||
          response.kind !== "research:resume-result" ||
          response.runId !== runId
        ) {
          throw new ResearchContractError(
            "provider-error",
            "The research host returned no correlated resume result.",
          );
        }
        if (!response.ok) {
          throw new ResearchContractError(response.code, response.error);
        }
        return response.report;
      } finally {
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(onProgress);
        options?.signal?.removeEventListener("abort", cancel);
        if (activeRunId === runId) activeRunId = null;
      }
    },

    async pauseActiveRun() {
      const runId = activeRunId;
      if (!runId) {
        throw new ResearchContractError(
          "invalid-request",
          "There is no active research run to pause.",
        );
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:pause-session",
        runId,
      }) as
        | {
            kind: "research:pause-session-result";
            runId: string;
            ok: true;
            status: "pause_requested" | "paused";
          }
        | {
            kind: "research:pause-session-result";
            runId: string;
            ok: false;
            code: ConstructorParameters<typeof ResearchContractError>[0];
            error: string;
          }
        | undefined;
      if (
        !response ||
        response.kind !== "research:pause-session-result" ||
        response.runId !== runId
      ) {
        throw new ResearchContractError(
          "provider-error",
          "The research pause host returned no correlated result.",
        );
      }
      if (!response.ok) {
        throw new ResearchContractError(response.code, response.error);
      }
      return response.status;
    },

    async copyMarkdown(markdown) {
      await navigator.clipboard.writeText(markdown);
    },

    async downloadMarkdown(markdown, filename) {
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" })
      );
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = safeFilename(filename);
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}

/** Chrome transport for the shared ordinary-Chat product port. */
export function chromeChatAgentPort(research: ResearchPort): ChatAgentPortV1 {
  const turns = createBrowserChatTurnPortV1(research.run.bind(research));
  const execute = async (input: {
    request: import("@atlcli/research").ResearchRequestV1;
    qualityPolicy: import("@atlcli/research").ChatQualityPolicyV1;
    conversationId?: string;
    resumeAnswer?: import("@atlcli/research").ChatUserQuestionAnswerV1;
    resumeCheckpoint?: { turnId: string; kind: "stream-interruption" | "steering" };
  }, stream?: import("@atlcli/research").ChatAgentStreamV1): Promise<ChatAnswerV1> => {
    return turns.execute(input, stream);
  };

  return defineChatAgentPortV1({
    startTurn: (input, stream) => execute(input, stream),
    async answerQuestion(input, stream) {
      const pending = await research.getPendingChatQuestion?.(input.siteOrigin);
      if (!pending || pending.conversationId !== input.conversationId ||
          pending.turnId !== input.turnId) {
        throw new ResearchContractError("invalid-request", "The Chat question checkpoint is stale.");
      }
      return execute({
        request: pending.request,
        qualityPolicy: pending.qualityPolicy,
        conversationId: pending.conversationId,
        resumeAnswer: input.answer,
        resumeCheckpoint: { turnId: pending.turnId, kind: "stream-interruption" },
      }, stream);
    },
    async resumeTurn(input, stream) {
      const interaction = await research.getChatInteraction?.(input.siteOrigin);
      if (!interaction || interaction.conversationId !== input.conversationId) {
        throw new ResearchContractError("invalid-request", "The Chat checkpoint is unavailable.");
      }
      const checkpoint = input.kind === "stream-interruption"
        ? interaction.streamInterruption
        : interaction.acceptedSteering;
      if (!checkpoint || checkpoint.turnId !== input.turnId) {
        throw new ResearchContractError("invalid-request", "The Chat checkpoint is stale.");
      }
      return execute({
        request: checkpoint.resume.request,
        qualityPolicy: checkpoint.resume.qualityPolicy,
        conversationId: interaction.conversationId,
        resumeCheckpoint: { turnId: checkpoint.turnId, kind: input.kind },
      }, stream);
    },
    async getPendingQuestion(siteOrigin) {
      const pending = await research.getPendingChatQuestion?.(siteOrigin);
      return pending
        ? {
            conversationId: pending.conversationId,
            turnId: pending.turnId,
            question: pending.question,
          }
        : null;
    },
    async getInteraction(siteOrigin) {
      return await research.getChatInteraction?.(siteOrigin) ?? null;
    },
    async control(command) {
      if (!research.controlActiveChat) {
        throw new ResearchContractError("invalid-request", "Chat controls are unavailable.");
      }
      return research.controlActiveChat(command);
    },
    stop: turns.stop,
    listHistory: listChatHistoryV1,
    async replay(input) {
      const conversationId = input.conversationId ?? (
        await chrome.storage.local.get(ACTIVE_CHAT_CONVERSATION_KEY)
      )[ACTIVE_CHAT_CONVERSATION_KEY];
      if (typeof conversationId !== "string") return null;
      const projection = await readChatSessionProjectionV1({
        siteOrigin: input.siteOrigin,
        conversationId,
      });
      const turn = projection?.session.conversation.recentTurns.at(-1);
      if (!projection || !turn) return null;
      return {
        conversationId,
        turnId: turn.id,
        objective: turn.objective,
        events: await projection.eventsForTurn(turn.id),
        ...(turn.finalAnswer ? { finalAnswer: turn.finalAnswer } : {}),
      };
    },
    async artifact(input) {
      const projection = await readChatSessionProjectionV1(input);
      const turn = projection?.session.conversation.recentTurns.find((candidate) =>
        candidate.id === input.turnId
      );
      return turn?.finalAnswer
        ? {
            conversationId: input.conversationId,
            turnId: input.turnId,
            mediaType: "text/markdown",
            markdown: turn.finalAnswer.messageMarkdown,
          }
        : null;
    },
    async sources(input) {
      const projection = await readChatSessionProjectionV1(input);
      const turn = projection?.session.conversation.recentTurns.find((candidate) =>
        candidate.id === input.turnId
      );
      return turn?.finalAnswer
        ? {
            conversationId: input.conversationId,
            turnId: input.turnId,
            sources: structuredClone(turn.finalAnswer.citations),
          }
        : null;
    },
    submitFeedback: recordBrowserChatAnswerFeedbackV1,
    async resetConversation() {
      await research.resetChatConversation?.();
    },
  });
}
