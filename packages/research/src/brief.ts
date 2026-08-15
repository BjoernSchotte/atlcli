import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  type ResearchLimitsV1,
  type ResearchOneShotPolicyV1,
  type ResearchProduct,
  type ResearchReportLanguageV1,
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

/** A user answer retained as host-owned brief data, never as hidden model state. */
export interface ResearchBriefClarificationResponseV1 {
  questionId: string;
  prompt: string;
  response: string;
}

/**
 * A user-authored correction to a previously rejected research plan. Like a
 * clarification response, this is visible research context rather than a
 * privilege channel: scope, budgets, and capabilities remain host-owned
 * fields of the brief and graph.
 */
export interface ResearchBriefPlanRevisionInstructionV1 {
  id: string;
  basedOnGraphRevision: number;
  instruction: string;
  requestedAt: string;
}

export interface ResearchBriefAssumptionDecisionV1 {
  assumptionId: string;
  decision: "accepted" | "rejected";
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
  /** Optional for V1 session compatibility; new hosts preserve the chosen language. */
  reportLanguage?: ResearchReportLanguageV1;
  expectedSections: string[];
  coverageTargets: ResearchCoverageTargetV1[];
  sourceClasses: ResearchProduct[];
  limits: ResearchLimitsV1;
  clarificationQuestions: ResearchClarificationQuestionV1[];
  clarificationResponses: ResearchBriefClarificationResponseV1[];
  planRevisionInstructions: ResearchBriefPlanRevisionInstructionV1[];
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
    question: researchQuestionFromBriefV1(brief),
    scope: structuredClone(brief.scope),
    limits: structuredClone(brief.limits),
    wikiProvider: "rest",
    ...(brief.reportLanguage ? { reportLanguage: brief.reportLanguage } : {}),
  };
}

/**
 * The provider and subagents receive the accepted question plus explicitly
 * retained user answers.  This is data, not an instruction channel and not a
 * permission change: scope, budgets, and capabilities still come only from
 * the validated brief fields.
 */
