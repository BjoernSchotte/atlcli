import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  type ResearchPort,
} from "../../../utils/research/contracts.js";
import type {
  ResearchResumableSessionV1,
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

    async prepareScopeClarificationReview(request, policy) {
      const window = await chrome.windows.getCurrent();
      if (window.id === undefined) {
        throw new ResearchContractError("provider-error", "The side panel window is unavailable.");
      }
      const response = await chrome.runtime.sendMessage({
        kind: "research:prepare-scope-clarification-review",
        windowId: window.id,
        request,
        policy,
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
      const sessionId = `research-session:${crypto.randomUUID()}`;
      const turnId = `research-turn:${crypto.randomUUID()}`;
      const policy = normalizeResearchOneShotPolicyV1(options?.policy);
      activeRunId = runId;
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
          kind: "research:cancel",
          runId,
        }).catch(() => undefined);
      };
      chrome.runtime.onMessage.addListener(onProgress);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      const timeoutId = setTimeout(cancel, request.limits.maxRunMs);
      try {
        const response = (await chrome.runtime.sendMessage({
          kind: "research:run",
          runId,
          sessionId,
          turnId,
          windowId: window.id,
          request,
          policy,
        })) as
          | {
              kind: "research:run-result";
              runId: string;
              ok: true;
              report: Awaited<ReturnType<ResearchPort["run"]>>;
            }
          | {
              kind: "research:run-result";
              runId: string;
              ok: false;
              code: ConstructorParameters<typeof ResearchContractError>[0];
              error: string;
            }
          | undefined;
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
          kind: "research:cancel",
          runId,
        }).catch(() => undefined);
      };
      chrome.runtime.onMessage.addListener(onProgress);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      const timeoutId = setTimeout(cancel, MAX_RESEARCH_RESUME_MS);
      try {
        const response = await chrome.runtime.sendMessage({
          kind: "research:resume",
          runId,
          sessionId,
          windowId: window.id,
        }) as
          | {
              kind: "research:resume-result";
              runId: string;
              ok: true;
              report: Awaited<ReturnType<ResearchPort["run"]>>;
            }
          | {
              kind: "research:resume-result";
              runId: string;
              ok: false;
              code: ConstructorParameters<typeof ResearchContractError>[0];
              error: string;
            }
          | undefined;
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
