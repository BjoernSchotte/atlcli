import { ResearchContractError } from "./contracts.js";

export const RESEARCH_ANTHROPIC_SESSION_KEY =
  "research-anthropic-key-v1" as const;

export function normalizeAnthropicApiKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new ResearchContractError("missing-key", "An Anthropic API key is required.");
  }
  const key = value.trim();
  if (!key) {
    throw new ResearchContractError("missing-key", "An Anthropic API key is required.");
  }
  if (key.length > 1_000 || /[\u0000-\u0020\u007f]/.test(key)) {
    throw new ResearchContractError("invalid-key", "The Anthropic API key is invalid.");
  }
  return key;
}
