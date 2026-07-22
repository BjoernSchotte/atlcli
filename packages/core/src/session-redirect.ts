/**
 * Destination-based redirect classification for SESSION-mode binary/attachment
 * downloads (spec 010 wave 2).
 *
 * ## The design gap this closes
 *
 * Both REST clients set `redirect: "manual"` on *every* session-mode request
 * (`packages/confluence/src/client.ts`, `packages/jira/src/client.ts`). For a
 * JSON API call that is exactly right: an expired Atlassian session answers with
 * a 3xx to `id.atlassian.com`, and FOLLOWING that bounce hands a `200
 * text/html` login page back as if it were API JSON.
 *
 * But the guard keyed on *"is there a redirect"*, not on *"where does it go"* —
 * and those are two categorically different events:
 *
 * - `→ id.atlassian.com/login` (or a same-origin `/login.action`): the session
 *   expired. There are no attachment bytes at a login page; following it would
 *   write an HTML login form into the export as image data. Still an error.
 * - `→ api.media.atlassian.com/file/…`: the **legitimate, by-design** way
 *   Atlassian Cloud delivers attachment bytes. Jira's
 *   `/rest/api/3/attachment/content/{id}` and Confluence's
 *   `/download/attachments/…` both 3xx there. This must be FOLLOWED.
 *
 * Conflating them made session-mode attachment downloads unreachable by
 * construction in both clients. This module makes the decision by destination
 * so the normal case works.
 *
 * ## What is and is not shared with `@atlcli/export-wiring`
 *
 * `@atlcli/export-wiring`'s `asset-policy.ts` is the hardened boundary for
 * `export_view`-sourced third-party image URLs, and its fetcher is *deliberately*
 * `credentials: "omit"` on every hop including the first. That is the opposite
 * of what an authenticated attachment download needs (hop 0 must carry the
 * ambient session), and — decisively — that package depends on
 * `@atlcli/confluence`, so neither REST client may import it without a cycle.
 *
 * `@atlcli/core` is the only module both clients already depend on, and
 * `./internal` is explicitly non-frozen, so this is the one home that shares the
 * decision between Confluence and Jira instead of forking it. The origin
 * allowlist is nevertheless taken as an INJECTED predicate
 * ({@link SessionRedirectPolicy}) so a host can widen it and so wiring this to a
 * future shared policy object is a one-line change at the call site.
 *
 * The SSRF machinery in `asset-policy.ts` (private ranges, IPv4-mapped IPv6,
 * NAT64, private suffixes) is not duplicated here on purpose: that guard exists
 * because *that* policy is open-ended (site origin plus whatever a host vouches
 * for, applied to attacker-authored macro URLs). This policy is a CLOSED
 * allowlist — the site's own origin plus Atlassian media hosts — so a private or
 * link-local target is already rejected for not being on it. The one case where
 * a private host is reachable is a self-hosted Confluence/Jira on an intranet,
 * which is the site origin itself and therefore the user's own server.
 *
 * ## Isomorphic
 *
 * `URL`, `Headers`, `fetch` and nothing else — both clients are browser build
 * entrypoints (`scripts/check-browser-build.ts`) and both reach this module.
 */

/** Redirect hops followed before a chain is treated as a loop. */
export const SESSION_REDIRECT_MAX_HOPS = 5;

/**
 * Hosts that only ever mean "authenticate here". A bounce to one of them is a
 * session-expiry signal, never a source of attachment bytes.
 */
export const ATLASSIAN_LOGIN_HOSTS: readonly string[] = Object.freeze([
  "id.atlassian.com",
  "auth.atlassian.com",
  "login.atlassian.com",
  "identity.atlassian.com",
]);

/**
 * The Atlassian media CDN's registrable host. Cloud 302s attachment content
 * here (`api.media.atlassian.com`), which is why the extension manifest already
 * grants `https://api.media.atlassian.com/*` (`apps/extension/wxt.config.ts`).
 * Matched as an exact host or as a subdomain suffix so regional/`api.` variants
 * are covered without an open `*.atlassian.com` rule.
 */
