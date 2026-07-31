import type { ResearchProduct, ResearchScopeV1 } from "./contracts.js";

export type ResearchScopeEntityKindV1 = "project" | "space" | "issue" | "page";
export type ResearchScopeSourceV1 =
  | "cli_flag"
  | "ui_added"
  | "natural_language"
  | "current_context"
  | "profile_default"
  | "global_default"
  | "exact_link"
  | "research_discovery";
export type ResearchScopeAuthorityV1 = "candidate" | "resolved" | "approved" | "locked";

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

export interface ResearchScopeBindingV1 {
  id: string;
  tenantOrigin: string;
  product: ResearchProduct;
  entityKind: ResearchScopeEntityKindV1;
  entityRef: string;
  key?: string;
  name: string;
  source: ResearchScopeSourceV1;
  authority: ResearchScopeAuthorityV1;
  mentionId?: string;
  candidateId?: string;
  approvedAt?: string;
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

export interface ResearchScopeSeedV1 {
  binding: ResearchScopeBindingV1;
  precedence: number;
}

const SOURCE_PRECEDENCE: Record<ResearchScopeSourceV1, number> = {
  cli_flag: 500,
  ui_added: 500,
  natural_language: 400,
  current_context: 300,
  profile_default: 200,
  global_default: 100,
  exact_link: 50,
  research_discovery: 0,
};

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
  return SOURCE_PRECEDENCE[source];
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
