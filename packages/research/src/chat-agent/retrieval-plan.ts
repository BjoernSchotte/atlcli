import type {
  BoundEntityAnchorV1,
  BoundEntityReadOutputV1,
  BoundEntitySectionReadOutputV1,
  ResearchCandidateRankOutputV1,
  ResearchBudgetSnapshotV1,
  ResearchGetOutputV1,
  ResearchSearchOutputV1,
} from "../capability-contracts.js";
import type { ResearchRelatedScopeCandidateV1 } from "../broker.js";
import {
  ResearchContractError,
  type ResearchLimitsV1,
  type ResearchProduct,
  type ResearchScopeBindingV1,
} from "../contracts.js";
import type { ResearchGraphCapabilityV1 } from "../graph.js";
import type { ResearchWorkspace } from "../workspace.js";
import { z } from "zod/v4";

export const CHAT_RETRIEVAL_PLAN_SCHEMA_V1 =
  "atlcli.chat-retrieval-plan/v1" as const;
export const CHAT_CANDIDATE_LEDGER_SCHEMA_V1 =
  "atlcli.chat-candidate-ledger/v1" as const;
export const CHAT_RETRIEVAL_ASSESSMENT_SCHEMA_V1 =
  "atlcli.chat-retrieval-assessment/v1" as const;
export const CHAT_RETRIEVAL_PLAN_PATH_V1 =
  "/.atlcli/chat/v1/retrieval-plan.json" as const;
export const CHAT_CANDIDATE_LEDGER_PATH_V1 =
  "/.atlcli/chat/v1/candidate-ledger.json" as const;
export const CHAT_RETRIEVAL_ASSESSMENT_PATH_V1 =
  "/.atlcli/chat/v1/retrieval-assessment.json" as const;

export type ChatRelationshipTraversalKindV1 =
  | "confluence-to-jira-reference"
  | "jira-to-confluence-remote-link";

export type ChatRetrievalCompletionSignalV1 =
  | "all-anchors-read"
  | "all-searches-terminal"
  | "all-admitted-candidates-terminal"
  | "relationship-traversals-checked"
  | "detail-evidence-present"
  | "query-variants-saturated";

export interface ChatSearchQueryV1 {
  text?: string;
  labels?: string[];
  ancestorId?: string;
  parentId?: string;
}

export interface ChatSearchVariantProposalV1 {
  variantId: string;
  query: ChatSearchQueryV1;
  expectedInformationGain?: "high" | "medium" | "low";
}

export interface ChatRetrievalSearchProposalV1 {
  searchId: string;
  product: ResearchProduct;
  variants: ChatSearchVariantProposalV1[];
  maxPages: number;
}

export interface ChatRelationshipTraversalProposalV1 {
  traversalId: string;
  kind: ChatRelationshipTraversalKindV1;
  maxDepth: 1;
}

export interface ChatRetrievalPlanProposalV1 {
  searches?: ChatRetrievalSearchProposalV1[];
  relationshipTraversals?: ChatRelationshipTraversalProposalV1[];
  unresolvedTerms?: string[];
}

const chatSearchQueryProposalSchemaV1 = z.object({
  text: z.string().min(1).max(500).optional(),
  labels: z.array(z.string().min(1).max(255)).min(1).max(8).optional(),
  ancestorId: z.string().min(1).max(128).optional(),
  parentId: z.string().min(1).max(128).optional(),
}).strict();

export const CHAT_RETRIEVAL_PLAN_PROPOSAL_SCHEMA_V1 = z.object({
  searches: z.array(z.object({
    searchId: z.string().min(1).max(120),
    product: z.enum(["jira", "confluence"]),
    variants: z.array(z.object({
      variantId: z.string().min(1).max(120),
      query: chatSearchQueryProposalSchemaV1,
      expectedInformationGain: z.enum(["high", "medium", "low"]).optional(),
    }).strict()).min(1).max(5),
    maxPages: z.number().int().min(1).max(100),
  }).strict()).max(2).optional(),
  relationshipTraversals: z.array(z.object({
    traversalId: z.string().min(1).max(120),
    kind: z.enum([
      "confluence-to-jira-reference",
      "jira-to-confluence-remote-link",
    ]),
    maxDepth: z.literal(1),
  }).strict()).max(2).optional(),
  unresolvedTerms: z.array(z.string().min(1).max(160)).max(20).optional(),
}).strict();

export interface ChatRetrievalAnchorV1 {
  anchorRef: string;
  product: ResearchProduct;
  entityKind: "issue" | "page";
  name: string;
}

export interface ChatResolvedRetrievalEntityV1 {
  bindingId: string;
  product: ResearchProduct;
  entityKind: "issue" | "page" | "project" | "space";
  authority: "approved" | "locked" | "resolved";
  key?: string;
  name: string;
}

export interface ChatRetrievalSearchV1 extends ChatRetrievalSearchProposalV1 {
  scopeBindingIds: string[];
}

export interface ChatRetrievalBudgetReservationsV1 {
  supervisorCalls: number;
  directReadCalls: number;
  discoveryCalls: number;
  detailCallsByProduct: Record<ResearchProduct, number>;
  relationshipTraversalCalls: number;
  repairCalls: number;
  criticCalls: number;
  synthesisCalls: 1;
  totalCalls: number;
}

export interface ChatRetrievalPlanV1 {
  schema: typeof CHAT_RETRIEVAL_PLAN_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  createdAt: string;
  questionFingerprint: string;
  anchors: ChatRetrievalAnchorV1[];
  resolvedEntities: ChatResolvedRetrievalEntityV1[];
  searches: ChatRetrievalSearchV1[];
  relationshipTraversals: ChatRelationshipTraversalProposalV1[];
  unresolvedTerms: string[];
  completionSignals: ChatRetrievalCompletionSignalV1[];
  budgetReservations: ChatRetrievalBudgetReservationsV1;
}

export type ChatCandidateStateV1 =
  | "discovered"
  | "admitted"
  | "detail-read"
  | "excluded"
  | "deferred";

export interface ChatCandidateDiscoveryV1 {
  kind: "bound-anchor" | "scoped-search" | "relationship";
  callId: string;
  searchId?: string;
  queryVariantId?: string;
  page: number;
  rank?: number;
}

export interface ChatCandidateLedgerEntryV1 {
  candidateId: string;
  sourceId: string;
  product: ResearchProduct;
  title: string;
  canonicalUrl: string;
  authority: "bound" | "scoped-search" | "explicit-relationship";
  versionsObserved: string[];
  discoveries: ChatCandidateDiscoveryV1[];
  state: ChatCandidateStateV1;
  admittedRank?: number;
  exclusionReason?: string;
  deferredReason?: string;
}

export interface ChatSearchLedgerEntryV1 {
  searchId: string;
  product: ResearchProduct;
  queryVariantId: string;
  pagesRead: number;
  uniqueCandidateCount: number;
  terminal: boolean;
  termination?: string;
}

export interface ChatRelatedScopeProposalV1 {
  proposalId: string;
  product: "confluence";
  entityKind: "page";
  key: string;
  scopeKey: string;
  name: string;
  canonicalUrl: string;
  discoveredFromProduct: "jira";
  discoveredFromSourceId: string;
  reason: "explicit-link-outside-bound-scope";
  status: "pending-user-approval";
}

export interface ChatCandidateLedgerV1 {
  schema: typeof CHAT_CANDIDATE_LEDGER_SCHEMA_V1;
  conversationId: string;
  turnId: string;
  planFingerprint: string;
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
  candidates: ChatCandidateLedgerEntryV1[];
  searches: ChatSearchLedgerEntryV1[];
  relationshipTraversalsChecked: ChatRelationshipTraversalKindV1[];
  /** Body-free review candidates only; these grant no read capability. */
  relatedScopeProposals?: ChatRelatedScopeProposalV1[];
  atlassianHttpCalls: number;
  lastBudgetSnapshot?: ResearchBudgetSnapshotV1;
}

