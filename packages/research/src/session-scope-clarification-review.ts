import { briefRequiresClarificationV1 } from "./brief.js";
import type { ResearchResumableSessionV1, ResearchSessionV1 } from "./session.js";
import type { ResearchSessionClarificationReviewV1 } from "./session-clarification-review.js";
import type { ResearchSessionPlanReviewV1 } from "./session-plan-review.js";
import type { ResearchScopeCandidateSelectionV1 } from "./scope-resolution.js";

/**
 * Tenant-filtered projection of the durable pre-brief scope decision. It
 * intentionally omits the user question, internal request, tenant origin,
 * source bodies, provider data, credentials, prompts, and model trajectory.
 */
export const RESEARCH_SESSION_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1 =
  "atlcli.research-session-scope-clarification-review/v1" as const;

export interface ResearchSessionScopeClarificationReviewV1 {
  schema: typeof RESEARCH_SESSION_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1;
  sessionId: string;
  revision: number;
  status: "waiting_scope_clarification" | "idle" | "planning";
  stage: "choice_required" | "brief_required" | "plan_required";
  updatedAt: string;
  clarification: {
    mentionId: string;
    reason: "ambiguous" | "weak_match" | "archived_only" | "unavailable" | "incomplete" | "not_found";
    rerunGuidance: string[];
    candidates: Array<{
      id: string;
      product: "jira" | "confluence";
      entityKind: "project" | "space" | "issue" | "page";
      key?: string;
      name: string;
      canonicalUrl?: string;
      status?: "current" | "archived";
    }>;
  };
}

export interface ResearchScopeClarificationReviewActionV1 {
  sessionId: string;
  revision: number;
  selection: ResearchScopeCandidateSelectionV1;
}

export interface ResearchScopeClarificationPlanningActionV1 {
  sessionId: string;
  revision: number;
}

/**
 * A selection can surface a refreshed scope choice or continue at the normal
 * brief/plan execution gates. The caller cannot submit a request, scope,
 * policy, graph, or tenant through this boundary.
 */
export type ResearchScopeClarificationReviewResolutionV1 =
  | { kind: "scope_clarification"; review: ResearchSessionScopeClarificationReviewV1 }
  | { kind: "clarification_review"; review: ResearchSessionClarificationReviewV1 }
  | { kind: "plan_review"; review: ResearchSessionPlanReviewV1 }
  | { kind: "resumable"; session: ResearchResumableSessionV1 };

function activeTurn(session: ResearchSessionV1) {
  return session.activeTurnId
    ? session.turns.find((candidate) => candidate.id === session.activeTurnId)
    : undefined;
}

/**
 * Project a scope choice, its narrow post-choice brief checkpoint, or a
 * post-brief graph checkpoint only for the active tenant.
 */
export function projectResearchSessionScopeClarificationReviewV1(
  session: ResearchSessionV1,
  expectedTenantOrigin: string,
): ResearchSessionScopeClarificationReviewV1 | undefined {
  const scopeClarification = session.scopeClarification;
  if (!scopeClarification || scopeClarification.request.scope.siteOrigin !== expectedTenantOrigin) {
    return undefined;
  }
  const waitingForChoice = session.status === "waiting_scope_clarification" &&
    scopeClarification.state === "waiting_choice" && !session.activeTurnId;
  const waitingForBrief = session.status === "idle" &&
    scopeClarification.state === "choice_resolved" && !session.activeTurnId;
  const turn = activeTurn(session);
  const waitingForPlan = session.status === "planning" &&
    scopeClarification.state === "choice_resolved" &&
    turn?.brief && !turn.graph && !briefRequiresClarificationV1(turn.brief);
  if (!waitingForChoice && !waitingForBrief && !waitingForPlan) return undefined;

  return {
    schema: RESEARCH_SESSION_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status as "waiting_scope_clarification" | "idle" | "planning",
    stage: waitingForChoice
      ? "choice_required"
      : waitingForBrief
        ? "brief_required"
        : "plan_required",
    updatedAt: session.updatedAt,
    clarification: {
      mentionId: scopeClarification.clarification.mentionId,
      reason: scopeClarification.clarification.reason,
      rerunGuidance: [...scopeClarification.clarification.rerunGuidance],
      candidates: waitingForChoice
        ? scopeClarification.candidateChoices.map((candidate) => ({
          id: candidate.id,
          product: candidate.product,
          entityKind: candidate.entityKind,
          ...(candidate.key === undefined ? {} : { key: candidate.key }),
          name: candidate.name,
          ...(candidate.canonicalUrl === undefined ? {} : { canonicalUrl: candidate.canonicalUrl }),
          ...(candidate.status === undefined ? {} : { status: candidate.status }),
        }))
        : [],
    },
  };
}