export function researchQuestionFromBriefV1(brief: ResearchBriefV1): string {
  // V1 sessions written before this additive field existed remain resumable.
  const responses = brief.clarificationResponses ?? [];
  const planRevisions = brief.planRevisionInstructions ?? [];
  if (responses.length === 0 && planRevisions.length === 0) return brief.objective;
  return [
    brief.objective,
    ...(responses.length === 0 ? [] : [
      "",
      "User-provided clarification (research context, not source evidence):",
      ...responses.map((response) =>
        `- Question: ${response.prompt}\n  Answer: ${response.response}`,
      ),
    ]),
    ...(planRevisions.length === 0 ? [] : [
      "",
      "User-requested plan correction (research context, not source evidence):",
      ...planRevisions.map((revision) => `- ${revision.instruction}`),
    ]),
  ].join("\n");
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
      /** The exact body-free accepted brief that a host must persist while waiting. */
      brief: ResearchBriefV1;
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

export function resolveResearchEffortV1(input: {
  requested: ResearchRequestedEffortV1;
  objective: string;
  sourceClasses: readonly ResearchProduct[];
}): ResearchResolvedEffortV1 {
  if (input.requested !== "auto") return input.requested;
  // Auto is a capability envelope, not an instruction to run every role.
  // The central supervisor receives the bounded deep-research catalog and
  // selects the minimal useful task composition for this turn. This preserves
  // the ability to extend retrieval at a durable checkpoint when host-observed
  // coverage is incomplete, without a keyword heuristic freezing a simple
  // question into a one-shot lookup before the agent can assess it.
  return "deep";
}

export function resolveResearchPlanApprovalV1(input: {
  requested: ResearchRequestedPlanApprovalV1;
  resolvedEffort: ResearchResolvedEffortV1;
  /** An automatic envelope remains runnable unless the caller asks for review. */
  requestedEffort?: ResearchRequestedEffortV1;
}): ResearchResolvedPlanApprovalV1 {
  if (input.requested === "automatic" || input.requested === "required") return input.requested;
  if (input.requestedEffort === "auto") return "automatic";
  return input.resolvedEffort === "deep" ? "required" : "automatic";
}

function normalizedProducts(
  scope: ResearchScopeV1,
  requested?: readonly ResearchProduct[],
  scopeBindings: readonly ResearchScopeBindingV1[] = [],
): ResearchProduct[] {
  const products = requested?.length
    ? [...requested]
    : [
        ...(scope.jiraProjectKeys.length > 0 || scopeBindings.some((binding) => binding.product === "jira")
          ? ["jira" as const]
          : []),
        ...(scope.confluenceSpaceKeys.length > 0 || scopeBindings.some((binding) => binding.product === "confluence")
          ? ["confluence" as const]
          : []),
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
  reportLanguage?: ResearchReportLanguageV1;
  sourceClasses?: readonly ResearchProduct[];
  limits?: ResearchLimitsV1;
  audience?: string;
  decisionToSupport?: string;
  expectedSections?: readonly string[];
  coverageTargets?: readonly ResearchCoverageTargetV1[];
  clarificationQuestions?: readonly ResearchClarificationQuestionV1[];
  clarificationResponses?: readonly ResearchBriefClarificationResponseV1[];
  planRevisionInstructions?: readonly ResearchBriefPlanRevisionInstructionV1[];
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
  const sourceClasses = normalizedProducts(input.scope, input.sourceClasses, input.scopeBindings);
  const requestedEffort = input.requestedEffort ?? "auto";
  const resolvedEffort = resolveResearchEffortV1({ requested: requestedEffort, objective, sourceClasses });
  const requestedPlanApproval = input.requestedPlanApproval ?? "default";
  const resolvedPlanApproval = resolveResearchPlanApprovalV1({
    requested: requestedPlanApproval,
    resolvedEffort,
    requestedEffort,
  });
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
  const clarificationResponses = structuredClone(input.clarificationResponses ?? []);
  if (clarificationResponses.length > 24 ||
      new Set(clarificationResponses.map((response) => response.questionId)).size !== clarificationResponses.length) {
    throw new Error("Research brief clarification responses are invalid.");
  }
  for (const response of clarificationResponses) {
    if (!/^clarification:[A-Za-z0-9._-]{1,120}$/.test(response.questionId) ||
        !response.prompt.trim() || response.prompt.length > 1_000 ||
        !response.response.trim() || response.response.length > 2_000) {
      throw new Error("Research brief clarification response is invalid.");
    }
  }
  const planRevisionInstructions = structuredClone(input.planRevisionInstructions ?? []);
  if (planRevisionInstructions.length > 8 ||
      new Set(planRevisionInstructions.map((revisionInstruction) => revisionInstruction.id)).size !== planRevisionInstructions.length) {
    throw new Error("Research brief plan revision instructions are invalid.");
  }
  for (const revisionInstruction of planRevisionInstructions) {
    if (!/^plan-revision:[A-Za-z0-9._-]{1,120}$/.test(revisionInstruction.id) ||
        !Number.isSafeInteger(revisionInstruction.basedOnGraphRevision) || revisionInstruction.basedOnGraphRevision < 1 ||
        !revisionInstruction.instruction.trim() || revisionInstruction.instruction.length > 2_000) {
      throw new Error("Research brief plan revision instruction is invalid.");
    }
    validTimestamp(revisionInstruction.requestedAt, "Research brief plan revision timestamp");
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
    ...(input.reportLanguage ? { reportLanguage: input.reportLanguage } : {}),
    expectedSections,
    coverageTargets: [...coverageTargets],
    sourceClasses,
    limits: structuredClone(input.limits ?? DEFAULT_RESEARCH_LIMITS_V1),
    clarificationQuestions: [...clarificationQuestions],
    clarificationResponses: clarificationResponses.map((response) => ({
      questionId: response.questionId,
      prompt: response.prompt.trim(),
      response: response.response.trim(),
    })),
    planRevisionInstructions: planRevisionInstructions.map((revisionInstruction) => ({
      ...revisionInstruction,
      instruction: revisionInstruction.instruction.trim(),
    })),
    assumptions: [...assumptions],
  };
}

export function briefRequiresClarificationV1(brief: ResearchBriefV1): boolean {
  return brief.clarificationQuestions.some((question) => question.required) ||
    brief.assumptions.some((assumption) => assumption.requiresUserDecision && assumption.status === "proposed");
}

/**
 * Materialize a new immutable brief revision after one complete answer set.
 * The reducer invokes this pure function while it holds the session CAS fence;
 * no provider, workspace, scope resolution, or graph construction occurs
 * here. Clarifications never widen the approved scope or budget.
 */
export function resolveResearchBriefClarificationsV1(input: {
  brief: ResearchBriefV1;
  answers: readonly Pick<ResearchBriefClarificationResponseV1, "questionId" | "response">[];
  assumptionDecisions: readonly ResearchBriefAssumptionDecisionV1[];
}): ResearchBriefV1 {
  const requiredQuestions = input.brief.clarificationQuestions.filter((question) => question.required);
  const requiredAssumptions = input.brief.assumptions.filter((assumption) =>
    assumption.requiresUserDecision && assumption.status === "proposed",
  );
  const answers = input.answers.map((answer) => ({
    questionId: answer.questionId,
    response: answer.response.trim(),
  }));
  const decisions = input.assumptionDecisions.map((decision) => ({ ...decision }));
  if (answers.length !== requiredQuestions.length ||
      decisions.length !== requiredAssumptions.length ||
      new Set(answers.map((answer) => answer.questionId)).size !== answers.length ||
      new Set(decisions.map((decision) => decision.assumptionId)).size !== decisions.length ||
      answers.some((answer) => !answer.response || answer.response.length > 2_000) ||
      !requiredQuestions.every((question) => answers.some((answer) => answer.questionId === question.id)) ||
      !requiredAssumptions.every((assumption) => decisions.some((decision) => decision.assumptionId === assumption.id)) ||
      decisions.some((decision) => decision.decision !== "accepted" && decision.decision !== "rejected")) {
    throw new Error("Research clarification resolution is incomplete or invalid.");
  }
  const answerByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const decisionByAssumptionId = new Map(decisions.map((decision) => [decision.assumptionId, decision]));
  return createResearchBriefV1({
    ...input.brief,
    revision: input.brief.revision + 1,
    clarificationQuestions: input.brief.clarificationQuestions.filter((question) => !question.required),
    clarificationResponses: [
      ...(input.brief.clarificationResponses ?? []),
      ...requiredQuestions.map((question) => ({
        questionId: question.id,
        prompt: question.prompt,
        response: answerByQuestionId.get(question.id)!.response,
      })),
    ],
    assumptions: input.brief.assumptions.map((assumption) => {
      const decision = decisionByAssumptionId.get(assumption.id);
      return decision ? { ...assumption, status: decision.decision } : assumption;
    }),
  });
}

/**
 * Materialize a user-requested plan correction as the next immutable brief
 * revision. The correction can guide later dynamic workflow selection, but it
 * cannot change the previously accepted scope, limits, or approval policy.
 */
export function reviseResearchBriefPlanV1(input: {
  brief: ResearchBriefV1;
  basedOnGraphRevision: number;
  instruction: string;
  requestedAt: string;
}): ResearchBriefV1 {
  const instruction = input.instruction.trim();
  if (!Number.isSafeInteger(input.basedOnGraphRevision) || input.basedOnGraphRevision < 1 ||
      !instruction || instruction.length > 2_000) {
    throw new Error("Research plan revision instruction is invalid.");
  }
  validTimestamp(input.requestedAt, "Research plan revision timestamp");
  const nextRevision = input.brief.revision + 1;
  const revisionInstruction: ResearchBriefPlanRevisionInstructionV1 = {
    id: `plan-revision:${input.basedOnGraphRevision}.${nextRevision}`,
    basedOnGraphRevision: input.basedOnGraphRevision,
    instruction,
    requestedAt: input.requestedAt,
  };
  return createResearchBriefV1({
    ...input.brief,
    revision: nextRevision,
    planRevisionInstructions: [
      ...(input.brief.planRevisionInstructions ?? []),
      revisionInstruction,
    ],
  });
}

/**
 * Commit an approved whole-project or whole-space discovery into the next
 * brief revision. Exact-entity approvals deliberately do not use this path:
 * they retain an entity binding without widening `ResearchScopeV1`.
 */
export function approveResearchBriefWholeScopeExpansionV1(input: {
  brief: ResearchBriefV1;
  binding: ResearchScopeBindingV1;
  /** Includes earlier approved exact-entity bindings retained by the turn. */
  existingBindings?: readonly ResearchScopeBindingV1[];
}): ResearchBriefV1 {
  const binding = structuredClone(input.binding);
  const existingBindings = structuredClone(input.existingBindings ?? input.brief.scopeBindings);
  const wholeScope = (binding.product === "jira" && binding.entityKind === "project") ||
    (binding.product === "confluence" && binding.entityKind === "space");
  const key = binding.key?.trim();
  if (!wholeScope || !key || binding.tenantOrigin !== input.brief.scope.siteOrigin ||
      binding.authority !== "approved" || binding.source !== "research_discovery" ||
      existingBindings.some((current) => current.id === binding.id || current.entityRef === binding.entityRef)) {
    throw new Error("Research whole-scope expansion binding is invalid.");
  }
  const jiraProjectKeys = binding.product === "jira"
    ? [...input.brief.scope.jiraProjectKeys, key.toUpperCase()]
    : [...input.brief.scope.jiraProjectKeys];
  const confluenceSpaceKeys = binding.product === "confluence"
    ? [...input.brief.scope.confluenceSpaceKeys, key]
    : [...input.brief.scope.confluenceSpaceKeys];
  if (new Set(jiraProjectKeys).size !== jiraProjectKeys.length ||
      new Set(confluenceSpaceKeys).size !== confluenceSpaceKeys.length) {
    throw new Error("Research whole-scope expansion is already present.");
  }
  return createResearchBriefV1({
    ...input.brief,
    revision: input.brief.revision + 1,
    scope: {
      ...input.brief.scope,
      jiraProjectKeys,
      confluenceSpaceKeys,
    },
    scopeBindings: [...existingBindings, binding],
    sourceClasses: [...new Set([...input.brief.sourceClasses, binding.product])],
  });
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
    brief: structuredClone(brief),
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
