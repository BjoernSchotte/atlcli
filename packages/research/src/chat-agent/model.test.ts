import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CAPABILITY_FREE_QUALITY_ADAPTER_V1 } from "../quality-policy.js";
import {
  resolveChatModelRouteV1,
  type ChatModelBindingV1,
} from "./model.js";

function binding(model: BaseChatModel): ChatModelBindingV1 {
  return {
    model,
    modelId: "one-model",
    qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
    structuredOutput: "tool",
  };
}

describe("provider-neutral Chat model routing", () => {
  test("keeps a capability-free one-model binding as a first-class route", () => {
    const model = {} as BaseChatModel;
    const route = resolveChatModelRouteV1(binding(model), {
      role: "critique",
      preference: "balanced",
    });

    expect(route).toEqual({
      model,
      effectiveModelId: "one-model",
      requestedPreference: "balanced",
      effectivePreference: "balanced",
      thinkingMode: "provider-default",
      finalizationCorridor: "standard",
    });
  });

  test("keeps the legacy bounded drafting, repair, and synthesis corridor explicit", () => {
    const model = {} as BaseChatModel;
    const finalizer = {} as BaseChatModel;
    const legacy = {
      ...binding(model),
      modelForFinalization: () => finalizer,
    };

    expect(resolveChatModelRouteV1(legacy, {
      role: "repair",
      preference: "balanced",
    })).toMatchObject({
      model: finalizer,
      requestedPreference: "balanced",
      effectivePreference: "fast",
      finalizationCorridor: "finalize-only",
    });
    expect(resolveChatModelRouteV1(legacy, {
      role: "synthesis",
      preference: "thorough",
    })).toMatchObject({
      model: finalizer,
      requestedPreference: "thorough",
      effectivePreference: "fast",
      finalizationCorridor: "finalize-only",
    });
  });
});
