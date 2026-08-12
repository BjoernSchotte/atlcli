import { ResearchContractError } from "../research/contracts.js";
import { normalizeAnthropicApiKey } from "../research/credential.js";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "./manifest.js";
import type { BrowserModelSelectionV1 } from "./selection.js";
import { isLocalModelActivationV1 } from "./storage.js";

export interface BrowserChatModelRunBindingV1 {
  modelProvider: "anthropic" | "local-gemma";
  apiKey: string;
}

export async function resolveBrowserChatModelRunBindingV1(input: {
  selection: BrowserModelSelectionV1;
  mode: "chat" | "research";
  readAnthropicApiKey(): Promise<unknown>;
  readLocalActivation(): Promise<unknown>;
}): Promise<BrowserChatModelRunBindingV1> {
  if (input.selection.providerId === "anthropic") {
    return {
      modelProvider: "anthropic",
      apiKey: normalizeAnthropicApiKey(await input.readAnthropicApiKey()),
    };
  }
  if (input.mode === "research") {
    throw new ResearchContractError(
      "invalid-request",
      "Deep Research is unavailable for the selected local model.",
    );
  }
  if (!isLocalModelActivationV1(
    await input.readLocalActivation(),
    LOCAL_GEMMA_G0_MANIFEST_V1,
  )) {
    throw new ResearchContractError(
      "invalid-request",
      "The selected local model is not installed and ready.",
    );
  }
  return { modelProvider: "local-gemma", apiKey: "" };
}
