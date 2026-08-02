import { describe, expect, test } from "bun:test";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  ResearchModelRunBudget,
  ResearchRunBudget,
  parseResearchRunBudgetStateV1,
} from "./budget.js";

describe("durable research budget state", () => {
  test("restores every limiter before the next provider call", () => {
    const original = new ResearchRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxPtcCalls: 2,
      maxHttpCalls: 2,
      maxSearchPagesPerProduct: 1,
      maxDetailItemsPerProduct: 1,
      maxItemsPerProduct: 1,
    });
    original.beginPtc({ tool: "synthetic" });
    original.guardTransport({ type: "attempt" });
    original.guardTransport({ type: "response", responseBytes: 12 });
    original.beginSearchPage("jira");
    original.addItems("jira", 1);
    original.beginDetail("jira");

    const restored = new ResearchRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxPtcCalls: 2,
      maxHttpCalls: 2,
      maxSearchPagesPerProduct: 1,
      maxDetailItemsPerProduct: 1,
      maxItemsPerProduct: 1,
    });
    restored.restore(original.state());

    expect(restored.state()).toEqual(original.state());
    expect(() => restored.beginPtc({ tool: "second" })).not.toThrow();
    expect(() => restored.beginPtc({ tool: "third" })).toThrow("PTC call budget was exhausted");
    expect(() => restored.beginSearchPage("jira")).toThrow("search page budget was exhausted");
  });

  test("rejects an over-limit or malformed durable projection", () => {
    expect(() => parseResearchRunBudgetStateV1({ schema: "atlcli.research-run-budget/v1" }))
      .toThrow("budget state is invalid");
    expect(() => parseResearchRunBudgetStateV1({
      schema: "atlcli.research-run-budget/v1",
      ptcCalls: DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls + 1,
      httpAttempts: 0,
      responseBytes: 0,
      pages: { jira: 0, confluence: 0 },
      items: { jira: 0, confluence: 0 },
      details: { jira: 0, confluence: 0 },
    }, DEFAULT_RESEARCH_LIMITS_V1)).toThrow("exceeds this run's limits");
  });
});

describe("model run budget", () => {
  test("reserves a conservative provider ceiling before concurrent model work starts", () => {
    const budget = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 1,
      maxTotalModelInputTokens: 5_000,
      maxTotalModelOutputTokens: 2_000,
      maxModelCostMicros: 100_000,
    });
    const reservation = budget.reserve({
      messages: [{ content: "Summarize the bounded evidence." }],
      tools: [{ name: "read_only_tool", schema: { type: "object" } }],
    }, 1_000);

    expect(budget.snapshot()).toMatchObject({ calls: 1, outputTokens: 1_000 });
    expect(() => budget.reserve({ messages: [] }, 1_000))
      .toThrow("model run budget was exhausted before another provider call");
    expect(budget.settle(reservation, {
      response_metadata: { usage: { input_tokens: 300, output_tokens: 200 } },
    })).toEqual({ calls: 1, inputTokens: 300, outputTokens: 200, costMicros: 6_400 });
  });

  test("fails closed after an unaccounted provider error consumes a reservation", () => {
    const budget = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 2,
      maxTotalModelInputTokens: 5_000,
      maxTotalModelOutputTokens: 1_000,
      maxModelCostMicros: 100_000,
    });
    budget.reserve({ messages: [{ content: "First attempt." }] }, 1_000);
    expect(() => budget.reserve({ messages: [{ content: "Retry." }] }, 1))
      .toThrow("model run budget was exhausted before another provider call");
  });

  test("estimates provider payloads without counting non-serialized schema internals", () => {
    const budget = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxTotalModelInputTokens: 5_000,
      maxTotalModelOutputTokens: 1_000,
      maxModelCostMicros: 100_000,
    });
    const schemaInternal = { privateMetadata: "x".repeat(100_000) };
    expect(() => budget.reserve({
      messages: [{ content: "Summarize bounded evidence." }],
      tools: [{ name: "read_only_tool", description: "Reads one bounded source.", schema: schemaInternal }],
      runtime: { nonSerializedMetadata: schemaInternal },
    }, 1_000)).not.toThrow();
  });
});
