import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ChatQualityPolicyV1,
  ProviderQualityCapabilityAdapterV1,
  ProviderReasoningPreferenceV1,
} from "../quality-policy.js";

export interface ChatModelBindingV1 {
  model: BaseChatModel;
  modelId: string;
  qualityAdapter: ProviderQualityCapabilityAdapterV1;
  structuredOutput: "native" | "tool";
  /** Explicit provider-adapter grant; absent means no reasoning text may cross the host boundary. */
  reasoningPresentation?: "summary";
  /**
   * Provider-neutral role selection for bounded Chat children. The host owns
   * the preference; adapters may map it to effort, another model, or the same
   * model without changing the accepted workflow.
   */
  modelForPreference?: (
    preference: ProviderReasoningPreferenceV1,
  ) => BaseChatModel;
  /**
   * Optional provider-specific finalize-only binding. The final synthesizer
   * must preserve the already checked draft, not spend its output allowance
   * on another long reasoning pass.
   */
  modelForFinalization?: () => BaseChatModel;
  /** Reduce only provider-unsupported JSON Schema keywords; host validation remains strict. */
  projectResponseSchema?: (
    schema: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

export interface ChatModelFactoryInputV1 {
  credential: string;
  maxOutputTokens: number;
  qualityPolicy: ChatQualityPolicyV1;
}

export type ChatModelFactoryV1 = (
  input: ChatModelFactoryInputV1,
) => ChatModelBindingV1;
