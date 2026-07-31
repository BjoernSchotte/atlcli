import {
  RESEARCH_SCOPE_SOURCE_PRECEDENCE_V1,
  type ResearchProduct,
  type ResearchScopeAuthorityV1,
  type ResearchScopeBindingV1,
  type ResearchScopeEntityKindV1,
  type ResearchScopeSeedV1,
  type ResearchScopeSourceV1,
  type ResearchScopeV1,
} from "./contracts.js";

export type {
  ResearchScopeAuthorityV1,
  ResearchScopeBindingV1,
  ResearchScopeEntityKindV1,
  ResearchScopeSeedV1,
  ResearchScopeSourceV1,
} from "./contracts.js";

export interface ResearchScopeMentionV1 {
  id: string;
  productHint?: ResearchProduct;
  entityKindHint?: ResearchScopeEntityKindV1;
  source: ResearchScopeSourceV1;
  text: string;
  normalizedText: string;
  questionTextRange?: { start: number; end: number };
  exactReference?: string;
}

export const RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1 =
  "atlcli.research-scope-mention-proposal/v1" as const;

/**
 * Model-proposed mention. The host accepts it only when text and normalization
 * exactly match the referenced question range.
 */
export interface ResearchScopeMentionProposalV1 {
  schema: typeof RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1;
  id: string;
  productHint?: ResearchProduct;
  entityKindHint?: ResearchScopeEntityKindV1;
  text: string;
  normalizedText: string;
  questionTextRange: { start: number; end: number };
  exactReference?: string;
}

export interface ResearchScopeCandidateV1 {
  id: string;
  tenantOrigin: string;
  product: ResearchProduct;
  entityKind: ResearchScopeEntityKindV1;
  entityRef: string;
  key?: string;
  name: string;
  aliases?: string[];
  canonicalUrl?: string;
  status?: "current" | "archived";
  match?: "exact_key" | "exact_name" | "alias" | "current_context" | "exact_link" | "prefix" | "fuzzy";
  accessible: true;
  providerFreshnessAt: string;
}

export interface ResearchScopeResolutionV1 {
  mentionId: string;
  state: "resolved" | "ambiguous" | "not_found" | "unavailable" | "incomplete";
  candidateIds: string[];
  resolvedCandidateId?: string;
  uniquenessProof?: "exact_key_lookup" | "exact_reference_lookup" | "provider_exact_query" | "complete_catalog";
  catalogComplete: boolean;
  requiresUserChoice: boolean;
}

export interface ResearchScopeResolutionInputV1 {
  mention: ResearchScopeMentionV1;
  candidates: readonly ResearchScopeCandidateV1[];
  catalogComplete: boolean;
  expectedTenantOrigin: string;
  maxCandidates?: number;
  allowArchived?: boolean;
}

const MATCH_RANK: Record<NonNullable<ResearchScopeCandidateV1["match"]>, number> = {
  exact_key: 500,
  exact_name: 400,
  alias: 300,
  current_context: 250,
  exact_link: 240,
  prefix: 100,
  fuzzy: 50,
};

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function matchFor(mention: ResearchScopeMentionV1, candidate: ResearchScopeCandidateV1): NonNullable<ResearchScopeCandidateV1["match"]> | undefined {
  if (
    mention.exactReference &&
    candidate.match === "exact_link" &&
    candidate.canonicalUrl === mention.exactReference
  ) {
    return "exact_link";
  }
  const needle = mention.normalizedText.trim() || normalize(mention.text);
  const key = candidate.key ? normalize(candidate.key) : "";
  const name = normalize(candidate.name);
  if (key && needle === key) return "exact_key";
  if (needle === name) return "exact_name";
  if (candidate.aliases?.some((alias) => normalize(alias) === needle)) return "alias";
  if (needle && (name.startsWith(needle) || needle.startsWith(name))) return "prefix";
  if (needle && name.split(" ").some((word) => needle.split(" ").includes(word))) return "fuzzy";
  return undefined;
}

export function normalizeResearchScopeMentionText(value: string): string {
  return normalize(value);
}

function invalidMention(message: string): never {
  throw new Error(message);
}

function isExactCurrentTenantReference(value: string, expectedTenantOrigin: string): boolean {
  try {
    const reference = new URL(value);
    return reference.origin === expectedTenantOrigin &&
      (reference.pathname.startsWith("/browse/") || reference.pathname.startsWith("/wiki/"));
  } catch {
    return false;
  }
}

/**
 * Convert untrusted model proposals into host-verified natural-language
 * mentions. No catalog lookup may run on the proposal objects themselves.
 */
