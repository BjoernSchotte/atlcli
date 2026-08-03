import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import { createResearchBriefV1 } from "./brief.js";
import { ResearchCapabilityBroker } from "./broker.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import { compileDynamicResearchSubagents } from "./dynamic-subagents.js";
import { composeResearchGraphV1 } from "./graph.js";
import { RESEARCH_PACKET_BODY_SCHEMA_V2 } from "./workflow-contracts.js";

describe("Jira focused-researcher acquisition", () => {
  test("reserves its single candidate-ranking call for the detail stage", () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:jira-acquisition",
      turnId: "research-turn:jira-acquisition",
      objective: "Which Jira work items explicitly link to the selected Confluence page?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const jira = compileDynamicResearchSubagents(graph, {
      model: fakeModel(),
      broker: {} as ResearchCapabilityBroker,
      question: brief.objective,
      maxInterpreterMs: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMs,
      maxInterpreterMemoryBytes: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMemoryBytes,
      maxPtcCalls: DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
      maxSearchPagesPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxSearchPagesPerProduct,
      maxDetailItemsPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxDetailItemsPerProduct,
      maxPacketChars: DEFAULT_RESEARCH_LIMITS_V1.maxPtcOutputBytes,
    }).find((subagent) => subagent.name.includes("jira-lookup"));

    expect(jira?.systemPrompt).toContain("retain the complete deduplicated opaque entityRef set for stage 2");
    expect(jira?.systemPrompt).toContain("Call tools.researchCandidateRank exactly once");
    expect(jira?.systemPrompt).not.toContain("then give the complete deduplicated set to tools.researchCandidateRank");
  });
});
