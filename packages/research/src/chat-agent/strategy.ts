import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { ResearchRunBudget } from "../budget.js";
import type { ResearchDetailEvidenceV1 } from "../broker.js";
import type { BoundEntityAnchorV1 } from "../capability-contracts.js";
import type { ResearchScopeV1 } from "../contracts.js";
import type {
  ChatQualityModeV1,
  ChatQualityPolicyV1,
} from "../quality-policy.js";
import { ChatContractError } from "./contracts.js";

export const CHAT_STRATEGY_DECISION_SCHEMA_V1 =
  "atlcli.chat-strategy-decision/v1" as const;
export const CHAT_STRATEGY_RECORD_SCHEMA_V1 =
  "atlcli.chat-strategy-record/v1" as const;
export const CHAT_STRATEGY_STATE_PATH_V1 =
  "/state/chat-strategy-v1.json" as const;
export const CHAT_STRATEGY_REVIEW_SCHEMA_V1 =
  "atlcli.chat-strategy-review/v1" as const;
export const CHAT_STRATEGY_REVIEW_RECORD_SCHEMA_V1 =
  "atlcli.chat-strategy-review-record/v1" as const;
export const CHAT_STRATEGY_REVIEW_STATE_PATH_V1 =
  "/state/chat-strategy-review-v1.json" as const;

export const CHAT_STRATEGY_REASON_CODES_V1 = [
  "quick-direct",
  "single-exact-context",
  "no-atlassian-acquisition",
  "multi-anchor",
  "broad-scope-discovery",
  "multi-source-comparison",
  "cross-product-relationship",
  "contradiction-risk",
  "unresolved-ambiguity",
] as const;
export type ChatStrategyReasonCodeV1 =
  (typeof CHAT_STRATEGY_REASON_CODES_V1)[number];

export const CHAT_STRATEGY_CAPABILITY_CLASSES_V1 = [
  "exact-read",
  "jira-discovery",
  "confluence-discovery",
  "relationship-tracing",
  "comparison-analysis",
  "contradiction-check",
  "quality-review",
  "chat-answer",
] as const;
export type ChatStrategyCapabilityClassV1 =
  (typeof CHAT_STRATEGY_CAPABILITY_CLASSES_V1)[number];

export const CHAT_STRATEGY_QUALITY_RISKS_V1 = [
  "multiple-sources",
  "cross-product",
  "contradictory-evidence",
  "broad-discovery",
  "scope-ambiguity",
] as const;
export type ChatStrategyQualityRiskV1 =
  (typeof CHAT_STRATEGY_QUALITY_RISKS_V1)[number];

export interface ChatStrategyDecisionV1 {
  schema: typeof CHAT_STRATEGY_DECISION_SCHEMA_V1;
  qualityMode: ChatQualityModeV1;
  execution: "direct" | "agentic";
  reasonCodes: ChatStrategyReasonCodeV1[];
  ambiguityDisposition: "none" | "ask-user";
  requiredCapabilities: ChatStrategyCapabilityClassV1[];
  expectedComplexity: "simple" | "moderate" | "complex";
  qualityRisks: ChatStrategyQualityRiskV1[];
}

export interface ChatStrategyRecordV1 {
  schema: typeof CHAT_STRATEGY_RECORD_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  acceptedAt: string;
  decision: ChatStrategyDecisionV1;
}

export interface ChatStrategyReviewV1 {
  schema: typeof CHAT_STRATEGY_REVIEW_SCHEMA_V1;
  execution: "agentic";
  detailedSourceIds: string[];
  detailedProducts: Array<"jira" | "confluence">;
  unmetCapabilityClasses: ChatStrategyCapabilityClassV1[];
  readyForAnswer: boolean;
}

export interface ChatStrategyReviewRecordV1 {
  schema: typeof CHAT_STRATEGY_REVIEW_RECORD_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  reviewedAt: string;
  review: ChatStrategyReviewV1;
}

const COMPARISON_INTENT_V1 =
  /\b(?:compare|comparison|contrast|difference|different|versus|vs\.?|vergleich(?:e|en)?|unterschied(?:e|en)?|gegenüberstellen)\b/iu;
const RELATIONSHIP_INTENT_V1 =
  /\b(?:relationship|related|relate|linked?|links?|correspond|mapping|beziehung(?:en)?|zusammenhang|verknüpf(?:t|ung|ungen)|zugehörig|abbildung)\b/iu;
const CONTRADICTION_INTENT_V1 =
  /\b(?:contradict(?:ion|ions|ory|s|ed)?|conflict|disagree|inconsisten\w*|which is current|source of truth|widerspr(?:ech\w*|üch\w*)?|konflikt\w*|uneinig|inkonsisten\w*|welche.*aktuell|maßgeblich)\b/iu;

function orderedUnique<T extends string>(
  values: readonly T[],
  order: readonly T[],
): T[] {
  const present = new Set(values);
  return order.filter((value) => present.has(value));
}

/**
 * Host-owned Chat strategy policy. Provider reasoning controls and model text
 * are intentionally absent, so neither can enable delegation or widen scope.
 */
