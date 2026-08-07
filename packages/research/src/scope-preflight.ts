import {
  ResearchContractError,
  normalizeResearchRequestV1,
  type ResearchRequestV1,
  type ResearchScopeBindingV1,
  type ResearchScopeEntityKindV1,
  type ResearchScopeSeedV1,
} from "./contracts.js";
import {
  RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1,
  normalizeResearchScopeMentionText,
  projectApprovedWholeScopeV1,
  scopeSourcePrecedence,
  selectResearchScopeSeedsV1,
  validateResearchScopeMentionProposalsV1,
  type ResearchScopeMentionProposalV1,
  type ResearchScopeMentionV1,
  type ResearchScopeCandidateV1,
  type ResearchScopeResolutionV1,
} from "./scope-discovery.js";
import {
  normalizeResearchScopeCandidateSelectionsV1,
  resolveInitialResearchScopeV1,
  type ResearchScopeClarificationRequiredV1,
  type ResearchScopeCatalogInvokePortV1,
  type ResearchScopeCandidateSelectionV1,
} from "./scope-resolution.js";

export const RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1 =
  "atlcli.research-scope-preflight-outcome/v1" as const;

export type ResearchScopePreflightOutcomeV1 =
  | {
      schema: typeof RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1;
      kind: "ready";
      request: ResearchRequestV1;
      mentions: ResearchScopeMentionV1[];
      resolutions: ResearchScopeResolutionV1[];
    }
  | {
      schema: typeof RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1;
      kind: "clarification_required";
      clarification: ResearchScopeClarificationRequiredV1;
      candidateChoices: ResearchScopeCandidateV1[];
      mentions: ResearchScopeMentionV1[];
      resolutions: ResearchScopeResolutionV1[];
    };

export interface ResearchScopePreflightOptionsV1 {
  candidateSelections?: ResearchScopeCandidateSelectionV1[];
}

interface MentionMatch {
  start: number;
  end: number;
  productHint: "jira" | "confluence";
  entityKindHint: ResearchScopeEntityKindV1;
  exactReference?: string;
}

function collectNamedMatches(
  question: string,
  productHint: MentionMatch["productHint"],
  entityKindHint: Extract<MentionMatch["entityKindHint"], "project" | "space">,
  noun: string,
  productPrefix: string,
): MentionMatch[] {
  const matches: MentionMatch[] = [];
  const addGroup = (expression: RegExp): void => {
    for (const match of question.matchAll(expression)) {
      const text = match[1];
      if (!text || match.index === undefined) continue;
      if (/\b(?:space|project|bereich|projekt)\b/i.test(text)) continue;
      if (new RegExp(`^(?:${productPrefix})$`, "iu").test(text.trim())) continue;
      if (/^(?:and|und|for|für|to|with|mit)$/i.test(text.trim())) continue;
      const relative = match[0].indexOf(text);
      if (relative < 0) continue;
      const start = match.index + relative;
      matches.push({
        start,
        end: start + text.length,
        productHint,
        entityKindHint,
      });
    }
  };

  const name = "([\\p{L}\\p{N}][\\p{L}\\p{N} &._'’/-]{0,119}?)";
  addGroup(new RegExp(`["“]([^"”\\n]{1,120})["”]\\s+(?:${productPrefix}\\s+)?${noun}\\b`, "giu"));
  addGroup(new RegExp(`\\b(?:in|from|within|using|use|nutze|im|aus|für|for|and|und)\\s+(?:(?:the|dem|den|der|die|das)\\s+)?${name}\\s+(?:${productPrefix}\\s+)?${noun}\\b`, "giu"));
  addGroup(new RegExp(`^\\s*(?:research|analyze|analyse|summari[sz]e|untersuche|prüfe)\\s+(?:(?:the|den|dem|der|die|das)\\s+)?${name}\\s+(?:${productPrefix}\\s+)?${noun}\\b`, "giu"));
  addGroup(new RegExp(`^\\s*fasse\\s+(?:(?:den|dem|der|die|das)\\s+)?${name}\\s+(?:${productPrefix}\\s+)?${noun}\\s+zusammen\\b`, "giu"));
  addGroup(new RegExp(`^\\s*fasse\\s+(?:(?:den|dem|der|die|das)\\s+)?(?:${productPrefix}\\s+)?${noun}\\s+${name}\\s+zusammen\\b`, "giu"));
  addGroup(new RegExp(`^\\s*(?!(?:research|analyze|analyse|summari[sz]e|untersuche|prüfe|fasse)\\b)${name}\\s+(?:${productPrefix}\\s+)?${noun}\\b`, "giu"));
  addGroup(new RegExp(`\\b(?:${productPrefix}\\s+)?${noun}(?:\\s*key)?\\s*(?::|=)?\\s+(?:named\\s+|called\\s+|namens\\s+|mit\\s+dem\\s+namen\\s+)?["“]?([A-Za-z][A-Za-z0-9._~-]{1,79})["”]?\\b`, "giu"));
  return matches;
}

