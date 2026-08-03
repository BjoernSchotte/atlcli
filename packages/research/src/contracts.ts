/**
 * Host-neutral contracts for atlcli read-only research.
 *
 * No model, Chrome, REST client, or interpreter type belongs in this module.
 * The portable screen and every productive/test host communicate through these
 * JSON-safe versioned shapes.
 */

export const RESEARCH_REQUEST_SCHEMA_V1 = "atlcli.research-request/v1" as const;
export const RESEARCH_REPORT_SCHEMA_V1 = "atlcli.research-report/v1" as const;
export const RESEARCH_REPORT_SCHEMA_V2 = "atlcli.research-report/v2" as const;
export const RESEARCH_REPORT_ARTIFACT_PATH_V1 = "/artifacts/report.md" as const;
export const RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1 =
  "atlcli.research-one-shot-policy/v1" as const;
export const RESEARCH_SCOPE_BINDING_SCHEMA_V1 =
  "atlcli.research-scope-binding/v1" as const;

export const RESEARCH_REQUESTED_EFFORTS_V1 = [
  "auto",
  "lookup",
  "analysis",
  "deep",
] as const;
export const RESEARCH_REQUESTED_PLAN_APPROVALS_V1 = [
  "default",
  "automatic",
  "required",
] as const;
export const RESEARCH_SCOPE_EXPANSION_MODES_V1 = [
  "strict",
  "ask",
  "exact-linked",
] as const;
export const RESEARCH_REQUESTED_RECONCILIATIONS_V1 = [
  "off",
  "auto",
  "required",
] as const;
export const RESEARCH_REPORT_LANGUAGES_V1 = ["en", "de"] as const;

export type ResearchRequestedEffortV1 =
  (typeof RESEARCH_REQUESTED_EFFORTS_V1)[number];
export type ResearchResolvedEffortV1 = Exclude<ResearchRequestedEffortV1, "auto">;
export type ResearchRequestedPlanApprovalV1 =
  (typeof RESEARCH_REQUESTED_PLAN_APPROVALS_V1)[number];
export type ResearchResolvedPlanApprovalV1 = Exclude<
  ResearchRequestedPlanApprovalV1,
  "default"
>;
export type ResearchScopeExpansionModeV1 =
  (typeof RESEARCH_SCOPE_EXPANSION_MODES_V1)[number];
export type ResearchRequestedReconciliationV1 =
  (typeof RESEARCH_REQUESTED_RECONCILIATIONS_V1)[number];
/** Language selected by the host for deterministic report copy and model output. */
export type ResearchReportLanguageV1 = (typeof RESEARCH_REPORT_LANGUAGES_V1)[number];

/**
 * Host-neutral controls for the equal CLI/browser one-shot surface.
 *
 * This remains separate from ResearchRequestV1 so the frozen source/retrieval
 * contract stays backwards compatible. Every cross-realm host normalizes this
 * value independently; it is policy, never model-authored input.
 */
export interface ResearchOneShotPolicyV1 {
  schema: typeof RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1;
  requestedEffort: ResearchRequestedEffortV1;
  requestedPlanApproval: ResearchRequestedPlanApprovalV1;
  scopeExpansionMode: ResearchScopeExpansionModeV1;
  requestedReconciliation: ResearchRequestedReconciliationV1;
}

export const DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1: Readonly<ResearchOneShotPolicyV1> = {
  schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  requestedEffort: "auto",
  requestedPlanApproval: "default",
  scopeExpansionMode: "ask",
  requestedReconciliation: "auto",
};

export const RESEARCH_TOOL_IDS = [
  "jira.issue.search",
  "jira.issue.get",
  "wiki.search",
  "wiki.page.get",
  "research.candidate.rank",
] as const;

export type ResearchToolId = (typeof RESEARCH_TOOL_IDS)[number];
export const RESEARCH_CAPABILITY_EVENT_TOOL_IDS_V1 = [
  ...RESEARCH_TOOL_IDS,
  "jira.project.search",
  "wiki.space.search",
  "atlassian.reference.resolve",
] as const;
export type ResearchCapabilityEventToolIdV1 =
  (typeof RESEARCH_CAPABILITY_EVENT_TOOL_IDS_V1)[number];
export type ResearchProvider = "rest" | "agg";
export type ResearchProduct = "jira" | "confluence";

export const RESEARCH_SCOPE_SOURCES_V1 = [
  "cli_flag",
  "ui_added",
  "natural_language",
  "current_context",
  "profile_default",
  "global_default",
  "exact_link",
  "research_discovery",
] as const;
export const RESEARCH_SCOPE_AUTHORITIES_V1 = [
  "candidate",
  "resolved",
  "approved",
  "locked",
] as const;
export const RESEARCH_SCOPE_SOURCE_PRECEDENCE_V1 = {
  cli_flag: 500,
  ui_added: 500,
  natural_language: 400,
  // A current-tenant project/space URL in the accepted question is an exact
  // natural-language scope mention, not a later research-discovery candidate.
  exact_link: 400,
  current_context: 300,
  profile_default: 200,
  global_default: 100,
  research_discovery: 0,
} as const;

export type ResearchScopeEntityKindV1 = "project" | "space" | "issue" | "page";
export type ResearchScopeSourceV1 = (typeof RESEARCH_SCOPE_SOURCES_V1)[number];
export type ResearchScopeAuthorityV1 = (typeof RESEARCH_SCOPE_AUTHORITIES_V1)[number];