export interface ChatRetrievalMetricsV1 {
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
}

export interface ChatRetrievalAssessmentV1 {
  schema: typeof CHAT_RETRIEVAL_ASSESSMENT_SCHEMA_V1;
  sufficient: boolean;
  reasons: string[];
  completionSignals: Array<{
    signal: ChatRetrievalCompletionSignalV1;
    satisfied: boolean;
  }>;
  metrics: ChatRetrievalMetricsV1;
}

type ChatObservedCapabilityV1 =
  | ResearchGraphCapabilityV1
  | "atlassian.bound.read"
  | "atlassian.bound.section.read";

const RAW_QUERY_LANGUAGE_PATTERN =
  /(?:\b(?:ORDER\s+BY|AND|OR)\b\s+(?:project|space|type|status|updated|created)\s*(?:=|~|\bIN\s*\()|\b(?:project|space|type|status|updated|created)\s*(?:=|~|\bIN\s*\())/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._%~-]{0,119}$/u;
const CONFLUENCE_ID_PATTERN = /^[1-9][0-9]{0,127}$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const QUERY_STOP_WORDS = new Set([
  "about", "answer", "belege", "beschreibe", "content", "erklaere", "erkläre",
  "diesem", "dokumentierten", "erkennbare", "erste", "fasse", "finde", "geben",
  "gemeinsamkeiten", "inhalte", "installation", "konfiguration", "konfigurationswege",
  "link", "links", "nenne", "nutzung", "quelle", "quellen", "schritte", "seite",
  "space", "summarize", "summary", "unterschiede", "use", "using", "vergleiche",
  "welche", "what", "widersprueche", "widersprüche", "with", "zentrale",
  "direkt", "entdeckten", "kennzeichne", "kanonischen", "kandidaten", "lies",
  "synthetisierst", "urls", "verbindungen",
]);

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function cleanText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.includes("\u0000")) invalid(`${label} is invalid.`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!cleaned || cleaned.length > maximum) invalid(`${label} is invalid.`);
  return cleaned;
}

function identifier(value: unknown, label: string): string {
  const cleaned = cleanText(value, label, 120);
  if (!SAFE_ID_PATTERN.test(cleaned)) invalid(`${label} is invalid.`);
  return cleaned;
}

function stableFingerprint(value: unknown): string {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalQuery(query: ChatSearchQueryV1): ChatSearchQueryV1 {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    invalid("Chat search query is invalid.");
  }
  const unknown = Object.keys(query).filter((key) =>
    !["text", "labels", "ancestorId", "parentId"].includes(key)
  );
  if (unknown.length > 0) invalid("Chat search query contains unsupported fields.");
  const text = query.text === undefined
    ? undefined
    : cleanText(query.text, "Chat search text", 500);
  if (text && RAW_QUERY_LANGUAGE_PATTERN.test(text)) {
    invalid("Raw CQL or JQL is not accepted as Chat search text.");
  }
  const labels = query.labels === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(query.labels) || query.labels.length < 1 || query.labels.length > 8) {
          invalid("Chat search labels are invalid.");
        }
        const normalized = query.labels.map((label) => cleanText(label, "Chat search label", 255));
        if (normalized.some((label) => !LABEL_PATTERN.test(label)) ||
            new Set(normalized).size !== normalized.length) {
          invalid("Chat search labels are invalid.");
        }
        return [...normalized].sort((left, right) => left.localeCompare(right, "en-US"));
      })();
  const ancestorId = query.ancestorId === undefined
    ? undefined
    : cleanText(query.ancestorId, "Chat ancestor ID", 128);
  const parentId = query.parentId === undefined
    ? undefined
    : cleanText(query.parentId, "Chat parent ID", 128);
  if ((ancestorId && !CONFLUENCE_ID_PATTERN.test(ancestorId)) ||
      (parentId && !CONFLUENCE_ID_PATTERN.test(parentId)) ||
      (ancestorId && parentId) || (!text && !labels && !ancestorId && !parentId)) {
    invalid("Chat search query is invalid.");
  }
  return {
    ...(text ? { text } : {}),
    ...(labels ? { labels } : {}),
    ...(ancestorId ? { ancestorId } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function quotedQuestionTerms(question: string): string[] {
  const patterns = [
    /"([^"]{2,160})"/gu,
    /“([^”]{2,160})”/gu,
    /„([^“”]{2,160})[“”]/gu,
    /«([^»]{2,160})»/gu,
    /‚([^‘’]{2,160})[‘’]/gu,
    /‘([^’]{2,160})’/gu,
    /'([^']{2,160})'/gu,
  ];
  return [...new Set(patterns.flatMap((pattern) =>
    [...question.matchAll(pattern)].map((match) => match[1]!.trim())
  ).filter(Boolean))];
}

function focusedQuestionTerms(question: string): string {
  const withoutUrls = question.replace(/https?:\/\/\S+/giu, " ");
  const tokens = withoutUrls.match(/[\p{L}\p{N}][\p{L}\p{N}._:-]{2,79}/gu) ?? [];
  const unique = new Map<string, string>();
  for (const original of tokens) {
    const normalized = original.replace(/^[._:-]+|[._:-]+$/gu, "");
    const key = normalized.toLocaleLowerCase("en-US");
    if (!normalized || QUERY_STOP_WORDS.has(key) || unique.has(key)) continue;
    unique.set(key, normalized);
    if (unique.size >= 10) break;
  }
  return [...unique.values()].join(" ").slice(0, 240);
}

function defaultQueryVariants(question: string): ChatSearchVariantProposalV1[] {
  const normalized = cleanText(question, "Chat question", 2_000);
  const variants: ChatSearchVariantProposalV1[] = [];
  const quoted = quotedQuestionTerms(normalized);
  variants.push(...quoted.slice(0, 5).map((term, index) => ({
    variantId: `quoted-term-${index + 1}`,
    query: { text: term },
    expectedInformationGain: "high" as const,
  })));
  const jiraKeys = [...new Set(normalized.match(/\b[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}\b/gu) ?? [])];
  if (jiraKeys.length > 0 && variants.length < 5) {
    variants.push({
      variantId: "explicit-keys",
      query: { text: jiraKeys.slice(0, 8).join(" ") },
      expectedInformationGain: "high",
    });
  }
  const focused = focusedQuestionTerms(normalized);
  if (focused && variants.length < 5) {
    variants.push({
      variantId: "question-terms",
      query: { text: focused },
      expectedInformationGain: quoted.length > 0 || jiraKeys.length > 0 ? "medium" : "high",
    });
  }
  return variants.filter((variant, index, all) =>
    all.findIndex((candidate) =>
      JSON.stringify(candidate.query) === JSON.stringify(variant.query)
    ) === index
  ).slice(0, 5);
}

function hostRequiredQueryVariants(
  question: string,
  product: ResearchProduct,
): ChatSearchVariantProposalV1[] {
  const normalized = cleanText(question, "Chat question", 2_000);
  if (product === "confluence") {
    return quotedQuestionTerms(normalized).slice(0, 5).map((term, index) => ({
      variantId: `host:quoted-term-${index + 1}`,
      query: { text: term },
      expectedInformationGain: "high" as const,
    }));
  }
  return [...new Set(
    normalized.match(/\b[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}\b/gu) ?? [],
  )].slice(0, 5).map((key, index) => ({
    variantId: `host:explicit-key-${index + 1}`,
    query: { text: key },
    expectedInformationGain: "high" as const,
  }));
}