export const ATLASSIAN_MEDIA_HOST = "media.atlassian.com";

/**
 * Last-path-segment spellings of a Server/Data Center login endpoint. Anonymous
 * or expired access to a protected resource redirects to `/login.action` (or
 * `/wiki/login.action` behind a context path) on the SAME origin — which the
 * origin allowlist would happily approve, so the path has to be classified too.
 */
const LOGIN_SEGMENTS = /^(?:login(?:\.action|\.jsp)?|dologin\.action|authenticate\.action)$/i;

/**
 * Unambiguous SSO servlet prefixes. Unlike the segment rule these may sit at any
 * depth, so they are matched as a substring of the pathname.
 */
const LOGIN_PATH_FRAGMENTS: readonly string[] = Object.freeze([
  "/plugins/servlet/samlsso",
  "/plugins/servlet/oidc",
  "/plugins/servlet/authentication",
]);

/**
 * True when a redirect target is an authentication destination.
 *
 * Host rules first (unambiguous), then a deliberately narrow path rule: the
 * login segment must be the LAST path segment and the path at most two segments
 * deep (`/login.action`, `/wiki/login.action`). Without the depth limit an
 * attachment literally named `login` — `/download/attachments/1/login` — would
 * be misread as a session expiry.
 */
export function isAtlassianLoginTarget(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  if (ATLASSIAN_LOGIN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
    return true;
  }
  const path = target.pathname.toLowerCase();
  if (LOGIN_PATH_FRAGMENTS.some((fragment) => path.includes(fragment))) return true;
  const segments = target.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.length > 2) return false;
  return LOGIN_SEGMENTS.test(segments[segments.length - 1]!);
}

/** True for the Atlassian media CDN that Cloud delivers attachment bytes from. */
export function isAtlassianMediaTarget(target: URL): boolean {
  // https only: the CDN is https-only and an http downgrade of a signed media
  // URL would put its token on the wire in the clear.
  if (target.protocol !== "https:") return false;
  const host = target.hostname.toLowerCase();
  return host === ATLASSIAN_MEDIA_HOST || host.endsWith(`.${ATLASSIAN_MEDIA_HOST}`);
}

/**
 * The allow/reject decision for one redirect target, injected into
 * {@link fetchSessionBinaryFollowingRedirects} so the transport does not own the
 * policy. {@link createAtlassianSessionRedirectPolicy} is the default both REST
 * clients use.
 */
export interface SessionRedirectPolicy {
  /** True when the target is an authentication destination (session expired). */
  isLoginTarget(target: URL): boolean;
  /** True when the target may legitimately serve the requested bytes. */
  isAllowedTarget(target: URL): boolean;
}

export interface AtlassianSessionRedirectPolicyOptions {
  /**
   * The site's own base URL (e.g. `https://acme.atlassian.net/wiki`). Only its
   * origin is used. An unparseable value yields a policy that allows nothing but
   * {@link allowedOrigins} and the Atlassian media hosts.
   */
  siteOrigin: string;
  /**
   * Extra origins the host vouches for — a Server/DC deployment fronted by its
   * own CDN, or a test's stand-in media origin. Defaults to NONE: widening is an
   * explicit act by the caller.
   */
  allowedOrigins?: readonly string[];
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * The default destination policy: the site's own origin, the Atlassian media
 * CDN, and anything the caller explicitly vouches for — nothing else.
 */
export function createAtlassianSessionRedirectPolicy(
  options: AtlassianSessionRedirectPolicyOptions
): SessionRedirectPolicy {
  const siteOrigin = normalizeOrigin(options.siteOrigin);
  const extra = new Set(
    (options.allowedOrigins ?? []).map(normalizeOrigin).filter((origin) => origin !== "")
  );
  return {
    isLoginTarget: isAtlassianLoginTarget,
    isAllowedTarget(target: URL): boolean {
      if (target.protocol !== "https:" && target.protocol !== "http:") return false;
      // `https://user:pass@host/` — never forward embedded credentials.
      if (target.username !== "" || target.password !== "") return false;
      if (siteOrigin !== "" && target.origin === siteOrigin) return true;
      if (extra.has(target.origin)) return true;
      return isAtlassianMediaTarget(target);
    },
  };
}

/**
 * Strip query/fragment before a redirect target lands in an error message or a
 * log line: Atlassian media URLs carry short-lived signed tokens, and client
 * errors are surfaced in export reports and JSONL logs.
 */
export function redactRedirectTarget(target: string): string {
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    return target;
  }
}