function collectExactReferenceMatches(question: string, expectedTenantOrigin: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  for (const match of question.matchAll(/https:\/\/[^\s<>()"'“”]+/giu)) {
    if (match.index === undefined) continue;
    const text = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const reference = new URL(text);
      if (reference.origin !== expectedTenantOrigin) continue;
      if (/^\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+(?:\/|$)/i.test(reference.pathname)) {
        matches.push({
          start: match.index,
          end: match.index + text.length,
          productHint: "jira",
          entityKindHint: "issue",
          exactReference: text,
        });
      } else if (
        /^\/wiki\/(?:(?:spaces|display)\/[^/]+\/pages|pages)\/\d+(?:\/|$)/i.test(reference.pathname) ||
        /^\/wiki\/spaces\/[^/]+\/blog\/\d{4}\/\d{2}\/\d{2}\/\d+(?:\/|$)/i.test(reference.pathname)
      ) {
        matches.push({
          start: match.index,
          end: match.index + text.length,
          productHint: "confluence",
          entityKindHint: "page",
          exactReference: text,
        });
      } else if (/\/wiki\/(?:spaces|display)\//i.test(reference.pathname)) {
        matches.push({
          start: match.index,
          end: match.index + text.length,
          productHint: "confluence",
          entityKindHint: "space",
          exactReference: text,
        });
      } else if (/\/(?:projects|plugins\/servlet\/project-config)\//i.test(reference.pathname)) {
        matches.push({
          start: match.index,
          end: match.index + text.length,
          productHint: "jira",
          entityKindHint: "project",
          exactReference: text,
        });
      }
    } catch {
      // The host validator remains authoritative; malformed URL-like text is
      // not promoted into a proposal.
    }
  }
  return matches;
}

function overlaps(left: MentionMatch, right: MentionMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Extract only grammar-anchored whole-scope names and exact tenant URLs.
 * Every proposal is then re-validated against the exact question range before
 * it can reach a catalog. This deliberately does not treat arbitrary capital
 * words as project or space names.
 */
export function proposeResearchScopeMentionsV1(input: {
  question: string;
  expectedTenantOrigin: string;
  existingBindings?: readonly ResearchScopeBindingV1[];
  maxMentions?: number;
}): ResearchScopeMentionV1[] {
  const lockedKinds = new Set(
    (input.existingBindings ?? [])
      .filter((binding) => binding.authority === "locked")
      .map((binding) => `${binding.product}:${binding.entityKind}`),
  );
  const candidates = [
    ...collectExactReferenceMatches(input.question, input.expectedTenantOrigin),
    ...collectNamedMatches(input.question, "jira", "project", "(?:project|projekt)", "jira"),
    ...collectNamedMatches(input.question, "confluence", "space", "(?:space|bereich)", "(?:confluence|wiki)"),
  ]
    .filter((match) => !lockedKinds.has(`${match.productHint}:${match.entityKindHint}`))
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const accepted: MentionMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.some((entry) => overlaps(entry, candidate))) continue;
    accepted.push(candidate);
    if (accepted.length >= Math.max(1, Math.min(input.maxMentions ?? 8, 12))) break;
  }
  const proposals: ResearchScopeMentionProposalV1[] = accepted.map((match, index) => {
    const text = input.question.slice(match.start, match.end);
    return {
      schema: RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1,
      id: `mention:scope-${index + 1}`,
      productHint: match.productHint,
      entityKindHint: match.entityKindHint,
      text,
      normalizedText: normalizeResearchScopeMentionText(text),
      questionTextRange: { start: match.start, end: match.end },
      ...(match.exactReference ? { exactReference: match.exactReference } : {}),
    };
  });
  return validateResearchScopeMentionProposalsV1({
    question: input.question,
    proposals,
    expectedTenantOrigin: input.expectedTenantOrigin,
    maxMentions: input.maxMentions,
  });
}

