import { describe, expect, test } from "bun:test";
import { DEFAULT_RESEARCH_LIMITS_V1, DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1 } from "./contracts.js";
import { projectResearchSessionScopeClarificationReviewV1 } from "./session-scope-clarification-review.js";
import { createResearchSessionV1, reduceResearchSessionV1 } from "./session.js";

function waitingScopeSession() {
  const session = createResearchSessionV1({
    sessionId: "research-session:scope-clarification-review",
    ownerId: "owner:scope-clarification-review",
    createdAt: "2026-08-02T12:00:00.000Z",
    leaseExpiresAt: "2026-08-02T12:10:00.000Z",
  });
  return reduceResearchSessionV1(session, {
    kind: "record_scope_clarification",
    request: {
      schema: "atlcli.research-request/v1",
      question: "Private Account Management question must not escape the review.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
      },
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      wikiProvider: "rest",
    },
    policy: DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
    clarification: {
      schema: "atlcli.research-clarification-required/v1",
      reason: "ambiguous",
      mentionId: "mention:scope-1",
      candidateIds: ["research-scope-candidate:account-management"],
      rerunGuidance: ["Pass an exact Confluence space with --space <KEY>."],
    },
    candidateChoices: [{
      schema: "atlcli.research-scope-candidate/v1",
      id: "research-scope-candidate:account-management",
      tenantOrigin: "https://example.atlassian.net",
      product: "confluence",
      entityKind: "space",
      entityRef: "space:account-management",
      key: "DOCS",
      name: "Account Management",
      accessible: true,
      providerFreshnessAt: "2026-08-02T12:00:00.000Z",
    }],
    expectedRevision: session.revision,
    expectedLeaseEpoch: session.lease.epoch,
    at: "2026-08-02T12:00:01.000Z",
  });
}

describe("projectResearchSessionScopeClarificationReviewV1", () => {
  test("projects only a tenant-bound candidate choice and omits the question", () => {
    const review = projectResearchSessionScopeClarificationReviewV1(
      waitingScopeSession(),
      "https://example.atlassian.net",
    );
    expect(review).toMatchObject({
      schema: "atlcli.research-session-scope-clarification-review/v1",
      stage: "choice_required",
      clarification: {
        mentionId: "mention:scope-1",
        candidates: [{ key: "DOCS", name: "Account Management" }],
      },
    });
    expect(JSON.stringify(review)).not.toContain("Private Account Management");
    expect(projectResearchSessionScopeClarificationReviewV1(
      waitingScopeSession(),
      "https://other.atlassian.net",
    )).toBeUndefined();
  });
});
