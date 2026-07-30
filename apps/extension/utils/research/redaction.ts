import {
  ResearchContractError,
  type ResearchErrorCode,
} from "./contracts.js";

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/gi,
  /(x-api-key\s*[:=]\s*)[^\s,;]+/gi,
  /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
] as const;

export function redactResearchSecrets(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, "$1[REDACTED]");
  }
  return message.slice(0, 2_000);
}

function classifiedError(
  code: ResearchErrorCode,
  message: string
): { code: ResearchErrorCode; message: string } {
  return { code, message };
}

export function classifyResearchError(value: unknown): {
  code: ResearchErrorCode;
  message: string;
} {
  if (value instanceof ResearchContractError) {
    return { code: value.code, message: redactResearchSecrets(value) };
  }
  const message = redactResearchSecrets(value);
  const normalized = message.toLowerCase();
  if (normalized.includes("api key") && normalized.includes("missing")) {
    return classifiedError("missing-key", "An Anthropic API key is required.");
  }
  if (
    normalized.includes("invalid x-api-key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("authentication_error")
  ) {
    return classifiedError("invalid-key", "The Anthropic API key was rejected.");
  }
  if (normalized.includes("rate_limit") || normalized.includes("status 429")) {
    return classifiedError("rate-limited", "The provider rate limit was reached.");
  }
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return classifiedError("cancelled", "The research run was cancelled.");
  }
  return classifiedError("provider-error", "The research provider failed.");
}
