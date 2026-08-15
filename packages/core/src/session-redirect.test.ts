import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_REDIRECT_MAX_HOPS,
  SessionRedirectBlockedError,
  createAtlassianSessionRedirectPolicy,
  fetchSessionBinaryFollowingRedirects,
  isAtlassianLoginTarget,
  isAtlassianMediaTarget,
  isSessionRedirectBlockedError,
  redactRedirectTarget,
  type SessionBinaryFetchOptions,
} from "./session-redirect.js";

const SITE = "https://acme.atlassian.net/wiki";
const policy = createAtlassianSessionRedirectPolicy({ siteOrigin: SITE });
const allow = (url: string): boolean => policy.isAllowedTarget(new URL(url));
const login = (url: string): boolean => policy.isLoginTarget(new URL(url));

/**
 * Destination classification (spec 010 wave 2).
 *
 * The defect these encode: the clients keyed the session-mode redirect guard on
 * *"is there a redirect"* rather than on *"where does it go"*, so the by-design
 * `attachment/content → api.media.atlassian.com` hop that DELIVERS attachment
 * bytes was refused exactly like an expired-session bounce to the login host.
 */
describe("session redirect destination policy", () => {
  test("the site's own origin is allowed (a same-origin hop is not a foreign one)", () => {
    expect(allow("https://acme.atlassian.net/wiki/download/attachments/1/a.png")).toBe(true);
    expect(allow("https://acme.atlassian.net/secure/attachment/1/a.png")).toBe(true);
  });

  test("the Atlassian media CDN is allowed — this is how Cloud delivers bytes", () => {
    expect(allow("https://api.media.atlassian.com/file/abc/binary?token=x")).toBe(true);
    expect(allow("https://media.atlassian.com/file/abc/binary")).toBe(true);
    expect(allow("https://eu-1.media.atlassian.com/file/abc/binary")).toBe(true);
  });

  test("a third-party origin is refused", () => {
    expect(allow("https://evil.example.com/steal")).toBe(false);
    // A near-miss host that merely CONTAINS the media host must not pass.
    expect(allow("https://media.atlassian.com.evil.example/x")).toBe(false);
    expect(allow("https://notmedia.atlassian.com/x")).toBe(false);
    // A different tenant is a different origin.
    expect(allow("https://other.atlassian.net/wiki/download/1")).toBe(false);
  });

  test("the media CDN is https-only (no downgrade of a signed media URL)", () => {
    expect(isAtlassianMediaTarget(new URL("https://api.media.atlassian.com/f"))).toBe(true);
    expect(isAtlassianMediaTarget(new URL("http://api.media.atlassian.com/f"))).toBe(false);
    expect(allow("http://api.media.atlassian.com/f")).toBe(false);
  });

  test("non-http(s) schemes and embedded credentials are refused", () => {
    expect(allow("data:image/png;base64,AAAA")).toBe(false);
    expect(allow("file:///etc/passwd")).toBe(false);
    expect(allow("https://user:pass@api.media.atlassian.com/f")).toBe(false);
  });

  test("private/link-local hosts are refused because the allowlist is closed", () => {
    // No separate SSRF guard is needed here (unlike the open-ended
    // export_view asset policy): these are simply not on the list.
    expect(allow("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(allow("http://127.0.0.1:8080/x")).toBe(false);
    expect(allow("http://[::1]/x")).toBe(false);
  });

  test("a host may vouch for extra origins, and only those", () => {
    const widened = createAtlassianSessionRedirectPolicy({
      siteOrigin: SITE,
      allowedOrigins: ["https://cdn.corp.example"],
    });
    expect(widened.isAllowedTarget(new URL("https://cdn.corp.example/a.png"))).toBe(true);
    expect(widened.isAllowedTarget(new URL("https://other.corp.example/a.png"))).toBe(false);
  });

  test("an unparseable site origin does not implicitly allow everything", () => {
    const broken = createAtlassianSessionRedirectPolicy({ siteOrigin: "not a url" });
    expect(broken.isAllowedTarget(new URL("https://acme.atlassian.net/x"))).toBe(false);
    expect(broken.isAllowedTarget(new URL("https://api.media.atlassian.com/f"))).toBe(true);
  });
});

describe("login-destination classification", () => {
  test("the Atlassian identity hosts are login targets", () => {
    expect(login("https://id.atlassian.com/login?continue=x")).toBe(true);
    expect(login("https://auth.atlassian.com/authorize")).toBe(true);
    expect(login("https://eu.id.atlassian.com/login")).toBe(true);
  });

  test("a SAME-ORIGIN Server/DC login endpoint is a login target too", () => {
    // The origin allowlist would happily approve this hop, so the path has to
    // be classified: following it writes an HTML login form into the export.
    expect(login("https://wiki.corp.example/login.action?os_destination=%2Fx")).toBe(true);
    expect(login("https://wiki.corp.example/wiki/login.action")).toBe(true);
    expect(login("https://acme.atlassian.net/login?dest-url=%2Fwiki")).toBe(true);
    expect(login("https://wiki.corp.example/plugins/servlet/samlsso?redirectTo=%2Fx")).toBe(true);
  });

  test("an attachment that merely looks like a login path is NOT a login target", () => {
    expect(login("https://acme.atlassian.net/wiki/download/attachments/1/login")).toBe(false);
    expect(login("https://acme.atlassian.net/wiki/download/attachments/1/login.png")).toBe(false);
    expect(isAtlassianLoginTarget(new URL("https://api.media.atlassian.com/file/x/binary"))).toBe(
      false
    );
  });
});

describe("redactRedirectTarget", () => {
  test("drops the query so a signed media token never lands in a log line", () => {
    expect(redactRedirectTarget("https://api.media.atlassian.com/file/x/binary?token=SECRET")).toBe(
      "https://api.media.atlassian.com/file/x/binary"
    );
  });
});

/**
 * The redirect follower, driven against REAL HTTP servers so every redirect is a
 * real redirect and every credential assertion is made about a request that was
 * actually put on the wire.
 */
describe("fetchSessionBinaryFollowingRedirects (real servers)", () => {
  let site: ReturnType<typeof Bun.serve>;
  let media: ReturnType<typeof Bun.serve>;
  let third: ReturnType<typeof Bun.serve>;
  let siteBase = "";
  let mediaBase = "";
  let thirdBase = "";

  const hits: string[] = [];
  /** Headers the MEDIA origin actually received, per request. */
  const mediaHeaders: Headers[] = [];

  const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

  beforeAll(() => {
    media = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(`media${pathname}`);
        mediaHeaders.push(req.headers);
        return new Response(BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      },
    });
    mediaBase = `http://127.0.0.1:${media.port}`;

    third = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`third${new URL(req.url).pathname}`);
        return new Response("owned", { status: 200 });
      },
    });
    thirdBase = `http://127.0.0.1:${third.port}`;

    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(`site${pathname}`);
        const redirect = (to: string) =>
          new Response(null, { status: 302, headers: { Location: to } });
        switch (pathname) {
          case "/attachment/media":
            return redirect(`${mediaBase}/file/abc/binary?token=SECRET`);
          case "/attachment/login":
            return redirect(`${siteBase}/login.action?os_destination=%2Fx`);
          case "/attachment/third-party":
            return redirect(`${thirdBase}/steal`);
          case "/attachment/no-location":
            return new Response(null, { status: 302 });
          case "/attachment/same-origin":
            return redirect(`${siteBase}/attachment/moved`);
          case "/attachment/moved":
            return new Response(BYTES, { status: 200 });
          case "/login.action":
            return new Response("<html>login</html>", { status: 200 });
          default:
            if (pathname.startsWith("/loop/")) {
              const n = Number(pathname.slice("/loop/".length)) || 0;
              return redirect(`${siteBase}/loop/${n + 1}`);
            }
            return new Response(BYTES, { status: 200 });
        }
      },
    });
    siteBase = `http://127.0.0.1:${site.port}`;
  });

  afterAll(() => {
    site.stop(true);
    media.stop(true);
    third.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
    mediaHeaders.length = 0;
  });

  /** The RequestInit the client hands each hop, in order. */
  let inits: Array<{ url: string; init: RequestInit | undefined }> = [];

  function run(path: string, extraHeaders: Record<string, string> = {}) {
    inits = [];
    const testPolicy = createAtlassianSessionRedirectPolicy({
      siteOrigin: siteBase,
      // Stands in for `api.media.atlassian.com`: a REAL second origin, so the
      // cross-origin credential rule is exercised rather than simulated.
      allowedOrigins: [mediaBase],
    });
    const options: SessionBinaryFetchOptions = {
      fetchFn: (input, init) => {
        inits.push({ url: input, init });
        return fetch(input, init);
      },
      loginRedirectError: (status) =>
        new Error(`Confluence API error (${status}): authentication redirect to Atlassian login`),
      blockedRedirectError: (target, reason) =>
        new SessionRedirectBlockedError("attachment download", target, reason),
    };
    return fetchSessionBinaryFollowingRedirects(
      `${siteBase}${path}`,
      {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        headers: { Cookie: "cloud.session.token=SECRET", ...extraHeaders },
      },
      testPolicy,
      options
    );
  }

  test("a redirect to an allowlisted media origin returns the bytes", async () => {
    const res = await run("/attachment/media");

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(hits).toEqual(["site/attachment/media", "media/file/abc/binary"]);
  });

  test("the cross-origin hop carries NO session credential", async () => {
    await run("/attachment/media");

    // Observed on the wire at the media origin.
    expect(mediaHeaders).toHaveLength(1);
    expect(mediaHeaders[0]!.get("cookie")).toBeNull();
    expect(mediaHeaders[0]!.get("authorization")).toBeNull();

    // And in the RequestInit: `credentials: "omit"` is the control that stops a
    // BROWSER attaching the ambient Atlassian cookie.
    expect(inits).toHaveLength(2);
    expect(inits[0]!.init?.credentials).toBe("include");
    expect(inits[1]!.init?.credentials).toBe("omit");
  });

  test("a SAME-origin hop keeps the session credential (nothing foreign to protect from)", async () => {
    const res = await run("/attachment/same-origin");

    expect(res.status).toBe(200);
    expect(hits).toEqual(["site/attachment/same-origin", "site/attachment/moved"]);
    expect(inits[1]!.init?.credentials).toBe("include");
  });

  test("a redirect to a login destination raises the auth error and is NOT followed", async () => {
    await expect(run("/attachment/login")).rejects.toThrow(/authentication redirect/i);
    // The decisive assertion: the login page was never requested, so no HTML
    // could be mistaken for attachment bytes.
    expect(hits).toEqual(["site/attachment/login"]);
  });

  test("a redirect to a non-allowlisted third party is refused before the request", async () => {
    const err = await run("/attachment/third-party").catch((e: unknown) => e);

    expect(isSessionRedirectBlockedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/non-allowlisted origin/);
    expect(hits).toEqual(["site/attachment/third-party"]);
  });

  test("a blocked-destination message does not read as a session expiry", async () => {
    const err = (await run("/attachment/third-party").catch((e: unknown) => e)) as Error;
    // `apps/extension/utils/read-path.ts` latches the session as expired on
    // these phrases; a refused third-party hop must not trip it.
    expect(err.message).not.toMatch(/non-json|login page|authentication redirect|opaqueredirect/i);
  });

  test("the hop count is bounded", async () => {
    const err = await run("/loop/0").catch((e: unknown) => e);

    expect(isSessionRedirectBlockedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/more than 5 redirects/);
    expect(hits).toHaveLength(SESSION_REDIRECT_MAX_HOPS + 1);
  });

  test("a 3xx without a Location header is refused, not read as an empty body", async () => {
    const err = await run("/attachment/no-location").catch((e: unknown) => e);

    expect(isSessionRedirectBlockedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/without a Location header/);
  });

  test("a non-redirect response is returned untouched, with hop 0's init unchanged", async () => {
    const res = await run("/attachment/plain");

    expect(res.status).toBe(200);
    expect(inits).toHaveLength(1);
    expect(inits[0]!.init?.credentials).toBe("include");
    expect(inits[0]!.init?.redirect).toBe("manual");
  });

  test("a signed media token is redacted out of the blocked-redirect message", async () => {
    const blocked = new SessionRedirectBlockedError(
      "attachment download",
      "https://evil.example/steal?token=SECRET",
      "redirect to a non-allowlisted origin"
    );
    expect(blocked.message).not.toContain("SECRET");
  });
});

