import { researchPlanApprovalRequiredV1 } from "./graph.js";
import type { ResearchSessionV1 } from "./session.js";

/**
 * A tenant-filtered, body-free projection of a first-class durable plan wait.
 * It deliberately omits the question, briefs, source bodies, task prompts,
 * provider state, and model trajectory. The host binds it to the active
 * tenant before exposing an approval control.
 */
export const RESEARCH_SESSION_PLAN_REVIEW_SCHEMA_V1 =
  "atlcli.research-session-plan-review/v1" as const;

export interface ResearchSessionPlanReviewV1 {
  schema: typeof RESEARCH_SESSION_PLAN_REVIEW_SCHEMA_V1;
  sessionId: string;
  revision: number;
  status: "waiting_plan_approval";
  updatedAt: string;
  turn: {
    id: string;
    briefRevision: number;
    graphRevision: number;
    resolvedEffort: "lookup" | "quick" | "analysis" | "deep";
    selectedRoleIds: string[];
    scopeExpansionMode: "strict" | "ask" | "exact-linked";
    reconciliationMode: "off" | "auto" | "required";
    scope: {
      jiraProjectKeys: string[];
      confluenceSpaceKeys: string[];
    };
    /** Body-free bound time window; omitted when no date constraint applies. */
    timeWindow?: {
      from?: string;
      to?: string;
    };
    /** Approved or locked scope identities, without tenant origin or entity refs. */
    scopeBindings?: Array<{
      id: string;
      product: "jira" | "confluence";
      entityKind: "project" | "space" | "issue" | "page";
      key?: string;
      name: string;
      source: string;
      authority: string;
    }>;
    /** Coverage criteria, deliberately omitting the user question text. */
    coverageTargets?: Array<{
      id: string;
      required: boolean;
      sourceClasses: Array<"jira" | "confluence">;
      minimumDistinctSources: number;
    }>;
    /**
     * The closed, host-approved envelope available to later in-envelope
     * replans. This never grants a new role, capability, scope, or budget.
     */
    replanEnvelope?: {
      optionalRoleIds: string[];
      allowedCapabilityIds: string[];
      maxParallelNodes: number;
      maxResearchWaves: number;
      maxReconciliationWaves: number;
    };
    /**
     * Body-free limits that the user can inspect before approving a durable
     * plan. The host derives these from the persisted brief; no caller may
     * widen them by editing a review projection.
     */
    budget: {
      maxPtcCalls: number;
      maxHttpCalls: number;
      maxModelCalls?: number;
      maxTotalModelInputTokens: number;
      maxTotalModelOutputTokens: number;
      maxModelCostMicros: number;
      maxRunMs: number;
    };
  };
}

/**
 * Expose a proposed plan only for the host's active tenant. A whole-scope
 * replacement is intentionally excluded: it carries a separate plan diff and
 * must use the dedicated scope-plan review boundary.
 */
export function projectResearchSessionPlanReviewV1(
  session: ResearchSessionV1,
  expectedTenantOrigin: string,
): ResearchSessionPlanReviewV1 | undefined {
  if (session.status !== "waiting_plan_approval") return undefined;
  const turn = session.activeTurnId
    ? session.turns.find((candidate) => candidate.id === session.activeTurnId)
    : undefined;
  if (!turn?.brief || !turn.graph || turn.brief.scope.siteOrigin !== expectedTenantOrigin) {
    return undefined;
  }
  if (turn.scopeRevisions?.some((revision) => revision.state === "proposed")) {
    return undefined;
  }
  const required = researchPlanApprovalRequiredV1(turn.graph);
  if (!required) return undefined;
  return {
    schema: RESEARCH_SESSION_PLAN_REVIEW_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    status: "waiting_plan_approval",
    updatedAt: session.updatedAt,
    turn: {
      id: turn.id,
      briefRevision: turn.brief.revision,
      graphRevision: turn.graph.revision,
      resolvedEffort: required.resolvedEffort,
      selectedRoleIds: [...required.selectedRoleIds],
      scopeExpansionMode: required.scopeExpansionMode,
      reconciliationMode: required.reconciliationMode,
      scope: {
        jiraProjectKeys: [...turn.brief.scope.jiraProjectKeys],
        confluenceSpaceKeys: [...turn.brief.scope.confluenceSpaceKeys],
      },
      ...(turn.brief.resolvedTimeWindow || turn.brief.scope.timeWindow ? {
        timeWindow: structuredClone(turn.brief.resolvedTimeWindow ?? turn.brief.scope.timeWindow),
      } : {}),
      scopeBindings: turn.scopeBindings.map((binding) => ({
        id: binding.id,
        product: binding.product,
        entityKind: binding.entityKind,
        ...(binding.key === undefined ? {} : { key: binding.key }),
        name: binding.name,
        source: binding.source,
        authority: binding.authority,
      })),
      coverageTargets: turn.brief.coverageTargets.map((target) => ({
        id: target.id,
        required: target.required,
        sourceClasses: [...target.sourceClasses],
        minimumDistinctSources: target.minimumDistinctSources,
      })),
      replanEnvelope: {
        optionalRoleIds: turn.graph.approvalEnvelope.allowedRoleIds.filter((roleId) =>
          !required.selectedRoleIds.includes(roleId),
        ),
        allowedCapabilityIds: [...turn.graph.approvalEnvelope.allowedCapabilityIds],
        maxParallelNodes: turn.graph.approvalEnvelope.maxParallelNodes,
        maxResearchWaves: turn.graph.approvalEnvelope.maxResearchWaves,
        maxReconciliationWaves: turn.graph.approvalEnvelope.maxReconciliationWaves,
      },
      budget: {
        maxPtcCalls: turn.brief.limits.maxPtcCalls,
        maxHttpCalls: turn.brief.limits.maxHttpCalls,
        maxModelCalls: turn.brief.limits.maxModelCalls,
        maxTotalModelInputTokens: turn.brief.limits.maxTotalModelInputTokens,
        maxTotalModelOutputTokens: turn.brief.limits.maxTotalModelOutputTokens,
        maxModelCostMicros: turn.brief.limits.maxModelCostMicros,
        maxRunMs: turn.brief.limits.maxRunMs,
      },
    },
  };
}