function retainHostRequiredQueryVariants(
  question: string,
  product: ResearchProduct,
  proposed: ChatSearchVariantProposalV1[],
): ChatSearchVariantProposalV1[] {
  const required = hostRequiredQueryVariants(question, product);
  const requiredIds = new Set(required.map((variant) => variant.variantId));
  const queryFingerprints = new Set(required.map((variant) =>
    stableFingerprint(canonicalQuery(variant.query))
  ));
  const optional = proposed.filter((variant) => {
    if (requiredIds.has(variant.variantId)) return false;
    const fingerprint = stableFingerprint(canonicalQuery(variant.query));
    if (queryFingerprints.has(fingerprint)) return false;
    queryFingerprints.add(fingerprint);
    return true;
  });
  return [...required, ...optional].slice(0, 5);
}

function ensureConciseCoreTermVariant(
  question: string,
  variants: ChatSearchVariantProposalV1[],
): ChatSearchVariantProposalV1[] {
  // Explicit quoted titles are already the highest-precision default strategy.
  // Injecting a guessed token can only displace one of them from the bounded
  // product-wide query budget. Model-proposed synonyms still benefit from the
  // pre-existing shared-core safety net below.
  if (variants.some((variant) =>
    variant.variantId.startsWith("quoted-term-") ||
    variant.variantId.startsWith("host:quoted-term-")
  )) {
    return variants;
  }
  const textVariants = variants
    .map((variant) => variant.query.text?.toLocaleLowerCase("en-US"))
    .filter((text): text is string => Boolean(text));
  const rawQuestionTokens = cleanText(question, "Chat question", 2_000)
    .match(/[\p{L}][\p{L}\p{N}._-]{3,79}/gu) ?? [];
  const questionTokens = [...new Map(rawQuestionTokens
    .map((original) => ({
      original: original.replace(/^[._-]+|[._-]+$/gu, ""),
      token: original.replace(/^[._-]+|[._-]+$/gu, "")
        .toLocaleLowerCase("en-US"),
    }))
    .filter(({ token }) => token && !QUERY_STOP_WORDS.has(token))
    .map((entry) => [entry.token, entry] as const)).values()];
  const candidates = questionTokens
    .map(({ original, token }, order) => ({
      original,
      token,
      order,
      occurrences: textVariants.filter((text) =>
        new RegExp(`(?:^|[^\\p{L}\\p{N}._-])${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}\\p{N}._-])`, "u")
          .test(text)
      ).length,
    }))
    .sort((left, right) =>
      right.occurrences - left.occurrences || left.order - right.order
    );
  // Technical identifiers are often the only stable bridge between a broad
  // natural-language question and the source index. Prefer them even when a
  // model proposed just one verbose variant; otherwise require repetition
  // across independently proposed variants before injecting a generic term.
  const mixedCase = candidates.find((candidate) =>
    !/[._-]/u.test(candidate.original) &&
    /\p{Ll}/u.test(candidate.original) &&
    /\p{Lu}/u.test(candidate.original.slice(1))
  );
  const technical = mixedCase ?? candidates.find((candidate) =>
    /(?:cli|api|sdk|mcp|js)$/iu.test(candidate.token) ||
    /[\p{L}\p{N}][._-][\p{L}\p{N}]/u.test(candidate.token) ||
    /\d/u.test(candidate.token)
  );
  const core = technical?.token ?? candidates.find((candidate) =>
    candidate.occurrences >= 2
  )?.token;
  if (!core || variants.some((variant) =>
    variant.query.text?.trim().toLocaleLowerCase("en-US") === core
  )) return variants;
  const ids = new Set(variants.map((variant) => variant.variantId));
  let variantId = "host-core-term";
  for (let suffix = 2; ids.has(variantId); suffix += 1) {
    variantId = `host-core-term-${suffix}`;
  }
  return [
    {
      variantId,
      query: { text: core },
      expectedInformationGain: "high",
    },
    ...variants.slice(0, 2),
  ];
}

function scopeBindingProjection(
  binding: ResearchScopeBindingV1,
): ChatResolvedRetrievalEntityV1 | undefined {
  if (!binding || !["jira", "confluence"].includes(binding.product) ||
      !["issue", "page", "project", "space"].includes(binding.entityKind) ||
      !["approved", "locked", "resolved"].includes(binding.authority)) {
    return undefined;
  }
  return {
    bindingId: identifier(binding.id, "Chat scope binding ID"),
    product: binding.product,
    entityKind: binding.entityKind,
    authority: binding.authority as "approved" | "locked" | "resolved",
    ...(binding.key ? { key: cleanText(binding.key, "Chat scope key", 255) } : {}),
    name: cleanText(binding.name, "Chat scope name", 500),
  };
}

function canonicalSearches(input: {
  question: string;
  proposal?: ChatRetrievalPlanProposalV1;
  allowedSearchProducts: readonly ResearchProduct[];
  resolvedEntities: readonly ChatResolvedRetrievalEntityV1[];
  limits: ResearchLimitsV1;
}): ChatRetrievalSearchV1[] {
  const allowed = new Set(input.allowedSearchProducts);
  const proposed = input.proposal?.searches ?? input.allowedSearchProducts.map((product) => ({
    searchId: `search:${product}`,
    product,
    variants: defaultQueryVariants(input.question),
    maxPages: 1,
  }));
  if (proposed.length > 2) invalid("Chat retrieval may contain at most two product searches.");
  const seenProducts = new Set<ResearchProduct>();
  const seenIds = new Set<string>();
  return proposed.map((search): ChatRetrievalSearchV1 => {
    if (!search || !allowed.has(search.product) || seenProducts.has(search.product)) {
      invalid("Chat retrieval search product is unavailable or duplicated.");
    }
    seenProducts.add(search.product);
    const searchId = identifier(search.searchId, "Chat search ID");
    if (seenIds.has(searchId)) invalid("Chat search ID is duplicated.");
    seenIds.add(searchId);
    if (!Number.isSafeInteger(search.maxPages) || search.maxPages < 1 ||
        search.maxPages > input.limits.maxSearchPagesPerProduct) {
      invalid("Chat search page budget is invalid.");
    }
    if (!Array.isArray(search.variants) || search.variants.length < 1 || search.variants.length > 5) {
      invalid("Chat search variants are invalid.");
    }
    const variantIds = new Set<string>();
    const queryFingerprints = new Set<string>();
    const gainRank = { high: 0, medium: 1, low: 2 } as const;
    const variants = ensureConciseCoreTermVariant(
      input.question,
      retainHostRequiredQueryVariants(input.question, search.product, search.variants),
    )
      // At least one page is required to execute a variant. Keep only the
      // highest-value variants that fit the product-wide page ceiling.
      .slice(0, input.limits.maxSearchPagesPerProduct)
      .map((variant, index) => {
      const variantId = identifier(variant.variantId, "Chat query variant ID");
      if (variantIds.has(variantId)) invalid("Chat query variant ID is duplicated.");
      variantIds.add(variantId);
      const query = canonicalQuery(variant.query);
      const fingerprint = stableFingerprint(query);
      if (queryFingerprints.has(fingerprint)) invalid("Chat query variant is duplicated.");
      queryFingerprints.add(fingerprint);
      if (search.product === "jira" && (query.ancestorId || query.parentId)) {
        invalid("Jira Chat search cannot use Confluence hierarchy fields.");
      }
      return {
        variantId,
        query,
        expectedInformationGain: variant.expectedInformationGain ??
          (["high", "medium", "low"] as const)[Math.min(index, 2)]!,
      };
      }).sort((left, right) =>
      gainRank[left.expectedInformationGain] - gainRank[right.expectedInformationGain]
    );
    // ResearchRunBudget owns one product-wide page ceiling. The proposal's
    // maxPages is a requested per-variant ceiling, so clamp it before admission
    // such that all admitted variants are actually executable within that root
    // budget. A plan must never advertise 3 x 5 pages while the broker permits
    // only 5 Confluence pages in total.
    const maxPages = Math.min(
      search.maxPages,
      Math.max(1, Math.floor(input.limits.maxSearchPagesPerProduct / variants.length)),
    );
    const scopeBindingIds = input.resolvedEntities
      .filter((entity) => entity.product === search.product &&
        (entity.entityKind === "project" || entity.entityKind === "space"))
      .map((entity) => entity.bindingId)
      .sort((left, right) => left.localeCompare(right, "en-US"));
    if (scopeBindingIds.length === 0) {
      invalid("Chat search requires an approved whole-project or whole-space binding.");
    }
    return {
      searchId,
      product: search.product,
      variants,
      maxPages,
      scopeBindingIds,
    };
  }).sort((left, right) => left.product.localeCompare(right.product, "en-US"));
}

