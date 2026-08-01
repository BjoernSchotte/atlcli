import {
  ResearchContractError,
  type ResearchScopeBindingV1,
  type ResearchScopeV1,
} from "./contracts.js";
import type {
  ResearchReferenceResolveOutputV1,
  ResearchScopeCatalogCapabilityId,
  ResearchScopeCatalogPageV1,
} from "./scope-catalog.js";
import {
  createResearchScopeBindingV1,
  projectApprovedWholeScopeV1,
  RESEARCH_SCOPE_RESOLUTION_SCHEMA_V1,
  resolveResearchScopeMentionV1,
  type ResearchScopeCandidateV1,
  type ResearchScopeMentionV1,
  type ResearchScopeResolutionV1,
} from "./scope-discovery.js";

export const RESEARCH_CLARIFICATION_REQUIRED_SCHEMA_V1 =
  "atlcli.research-clarification-required/v1" as const;

export type ResearchScopeClarificationReasonV1 =
  | "ambiguous"
  | "weak_match"
  | "archived_only"
  | "unavailable"
  | "incomplete"
  | "not_found";

export interface ResearchClarificationRequiredV1 {
  schema: typeof RESEARCH_CLARIFICATION_REQUIRED_SCHEMA_V1;
  reason: ResearchScopeClarificationReasonV1;
  mentionId: string;
  candidateIds: string[];
  productHint?: "jira" | "confluence";
  entityKindHint?: "project" | "space" | "issue" | "page";
  rerunGuidance: string[];
}

export interface ResearchScopeCatalogInvokePortV1 {
  invoke(
    capability: ResearchScopeCatalogCapabilityId,
    value: unknown,
  ): Promise<ResearchScopeCatalogPageV1 | ResearchReferenceResolveOutputV1>;
}

export type ResearchInitialScopeResolutionOutcomeV1 =
  | {
      kind: "ready";
      scope: ResearchScopeV1;
      bindings: ResearchScopeBindingV1[];
      resolutions: ResearchScopeResolutionV1[];
    }
  | {
      kind: "clarification_required";
      clarification: ResearchClarificationRequiredV1;
      resolutions: ResearchScopeResolutionV1[];
    };

function catalogCapability(mention: ResearchScopeMentionV1):
  | "jira.project.search"
  | "wiki.space.search"
  | undefined {
  if (mention.productHint === "jira" || mention.entityKindHint === "project") {
    return "jira.project.search";
  }
  if (mention.productHint === "confluence" || mention.entityKindHint === "space") {
    return "wiki.space.search";
  }
  return undefined;
}

function pageInput(
  capability: "jira.project.search" | "wiki.space.search",
  mention: ResearchScopeMentionV1,
  cursorRef?: string,
): Record<string, unknown> {
  return {
    schema: capability === "jira.project.search"
      ? "atlcli.ptc/jira.project.search.input/v1"
      : "atlcli.ptc/wiki.space.search.input/v1",
    product: capability === "jira.project.search" ? "jira" : "confluence",
    entityKind: capability === "jira.project.search" ? "project" : "space",
    normalizedQuery: mention.normalizedText,
    includeArchived: true,
    ...(cursorRef ? { cursorRef } : {}),
    maxCandidates: 20,
  };
}

function isPage(value: ResearchScopeCatalogPageV1 | ResearchReferenceResolveOutputV1): value is ResearchScopeCatalogPageV1 {
  return "candidates" in value;
}

async function collectCandidates(
  catalog: ResearchScopeCatalogInvokePortV1,
  capability: "jira.project.search" | "wiki.space.search",
  mention: ResearchScopeMentionV1,
  maximumPages: number,
): Promise<{ candidates: ResearchScopeCandidateV1[]; complete: boolean }> {
  const candidates: ResearchScopeCandidateV1[] = [];
  const seen = new Set<string>();
  let cursorRef: string | undefined;
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const result = await catalog.invoke(capability, pageInput(capability, mention, cursorRef));
    if (!isPage(result)) throw new ResearchContractError("provider-error", "Scope catalog returned the wrong output shape.");
    for (const candidate of result.candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
    }
    if (!result.nextCursorRef) {
      return { candidates, complete: !result.truncated };
    }
    cursorRef = result.nextCursorRef;
  }
  return { candidates, complete: false };
}

function archivedExactCandidates(
  mention: ResearchScopeMentionV1,
  candidates: readonly ResearchScopeCandidateV1[],
  expectedTenantOrigin: string,
): string[] {
  const resolution = resolveResearchScopeMentionV1({
    mention,
    candidates,
    catalogComplete: true,
    expectedTenantOrigin,
    maxCandidates: 8,
    allowArchived: true,
  });
  if (resolution.state !== "resolved" || !resolution.resolvedCandidateId) return [];
  const candidate = candidates.find((entry) => entry.id === resolution.resolvedCandidateId);
  return candidate?.status === "archived" ? [candidate.id] : [];
}

