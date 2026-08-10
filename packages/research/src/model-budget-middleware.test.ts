import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ResearchModelRunBudget } from "./budget.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  createResearchModelBudgetMiddlewareV1,
  parseResearchModelCallObservationV1,
} from "./model-budget-middleware.js";

describe("research model budget middleware", () => {
  test("emits body-free category metrics without making observers authoritative", async () => {
    const budget = new ResearchModelRunBudget(DEFAULT_RESEARCH_LIMITS_V1);
    const observations: unknown[] = [];
    let clock = 100;
    const middleware = createResearchModelBudgetMiddlewareV1(budget, {
      name: "SafeObservationProof",
      maxOutputTokens: 1_000,
      onSnapshot: async () => {},
      observation: {
        role: "subagent",
        modelId: "synthetic-model",
        profileId: "comparison-analyst",
        phase: "analysis",
        wave: 1,
        attempt: 1,
        preference: "balanced",
        routeRole: "analysis",
        effectivePreference: "fast",
        thinkingMode: "disabled",
        finalizationCorridor: "standard",
      },
      onObservation: async (observation) => {
        observations.push(observation);
        throw new Error("diagnostic sink unavailable");
      },
      now: () => clock += 25,
    });
    const request = {
      model: { getName: () => "synthetic-model" },
      systemMessage: "private system text",
      messages: [{ content: "private prompt text" }],
      tools: [],
    } as never;
    const handler = async () => new AIMessage({
      content: "private answer text",
      response_metadata: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 40,
        },
      },
    });

    await expect(middleware.wrapModelCall!(request, handler)).resolves.toBeInstanceOf(AIMessage);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      schema: "atlcli.research-model-call-observation/v1",
      role: "subagent",
      status: "completed",
      profileId: "comparison-analyst",
      phase: "analysis",
      wave: 1,
      attempt: 1,
      routeRole: "analysis",
      effectivePreference: "fast",
      thinkingMode: "disabled",
      finalizationCorridor: "standard",
      observedUsage: {
        inputTokens: 100,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        outputTokens: 40,
      },
    });
    const serialized = JSON.stringify(observations[0]);
    expect(serialized).not.toContain("private prompt text");
    expect(serialized).not.toContain("private answer text");
    expect(serialized).not.toContain("private system text");
    expect(() => parseResearchModelCallObservationV1({
      ...(observations[0] as Record<string, unknown>),
      prompt: "private prompt text",
    })).toThrow("observation is invalid");
  });

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
