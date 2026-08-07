import { ChatAnthropic } from "@langchain/anthropic";
import {
  ANTHROPIC_QUALITY_ADAPTER_V1,
  resolveProviderQualityV1,
  type ProviderReasoningPreferenceV1,
} from "../../quality-policy.js";
import {
  ChatContractError,
  providerCompatibleChatJsonSchemaV1,
} from "../contracts.js";
import type { ChatModelBindingV1, ChatModelFactoryInputV1 } from "../model.js";

export const ANTHROPIC_CHAT_MODEL_ID = "claude-sonnet-4-6" as const;

export function anthropicOutputTokensForPreferenceV1(
  preference: ProviderReasoningPreferenceV1,
  rootLimit: number,
): number {
  const profileLimit = preference === "fast"
    ? 2_048
    : preference === "balanced"
      ? 4_096
      : 8_000;
  return Math.max(1, Math.min(rootLimit, profileLimit));
}

export function createAnthropicChatModelBindingV1(
  input: ChatModelFactoryInputV1,
): ChatModelBindingV1 {
  const credential = input.credential.trim();
  if (!credential) {
    throw new ChatContractError("missing-key", "An LLM provider credential is required.");
  }
  const models = new Map<ProviderReasoningPreferenceV1, ChatAnthropic>();
  const modelForPreference = (
    preference: ProviderReasoningPreferenceV1,
  ): ChatAnthropic => {
    const cached = models.get(preference);
    if (cached) return cached;
    const resolved = resolveProviderQualityV1(
      {
        ...input.qualityPolicy,
        providerReasoningPreference: preference,
      },
      ANTHROPIC_QUALITY_ADAPTER_V1,
    );
    const model = new ChatAnthropic({
      model: ANTHROPIC_CHAT_MODEL_ID,
      apiKey: credential,
      maxTokens: anthropicOutputTokensForPreferenceV1(
        preference,
        input.maxOutputTokens,
      ),
      maxRetries: 0,
      streaming: true,
      ...(resolved.controls?.adaptiveThinking
        ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
        : { temperature: 0 }),
      ...(resolved.controls?.effort
        ? { outputConfig: { effort: resolved.controls.effort } }
        : {}),
    });
    models.set(preference, model);
    return model;
  };
  const rootPreference = input.qualityPolicy.providerReasoningPreference;
  const resolved = resolveProviderQualityV1(input.qualityPolicy, ANTHROPIC_QUALITY_ADAPTER_V1);
  return {
    model: modelForPreference(rootPreference),
    modelId: ANTHROPIC_CHAT_MODEL_ID,
    qualityAdapter: ANTHROPIC_QUALITY_ADAPTER_V1,
    // ToolStrategy keeps the structured answer portable across providers and
    // gives LangChain a bounded schema-repair turn. LangGraph exposes the
    // accumulated tool arguments while they stream, so this does not sacrifice
    // progressive Markdown rendering.
    structuredOutput: "tool",
    modelForPreference,
    projectResponseSchema: providerCompatibleChatJsonSchemaV1,
    ...(resolved.controls?.adaptiveThinking
      ? { reasoningPresentation: "summary" as const }
      : {}),
  };
}
