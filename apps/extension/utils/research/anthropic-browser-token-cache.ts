/**
 * Fail-closed stand-in for the SDK's optional OAuth token cache.
 *
 * The explicit API-key path never constructs this class. Its presence keeps
 * the upstream client module shape intact without bundling the Node credential
 * providers used by profile/OIDC authentication.
 */
export class TokenCache {
  constructor() {
    throw new Error(
      "Anthropic OAuth credential caching is unavailable in the browser research worker."
    );
  }
}
