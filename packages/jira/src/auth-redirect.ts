/**
 * Session-auth response guards for the Jira REST client (spec 010 wave 2,
 * adversarial-review finding B1).
 *
 * **Deliberately NOT re-exported from any barrel.** `src/index.ts` does
 * `export * from "./client.js"`, so declaring these in `client.ts` would add
 * them to the API surface spec 009 froze — a permanent compatibility
 * commitment for an internal guard. They live here so they can be unit-tested
 * directly without being published: the same call wave 1 made for
 * `retry-after.ts`.
 *
 * ## What this closes
 *
 * `JiraClient` set `credentials: "include"` for session profiles but, unlike
 * `ConfluenceClient`, never set `redirect: "manual"` and carried no redirect
 * guard. An expired Atlassian session answers an API call with
 * `302 → id.atlassian.com → 200 text/html`; fetch FOLLOWED that bounce and the
 * login page came back as if it were issue JSON. The consumer then threw while
 * reading `issue.fields`, that throw was classified `network`, and the
 * extension's session-expiry latch never tripped — so every subsequent macro
 * fired another authenticated request at a site that had stopped
 * authenticating them. Reproduced as `{"kind":"network","expired":false}`.
 *
 * ## Relationship to ConfluenceClient
 *
 * These mirror `ConfluenceClient`'s private `assertNotAuthRedirect` /
 * `assertSessionJsonOk` (`packages/confluence/src/client.ts`) in behaviour,
 * call-site placement, taxonomy AND message shape. The message shape is
 * load-bearing, not cosmetic: the extension classifies session expiry by
 * matching the clients' strings (`apps/extension/utils/read-path.ts`,
 * `apps/extension/utils/macros/session-ports.ts`), so `(302): authentication
 * redirect …` and `(login): non-JSON 200 response (login page …)` are kept
 * byte-compatible with Confluence's. They are free functions rather than
 * private methods only so the guard is testable in isolation.
 *
 * The message TEXT stays duplicated per package (it names the product), but the
 * decision that produces it no longer is: the destination policy the binary
 * download path uses lives in `@atlcli/core/internal`
 * (`packages/core/src/session-redirect.ts`), the non-frozen subpath both clients
 * already reach for `Retry-After` parsing. That is the only home that shares
 * code between Confluence and Jira without a cycle — `@atlcli/export-wiring`,
 * which owns the analogous external-asset policy, depends on
 * `@atlcli/confluence`.
 */

/** Why a session-auth response was rejected before it could be read as data. */
export type JiraSessionAuthReason =
  /** A 3xx (or opaque) bounce to the Atlassian login host. */
  | "auth-redirect"
  /** A 200 whose body is an HTML login page rather than API JSON. */
  | "login-page"
  /** A 200 whose JSON body is the server's own error envelope. */
  | "error-envelope";

/**
 * A session-mode response that must never be read as data.
 *
 * Distinct and typed so a caller can tell it apart from a generic network or
 * parse failure — which is the whole point of B1: the old behaviour produced an
 * indistinguishable `TypeError` deep inside a consumer. `name` is stable and
 * checked by {@link isJiraSessionAuthError}, so code that cannot import this
 * class (it is intentionally off the frozen barrel) can still classify it
 * without string-matching the message.
 */
export class JiraSessionAuthError extends Error {
  readonly reason: JiraSessionAuthReason;
  /**
   * The HTTP status this was derived from. `302` stands in for an opaque
   * redirect, whose real status is 0 — the same substitution Confluence makes.
   */
  readonly status: number;

  constructor(reason: JiraSessionAuthReason, status: number, message: string) {
    super(message);
    this.name = "JiraSessionAuthError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Type guard for {@link JiraSessionAuthError} that survives duplicate module
 * instances (two copies of the package in one bundle would break `instanceof`).
 */
export function isJiraSessionAuthError(err: unknown): err is JiraSessionAuthError {
  return err instanceof Error && err.name === "JiraSessionAuthError";
}

/**
 * The slice of `Response` the redirect guard reads. Structural so a
 * hand-constructed `Response` satisfies it with no cast.
 */
export interface RedirectCheckableResponse {
  readonly type?: string;
  readonly status: number;
}

/**
 * True when a response is a redirect we must not follow.
 *
 * With `redirect: "manual"` a browser surfaces the bounce as an opaque redirect
 * (`type === "opaqueredirect"`, `status 0`); Bun/Node surface the raw 3xx
 * instead. Both shapes mean the same thing.
 */
export function isAuthRedirect(res: RedirectCheckableResponse): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

/**
 * The one place this package spells the session-expiry message.
 *
 * Both the JSON guard ({@link assertNotAuthRedirect}) and the binary redirect
 * follower in `client.ts`'s `downloadAttachment` build their error here, so the
 * phrasing the extension string-matches cannot drift between the two paths.
 */
export function sessionAuthRedirectError(status: number): JiraSessionAuthError {
  return new JiraSessionAuthError(
    "auth-redirect",
    status,
    `Jira API error (${status}): authentication redirect to Atlassian login (session not logged in)`
  );
}

/**
 * Session-mode guard for JSON API calls: a redirect means the ambient Atlassian
 * session is missing/expired (the request is being bounced to the login host).
 * Throw rather than follow it. No-op for CLI/token auth, whose requests keep
 * fetch's default follow behaviour.
 *
 * JSON-only on purpose. A REST endpoint has no legitimate reason to bounce
 * anywhere, so "any redirect is a login redirect" holds here. It does NOT hold
 * for `/rest/api/3/attachment/content/{id}`, which Cloud answers with a 302 to
 * the media CDN by design — that path classifies by DESTINATION instead (spec
 * 010 wave 2), so an attachment download can actually return bytes in session
 * mode.
 */
export function assertNotAuthRedirect(res: RedirectCheckableResponse, useSession: boolean): void {
  if (!useSession) return;
  if (!isAuthRedirect(res)) return;
  // An opaque redirect reports status 0, which carries no information and does
  // not match the `(\d{3})` the downstream classifiers scan for; 302 is the
  // canonical stand-in (Confluence hardcodes the same value).
  const status = res.status >= 300 && res.status < 400 ? res.status : 302;
  throw sessionAuthRedirectError(status);
}

/**
 * Session-mode guard for a 2xx response body. Atlassian answers some
 * unauthenticated/again-denied API calls with HTTP 200 whose body is NOT real
 * data — either an HTML login page (non-JSON), or a JSON error envelope
 * carrying its own `statusCode`. Both must become errors rather than be handed
 * back as if they were issue/search payloads. No-op for CLI/token auth.
 *
 * An empty body (e.g. a 200 from DELETE) is legitimate and is left alone.
 */
export function assertSessionJsonOk(
  text: string,
  data: unknown,
  isJson: boolean,
  useSession: boolean
): void {
  if (!useSession) return;
  if (text && !isJson) {
    throw new JiraSessionAuthError(
      "login-page",
      200,
      "Jira API error (login): non-JSON 200 response (login page — session not logged in)"
    );
  }
  if (isJson && data && typeof data === "object") {
    const statusCode = (data as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400) {
      const message = (data as { message?: unknown }).message;
      throw new JiraSessionAuthError(
        "error-envelope",
        statusCode,
        // The server's OWN status is preserved so downstream keeps its 401 /
        // 403 / 404 taxonomy instead of collapsing everything to "logged out".
        `Jira API error (${statusCode}): ${typeof message === "string" ? message : "error response body"}`
      );
    }
  }
}
