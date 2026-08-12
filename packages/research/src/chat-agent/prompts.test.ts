import { describe, expect, test } from "bun:test";
import {
  buildChatSystemPromptV1,
  buildChatTurnPromptV1,
  chatAnswerOutputInstructionV1,
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
    expect(repair).toContain("complete, self-contained statement in the user's language");
    expect(repair).toContain("detached continuation fragments");
    expect(repair).toContain("cannot be both directly measured and conjectural");
    expect(repair).toContain("selection predicate before satisfying a requested count or ranking");
    expect(repair).toContain("do not count them toward the requested set");
    expect(repair).toContain("Preserve the ranking direction expressed by the user");
    expect(repair).not.toContain("groesste");
    expect(repair).not.toContain("niedrigste");
    expect(repair).toContain("compare isolated interventions against a stated baseline");
    expect(repair).toContain("holding the requested outcome quality");
    expect(repair).toContain("bundled configuration change");
    expect(repair).toContain("preserve each effect measure explicitly reported by the source");
    expect(repair).toContain("must not replace an explicit source percentage");
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

  test("uses the original German, English, or French question as semantic guidance", () => {
    const questions = [
      "Nenne den Budgetrahmen und die jährliche Basisgebühr.",
      "State the budget range and the annual base fee.",
      "Indiquez la fourchette budgétaire et les frais annuels de base.",
    ];

    for (const question of questions) {
      const prompt = buildChatTurnPromptV1({
        question,
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
        anchors: [],
      });
      expect(prompt).toContain(JSON.stringify(question));
      expect(prompt).toContain("Judge coverage by meaning, not wording");
      expect(prompt).toContain("the user's chosen language");
      expect(prompt).toContain("Never copy question fragments merely to satisfy validation");
      expect(prompt).not.toContain("request checklist");
      expect(prompt).not.toContain("verbatim fragments");
    }
  });
});