export function validateResearchScopeMentionProposalsV1(input: {
  question: string;
  proposals: readonly ResearchScopeMentionProposalV1[];
  expectedTenantOrigin: string;
  maxMentions?: number;
}): ResearchScopeMentionV1[] {
  const maximum = Math.max(1, Math.min(input.maxMentions ?? 8, 12));
  if (typeof input.question !== "string" || input.question.trim() === "" || input.question.length > 4_000) {
    invalidMention("Research question is invalid for scope mention validation.");
  }
  if (!Array.isArray(input.proposals) || input.proposals.length > maximum) {
    invalidMention("Research scope mention proposal count is invalid.");
  }
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(input.expectedTenantOrigin).origin;
  } catch {
    invalidMention("Expected research tenant origin is invalid.");
  }
  if (expectedOrigin !== input.expectedTenantOrigin || !expectedOrigin.startsWith("https://")) {
    invalidMention("Expected research tenant origin must be an HTTPS origin.");
  }
  const seenIds = new Set<string>();
  const accepted = input.proposals.map((proposal): ResearchScopeMentionV1 => {
    if (!proposal || proposal.schema !== RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1) {
      invalidMention("Unsupported research scope mention proposal schema.");
    }
    if (!/^mention:[A-Za-z0-9._-]{1,80}$/.test(proposal.id) || seenIds.has(proposal.id)) {
      invalidMention("Research scope mention proposal ID is invalid or duplicated.");
    }
    seenIds.add(proposal.id);
    const { start, end } = proposal.questionTextRange ?? {};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > input.question.length) {
      invalidMention("Research scope mention question range is invalid.");
    }
    const exactText = input.question.slice(start, end);
    if (exactText !== proposal.text || exactText.trim() === "" || exactText.length > 240) {
      invalidMention("Research scope mention text does not match its exact question range.");
    }
    const normalizedText = normalizeResearchScopeMentionText(exactText);
    if (!normalizedText || proposal.normalizedText !== normalizedText) {
      invalidMention("Research scope mention normalization is not host-verifiable.");
    }
    if (proposal.productHint && proposal.productHint !== "jira" && proposal.productHint !== "confluence") {
      invalidMention("Research scope mention product hint is invalid.");
    }
    if (proposal.entityKindHint && !["project", "space", "issue", "page"].includes(proposal.entityKindHint)) {
      invalidMention("Research scope mention entity-kind hint is invalid.");
    }
    if (proposal.productHint === "jira" && proposal.entityKindHint && !["project", "issue"].includes(proposal.entityKindHint)) {
      invalidMention("Research scope mention product and entity-kind hints conflict.");
    }
    if (proposal.productHint === "confluence" && proposal.entityKindHint && !["space", "page"].includes(proposal.entityKindHint)) {
      invalidMention("Research scope mention product and entity-kind hints conflict.");
    }
    if (proposal.exactReference && !isExactCurrentTenantReference(proposal.exactReference, expectedOrigin)) {
      invalidMention("Research scope exact reference is outside the current tenant or unsupported.");
    }
    return {
      id: proposal.id,
      ...(proposal.productHint ? { productHint: proposal.productHint } : {}),
      ...(proposal.entityKindHint ? { entityKindHint: proposal.entityKindHint } : {}),
      source: proposal.exactReference ? "exact_link" : "natural_language",
      text: exactText,
      normalizedText,
      questionTextRange: { start, end },
      ...(proposal.exactReference ? { exactReference: proposal.exactReference } : {}),
    };
  });
  const byRange = [...accepted].sort((left, right) =>
    left.questionTextRange!.start - right.questionTextRange!.start ||
    left.questionTextRange!.end - right.questionTextRange!.end,
  );
  for (let index = 1; index < byRange.length; index += 1) {
    if (byRange[index]!.questionTextRange!.start < byRange[index - 1]!.questionTextRange!.end) {
      invalidMention("Research scope mention ranges must not overlap.");
    }
  }
  return accepted;
}

export function resolveResearchScopeMentionV1(input: ResearchScopeResolutionInputV1): ResearchScopeResolutionV1 {
  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? 8, 20));
  const ranked = input.candidates
    .filter((candidate) => candidate.tenantOrigin === input.expectedTenantOrigin && candidate.accessible && (!input.mention.productHint || candidate.product === input.mention.productHint) && (!input.mention.entityKindHint || candidate.entityKind === input.mention.entityKindHint) && (input.allowArchived || candidate.status !== "archived"))
    .map((candidate) => ({ candidate, match: matchFor(input.mention, candidate) }))
    .filter((entry): entry is { candidate: ResearchScopeCandidateV1; match: NonNullable<ResearchScopeCandidateV1["match"]> } => Boolean(entry.match))
    .sort((left, right) => MATCH_RANK[right.match] - MATCH_RANK[left.match] || left.candidate.id.localeCompare(right.candidate.id));
  const candidateIds = ranked.slice(0, maxCandidates).map(({ candidate }) => candidate.id);
  const exactKey = ranked.filter(({ match }) => match === "exact_key");
  if (exactKey.length === 1) return { mentionId: input.mention.id, state: "resolved", candidateIds, resolvedCandidateId: exactKey[0]!.candidate.id, uniquenessProof: "exact_key_lookup", catalogComplete: input.catalogComplete, requiresUserChoice: false };
  const exactReference = ranked.filter(({ match }) => match === "exact_link");
  if (exactReference.length === 1) return { mentionId: input.mention.id, state: "resolved", candidateIds, resolvedCandidateId: exactReference[0]!.candidate.id, uniquenessProof: "exact_reference_lookup", catalogComplete: input.catalogComplete, requiresUserChoice: false };
  const exactName = ranked.filter(({ match }) => match === "exact_name");
  if (exactName.length === 1 && input.catalogComplete) return { mentionId: input.mention.id, state: "resolved", candidateIds, resolvedCandidateId: exactName[0]!.candidate.id, uniquenessProof: "complete_catalog", catalogComplete: true, requiresUserChoice: false };
  const exactAlias = ranked.filter(({ match }) => match === "alias");
  if (exactAlias.length === 1 && input.catalogComplete) return { mentionId: input.mention.id, state: "resolved", candidateIds, resolvedCandidateId: exactAlias[0]!.candidate.id, uniquenessProof: "complete_catalog", catalogComplete: true, requiresUserChoice: false };
  if (ranked.length > 0) return { mentionId: input.mention.id, state: input.catalogComplete ? "ambiguous" : "incomplete", candidateIds, catalogComplete: input.catalogComplete, requiresUserChoice: true };
  return { mentionId: input.mention.id, state: input.catalogComplete ? "not_found" : "incomplete", candidateIds: [], catalogComplete: input.catalogComplete, requiresUserChoice: !input.catalogComplete };
}

