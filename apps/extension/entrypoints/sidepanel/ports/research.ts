import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  type ResearchPort,
} from "../../../utils/research/contracts.js";
import {
  RESEARCH_ANTHROPIC_SESSION_KEY,
  normalizeAnthropicApiKey,
} from "../../../utils/research/credential.js";
import {
  isResearchEvent,
  isResearchProgress,
} from "../../../utils/messages.js";

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
