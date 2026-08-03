import { describe, expect, test } from "bun:test";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  ResearchModelRunBudget,
  ResearchRunBudget,
  parseResearchModelBudgetStateV1,
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
  test("keeps enough default token headroom for finalization while the $2 ceiling stays binding", () => {
    expect(DEFAULT_RESEARCH_LIMITS_V1).toMatchObject({
      maxTotalModelInputTokens: 250_000,
      maxModelCostMicros: 2_000_000,
      maxRunMs: 10 * 60_000,
    });

    const budget = new ResearchModelRunBudget(DEFAULT_RESEARCH_LIMITS_V1);
    const first = budget.reserve({ messages: [{ content: "Earlier bounded workflow context.".repeat(7_000) }] }, 8_000);
    budget.settle(first, {
      response_metadata: { usage: { input_tokens: 50_000, output_tokens: 19_000 } },
    });

    // A final response-format invocation can carry a large compacted
    // transcript. It is admitted here because its conservative dollar
    // reservation remains below $2; the monetary ceiling remains the
    // authoritative limiter, not an arbitrary lower input-token total.
    expect(() => budget.reserve({
      messages: [{ content: "Final structured response context.".repeat(9_000) }],
      responseFormat: { type: "json_schema" },
    }, 8_000)).not.toThrow();
  });

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
    })).toEqual({ calls: 1, inputTokens: 300, outputTokens: 200, costMicros: 4_200 });
  });

  test("uses long-context rates only when one request can cross that threshold", () => {
    const standard = new ResearchModelRunBudget(DEFAULT_RESEARCH_LIMITS_V1);
    const standardReservation = standard.reserve({ messages: [] }, 100);
    expect(standard.settle(standardReservation, {
      response_metadata: { usage: { input_tokens: 300, output_tokens: 200 } },
    }).costMicros).toBe(4_200);

    const longContext = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelInputTokens: 200_001,
    });
    const longContextReservation = longContext.reserve({ messages: [] }, 100);
    expect(longContext.settle(longContextReservation, {
      response_metadata: { usage: { input_tokens: 300, output_tokens: 200 } },
    }).costMicros).toBe(6_400);
  });

  test("fails closed after an unaccounted provider error consumes a reservation", () => {
    const budget = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 2,
      maxTotalModelInputTokens: 5_000,
      maxTotalModelOutputTokens: 1_000,
      maxModelCostMicros: 40_000,
    });
    budget.reserve({ messages: [{ content: "First attempt." }] }, 1_000);
    expect(() => budget.reserve({ messages: [{ content: "Retry." }] }, 1))
      .toThrow("model run budget was exhausted before another provider call");
  });

  test("restores a persisted provider reservation without resetting its session ceiling", () => {
    const limits = {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 2,
      maxTotalModelInputTokens: 20_000,
      maxTotalModelOutputTokens: 2_000,
      maxModelCostMicros: 30_000,
    };
    const original = new ResearchModelRunBudget(limits);
    original.reserve({ messages: [{ content: "A provider request may have reached the service." }] }, 1_000);
    const state = original.state();
    expect(parseResearchModelBudgetStateV1(state)).toEqual(state);

    const resumed = new ResearchModelRunBudget(limits);
    resumed.restore(state);
    expect(resumed.snapshot()).toEqual(original.snapshot());
    expect(() => resumed.reserve({ messages: [{ content: "A second call." }] }, 1_000))
      .toThrow("model run budget was exhausted before another provider call");
  });

  test("retains an observed provider overage so a recovered session stays fail-closed", () => {
    const limits = {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 2,
      maxTotalModelInputTokens: 5_000,
      maxTotalModelOutputTokens: 500,
      maxModelCostMicros: 100_000,
    };
    const original = new ResearchModelRunBudget(limits);
    const reservation = original.reserve({ messages: [{ content: "Bounded request." }] }, 500);
    original.settle(reservation, {
      response_metadata: { usage: { input_tokens: 500, output_tokens: 750 } },
    });
    expect(original.exceedsLimits()).toBe(true);
    const state = parseResearchModelBudgetStateV1(original.state());
    expect(state.snapshot.outputTokens).toBe(750);

    const resumed = new ResearchModelRunBudget(limits);
    resumed.restore(state);
    expect(() => resumed.reserve({ messages: [] }, 1)).toThrow("model run budget was exhausted before another provider call");
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

  test("reserves a complete PTC workflow without starving its final author", () => {
    const budget = new ResearchModelRunBudget(DEFAULT_RESEARCH_LIMITS_V1);
    const ptcTools = Array.from({ length: 7 }, (_, index) => ({
      name: `bounded_read_${index}`,
      description: "Runs one host-validated read-only operation.",
      schema: { type: "object" },
    }));
    const workflowPrompt = "Bounded one-shot research workflow. ".repeat(400);

    // The global budget has to admit the known complete graph, not only the
    // early supervisor and acquisition requests. Exact provider usage will
    // still settle below these pessimistic reservations when it is available.
    expect(() => {
      budget.reserve({ systemMessage: workflowPrompt, messages: [], tools: ptcTools }, 8_000);
      budget.reserve({ systemMessage: workflowPrompt, messages: [], tools: ptcTools }, 3_000);
      budget.reserve({ systemMessage: workflowPrompt, messages: [], tools: ptcTools }, 3_000);
      budget.reserve({ systemMessage: workflowPrompt, messages: [], tools: [{ name: "js_eval" }] }, 2_400);
      budget.reserve({
        systemMessage: workflowPrompt,
        messages: [{ content: "Compact accepted packets." }],
        tools: [{ name: "js_eval" }],
        responseFormat: { type: "json_schema" },
      }, 4_096);
    }).not.toThrow();
  });
});
