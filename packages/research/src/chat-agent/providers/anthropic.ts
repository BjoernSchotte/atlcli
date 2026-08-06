import { ChatAnthropic } from "@langchain/anthropic";
import {
  ANTHROPIC_QUALITY_ADAPTER_V1,
  resolveProviderQualityV1,
} from "../../quality-policy.js";
import { ChatContractError } from "../contracts.js";
import type { ChatModelBindingV1, ChatModelFactoryInputV1 } from "../model.js";

export const ANTHROPIC_CHAT_MODEL_ID = "claude-sonnet-4-6" as const;

export function createAnthropicChatModelBindingV1(
  input: ChatModelFactoryInputV1,
): ChatModelBindingV1 {
  const credential = input.credential.trim();
  if (!credential) {
    throw new ChatContractError("missing-key", "An LLM provider credential is required.");
  }
  const resolved = resolveProviderQualityV1(
    input.qualityPolicy,
    ANTHROPIC_QUALITY_ADAPTER_V1,
  );
  return {
    model: new ChatAnthropic({
      model: ANTHROPIC_CHAT_MODEL_ID,
      apiKey: credential,
      maxTokens: input.maxOutputTokens,
      maxRetries: 0,
      streaming: true,
      ...(resolved.controls?.adaptiveThinking
        ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
        : { temperature: 0 }),
      ...(resolved.controls?.effort
        ? { outputConfig: { effort: resolved.controls.effort } }
        : {}),
    }),
    modelId: ANTHROPIC_CHAT_MODEL_ID,
    qualityAdapter: ANTHROPIC_QUALITY_ADAPTER_V1,
    // Anthropic's native JSON-schema output keeps the terminal model step in
    // the normal streamed response channel. A ToolStrategy would force the
    // terminal response through a tool call, which suppresses summarized
    // thinking and answer-text chunks on Sonnet 4.6. The stricter host Zod
    // finalizer remains authoritative after LangChain parses this envelope.
    structuredOutput: "native",
    ...(resolved.controls?.adaptiveThinking
      ? { reasoningPresentation: "summary" as const }
      : {}),
  };
}
