import { describe, test, expect, mock, afterEach, afterAll, beforeAll, beforeEach } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";
import { isJiraSessionAuthError, type JiraSessionAuthError } from "./auth-redirect.js";

const mockProfile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: {
    type: "apiToken",
    email: "test@example.com",
    token: "test-token",
  },
};

const originalFetch = globalThis.fetch;

describe("JiraClient TLS options", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("omits the tls field on fetch when the profile has no TLS config", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedInit = options;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient(mockProfile);
    await client.getIssue("TEST-1");

    expect(capturedInit).toBeDefined();
    expect("tls" in (capturedInit as Record<string, unknown>)).toBe(false);
  });

  test("passes tls options on fetch when the profile skips verification", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedInit = options;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient({ ...mockProfile, tlsSkipVerify: true });
    await client.getIssue("TEST-1");

    const tls = (capturedInit as unknown as { tls?: { rejectUnauthorized?: boolean } }).tls;
    expect(tls).toBeDefined();
    expect(tls?.rejectUnauthorized).toBe(false);
  });
});

describe("JiraClient session auth mode (spec 001 task 5)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sessionProfile: Profile = {
    name: "session",
    baseUrl: "https://test.atlassian.net",
    auth: { type: "session" },
  };

  function captureFetch(response: () => Response): { last: () => RequestInit | undefined } {
    let last: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      last = init;
      return Promise.resolve(response());
    }) as unknown as typeof fetch;
    return { last: () => last };
  }

  const issueResponse = () =>
    new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 });

  test("issue read (getIssue): no Authorization header, credentials include", async () => {
    const cap = captureFetch(issueResponse);
    await new JiraClient(sessionProfile).getIssue("TEST-1");
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("search: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() =>
      new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 })
    );
    await new JiraClient(sessionProfile).search("project = TEST");
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("attachment upload: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() =>
      new Response(JSON.stringify([{ id: "10", filename: "f.png" }]), { status: 200 })
    );
    await new JiraClient(sessionProfile).uploadAttachment(
      "TEST-1",
      "f.png",
      Buffer.from([1, 2, 3])
    );
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("attachment download: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await new JiraClient(sessionProfile).downloadAttachment(
      "https://test.atlassian.net/rest/api/3/attachment/content/10"
    );
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("regression: non-session profile keeps Authorization and leaves credentials unset", async () => {
    const cap = captureFetch(issueResponse);
    await new JiraClient(mockProfile).getIssue("TEST-1");
    const init = cap.last();
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /);
    expect(init?.credentials).toBeUndefined();
  });
});

/**
 * Session auth-redirect / login-page classification (spec 010 wave 2, finding
 * B1) — driven against a REAL HTTP server so the redirect is a real redirect
 * and `redirect: "manual"` is proved by behaviour (the login endpoint is never
 * reached) rather than only by inspecting the RequestInit.
 *
 * Before this fix `JiraClient` set `credentials: "include"` without
 * `redirect: "manual"`, so `302 → login → 200 text/html` was FOLLOWED and the
 * login page came back as if it were issue JSON. The consumer then threw while
 * reading `issue.fields`, was classified `network`, and the extension's
 * session-expiry latch never tripped — every later macro fired another doomed
 * authenticated request.
 */
