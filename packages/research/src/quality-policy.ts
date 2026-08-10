import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResearchWorkspace } from "./workspace.js";

export const CHAT_QUALITY_STATE_PATH_V1 = "/state/chat-quality-v1.json" as const;

export const CHAT_QUALITY_MODES_V1 = ["quick", "auto", "deep"] as const;
export type ChatQualityModeV1 = (typeof CHAT_QUALITY_MODES_V1)[number];

export const PROVIDER_REASONING_PREFERENCES_V1 = [
  "fast",
  "balanced",
  "thorough",
] as const;
export type ProviderReasoningPreferenceV1 =
  (typeof PROVIDER_REASONING_PREFERENCES_V1)[number];

export interface ChatQualityPolicyV1 {
  mode: ChatQualityModeV1;
  delegation: "disabled" | "adaptive" | "strategy-required";
  completionTarget: "direct" | "sufficient-validated";
  planning: "none" | "automatic";
  scopeExpansion: "deny" | "ask";
  /** T8 sets measured defaults; an explicit host override remains optional now. */
  deadline?: {
    softDeadlineMs: number;
    hardDeadlineMs: number;
    finalizationReserveMs: number;
  };
  providerReasoningPreference: ProviderReasoningPreferenceV1;
}

export function chatQualityPolicyV1(mode: ChatQualityModeV1): ChatQualityPolicyV1 {
  switch (mode) {
    case "quick":
      return {
        mode,
        delegation: "disabled",
        completionTarget: "direct",
        planning: "none",
        scopeExpansion: "deny",
        providerReasoningPreference: "fast",
      };
    case "auto":
      return {
        mode,
        delegation: "adaptive",
        completionTarget: "sufficient-validated",
        planning: "automatic",
        scopeExpansion: "ask",
        providerReasoningPreference: "balanced",
      };
    case "deep":
      return {
        mode,
        delegation: "strategy-required",
        completionTarget: "sufficient-validated",
        planning: "automatic",
        scopeExpansion: "ask",
        providerReasoningPreference: "thorough",
      };
  }
}

const CHAT_QUALITY_POLICY_KEYS_V1 = new Set([
  "mode",
  "delegation",
  "completionTarget",
  "planning",
  "scopeExpansion",
  "deadline",
  "providerReasoningPreference",
]);

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isChatQualityDeadlineV1(
  value: unknown,
): value is NonNullable<ChatQualityPolicyV1["deadline"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !["softDeadlineMs", "hardDeadlineMs", "finalizationReserveMs"].every(
      (key) => Object.hasOwn(record, key),
    )
  ) {
    return false;
  }
  const soft = record.softDeadlineMs;
  const hard = record.hardDeadlineMs;
  const reserve = record.finalizationReserveMs;
  return isPositiveSafeInteger(soft) &&
    isPositiveSafeInteger(hard) &&
    isPositiveSafeInteger(reserve) &&
    soft < hard &&
    reserve < hard;
}

function isChatQualityPolicyV1(value: unknown): value is ChatQualityPolicyV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CHAT_QUALITY_POLICY_KEYS_V1.has(key))) {
    return false;
  }
  const candidate = value as Partial<ChatQualityPolicyV1>;
  if (!CHAT_QUALITY_MODES_V1.includes(candidate.mode as ChatQualityModeV1)) return false;
  const canonical = chatQualityPolicyV1(candidate.mode as ChatQualityModeV1);
  return candidate.delegation === canonical.delegation &&
    candidate.completionTarget === canonical.completionTarget &&
    candidate.planning === canonical.planning &&
    candidate.scopeExpansion === canonical.scopeExpansion &&
    PROVIDER_REASONING_PREFERENCES_V1.includes(
      candidate.providerReasoningPreference as ProviderReasoningPreferenceV1,
    ) &&
    (candidate.deadline === undefined || isChatQualityDeadlineV1(candidate.deadline));
}