export interface ResearchScopeBindingV1 {
  schema: typeof RESEARCH_SCOPE_BINDING_SCHEMA_V1;
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

export interface ResearchScopeSeedV1 {
  binding: ResearchScopeBindingV1;
  precedence: number;
}

export interface ResearchTimeWindowV1 {
  from?: string;
  to?: string;
}

export interface ResearchScopeV1 {
  siteOrigin: string;
  jiraProjectKeys: string[];
  confluenceSpaceKeys: string[];
  timeWindow?: ResearchTimeWindowV1;
}

export interface ResearchLimitsV1 {
  pageSize: number;
  maxSearchPagesPerProduct: number;
  maxItemsPerProduct: number;
  maxDetailItemsPerProduct: number;
  maxBodyCharsPerItem: number;
  maxPtcCalls: number;
  maxHttpCalls: number;
  maxConcurrentCalls: number;
  maxPtcInputBytes: number;
  maxPtcOutputBytes: number;
  maxTotalResponseBytes: number;
  maxInterpreterMemoryBytes: number;
  maxInterpreterMs: number;
  /** Total model invocations across the central supervisor and every subagent. */
  maxModelCalls: number;
  /** Conservative run-wide input-token ceiling, including tool schemas and results. */
  maxTotalModelInputTokens: number;
  /** Conservative run-wide output-token ceiling. */
  maxTotalModelOutputTokens: number;
  /** Conservative USD micro-dollar ceiling using the model's documented worst-case rates. */
  maxModelCostMicros: number;
  maxModelInputTokens: number;
  maxModelOutputTokens: number;
  maxReportChars: number;
  /**
   * Maximum age of retained evidence before a resumed run must re-read it
   * through the host provider before using a dependent claim in a report.
   */
  maxEvidenceAgeMs: number;
  maxRunMs: number;
}

export const DEFAULT_RESEARCH_LIMITS_V1: Readonly<ResearchLimitsV1> = {
  pageSize: 25,
  maxSearchPagesPerProduct: 5,
  maxItemsPerProduct: 100,
  maxDetailItemsPerProduct: 20,
  maxBodyCharsPerItem: 12_000,
  maxPtcCalls: 32,
  maxHttpCalls: 64,
  maxConcurrentCalls: 4,
  maxPtcInputBytes: 32_000,
  maxPtcOutputBytes: 128_000,
  maxTotalResponseBytes: 8_000_000,
  maxInterpreterMemoryBytes: 64_000_000,
  // A host-generated focused workflow can read the whole bounded candidate
  // set serially. Keep the interpreter below the per-worker duration, while
  // allowing normal Atlassian request latency instead of forcing a first-N
  // result through a ten-second cutoff.
  maxInterpreterMs: 60_000,
  maxModelCalls: 16,
  // The monetary ceiling is the binding spend guard. A complete bounded
  // workflow may need to retain two acquisition traces before join, critique,
  // and final synthesis. This remains a hard run-wide token cap, but must not
  // stop a fully acquired evidence set before its final author can run.
  maxTotalModelInputTokens: 350_000,
  maxTotalModelOutputTokens: 64_000,
  maxModelCostMicros: 2_000_000,
  maxModelInputTokens: 80_000,
  maxModelOutputTokens: 8_000,
  maxReportChars: 24_000,
  // A normal ten-minute run does not re-fetch its own source bodies. A later
  // continuation cannot silently treat an old retained body as current.
  maxEvidenceAgeMs: 15 * 60_000,
  // CLI and browser use the same durable default. A two-minute browser
  // deadline cut off a normal bounded deep-research workflow before its
  // second retrieval/reconciliation wave could complete.
  maxRunMs: 10 * 60_000,
};

export interface ResearchRequestV1 {
  schema: typeof RESEARCH_REQUEST_SCHEMA_V1;
  question: string;
  scope: ResearchScopeV1;
  limits: ResearchLimitsV1;
  wikiProvider: ResearchProvider;
  /** Host-selected report language. Omitted V1 requests retain English output. */
  reportLanguage?: ResearchReportLanguageV1;
  /** Ordered host-originated scope provenance; omitted by legacy V1 callers. */
  scopeSeeds?: ResearchScopeSeedV1[];
  /**
   * Products whose attached exact entity replaces broad discovery for this
   * conversational turn. The enclosing project/space remains in the signed
   * scope so detail evidence can still be validated against its real source.
   */
  exactContextProducts?: ResearchProduct[];
}

export interface ResearchSourceReferenceV1 {
  id: string;
  product: ResearchProduct;
  title: string;
  url: string;
  issueKey?: string;
  contentId?: string;
  projectKey?: string;
  spaceKey?: string;
  excerpt?: string;
  updatedAt?: string;
}

export interface ResearchFindingV1 {
  id: string;
  classification: "fact" | "inference";
  summary: string;
  detail?: string;
  sourceIds: string[];
}

export interface AtlassianRelationshipV1 {
  id: string;
  classification: "verified" | "hypothesis";
  jiraIssueKey: string;
  confluenceContentId: string;
  summary: string;
  sourceIds: string[];
}

export interface ResearchRunCountsV1 {
  ptcCalls: number;
  httpCalls: number;
  jiraItems: number;
  confluenceItems: number;
}

export interface ResearchRunUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ResearchRunSummaryV1 {
  model: string;
  wikiProvider: ResearchProvider;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  complete: boolean;
  counts: ResearchRunCountsV1;
  usage?: ResearchRunUsageV1;
  warnings: string[];
}

export interface ResearchReportV1 {
  schema: typeof RESEARCH_REPORT_SCHEMA_V1;
  title: string;
  question: string;
  scope: ResearchScopeV1;
  executiveSummary: string;
  findings: ResearchFindingV1[];
  relationships: AtlassianRelationshipV1[];
  limitations: string[];
  sources: ResearchSourceReferenceV1[];
  run: ResearchRunSummaryV1;
  markdown: string;
}

/**
 * A host-validated claim projection in a V2 report. The model may arrange
 * accepted claim IDs, but only the host copies their statement and provenance
 * from the private claim/evidence ledgers into this public artifact.
 */
export interface ResearchReportClaimV2 {
  id: string;
  classification: "fact" | "inference";
  statement: string;
  freshness: "current";
  evidenceIds: string[];
  sourceIds: string[];
}

/** A stable, outline-derived grouping of host-validated report claims. */
export interface ResearchReportSectionV2 {
  id: string;
  title: string;
  question: string;
  claimIds: string[];
  coverageTargetIds: string[];
}

/**
 * Host-validated reconciliation outcome. This is process metadata, not source
 * evidence: it deliberately excludes critic prose, source references, and
 * private evidence spans.
 */
export interface ResearchReportReconciliationV2 {
  defectId: string;
  target: {
    kind: "finding" | "relationship" | "claim" | "section" | "node" | "coverage";
    id: string;
  };
  decision: "reject_defect" | "revise" | "downgrade" | "add_follow_up" | "abstain" | "no_change";
  reasonCode: "invalid_reference" | "already_resolved" | "supported_by_evidence" | "material_defect" | "insufficient_budget" | "outside_approval_envelope";
}

/**
 * Host-derived visibility into why every published source was permitted to be
 * read. It carries neither a scope entity nor a credential: the source list
 * already supplies the user-visible citation, while this records whether the
 * read relied on a whole project/space or one approved exact entity.
 */
export interface ResearchReportSourceAuthorityV2 {
  sourceId: string;
  authorityClasses: Array<"whole_scope" | "exact_entity">;
}

/**
 * New evidence-first report contract. `markdown` remains an exact
 * deterministic projection so CLI, browser, copy, download, and future
 * exporters consume identical bytes.
 */
export interface ResearchReportV2 {
  schema: typeof RESEARCH_REPORT_SCHEMA_V2;
  title: string;
  question: string;
  scope: ResearchScopeV1;
  executiveSummaryClaimIds: string[];
  claims: ResearchReportClaimV2[];
  sections: ResearchReportSectionV2[];
  coverage: Array<{
    targetId: string;
    status: "covered" | "partial" | "uncovered";
    claimIds: string[];
    evidenceIds: string[];
    distinctSourceCount: number;
  }>;
  /** Absent on historical V2 reports created before reconciliation projection. */
  reconciliation?: ResearchReportReconciliationV2[];
  /** Absent on historical V2 reports created before authority projection. */
  sourceAuthorities?: ResearchReportSourceAuthorityV2[];
  limitations: string[];
  sources: ResearchSourceReferenceV1[];
  run: ResearchRunSummaryV1;
  markdown: string;
}

export type ResearchReport = ResearchReportV1 | ResearchReportV2;

export type ResearchProgressPhase =
  | "preparing"
  | "researching"
  | "rendering"
  | "complete";

export interface ResearchProgressV1 {
  phase: ResearchProgressPhase;
  message: string;
  completedCalls: number;
  maxCalls: number;
}

/**
 * Sanitized, body-free event stream shape shared by CLI and browser hosts.
 * T2 emits phase/progress/artifact events; durable phases extend usage of the
 * same union without putting prompts, source bodies, cursors, or secrets in it.
 */
export type ResearchEventV1 =
  | { kind: "state"; seq: number; at: string; from: string; to: string }
  | { kind: "phase"; seq: number; at: string; phase: string }
  | { kind: "progress"; seq: number; at: string; graphRevision: number; completed: number; maximum: number }
  | { kind: "brief"; seq: number; at: string; revision: number }
  | { kind: "clarification"; seq: number; at: string; briefRevision: number; status: string }
  | { kind: "scope"; seq: number; at: string; briefRevision: number; proposalId?: string; status: string }
  | {
      kind: "plan";
      seq: number;
      at: string;
      briefRevision: number;
      revision: number;
      status: string;
      resolvedEffort: ResearchResolvedEffortV1;
      selectedRoleIds: string[];
      nodeCount: number;
      waveCount: number;
      maxParallelNodes: number;
    }
  | { kind: "plan_diff"; seq: number; at: string; from: number; to: number }
  | { kind: "control"; seq: number; at: string; action: string; status: string; revision: number }
  | {
      kind: "task";
      seq: number;
      at: string;
      taskId: string;
      status: string;
      roleId?: string;
      wave?: number;
      dependencyTaskIds?: string[];
      grantedCapabilityIds?: string[];
      resultBytes?: number;
      capabilityCalls?: number;
      inputTokens?: number;
      outputTokens?: number;
      sourceCount?: number;
      findingCount?: number;
      relationshipCount?: number;
      gapCount?: number;
      defectCount?: number;
    }
  | {
      kind: "subagent";
      seq: number;
      at: string;
      taskId: string;
      roleId: string;
      status: string;
      attempt?: number;
      durationMs?: number;
      errorCode?: string;
    }
  | {
      kind: "capability";
      seq: number;
      at: string;
      callId: string;
      toolId: ResearchCapabilityEventToolIdV1;
      inputKind: "search" | "continuation" | "detail" | "reference" | "ranking";
      status: string;
      itemCount?: number;
      /** Bounded source labels safe for user-facing live activity. */
      itemLabels?: string[];
      complete?: boolean;
      termination?: string;
      resultBytes?: number;
      truncated?: boolean;
      durationMs?: number;
      errorCode?: string;
      inputKeys?: string[];
      queryKeys?: string[];
    }
  | {
      kind: "decision";
      seq: number;
      at: string;
      decisionId: string;
      status: "started" | "completed" | "failed";
      reasonCode: string;
      taskId?: string;
      errorCode?: string;
      codeBytes?: number;
      codeHash?: string;
    }
  | {
      kind: "reconciliation";
      seq: number;
      at: string;
      taskId: string;
      status: "started" | "completed" | "failed";
      defectCount?: number;
      proposedFollowUpCount?: number;
    }
  | {
      kind: "reconciliation_disposition";
      seq: number;
      at: string;
      dispositionId: string;
      defectId: string;
      decision: "reject_defect" | "revise" | "downgrade" | "add_follow_up" | "abstain" | "no_change";
      reasonCode: "invalid_reference" | "already_resolved" | "supported_by_evidence" | "material_defect" | "insufficient_budget" | "outside_approval_envelope";
      status: "recorded";
    }
  | {
      kind: "repair_group";
      seq: number;
      at: string;
      followUpId: string;
      taskId?: string;
      status: "authorized" | "retained_without_execution" | "completed";
      reasonCode: "accepted_follow_up" | "wave_or_budget_exhausted" | "packet_accepted";
    }
  | {
      /**
       * Host-derived, body-free assessment at a retrieval-wave boundary.
       * Source identities, queries, URLs, and model reasoning are deliberately
       * not part of this cross-host event contract.
       */
      kind: "retrieval";
      seq: number;
      at: string;
      graphRevision: number;
      action: "continue" | "replan" | "stop";
      reason: string;
      rankedCandidateCount: number;
      detailReadCount: number;
      newDetailSourceCount: number;
      duplicateDetailReadCount: number;
      unresolvedCoverageTargetCount: number;
      unresolvedContradictionCount: number;
    }
  | { kind: "steering"; seq: number; at: string; revision: number; status: string }
  | {
      kind: "budget";
      seq: number;
      at: string;
      metric: "capability_calls" | "tokens" | "bytes" | "duration_ms" | "cost_micros";
      consumed: number;
      maximum: number;
    }
  | { kind: "evidence"; seq: number; at: string; evidenceId: string }
  | { kind: "warning"; seq: number; at: string; code: string }
  | { kind: "recovery"; seq: number; at: string; checkpointRef: string }
  | { kind: "artifact"; seq: number; at: string; path: typeof RESEARCH_REPORT_ARTIFACT_PATH_V1 };

export type ResearchOneShotEventV1 = Extract<
  ResearchEventV1,
  {
    kind:
      | "phase"
      | "progress"
      | "brief"
      | "plan"
      | "task"
      | "subagent"
      | "capability"
      | "decision"
      | "reconciliation"
      | "reconciliation_disposition"
      | "repair_group"
      | "steering"
      | "retrieval"
      | "budget"
      | "artifact";
  }
>;

export type ResearchErrorCode =
  | "invalid-request"
  | "plan-approval-required"
  | "scope-approval-required"
  | "clarification-required"
  | "missing-key"
  | "invalid-key"
  | "not-atlassian"
  | "not-authenticated"
  | "access-denied"
  | "rate-limited"
  | "provider-error"
  | "limit-exceeded"
  | "paused"
  | "cancelled"
  | "invalid-report"
  | "unknown";

export class ResearchContractError extends Error {
  readonly code: ResearchErrorCode;