function canonicalTraversals(input: {
  proposal?: ChatRetrievalPlanProposalV1;
  products: readonly ResearchProduct[];
  anchors: readonly ChatRetrievalAnchorV1[];
  enabled: boolean;
}): ChatRelationshipTraversalProposalV1[] {
  const available = new Set<ChatRelationshipTraversalKindV1>();
  if (input.enabled &&
      (input.products.includes("confluence") || input.anchors.some((anchor) => anchor.product === "confluence"))) {
    available.add("confluence-to-jira-reference");
  }
  if (input.enabled &&
      (input.products.includes("jira") || input.anchors.some((anchor) => anchor.product === "jira"))) {
    available.add("jira-to-confluence-remote-link");
  }
  const proposed = input.proposal?.relationshipTraversals ?? [...available].map((kind) => ({
    traversalId: `traversal:${kind}`,
    kind,
    maxDepth: 1 as const,
  }));
  if (proposed.length > 2) invalid("Chat relationship traversal proposal is too large.");
  const seen = new Set<ChatRelationshipTraversalKindV1>();
  return proposed.map((traversal) => {
    if (!traversal || !available.has(traversal.kind) || seen.has(traversal.kind) ||
        traversal.maxDepth !== 1) {
      invalid("Chat relationship traversal is unavailable, duplicated, or too deep.");
    }
    seen.add(traversal.kind);
    return {
      traversalId: identifier(traversal.traversalId, "Chat traversal ID"),
      kind: traversal.kind,
      maxDepth: 1 as const,
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind, "en-US"));
}

export function createChatRetrievalPlanV1(input: {
  conversationId: string;
  turnId: string;
  question: string;
  anchors: readonly BoundEntityAnchorV1[];
  scopeBindings: readonly ResearchScopeBindingV1[];
  boundProjectKeys?: readonly string[];
  boundSpaceKeys?: readonly string[];
  searchProducts: readonly ResearchProduct[];
  exactContextProducts: readonly ResearchProduct[];
  limits: ResearchLimitsV1;
  agentic: boolean;
  relationshipTracing?: boolean;
  proposal?: ChatRetrievalPlanProposalV1;
  now?: () => number;
}): ChatRetrievalPlanV1 {
  const conversationId = cleanText(input.conversationId, "Chat conversation ID", 240);
  const turnId = cleanText(input.turnId, "Chat turn ID", 240);
  const exactProducts = new Set(input.exactContextProducts);
  const allowedSearchProducts = [...new Set(input.searchProducts)]
    .filter((product) => !exactProducts.has(product));
  const anchors = input.anchors.map((anchor): ChatRetrievalAnchorV1 => ({
    anchorRef: cleanText(anchor.anchorRef, "Chat anchor reference", 220),
    product: anchor.product,
    entityKind: anchor.entityKind,
    name: cleanText(anchor.name, "Chat anchor name", 500),
  }));
  const resolvedEntities = input.scopeBindings
    .map(scopeBindingProjection)
    .filter((entry): entry is ChatResolvedRetrievalEntityV1 => entry !== undefined)
  for (const projectKey of input.boundProjectKeys ?? []) {
    if (!resolvedEntities.some((entry) =>
      entry.product === "jira" && entry.entityKind === "project" && entry.key === projectKey
    )) {
      resolvedEntities.push({
        bindingId: `scope:jira-project:${cleanText(projectKey, "Jira project key", 20)}`,
        product: "jira",
        entityKind: "project",
        authority: "locked",
        key: projectKey,
        name: projectKey,
      });
    }
  }
  for (const spaceKey of input.boundSpaceKeys ?? []) {
    if (!resolvedEntities.some((entry) =>
      entry.product === "confluence" && entry.entityKind === "space" && entry.key === spaceKey
    )) {
      resolvedEntities.push({
        bindingId: `scope:confluence-space:${stableFingerprint(spaceKey).slice("fnv1a32:".length)}`,
        product: "confluence",
        entityKind: "space",
        authority: "locked",
        key: spaceKey,
        name: spaceKey,
      });
    }
  }
  resolvedEntities.sort((left, right) => left.bindingId.localeCompare(right.bindingId, "en-US"));
  const searches = canonicalSearches({
    question: input.question,
    ...(input.proposal ? { proposal: input.proposal } : {}),
    allowedSearchProducts,
    resolvedEntities,
    limits: input.limits,
  });
  const relationshipTraversals = canonicalTraversals({
    ...(input.proposal ? { proposal: input.proposal } : {}),
    products: [...new Set([...allowedSearchProducts, ...anchors.map((anchor) => anchor.product)])],
    anchors,
    enabled: input.relationshipTracing !== false,
  });
  const unresolvedTerms = [...new Set((input.proposal?.unresolvedTerms ?? []).map((term) =>
    cleanText(term, "Chat unresolved term", 160)
  ))].slice(0, 12).sort((left, right) => left.localeCompare(right, "en-US"));
  const directReadCalls = anchors.length;
  // Strategy acknowledgement, workflow proposal/review, durable frontier
  // control and the quality boundary use the same root PTC budget as source
  // acquisition. Reserve their measured bounded envelope explicitly instead
  // of pretending the budget belongs only to Atlassian tools.
  const supervisorCalls = input.agentic
    ? Math.min(32, Math.max(10, Math.floor(input.limits.maxPtcCalls * 0.4)))
    : 2;
  const discoveryCalls = searches.reduce((total, search) =>
    total + (search.maxPages * search.variants.length) + 1, 0
  );
  const relationshipTraversalCalls = relationshipTraversals.length;
  const repairCalls = input.agentic ? 1 : 0;
  const criticCalls = input.agentic ? 1 : 0;
  const synthesisCalls = 1 as const;
  const fixedCalls = supervisorCalls + directReadCalls + discoveryCalls + relationshipTraversalCalls +
    repairCalls + criticCalls + synthesisCalls;
  const searchProducts = [...new Set(searches.map((search) => search.product))];
  if (fixedCalls + searchProducts.length > input.limits.maxPtcCalls) {
    invalid("Chat retrieval plan exceeds the root capability-call budget.");
  }
  const detailCallsByProduct: Record<ResearchProduct, number> = {
    jira: 0,
    confluence: 0,
  };
  let remainingDetailCalls = input.limits.maxPtcCalls - fixedCalls;
  // Give every searched product one detail-read opportunity first, then split
  // the remaining root corridor fairly. The persisted reservation is also the
  // runtime ceiling, so a small Chat budget can never silently admit more
  // candidates than its supervisor, critic, and synthesizer can finish.
  while (remainingDetailCalls > 0 && searchProducts.some((product) =>
    detailCallsByProduct[product] < input.limits.maxDetailItemsPerProduct
  )) {
    for (const product of searchProducts) {
      if (remainingDetailCalls <= 0) break;
      if (detailCallsByProduct[product] >= input.limits.maxDetailItemsPerProduct) continue;
      detailCallsByProduct[product] += 1;
      remainingDetailCalls -= 1;
    }
  }
  const totalCalls = fixedCalls + Object.values(detailCallsByProduct)
    .reduce((total, calls) => total + calls, 0);
  const completionSignals: ChatRetrievalCompletionSignalV1[] = [
    ...(anchors.length > 0 ? ["all-anchors-read" as const] : []),
    ...(searches.length > 0
      ? [
          "all-searches-terminal" as const,
          "all-admitted-candidates-terminal" as const,
          "query-variants-saturated" as const,
        ]
      : []),
    ...(relationshipTraversals.length > 0
      ? ["relationship-traversals-checked" as const]
      : []),
    "detail-evidence-present",
  ];
  return {
    schema: CHAT_RETRIEVAL_PLAN_SCHEMA_V1,
    conversationId,
    turnId,
    createdAt: new Date((input.now ?? Date.now)()).toISOString(),
    questionFingerprint: stableFingerprint(cleanText(input.question, "Chat question", 2_000)),
    anchors,
    resolvedEntities,
    searches,
    relationshipTraversals,
    unresolvedTerms,
    completionSignals,
    budgetReservations: {
      supervisorCalls,
      directReadCalls,
      discoveryCalls,
      detailCallsByProduct,
      relationshipTraversalCalls,
      repairCalls,
      criticCalls,
      synthesisCalls,
      totalCalls,
    },
  };
}

function sourceFromResult(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result) || !("source" in result)) {
    return undefined;
  }
  const source = result.source;
  return source && typeof source === "object" && !Array.isArray(source)
    ? source as Record<string, unknown>
    : undefined;
}

