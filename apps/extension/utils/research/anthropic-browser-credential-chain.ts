/**
 * Browser build guard for the Anthropic SDK's optional local credential chain.
 *
 * The research worker always constructs ChatAnthropic with an explicit API
 * key held in chrome.storage.session. The SDK nevertheless imports its
 * filesystem-backed default credential resolver eagerly. Keeping that resolver
 * in an MV3 bundle would pull node:fs/node:path into the worker even though the
 * explicit-key branch never calls it.
 */
function unavailable(): never {
  throw new Error(
    "Anthropic local credential profiles are unavailable in the browser; provide an explicit session API key."
  );
}

export function defaultCredentials(): never {
  return unavailable();
}

export function resolveCredentialsFromConfig(): never {
  return unavailable();
}
