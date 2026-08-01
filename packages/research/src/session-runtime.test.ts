import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1 } from "./graph.js";
import { initializeResearchSessionTurnV1 } from "./session-runtime.js";
import { InMemoryResearchSessionStoreV1 } from "./session-store.js";
import { createResearchSessionV1 } from "./session.js";

function brief(approval: "automatic" | "required") {
  return createResearchBriefV1({
    sessionId: "research-session:runtime-test",
    turnId: "research-turn:runtime-test",
    objective: "Find the related Jira work item.",
    scope: { siteOrigin: "https://example.atlassian.net", jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCS"] },
    asOf: "2026-08-01T15:00:00.000Z",
    timezone: "UTC",
    requestedPlanApproval: approval,
  });
}

function session() {
  return createResearchSessionV1({
    sessionId: "research-session:runtime-test",
    ownerId: "owner:runtime",
    createdAt: "2026-08-01T15:00:00.000Z",
    leaseExpiresAt: "2026-08-01T15:10:00.000Z",
  });
}

describe("durable research session execution gate", () => {
  test("persists an accepted turn, brief, exact proposed graph, and separate automatic approval before execution", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({ status: "running", revision: 5 });
    expect(result.turns[0]).toMatchObject({ brief: { objective: "Find the related Jira work item." }, graph: { status: "approved" } });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph", "approve_graph"]);
  });

  test("leaves a required plan durably waiting without any approval transition", async () => {
    const requiredBrief = brief("required");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: requiredBrief,
      graph: composeResearchGraphV1(requiredBrief),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({ status: "waiting_plan_approval", revision: 4 });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph"]);
  });
});
