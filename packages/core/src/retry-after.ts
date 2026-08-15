/**
 * `Retry-After` parsing, shared by every REST client in the repo.
 *
 * This is the shared base module the duplicated copies in
 * `packages/confluence/src/retry-after.ts` and `packages/jira/src/retry-after.ts`
 * were marked as waiting for: both packages depend on `@atlcli/core` and neither
 * depends on the other, so `@atlcli/core` is the only home that does not create a
 * cycle. Those two files are now one-line re-exports, so each client keeps its
 * `./retry-after.js` import and there is exactly one parser.
 *
 * **Reached via `@atlcli/core/internal`, never the main barrel.** The clients'
 * barrels are part of the surface spec 009 froze; an internal header parser has
 * no business being a permanent compatibility commitment. The `./internal`
 * subpath is classified non-frozen for exactly this kind of module.
 */

/**
 * Bounds on a `Retry-After` delay.
 *
 * `MIN` exists because a `429` whose `Retry-After` says "0" is the server
 * contradicting itself; honouring it literally turns the retry loop into a burst
 * of back-to-back requests at the endpoint that just asked us to slow down.
 * `MAX` exists because the header is server-controlled and unbounded — one
 * absurd value used to become a `setTimeout` measured in years, i.e. a CLI that
 * looks hung with no way to tell it apart from a network stall.
 */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Milliseconds to wait after a `429`, read from the `Retry-After` header.
 *
 * Returns `undefined` for a header this cannot read as a delay, so the caller
 * falls back to its own exponential backoff rather than to a bad number.
 *
 * What this replaces — `parseInt(header, 10) * 1000` — had three failure modes,
 * all reachable from a value the *server* chooses:
 *
 *   - `Retry-After: unavailable` → `NaN` → `setTimeout(fn, NaN)` fires on the
 *     next tick, so a rate-limited client retries IMMEDIATELY, every attempt,
 *     and hammers the endpoint that just rate-limited it;
 *   - `Retry-After: -1` → a negative delay: the same immediate retry;
 *   - `Retry-After: 99999999` → a ~3-year wait.
 *
 * `parseInt` is also too permissive in the other direction: it reads `"1e9"` as
 * `1` and `"5 minutes"` as `5`, silently inventing a delay from a header it did
 * not actually understand. This requires the delta-seconds form to be digits
 * end to end, and accepts the RFC 9110 HTTP-date alternative — which always
 * starts with a day name, so a leading letter is what tells the two apart. That
 * check is load-bearing: `Date.parse("-1")` does NOT return `NaN`, it returns a
 * date in 2001, which would otherwise clamp to an immediate retry.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  options: { now?: number } = {}
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return undefined;
    return clampRetryAfterMs(seconds * 1000);
  }
  if (/^[A-Za-z]/.test(value)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    return clampRetryAfterMs(at - (options.now ?? Date.now()));
  }
  return undefined;
}

function clampRetryAfterMs(ms: number): number {
  if (!Number.isFinite(ms)) return RETRY_AFTER_MIN_MS;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}