  constructor(code: ResearchErrorCode, message: string) {
    super(message);
    this.name = "ResearchContractError";
    this.code = code;
  }
}

export type ResearchRunModeV1 = "chat" | "research";

export interface ResearchRunOptions {
  signal?: AbortSignal;
  /** Selects a direct conversational turn or the dynamic research workflow. */
  mode?: ResearchRunModeV1;
  /**
   * Host-owned durable identity for a multi-turn direct-chat conversation.
   * Reusing it causes the checkpointer to append the new human turn to the
   * same DeepAgentsJS thread. Omitting it starts a new conversation.
   */
  conversationId?: string;
  policy?: ResearchOneShotPolicyV1;
  /**
   * The host owns durable session identity. Presenters may use this opaque
   * reference to associate a streamed user turn with its later continuation,
   * but cannot use it to bypass the revision-fenced session controls.
   */
  onSessionStart?: (session: { sessionId: string; turnId?: string }) => void;
  onProgress?: (progress: ResearchProgressV1) => void;
  onEvent?: (event: ResearchOneShotEventV1) => void;
}

/**
 * The only research surface visible to the portable React application.
 *
 * Credential methods deliberately do not return a key. A host may remember it
 * for the current browser session, but the app can only ask whether one exists.
 */
export interface ResearchPort {
  hasApiKey(): Promise<boolean>;
  setApiKey(apiKey: string): Promise<void>;
  clearApiKey(): Promise<void>;
  /**
   * Start the next direct-chat turn in a fresh durable conversation. The host
   * clears only its active-conversation pointer; retained conversation state
   * remains host-owned and may be exposed by a future history surface.
   */
  resetChatConversation?(): Promise<void>;
  resolveScope(
    request: ResearchRequestV1,
    options?: import("./scope-preflight.js").ResearchScopePreflightOptionsV1,
  ): Promise<import("./scope-preflight.js").ResearchScopePreflightOutcomeV1>;
  /**
   * An optional durable-session capability. One-shot-only hosts intentionally
   * omit it until they implement their own tenant-bound session catalog.
   */
  listResumableSessions?(): Promise<
    import("./session.js").ResearchResumableSessionV1[]
  >;
  /**
   * Terminal turns available to the active tenant for a user-authored follow-up.
   * The host projects these from durable state; callers cannot select scope,
   * policy, or budget for the resulting turn.
   */
  listRetainedSessions?(): Promise<
    import("./session.js").ResearchRetainedSessionV1[]
  >;
  /**
   * Append and durably prepare a question against a terminal session's exact
   * stored scope, policy, and limits. This intentionally never starts a
   * worker: the caller must separately approve or resume the returned state.
   */
  prepareFollowUpTurn?(input: {
    sessionId: string;
    revision: number;
    question: string;
  }): Promise<
    | { kind: "plan_review"; review: import("./session-plan-review.js").ResearchSessionPlanReviewV1 }
    | { kind: "resumable"; session: import("./session.js").ResearchResumableSessionV1 }
  >;
  /**
   * Persist one user-originated focus/prioritization request at an already
   * settled retrieval checkpoint. Hosts bind tenant and revisions themselves.
   */
  requestSteering?(input: {
    sessionId: string;
    revision: number;
    instruction: string;
  }): Promise<void>;
  run(request: ResearchRequestV1, options?: ResearchRunOptions): Promise<ResearchReport>;
  resume?(
    sessionId: string,
    options?: Omit<ResearchRunOptions, "policy">,
  ): Promise<ResearchReport>;
  /**
   * Cooperatively stop the active run at its next persisted retrieval
   * checkpoint. The port owns the ephemeral run identity; callers cannot name
   * a session or a worker.
   */
  pauseActiveRun?(): Promise<"pause_requested" | "paused">;
  /**
   * Optional tenant-bound review surface for durable related-scope proposals.
   * Hosts return only body-free snapshots and derive an approved binding from
   * the persisted proposal/candidate, never from caller-provided scope keys.
   */
  listScopeReviews?(): Promise<
    import("./session-scope-review.js").ResearchSessionScopeReviewV1[]
  >;
  approveScopeReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    graphRevision: number;
    proposalId: string;
  }): Promise<import("./session-scope-review.js").ResearchSessionScopeReviewV1>;
  rejectScopeReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    graphRevision: number;
    proposalId: string;
  }): Promise<import("./session-scope-review.js").ResearchSessionScopeReviewV1>;
  /** Optional review/approval boundary for a replacement scope-expansion plan. */
  listScopePlanReviews?(): Promise<
    import("./session-scope-review.js").ResearchSessionScopeReviewV1[]
  >;
  approveScopePlanReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    graphRevision: number;
  }): Promise<import("./session-scope-review.js").ResearchSessionScopeReviewV1>;
  /**
   * Persist an initial required plan before key storage, model construction,
   * or retrieval. Hosts that cannot offer durable sessions omit this method.
   */
  preparePlanReview?(
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ): Promise<import("./session-plan-review.js").ResearchSessionPlanReviewV1>;
  /** Tenant-bound, body-free initial plan review discovery. */
  listPlanReviews?(): Promise<
    import("./session-plan-review.js").ResearchSessionPlanReviewV1[]
  >;
  /** Approves one exact initial plan revision and returns its resumable turn. */
  approvePlanReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    graphRevision: number;
  }): Promise<import("./session.js").ResearchResumableSessionV1>;
  /**
   * Reject one exact plan and persist a user correction before composing a
   * replacement that must itself be approved. The correction is deliberately
   * not a free-form graph or scope mutation.
   */
  rejectPlanReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    graphRevision: number;
    instruction: string;
  }): Promise<import("./session-plan-review.js").ResearchSessionPlanReviewV1>;
  /**
   * Persist a required brief clarification before credentials, a provider, or
   * graph construction. Browser hosts bind it to the active tenant.
   */
  prepareClarificationReview?(
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ): Promise<import("./session-clarification-review.js").ResearchSessionClarificationReviewV1>;
  /** Tenant-bound discovery of answer and post-answer planning checkpoints. */
  listClarificationReviews?(): Promise<
    import("./session-clarification-review.js").ResearchSessionClarificationReviewV1[]
  >;
  /** Commits the exact answer/assumption set and then proposes the next graph. */
  resolveClarificationReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
    answers: import("./session-clarification-review.js").ResearchClarificationReviewResolutionInputV1["answers"];
    assumptionDecisions: import("./session-clarification-review.js").ResearchClarificationReviewResolutionInputV1["assumptionDecisions"];
  }): Promise<import("./session-clarification-review.js").ResearchClarificationReviewResolutionV1>;
  /** Finishes a prior answer-committed checkpoint without accepting new input. */
  continueClarificationReview?(input: {
    sessionId: string;
    revision: number;
    briefRevision: number;
  }): Promise<import("./session-clarification-review.js").ResearchClarificationReviewResolutionV1>;
  /** Persist a natural-language scope choice before the first brief exists. */
  prepareScopeClarificationReview?(
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ): Promise<import("./session-scope-clarification-review.js").ResearchSessionScopeClarificationReviewV1>;
  /** Tenant-bound discovery of pending scope-choice and post-choice checkpoints. */
  listScopeClarificationReviews?(): Promise<
    import("./session-scope-clarification-review.js").ResearchSessionScopeClarificationReviewV1[]
  >;
  /** Commits one exact persisted candidate choice after host catalog validation. */
  resolveScopeClarificationReview?(input: {
    sessionId: string;
    revision: number;
    selection: import("./scope-resolution.js").ResearchScopeCandidateSelectionV1;
  }): Promise<import("./session-scope-clarification-review.js").ResearchScopeClarificationReviewResolutionV1>;
  /** Finishes a post-choice brief or plan checkpoint without accepting new input. */
  continueScopeClarificationReview?(input: {
    sessionId: string;
    revision: number;
  }): Promise<import("./session-scope-clarification-review.js").ResearchScopeClarificationReviewResolutionV1>;
  copyMarkdown(markdown: string): Promise<void>;
  downloadMarkdown(markdown: string, filename: string): Promise<void>;
}