describe("JiraClient session auth redirects (spec 010 wave 2, finding B1)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const hits: string[] = [];
  /** Settles the deliberately-hanging `/issue/SLOW-1` handler after a test. */
  let releaseSlow: (() => void) | undefined;

  const ISSUE_JSON = JSON.stringify({ id: "1", key: "TEST-1", fields: { summary: "real" } });
  const LOGIN_HTML =
    "<!doctype html><html><head><title>Log in</title></head><body><form id=login></form></body></html>";
  const json = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  const html = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(pathname);
        switch (pathname) {
          // An expired Atlassian session: bounce to the login host.
          case "/rest/api/2/issue/EXPIRED-1":
            return new Response(null, { status: 302, headers: { Location: `${base}/login` } });
          case "/login":
            return html(LOGIN_HTML);
          // Some deployments answer 200 with the login page directly.
          case "/rest/api/2/issue/HTML-1":
            return html(LOGIN_HTML);
          // A benign redirect chain, used to prove token auth still follows.
          case "/rest/api/2/issue/TOKEN-1":
            return new Response(null, {
              status: 302,
              headers: { Location: `${base}/rest/api/2/issue/TOKEN-1/moved` },
            });
          case "/rest/api/2/issue/TOKEN-1/moved":
            return json(ISSUE_JSON);
          case "/rest/api/2/issue/SLOW-1":
            return new Promise<Response>((resolve) => {
              releaseSlow = () => resolve(json(ISSUE_JSON));
            });
          default:
            return json(ISSUE_JSON);
        }
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    releaseSlow?.();
    server.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
  });

  const sessionProfile = (): Profile => ({
    name: "session",
    baseUrl: base,
    auth: { type: "session" },
  });
  const tokenProfile = (): Profile => ({
    name: "token",
    baseUrl: base,
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  });

  async function capture(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (err) {
      return err;
    }
    throw new Error("expected the call to reject");
  }

  test("a 302 to a login page becomes a typed auth-redirect error, NOT a network error", async () => {
    const err = await capture(() => new JiraClient(sessionProfile()).getIssue("EXPIRED-1"));

    expect(isJiraSessionAuthError(err)).toBe(true);
    const typed = err as JiraSessionAuthError;
    expect(typed.reason).toBe("auth-redirect");
    expect(typed.status).toBe(302);
    expect(typed.message).toContain("authentication redirect to Atlassian login");
    // The exact regression: the old code produced a TypeError deep inside the
    // consumer, which the extension classified as `network` and never latched.
    expect(err).not.toBeInstanceOf(TypeError);
  });

  test("the redirect is NOT followed: the login endpoint is never requested", async () => {
    await capture(() => new JiraClient(sessionProfile()).getIssue("EXPIRED-1"));

    expect(hits).toEqual(["/rest/api/2/issue/EXPIRED-1"]);
    expect(hits).not.toContain("/login");
  });

  test("session requests set redirect: \"manual\" on the RequestInit", async () => {
    let init: RequestInit | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, options: RequestInit) => {
      init = options;
      return realFetch(url, options);
    }) as unknown as typeof fetch;
    try {
      await capture(() => new JiraClient(sessionProfile()).getIssue("EXPIRED-1"));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("include");
  });

  test("a 200 text/html login page on a JSON endpoint is rejected, not returned as data", async () => {
    const err = await capture(() => new JiraClient(sessionProfile()).getIssue("HTML-1"));

    expect(isJiraSessionAuthError(err)).toBe(true);
    const typed = err as JiraSessionAuthError;
    expect(typed.reason).toBe("login-page");
    expect(typed.message).toContain("non-JSON 200 response (login page");
    // The old behaviour: the HTML string came back typed as JiraIssue, and the
    // consumer blew up on `issue.fields`.
    expect(typed.message).not.toContain("<html");
  });

  test("regression: token auth is unaffected — the same server's 302 is still followed", async () => {
    const issue = await new JiraClient(tokenProfile()).getIssue("TOKEN-1");

    expect(issue.key).toBe("TEST-1");
    // Proof it FOLLOWED: the redirect target was fetched too.
    expect(hits).toEqual([
      "/rest/api/2/issue/TOKEN-1",
      "/rest/api/2/issue/TOKEN-1/moved",
    ]);
  });

  test("regression: token auth leaves redirect unset on the RequestInit", async () => {
    let init: RequestInit | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, options: RequestInit) => {
      init = options;
      return realFetch(url, options);
    }) as unknown as typeof fetch;
    try {
      await new JiraClient(tokenProfile()).getIssue("OK-1");
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(init?.redirect).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  test("a browser opaque redirect is classified identically", async () => {
    // `type: "opaqueredirect"` is what a BROWSER returns for a manual-redirect
    // fetch; no server can emit it, so the response is hand-constructed (a real
    // `Response` with the prototype's `type` getter shadowed on the instance).
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      return Promise.resolve(res);
    }) as unknown as typeof fetch;

    let err: unknown;
    try {
      err = await capture(() => new JiraClient(sessionProfile()).getIssue("EXPIRED-1"));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(isJiraSessionAuthError(err)).toBe(true);
    const typed = err as JiraSessionAuthError;
    expect(typed.reason).toBe("auth-redirect");
    expect(typed.status).toBe(302);
  });
});

