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
      streaming: false,
      ...(resolved.controls?.adaptiveThinking
        ? { thinking: { type: "adaptive" as const } }
        : { temperature: 0 }),
      ...(resolved.controls?.effort
        ? { outputConfig: { effort: resolved.controls.effort } }
        : {}),
    }),
    modelId: ANTHROPIC_CHAT_MODEL_ID,
    qualityAdapter: ANTHROPIC_QUALITY_ADAPTER_V1,
    // ToolStrategy is the portable LangChain/DeepAgentsJS baseline and avoids
    // coupling the Chat contract to Anthropic's evolving native JSON envelope.
    // A future adapter may opt into `native` only after its production path is
    // proven against the same strict host finalizer.
    structuredOutput: "tool",
  };
}
