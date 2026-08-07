import { describe, expect, test } from "bun:test";
import { buildChatSystemPromptV1, buildChatTurnPromptV1 } from "./prompts.js";

describe("Chat supervisor prompt", () => {
  test("keeps direct discovery behind host-owned acquisition controllers", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "deep",
      maxDetailItemsPerProduct: 8,
      strategyDecisionRequired: true,
    });
    expect(prompt).toContain("tools.chatJiraRetrievalAcquire({})");
    expect(prompt).toContain("tools.chatConfluenceRetrievalAcquire({})");
    expect(prompt).toContain("raw search, rank, and detail tools are intentionally unavailable");
    expect(prompt).toContain("gaps field MUST be an actual JSON array");
    expect(prompt).toContain("below 700 words");
    expect(prompt).toContain("A citation on a heading does not cite the paragraphs beneath it");
    expect(prompt).toContain("list item, or table row");
    expect(prompt).not.toContain("tools.researchCandidateRank");
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

  test("projects only body-free planned-acquisition controls to direct Chat", () => {
    const prompt = buildChatTurnPromptV1({
      question: "Compare the bounded products.",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
      anchors: [],
      admittedSearches: [{
        product: "confluence",
        queries: [{ text: "design" }, { text: "architecture" }],
      }],
      directPlannedAcquisition: true,
    });

    expect(prompt).toContain('"product":"confluence","variantCount":2');
    expect(prompt).toContain("call the matching host acquisition controller exactly once");
    expect(prompt).not.toContain("design");
    expect(prompt).not.toContain("architecture");
  });
});
