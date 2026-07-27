import type { ValidatedAdfDocument } from "./adf-types.js";

/**
 * Trust marker for values produced by the bounded validator in this module
 * graph. Structural lookalikes never bypass validation.
 */
const trustedDocuments = new WeakSet<object>();

/**
 * Short-lived source-object cache. It avoids parsing the same ADF twice when a
 * client read flows directly into the decoder, without putting parsed page
 * bodies into serializable transport/job contracts.
 */
const sourceDocuments = new WeakMap<object, ValidatedAdfDocument>();

export function trustValidatedAdf(
  validated: ValidatedAdfDocument,
): ValidatedAdfDocument {
  trustedDocuments.add(validated);
  return validated;
}

export function isTrustedValidatedAdf(
  value: unknown,
): value is ValidatedAdfDocument {
  return (
    value !== null &&
    typeof value === "object" &&
    trustedDocuments.has(value)
  );
}

export function cacheValidatedAdfForSource(
  source: object,
  validated: ValidatedAdfDocument,
): void {
  if (!isTrustedValidatedAdf(validated)) {
    throw new TypeError("Only validateAdf() results can enter the ADF source cache.");
  }
  sourceDocuments.set(source, validated);
}

export function validatedAdfForSource(
  source: object,
): ValidatedAdfDocument | undefined {
  return sourceDocuments.get(source);
}