export function normalizeChatQualityPolicyV1(value: unknown): ChatQualityPolicyV1 {
  if (!isChatQualityPolicyV1(value)) {
    throw new Error("Chat quality policy is invalid.");
  }
  return structuredClone(value);
}

/**
 * Compatibility is intentionally restricted to durable state decoding. New
 * public callers must provide the canonical quality contract.
 */
export function decodeStoredChatQualityPolicyV1(value: unknown): ChatQualityPolicyV1 {
  if (isChatQualityPolicyV1(value)) return structuredClone(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const legacy = (value as { requestedEffort?: unknown }).requestedEffort;
    if (legacy === "lookup") return chatQualityPolicyV1("quick");
    if (legacy === "deep" || legacy === "analysis") return chatQualityPolicyV1("deep");
    if (legacy === "auto") return chatQualityPolicyV1("auto");
  }
  throw new Error("Stored chat quality policy is invalid.");
}

export async function persistChatQualityPolicyV1(
  workspace: ResearchWorkspace,
  policy: ChatQualityPolicyV1,
): Promise<void> {
  await workspace.writeFile(
    CHAT_QUALITY_STATE_PATH_V1,
    JSON.stringify(normalizeChatQualityPolicyV1(policy)),
  );
}

export async function readStoredChatQualityPolicyV1(
  workspace: ResearchWorkspace,
): Promise<ChatQualityPolicyV1 | undefined> {
  const contents = await workspace.readFile(CHAT_QUALITY_STATE_PATH_V1);
  if (contents === undefined) return undefined;
  return decodeStoredChatQualityPolicyV1(JSON.parse(contents));
}

export interface ProviderReasoningControlsV1 {
  effort?: "low" | "medium" | "high";
  adaptiveThinking?: boolean;
}

export interface ProviderQualityCapabilityAdapterV1 {
  readonly providerId: string;
  reasoningControls(
    preference: ProviderReasoningPreferenceV1,
  ): ProviderReasoningControlsV1 | undefined;
  promptCache?: {
    readonly enabled: boolean;
    readonly ttl: "5m" | "1h";
  };
}

export const CAPABILITY_FREE_QUALITY_ADAPTER_V1: ProviderQualityCapabilityAdapterV1 = {
  providerId: "capability-free",
  reasoningControls: () => undefined,
};

export const ANTHROPIC_QUALITY_ADAPTER_V1: ProviderQualityCapabilityAdapterV1 = {
  providerId: "anthropic",
  reasoningControls(preference) {
    switch (preference) {
      case "fast":
        return { effort: "low", adaptiveThinking: false };
      case "balanced":
        return { effort: "medium", adaptiveThinking: true };
      case "thorough":
        return { effort: "high", adaptiveThinking: true };
    }
  },
  promptCache: { enabled: true, ttl: "5m" },
};

export interface ResolvedProviderQualityV1 {
  /** Workflow semantics are copied unchanged regardless of provider support. */
  workflow: ChatQualityPolicyV1;
  controls?: ProviderReasoningControlsV1;
}

export function resolveProviderQualityV1(
  policy: ChatQualityPolicyV1,
  adapter: ProviderQualityCapabilityAdapterV1,
): ResolvedProviderQualityV1 {
  const normalized = normalizeChatQualityPolicyV1(policy);
  const controls = adapter.reasoningControls(
    normalized.providerReasoningPreference,
  );
  return {
    workflow: normalized,
    ...(controls ? { controls } : {}),
  };
}

export const RESEARCH_MODEL_PROFILE_IDS_V1 = [
  "fast-reader",
  "strong-reasoner",
] as const;
export type ResearchModelProfileIdV1 =
  (typeof RESEARCH_MODEL_PROFILE_IDS_V1)[number];

export interface ResearchRoleModelProfileV1 {
  profile: ResearchModelProfileIdV1;
  reasoning: ProviderReasoningPreferenceV1;
}

