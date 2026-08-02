import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  type ResearchLimitsV1,
  type ResearchOneShotPolicyV1,
  type ResearchProduct,
  type ResearchRequestV1,
  type ResearchRequestedEffortV1,
  type ResearchRequestedPlanApprovalV1,
  type ResearchRequestedReconciliationV1,
  type ResearchResolvedEffortV1,
  type ResearchResolvedPlanApprovalV1,
  type ResearchScopeBindingV1,
  type ResearchScopeExpansionModeV1,
  type ResearchScopeV1,
  type ResearchTimeWindowV1,
} from "./contracts.js";
export type {
  ResearchRequestedEffortV1,
  ResearchRequestedPlanApprovalV1,
  ResearchRequestedReconciliationV1,
  ResearchResolvedEffortV1,
  ResearchResolvedPlanApprovalV1,
  ResearchScopeExpansionModeV1,
} from "./contracts.js";
import type {
  ResearchScopeCandidateV1,
  ResearchScopeMentionV1,
  ResearchScopeResolutionV1,
} from "./scope-discovery.js";
import {
  RESEARCH_CLARIFICATION_REQUIRED_SCHEMA_V1,
  type ResearchBriefClarificationRequiredV1,
} from "./scope-resolution.js";

export const RESEARCH_BRIEF_SCHEMA_V1 = "atlcli.research-brief/v1" as const;
export const RESEARCH_SCOPE_DISCOVERY_POLICY_SCHEMA_V1 =
  "atlcli.research-scope-discovery-policy/v1" as const;

export interface ResearchCoverageTargetV1 {
  id: string;
  question: string;
  required: boolean;
  sourceClasses: ResearchProduct[];
  minimumDistinctSources: number;
}

export interface ResearchClarificationQuestionV1 {
  id: string;
  prompt: string;
  required: boolean;
  scopeMentionId?: string;
  candidateIds?: string[];
}

export interface ResearchBriefAssumptionV1 {
  id: string;
  text: string;
  requiresUserDecision: boolean;
  status: "proposed" | "accepted" | "rejected";
}

export interface ResearchScopeDiscoveryPolicyV1 {
  schema: typeof RESEARCH_SCOPE_DISCOVERY_POLICY_SCHEMA_V1;
  catalogDiscovery: "on";
  expansionMode: ResearchScopeExpansionModeV1;
  maxCatalogPagesPerCapability: number;
  maxCandidatesPerMention: number;
  maxCatalogResultBytes: number;
  maxExactLinkedEntities: number;
  maxScopeExpansionProposals: number;
}

export interface ResearchBriefV1 {
  schema: typeof RESEARCH_BRIEF_SCHEMA_V1;
  sessionId: string;
  turnId: string;
  revision: number;
  objective: string;
  audience?: string;
  decisionToSupport?: string;
  scope: ResearchScopeV1;
  scopeMentions: ResearchScopeMentionV1[];
  scopeCandidates: ResearchScopeCandidateV1[];
  scopeBindings: ResearchScopeBindingV1[];
  scopeResolutions: ResearchScopeResolutionV1[];
  scopeDiscoveryPolicy: ResearchScopeDiscoveryPolicyV1;
  asOf: string;
  timezone: string;
  resolvedTimeWindow?: ResearchTimeWindowV1;
  requestedEffort: ResearchRequestedEffortV1;
  resolvedEffort: ResearchResolvedEffortV1;
  requestedPlanApproval: ResearchRequestedPlanApprovalV1;
  resolvedPlanApproval: ResearchResolvedPlanApprovalV1;
  requestedReconciliation: ResearchRequestedReconciliationV1;
  expectedSections: string[];
  coverageTargets: ResearchCoverageTargetV1[];
  sourceClasses: ResearchProduct[];
  limits: ResearchLimitsV1;
  clarificationQuestions: ResearchClarificationQuestionV1[];
  assumptions: ResearchBriefAssumptionV1[];
}

