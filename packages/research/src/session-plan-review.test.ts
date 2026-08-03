import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1 } from "./graph.js";
import {
  createResearchSessionV1,
  reduceResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import { projectResearchSessionPlanReviewV1 } from "./session-plan-review.js";

const at = "2026-08-02T16:00:00.000Z";

function update<T extends Omit<ResearchSessionUpdateV1, "expectedRevision" | "expectedLeaseEpoch" | "at">>(
  session: ResearchSessionV1,
  value: T,
): ResearchSessionV1 {
  return reduceResearchSessionV1(session, {
    ...value,
    expectedRevision: session.revision,
    expectedLeaseEpoch: session.lease.epoch,
    at,
  } as ResearchSessionUpdateV1);
}

function waitingPlan(): ResearchSessionV1 {
  let session = createResearchSessionV1({
    sessionId: "research-session:plan-review",
    ownerId: "owner:plan-review",
    createdAt: at,
    leaseExpiresAt: "2026-08-02T16:10:00.000Z",
  });
  const brief = createResearchBriefV1({
    sessionId: session.sessionId,
    turnId: "research-turn:plan-review",
    objective: "Do not expose this private objective.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
      timeWindow: { from: "2026-07-01", to: "2026-08-02" },
    },
    scopeBindings: [{
      schema: "atlcli.research-scope-binding/v1",
      id: "scope-binding:cli-demo",
      tenantOrigin: "https://example.atlassian.net",
      product: "jira",
      entityKind: "project",
      entityRef: "research-scope-entity:cli-demo",
      key: "DEMO",
      name: "Demo project",
      source: "cli_flag",
      authority: "locked",
    }],
    coverageTargets: [{
      id: "coverage:primary",
      question: "Do not expose this private coverage wording.",
      required: true,
      sourceClasses: ["jira", "confluence"],
      minimumDistinctSources: 2,
    }],
    asOf: at,
    timezone: "UTC",
    requestedEffort: "deep",
    requestedPlanApproval: "required",
    requestedReconciliation: "required",
  });
  session = update(session, { kind: "create_turn", turnId: brief.turnId });
  session = update(session, { kind: "record_brief", brief });
  return update(session, { kind: "propose_graph", graph: composeResearchGraphV1(brief) });
}

describe("projectResearchSessionPlanReviewV1", () => {
  test("projects a body-free tenant-bound initial plan review", () => {
    const review = projectResearchSessionPlanReviewV1(
      waitingPlan(),
      "https://example.atlassian.net",
    );
    expect(review).toMatchObject({
      schema: "atlcli.research-session-plan-review/v1",
      status: "waiting_plan_approval",
      turn: {
        briefRevision: 1,
        graphRevision: 1,
        resolvedEffort: "deep",
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        timeWindow: { from: "2026-07-01", to: "2026-08-02" },
        scopeBindings: [{
          id: "scope-binding:cli-demo",
          key: "DEMO",
          source: "cli_flag",
          authority: "locked",
        }],
        coverageTargets: [{
          id: "coverage:primary",
          required: true,
          sourceClasses: ["jira", "confluence"],
          minimumDistinctSources: 2,
        }],
        replanEnvelope: expect.objectContaining({
          allowedCapabilityIds: expect.arrayContaining(["jira.issue.search"]),
        }),
        budget: {
          maxPtcCalls: 32,
          maxHttpCalls: 64,
          maxModelCalls: 16,
          maxTotalModelInputTokens: 160_000,
          maxTotalModelOutputTokens: 64_000,
          maxModelCostMicros: 2_000_000,
          maxRunMs: 120_000,
        },
      },
    });
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("private objective");
    expect(serialized).not.toContain("private coverage wording");
    expect(serialized).not.toContain("siteOrigin");
    expect(serialized).not.toContain("research-scope-entity:cli-demo");
  });

  test("denies a foreign tenant and delegates replacement plans to scope review", () => {
    const session = waitingPlan();
    expect(projectResearchSessionPlanReviewV1(session, "https://foreign.atlassian.net")).toBeUndefined();
    const replacement = {
      ...session,
      turns: session.turns.map((turn) => ({
        ...turn,
        scopeRevisions: [{
          schema: "atlcli.research-session-scope-revision/v1" as const,
          id: "scope-revision:related",
          proposalId: "scope-expansion:related",
          basedOnBriefRevision: 1,
          basedOnGraphRevision: 1,
          expansionKind: "whole_scope" as const,
          approvedBinding: {} as never,
          previousBrief: turn.brief!,
          previousGraph: turn.graph!,
          state: "proposed" as const,
          revisedBriefRevision: 2,
          proposedGraphRevision: 2,
          planDiff: {} as never,
        }],
      })),
    };
    expect(projectResearchSessionPlanReviewV1(replacement, "https://example.atlassian.net")).toBeUndefined();
  });
});