/**
 * A redirect that was refused because its destination is not on the allowlist —
 * as distinct from a session expiry, which stays each package's own typed auth
 * error.
 *
 * The message deliberately avoids the phrases the extension scans for to detect
 * session expiry (`authentication redirect`, `login page`, `non-json`,
 * `opaqueredirect` — `apps/extension/utils/read-path.ts`): a blocked third-party
 * hop is not a reason to latch the session as expired.
 */
export class SessionRedirectBlockedError extends Error {
  readonly target: string;
  readonly reason: string;

  constructor(label: string, target: string, reason: string) {
    super(`${label} blocked: ${reason} (${redactRedirectTarget(target)})`);
    this.name = "SessionRedirectBlockedError";
    this.target = target;
    this.reason = reason;
  }
}

/** Type guard that survives duplicate module instances in one bundle. */
export function isSessionRedirectBlockedError(err: unknown): err is SessionRedirectBlockedError {
  return err instanceof Error && err.name === "SessionRedirectBlockedError";
}

/**
 * The slice of `fetch` this module uses. Narrower than `typeof fetch` (which
 * carries runtime-specific statics such as Bun's `preconnect`) so an injected
 * stand-in does not have to reproduce them.
 */
export type SessionBinaryFetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface SessionBinaryFetchOptions {
  /** Defaults to the ambient `fetch`, looked up per call so tests can swap it. */
  fetchFn?: SessionBinaryFetchLike;
  /** Defaults to {@link SESSION_REDIRECT_MAX_HOPS}. */
  maxRedirects?: number;
  /**
   * Build the package's own typed auth error for a bounce to a login
   * destination. A factory rather than a shared class so Confluence's and Jira's
   * message text — which the extension string-matches to detect session expiry —
   * stays owned by each package and byte-identical to what it emits today.
   */
  loginRedirectError(status: number): Error;
  /** Build the error for a target that is neither login nor allowlisted. */
  blockedRedirectError(target: string, reason: string): Error;
}

/**
 * Remove every credential an intermediate hop must not inherit.
 *
 * `credentials: "omit"` is the control that matters in a browser: it is what
 * stops the ambient Atlassian session cookie from being attached. The header
 * deletes cover a runtime (Bun/Node) where `credentials` is inert but an
 * `Authorization` header is not.
 */
function withoutAmbientCredentials(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.delete("Authorization");
  headers.delete("Cookie");
  return { ...init, headers, credentials: "omit" };
}

/** Release a redirect response's body so the connection is not left dangling. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already finished; nothing to do.
  }
}

/**
 * Perform a session-mode binary request, following redirects to allowlisted
 * destinations and refusing everything else.
 *
 * `init` is the caller's finalized `RequestInit` — for a session profile that
 * means `credentials: "include"` and `redirect: "manual"`, exactly as today. Hop
 * 0 is issued unchanged (same origin, same credentials, byte-identical to the
 * pre-fix request); only a CROSS-ORIGIN hop is rewritten, and only ever to
 * remove credentials.
 *
 * ### The two runtimes
 *
 * With `redirect: "manual"` a server-side runtime (Bun/Node) hands back the raw
 * 3xx with a readable `Location`, so every hop is classified BEFORE it is
 * requested. A browser instead returns an opaque-redirect response whose
 * `Location` is unreadable by design — there the target cannot be pre-checked at
 * all, so the request is re-issued with `redirect: "follow"` and the FINAL
 * `response.url` is classified after the fact. That is not a weaker credential
 * story: a browser attaches cookies per destination origin, so the site's
 * session cookie is never sent to the media CDN regardless. It is a weaker
 * *SSRF* story (the request has already been made when it is judged), which is
 * acceptable because the redirect was issued by the user's own Atlassian site
 * and the bytes are discarded unless the destination passes the policy.
 */