export function createResearchScopeBindingV1(input: { candidate: ResearchScopeCandidateV1; source: ResearchScopeSourceV1; authority: "approved" | "locked"; mentionId?: string; approvedAt?: string; bindingId?: string }): ResearchScopeBindingV1 {
  return { id: input.bindingId ?? `scope-binding:${input.candidate.id}`, tenantOrigin: input.candidate.tenantOrigin, product: input.candidate.product, entityKind: input.candidate.entityKind, entityRef: input.candidate.entityRef, ...(input.candidate.key ? { key: input.candidate.key } : {}), name: input.candidate.name, source: input.source, authority: input.authority, ...(input.mentionId ? { mentionId: input.mentionId } : {}), candidateId: input.candidate.id, ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}) };
}

/** Build a deterministic whole-scope seed for a CLI/UI/context key. */
export function createResearchKeyScopeSeedV1(input: {
  tenantOrigin: string;
  product: "jira" | "confluence";
  key: string;
  source: ResearchScopeSourceV1;
  authority: "approved" | "locked";
}): ResearchScopeSeedV1 {
  const key = input.product === "jira" ? input.key.trim().toUpperCase() : input.key.trim();
  const entityKind = input.product === "jira" ? "project" : "space";
  const encodedKey = encodeURIComponent(key);
  return {
    binding: {
      id: `scope-binding:${input.source}:${input.product}:${encodedKey}`,
      tenantOrigin: input.tenantOrigin,
      product: input.product,
      entityKind,
      entityRef: `scope-key:${input.product}:${encodedKey}`,
      key,
      name: key,
      source: input.source,
      authority: input.authority,
    },
    precedence: scopeSourcePrecedence(input.source),
  };
}

export function selectResearchScopeSeedsV1(seeds: readonly ResearchScopeSeedV1[]): ResearchScopeBindingV1[] {
  const selected = new Map<string, ResearchScopeSeedV1[]>();
  for (const seed of seeds) {
    const key = `${seed.binding.tenantOrigin}:${seed.binding.product}:${seed.binding.entityKind}`;
    const current = selected.get(key) ?? [];
    const currentPrecedence = current[0]?.precedence;
    if (currentPrecedence === undefined || seed.precedence > currentPrecedence) {
      selected.set(key, [seed]);
    } else if (
      seed.precedence === currentPrecedence &&
      !current.some((entry) => entry.binding.entityRef === seed.binding.entityRef)
    ) {
      current.push(seed);
    }
  }
  return [...selected.values()]
    .flat()
    .sort((left, right) => right.precedence - left.precedence || left.binding.id.localeCompare(right.binding.id))
    .map(({ binding }) => binding);
}

export function scopeSourcePrecedence(source: ResearchScopeSourceV1): number {
  return RESEARCH_SCOPE_SOURCE_PRECEDENCE_V1[source];
}

export function projectApprovedWholeScopeV1(bindings: readonly ResearchScopeBindingV1[], base: ResearchScopeV1): ResearchScopeV1 {
  const jiraProjectKeys = new Set(base.jiraProjectKeys);
  const confluenceSpaceKeys = new Set(base.confluenceSpaceKeys);
  for (const binding of bindings) {
    if (binding.authority !== "approved" && binding.authority !== "locked") continue;
    if (binding.entityKind === "project" && binding.product === "jira" && binding.key) jiraProjectKeys.add(binding.key.toUpperCase());
    if (binding.entityKind === "space" && binding.product === "confluence" && binding.key) confluenceSpaceKeys.add(binding.key);
  }
  return { ...base, jiraProjectKeys: [...jiraProjectKeys], confluenceSpaceKeys: [...confluenceSpaceKeys] };
}
