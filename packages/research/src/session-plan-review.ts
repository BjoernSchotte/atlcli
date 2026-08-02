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
    },
  };
}
