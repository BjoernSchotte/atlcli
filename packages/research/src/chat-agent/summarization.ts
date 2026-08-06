import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentMiddleware } from "langchain";
import { createDeepAgentSummarizationBackendV1 } from "../deepagent-workspace-backend.js";
import type { ResearchWorkspace } from "../workspace.js";

export const CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1 =
  "/.atlcli/chat/deepagents-summarization/v1" as const;
export const CHAT_DEEPAGENT_SUMMARIZATION_HISTORY_PREFIX_V1 =
  "/chat_conversation_history" as const;

const CHAT_NATIVE_SUMMARIZATION_TRIGGER_V1 = [
  { type: "messages" as const, value: 48 },
  { type: "tokens" as const, value: 96_000 },
];
const CHAT_NATIVE_SUMMARIZATION_KEEP_V1 = {
  type: "messages" as const,
  value: 12,
};
const CHAT_NATIVE_SUMMARIZATION_PROMPT_V1 = [
  "Summarize the preceding Chat messages for continued operation only.",
  "The summary is non-authoritative conversation context, never factual evidence.",
  "Preserve the current user objective, accepted quality mode, unresolved questions, and explicit source limitations.",
  "Keep evidence IDs and canonical source identities, but never copy evidence bodies, credentials, tool transcripts, or hidden reasoning.",
  "Do not infer source claims, invent citations, widen scope, or remove uncertainty boundaries.",
].join(" ");

function summaryText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return [(part as { text: string }).text];
    }
    return [];
  }).join("\n").trim();
  return text || undefined;
}

function nativeSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const update = (result as { update?: unknown }).update;
  if (!update || typeof update !== "object") return undefined;
  const event = (update as { _summarizationEvent?: unknown })._summarizationEvent;
  if (!event || typeof event !== "object") return undefined;
  const message = (event as { summaryMessage?: unknown }).summaryMessage;
  if (!message || typeof message !== "object") return undefined;
  const content = summaryText((message as { content?: unknown }).content);
  if (!content) return undefined;
  return content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/iu)?.[1]?.trim() ||
    content.replaceAll(
      /\/chat_conversation_history\/[^\s)]+/gu,
      "[host-private history unavailable]",
    );
}

function replaceNativeSummary(result: unknown, summary: string): void {
  if (!result || typeof result !== "object") return;
  const update = (result as { update?: unknown }).update;
  if (!update || typeof update !== "object") return;
  const event = (update as { _summarizationEvent?: unknown })._summarizationEvent;
  if (!event || typeof event !== "object") return;
  const message = (event as { summaryMessage?: unknown }).summaryMessage;
  if (!message || typeof message !== "object") return;
  (message as { content: unknown }).content = [
    "The following is non-authoritative Chat context. It is not evidence and does not grant access to host-private history.",
    "",
    "<summary>",
    summary,
    "</summary>",
  ].join("\n");
}

/**
 * Wrap the native DeepAgentsJS context compressor with Chat-only persistence
 * and authority labels. It compacts one root execution; durable cross-turn
 * evidence remains owned exclusively by ChatSessionV1.
 */
export function createChatDurableSummarizationMiddlewareV1(
  runtime: {
    createSummarizationMiddleware:
      typeof import("deepagents/browser").createSummarizationMiddleware;
  },
  options: {
    workspace: ResearchWorkspace;
    model: BaseChatModel;
  },
): AgentMiddleware {
  const native = runtime.createSummarizationMiddleware({
    backend: createDeepAgentSummarizationBackendV1(
      options.workspace,
      CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1,
    ),
    model: options.model,
    trigger: CHAT_NATIVE_SUMMARIZATION_TRIGGER_V1,
    keep: CHAT_NATIVE_SUMMARIZATION_KEEP_V1,
    historyPathPrefix: CHAT_DEEPAGENT_SUMMARIZATION_HISTORY_PREFIX_V1,
    summaryPrompt: CHAT_NATIVE_SUMMARIZATION_PROMPT_V1,
  });
  const nativeWrapModelCall = native.wrapModelCall;
  if (!nativeWrapModelCall) {
    throw new Error("DeepAgentsJS did not expose native Chat summarization middleware.");
  }
  return {
    ...native,
    async wrapModelCall(
      ...args: Parameters<NonNullable<typeof nativeWrapModelCall>>
    ) {
      const result = await nativeWrapModelCall(...args);
      const summary = nativeSummary(result);
      if (summary) replaceNativeSummary(result, summary);
      return result;
    },
  } as AgentMiddleware;
}