/**
 * Recreate the immutable retrieval request from a durable brief.  A resume
 * must not accept a new question, scope, limit, or provider selection from a
 * host message; those choices are already fenced by the accepted brief.
 */
export function researchRequestFromBriefV1(brief: ResearchBriefV1): ResearchRequestV1 {
  return {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: brief.objective,
    scope: structuredClone(brief.scope),
    limits: structuredClone(brief.limits),
    wikiProvider: "rest",
  };
}

/** Recreate the immutable execution policy from a durable brief. */
export function researchPolicyFromBriefV1(brief: ResearchBriefV1): ResearchOneShotPolicyV1 {
  return {
    schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
    requestedEffort: brief.requestedEffort,
    requestedPlanApproval: brief.requestedPlanApproval,
    scopeExpansionMode: brief.scopeDiscoveryPolicy.expansionMode,
    requestedReconciliation: brief.requestedReconciliation,
  };
}

export const RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1 =
  "atlcli.research-brief-preflight-outcome/v1" as const;

export type ResearchBriefPreflightOutcomeV1 =
  | {
      schema: typeof RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1;
      kind: "ready";
      brief: ResearchBriefV1;
    }
  | {
      schema: typeof RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1;
      kind: "clarification_required";
      clarification: ResearchBriefClarificationRequiredV1;
    };

export const DEFAULT_RESEARCH_SCOPE_DISCOVERY_POLICY_V1: Readonly<ResearchScopeDiscoveryPolicyV1> = {
  schema: RESEARCH_SCOPE_DISCOVERY_POLICY_SCHEMA_V1,
  catalogDiscovery: "on",
  expansionMode: "ask",
  maxCatalogPagesPerCapability: 5,
  maxCandidatesPerMention: 8,
  maxCatalogResultBytes: 128_000,
  maxExactLinkedEntities: 8,
  maxScopeExpansionProposals: 4,
};

function hasAny(value: string, terms: readonly string[]): boolean {
  const lower = value.toLocaleLowerCase("en-US");
  return terms.some((term) => lower.includes(term));
}

export function resolveResearchEffortV1(input: {
  requested: ResearchRequestedEffortV1;
  objective: string;
  sourceClasses: readonly ResearchProduct[];
}): ResearchResolvedEffortV1 {
  if (input.requested !== "auto") return input.requested;
  const crossProduct = input.sourceClasses.includes("jira") && input.sourceClasses.includes("confluence");
  if (hasAny(input.objective, ["contradict", "widerspruch", "exhaustive", "vollständig", "deep research", "hierarchy", "historical trend"])) {
    return "deep";
  }
  if (crossProduct || hasAny(input.objective, ["compare", "relate", "relationship", "analyse", "analyze", "mapping", "zuord", "gehören"])) {
    return "analysis";
  }
  return "lookup";
}

export function resolveResearchPlanApprovalV1(input: {
  requested: ResearchRequestedPlanApprovalV1;
  resolvedEffort: ResearchResolvedEffortV1;
}): ResearchResolvedPlanApprovalV1 {
  if (input.requested === "automatic" || input.requested === "required") return input.requested;
  return input.resolvedEffort === "deep" ? "required" : "automatic";
}

function normalizedProducts(scope: ResearchScopeV1, requested?: readonly ResearchProduct[]): ResearchProduct[] {
  const products = requested?.length
    ? [...requested]
    : [
        ...(scope.jiraProjectKeys.length > 0 ? ["jira" as const] : []),
        ...(scope.confluenceSpaceKeys.length > 0 ? ["confluence" as const] : []),
      ];
  const unique = [...new Set(products)];
  return unique.length > 0 ? unique : ["jira", "confluence"];
}

function boundedUnique(values: readonly string[], maximumItems: number, maximumLength: number, label: string): string[] {
  if (values.length > maximumItems) throw new Error(`${label} exceeds its item limit.`);
  const result = values.map((value) => value.trim());
  if (result.some((value) => !value || value.length > maximumLength)) throw new Error(`${label} contains an invalid value.`);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result;
}

function validTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} must be an ISO timestamp.`);
  return value;
}

function validTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error("Research brief timezone is invalid.");
  }
}

export interface CreateResearchBriefInputV1 {
  sessionId: string;
  turnId: string;
  revision?: number;
  objective: string;
  scope: ResearchScopeV1;
  scopeMentions?: readonly ResearchScopeMentionV1[];
  scopeCandidates?: readonly ResearchScopeCandidateV1[];
  scopeBindings?: readonly ResearchScopeBindingV1[];
  scopeResolutions?: readonly ResearchScopeResolutionV1[];
  scopeDiscoveryPolicy?: ResearchScopeDiscoveryPolicyV1;
  asOf: string;
  timezone: string;
  requestedEffort?: ResearchRequestedEffortV1;
  requestedPlanApproval?: ResearchRequestedPlanApprovalV1;
  requestedReconciliation?: ResearchRequestedReconciliationV1;
  sourceClasses?: readonly ResearchProduct[];
  limits?: ResearchLimitsV1;
  audience?: string;
  decisionToSupport?: string;
  expectedSections?: readonly string[];
  coverageTargets?: readonly ResearchCoverageTargetV1[];
  clarificationQuestions?: readonly ResearchClarificationQuestionV1[];
  assumptions?: readonly ResearchBriefAssumptionV1[];
}

/** Construct the host-owned fields of the accepted one-shot brief. */
export function createResearchBriefV1(input: CreateResearchBriefInputV1): ResearchBriefV1 {
  if (!/^research-session:[A-Za-z0-9._-]{1,120}$/.test(input.sessionId)) throw new Error("Research brief sessionId is invalid.");
  if (!/^research-turn:[A-Za-z0-9._-]{1,120}$/.test(input.turnId)) throw new Error("Research brief turnId is invalid.");
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Research brief revision is invalid.");
  const objective = input.objective.trim();
  if (!objective || objective.length > 4_000) throw new Error("Research brief objective is invalid.");
  const sourceClasses = normalizedProducts(input.scope, input.sourceClasses);
  const requestedEffort = input.requestedEffort ?? "auto";
  const resolvedEffort = resolveResearchEffortV1({ requested: requestedEffort, objective, sourceClasses });
  const requestedPlanApproval = input.requestedPlanApproval ?? "default";
  const resolvedPlanApproval = resolveResearchPlanApprovalV1({ requested: requestedPlanApproval, resolvedEffort });
  const expectedSections = boundedUnique(
    input.expectedSections ?? ["Executive summary", "Findings", "Relationships", "Limitations", "Sources"],
    12,
    120,
    "Research brief expected sections",
  );
  const coverageTargets = input.coverageTargets?.length
    ? structuredClone(input.coverageTargets)
    : [{
        id: "coverage:primary-question",
        question: objective,
        required: true,
        sourceClasses: [...sourceClasses],
        minimumDistinctSources: sourceClasses.length,
      }];
  for (const target of coverageTargets) {
    if (!/^coverage:[A-Za-z0-9._-]{1,120}$/.test(target.id) || !target.question.trim() || target.question.length > 1_000 || !Number.isSafeInteger(target.minimumDistinctSources) || target.minimumDistinctSources < 1 || target.minimumDistinctSources > 20 || target.sourceClasses.length === 0) {
      throw new Error("Research brief coverage target is invalid.");
    }
  }
  const assumptions = structuredClone(input.assumptions ?? []);
  for (const assumption of assumptions) {
    if (!/^assumption:[A-Za-z0-9._-]{1,120}$/.test(assumption.id) || !assumption.text.trim() || assumption.text.length > 1_000 || !["proposed", "accepted", "rejected"].includes(assumption.status)) throw new Error("Research brief assumption is invalid.");
    if (assumption.status === "accepted" && input.revision === undefined) throw new Error("A newly constructed brief cannot silently accept an assumption.");
  }
  const clarificationQuestions = structuredClone(input.clarificationQuestions ?? []);
  for (const question of clarificationQuestions) {
    if (!/^clarification:[A-Za-z0-9._-]{1,120}$/.test(question.id) || !question.prompt.trim() || question.prompt.length > 1_000 || (question.candidateIds?.length ?? 0) > 8) throw new Error("Research brief clarification question is invalid.");
  }
  return {
    schema: RESEARCH_BRIEF_SCHEMA_V1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    revision,
    objective,
    ...(input.audience?.trim() ? { audience: input.audience.trim().slice(0, 500) } : {}),
    ...(input.decisionToSupport?.trim() ? { decisionToSupport: input.decisionToSupport.trim().slice(0, 1_000) } : {}),
    scope: structuredClone(input.scope),
    scopeMentions: structuredClone([...(input.scopeMentions ?? [])]),
    scopeCandidates: structuredClone([...(input.scopeCandidates ?? [])]),
    scopeBindings: structuredClone([...(input.scopeBindings ?? [])]),
    scopeResolutions: structuredClone([...(input.scopeResolutions ?? [])]),
    scopeDiscoveryPolicy: structuredClone(input.scopeDiscoveryPolicy ?? DEFAULT_RESEARCH_SCOPE_DISCOVERY_POLICY_V1),
    asOf: validTimestamp(input.asOf, "Research brief asOf"),
    timezone: validTimezone(input.timezone),
    ...(input.scope.timeWindow ? { resolvedTimeWindow: structuredClone(input.scope.timeWindow) } : {}),
    requestedEffort,
    resolvedEffort,
    requestedPlanApproval,
    resolvedPlanApproval,
    requestedReconciliation: input.requestedReconciliation ?? "auto",
    expectedSections,
    coverageTargets: [...coverageTargets],
    sourceClasses,
    limits: structuredClone(input.limits ?? DEFAULT_RESEARCH_LIMITS_V1),
    clarificationQuestions: [...clarificationQuestions],
    assumptions: [...assumptions],
  };
}

export function briefRequiresClarificationV1(brief: ResearchBriefV1): boolean {
  return brief.clarificationQuestions.some((question) => question.required) ||
    brief.assumptions.some((assumption) => assumption.requiresUserDecision && assumption.status === "proposed");
}

/**
 * Preserve host-authored, non-blocking assumptions as visible report limits.
 * They remain explicitly unconfirmed; a model draft cannot turn them into an
 * accepted user decision or a sourced factual claim.
 */
export function projectResearchProposedAssumptionLimitationsV1(
  brief: ResearchBriefV1,
): string[] {
  return brief.assumptions
    .filter((assumption) => !assumption.requiresUserDecision && assumption.status === "proposed")
    .slice(0, 12)
    .map((assumption) => `Proposed assumption (not user-confirmed): ${assumption.text}`);
}

/**
 * Stop a T3 one-shot before graph composition when the host-owned brief needs
 * a user answer. This operation is pure: it cannot create a workspace, invoke
 * a provider, or start a model/subagent. T4 later persists the same typed
 * value as a durable clarification wait.
 */
export function prepareResearchBriefPreflightV1(
  brief: ResearchBriefV1,
): ResearchBriefPreflightOutcomeV1 {
  const questions = brief.clarificationQuestions.filter((question) => question.required);
  const assumptionsRequiringDecision = brief.assumptions.filter((assumption) =>
    assumption.requiresUserDecision && assumption.status === "proposed"
  );
  if (questions.length === 0 && assumptionsRequiringDecision.length === 0) {
    return {
      schema: RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "ready",
      brief: structuredClone(brief),
    };
  }
  return {
    schema: RESEARCH_BRIEF_PREFLIGHT_OUTCOME_SCHEMA_V1,
    kind: "clarification_required",
    clarification: {
      schema: RESEARCH_CLARIFICATION_REQUIRED_SCHEMA_V1,
      sessionId: brief.sessionId,
      turnId: brief.turnId,
      briefRevision: brief.revision,
      questions: structuredClone(questions),
      assumptionsRequiringDecision: structuredClone(assumptionsRequiringDecision),
    },
  };
}