const LIMIT_BOUNDS: {
  [K in keyof ResearchLimitsV1]: readonly [minimum: number, maximum: number];
} = {
  pageSize: [1, 50],
  maxSearchPagesPerProduct: [1, 10],
  maxItemsPerProduct: [1, 250],
  maxDetailItemsPerProduct: [1, 50],
  maxBodyCharsPerItem: [256, 50_000],
  maxPtcCalls: [4, 128],
  maxHttpCalls: [4, 256],
  maxConcurrentCalls: [1, 8],
  maxPtcInputBytes: [1_000, 256_000],
  maxPtcOutputBytes: [1_000, 1_000_000],
  maxTotalResponseBytes: [100_000, 50_000_000],
  maxInterpreterMemoryBytes: [8_000_000, 256_000_000],
  maxInterpreterMs: [500, 60_000],
  maxModelCalls: [1, 64],
  maxTotalModelInputTokens: [1_000, 1_000_000],
  maxTotalModelOutputTokens: [1_000, 128_000],
  maxModelCostMicros: [10_000, 100_000_000],
  maxModelInputTokens: [1_000, 200_000],
  maxModelOutputTokens: [1_000, 32_000],
  maxReportChars: [1_000, 100_000],
  maxEvidenceAgeMs: [60_000, 7 * 24 * 60 * 60_000],
  maxRunMs: [5_000, 10 * 60_000],
};