function seedForBinding(binding: ResearchScopeBindingV1): ResearchScopeSeedV1 {
  return { binding, precedence: scopeSourcePrecedence(binding.source) };
}

/**
 * Resolve natural-language whole-scope mentions before graph construction.
 * The catalog-only port makes content detail reads and subagent dispatch
 * structurally unavailable during this phase.
 */
export async function prepareResearchScopePreflightV1(input: {
  request: ResearchRequestV1;
  catalog: ResearchScopeCatalogInvokePortV1;
  automaticApproval?: boolean;
  maximumCatalogPages?: number;
  candidateSelections?: readonly ResearchScopeCandidateSelectionV1[];
}): Promise<ResearchScopePreflightOutcomeV1> {
  const request = normalizeResearchRequestV1(input.request);
  const existingSeeds = request.scopeSeeds ?? [];
  const existingBindings = existingSeeds.map((seed) => seed.binding);
  const mentions = proposeResearchScopeMentionsV1({
    question: request.question,
    expectedTenantOrigin: request.scope.siteOrigin,
    existingBindings,
  });
  const candidateSelections = normalizeResearchScopeCandidateSelectionsV1(
    input.candidateSelections,
  );
  if (
    candidateSelections.some(
      (selection) => !mentions.some((mention) => mention.id === selection.mentionId),
    )
  ) {
    throw new ResearchContractError(
      "invalid-request",
      "Research scope candidate selection does not match the current question.",
    );
  }
  if (mentions.length === 0) {
    if (
      request.scope.jiraProjectKeys.length === 0 &&
      request.scope.confluenceSpaceKeys.length === 0 &&
      existingSeeds.length === 0
    ) {
      return {
        schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
        kind: "clarification_required",
        clarification: {
          schema: "atlcli.research-clarification-required/v1",
          reason: "not_found",
          mentionId: "mention:scope-required",
          candidateIds: [],
          rerunGuidance: [
            "Pass --project <KEY> and/or --space <KEY>, or name a Jira project or Confluence space in the question.",
          ],
        },
        candidateChoices: [],
        mentions: [],
        resolutions: [],
      };
    }
    return {
      schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "ready",
      request,
      mentions: [],
      resolutions: [],
    };
  }
  const resolution = await resolveInitialResearchScopeV1({
    baseScope: request.scope,
    existingBindings,
    mentions,
    catalog: input.catalog,
    automaticApproval: input.automaticApproval ?? true,
    maximumCatalogPages: input.maximumCatalogPages,
    candidateSelections,
  });
  if (resolution.kind === "clarification_required") {
    return {
      schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "clarification_required",
      clarification: resolution.clarification,
      candidateChoices: resolution.candidateChoices,
      mentions,
      resolutions: resolution.resolutions,
    };
  }
  const resolvedSeeds = resolution.bindings
    .filter((binding) => !existingBindings.some((existing) => existing.id === binding.id))
    .map(seedForBinding);
  const selectedSeeds = selectResearchScopeSeedsV1([...existingSeeds, ...resolvedSeeds])
    .map(seedForBinding);
  const projectionBase = existingSeeds.length > 0
    ? { ...request.scope, jiraProjectKeys: [], confluenceSpaceKeys: [] }
    : request.scope;
  const scope = projectApprovedWholeScopeV1(
    selectedSeeds.map((seed) => seed.binding),
    projectionBase,
  );
  return {
    schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
    kind: "ready",
    request: normalizeResearchRequestV1({
      ...request,
      scope,
      scopeSeeds: selectedSeeds,
    }),
    mentions,
    resolutions: resolution.resolutions,
  };
}
