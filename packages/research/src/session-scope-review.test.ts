import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import {
  composeResearchGraphV1,
  stageResearchGraphForDurableSessionV1,
} from "./graph.js";
import { createResearchScopeExpansionProposalV1 } from "./scope-discovery.js";
import {
  createResearchSessionV1,
  reduceResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import { projectResearchSessionScopeReviewV1 } from "./session-scope-review.js";

const at = "2026-08-02T14:00:00.000Z";

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

function waitingForScopeApproval(): ResearchSessionV1 {
  let session = createResearchSessionV1({
    sessionId: "research-session:scope-review",
    ownerId: "owner:scope-review",
    createdAt: at,
    leaseExpiresAt: "2026-08-02T14:10:00.000Z",
  });
  const brief = createResearchBriefV1({
    sessionId: session.sessionId,
    turnId: "research-turn:scope-review",
    objective: "Inspect a related documentation space.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["DOCS"],
    },
    asOf: at,
    timezone: "UTC",
    requestedPlanApproval: "automatic",
  });
  session = update(session, { kind: "create_turn", turnId: brief.turnId });
  session = update(session, {
    kind: "record_brief",
    brief,
    scopeCandidates: [{
      schema: "atlcli.research-scope-candidate/v1",
      id: "research-scope-candidate:confluence-space-related",
      tenantOrigin: "https://example.atlassian.net",
      product: "confluence",
      entityKind: "space",
      entityRef: "opaque-related-space-ref",
      key: "RELATED",
      name: "Related documentation",
      canonicalUrl: "https://example.atlassian.net/wiki/spaces/RELATED",
      status: "current",
      match: "exact_link",
      accessible: true,
      providerFreshnessAt: at,
    }],
  });
  const graph = stageResearchGraphForDurableSessionV1(
    composeResearchGraphV1(session.turns[0]!.brief!),
  );
  session = update(session, { kind: "propose_graph", graph });
  session = update(session, { kind: "approve_graph", graphRevision: graph.revision });
  return update(session, {
    kind: "propose_scope_expansion",
    proposal: createResearchScopeExpansionProposalV1({
      id: "scope-expansion:related",
      sessionId: session.sessionId,
      turnId: brief.turnId,
      basedOnBriefRevision: brief.revision,
      basedOnGraphRevision: graph.revision,
      candidateId: "research-scope-candidate:confluence-space-related",
      expansionKind: "whole_scope",
      reason: "An exact link references this space.",
      provenanceRefs: ["source:related-link"],
      status: "proposed",
    }),
  });
}

describe("research session scope-review projection", () => {
  test("projects a tenant-bound, body-free scope decision with revision fences", () => {
    const session = waitingForScopeApproval();
    const projected = projectResearchSessionScopeReviewV1(
      session,
      "https://example.atlassian.net",
    );

    expect(projected).toMatchObject({
      schema: "atlcli.research-session-scope-review/v1",
      sessionId: session.sessionId,
      revision: session.revision,
      status: "waiting_scope_approval",
      turn: {
        briefRevision: 1,
        graphRevision: 1,
        candidates: [{ key: "RELATED", name: "Related documentation" }],
        expansionProposals: [{
          id: "scope-expansion:related",
          expansionKind: "whole_scope",
          status: "proposed",
        }],
      },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("tenantOrigin");
    expect(serialized).not.toContain("entityRef");
    expect(serialized).not.toContain("providerFreshnessAt");
    expect(serialized).not.toContain("owner:scope-review");
  });

  test("does not disclose a review to a different active tenant", () => {
    expect(projectResearchSessionScopeReviewV1(
      waitingForScopeApproval(),
      "https://other.atlassian.net",
    )).toBeUndefined();
  });
});