function boundedInteger(
  value: unknown,
  fallback: number,
  [minimum, maximum]: readonly [number, number]
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Normalize an untrusted CLI/browser/worker policy with a closed schema. */
export function normalizeResearchOneShotPolicyV1(
  value: unknown,
): ResearchOneShotPolicyV1 {
  if (value === undefined) return structuredClone(DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", "Research one-shot policy is invalid.");
  }
  const policy = value as Record<string, unknown>;
  const allowed = [
    "schema",
    "requestedEffort",
    "requestedPlanApproval",
    "scopeExpansionMode",
    "requestedReconciliation",
  ];
  if (Object.keys(policy).some((key) => !allowed.includes(key))) {
    throw new ResearchContractError(
      "invalid-request",
      "Research one-shot policy contains unknown fields.",
    );
  }
  if (policy.schema !== RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1) {
    throw new ResearchContractError(
      "invalid-request",
      "Unsupported research one-shot policy schema.",
    );
  }
  if (!RESEARCH_REQUESTED_EFFORTS_V1.includes(
    policy.requestedEffort as ResearchRequestedEffortV1,
  )) {
    throw new ResearchContractError("invalid-request", "Research effort policy is invalid.");
  }
  if (!RESEARCH_REQUESTED_PLAN_APPROVALS_V1.includes(
    policy.requestedPlanApproval as ResearchRequestedPlanApprovalV1,
  )) {
    throw new ResearchContractError(
      "invalid-request",
      "Research plan-approval policy is invalid.",
    );
  }
  if (!RESEARCH_SCOPE_EXPANSION_MODES_V1.includes(
    policy.scopeExpansionMode as ResearchScopeExpansionModeV1,
  )) {
    throw new ResearchContractError(
      "invalid-request",
      "Research scope-expansion policy is invalid.",
    );
  }
  if (!RESEARCH_REQUESTED_RECONCILIATIONS_V1.includes(
    policy.requestedReconciliation as ResearchRequestedReconciliationV1,
  )) {
    throw new ResearchContractError(
      "invalid-request",
      "Research reconciliation policy is invalid.",
    );
  }
  return {
    schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
    requestedEffort: policy.requestedEffort as ResearchRequestedEffortV1,
    requestedPlanApproval:
      policy.requestedPlanApproval as ResearchRequestedPlanApprovalV1,
    scopeExpansionMode: policy.scopeExpansionMode as ResearchScopeExpansionModeV1,
    requestedReconciliation:
      policy.requestedReconciliation as ResearchRequestedReconciliationV1,
  };
}

export function normalizeResearchLimitsV1(value: unknown): ResearchLimitsV1 {
  const source =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof ResearchLimitsV1, unknown>>)
      : {};
  const normalized = {} as ResearchLimitsV1;
  for (const key of Object.keys(DEFAULT_RESEARCH_LIMITS_V1) as (keyof ResearchLimitsV1)[]) {
    normalized[key] = boundedInteger(
      source[key],
      DEFAULT_RESEARCH_LIMITS_V1[key],
      LIMIT_BOUNDS[key]
    );
  }
  normalized.maxDetailItemsPerProduct = Math.min(
    normalized.maxDetailItemsPerProduct,
    normalized.maxItemsPerProduct
  );
  return normalized;
}

