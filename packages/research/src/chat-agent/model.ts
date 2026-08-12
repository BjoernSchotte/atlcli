import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ChatQualityPolicyV1,
  ProviderQualityCapabilityAdapterV1,
  ProviderReasoningPreferenceV1,
} from "../quality-policy.js";

export type ChatModelRouteRoleV1 =
  | "root-planning"
  | "extraction"
  | "analysis"
  | "drafting"
  | "critique"
  | "repair"
  | "synthesis";

export type ChatModelThinkingModeV1 =
  | "provider-default"
  | "disabled"
  | "adaptive-summary";

export type ChatModelFinalizationCorridorV1 = "standard" | "finalize-only";

export interface ChatModelRouteRequestV1 {
  role: ChatModelRouteRoleV1;
  preference: ProviderReasoningPreferenceV1;
  /** Optional bounded-agent identity for profile-aware local or test adapters. */
  profileId?: string;
}

/**
 * Provider-neutral result of a host-owned role route. The selected model may
 * be the binding's only model; metadata remains explicit so telemetry never
 * confuses the requested quality preference with the effective provider path.
 */
export interface ChatModelRouteV1 {
  model: BaseChatModel;
  effectiveModelId: string;
  requestedPreference: ProviderReasoningPreferenceV1;
  effectivePreference: ProviderReasoningPreferenceV1;
  thinkingMode: ChatModelThinkingModeV1;
  finalizationCorridor: ChatModelFinalizationCorridorV1;
}

/**
 * Provider-owned projection of a still-unvalidated structured answer. The host
 * may present it provisionally, but only the normal structured-output path can
 * accept it as the turn result.
 */
export interface ChatStructuredAnswerPreviewV1 {
  generationId: string;
  status: "snapshot" | "completed";
  markdown: string;
}

export interface ChatModelBindingV1 {
  model: BaseChatModel;
  modelId: string;
  qualityAdapter: ProviderQualityCapabilityAdapterV1;
  structuredOutput: "native" | "tool";
  /** Explicit provider-adapter grant; absent means no reasoning text may cross the host boundary. */
  reasoningPresentation?: "summary";
  /** Optional out-of-band preview for providers whose native tool grammar is not JSON. */
  subscribeStructuredAnswerPreview?: (
    listener: (preview: ChatStructuredAnswerPreviewV1) => void,
  ) => () => void;
  /** Provider-granted prompt-cache control; absent keeps the portable no-cache path. */
  promptCache?: {
    ttl: "5m" | "1h";
  };
  /**
   * Optional DeepAgentsJS harness tuning selected by the provider adapter.
   * The host registers it before constructing root or child agents; it never
   * changes model selection or grants capabilities.
   */
  harnessProfile?: {
    key: string;
    profile: Parameters<
      typeof import("deepagents/browser").registerHarnessProfile
    >[1];
  };
  /** Per-invocation controls for constrained runtimes, not usage quotas. */
  runtimeLimits?: {
    maxInputTokens?: number;
    interpreterResultChars?: number;
  };
  /**
   * Explicit role-to-capability route. It may return the same model for every
   * role; routing metadata cannot grant tools, scope, or workflow authority.
   */
  modelForRoute?: (request: ChatModelRouteRequestV1) => ChatModelRouteV1;
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
  ) => {
    type: "object";
    [key: string]: unknown;
  };
}

export function resolveChatModelRouteV1(
  binding: ChatModelBindingV1,
  request: ChatModelRouteRequestV1,
): ChatModelRouteV1 {
  const routed = binding.modelForRoute?.(request);
  if (routed) return routed;
  const finalizeOnly = ["drafting", "repair", "synthesis"].includes(request.role) &&
    binding.modelForFinalization !== undefined;
  const model = finalizeOnly
    ? binding.modelForFinalization!()
    : binding.modelForPreference?.(request.preference) ?? binding.model;
  return {
    model,
    effectiveModelId: binding.modelId,
    requestedPreference: request.preference,
    effectivePreference: finalizeOnly ? "fast" : request.preference,
    thinkingMode: "provider-default",
    finalizationCorridor: finalizeOnly ? "finalize-only" : "standard",
  };
}

export interface ChatModelFactoryInputV1 {
  credential: string;
  maxOutputTokens: number;
  qualityPolicy: ChatQualityPolicyV1;
}

export type ChatModelFactoryV1 = (
  input: ChatModelFactoryInputV1,
) => ChatModelBindingV1;
