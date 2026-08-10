import { describe, expect, test } from "bun:test";
import {
  buildChatSystemPromptV1,
  buildChatTurnPromptV1,
  chatAnswerOutputInstructionV1,
  deriveChatRequestChecklistV1,
} from "./prompts.js";

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
    expect(prompt).toContain("Headings and non-factual transitions use assertion=none");
    expect(prompt).toContain("sourceRefs");
    expect(prompt).toContain("list item, or table row");
    expect(prompt).not.toContain("tools.researchCandidateRank");
  });

  test("runs one persistent agentic eval program with an exact profile catalog", () => {
    const prompt = buildChatSystemPromptV1({
      qualityMode: "deep",
      maxDetailItemsPerProduct: 8,
      strategyDecisionRequired: true,
      agenticWorkflowRequired: true,
    });
    expect(prompt).toContain("In one eval program");
    expect(prompt).toContain("chatWorkflowRun exactly once");
    expect(prompt).toContain("Intermediate advance/review controls");
    expect(prompt).toContain("exact-context-reader");
    expect(prompt).toContain("chat-synthesizer");
    expect(prompt).not.toContain("chatWorkflowAdvance");
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

  test("keeps Quick structured answers inside the smaller direct-output corridor", () => {
    const quick = buildChatSystemPromptV1({
      qualityMode: "quick",
      maxDetailItemsPerProduct: 4,
      locale: "de",
    });
    const auto = buildChatSystemPromptV1({
      qualityMode: "auto",
      maxDetailItemsPerProduct: 4,
      locale: "de",
    });

    expect(quick).toContain("below 350 words and 16 blocks");
    expect(quick).toContain("do not reproduce the source document section by section");
    expect(auto).toContain("below 700 words and 60 blocks");
  });

  test("makes the structured-output repair corridor smaller for Quick", () => {
    const repair = chatAnswerOutputInstructionV1("quick", true);

    expect(repair).toContain("REPAIR OUTPUT CONTRACT (quick, hard limit)");
    expect(repair).toContain("at most 350 visible words and 16 blocks");
    expect(repair).toContain("grammatically complete");
    expect(repair).toContain("detached lowercase continuation paragraph");
    expect(repair).toContain("cannot be both directly measured and conjectural");
    expect(repair).toContain("selection predicate before satisfying a requested count or ranking");
    expect(repair).toContain("do not count them toward N");
    expect(repair).toContain("Finish the complete ChatAnswerDraftV2 JSON");
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

  test("projects explicit enumerated user facets without inventing requirements", () => {
    const question = [
      "Fasse ausschließlich die direkt verlinkte Seite knapp zusammen und nenne",
      "Modellgröße, gemessene Endgeschwindigkeit und die Einsatzempfehlung:",
      "https://tenant.invalid/wiki/spaces/SAFE/pages/100/Private-title",
    ].join(" ");

    expect(deriveChatRequestChecklistV1(question)).toEqual([
      "Modellgröße",
      "gemessene Endgeschwindigkeit",
      "die Einsatzempfehlung",
    ]);
    const prompt = buildChatTurnPromptV1({
      question,
      jiraProjectKeys: [],
      confluenceSpaceKeys: [],
      anchors: [],
    });
    expect(prompt).toContain("Explicit user request checklist");
    expect(prompt).toContain('"die Einsatzempfehlung"');
    expect(prompt).toContain("no added requirements");
  });

  test("does not manufacture a checklist for an ordinary unenumerated question", () => {
    expect(deriveChatRequestChecklistV1("Worum geht es auf dieser Seite?")).toEqual([]);
  });
});