function observedSource(input: Record<string, unknown>): {
  sourceId: string;
  product: ResearchProduct;
  title: string;
  canonicalUrl: string;
  version?: string;
} {
  const sourceId = cleanText(input.sourceId, "Chat candidate source ID", 256);
  const product = input.product;
  if (product !== "jira" && product !== "confluence") {
    invalid("Chat candidate product is invalid.");
  }
  return {
    sourceId,
    product,
    title: cleanText(input.title, "Chat candidate title", 2_000),
    canonicalUrl: cleanText(input.url, "Chat candidate canonical URL", 4_000),
    ...(typeof input.updatedAt === "string" && input.updatedAt
      ? { version: cleanText(input.updatedAt, "Chat candidate version", 120) }
      : {}),
  };
}

function canonicalUrlMatchesSourceV1(input: {
  sourceId: string;
  product: ResearchProduct;
  canonicalUrl: string;
  siteOrigin: string;
}): boolean {
  let url: URL;
  try {
    url = new URL(input.canonicalUrl);
  } catch {
    return false;
  }
  if (url.origin !== input.siteOrigin) return false;
  if (input.product === "jira") {
    const issueKey = input.sourceId.match(/^jira:([A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18})$/u)?.[1];
    return issueKey !== undefined
      ? url.pathname === `/browse/${encodeURIComponent(issueKey)}`
      : url.pathname.startsWith("/browse/");
  }
  const contentId = input.sourceId.match(/^wiki:([1-9][0-9]{0,127})$/u)?.[1];
  if (!contentId) return url.pathname.startsWith("/wiki/");
  const encodedId = encodeURIComponent(contentId);
  return url.pathname === `/wiki/pages/${encodedId}` ||
    new RegExp(`^/wiki/spaces/[^/]+/pages/${encodedId}(?:/|$)`, "u").test(url.pathname);
}

function cloneLedger(ledger: ChatCandidateLedgerV1): ChatCandidateLedgerV1 {
  return structuredClone(ledger);
}

function queryFingerprint(query: unknown): string {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    invalid("Chat search invocation is missing its admitted query.");
  }
  return stableFingerprint(canonicalQuery(query as ChatSearchQueryV1));
}

export class ChatCandidateLedgerControllerV1 {
  #plan: ChatRetrievalPlanV1;
  readonly #workspace: ResearchWorkspace;
  readonly #siteOrigin: string;
  readonly #now: () => number;
  readonly #expectedSourceIds?: Set<string>;
  readonly #candidateBySource = new Map<string, ChatCandidateLedgerEntryV1>();
  readonly #sourceByEntityRef = new Map<string, string>();
  readonly #cursorRoute = new Map<string, { searchId: string; variantId: string; page: number }>();
  readonly #searchByVariant = new Map<string, ChatSearchLedgerEntryV1>();
  readonly #relatedScopeProposalByIdentity = new Map<
    string,
    ChatRelatedScopeProposalV1
  >();
  #persistTail = Promise.resolve();
  #ledger: ChatCandidateLedgerV1;

  constructor(input: {
    plan: ChatRetrievalPlanV1;
    workspace: ResearchWorkspace;
    siteOrigin: string;
    expectedSourceIds?: readonly string[];
    now?: () => number;
  }) {
    this.#plan = structuredClone(input.plan);
    this.#workspace = input.workspace;
    this.#siteOrigin = new URL(input.siteOrigin).origin;
    this.#now = input.now ?? Date.now;
    this.#expectedSourceIds = input.expectedSourceIds
      ? new Set(input.expectedSourceIds)
      : undefined;
    const at = new Date(this.#now()).toISOString();
    this.#ledger = {
      schema: CHAT_CANDIDATE_LEDGER_SCHEMA_V1,
      conversationId: input.plan.conversationId,
      turnId: input.plan.turnId,
      planFingerprint: stableFingerprint(input.plan),
      startedAt: at,
      updatedAt: at,
      candidates: [],
      searches: [],
      relationshipTraversalsChecked: [],
      atlassianHttpCalls: 0,
    };
  }

  async initialize(): Promise<void> {
    await this.#workspace.writeFile(
      CHAT_RETRIEVAL_PLAN_PATH_V1,
      JSON.stringify(this.#plan),
    );
    await this.#persist();
  }

  async replacePlan(plan: ChatRetrievalPlanV1): Promise<void> {
    if (plan.conversationId !== this.#plan.conversationId ||
        plan.turnId !== this.#plan.turnId) {
      invalid("Chat retrieval replan belongs to another conversation or turn.");
    }
    if (this.#candidateBySource.size > 0 || this.#sourceByEntityRef.size > 0 ||
        this.#cursorRoute.size > 0 || this.#searchByVariant.size > 0 ||
        this.#ledger.atlassianHttpCalls > 0 || this.#ledger.finalizedAt) {
      invalid("Chat retrieval replan is no longer allowed after acquisition began.");
    }
    this.#plan = structuredClone(plan);
    this.#ledger.planFingerprint = stableFingerprint(plan);
    this.#ledger.updatedAt = new Date(this.#now()).toISOString();
    await this.#workspace.writeFile(
      CHAT_RETRIEVAL_PLAN_PATH_V1,
      JSON.stringify(this.#plan),
    );
    await this.#persist();
  }

