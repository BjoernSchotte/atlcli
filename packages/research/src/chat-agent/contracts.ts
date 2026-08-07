import { z } from "zod/v4";
import {
  ResearchContractError,
  type ResearchErrorCode,
  type ResearchLimitsV1,
  type ResearchProduct,
  type ResearchProvider,
  type ResearchRunCountsV1,
  type ResearchRunUsageV1,
  type ResearchScopeSeedV1,
  type ResearchScopeV1,
} from "../contracts.js";
import {
  CHAT_QUALITY_MODES_V1,
  normalizeChatQualityPolicyV1,
  type ChatQualityModeV1,
  type ChatQualityPolicyV1,
} from "../quality-policy.js";
import type {
  ChatStrategyCapabilityClassV1,
  ChatStrategyQualityRiskV1,
  ChatStrategyReasonCodeV1,
} from "./strategy.js";

export const CHAT_TURN_REQUEST_SCHEMA_V1 = "atlcli.chat-turn-request/v1" as const;
export const CHAT_ANSWER_SCHEMA_V1 = "atlcli.chat-answer/v1" as const;
export const CHAT_SESSION_STATE_SCHEMA_V1 = "atlcli.chat-session-state/v1" as const;
export const CHAT_SESSION_STATE_PATH_V1 = "/state/chat-session-v1.json" as const;

export type ChatStrategyPathV1 = "direct" | "agentic";

export interface ChatTurnRequestV1 {
  schema: typeof CHAT_TURN_REQUEST_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  question: string;
  scope: ResearchScopeV1;
  limits: ResearchLimitsV1;
  wikiProvider: ResearchProvider;
  scopeSeeds?: ResearchScopeSeedV1[];
  exactContextProducts?: ResearchProduct[];
  locale?: string;
}

export interface ChatCitationV1 {
  sourceId: string;
  title: string;
  url: string;
  product: ResearchProduct;
  /** Host-validated locator for a specifically read Confluence section. */
  section?: {
    sectionId: string;
    heading: string;
  };
}

export interface ChatAnswerGapV1 {
  code: "no-detail-evidence" | "truncated-source" | "unresolved-reference" | "incomplete-coverage";
  message: string;
  sourceIds: string[];
}

const CHAT_GAP_CODES_V1 = [
  "no-detail-evidence",
  "truncated-source",
  "unresolved-reference",
  "incomplete-coverage",
] as const;
type ChatGapCodeV1 = (typeof CHAT_GAP_CODES_V1)[number];

/** Provider wording is advisory; the host owns the compact durable taxonomy. */
export function normalizeChatGapCodeV1(value: string): ChatGapCodeV1 {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (CHAT_GAP_CODES_V1.includes(normalized as ChatGapCodeV1)) {
    return normalized as ChatGapCodeV1;
  }
  if (/truncat|clipp|source.?limit/iu.test(normalized)) return "truncated-source";
  if (/refer|link|mapping|relationship/iu.test(normalized)) return "unresolved-reference";
  if (/detail|evidence.?absent|no.?evidence/iu.test(normalized)) return "no-detail-evidence";
  // Search, retrieval, coverage, verification, and any other bounded provider
  // label are conservatively represented as incomplete coverage. The host
  // never lets a provider-created taxonomy weaken an evidence boundary.
  return "incomplete-coverage";
}

const CHAT_GAP_CODE_SCHEMA_V1 = z.string().min(1).max(64)
  .transform(normalizeChatGapCodeV1);

export interface ChatStrategyV1 {
  qualityMode: ChatQualityModeV1;
  path: ChatStrategyPathV1;
  delegated: boolean;
  reasonCode: "quick-direct" | "auto-direct" | "deep-direct" | "agentic-required";
  reasonCodes: ChatStrategyReasonCodeV1[];
  ambiguityDisposition: "none" | "ask-user";
  requiredCapabilities: ChatStrategyCapabilityClassV1[];
  expectedComplexity: "simple" | "moderate" | "complex";
  qualityRisks: ChatStrategyQualityRiskV1[];
}

export interface ChatContinuationOfferV1 {
  kind: "follow-up" | "deep-research" | "clarification";
  prompt: string;
}

export interface ChatRunSummaryV1 {
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  counts: ResearchRunCountsV1;
  usage?: ResearchRunUsageV1;
  retrieval?: {
    discoveredCandidates: number;
    admittedCandidates: number;
    detailReadCandidates: number;
    excludedCandidates: number;
    deferredCandidates: number;
    detailReadCoverage: number;
    canonicalUrlCorrectness: number;
    observedRecall: number | null;
    wrongSourceRate: number | null;
    atlassianHttpCalls: number;
    latencyMs: number;
  };
}

export interface ChatAnswerV1 {
  schema: typeof CHAT_ANSWER_SCHEMA_V1;
  messageMarkdown: string;
  citations: ChatCitationV1[];
  evidenceRefs: string[];
  gaps: ChatAnswerGapV1[];
  strategy: ChatStrategyV1;
  continuation?: ChatContinuationOfferV1;
  run: ChatRunSummaryV1;
}

export interface ChatSessionStateV1 {
  schema: typeof CHAT_SESSION_STATE_SCHEMA_V1;
  conversationId: string;
  qualityPolicy: ChatQualityPolicyV1;
}

