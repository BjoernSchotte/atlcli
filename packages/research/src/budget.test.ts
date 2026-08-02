import { describe, expect, test } from "bun:test";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
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