export async function fetchSessionBinaryFollowingRedirects(
  url: string,
  init: RequestInit,
  policy: SessionRedirectPolicy,
  options: SessionBinaryFetchOptions
): Promise<Response> {
  // `fetch` is resolved at CALL time, not module-evaluation time, so a test that
  // swaps `globalThis.fetch` is still honoured.
  const doFetch: SessionBinaryFetchLike =
    options.fetchFn ?? ((input, requestInit) => fetch(input, requestInit));
  const maxRedirects = options.maxRedirects ?? SESSION_REDIRECT_MAX_HOPS;
  const firstHopOrigin = normalizeOrigin(url);

  let current = url;
  let currentInit = init;

  for (let hop = 0; ; hop++) {
    const res = await doFetch(current, currentInit);

    if (res.type === "opaqueredirect") {
      return await followOpaqueRedirect(current, currentInit, policy, options, doFetch);
    }
    if (res.status < 300 || res.status >= 400) return res;

    // A 3xx past the budget is a loop (or a deliberate stall); stop before the
    // next request rather than after it.
    if (hop >= maxRedirects) {
      await discardBody(res);
      throw options.blockedRedirectError(current, `more than ${maxRedirects} redirects`);
    }

    const location = res.headers.get("location");
    await discardBody(res);
    if (!location) {
      throw options.blockedRedirectError(current, "redirect without a Location header");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw options.blockedRedirectError(current, "redirect to an unparseable Location");
    }

    // Destination decides, in this order: a login bounce is a session expiry
    // even when it is same-origin (and therefore "allowed"), so it is checked
    // first.
    if (policy.isLoginTarget(next)) throw options.loginRedirectError(res.status);
    if (!policy.isAllowedTarget(next)) {
      throw options.blockedRedirectError(next.toString(), "redirect to a non-allowlisted origin");
    }

    if (next.origin !== firstHopOrigin) currentInit = withoutAmbientCredentials(currentInit);
    current = next.toString();
  }
}

/**
 * Browser path: `redirect: "manual"` produced a response whose target cannot be
 * read, so re-issue the request letting the browser follow, then judge the final
 * URL. See {@link fetchSessionBinaryFollowingRedirects} for why this is sound.
 */
async function followOpaqueRedirect(
  current: string,
  currentInit: RequestInit,
  policy: SessionRedirectPolicy,
  options: SessionBinaryFetchOptions,
  doFetch: SessionBinaryFetchLike
): Promise<Response> {
  const res = await doFetch(current, { ...currentInit, redirect: "follow" });

  // Still unreadable (or a `no-cors` opaque response): the destination cannot be
  // verified, so the bytes cannot be trusted to be the attachment.
  if (res.type === "opaqueredirect" || res.type === "opaque" || res.url === "") {
    await discardBody(res);
    throw options.blockedRedirectError(current, "redirect to an unverifiable destination");
  }

  let final: URL;
  try {
    final = new URL(res.url);
  } catch {
    await discardBody(res);
    throw options.blockedRedirectError(current, "redirect to an unverifiable destination");
  }
  if (final.href === current) return res;

  if (policy.isLoginTarget(final)) {
    await discardBody(res);
    // The real 3xx status is unreadable through an opaque redirect; 302 is the
    // canonical stand-in both clients already use for that case.
    throw options.loginRedirectError(302);
  }
  if (!policy.isAllowedTarget(final)) {
    await discardBody(res);
    throw options.blockedRedirectError(final.toString(), "redirect to a non-allowlisted origin");
  }
  return res;
}