function normalizeKeyList(
  values: unknown,
  pattern: RegExp,
  label: string
): string[] {
  if (!Array.isArray(values)) {
    throw new ResearchContractError("invalid-request", `${label} scope must be a list.`);
  }
  const normalized = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (normalized.length > 20) {
    throw new ResearchContractError("invalid-request", `Select no more than 20 ${label}s.`);
  }
  for (const value of normalized) {
    if (!pattern.test(value)) {
      throw new ResearchContractError("invalid-request", `Invalid ${label}: ${value}`);
    }
  }
  return normalized;
}

function normalizeIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ResearchContractError("invalid-request", `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ResearchContractError("invalid-request", `${label} is not a valid date.`);
  }
  return value;
}

export function normalizeResearchScopeV1(value: unknown): ResearchScopeV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-request", "Research scope is missing.");
  }
  const scope = value as Partial<Record<keyof ResearchScopeV1, unknown>>;
  let url: URL;
  try {
    if (typeof scope.siteOrigin !== "string") throw new Error("missing origin");
    url = new URL(scope.siteOrigin);
  } catch {
    throw new ResearchContractError("not-atlassian", "The active site URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== scope.siteOrigin ||
    !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)
  ) {
    throw new ResearchContractError(
      "not-atlassian",
      "Research requires an approved Atlassian Cloud site origin."
    );
  }

  const jiraProjectKeys = normalizeKeyList(
    scope.jiraProjectKeys,
    /^[A-Z][A-Z0-9]{1,19}$/,
    "Jira project"
  );
  const confluenceSpaceKeys = normalizeKeyList(
    scope.confluenceSpaceKeys,
    /^[A-Za-z0-9~][A-Za-z0-9._~-]{0,254}$/,
    "Confluence space"
  );
  const timeWindow =
    typeof scope.timeWindow === "object" && scope.timeWindow !== null
      ? (scope.timeWindow as Partial<Record<keyof ResearchTimeWindowV1, unknown>>)
      : {};
  const from = normalizeIsoDate(timeWindow.from, "Start date");
  const to = normalizeIsoDate(timeWindow.to, "End date");
  if (from && to && from > to) {
    throw new ResearchContractError(
      "invalid-request",
      "The start date must not be after the end date."
    );
  }

  return {
    siteOrigin: url.origin,
    jiraProjectKeys,
    confluenceSpaceKeys,
    ...(from || to ? { timeWindow: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
  };
}

function boundedScopeSeedString(
  value: unknown,
  label: string,
  maximum = 512,
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return value.trim();
}

function selectedWholeScopeKeys(
  seeds: readonly ResearchScopeSeedV1[],
  product: ResearchProduct,
  entityKind: "project" | "space",
): string[] {
  const matching = seeds.filter((seed) =>
    seed.binding.product === product && seed.binding.entityKind === entityKind
  );
  const maximum = Math.max(...matching.map((seed) => seed.precedence));
  return [...new Set(
    matching
      .filter((seed) => seed.precedence === maximum)
      .map((seed) => seed.binding.key!)
  )];
}

export function normalizeResearchScopeSeedsV1(
  value: unknown,
  scope: ResearchScopeV1,
): ResearchScopeSeedV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 40) {
    throw new ResearchContractError(
      "invalid-request",
      "Research scope provenance must contain no more than 40 seeds.",
    );
  }
  if (value.length === 0) return undefined;
  const sources = new Set<string>(RESEARCH_SCOPE_SOURCES_V1);
  const normalized = value.map((candidate, index): ResearchScopeSeedV1 => {
    if (!candidate || typeof candidate !== "object") {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} is invalid.`);
    }
    const seed = candidate as { binding?: unknown; precedence?: unknown };
    if (!seed.binding || typeof seed.binding !== "object") {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} has no binding.`);
    }
    const binding = seed.binding as Partial<Record<keyof ResearchScopeBindingV1, unknown>>;
    if (binding.schema !== RESEARCH_SCOPE_BINDING_SCHEMA_V1) {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} has an unsupported binding schema.`);
    }
    const product = binding.product;
    const entityKind = binding.entityKind;
    if (product !== "jira" && product !== "confluence") {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} has an invalid product.`);
    }
    const wholeScope =
      (product === "jira" && entityKind === "project") ||
      (product === "confluence" && entityKind === "space");
    const exactEntity =
      (product === "jira" && entityKind === "issue") ||
      (product === "confluence" && entityKind === "page");
    if (!wholeScope && !exactEntity) {
      throw new ResearchContractError(
        "invalid-request",
        "One-shot scope seeds must bind a Jira project or issue, or a Confluence space or page.",
      );
    }
    if (binding.tenantOrigin !== scope.siteOrigin) {
      throw new ResearchContractError("invalid-request", "Scope seed tenant does not match the request tenant.");
    }
    if (typeof binding.source !== "string" || !sources.has(binding.source)) {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} has an invalid source.`);
    }
    const source = binding.source as ResearchScopeSourceV1;
    if (binding.authority !== "approved" && binding.authority !== "locked") {
      throw new ResearchContractError(
        "invalid-request",
        "One-shot scope seeds must be approved or locked.",
      );
    }
    const expectedPrecedence = RESEARCH_SCOPE_SOURCE_PRECEDENCE_V1[source];
    if (seed.precedence !== expectedPrecedence) {
      throw new ResearchContractError("invalid-request", "Scope seed precedence does not match its source.");
    }
    const rawKey = boundedScopeSeedString(binding.key, `Scope seed ${index + 1} key`, 255);
    const key = product === "jira" ? rawKey.toUpperCase() : rawKey;
    if (entityKind === "issue" && !/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}$/.test(key)) {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} issue key is invalid.`);
    }
    if (entityKind === "page" && !/^[1-9][0-9]{0,127}$/.test(key)) {
      throw new ResearchContractError("invalid-request", `Scope seed ${index + 1} page ID is invalid.`);
    }
    const entityRef = boundedScopeSeedString(
      binding.entityRef,
      `Scope seed ${index + 1} entity reference`,
    );
    if (exactEntity && !/^research-scope-entity:[A-Za-z0-9._-]{1,200}$/.test(entityRef)) {
      throw new ResearchContractError(
        "invalid-request",
        `Scope seed ${index + 1} exact entity reference is invalid.`,
      );
    }
    return {
      binding: {
        schema: RESEARCH_SCOPE_BINDING_SCHEMA_V1,
        id: boundedScopeSeedString(binding.id, `Scope seed ${index + 1} id`),
        tenantOrigin: scope.siteOrigin,
        product,
        entityKind,
        entityRef,
        key,
        name: boundedScopeSeedString(binding.name, `Scope seed ${index + 1} name`, 255),
        source,
        authority: binding.authority,
        ...(binding.mentionId !== undefined
          ? { mentionId: boundedScopeSeedString(binding.mentionId, `Scope seed ${index + 1} mention id`) }
          : {}),
        ...(binding.candidateId !== undefined
          ? { candidateId: boundedScopeSeedString(binding.candidateId, `Scope seed ${index + 1} candidate id`) }
          : {}),
        ...(binding.approvedAt !== undefined
          ? { approvedAt: boundedScopeSeedString(binding.approvedAt, `Scope seed ${index + 1} approval time`) }
          : {}),
      },
      precedence: expectedPrecedence,
    };
  });

  const selectedProjects = selectedWholeScopeKeys(normalized, "jira", "project");
  const selectedSpaces = selectedWholeScopeKeys(normalized, "confluence", "space");
  if (
    JSON.stringify(selectedProjects) !== JSON.stringify(scope.jiraProjectKeys) ||
    JSON.stringify(selectedSpaces) !== JSON.stringify(scope.confluenceSpaceKeys)
  ) {
    throw new ResearchContractError(
      "invalid-request",
      "Projected scope does not match the highest-precedence scope seeds.",
    );
  }
  return normalized;
}

export function normalizeResearchRequestV1(value: unknown): ResearchRequestV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-request", "The research request is missing.");
  }
  const request = value as Partial<Record<keyof ResearchRequestV1, unknown>>;
  if (typeof request.question !== "string") {
    throw new ResearchContractError("invalid-request", "The research question is missing.");
  }
  const question = request.question.trim();
  if (question.length < 3 || question.length > 2_000) {
    throw new ResearchContractError(
      "invalid-request",
      "The research question must contain between 3 and 2,000 characters."
    );
  }
  if (request.wikiProvider !== "rest" && request.wikiProvider !== "agg") {
    throw new ResearchContractError("invalid-request", "Unknown Confluence read provider.");
  }
  if (
    request.reportLanguage !== undefined &&
    !RESEARCH_REPORT_LANGUAGES_V1.includes(request.reportLanguage as ResearchReportLanguageV1)
  ) {
    throw new ResearchContractError("invalid-request", "Research report language is invalid.");
  }
  const scope = normalizeResearchScopeV1(request.scope);
  const scopeSeeds = normalizeResearchScopeSeedsV1(request.scopeSeeds, scope);
  let exactContextProducts: ResearchProduct[] | undefined;
  if (request.exactContextProducts !== undefined) {
    if (!Array.isArray(request.exactContextProducts)) {
      throw new ResearchContractError("invalid-request", "Exact context products must be a list.");
    }
    exactContextProducts = [...new Set(request.exactContextProducts.map((product) => {
      if (product !== "jira" && product !== "confluence") {
        throw new ResearchContractError("invalid-request", "Exact context product is invalid.");
      }
      return product as ResearchProduct;
    }))].sort();
  }
  return {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question,
    scope,
    limits: normalizeResearchLimitsV1(request.limits),
    wikiProvider: request.wikiProvider,
    ...(request.reportLanguage === undefined
      ? {}
      : { reportLanguage: request.reportLanguage as ResearchReportLanguageV1 }),
    ...(scopeSeeds ? { scopeSeeds } : {}),
    ...(exactContextProducts?.length ? { exactContextProducts } : {}),
  };
}
