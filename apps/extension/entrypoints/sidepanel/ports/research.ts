import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  type ChatAnswerV1,
  type ResearchPort,
  type ResearchReport,
} from "../../../utils/research/contracts.js";
import type {
  ResearchResumableSessionV1,
  ResearchRetainedSessionV1,
  ResearchClarificationReviewResolutionV1,
  ResearchSessionClarificationReviewV1,
  ResearchScopeClarificationReviewResolutionV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
} from "@atlcli/research";
import {
  RESEARCH_ANTHROPIC_SESSION_KEY,
  normalizeAnthropicApiKey,
} from "../../../utils/research/credential.js";
import {
  isResearchEvent,
  isResearchProgress,
} from "../../../utils/messages.js";

const MAX_RESEARCH_RESUME_MS = 10 * 60_000;
const ACTIVE_CHAT_CONVERSATION_KEY = "atlcli.research.active-chat-conversation-id.v1";
const RESEARCH_SESSION_ID_PATTERN = /^research-session:[A-Za-z0-9._-]{1,120}$/;

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

  return {
    async hasApiKey() {
      const stored = await chrome.storage.session.get([
        RESEARCH_ANTHROPIC_SESSION_KEY,
      ]);
      return (
        typeof stored[RESEARCH_ANTHROPIC_SESSION_KEY] === "string" &&
        stored[RESEARCH_ANTHROPIC_SESSION_KEY].trim().length > 0
      );
    },

    async setApiKey(value) {
      const apiKey = normalizeAnthropicApiKey(value);
      await chrome.storage.session.set({
        [RESEARCH_ANTHROPIC_SESSION_KEY]: apiKey,
      });
    },

    async clearApiKey() {
      await chrome.storage.session.remove(RESEARCH_ANTHROPIC_SESSION_KEY);
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
      const turnId = `research-turn:${crypto.randomUUID()}`;
      const policy = normalizeResearchOneShotPolicyV1(options?.policy);
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
            ...(options?.qualityPolicy ? { qualityPolicy: options.qualityPolicy } : {}),
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
