import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SETTINGS,
  memorySettingsStore,
  normalizeSettings,
} from "../utils/ports/settings.js";
import {
  ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
  browserChatActiveConversationStorageKeyV1,
  browserChatProviderCacheIdentityV1,
  LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
} from "../utils/local-model/selection.js";

describe("app settings", () => {
  it("keeps legacy records visible by default", () => {
    expect(normalizeSettings({ locale: "de" })).toEqual({
      locale: "de",
      lastWorkspace: null,
      hideRovoEntrypoints: false,
      modelSelection: ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    });
  });

  it("accepts only an explicit boolean true for Rovo hiding", () => {
    expect(
      normalizeSettings({ locale: "en", hideRovoEntrypoints: true })
    ).toEqual({
      locale: "en",
      lastWorkspace: null,
      hideRovoEntrypoints: true,
      modelSelection: ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    });
    expect(
      normalizeSettings({ locale: "en", hideRovoEntrypoints: "true" })
    ).toEqual({
      locale: "en",
      lastWorkspace: null,
      hideRovoEntrypoints: false,
      modelSelection: ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    });
  });

  it("accepts only the two exact shipped model selections", () => {
    expect(normalizeSettings({ modelSelection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1 }))
      .toEqual({ ...DEFAULT_SETTINGS, modelSelection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1 });
    expect(normalizeSettings({
      modelSelection: {
        ...LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
        modelRevision: "mutable-or-unknown",
      },
    })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({
      modelSelection: {
        schema: "atlcli.browser-model-selection/v1",
        providerId: "openai-compatible",
        modelId: "user-controlled",
      },
    })).toEqual(DEFAULT_SETTINGS);
  });

  it("isolates durable Chat identity and active pointers by selected model", () => {
    expect(browserChatProviderCacheIdentityV1(
      LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
      "browser-principal:fixture",
    )).toContain("local-gemma:onnx-community/gemma-4-E4B-it-ONNX");
    expect(browserChatActiveConversationStorageKeyV1(
      ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    )).toBe("atlcli.research.active-chat-conversation-id.v1");
    expect(browserChatActiveConversationStorageKeyV1(
      LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
    )).not.toBe(browserChatActiveConversationStorageKeyV1(
      ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
    ));
  });

  it("falls back safely for malformed records", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({ locale: "fr", hideRovoEntrypoints: 1 })
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("persists the combined workspace and Rovo settings through the memory port", async () => {
    const store = memorySettingsStore();
    await store.save({
      locale: "de",
      lastWorkspace: "ai",
      hideRovoEntrypoints: true,
      modelSelection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
    });
    expect(await store.load()).toEqual({
      locale: "de",
      lastWorkspace: "ai",
      hideRovoEntrypoints: true,
      modelSelection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
    });
  });
});
