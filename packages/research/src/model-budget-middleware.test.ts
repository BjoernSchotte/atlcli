import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ResearchModelRunBudget } from "./budget.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import { createResearchModelBudgetMiddlewareV1 } from "./model-budget-middleware.js";

describe("research model budget middleware", () => {
  test("releases a dynamic synthesis reserve after the protected work completes", async () => {
    const budget = new ResearchModelRunBudget({
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxModelCalls: 2,
      maxTotalModelInputTokens: 20_000,
      maxTotalModelOutputTokens: 4_000,
      maxModelCostMicros: 200_000,
    });
    let synthesisPending = true;
    const middleware = createResearchModelBudgetMiddlewareV1(budget, {
      name: "DynamicReserveProof",
      maxOutputTokens: 1_000,
      retain: () => synthesisPending
        ? { calls: 1, inputTokens: 2_000, outputTokens: 1_000 }
        : undefined,
      onSnapshot: async () => {},
    });
    const request = {
      messages: [{ content: "Bounded root context." }],
      tools: [],
    } as never;
    const handler = async () => new AIMessage("done");

    await middleware.wrapModelCall!(request, handler);
    await expect(middleware.wrapModelCall!(request, handler)).rejects.toThrow(
      "model run budget was exhausted before another provider call",
    );

    synthesisPending = false;
    await expect(middleware.wrapModelCall!(request, handler)).resolves.toBeInstanceOf(
      AIMessage,
    );
  });
});
