/**
 * `Retry-After` parsing for the Jira REST client.
 *
 * The implementation moved to `@atlcli/core` (`src/retry-after.ts`, reached via
 * the non-frozen `./internal` subpath): it was byte-identical here and in
 * `packages/confluence/src/retry-after.ts`, and both packages depend on
 * `@atlcli/core` while neither depends on the other — so that is the only home
 * that does not create a cycle. Wave 1 recorded the duplication as debt pending
 * exactly this refactor.
 *
 * This file stays as the seam so `client.ts` keeps its `./retry-after.js`
 * import and the parser never reaches the package barrel.
 */
export {
  parseRetryAfterMs,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
} from "@atlcli/core/internal";
