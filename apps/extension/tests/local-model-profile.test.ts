import { describe, expect, it } from "bun:test";
import {
  LOCAL_GEMMA_HARNESS_PROFILE_V1,
  LOCAL_GEMMA_OPERATIONAL_PROFILE_V1,
  localGemmaContextOverflowMessageV1,
  localGemmaRouteOutputTokensV1,
  localGemmaThinkingModeV1,
} from "../utils/local-model/model-profile.js";

describe("local Gemma operational profile", () => {
  it("keeps usage unmetered while enforcing the per-invocation browser context", () => {
    expect(localGemmaContextOverflowMessageV1(
      LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInputTokens,
    )).toBeUndefined();
    expect(localGemmaContextOverflowMessageV1(
      LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInputTokens + 1,
    )).toContain("browser inference envelope");
  });

  it("maps Quick, Auto, and Think deeper onto Gemma's supported thinking controls", () => {
    expect(localGemmaThinkingModeV1("fast")).toBe("disabled");
    expect(localGemmaThinkingModeV1("balanced")).toBe("low");
    expect(localGemmaThinkingModeV1("thorough")).toBe("enabled");
  });

  it("removes only DeepAgentsJS's duplicate generic summarizer", () => {
    expect(LOCAL_GEMMA_HARNESS_PROFILE_V1.excludedMiddleware).toEqual([
      "SummarizationMiddleware",
    ]);
  });

  it("uses role-sized generation corridors instead of one maximal allowance", () => {
    expect(localGemmaRouteOutputTokensV1("extraction", 4_096)).toBe(1_024);
    expect(localGemmaRouteOutputTokensV1("extraction", 1_024)).toBe(1_024);
    expect(localGemmaRouteOutputTokensV1("root-planning", 4_096)).toBe(1_024);
    expect(localGemmaRouteOutputTokensV1("root-planning", 768)).toBe(768);
    expect(localGemmaRouteOutputTokensV1("analysis", 4_096)).toBe(1_024);
    expect(localGemmaRouteOutputTokensV1("critique", 4_096)).toBe(768);
    expect(localGemmaRouteOutputTokensV1("synthesis", 4_096)).toBe(1_024);
    expect(localGemmaRouteOutputTokensV1("synthesis", 512)).toBe(512);
  });
});