/**
 * Cancellation (spec 010 wave 2): `JiraClient.request()` took no `AbortSignal`,
 * so the extension's export cancel could only abort cooperatively BETWEEN
 * calls — an in-flight Jira request ran to completion.
 */
describe("JiraClient AbortSignal (spec 010 wave 2)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const hits: string[] = [];
  let releaseSlow: (() => void) | undefined;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(pathname);
        if (pathname.endsWith("/SLOW-1")) {
          return new Promise<Response>((resolve) => {
            releaseSlow = () =>
              resolve(
                new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              );
          });
        }
        // Drives the client into its 5xx exponential backoff (1 s on attempt 0).
        if (pathname.endsWith("/BOOM-1")) {
          return new Response("server error", { status: 500 });
        }
        return new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    releaseSlow?.();
    server.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
  });

  const profile = (): Profile => ({
    name: "token",
    baseUrl: base,
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  });

  test("aborts an in-flight request instead of waiting for the response", async () => {
    const controller = new AbortController();
    const pending = new JiraClient(profile()).getIssue("SLOW-1", { signal: controller.signal });
    // Let the request actually reach the (hanging) server before cancelling.
    await Bun.sleep(50);
    expect(hits).toEqual(["/rest/api/2/issue/SLOW-1"]);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The abort must not be mistaken for a transient failure and retried.
    expect(hits).toEqual(["/rest/api/2/issue/SLOW-1"]);
    releaseSlow?.();
  });

  test("an already-aborted signal short-circuits before any request is made", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new JiraClient(profile()).getIssue("TEST-1", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toEqual([]);
  });

  test("search() forwards the signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new JiraClient(profile()).search("project = TEST", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toEqual([]);
  });

  test("searchGet() forwards the signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new JiraClient(profile()).searchGet("project = TEST", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toEqual([]);
  });

  test("aborts DURING the 5xx retry backoff rather than after it elapses", async () => {
    // The backoff is 1 s on attempt 0. A non-abortable `sleep` would swallow the
    // cancel until that second was up, so the assertion is on the LATENCY, not
    // just on the rejection.
    const controller = new AbortController();
    const pending = new JiraClient(profile()).getIssue("BOOM-1", { signal: controller.signal });
    await Bun.sleep(50);
    expect(hits).toEqual(["/rest/api/2/issue/BOOM-1"]);

    const abortedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(Date.now() - abortedAt).toBeLessThan(500);
    // No further attempt was made.
    expect(hits).toEqual(["/rest/api/2/issue/BOOM-1"]);
  });

  test("downloadAttachment(): an aborted signal is not swallowed by the retry loop", async () => {
    // Its catch-and-retry block treats every throw as transient; without the
    // explicit abort check a cancel would fire `maxRetries` more requests.
    const controller = new AbortController();
    controller.abort();

    await expect(
      new JiraClient(profile()).downloadAttachment(`${base}/attachment/content/10`, {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toEqual([]);
  });
});

describe("JiraClient 429 retry delay is bounded (spec 010 wave-1 review, B6)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("does not retry immediately when Retry-After is unparseable", async () => {
    // Proves the clamp is WIRED INTO the request loop, not merely exported:
    // `parseInt("unavailable", 10) * 1000` is NaN, and `setTimeout(fn, NaN)`
    // fires on the next tick, so the client used to answer a 429 with an
    // instant second request.
    const timestamps: number[] = [];
    let callCount = 0;
    globalThis.fetch = mock(() => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "unavailable" },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient(mockProfile);
    await client.getIssue("TEST-1");

    expect(callCount).toBe(2);
    // Fell back to the 1 s exponential base rather than to NaN.
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(500);
  });
});