  async retainAdmittedCandidates(
    product: ResearchProduct,
    sourceIds: readonly string[],
    reason = "outside-bounded-detail-selection",
  ): Promise<void> {
    const retained = new Set(sourceIds.map((sourceId) =>
      cleanText(sourceId, "Retained Chat candidate source ID", 256)
    ));
    for (const sourceId of retained) {
      const candidate = this.#candidateBySource.get(sourceId);
      if (!candidate || candidate.product !== product || candidate.state !== "admitted") {
        invalid("Chat detail selection contains a candidate that was not admitted by ranking.");
      }
    }
    for (const candidate of this.#candidateBySource.values()) {
      if (candidate.product === product && candidate.state === "admitted" &&
          !retained.has(candidate.sourceId)) {
        candidate.state = "excluded";
        candidate.exclusionReason = cleanText(
          reason,
          "Chat candidate exclusion reason",
          240,
        );
      }
    }
    this.#ledger.updatedAt = new Date(this.#now()).toISOString();
    await this.#persist();
  }

  plan(): ChatRetrievalPlanV1 {
    return structuredClone(this.#plan);
  }

  snapshot(): ChatCandidateLedgerV1 {
    this.#ledger.candidates = [...this.#candidateBySource.values()]
      .map((entry) => structuredClone(entry))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en-US"));
    this.#ledger.searches = [...this.#searchByVariant.values()]
      .map((entry) => structuredClone(entry))
      .sort((left, right) =>
        `${left.product}:${left.searchId}:${left.queryVariantId}`.localeCompare(
          `${right.product}:${right.searchId}:${right.queryVariantId}`,
          "en-US",
        )
      );
    const relatedScopeProposals = [...this.#relatedScopeProposalByIdentity.values()]
      .map((entry) => structuredClone(entry))
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId, "en-US"));
    if (relatedScopeProposals.length > 0) {
      this.#ledger.relatedScopeProposals = relatedScopeProposals;
    } else {
      delete this.#ledger.relatedScopeProposals;
    }
    return cloneLedger(this.#ledger);
  }

  async observeRelatedScopeCandidate(
    candidate: ResearchRelatedScopeCandidateV1,
  ): Promise<void> {
    const canonical = new URL(candidate.canonicalUrl);
    const expectedPath = `/wiki/spaces/${encodeURIComponent(candidate.scopeKey)}/pages/${candidate.key}`;
    if (canonical.origin !== this.#siteOrigin || !canonical.pathname.includes(expectedPath)) {
      invalid("Chat related-scope candidate is outside the bound tenant or has no canonical page identity.");
    }
    const identity = `${candidate.product}:${candidate.key}`;
    const proposal: ChatRelatedScopeProposalV1 = {
      proposalId: `related-scope:${stableFingerprint(identity).slice("fnv1a32:".length)}`,
      product: candidate.product,
      entityKind: candidate.entityKind,
      key: cleanText(candidate.key, "Chat related-scope entity key", 128),
      scopeKey: cleanText(candidate.scopeKey, "Chat related-scope key", 255),
      name: cleanText(candidate.name, "Chat related-scope entity name", 500),
      canonicalUrl: canonical.toString(),
      discoveredFromProduct: candidate.discoveredFromProduct,
      discoveredFromSourceId: cleanText(
        candidate.discoveredFromSourceId,
        "Chat related-scope provenance",
        256,
      ),
      reason: candidate.reason,
      status: "pending-user-approval",
    };
    const existing = this.#relatedScopeProposalByIdentity.get(identity);
    if (existing && JSON.stringify(existing) !== JSON.stringify(proposal)) {
      invalid("Chat related-scope candidate identity changed during the turn.");
    }
    this.#relatedScopeProposalByIdentity.set(identity, proposal);
    this.#ledger.updatedAt = new Date(this.#now()).toISOString();
    await this.#persist();
  }

  allowedInitialQueries(product: ResearchProduct): ChatSearchQueryV1[] {
    return this.#plan.searches
      .filter((search) => search.product === product)
      .flatMap((search) => search.variants.map((variant) => structuredClone(variant.query)));
  }

  /**
   * True only after every admitted query variant for one product returned a
   * terminal page and none discovered a candidate. Search specialists use
   * this host-owned signal to stop evaluating code and return an explicit gap
   * instead of inventing queries after the safe retrieval plan is exhausted.
   */
  isSearchExhaustedWithoutCandidates(product: ResearchProduct): boolean {
    return this.isSearchPlanSaturated(product) &&
      !this.#ledger.candidates.some((candidate) => candidate.product === product);
  }

  isSearchPlanSaturated(product: ResearchProduct): boolean {
    const planned = this.#plan.searches
      .filter((search) => search.product === product)
      .flatMap((search) => search.variants.map((variant) => ({
        searchId: search.searchId,
        variantId: variant.variantId,
      })));
    if (planned.length === 0) return false;
    const completed = new Set(this.#ledger.searches
      .filter((search) => search.product === product && search.terminal)
      .map((search) => `${search.searchId}:${search.queryVariantId}`));
    return planned.every((variant) =>
      completed.has(`${variant.searchId}:${variant.variantId}`)
    );
  }

  #variantFor(product: ResearchProduct, input: unknown): {
    search: ChatRetrievalSearchV1;
    variant: ChatSearchVariantProposalV1;
    page: number;
  } {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const nestedCursor = record.query && typeof record.query === "object" &&
      !Array.isArray(record.query) && "cursor" in record.query
      ? (record.query as { cursor?: unknown }).cursor
      : undefined;
    const cursor = typeof record.cursor === "string"
      ? record.cursor
      : typeof nestedCursor === "string" ? nestedCursor : undefined;
    if (cursor) {
      const route = this.#cursorRoute.get(cursor);
      const search = route && this.#plan.searches.find((candidate) => candidate.searchId === route.searchId);
      const variant = search && route && search.variants.find((candidate) =>
        candidate.variantId === route.variantId
      );
      if (!route || !search || !variant || search.product !== product) {
        invalid("Chat search cursor is not part of the admitted retrieval plan.");
      }
      return { search, variant, page: route.page };
    }
    const query = typeof record.query === "string"
      ? { text: record.query }
      : record.query;
    const fingerprint = queryFingerprint(query);
    for (const search of this.#plan.searches.filter((candidate) => candidate.product === product)) {
      const variant = search.variants.find((candidate) =>
        stableFingerprint(candidate.query) === fingerprint
      );
      if (variant) return { search, variant, page: 1 };
    }
    invalid("Chat search query is not an admitted retrieval-plan variant.");
  }

  assertToolInput(tool: ChatObservedCapabilityV1, input: unknown): void {
    if (tool !== "jira.issue.search" && tool !== "wiki.search") return;
    const product = tool === "jira.issue.search" ? "jira" : "confluence";
    const { search, variant, page } = this.#variantFor(product, input);
    const state = this.#searchByVariant.get(`${search.searchId}:${variant.variantId}`);
    if (page > search.maxPages || (state?.terminal && page > state.pagesRead)) {
      invalid("Chat search exceeds its admitted page or terminal boundary.");
    }
  }

