import {
  classifyResearchError,
  redactResearchSecrets,
  type ResearchErrorCode,
} from "@atlcli/research";

const GENERIC_PROVIDER_ERROR_V1 = "The research provider failed.";

/**
 * Keep remote-provider redaction unchanged while making local browser-runtime
 * failures actionable. Local errors never cross a provider boundary, but may
 * still contain credentials from host plumbing, so the shared secret
 * redaction and length cap remain mandatory.
 */
export function classifyLocalGemmaHostErrorV1(
  value: unknown,
  localGemma: boolean,
): { code: ResearchErrorCode; message: string } {
  const classified = classifyResearchError(value);
  if (
    !localGemma ||
    classified.code !== "provider-error" ||
    classified.message !== GENERIC_PROVIDER_ERROR_V1
  ) {
    return classified;
  }
  const detail = redactResearchSecrets(value).trim();
  if (
    !detail ||
    detail === "undefined" ||
    detail === "null" ||
    detail === "[object Object]" ||
    detail === GENERIC_PROVIDER_ERROR_V1
  ) {
    return classified;
  }
  return {
    code: classified.code,
    message: `Local Gemma browser host failed: ${detail}`,
  };
}