/**
 * Session-mode ATTACHMENT downloads: follow the redirect that delivers the bytes
 * (spec 010 wave 2).
 *
 * The design gap: `applyFetchOptions` set `redirect: "manual"` for every session
 * request, and the guard keyed on *"is there a redirect"*. Jira Cloud answers
 * `/rest/api/3/attachment/content/{id}` with a 302 to `api.media.atlassian.com`
 * BY DESIGN, so session-mode attachment downloads could not return bytes at all
 * — they failed as if the session had expired. Classification is by DESTINATION
 * now.
 *
 * Driven against two real `Bun.serve` origins so the redirect is a real redirect
 * and the credential assertions are made about requests that were actually put
 * on the wire. The only substitution is a DNS-style resolver that maps the real
 * `https://api.media.atlassian.com` prefix onto the local media server — the
 * HTTP is real, the hostname the POLICY sees is the production one.
 */
describe("JiraClient session attachment redirects (spec 010 wave 2)", () => {
  const MEDIA_PREFIX = "https://api.media.atlassian.com";

  let site: ReturnType<typeof Bun.serve>;
  let media: ReturnType<typeof Bun.serve>;
  let third: ReturnType<typeof Bun.serve>;
  let base = "";
  let mediaBase = "";
  let thirdBase = "";

  const hits: string[] = [];
  const mediaHeaders: Headers[] = [];
  let inits: Array<{ url: string; init: RequestInit | undefined }> = [];

  const BYTES = new Uint8Array([7, 8, 9]);

  beforeAll(() => {
    media = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`media${new URL(req.url).pathname}`);
        mediaHeaders.push(req.headers);
        return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
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
          // The production shape: Cloud hands the bytes off to the media CDN.
          case "/rest/api/3/attachment/content/10":
            return redirect(`${MEDIA_PREFIX}/file/abc/binary?token=SECRET`);
          case "/rest/api/3/attachment/content/11":
            return redirect(`${base}/login`);
          case "/rest/api/3/attachment/content/12":
            return redirect(`${thirdBase}/steal`);
          case "/rest/api/3/attachment/content/13":
            return redirect(`${base}/rest/api/3/attachment/content/moved`);
          case "/rest/api/3/attachment/content/moved":
            return new Response(BYTES, { status: 200 });
          // A JSON endpoint bouncing to the media CDN must STILL be refused:
          // the relaxation is for attachment bytes, not for API calls.
          case "/rest/api/2/issue/MEDIA-1":
            return redirect(`${MEDIA_PREFIX}/file/abc/binary`);
          case "/login":
            return new Response("<html>login</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          default:
            if (pathname.startsWith("/loop/")) {
              const n = Number(pathname.slice("/loop/".length)) || 0;
              return redirect(`${base}/loop/${n + 1}`);
            }
            return new Response(BYTES, { status: 200 });
        }
      },
    });
    base = `http://127.0.0.1:${site.port}`;
  });

  afterAll(() => {
    site.stop(true);
    media.stop(true);
    third.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
    mediaHeaders.length = 0;
    inits = [];
    // Resolver, not a mock: rewrites the media HOSTNAME to the local media
    // server and performs a real fetch. The policy still judges the production
    // `https://api.media.atlassian.com` URL.
    globalThis.fetch = ((input: string, init: RequestInit) => {
      const url = String(input);
      inits.push({ url, init });
      const target = url.startsWith(MEDIA_PREFIX)
        ? `${mediaBase}${url.slice(MEDIA_PREFIX.length)}`
        : url;
      return originalFetch(target, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sessionProfile = (): Profile => ({
    name: "session",
    baseUrl: base,
    auth: { type: "session" },
  });
  const tokenProfile = (): Profile => ({
    name: "token",
    baseUrl: base,
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  });

  test("follows the media-CDN redirect and returns the attachment bytes", async () => {
    const bytes = await new JiraClient(sessionProfile()).downloadAttachment(
      `${base}/rest/api/3/attachment/content/10`
    );

    expect(new Uint8Array(bytes)).toEqual(BYTES);
    expect(hits).toEqual(["site/rest/api/3/attachment/content/10", "media/file/abc/binary"]);
  });

  test("the media hop carries no session credential", async () => {
    await new JiraClient(sessionProfile()).downloadAttachment(
      `${base}/rest/api/3/attachment/content/10`
    );

    expect(mediaHeaders).toHaveLength(1);
    expect(mediaHeaders[0]!.get("cookie")).toBeNull();
    expect(mediaHeaders[0]!.get("authorization")).toBeNull();

    expect(inits).toHaveLength(2);
    expect(inits[0]!.init?.credentials).toBe("include");
    expect(inits[1]!.url.startsWith(MEDIA_PREFIX)).toBe(true);
    expect(inits[1]!.init?.credentials).toBe("omit");
  });

  test("a same-origin hop is followed and keeps the session credential", async () => {
    const bytes = await new JiraClient(sessionProfile()).downloadAttachment(
      `${base}/rest/api/3/attachment/content/13`
    );

    expect(new Uint8Array(bytes)).toEqual(BYTES);
    expect(inits[1]!.init?.credentials).toBe("include");
  });

  test("a redirect to a login page is still the typed auth error, with unchanged wording", async () => {
    let err: unknown;
    try {
      await new JiraClient(sessionProfile()).downloadAttachment(
        `${base}/rest/api/3/attachment/content/11`
      );
    } catch (caught) {
      err = caught;
    }

    expect(isJiraSessionAuthError(err)).toBe(true);
    const typed = err as JiraSessionAuthError;
    expect(typed.reason).toBe("auth-redirect");
    // Byte-identical to the JSON path's message: the extension detects session
    // expiry by matching this text.
    expect(typed.message).toBe(
      "Jira API error (302): authentication redirect to Atlassian login (session not logged in)"
    );
    // Never followed, and never retried: a login bounce is a verdict, not a
    // transient failure.
    expect(hits).toEqual(["site/rest/api/3/attachment/content/11"]);
  });

  test("a redirect to a non-allowlisted third party is refused before the request", async () => {
    let err: unknown;
    try {
      await new JiraClient(sessionProfile()).downloadAttachment(
        `${base}/rest/api/3/attachment/content/12`
      );
    } catch (caught) {
      err = caught;
    }

    expect((err as Error).name).toBe("SessionRedirectBlockedError");
    expect((err as Error).message).toMatch(/non-allowlisted origin/);
    expect(hits).toEqual(["site/rest/api/3/attachment/content/12"]);
    // It must not read as a session expiry to the extension's classifier.
    expect((err as Error).message).not.toMatch(
      /non-json|login page|authentication redirect|opaqueredirect/i
    );
  });

  test("the redirect chain is bounded", async () => {
    let err: unknown;
    try {
      await new JiraClient(sessionProfile()).downloadAttachment(`${base}/loop/0`);
    } catch (caught) {
      err = caught;
    }

    expect((err as Error).message).toMatch(/more than 5 redirects/);
    expect(hits).toHaveLength(6);
  });

  test("regression: JSON API calls keep the strict no-redirect rule, media CDN included", async () => {
    let err: unknown;
    try {
      await new JiraClient(sessionProfile()).getIssue("MEDIA-1");
    } catch (caught) {
      err = caught;
    }

    expect(isJiraSessionAuthError(err)).toBe(true);
    expect((err as JiraSessionAuthError).reason).toBe("auth-redirect");
    expect(hits).toEqual(["site/rest/api/2/issue/MEDIA-1"]);
  });

  test("regression: token auth still follows redirects itself, with no manual handling", async () => {
    const bytes = await new JiraClient(tokenProfile()).downloadAttachment(
      `${base}/rest/api/3/attachment/content/13`
    );

    expect(new Uint8Array(bytes)).toEqual(BYTES);
    // fetch followed it internally: exactly one call from the client.
    expect(inits).toHaveLength(1);
    expect(inits[0]!.init?.redirect).toBeUndefined();
    expect(inits[0]!.init?.credentials).toBeUndefined();
  });
});