  async observe(
    tool: ChatObservedCapabilityV1,
    result: unknown,
    callId: string,
    input?: unknown,
  ): Promise<void> {
    if (result && typeof result === "object" && !Array.isArray(result) &&
        "budget" in result && result.budget && typeof result.budget === "object" &&
        !Array.isArray(result.budget)) {
      const budget = result.budget as Partial<ResearchBudgetSnapshotV1>;
      if (Number.isSafeInteger(budget.ptcRemaining) &&
          Number.isSafeInteger(budget.httpAttemptsRemaining) &&
          Number.isSafeInteger(budget.responseBytesRemaining)) {
        this.#ledger.lastBudgetSnapshot = {
          ptcRemaining: budget.ptcRemaining!,
          httpAttemptsRemaining: budget.httpAttemptsRemaining!,
          responseBytesRemaining: budget.responseBytesRemaining!,
        };
      }
    }
    if (tool === "jira.issue.search" || tool === "wiki.search") {
      this.#observeSearch(tool, result as ResearchSearchOutputV1, callId, input);
    } else if (tool === "research.candidate.rank") {
      this.#observeRank(result as ResearchCandidateRankOutputV1, callId);
    } else if (tool === "jira.issue.get" || tool === "wiki.page.get") {
      this.#observeDetail(result as ResearchGetOutputV1, callId, "scoped-search");
      this.#ledger.atlassianHttpCalls += 1;
    } else if (tool === "atlassian.bound.read") {
      this.#observeDetail(result as BoundEntityReadOutputV1, callId, "bound");
      this.#observeRelatedAnchors(result as BoundEntityReadOutputV1, callId);
      this.#ledger.atlassianHttpCalls += 1;
    } else if (tool === "atlassian.bound.section.read") {
      this.#observeDetail(result as BoundEntitySectionReadOutputV1, callId, "bound");
    }
    this.#ledger.updatedAt = new Date(this.#now()).toISOString();
    await this.#persist();
  }

  #observeSearch(
    tool: "jira.issue.search" | "wiki.search",
    result: ResearchSearchOutputV1,
    callId: string,
    input: unknown,
  ): void {
    const product = tool === "jira.issue.search" ? "jira" : "confluence";
    const { search, variant, page } = this.#variantFor(product, input);
    if (!result || !Array.isArray(result.items) || !result.page) {
      invalid("Chat search result is invalid.");
    }
    const stateKey = `${search.searchId}:${variant.variantId}`;
    const state = this.#searchByVariant.get(stateKey) ?? {
      searchId: search.searchId,
      product,
      queryVariantId: variant.variantId,
      pagesRead: 0,
      uniqueCandidateCount: 0,
      terminal: false,
    };
    const before = this.#candidateBySource.size;
    for (const raw of result.items) {
      const source = observedSource(raw as unknown as Record<string, unknown>);
      if (source.product !== product || typeof raw.entityRef !== "string") {
        invalid("Chat search result escaped its admitted product.");
      }
      this.#sourceByEntityRef.set(raw.entityRef, source.sourceId);
      this.#upsertCandidate(source, {
        kind: "scoped-search",
        callId,
        searchId: search.searchId,
        queryVariantId: variant.variantId,
        page,
      }, "scoped-search");
    }
    state.pagesRead = Math.max(state.pagesRead, page);
    state.uniqueCandidateCount += Math.max(0, this.#candidateBySource.size - before);
    state.terminal = result.page.complete || !result.page.nextCursor || page >= search.maxPages;
    if (result.page.termination) state.termination = result.page.termination;
    if (result.page.nextCursor && !state.terminal) {
      this.#cursorRoute.set(result.page.nextCursor, {
        searchId: search.searchId,
        variantId: variant.variantId,
        page: page + 1,
      });
    }
    this.#searchByVariant.set(stateKey, state);
    this.#ledger.atlassianHttpCalls += 1;
  }

  #observeRank(result: ResearchCandidateRankOutputV1, callId: string): void {
    if (!result || !Array.isArray(result.items)) invalid("Chat candidate ranking is invalid.");
    for (const item of result.items) {
      const sourceId = this.#sourceByEntityRef.get(item.entityRef);
      const candidate = sourceId ? this.#candidateBySource.get(sourceId) : undefined;
      if (!candidate || sourceId !== item.sourceId || !Number.isSafeInteger(item.rank) || item.rank < 1) {
        invalid("Chat candidate ranking contains an unknown or invalid candidate.");
      }
      candidate.state = "admitted";
      candidate.admittedRank = item.rank;
      candidate.discoveries.push({
        kind: "scoped-search",
        callId,
        page: 0,
        rank: item.rank,
      });
    }
  }

  #observeDetail(
    result: ResearchGetOutputV1 | BoundEntityReadOutputV1 | BoundEntitySectionReadOutputV1,
    callId: string,
    authority: ChatCandidateLedgerEntryV1["authority"],
  ): void {
    const raw = sourceFromResult(result);
    if (!raw) invalid("Chat detail result is missing its source identity.");
    const source = observedSource(raw);
    const existing = this.#candidateBySource.get(source.sourceId);
    if (authority === "scoped-search" && (!existing || existing.state !== "admitted")) {
      invalid("Chat detail result was not admitted by candidate ranking.");
    }
    const candidate = this.#upsertCandidate(source, {
      kind: authority === "bound" ? "bound-anchor" : "scoped-search",
      callId,
      page: 0,
    }, authority);
    candidate.state = "detail-read";
    delete candidate.exclusionReason;
    delete candidate.deferredReason;
    const traversalKind: ChatRelationshipTraversalKindV1 = source.product === "confluence"
      ? "confluence-to-jira-reference"
      : "jira-to-confluence-remote-link";
    if (this.#plan.relationshipTraversals.some((entry) => entry.kind === traversalKind) &&
        !this.#ledger.relationshipTraversalsChecked.includes(traversalKind)) {
      this.#ledger.relationshipTraversalsChecked.push(traversalKind);
    }
  }

  #observeRelatedAnchors(result: BoundEntityReadOutputV1, callId: string): void {
    const source = sourceFromResult(result);
    const sourceProduct = source?.product;
    const checkedKind: ChatRelationshipTraversalKindV1 | undefined =
      sourceProduct === "confluence"
        ? "confluence-to-jira-reference"
        : sourceProduct === "jira"
          ? "jira-to-confluence-remote-link"
          : undefined;
    if (checkedKind && this.#plan.relationshipTraversals.some((entry) =>
      entry.kind === checkedKind
    ) && !this.#ledger.relationshipTraversalsChecked.includes(checkedKind)) {
      this.#ledger.relationshipTraversalsChecked.push(checkedKind);
    }
    for (const anchor of result.relatedAnchors ?? []) {
      const kind: ChatRelationshipTraversalKindV1 = anchor.product === "jira"
        ? "confluence-to-jira-reference"
        : "jira-to-confluence-remote-link";
      if (!this.#plan.relationshipTraversals.some((entry) => entry.kind === kind)) continue;
      if (!this.#ledger.relationshipTraversalsChecked.includes(kind)) {
        this.#ledger.relationshipTraversalsChecked.push(kind);
      }
      // The opaque anchor intentionally has no canonical identity yet. Its
      // eventual bound read creates the candidate without persisting the ref.
      void callId;
    }
  }

  #upsertCandidate(
    source: ReturnType<typeof observedSource>,
    discovery: ChatCandidateDiscoveryV1,
    authority: ChatCandidateLedgerEntryV1["authority"],
  ): ChatCandidateLedgerEntryV1 {
    if (!canonicalUrlMatchesSourceV1({
      ...source,
      siteOrigin: this.#siteOrigin,
    })) {
      invalid("Chat candidate canonical URL does not match its source identity.");
    }
    let candidate = this.#candidateBySource.get(source.sourceId);
    if (!candidate) {
      candidate = {
        candidateId: `candidate:${stableFingerprint(source.sourceId).slice("fnv1a32:".length)}`,
        sourceId: source.sourceId,
        product: source.product,
        title: source.title,
        canonicalUrl: source.canonicalUrl,
        authority,
        versionsObserved: source.version ? [source.version] : [],
        discoveries: [],
        state: "discovered",
      };
      this.#candidateBySource.set(source.sourceId, candidate);
    } else {
      if (candidate.product !== source.product || !canonicalUrlMatchesSourceV1({
        sourceId: candidate.sourceId,
        product: candidate.product,
        canonicalUrl: candidate.canonicalUrl,
        siteOrigin: this.#siteOrigin,
      })) {
        invalid("Chat candidate canonical identity changed during the turn.");
      }
      const hasCanonicalEntityIdentity = source.product === "confluence"
        ? /^wiki:[1-9][0-9]{0,127}$/u.test(source.sourceId)
        : /^jira:[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}$/u.test(source.sourceId);
      if (candidate.canonicalUrl !== source.canonicalUrl && !hasCanonicalEntityIdentity) {
        invalid("Chat candidate canonical identity changed during the turn.");
      }
      if (source.product === "confluence" &&
          !candidate.canonicalUrl.includes("/wiki/spaces/") &&
          source.canonicalUrl.includes("/wiki/spaces/")) {
        candidate.canonicalUrl = source.canonicalUrl;
      }
      candidate.title = source.title;
      if (source.version && !candidate.versionsObserved.includes(source.version)) {
        candidate.versionsObserved.push(source.version);
        candidate.versionsObserved.sort((left, right) => left.localeCompare(right, "en-US"));
      }
      if (authority === "bound" || authority === "explicit-relationship") {
        candidate.authority = authority;
      }
    }
    if (!candidate.discoveries.some((entry) =>
      entry.callId === discovery.callId &&
      entry.searchId === discovery.searchId &&
      entry.queryVariantId === discovery.queryVariantId &&
      entry.page === discovery.page && entry.rank === discovery.rank
    )) {
      candidate.discoveries.push(discovery);
    }
    return candidate;
  }

  markTraversalChecked(kind: ChatRelationshipTraversalKindV1): void {
    if (!this.#plan.relationshipTraversals.some((entry) => entry.kind === kind)) {
      invalid("Chat relationship traversal was not admitted by the plan.");
    }
    if (!this.#ledger.relationshipTraversalsChecked.includes(kind)) {
      this.#ledger.relationshipTraversalsChecked.push(kind);
      this.#ledger.relationshipTraversalsChecked.sort((left, right) =>
        left.localeCompare(right, "en-US")
      );
    }
  }

  async finalize(reason = "retrieval-boundary-reached"): Promise<ChatRetrievalAssessmentV1> {
    for (const candidate of this.#candidateBySource.values()) {
      if (candidate.state === "discovered") {
        candidate.state = "excluded";
        candidate.exclusionReason = "not-admitted-by-ranking";
      } else if (candidate.state === "admitted") {
        candidate.state = "deferred";
        candidate.deferredReason = cleanText(reason, "Chat candidate deferral reason", 240);
      }
    }
    this.#ledger.finalizedAt = new Date(this.#now()).toISOString();
    this.#ledger.updatedAt = this.#ledger.finalizedAt;
    await this.#persist();
    const assessment = this.assessment();
    await this.#workspace.writeFile(
      CHAT_RETRIEVAL_ASSESSMENT_PATH_V1,
      JSON.stringify(assessment),
    );
    return assessment;
  }

  assessment(): ChatRetrievalAssessmentV1 {
    const snapshot = this.snapshot();
    const anchorSourceCount = snapshot.candidates.filter((candidate) =>
      candidate.authority === "bound" && candidate.state === "detail-read"
    ).length;
    const terminalSearches = snapshot.searches.filter((search) => search.terminal).length;
    const admitted = snapshot.candidates.filter((candidate) =>
      ["admitted", "detail-read", "deferred"].includes(candidate.state)
    );
    const detailed = snapshot.candidates.filter((candidate) => candidate.state === "detail-read");
    const allAdmittedTerminal = admitted.every((candidate) =>
      candidate.state === "detail-read" || candidate.state === "deferred"
    );
    const plannedVariantCount = this.#plan.searches.reduce(
      (total, search) => total + search.variants.length,
      0,
    );
    const completedVariantCount = snapshot.searches.filter((search) => search.terminal).length;
    const queryVariantsSaturated = plannedVariantCount === 0 ||
      (completedVariantCount === plannedVariantCount && snapshot.searches.every((search) =>
        search.terminal
      ));
    const traversalKinds = new Set(snapshot.relationshipTraversalsChecked);
    const signalState = new Map<ChatRetrievalCompletionSignalV1, boolean>([
      ["all-anchors-read", this.#plan.anchors.length === 0 || anchorSourceCount >= this.#plan.anchors.length],
      ["all-searches-terminal", this.#plan.searches.length === 0 ||
        terminalSearches === plannedVariantCount],
      ["all-admitted-candidates-terminal", allAdmittedTerminal],
      ["relationship-traversals-checked", this.#plan.relationshipTraversals.every((traversal) =>
        traversalKinds.has(traversal.kind)
      )],
      ["detail-evidence-present", detailed.length > 0],
      ["query-variants-saturated", queryVariantsSaturated],
    ]);
    const completionSignals = this.#plan.completionSignals.map((signal) => ({
      signal,
      satisfied: signalState.get(signal) === true,
    }));
    const deferred = snapshot.candidates.filter((candidate) => candidate.state === "deferred");
    const reasons = [
      ...completionSignals.filter((signal) => !signal.satisfied)
        .map((signal) => `completion-signal:${signal.signal}`),
      ...(this.#plan.unresolvedTerms.length > 0 ? ["unresolved-terms"] : []),
      ...(deferred.length > 0 ? ["deferred-admitted-candidates"] : []),
      ...((snapshot.relatedScopeProposals?.length ?? 0) > 0
        ? ["related-scope-approval-required"]
        : []),
    ];
    const canonicalCorrect = snapshot.candidates.filter((candidate) => {
      try {
        const url = new URL(candidate.canonicalUrl);
        return url.origin === this.#siteOrigin &&
          (candidate.product === "jira"
            ? url.pathname.includes("/browse/")
            : url.pathname.includes("/wiki/"));
      } catch {
        return false;
      }
    }).length;
    const expected = this.#expectedSourceIds;
    const discoveredIds = new Set(snapshot.candidates.map((candidate) => candidate.sourceId));
    const wrong = expected
      ? snapshot.candidates.filter((candidate) => !expected.has(candidate.sourceId)).length
      : 0;
    return {
      schema: CHAT_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
      sufficient: reasons.length === 0,
      reasons,
      completionSignals,
      metrics: {
        discoveredCandidates: snapshot.candidates.length,
        admittedCandidates: admitted.length,
        detailReadCandidates: detailed.length,
        excludedCandidates: snapshot.candidates.filter((candidate) =>
          candidate.state === "excluded"
        ).length,
        deferredCandidates: deferred.length,
        detailReadCoverage: admitted.length === 0 ? (detailed.length > 0 ? 1 : 0) :
          detailed.length / admitted.length,
        canonicalUrlCorrectness: snapshot.candidates.length === 0 ? 0 :
          canonicalCorrect / snapshot.candidates.length,
        observedRecall: expected
          ? [...expected].filter((sourceId) => discoveredIds.has(sourceId)).length /
            Math.max(1, expected.size)
          : null,
        wrongSourceRate: expected
          ? wrong / Math.max(1, snapshot.candidates.length)
          : null,
        atlassianHttpCalls: snapshot.atlassianHttpCalls,
        latencyMs: Math.max(0, this.#now() - Date.parse(snapshot.startedAt)),
      },
    };
  }

  #persist(): Promise<void> {
    const snapshot = this.snapshot();
    this.#persistTail = this.#persistTail.then(() =>
      this.#workspace.writeFile(CHAT_CANDIDATE_LEDGER_PATH_V1, JSON.stringify(snapshot))
    );
    return this.#persistTail;
  }
}
