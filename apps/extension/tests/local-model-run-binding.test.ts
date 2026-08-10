import { describe, expect, it } from "bun:test";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";
import { resolveBrowserChatModelRunBindingV1 } from "../utils/local-model/run-binding.js";
import {
  ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
  LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
} from "../utils/local-model/selection.js";
import {
  LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
  LOCAL_MODEL_CACHE_NAME_V1,
} from "../utils/local-model/storage.js";

const activation = {
  schema: LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
  selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
  cacheName: LOCAL_MODEL_CACHE_NAME_V1,
  installedAt: "2026-08-10T10:00:00.000Z",
  aggregateByteLength: LOCAL_GEMMA_G0_MANIFEST_V1.aggregateByteLength,
  files: LOCAL_GEMMA_G0_MANIFEST_V1.files,
};

describe("browser chat model run binding", () => {
  it("keeps the Anthropic credential path independent of local activation", async () => {
    let activationReads = 0;
    await expect(resolveBrowserChatModelRunBindingV1({
      selection: ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
      mode: "chat",
      readAnthropicApiKey: async () => "  synthetic-key  ",
      readLocalActivation: async () => {
        activationReads += 1;
        return undefined;
      },
    })).resolves.toEqual({ modelProvider: "anthropic", apiKey: "synthetic-key" });
    expect(activationReads).toBe(0);
  });

  it("binds installed Gemma without reading or sending an Anthropic key", async () => {
    let credentialReads = 0;
    await expect(resolveBrowserChatModelRunBindingV1({
      selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
      mode: "chat",
      readAnthropicApiKey: async () => {
        credentialReads += 1;
        return "must-not-be-read";
      },
      readLocalActivation: async () => activation,
    })).resolves.toEqual({ modelProvider: "local-gemma", apiKey: "" });
    expect(credentialReads).toBe(0);
  });

  it("fails closed for missing activation and Deep Research", async () => {
    const base = {
      selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
      readAnthropicApiKey: async () => "must-not-be-read",
      readLocalActivation: async () => undefined,
    } as const;
    await expect(resolveBrowserChatModelRunBindingV1({
      ...base,
      mode: "chat",
    })).rejects.toThrow("not installed and ready");
    await expect(resolveBrowserChatModelRunBindingV1({
      ...base,
      mode: "research",
    })).rejects.toThrow("Deep Research is unavailable");
  });
});
