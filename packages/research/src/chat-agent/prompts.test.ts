import { describe, expect, test } from "bun:test";
import { buildChatSystemPromptV1, buildChatTurnPromptV1 } from "./prompts.js";

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

  test("publishes only the profile catalog available to the current turn", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "deep",
      maxDetailItemsPerProduct: 8,
      strategyDecisionRequired: true,
      agenticWorkflowRequired: true,
      allowedAgenticProfileIds: [
        "confluence-search-reader",
        "comparison-analyst",
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ],
    });
    const catalog = prompt.match(/complete model-selectable profile set is: ([^.]+)\./u)?.[1];
    expect(catalog).toContain("confluence-search-reader");
    expect(catalog).toContain("comparison-analyst");
    expect(catalog).not.toContain("exact-context-reader");
    expect(catalog).not.toContain("jira-search-reader");
  });

  test("localizes the answer and provider-visible reasoning summaries", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "auto",
      maxDetailItemsPerProduct: 4,
      locale: "de-DE",
    });

    expect(prompt).toContain("reasoning summaries in German");
    expect(prompt).toContain("source titles, Jira keys, and URLs unchanged");
  });

  test("pins direct Chat searches to the host-admitted query variants", () => {
    const prompt = buildChatTurnPromptV1({
      question: "Compare the bounded products.",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
      anchors: [],
      admittedSearches: [{
        product: "confluence",
        queries: [{ text: "design" }, { text: "architecture" }],
      }],
    });

    expect(prompt).toContain('"queries":[{"text":"design"},{"text":"architecture"}]');
    expect(prompt).toContain("copy one of these query objects exactly");
    expect(prompt).toContain("Do not paraphrase, broaden, or invent");
  });
});
