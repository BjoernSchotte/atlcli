/**
 * The upstream client references this constant while constructing headers.
 * API-key requests do not add it; retaining the exact value preserves client
 * behavior if the unused OAuth branch is inspected.
 */
export const OAUTH_API_BETA_HEADER = "oauth-2025-04-20";