/**
 * The BROWSER shape: `redirect: "manual"` yields an opaque-redirect response
 * whose `Location` is unreadable by design, so the destination cannot be
 * pre-checked. The follower re-issues with `redirect: "follow"` and judges the
 * FINAL `response.url`. No server can emit an opaque redirect, so these
 * responses are hand-constructed real `Response` objects.
 */
describe("fetchSessionBinaryFollowingRedirects (browser opaque redirect)", () => {
  const browserPolicy = createAtlassianSessionRedirectPolicy({ siteOrigin: SITE });

  function handlers(): SessionBinaryFetchOptions {
    return {
      loginRedirectError: (status) =>
        new Error(`Confluence API error (${status}): authentication redirect to Atlassian login`),
      blockedRedirectError: (target, reason) =>
        new SessionRedirectBlockedError("attachment download", target, reason),
    };
  }

  function opaqueThen(second: () => Response): {
    options: SessionBinaryFetchOptions;
    calls: Array<RequestInit | undefined>;
  } {
    const calls: Array<RequestInit | undefined> = [];
    let call = 0;
    return {
      calls,
      options: {
        ...handlers(),
        fetchFn: (_input, init) => {
          calls.push(init);
          if (call++ === 0) {
            const res = new Response(null, { status: 200 });
            Object.defineProperty(res, "type", { value: "opaqueredirect" });
            return Promise.resolve(res);
          }
          return Promise.resolve(second());
        },
      },
    };
  }

  /** A followed response: `url` is the FINAL URL, `redirected` is true. */
  function followed(finalUrl: string, body: BodyInit | null, status = 200): Response {
    const res = new Response(body, { status });
    Object.defineProperty(res, "url", { value: finalUrl });
    Object.defineProperty(res, "redirected", { value: true });
    return res;
  }

  const start = `${SITE}/download/attachments/1/a.png`;

  test("an opaque redirect that lands on the media CDN returns the bytes", async () => {
    const { options, calls } = opaqueThen(() =>
      followed("https://api.media.atlassian.com/file/abc/binary", new Uint8Array([9, 9]))
    );

    const res = await fetchSessionBinaryFollowingRedirects(
      start,
      { credentials: "include", redirect: "manual" },
      browserPolicy,
      options
    );

    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    // The retry is what makes the destination knowable at all.
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[1]?.redirect).toBe("follow");
  });

  test("an opaque redirect that lands on the login host still raises the auth error", async () => {
    const { options } = opaqueThen(() =>
      followed("https://id.atlassian.com/login?continue=x", "<html>login</html>")
    );

    await expect(
      fetchSessionBinaryFollowingRedirects(
        start,
        { credentials: "include", redirect: "manual" },
        browserPolicy,
        options
      )
    ).rejects.toThrow(/authentication redirect to Atlassian login/);
  });

  test("an opaque redirect that lands on a third party is refused", async () => {
    const { options } = opaqueThen(() => followed("https://evil.example/steal", "owned"));

    const err = await fetchSessionBinaryFollowingRedirects(
      start,
      { credentials: "include", redirect: "manual" },
      browserPolicy,
      options
    ).catch((e: unknown) => e);

    expect(isSessionRedirectBlockedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/non-allowlisted origin/);
  });

  test("a destination that stays unreadable is refused rather than trusted", async () => {
    const { options } = opaqueThen(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaque" });
      Object.defineProperty(res, "url", { value: "" });
      return res;
    });

    const err = await fetchSessionBinaryFollowingRedirects(
      start,
      { credentials: "include", redirect: "manual" },
      browserPolicy,
      options
    ).catch((e: unknown) => e);

    expect(isSessionRedirectBlockedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/unverifiable destination/);
  });
});
