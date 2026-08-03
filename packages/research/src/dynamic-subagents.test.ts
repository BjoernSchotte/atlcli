import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { createResearchBriefV1 } from "./brief.js";
import { ResearchCapabilityBroker } from "./broker.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  boundResearchNodePtcToolsV1,
  buildResearchAcquisitionProgram,
  compileDynamicResearchSubagents,
} from "./dynamic-subagents.js";
import { composeResearchGraphV1 } from "./graph.js";
import { RESEARCH_PACKET_BODY_SCHEMA_V2 } from "./workflow-contracts.js";

describe("Jira focused-researcher acquisition", () => {
  test("uses one host-generated program with one candidate-ranking stage", () => {
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

    expect(jira?.systemPrompt).toContain("single host-generated bounded program");
    expect(jira?.systemPrompt).toContain("Do not call eval a second time");
    expect(jira?.systemPrompt).toContain("Select at most 4 claimCandidates");
    expect(jira?.systemPrompt).toContain("exact detail quotes of at most 280 characters");
    expect(jira?.systemPrompt).not.toContain("exactly two bounded stages");
    expect(jira?.systemPrompt).not.toContain("Stage 2 — read evidence");

    const program = buildResearchAcquisitionProgram(
      (graph.nodes.find((node) => node.id === "research-node:jira-lookup"))!,
      brief.objective,
      8,
      4,
    );
    expect(program).toContain("const result = await collect(search)");
    expect(program).toContain("const ranked = entityRefs.length === 0");
    expect(program).toContain("ranked.items.slice(0, 8)");
    expect(program.match(/tools\.researchCandidateRank/g)).toHaveLength(1);
  });

  test("caps concurrent PTC calls at the host-admitted node budget", async () => {
    let invoked = 0;
    const source = tool(async () => {
      invoked += 1;
      return "ok";
    }, {
      name: "read",
      description: "Synthetic read.",
      schema: z.object({}),
    });
    const [bounded] = boundResearchNodePtcToolsV1([source], 2, "research-node:bounded");
    const outcomes = await Promise.allSettled([
      bounded!.invoke({}),
      bounded!.invoke({}),
      bounded!.invoke({}),
    ]);

    expect(invoked).toBe(2);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
  });

  test("removes eval after the one permitted acquisition result", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:single-eval",
      turnId: "research-turn:single-eval",
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
    const worker = compileDynamicResearchSubagents(graph, {
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
    const middleware = worker?.middleware?.find((candidate) =>
      candidate.name === "ResearchCompletedEvalNoPtcMiddleware"
    );
    expect(middleware?.wrapModelCall).toBeDefined();
    let observed: unknown;
    await middleware!.wrapModelCall!({
      messages: [new ToolMessage({ content: "acquired", tool_call_id: "eval:1", name: "eval" })],
      tools: [{ name: "eval" }, { name: "ResearchPacketBodyV2" }],
      systemMessage: { concat: (value: string) => value },
    } as never, async (request) => {
      observed = request;
      return {} as never;
    });

    expect(observed).toMatchObject({
      tools: [{ name: "ResearchPacketBodyV2" }],
      systemMessage: "The one permitted acquisition eval has completed. Source reads are now unavailable. Do not write prose or call eval. Call exactly one remaining host response tool (ResearchPacketBodyV2) with the schema-valid result derived solely from the completed acquisition.",
    });
  });
});