export function deriveChatStrategyDecisionV1(input: {
  qualityPolicy: ChatQualityPolicyV1;
  question: string;
  scope: ResearchScopeV1;
  anchors: readonly BoundEntityAnchorV1[];
  unresolvedAmbiguity?: boolean;
}): ChatStrategyDecisionV1 {
  const comparison = COMPARISON_INTENT_V1.test(input.question);
  const relationship = RELATIONSHIP_INTENT_V1.test(input.question);
  const contradiction = CONTRADICTION_INTENT_V1.test(input.question);
  const anchorProducts = new Set(input.anchors.map((anchor) => anchor.product));
  const scopeProducts = new Set([
    ...(input.scope.jiraProjectKeys.length > 0 ? ["jira" as const] : []),
    ...(input.scope.confluenceSpaceKeys.length > 0 ? ["confluence" as const] : []),
  ]);
  const crossProduct = anchorProducts.size > 1 || scopeProducts.size > 1;
  const multiAnchor = input.anchors.length > 1;
  const broadDiscovery = input.anchors.length === 0 && scopeProducts.size > 0;
  const noAcquisition = input.anchors.length === 0 && scopeProducts.size === 0;
  const unresolvedAmbiguity = input.unresolvedAmbiguity === true;

  const reasons: ChatStrategyReasonCodeV1[] = [];
  if (input.qualityPolicy.mode === "quick") reasons.push("quick-direct");
  if (input.anchors.length === 1 && !comparison && !relationship && !contradiction) {
    reasons.push("single-exact-context");
  }
  if (noAcquisition) reasons.push("no-atlassian-acquisition");
  if (multiAnchor) reasons.push("multi-anchor");
  if (broadDiscovery) reasons.push("broad-scope-discovery");
  if (comparison) reasons.push("multi-source-comparison");
  if (relationship || crossProduct) reasons.push("cross-product-relationship");
  if (contradiction) reasons.push("contradiction-risk");
  if (unresolvedAmbiguity) reasons.push("unresolved-ambiguity");

  const risks: ChatStrategyQualityRiskV1[] = [];
  if (multiAnchor || comparison) risks.push("multiple-sources");
  if (relationship || crossProduct) risks.push("cross-product");
  if (contradiction) risks.push("contradictory-evidence");
  if (broadDiscovery) risks.push("broad-discovery");
  if (unresolvedAmbiguity) risks.push("scope-ambiguity");

  const complex = comparison || relationship || contradiction || crossProduct;
  const moderate = multiAnchor || broadDiscovery;
  const execution = input.qualityPolicy.mode === "quick" || (!complex && !moderate)
    ? "direct"
    : "agentic";

  const capabilities: ChatStrategyCapabilityClassV1[] = [];
  if (input.anchors.length > 0) capabilities.push("exact-read");
  if (input.scope.jiraProjectKeys.length > 0 || relationship) {
    capabilities.push("jira-discovery");
  }
  if (input.scope.confluenceSpaceKeys.length > 0 || input.anchors.some((anchor) => anchor.product === "confluence")) {
    capabilities.push("confluence-discovery");
  }
  if (relationship || crossProduct) capabilities.push("relationship-tracing");
  if (comparison) capabilities.push("comparison-analysis");
  if (contradiction) capabilities.push("contradiction-check");
  if (execution === "agentic") capabilities.push("quality-review");
  capabilities.push("chat-answer");

  return {
    schema: CHAT_STRATEGY_DECISION_SCHEMA_V1,
    qualityMode: input.qualityPolicy.mode,
    execution,
    reasonCodes: orderedUnique(reasons, CHAT_STRATEGY_REASON_CODES_V1),
    ambiguityDisposition: unresolvedAmbiguity ? "ask-user" : "none",
    requiredCapabilities: orderedUnique(
      capabilities,
      CHAT_STRATEGY_CAPABILITY_CLASSES_V1,
    ),
    expectedComplexity: complex ? "complex" : moderate ? "moderate" : "simple",
    qualityRisks: orderedUnique(risks, CHAT_STRATEGY_QUALITY_RISKS_V1),
  };
}

