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
  "Conversation to summarize:",
  "{conversation}",
].join(" ");

export function chatSummarizationContextPolicyV1(
  model: BaseChatModel,
  operationalMaxInputTokens?: number,
): {
  trigger: Array<
    { type: "messages"; value: number } |
    { type: "tokens"; value: number }
  >;
  keep: { type: "messages" | "tokens"; value: number };
  trimTokensToSummarize?: number;
} {
  // Test doubles and capability-minimal provider adapters may not publish a
  // profile. Keep the native policy in that case instead of dereferencing a
  // capability that is optional at runtime.
  const maxInputTokens = operationalMaxInputTokens ?? model.profile?.maxInputTokens;
  if (!maxInputTokens) {
    return {
      trigger: CHAT_NATIVE_SUMMARIZATION_TRIGGER_V1,
      keep: CHAT_NATIVE_SUMMARIZATION_KEEP_V1,
    };
  }
  return {
    // Keep headroom for tool schemas and the next tool result; these are not
    // fully represented by the middleware's message-token estimate.
    trigger: [
      { type: "messages", value: 24 },
      { type: "tokens", value: Math.floor(maxInputTokens * 0.65) },
    ],
    keep: {
      type: "tokens",
      value: Math.max(512, Math.floor(maxInputTokens * 0.12)),
    },
    trimTokensToSummarize: Math.max(1_024, Math.floor(maxInputTokens * 0.5)),
  };
}

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
    operationalMaxInputTokens?: number;
    shortTurnPassThrough?: boolean;
  },
): AgentMiddleware {
  const contextPolicy = chatSummarizationContextPolicyV1(
    options.model,
    options.operationalMaxInputTokens,
  );
  const native = runtime.createSummarizationMiddleware({
    backend: createDeepAgentSummarizationBackendV1(
      options.workspace,
      CHAT_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1,
    ),
    model: options.model,
    trigger: contextPolicy.trigger,
    keep: contextPolicy.keep,
    ...(contextPolicy.trimTokensToSummarize === undefined
      ? {}
      : { trimTokensToSummarize: contextPolicy.trimTokensToSummarize }),
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
      const [request, handler] = args;
      const hasPriorSummary = Boolean(
        request.state &&
          typeof request.state === "object" &&
          "_summarizationEvent" in request.state &&
          request.state._summarizationEvent,
      );
      if (
        options.shortTurnPassThrough &&
        !hasPriorSummary &&
        (request.messages?.length ?? 0) <= 6
      ) {
        // A short local tool round-trip can cross DeepAgents' proactive token
        // trigger because that estimate includes the root prompt and schemas.
        // There is no conversation history to compact in that case. Calling
        // the native summarizer can select an empty message suffix when one
        // retained tool result is larger than its trim budget, replacing the
        // live evidence with an empty summary. Let the local adapter's exact
        // context guard surface a real overflow instead.
        return handler(request);
      }
      const result = await nativeWrapModelCall(...args);
      const summary = nativeSummary(result);
      if (summary) replaceNativeSummary(result, summary);
      return result;
    },
  } as AgentMiddleware;
}
