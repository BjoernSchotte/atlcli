/**
 * Non-frozen internals of `@atlcli/core`, mirroring `@atlcli/confluence`'s
 * `./internal` subpath (spec 009 classifies `./internal` as non-frozen, so a
 * module here carries no compatibility promise).
 *
 * Modules land here when they must be SHARED between sibling packages but must
 * not become public API. Today that is two things, both needed by BOTH REST
 * clients while neither package may depend on the other:
 *
 * - the `Retry-After` parser, previously copied verbatim into
 *   `packages/confluence/src/retry-after.ts` and `packages/jira/src/retry-after.ts`;
 * - the session-mode redirect destination policy (`./session-redirect.js`), which
 *   is what lets an attachment download follow Atlassian's media-CDN bounce while
 *   a login bounce still fails as a session expiry.
 *
 * Everything exported here must stay isomorphic — `packages/confluence/src/client.ts`
 * and `packages/jira/src/client.ts` are both browser-build entrypoints and both
 * reach this module.
 */
export {
  parseRetryAfterMs,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
} from "./retry-after.js";

export {
  ATLASSIAN_LOGIN_HOSTS,
  ATLASSIAN_MEDIA_HOST,
  SESSION_REDIRECT_MAX_HOPS,
  SessionRedirectBlockedError,
  createAtlassianSessionRedirectPolicy,
  fetchSessionBinaryFollowingRedirects,
  isAtlassianLoginTarget,
  isAtlassianMediaTarget,
  isSessionRedirectBlockedError,
  redactRedirectTarget,
} from "./session-redirect.js";
export type {
  AtlassianSessionRedirectPolicyOptions,
  SessionBinaryFetchLike,
  SessionBinaryFetchOptions,
  SessionRedirectPolicy,
} from "./session-redirect.js";