export function createChatStrategyDecisionControllerV1(input: {
  decision: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  onAcknowledged?: (decision: ChatStrategyDecisionV1) => void | Promise<void>;
}): {
  tool: DynamicStructuredTool;
  acknowledgedDecision(): ChatStrategyDecisionV1 | undefined;
  assertAcknowledged(): void;
} {
  let acknowledged: ChatStrategyDecisionV1 | undefined;
  let acknowledging = false;
  const strategyTool = tool(async () => {
    if (acknowledged || acknowledging) {
      throw new ChatContractError(
        "invalid-request",
        "The accepted Chat strategy decision has already been acknowledged for this turn.",
      );
    }
    if (input.decision.ambiguityDisposition !== "none") {
      throw new ChatContractError(
        "clarification-required",
        "Material Chat scope ambiguity must be resolved before model or content work.",
      );
    }
    acknowledging = true;
    try {
      input.budget.beginPtc({ schema: CHAT_STRATEGY_DECISION_SCHEMA_V1 });
      const candidate = structuredClone(input.decision);
      input.budget.completePtc(candidate);
      await input.onAcknowledged?.(structuredClone(candidate));
      acknowledged = candidate;
      return JSON.stringify(candidate);
    } finally {
      acknowledging = false;
    }
  }, {
    name: "chat_strategy_decide",
    description:
      "Accept the host-derived direct or agentic Chat strategy exactly once before any Atlassian content capability. Takes an empty object and returns the bounded strategy decision.",
    schema: z.object({}).strict(),
  });
  return {
    tool: strategyTool,
    acknowledgedDecision: () => acknowledged
      ? structuredClone(acknowledged)
      : undefined,
    assertAcknowledged() {
      if (!acknowledged) {
        throw new ChatContractError(
          "invalid-request",
          "The accepted Chat strategy decision must be acknowledged before Atlassian content work.",
        );
      }
    },
  };
}

export function assessChatStrategyReviewV1(input: {
  decision: ChatStrategyDecisionV1;
  detailEvidence: readonly ResearchDetailEvidenceV1[];
}): ChatStrategyReviewV1 {
  if (input.decision.execution !== "agentic") {
    throw new ChatContractError(
      "invalid-request",
      "A Chat strategy review is available only for an accepted agentic trajectory.",
    );
  }
  const sourceIds = [...new Set(input.detailEvidence.map((entry) => entry.source.id))]
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const products = [...new Set(input.detailEvidence.map((entry) => entry.source.product))]
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const unmet: ChatStrategyCapabilityClassV1[] = [];
  const required = new Set(input.decision.requiredCapabilities);
  if (required.has("jira-discovery") && !products.includes("jira")) {
    unmet.push("jira-discovery");
  }
  if (required.has("confluence-discovery") && !products.includes("confluence")) {
    unmet.push("confluence-discovery");
  }
  if (
    required.has("relationship-tracing") &&
    required.has("jira-discovery") &&
    required.has("confluence-discovery") &&
    products.length < 2
  ) {
    unmet.push("relationship-tracing");
  }
  if (required.has("comparison-analysis") && sourceIds.length < 2) {
    unmet.push("comparison-analysis");
  }
  if (required.has("contradiction-check") && sourceIds.length < 2) {
    unmet.push("contradiction-check");
  }
  return {
    schema: CHAT_STRATEGY_REVIEW_SCHEMA_V1,
    execution: "agentic",
    detailedSourceIds: sourceIds,
    detailedProducts: products,
    unmetCapabilityClasses: orderedUnique(
      unmet,
      CHAT_STRATEGY_CAPABILITY_CLASSES_V1,
    ),
    readyForAnswer: unmet.length === 0,
  };
}

export function createChatStrategyReviewControllerV1(input: {
  decision: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  detailEvidence: () => readonly ResearchDetailEvidenceV1[];
  beforeReview?: () => void;
  onReviewed?: (review: ChatStrategyReviewV1) => void | Promise<void>;
}): {
  tool: DynamicStructuredTool;
  latestReview(): ChatStrategyReviewV1 | undefined;
  assertCurrent(): void;
} {
  let latest: ChatStrategyReviewV1 | undefined;
  let reviewing = false;
  let attempts = 0;
  const reviewTool = tool(async () => {
    if (reviewing || attempts >= 2) {
      throw new ChatContractError(
        "limit-exceeded",
        "The bounded Chat strategy review limit has been reached.",
      );
    }
    reviewing = true;
    try {
      input.beforeReview?.();
      input.budget.beginPtc({ schema: CHAT_STRATEGY_REVIEW_SCHEMA_V1 });
      const review = assessChatStrategyReviewV1({
        decision: input.decision,
        detailEvidence: input.detailEvidence(),
      });
      input.budget.completePtc(review);
      await input.onReviewed?.(structuredClone(review));
      latest = review;
      attempts += 1;
      return JSON.stringify(review);
    } finally {
      reviewing = false;
    }
  }, {
    name: "chat_strategy_review",
    description:
      "Perform the bounded host-owned final evidence-gap review for an accepted agentic Chat trajectory. Call after acquisition and again only when the first review identified a repairable gap and more detail evidence was acquired.",
    schema: z.object({}).strict(),
  });
  return {
    tool: reviewTool,
    latestReview: () => latest ? structuredClone(latest) : undefined,
    assertCurrent() {
      if (!latest) {
        throw new ChatContractError(
          "invalid-report",
          "An agentic Chat answer requires a completed host evidence-gap review.",
        );
      }
      const currentSourceIds = [...new Set(input.detailEvidence().map((entry) => entry.source.id))]
        .sort((left, right) => left.localeCompare(right, "en-US"));
      if (JSON.stringify(currentSourceIds) !== JSON.stringify(latest.detailedSourceIds)) {
        throw new ChatContractError(
          "invalid-report",
          "The agentic Chat evidence changed after its final evidence-gap review.",
        );
      }
    },
  };
}
