import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import {
  ANTHROPIC_QUALITY_ADAPTER_V1,
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  CHAT_QUALITY_MODES_V1,
  chatQualityPolicyV1,
  createPromptCacheSegmentsV1,
  decodeStoredChatQualityPolicyV1,
  normalizeChatQualityPolicyV1,
  persistChatQualityPolicyV1,
  projectPromptCacheSystemContentV1,
  readStoredChatQualityPolicyV1,
  resolveProviderQualityV1,
  resolveResearchRoleModelV1,
} from "./quality-policy.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

describe("provider-neutral chat quality policy", () => {
  test("defines closed workflow semantics independently of provider controls", () => {
    expect(CHAT_QUALITY_MODES_V1).toEqual(["quick", "auto", "deep"]);
    expect(chatQualityPolicyV1("quick")).toMatchObject({
      delegation: "disabled",
      completionTarget: "direct",
      planning: "none",
      providerReasoningPreference: "fast",
    });
    expect(chatQualityPolicyV1("auto")).toMatchObject({
      delegation: "adaptive",
      completionTarget: "sufficient-validated",
      planning: "automatic",
      providerReasoningPreference: "balanced",
    });
    expect(chatQualityPolicyV1("deep")).toMatchObject({
      delegation: "strategy-required",
      completionTarget: "sufficient-validated",
      planning: "automatic",
      providerReasoningPreference: "thorough",
    });
    expect(chatQualityPolicyV1("auto").deadline).toBeUndefined();
  });

  test("maps hints only when a provider supports them", () => {
    const policy = chatQualityPolicyV1("deep");
    expect(ANTHROPIC_QUALITY_ADAPTER_V1.reasoningControls(
      policy.providerReasoningPreference,
    )).toEqual({ effort: "high", adaptiveThinking: true });
    expect(CAPABILITY_FREE_QUALITY_ADAPTER_V1.reasoningControls(
      policy.providerReasoningPreference,
    )).toBeUndefined();
    expect(policy).toEqual(chatQualityPolicyV1("deep"));
    const capable = resolveProviderQualityV1(
      policy,
      ANTHROPIC_QUALITY_ADAPTER_V1,
    );
    const capabilityFree = resolveProviderQualityV1(
      policy,
      CAPABILITY_FREE_QUALITY_ADAPTER_V1,
    );
    expect(capable.workflow).toEqual(capabilityFree.workflow);
    expect(capable.controls).toEqual({ effort: "high", adaptiveThinking: true });
    expect(capabilityFree.controls).toBeUndefined();
  });

  test("rejects unknown fields and invalid deadline combinations", () => {
    expect(() => normalizeChatQualityPolicyV1({
      ...chatQualityPolicyV1("auto"),
      providerEffort: "high",
    })).toThrow("Chat quality policy is invalid.");
    expect(() => normalizeChatQualityPolicyV1({
      ...chatQualityPolicyV1("deep"),
      deadline: {
        softDeadlineMs: 10_000,
        hardDeadlineMs: 5_000,
        finalizationReserveMs: 1_000,
      },
    })).toThrow("Chat quality policy is invalid.");
    expect(() => normalizeChatQualityPolicyV1({
      ...chatQualityPolicyV1("quick"),
      delegation: "adaptive",
    })).toThrow("Chat quality policy is invalid.");
    expect(normalizeChatQualityPolicyV1({
      ...chatQualityPolicyV1("deep"),
      deadline: {
        softDeadlineMs: 5_000,
        hardDeadlineMs: 10_000,
        finalizationReserveMs: 1_000,
      },
    }).deadline).toEqual({
      softDeadlineMs: 5_000,
      hardDeadlineMs: 10_000,
      finalizationReserveMs: 1_000,
    });
  });

  test("allows provider preference overrides without changing the accepted workflow", () => {
    const policy = normalizeChatQualityPolicyV1({
      ...chatQualityPolicyV1("quick"),
      providerReasoningPreference: "thorough",
    });
    expect(policy).toMatchObject({
      mode: "quick",
      delegation: "disabled",
      completionTarget: "direct",
      planning: "none",
      scopeExpansion: "deny",
      providerReasoningPreference: "thorough",
    });
  });

  test("routes provider-neutral role profiles and safely falls back", () => {
    const fallback = fakeModel();
    const fast = fakeModel();
    const strong = fakeModel();
    expect(resolveResearchRoleModelV1("focused-researcher", fallback, {
      "fast-reader": fast,
    })).toBe(fast);
    expect(resolveResearchRoleModelV1("synthesizer", fallback, {
      "strong-reasoner": strong,
    })).toBe(strong);
    expect(resolveResearchRoleModelV1("synthesizer", fallback)).toBe(fallback);
  });

  test("keeps all private and revision-specific material outside the cacheable prefix", () => {
    const segments = createPromptCacheSegmentsV1({
      supervisorPrompt: "stable supervisor v1",
      toolSchemas: ["stable tool schema"],
      responseSchemas: ["stable response schema"],
      userInput: "private user question",
      evidenceBodies: ["private evidence body"],
      credentials: ["secret credential"],
      steeringRevisions: ["private steering revision"],
    });
    expect(segments.stable).toEqual([
      "stable supervisor v1",
      "stable tool schema",
      "stable response schema",
    ]);
    expect(segments.private).toEqual([
      "private user question",
      "private evidence body",
      "secret credential",
      "private steering revision",
    ]);
    expect(segments.stable.join("\n")).not.toMatch(/private|secret/);
  });

  test("omits empty content blocks before provider prompt-cache projection", () => {
    expect(createPromptCacheSegmentsV1({
      supervisorPrompt: "stable supervisor v1",
      toolSchemas: ["", "stable tool schema"],
      responseSchemas: ["   "],
      userInput: "",
      evidenceBodies: ["\n"],
    })).toEqual({
      stable: ["stable supervisor v1", "stable tool schema"],
      private: [],
    });
  });

  test("marks only the stable system prefix and appends private content uncached", () => {
    expect(projectPromptCacheSystemContentV1({
      existingContent: [
        { type: "text", text: "stable host prompt" },
        { type: "text", text: "\n\n" },
        { type: "text", text: "stable DeepAgents prompt" },
      ],
      privateSegments: ["private turn context"],
      cacheStablePrefix: true,
    })).toEqual([
      { type: "text", text: "stable host prompt" },
      {
        type: "text",
        text: "stable DeepAgents prompt",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
      { type: "text", text: "private turn context" },
    ]);
  });

  test("persists canonical state and limits legacy decoding to stored state", async () => {
    const workspace = createMemoryResearchWorkspace();
    await persistChatQualityPolicyV1(workspace, chatQualityPolicyV1("auto"));
    expect(await readStoredChatQualityPolicyV1(workspace)).toEqual(
      chatQualityPolicyV1("auto"),
    );
    expect(decodeStoredChatQualityPolicyV1({ requestedEffort: "lookup" }))
      .toEqual(chatQualityPolicyV1("quick"));
    expect(decodeStoredChatQualityPolicyV1({ requestedEffort: "deep" }))
      .toEqual(chatQualityPolicyV1("deep"));
  });
});