export class ChatContractError extends ResearchContractError {
  constructor(code: ResearchErrorCode, message: string) {
    super(code, message);
    this.name = "ChatContractError";
  }
}

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

function normalizeString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\u0000")) {
    throw new ChatContractError("invalid-request", `${label} is invalid.`);
  }
  return normalized;
}

export function normalizeChatTurnRequestV1(value: ChatTurnRequestV1): ChatTurnRequestV1 {
  if (!value || value.schema !== CHAT_TURN_REQUEST_SCHEMA_V1) {
    throw new ChatContractError("invalid-request", "Chat turn request schema is invalid.");
  }
  const conversationId = normalizeString(value.conversationId, "Chat conversation ID", 200);
  const turnId = normalizeString(value.turnId, "Chat turn ID", 200);
  if (!CHAT_ID.test(conversationId) || !CHAT_ID.test(turnId)) {
    throw new ChatContractError("invalid-request", "Chat turn identity is invalid.");
  }
  const question = normalizeString(value.question, "Chat question", 2_000);
  if (!CHAT_QUALITY_MODES_V1.length) {
    throw new ChatContractError("invalid-request", "Chat quality modes are unavailable.");
  }
  return structuredClone({ ...value, conversationId, turnId, question });
}

export const CHAT_AGENT_DRAFT_TOOL_NAME_V1 = "ChatAnswerDraftV1" as const;

export const CHAT_AGENT_DRAFT_SCHEMA_V1 = z.object({
  messageMarkdown: z.string().min(1).max(24_000).describe(
    "Conversational Markdown. Every paragraph that states an evidence-derived fact must end on the same line with one or more exact [[source:SOURCE_ID]] placeholders copied from accepted dependency packets.",
  ),
  citationSourceIds: z.array(z.string().min(1).max(256)).max(100).describe(
    "Unique canonical SOURCE_ID values used by placeholders in messageMarkdown, without section suffixes.",
  ),
  gaps: z.array(z.object({
    code: CHAT_GAP_CODE_SCHEMA_V1,
    message: z.string().min(1).max(1_000),
    sourceIds: z.array(z.string().min(1).max(256)).max(100),
  }).strict()).max(50).describe(
    "An actual JSON array, never a JSON-encoded string. Each gap is an object with code, message, and a sourceIds array.",
  ),
  continuation: z.object({
    kind: z.enum(["follow-up", "deep-research", "clarification"]),
    prompt: z.string().min(1).max(1_000),
  }).strict().optional(),
}).strict().meta({ title: CHAT_AGENT_DRAFT_TOOL_NAME_V1 });

export type ChatAgentDraftV1 = z.infer<typeof CHAT_AGENT_DRAFT_SCHEMA_V1>;

export const CHAT_AGENT_DRAFT_JSON_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["messageMarkdown", "citationSourceIds", "gaps"],
  properties: {
    messageMarkdown: {
      type: "string",
      description: "Conversational Markdown. Every evidence-derived factual paragraph must end on the same line with one or more exact [[source:SOURCE_ID]] placeholders copied verbatim from accepted dependency packets. Example: The implementation is complete. [[source:jira:DEMO-1]]",
      minLength: 1,
      maxLength: 24_000,
    },
    citationSourceIds: {
      type: "array",
      description: "Unique canonical SOURCE_ID values used by placeholders in messageMarkdown, without section suffixes.",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    gaps: {
      type: "array",
      description: "An actual JSON array, never a JSON-encoded string. Each gap is an object with code, message, and a sourceIds array.",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "sourceIds"],
        properties: {
        code: { type: "string", minLength: 1, maxLength: 64 },
          message: { type: "string", minLength: 1, maxLength: 1_000 },
          sourceIds: {
            type: "array",
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    continuation: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "prompt"],
      properties: {
        kind: { enum: ["follow-up", "deep-research", "clarification"] },
        prompt: { type: "string", minLength: 1, maxLength: 1_000 },
      },
    },
  },
} as const;

const CHAT_PROVIDER_UNSUPPORTED_SCHEMA_KEYWORDS_V1 = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

/**
 * Provider adapters may expose a reduced JSON Schema; the stricter immutable
 * host contract remains authoritative after the model returns.
 */
export function providerCompatibleChatJsonSchemaV1(
  schema: Readonly<Record<string, unknown>>,
): {
  type: "object";
  [key: string]: unknown;
} {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !CHAT_PROVIDER_UNSUPPORTED_SCHEMA_KEYWORDS_V1.has(key))
        .map(([key, nested]) => [key, visit(nested)]),
    );
  };
  return visit(schema) as {
    type: "object";
    [key: string]: unknown;
  };
}

export function providerCompatibleChatAnswerSchemaV1(): {
  type: "object";
  [key: string]: unknown;
} {
  return providerCompatibleChatJsonSchemaV1(CHAT_AGENT_DRAFT_JSON_SCHEMA_V1);
}

export function createChatSessionStateV1(input: {
  conversationId: string;
  qualityPolicy: ChatQualityPolicyV1;
}): ChatSessionStateV1 {
  return {
    schema: CHAT_SESSION_STATE_SCHEMA_V1,
    conversationId: normalizeString(input.conversationId, "Chat conversation ID", 200),
    qualityPolicy: normalizeChatQualityPolicyV1(input.qualityPolicy),
  };
}