export const RESEARCH_ROLE_MODEL_PROFILES_V1 = {
  "focused-researcher": { profile: "fast-reader", reasoning: "fast" },
  "document-distiller": { profile: "fast-reader", reasoning: "fast" },
  "contradiction-verifier": { profile: "strong-reasoner", reasoning: "thorough" },
  "coverage-moderator": { profile: "strong-reasoner", reasoning: "thorough" },
  "outline-planner": { profile: "strong-reasoner", reasoning: "balanced" },
  reconciler: { profile: "strong-reasoner", reasoning: "thorough" },
  // The synthesizer selects accepted Claim IDs after outline, coverage, and
  // critique. The host renders the report, so balanced reasoning preserves
  // editorial quality without reopening a second deep-analysis pass.
  synthesizer: { profile: "strong-reasoner", reasoning: "balanced" },
} as const satisfies Record<string, ResearchRoleModelProfileV1>;

export function resolveResearchRoleModelV1(
  role: keyof typeof RESEARCH_ROLE_MODEL_PROFILES_V1,
  defaultModel: BaseChatModel,
  configured: Partial<Record<ResearchModelProfileIdV1, BaseChatModel>> = {},
): BaseChatModel {
  return configured[RESEARCH_ROLE_MODEL_PROFILES_V1[role].profile] ?? defaultModel;
}

export interface PromptCacheSegmentsV1 {
  stable: readonly string[];
  private: readonly string[];
}

export interface PromptCacheContentBlockV1 {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  [key: string]: unknown;
}

/**
 * Projects the final provider system content after DeepAgents has assembled
 * its static prompt. Whitespace-only separator blocks are removed because
 * Anthropic rejects them. The cache marker is placed before any private
 * per-turn suffix, so questions, evidence, credentials, and steering never
 * enter the cached prefix.
 */
export function projectPromptCacheSystemContentV1(input: {
  existingContent: unknown;
  privateSegments: readonly string[];
  cacheStablePrefix: boolean;
  ttl?: "5m" | "1h";
}): PromptCacheContentBlockV1[] {
  const existing = typeof input.existingContent === "string"
    ? [{ type: "text", text: input.existingContent }]
    : Array.isArray(input.existingContent)
      ? input.existingContent.filter(
          (value): value is PromptCacheContentBlockV1 =>
            Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
            "type" in value && typeof value.type === "string",
        )
      : [];
  const stable = existing
    .filter((block) => !(block.type === "text" && (block.text ?? "").trim().length === 0))
    .map((block) => {
      const sanitized = { ...block };
      delete sanitized.cache_control;
      return sanitized;
    });
  if (input.cacheStablePrefix && stable.length > 0) {
    stable[stable.length - 1] = {
      ...stable[stable.length - 1],
      cache_control: { type: "ephemeral", ttl: input.ttl ?? "5m" },
    };
  }
  return [
    ...stable,
    ...input.privateSegments
      .filter((value) => value.trim().length > 0)
      .map((text) => ({ type: "text", text })),
  ];
}

/**
 * Builds an auditable cache boundary. Only host-authored versioned material may
 * enter the stable prefix. Per-turn or tenant material is always private.
 */
export function createPromptCacheSegmentsV1(input: {
  supervisorPrompt: string;
  toolSchemas: readonly string[];
  responseSchemas: readonly string[];
  userInput?: string;
  evidenceBodies?: readonly string[];
  credentials?: readonly string[];
  steeringRevisions?: readonly string[];
}): PromptCacheSegmentsV1 {
  return {
    stable: [input.supervisorPrompt, ...input.toolSchemas, ...input.responseSchemas]
      .filter((value) => value.trim().length > 0),
    private: [
      ...(input.userInput === undefined ? [] : [input.userInput]),
      ...(input.evidenceBodies ?? []),
      ...(input.credentials ?? []),
      ...(input.steeringRevisions ?? []),
    ].filter((value) => value.trim().length > 0),
  };
}
