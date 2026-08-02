import { ResearchContractError, type ResearchProduct } from "./contracts.js";

export const RESEARCH_RETRIEVAL_ASSESSMENT_SCHEMA_V1 =
  "atlcli.research-retrieval-assessment/v1" as const;

/**
 * The host's next retrieval action. These values deliberately express only
 * observable evidence and budget state; a model confidence score cannot
 * select a branch of the loop.
 */
export type ResearchRetrievalAssessmentActionV1 = "continue" | "replan" | "stop";

export type ResearchRetrievalAssessmentReasonV1 =
  | "unread_ranked_candidates"
  | "search_not_terminal"
  | "coverage_gap"
  | "unresolved_contradiction"
  | "capability_budget_exhausted"
  | "detail_budget_exhausted"
  | "search_budget_exhausted"
  | "marginal_evidence"
  | "no_ranked_candidates"
  | "ranked_candidates_exhausted";

const RETRIEVAL_ACTIONS_V1: readonly ResearchRetrievalAssessmentActionV1[] = [
  "continue",
  "replan",
  "stop",
];

const RETRIEVAL_REASONS_V1: readonly ResearchRetrievalAssessmentReasonV1[] = [
  "unread_ranked_candidates",
  "search_not_terminal",
  "coverage_gap",
  "unresolved_contradiction",
  "capability_budget_exhausted",
  "detail_budget_exhausted",
  "search_budget_exhausted",
  "marginal_evidence",
  "no_ranked_candidates",
  "ranked_candidates_exhausted",
];

export interface ResearchRetrievalProductAssessmentInputV1 {
  product: ResearchProduct;
  /** A host-issued ranked candidate can be read only through its opaque ref. */
  rankedSourceIds: string[];
  /** Successful detail reads in the current wave, potentially with repeats. */
  detailedSourceIds: string[];
  searchAttempted: boolean;
  searchComplete: boolean;
  canSearchMore: boolean;
  canReadMoreDetails: boolean;
}

export interface ResearchRetrievalAssessmentInputV1 {
  products: ResearchRetrievalProductAssessmentInputV1[];
  /** Sources already accepted before this retrieval wave. */
  priorAcceptedSourceIds?: string[];
  unresolvedCoverageTargetIds?: string[];
  unresolvedContradictionIds?: string[];
  ptcCallsRemaining: number;
  httpAttemptsRemaining: number;
}

export interface ResearchRetrievalProductAssessmentV1 {
  product: ResearchProduct;
  rankedCandidateCount: number;
  detailReadCount: number;
  uniqueDetailSourceCount: number;
  unreadRankedCandidateCount: number;
  searchAttempted: boolean;
  searchComplete: boolean;
  canSearchMore: boolean;
  canReadMoreDetails: boolean;
}

