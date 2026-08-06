import {
  ResearchContractError,
  type ResearchErrorCode,
} from "./contracts.js";

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/gi,
  /(x-api-key\s*[:=]\s*)[^\s,;]+/gi,
  /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /(cookie\s*[:=]\s*)[^\s,;]+/gi,
  /(set-cookie\s*[:=]\s*)[^\r\n]+/gi,
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

const RESEARCH_ERROR_CODES = new Set<ResearchErrorCode>([
  "invalid-request",
  "missing-key",
  "invalid-key",
  "not-authenticated",
  "not-atlassian",
  "access-denied",
  "rate-limited",
  "provider-error",
  "limit-exceeded",
  "cancelled",
  "paused",
  "scope-approval-required",
  "clarification-required",
  "plan-approval-required",
  "invalid-report",
  "unknown",
]);

function bundledContractError(value: unknown): {
  code: ResearchErrorCode;
  message: string;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { name?: unknown; code?: unknown; message?: unknown };
  if (
    candidate.name !== "ResearchContractError" &&
    candidate.name !== "ChatContractError"
  ) return undefined;
  if (
    typeof candidate.code !== "string" ||
    !RESEARCH_ERROR_CODES.has(candidate.code as ResearchErrorCode) ||
    typeof candidate.message !== "string"
  ) return undefined;
  return {
    code: candidate.code as ResearchErrorCode,
    message: redactResearchSecrets(candidate.message),
  };
}

export function classifyResearchError(value: unknown): {
  code: ResearchErrorCode;
  message: string;
} {
  if (value instanceof ResearchContractError) {
    return { code: value.code, message: redactResearchSecrets(value) };
  }
  const bundled = bundledContractError(value);
  if (bundled) return bundled;
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
  if (/\(401\)|status\s*401/.test(normalized)) {
    return classifiedError("not-authenticated", "The Atlassian session is not authenticated.");
  }
  if (/\((?:403|404)\)|status\s*(?:403|404)/.test(normalized)) {
    return classifiedError("access-denied", "The Atlassian resource is unavailable.");
  }
  if (
    normalized.includes("rate_limit") ||
    normalized.includes("rate limited") ||
    normalized.includes("status 429")
  ) {
    return classifiedError("rate-limited", "The provider rate limit was reached.");
  }
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    return classifiedError("cancelled", "The research run was cancelled.");
  }
  return classifiedError("provider-error", "The research provider failed.");
}