function clarification(
  mention: ResearchScopeMentionV1,
  reason: ResearchScopeClarificationReasonV1,
  candidateIds: readonly string[],
): ResearchClarificationRequiredV1 {
  const rerunGuidance = mention.entityKindHint === "project" || mention.productHint === "jira"
    ? ["Pass an exact Jira project with --project <KEY>."]
    : mention.entityKindHint === "space" || mention.productHint === "confluence"
      ? ["Pass an exact Confluence space with --space <KEY>."]
      : ["Pass an exact Jira project with --project <KEY> or Confluence space with --space <KEY>."];
  return {
    schema: RESEARCH_CLARIFICATION_REQUIRED_SCHEMA_V1,
    reason,
    mentionId: mention.id,
    candidateIds: [...candidateIds].slice(0, 8),
    ...(mention.productHint ? { productHint: mention.productHint } : {}),
    ...(mention.entityKindHint ? { entityKindHint: mention.entityKindHint } : {}),
    rerunGuidance,
  };
}

function reasonForResolution(
  resolution: ResearchScopeResolutionV1,
  mention: ResearchScopeMentionV1,
  candidates: readonly ResearchScopeCandidateV1[],
  expectedTenantOrigin: string,
): { reason: ResearchScopeClarificationReasonV1; candidateIds: string[] } {
  const archived = archivedExactCandidates(mention, candidates, expectedTenantOrigin);
  if (archived.length > 0) return { reason: "archived_only", candidateIds: archived };
  if (resolution.state === "incomplete") return { reason: "incomplete", candidateIds: resolution.candidateIds };
  if (resolution.state === "not_found") return { reason: "not_found", candidateIds: [] };
  if (resolution.state === "unavailable") return { reason: "unavailable", candidateIds: resolution.candidateIds };
  return {
    reason: resolution.candidateIds.length > 1 ? "ambiguous" : "weak_match",
    candidateIds: resolution.candidateIds,
  };
}

/**
 * Resolve verified mention objects before content retrieval. This function has
 * no content broker or subagent dependency, so a clarification outcome cannot
 * accidentally perform detail research.
 */
export async function resolveInitialResearchScopeV1(input: {
  baseScope: ResearchScopeV1;
  existingBindings: readonly ResearchScopeBindingV1[];
  mentions: readonly ResearchScopeMentionV1[];
  catalog: ResearchScopeCatalogInvokePortV1;
  automaticApproval: boolean;
  maximumCatalogPages?: number;
}): Promise<ResearchInitialScopeResolutionOutcomeV1> {
  const resolutions: ResearchScopeResolutionV1[] = [];
  const bindings = [...input.existingBindings];
  const maximumPages = Math.max(1, Math.min(input.maximumCatalogPages ?? 5, 10));
  for (const mention of input.mentions) {
    try {
      let candidates: ResearchScopeCandidateV1[];
      let complete: boolean;
      if (mention.exactReference) {
        const result = await input.catalog.invoke("atlassian.reference.resolve", {
          schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
          reference: mention.exactReference,
          expectedTenantOrigin: input.baseScope.siteOrigin,
          expectedKinds: mention.entityKindHint ? [mention.entityKindHint] : ["project", "space", "issue", "page"],
        });
        if (isPage(result)) throw new ResearchContractError("provider-error", "Reference resolver returned the wrong output shape.");
        candidates = result.candidate ? [result.candidate] : [];
        complete = !result.unavailable;
      } else {
        const capability = catalogCapability(mention);
        if (!capability) {
          const unavailable: ResearchScopeResolutionV1 = {
            schema: RESEARCH_SCOPE_RESOLUTION_SCHEMA_V1,
            mentionId: mention.id,
            state: "unavailable",
            candidateIds: [],
            catalogComplete: false,
            requiresUserChoice: true,
          };
          resolutions.push(unavailable);
          return { kind: "clarification_required", clarification: clarification(mention, "unavailable", []), resolutions };
        }
        ({ candidates, complete } = await collectCandidates(input.catalog, capability, mention, maximumPages));
      }
      const resolution = resolveResearchScopeMentionV1({
        mention,
        candidates,
        catalogComplete: complete,
        expectedTenantOrigin: input.baseScope.siteOrigin,
        maxCandidates: 8,
      });
      resolutions.push(resolution);
      if (resolution.state !== "resolved" || !resolution.resolvedCandidateId) {
        const unresolved = reasonForResolution(resolution, mention, candidates, input.baseScope.siteOrigin);
        return {
          kind: "clarification_required",
          clarification: clarification(mention, unresolved.reason, unresolved.candidateIds),
          resolutions,
        };
      }
      const candidate = candidates.find((entry) => entry.id === resolution.resolvedCandidateId);
      if (!candidate) throw new ResearchContractError("provider-error", "Resolved scope candidate is missing.");
      bindings.push(createResearchScopeBindingV1({
        candidate,
        source: mention.source,
        authority: input.automaticApproval ? "approved" : "resolved",
        mentionId: mention.id,
      }));
    } catch (error) {
      if (!(error instanceof ResearchContractError) || error.code === "invalid-request") throw error;
      const unavailable: ResearchScopeResolutionV1 = {
        schema: RESEARCH_SCOPE_RESOLUTION_SCHEMA_V1,
        mentionId: mention.id,
        state: "unavailable",
        candidateIds: [],
        catalogComplete: false,
        requiresUserChoice: true,
      };
      resolutions.push(unavailable);
      return { kind: "clarification_required", clarification: clarification(mention, "unavailable", []), resolutions };
    }
  }
  return {
    kind: "ready",
    scope: projectApprovedWholeScopeV1(bindings, input.baseScope),
    bindings,
    resolutions,
  };
}
