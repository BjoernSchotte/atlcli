import { describe, expect, it } from "bun:test";
import {
  LOCAL_GEMMA_OPERATIONAL_PROFILE_V1,
  localGemmaContextOverflowMessageV1,
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
});
