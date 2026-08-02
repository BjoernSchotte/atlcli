import {
  briefRequiresClarificationV1,
  type ResearchBriefAssumptionDecisionV1,
  type ResearchBriefClarificationResponseV1,
} from "./brief.js";
import type { ResearchSessionV1 } from "./session.js";
import type { ResearchResumableSessionV1 } from "./session.js";
import type { ResearchSessionPlanReviewV1 } from "./session-plan-review.js";

/**
 * Tenant-filtered projection for a durable brief-clarification wait. Prompts
 * and assumption texts are intentional user-facing inputs; objectives, source
 * bodies, packets, provider state, and model trajectories never cross this
 * boundary.
 */
export const RESEARCH_SESSION_CLARIFICATION_REVIEW_SCHEMA_V1 =
  "atlcli.research-session-clarification-review/v1" as const;

export interface ResearchSessionClarificationReviewV1 {
  schema: typeof RESEARCH_SESSION_CLARIFICATION_REVIEW_SCHEMA_V1;
  sessionId: string;
  revision: number;
  /**
   * `planning` is a recoverable, answer-committed checkpoint: the graph was
   * not yet proposed when the previous host stopped. It is deliberately
   * distinct from a runnable plan or a one-shot retry.
   */
  status: "waiting_clarification" | "planning";
  stage: "answer_required" | "plan_required";
  updatedAt: string;
  turn: {
    id: string;
    briefRevision: number;
    scope: {
      jiraProjectKeys: string[];
      confluenceSpaceKeys: string[];
    };
    questions: Array<{
      id: string;
      prompt: string;
      candidateIds?: string[];
    }>;
    assumptions: Array<{
      id: string;
      text: string;
    }>;
  };
}

export interface ResearchClarificationReviewResolutionInputV1 {
  answers: Array<Pick<ResearchBriefClarificationResponseV1, "questionId" | "response">>;
  assumptionDecisions: ResearchBriefAssumptionDecisionV1[];
}

/** The post-answer checkpoint either requires plan review or is resumable. */
export type ResearchClarificationReviewResolutionV1 =
  | { kind: "plan_review"; review: ResearchSessionPlanReviewV1 }
  | { kind: "resumable"; session: ResearchResumableSessionV1 };

function activeTurn(session: ResearchSessionV1) {
  return session.activeTurnId
    ? session.turns.find((candidate) => candidate.id === session.activeTurnId)
    : undefined;
}

/**
 * Projects either a true clarification wait or the narrow recovery state left
 * after an answer CAS succeeded but before the subsequent graph proposal.
 */
export function projectResearchSessionClarificationReviewV1(
  session: ResearchSessionV1,
  expectedTenantOrigin: string,
): ResearchSessionClarificationReviewV1 | undefined {
  const turn = activeTurn(session);
  if (!turn?.brief || turn.brief.scope.siteOrigin !== expectedTenantOrigin) return undefined;

  const waitingForAnswers = session.status === "waiting_clarification" &&
    briefRequiresClarificationV1(turn.brief);
  const waitingForPlan = session.status === "planning" && !turn.graph &&
    !briefRequiresClarificationV1(turn.brief) &&
    (turn.clarifications.length > 0 || turn.assumptionDecisions.length > 0);
  if (!waitingForAnswers && !waitingForPlan) return undefined;

  const questions = waitingForAnswers
    ? turn.brief.clarificationQuestions
      .filter((question) => question.required)
      .map((question) => ({
        id: question.id,
        prompt: question.prompt,
        ...(question.candidateIds?.length ? { candidateIds: [...question.candidateIds] } : {}),
      }))
    : [];
  const assumptions = waitingForAnswers
    ? turn.brief.assumptions
      .filter((assumption) => assumption.requiresUserDecision && assumption.status === "proposed")
      .map((assumption) => ({ id: assumption.id, text: assumption.text }))
    : [];

  return {
    schema: RESEARCH_SESSION_CLARIFICATION_REVIEW_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status as "waiting_clarification" | "planning",
    stage: waitingForAnswers ? "answer_required" : "plan_required",
    updatedAt: session.updatedAt,
    turn: {
      id: turn.id,
      briefRevision: turn.brief.revision,
      scope: {
        jiraProjectKeys: [...turn.brief.scope.jiraProjectKeys],
        confluenceSpaceKeys: [...turn.brief.scope.confluenceSpaceKeys],
      },
      questions,
      assumptions,
    },
  };
}
