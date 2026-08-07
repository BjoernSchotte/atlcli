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

export function anthropicRootOutputTokensV1(
  mode: ChatModelFactoryInputV1["qualityPolicy"]["mode"],
  rootLimit: number,
): number {
  const modeLimit = mode === "deep" ? 8_000 : 4_096;
  return Math.max(1, Math.min(rootLimit, modeLimit));
}

export function createAnthropicChatModelBindingV1(
  input: ChatModelFactoryInputV1,
): ChatModelBindingV1 {
  const credential = input.credential.trim();
  if (!credential) {
    throw new ChatContractError("missing-key", "An LLM provider credential is required.");
  }
  const models = new Map<ProviderReasoningPreferenceV1, ChatAnthropic>();
  let finalizationModel: ChatAnthropic | undefined;
  const createModel = (
    preference: ProviderReasoningPreferenceV1,
    maxTokens: number,
  ): ChatAnthropic => {
    const resolved = resolveProviderQualityV1(
      {
        ...input.qualityPolicy,
        providerReasoningPreference: preference,
      },
      ANTHROPIC_QUALITY_ADAPTER_V1,
    );
    return new ChatAnthropic({
      model: ANTHROPIC_CHAT_MODEL_ID,
      apiKey: credential,
      maxTokens,
      // LangChain keeps the Anthropic SDK client itself at zero retries and
      // routes this value through its retry-aware caller. One retry therefore
      // covers provider-classified 429/5xx overloads without replaying the
      // host workflow or any Atlassian read capability.
      maxRetries: 1,
      streaming: true,
      ...(resolved.controls?.adaptiveThinking
        ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
        : { temperature: 0 }),
      ...(resolved.controls?.effort
        ? { outputConfig: { effort: resolved.controls.effort } }
        : {}),
    });
  };
  const modelForPreference = (
    preference: ProviderReasoningPreferenceV1,
  ): ChatAnthropic => {
    const cached = models.get(preference);
    if (cached) return cached;
    const model = createModel(
      preference,
      anthropicOutputTokensForPreferenceV1(
        preference,
        input.maxOutputTokens,
      ),
    );
    models.set(preference, model);
    return model;
  };
  const rootPreference = input.qualityPolicy.providerReasoningPreference;
  const rootMaxTokens = anthropicRootOutputTokensV1(
    input.qualityPolicy.mode,
    input.maxOutputTokens,
  );
  const preferenceMaxTokens = anthropicOutputTokensForPreferenceV1(
    rootPreference,
    input.maxOutputTokens,
  );
  const rootModel = rootMaxTokens === preferenceMaxTokens
    ? modelForPreference(rootPreference)
    : createModel(rootPreference, rootMaxTokens);
  const resolved = resolveProviderQualityV1(input.qualityPolicy, ANTHROPIC_QUALITY_ADAPTER_V1);
  return {
    model: rootModel,
    modelId: ANTHROPIC_CHAT_MODEL_ID,
    qualityAdapter: ANTHROPIC_QUALITY_ADAPTER_V1,
    // Anthropic supports LangChain's native JSON-schema response format while
    // ordinary tools remain available. This makes the terminal answer an
    // enforced provider response instead of one optional tool among eval/HITL.
    // Other providers remain free to select the portable ToolStrategy through
    // the model-binding contract.
    structuredOutput: "native",
    modelForPreference,
    modelForFinalization: () => {
      finalizationModel ??= createModel(
        "fast",
        Math.min(input.maxOutputTokens, 5_000),
      );
      return finalizationModel;
    },
    projectResponseSchema: providerCompatibleChatJsonSchemaV1,
    ...(resolved.controls?.adaptiveThinking
      ? { reasoningPresentation: "summary" as const }
      : {}),
  };
}
