import type { ValidatedAdfDocument } from "./types.js";

/**
 * Runtime trust marker shared by every consumer of the bounded ADF validator.
 * Structural lookalikes cannot bypass validation across package boundaries.
 */
const trustedDocuments = new WeakSet<object>();

export function trustValidatedAdf(
  validated: ValidatedAdfDocument,
): ValidatedAdfDocument {
  trustedDocuments.add(validated);
  return validated;
}

export function isTrustedValidatedAdf(
  value: unknown,
): value is ValidatedAdfDocument {
  return value !== null && typeof value === "object" && trustedDocuments.has(value);
}
