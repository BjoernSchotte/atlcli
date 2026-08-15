import {
  isTrustedValidatedAdf,
  type ValidatedAdfDocument,
} from "@atlcli/change-set/adf";

export {
  isTrustedValidatedAdf,
  trustValidatedAdf,
} from "@atlcli/change-set/adf";

/**
 * Short-lived source-object cache. It avoids parsing the same ADF twice when a
 * client read flows directly into the decoder, without putting parsed page
 * bodies into serializable transport/job contracts.
 */
const sourceDocuments = new WeakMap<object, ValidatedAdfDocument>();

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
