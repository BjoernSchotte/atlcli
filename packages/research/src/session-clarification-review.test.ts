import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { projectResearchSessionClarificationReviewV1 } from "./session-clarification-review.js";
import { createResearchSessionV1, reduceResearchSessionV1 } from "./session.js";

function waitingSession() {
  const created = createResearchSessionV1({
    sessionId: "research-session:clarification-review",
    ownerId: "owner:clarification-review",
    createdAt: "2026-08-02T12:00:00.000Z",
    leaseExpiresAt: "2026-08-02T12:10:00.000Z",
  });
  const turn = reduceResearchSessionV1(created, {
    kind: "create_turn",
    turnId: "research-turn:clarification-review",
    expectedRevision: created.revision,
    expectedLeaseEpoch: created.lease.epoch,
    at: "2026-08-02T12:00:01.000Z",
  });
  const brief = createResearchBriefV1({
    sessionId: turn.sessionId,
    turnId: "research-turn:clarification-review",
    objective: "Private objective must not appear in the review.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: "2026-08-02T12:00:00.000Z",
    timezone: "UTC",
    clarificationQuestions: [{
      id: "clarification:window",
      prompt: "Which reporting window should be used?",
      required: true,
    }],
    assumptions: [{
      id: "assumption:archive",
      text: "Include archived items.",
      requiresUserDecision: true,
      status: "proposed",
    }],
  });
  return reduceResearchSessionV1(turn, {
    kind: "record_brief",
    brief,
    expectedRevision: turn.revision,
    expectedLeaseEpoch: turn.lease.epoch,
    at: "2026-08-02T12:00:02.000Z",
  });
}

describe("projectResearchSessionClarificationReviewV1", () => {
  test("projects a tenant-bound question/decision wait without the objective", () => {
    const review = projectResearchSessionClarificationReviewV1(
      waitingSession(),
      "https://example.atlassian.net",
    );
    expect(review).toMatchObject({
      schema: "atlcli.research-session-clarification-review/v1",
      stage: "answer_required",
      turn: {
        briefRevision: 1,
        questions: [{ id: "clarification:window" }],
        assumptions: [{ id: "assumption:archive" }],
      },
    });
    expect(JSON.stringify(review)).not.toContain("Private objective");
    expect(projectResearchSessionClarificationReviewV1(
      waitingSession(),
      "https://other.atlassian.net",
    )).toBeUndefined();
  });

  test("projects an answer-committed planning checkpoint for recovery", () => {
    const waiting = waitingSession();
    const planning = reduceResearchSessionV1(waiting, {
      kind: "resolve_clarifications",
      briefRevision: 1,
      answers: [{ questionId: "clarification:window", response: "The last seven days." }],
      assumptionDecisions: [{ assumptionId: "assumption:archive", decision: "rejected" }],
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-02T12:00:03.000Z",
    });
    expect(projectResearchSessionClarificationReviewV1(
      planning,
      "https://example.atlassian.net",
    )).toMatchObject({
      status: "planning",
      stage: "plan_required",
      turn: { briefRevision: 2, questions: [], assumptions: [] },
    });
  });
});
