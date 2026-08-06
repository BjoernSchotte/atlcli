import { describe, expect, test } from "bun:test";
import { buildChatSystemPromptV1 } from "./prompts.js";

describe("Chat supervisor prompt", () => {
  test("makes the host-enforced search-rank-detail sequence executable", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "deep",
      maxDetailItemsPerProduct: 8,
      strategyDecisionRequired: true,
    });
    expect(prompt).toContain("page.items[].entityRef");
    expect(prompt).toContain("tools.researchCandidateRank");
    expect(prompt).toContain("Only entityRef values from that ranking result");
    expect(prompt).toContain("Never pass an entityRef directly from a search result");
  });

  test("allows persistent checkpointed agentic eval steps with an exact profile catalog", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "deep",
      maxDetailItemsPerProduct: 8,
      strategyDecisionRequired: true,
      agenticWorkflowRequired: true,
    });
    expect(prompt).toContain("separate eval calls");
    expect(prompt).toContain("exact-context-reader");
    expect(prompt).toContain("chat-synthesizer");
    expect(prompt).not.toContain("split this workflow across eval calls");
  });
});
