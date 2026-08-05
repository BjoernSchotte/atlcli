import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ChatQualityPolicyV1,
  ProviderQualityCapabilityAdapterV1,
} from "../quality-policy.js";

export interface ChatModelBindingV1 {
  model: BaseChatModel;
  modelId: string;
  qualityAdapter: ProviderQualityCapabilityAdapterV1;
  structuredOutput: "native" | "tool";
}

export interface ChatModelFactoryInputV1 {
  credential: string;
  maxOutputTokens: number;
  qualityPolicy: ChatQualityPolicyV1;
}

export type ChatModelFactoryV1 = (
  input: ChatModelFactoryInputV1,
) => ChatModelBindingV1;