export interface ResearchRetrievalAssessmentV1 {
  schema: typeof RESEARCH_RETRIEVAL_ASSESSMENT_SCHEMA_V1;
  action: ResearchRetrievalAssessmentActionV1;
  reason: ResearchRetrievalAssessmentReasonV1;
  products: ResearchRetrievalProductAssessmentV1[];
  newDetailSourceCount: number;
  duplicateDetailReadCount: number;
  unresolvedCoverageTargetCount: number;
  unresolvedContradictionCount: number;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function sourceIds(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) =>
    typeof entry !== "string" || entry.length === 0 || entry.length > 256 || entry.includes("\u0000"),
  )) {
    invalid(`${label} is invalid.`);
  }
  return [...new Set(value)].sort();
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} is invalid.`);
  return value as number;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * Parse the persisted/session-crossing projection. The original assessment
 * contains only counts and enum decisions; this parser deliberately has no
 * slot for source IDs, search terms, URLs, or model-generated rationale.
 */
export function parseResearchRetrievalAssessmentV1(
  value: unknown,
): ResearchRetrievalAssessmentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Retrieval assessment is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, [
    "schema",
    "action",
    "reason",
    "products",
    "newDetailSourceCount",
    "duplicateDetailReadCount",
    "unresolvedCoverageTargetCount",
    "unresolvedContradictionCount",
  ]) ||
      record.schema !== RESEARCH_RETRIEVAL_ASSESSMENT_SCHEMA_V1 ||
      !RETRIEVAL_ACTIONS_V1.includes(record.action as ResearchRetrievalAssessmentActionV1) ||
      !RETRIEVAL_REASONS_V1.includes(record.reason as ResearchRetrievalAssessmentReasonV1) ||
      !Array.isArray(record.products) || record.products.length < 1 || record.products.length > 2) {
    invalid("Retrieval assessment is invalid.");
  }
  const seenProducts = new Set<ResearchProduct>();
  const products = record.products.map((value): ResearchRetrievalProductAssessmentV1 => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid("Retrieval assessment product is invalid.");
    }
    const product = value as Record<string, unknown>;
    if (!hasOnlyKeys(product, [
      "product",
      "rankedCandidateCount",
      "detailReadCount",
      "uniqueDetailSourceCount",
      "unreadRankedCandidateCount",
      "searchAttempted",
      "searchComplete",
      "canSearchMore",
      "canReadMoreDetails",
    ]) ||
        (product.product !== "jira" && product.product !== "confluence") ||
        seenProducts.has(product.product) ||
        typeof product.searchAttempted !== "boolean" ||
        typeof product.searchComplete !== "boolean" ||
        typeof product.canSearchMore !== "boolean" ||
        typeof product.canReadMoreDetails !== "boolean") {
      invalid("Retrieval assessment product is invalid.");
    }
    seenProducts.add(product.product);
    const rankedCandidateCount = nonNegative(product.rankedCandidateCount, "Retrieval ranked candidate count");
    const detailReadCount = nonNegative(product.detailReadCount, "Retrieval detail read count");
    const uniqueDetailSourceCount = nonNegative(product.uniqueDetailSourceCount, "Retrieval unique detail source count");
    const unreadRankedCandidateCount = nonNegative(product.unreadRankedCandidateCount, "Retrieval unread ranked candidate count");
    if ((!product.searchAttempted && product.searchComplete) ||
        uniqueDetailSourceCount > detailReadCount ||
        unreadRankedCandidateCount > rankedCandidateCount) {
      invalid("Retrieval assessment product counters are inconsistent.");
    }
    return {
      product: product.product,
      rankedCandidateCount,
      detailReadCount,
      uniqueDetailSourceCount,
      unreadRankedCandidateCount,
      searchAttempted: product.searchAttempted,
      searchComplete: product.searchComplete,
      canSearchMore: product.canSearchMore,
      canReadMoreDetails: product.canReadMoreDetails,
    };
  }).sort((left, right) => left.product.localeCompare(right.product));
  const expectedOrder = record.products.map((product) =>
    (product as { product: ResearchProduct }).product,
  ).join(",");
  if (products.map((product) => product.product).join(",") !== expectedOrder) {
    invalid("Retrieval assessment products are not canonical.");
  }
  const action = record.action as ResearchRetrievalAssessmentActionV1;
  const reason = record.reason as ResearchRetrievalAssessmentReasonV1;
  const expectedAction = reason === "unread_ranked_candidates" || reason === "search_not_terminal"
    ? "continue"
    : reason === "coverage_gap" || reason === "unresolved_contradiction"
      ? "replan"
      : "stop";
  if (action !== expectedAction) invalid("Retrieval assessment action and reason are inconsistent.");
  const newDetailSourceCount = nonNegative(record.newDetailSourceCount, "Retrieval new detail source count");
  const duplicateDetailReadCount = nonNegative(record.duplicateDetailReadCount, "Retrieval duplicate detail read count");
  const uniqueDetailSourceCount = products.reduce(
    (total, product) => total + product.uniqueDetailSourceCount,
    0,
  );
  const minimumDuplicateDetailReadCount = products.reduce(
    (total, product) => total + product.detailReadCount - product.uniqueDetailSourceCount,
    0,
  );
  const totalDetailReadCount = products.reduce(
    (total, product) => total + product.detailReadCount,
    0,
  );
  if (newDetailSourceCount > uniqueDetailSourceCount ||
      duplicateDetailReadCount < minimumDuplicateDetailReadCount ||
      duplicateDetailReadCount > totalDetailReadCount) {
    invalid("Retrieval assessment aggregate counters are inconsistent.");
  }
  return {
    schema: RESEARCH_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
    action,
    reason,
    products,
    newDetailSourceCount,
    duplicateDetailReadCount,
    unresolvedCoverageTargetCount: nonNegative(
      record.unresolvedCoverageTargetCount,
      "Retrieval unresolved coverage target count",
    ),
    unresolvedContradictionCount: nonNegative(
      record.unresolvedContradictionCount,
      "Retrieval unresolved contradiction count",
    ),
  };
}

/**
 * Derive the next safe retrieval decision from host-observed state. The
 * assessment itself cannot dispatch work or widen scope; a later supervisor
 * revision must still pass the graph, scope, and budget validators.
 */
export function assessResearchRetrievalV1(
  input: ResearchRetrievalAssessmentInputV1,
): ResearchRetrievalAssessmentV1 {
  if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 2) {
    invalid("Retrieval assessment products are invalid.");
  }
  const seenProducts = new Set<ResearchProduct>();
  const products = input.products.map((entry): ResearchRetrievalProductAssessmentV1 => {
    if (!entry || (entry.product !== "jira" && entry.product !== "confluence") || seenProducts.has(entry.product)) {
      invalid("Retrieval assessment product is invalid or duplicated.");
    }
    seenProducts.add(entry.product);
    if (typeof entry.searchAttempted !== "boolean" ||
        typeof entry.searchComplete !== "boolean" ||
        typeof entry.canSearchMore !== "boolean" ||
        typeof entry.canReadMoreDetails !== "boolean") {
      invalid("Retrieval assessment product state is invalid.");
    }
    if (!entry.searchAttempted && entry.searchComplete) {
      invalid("A retrieval search cannot be complete before it is attempted.");
    }
    const rankedSourceIds = sourceIds(entry.rankedSourceIds, "Retrieval ranked source IDs", 4_096);
    const detailedSourceIds = sourceIds(entry.detailedSourceIds, "Retrieval detailed source IDs", 4_096);
    const unreadRankedCandidateCount = rankedSourceIds.filter((sourceId) =>
      !detailedSourceIds.includes(sourceId),
    ).length;
    return {
      product: entry.product,
      rankedCandidateCount: rankedSourceIds.length,
      detailReadCount: entry.detailedSourceIds.length,
      uniqueDetailSourceCount: detailedSourceIds.length,
      unreadRankedCandidateCount,
      searchAttempted: entry.searchAttempted,
      searchComplete: entry.searchComplete,
      canSearchMore: entry.canSearchMore,
      canReadMoreDetails: entry.canReadMoreDetails,
    };
  }).sort((left, right) => left.product.localeCompare(right.product));

  const priorAcceptedSourceIds = new Set(
    sourceIds(input.priorAcceptedSourceIds ?? [], "Prior accepted source IDs", 8_192),
  );
  const allDetailedSourceIds = input.products.flatMap((entry) => entry.detailedSourceIds);
  const uniqueDetailedSourceIds = new Set(allDetailedSourceIds);
  const newDetailSourceCount = [...uniqueDetailedSourceIds].filter((sourceId) =>
    !priorAcceptedSourceIds.has(sourceId),
  ).length;
  const duplicateDetailReadCount = Math.max(0, allDetailedSourceIds.length - uniqueDetailedSourceIds.size);
  const unresolvedCoverageTargetIds = sourceIds(
    input.unresolvedCoverageTargetIds ?? [],
    "Unresolved coverage target IDs",
    64,
  );
  const unresolvedContradictionIds = sourceIds(
    input.unresolvedContradictionIds ?? [],
    "Unresolved contradiction IDs",
    64,
  );
  const ptcCallsRemaining = nonNegative(input.ptcCallsRemaining, "Remaining PTC calls");
  const httpAttemptsRemaining = nonNegative(input.httpAttemptsRemaining, "Remaining HTTP attempts");
  const unreadProducts = products.filter((product) => product.unreadRankedCandidateCount > 0);
  const incompleteProducts = products.filter((product) =>
    product.searchAttempted && !product.searchComplete,
  );
  const anyDetailRead = allDetailedSourceIds.length > 0;
  const resultBase = {
    schema: RESEARCH_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
    products,
    newDetailSourceCount,
    duplicateDetailReadCount,
    unresolvedCoverageTargetCount: unresolvedCoverageTargetIds.length,
    unresolvedContradictionCount: unresolvedContradictionIds.length,
  } as const;

  if (unreadProducts.length > 0) {
    if (ptcCallsRemaining < 1 || httpAttemptsRemaining < 1) {
      return { ...resultBase, action: "stop", reason: "capability_budget_exhausted" };
    }
    if (unreadProducts.every((product) => !product.canReadMoreDetails)) {
      return { ...resultBase, action: "stop", reason: "detail_budget_exhausted" };
    }
    return { ...resultBase, action: "continue", reason: "unread_ranked_candidates" };
  }

  if (incompleteProducts.length > 0) {
    if (ptcCallsRemaining >= 2 && httpAttemptsRemaining >= 1 &&
        incompleteProducts.some((product) => product.canSearchMore)) {
      return { ...resultBase, action: "continue", reason: "search_not_terminal" };
    }
    return {
      ...resultBase,
      action: "stop",
      reason: ptcCallsRemaining < 2 || httpAttemptsRemaining < 1
        ? "capability_budget_exhausted"
        : "search_budget_exhausted",
    };
  }

  if (anyDetailRead && newDetailSourceCount === 0) {
    return { ...resultBase, action: "stop", reason: "marginal_evidence" };
  }
  if (unresolvedContradictionIds.length > 0) {
    return { ...resultBase, action: "replan", reason: "unresolved_contradiction" };
  }
  if (unresolvedCoverageTargetIds.length > 0) {
    return { ...resultBase, action: "replan", reason: "coverage_gap" };
  }
  if (products.every((product) => product.rankedCandidateCount === 0)) {
    return { ...resultBase, action: "stop", reason: "no_ranked_candidates" };
  }
  return { ...resultBase, action: "stop", reason: "ranked_candidates_exhausted" };
}
