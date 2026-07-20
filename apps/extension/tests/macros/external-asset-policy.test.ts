/**
 * `ExternalAssetPolicy` / `ExternalAssetFetcher` (spec 010 T5.4).
 *
 * NO HTTP MOCKING: `installFetch` below hands back hand-constructed REAL
 * `Response` objects (the pattern `tests/read-path.test.ts` already uses).
 * Every allow/reject decision under test is computed by the real policy over a
 * real `URL`.
 *
 * The fixture array is imported, not re-declared: a wave-2 agent extends this
 * file to drive the SAME fixtures through both engines' resolvers
 * (`utils/pdf/run-export.ts#pageResolver` and
 * `utils/docx/env.ts#sessionAssetFetcher`) and assert identical outcomes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  ATLASSIAN_MEDIA_ORIGINS,
  createExternalAssetFetcher,
  createExternalAssetPolicy,
  EXTERNAL_ASSET_POLICY_FIXTURES,
  EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES,
  externalAssetPolicyFromPageUrl,
  isExternalAssetBlockedError,
  isExternalAssetTimeoutError,
  isPrivateHost,
  parseIpv6,
  POLICY_FIXTURE_SITE_ORIGIN,
} from "../../utils/macros/external-asset-policy.js";

const policy = createExternalAssetPolicy({ siteOrigin: POLICY_FIXTURE_SITE_ORIGIN });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FetchLog {
  urls: string[];
  inits: RequestInit[];
}

/** Route hand-built REAL Responses by URL, recording every request. */
function installFetch(handler: (url: string) => Response): FetchLog {
  const log: FetchLog = { urls: [], inits: [] };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.urls.push(url);
    log.inits.push(init ?? {});
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return log;
}

function ok(body = "PNGBYTES"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

/**
 * Answer a 302 chain: `start` bounces to `chain[0]`, `chain[0]` to `chain[1]`,
 * …, and the last entry answers 200. Anything else answers 200 too, so a hop
 * the fetcher invents rather than follows still shows up in the log.
 */
function installChain(start: string, chain: readonly string[]): FetchLog {
  const hops = [start, ...chain];
  return installFetch((url) => {
    const at = hops.indexOf(url);
    return at >= 0 && at < chain.length ? redirect(chain[at]!) : ok();
  });
}

describe("ExternalAssetPolicy — shared fixture set", () => {
  it("covers every category the plan names", () => {
    const names = EXTERNAL_ASSET_POLICY_FIXTURES.map((f) => f.name);
    for (const required of [
      "site origin",
      "allowed Atlassian media origin",
      "disallowed third-party origin",
      "redirect to a disallowed origin",
      "multi-hop redirect ending at a private target",
      "loopback target",
      "private RFC1918 target",
      "mapped-IPv6 loopback target",
      "mapped-IPv6 metadata target",
      "unspecified IPv6 target",
      "unique-local IPv6 metadata target",
      "GCE metadata hostname",
    ]) {
      expect(names).toContain(required);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The guard that makes the array self-driving. Redirect fixtures used to be
   * FILTERED OUT of the loop below and two were hand-picked by name, so
   * `allowedAfterRedirect` was never read: a fixture could declare any outcome
   * at all and the suite stayed green.
   */
  it("drives every declared expectation — no fixture field is decorative", () => {
    const redirecting = EXTERNAL_ASSET_POLICY_FIXTURES.filter((f) => f.redirectChain);
    expect(redirecting.length).toBeGreaterThan(2);
    // A chain without an outcome (or an outcome without a chain) is an
    // expectation nothing can assert on.
    expect(
      EXTERNAL_ASSET_POLICY_FIXTURES.filter(
        (f) => (f.redirectChain !== undefined) !== (f.allowedAfterRedirect !== undefined)
      ).map((f) => f.name)
    ).toEqual([]);
    expect(redirecting.every((f) => f.redirectChain!.length > 0)).toBe(true);
    // At least one chain is longer than a single hop: a one-hop-only set cannot
    // tell a per-hop check apart from one that re-checks only the first bounce.
    expect(Math.max(...redirecting.map((f) => f.redirectChain!.length))).toBeGreaterThan(1);
  });

  // EVERY fixture, redirecting ones included — `allow()` is the verdict for the
  // fixture's own URL regardless of where it later bounces.
  for (const fixture of EXTERNAL_ASSET_POLICY_FIXTURES) {
    it(`allow() — ${fixture.name}: ${fixture.reason}`, () => {
      expect(policy.allow(fixture.url)).toBe(fixture.allowed);
    });
  }

  for (const fixture of EXTERNAL_ASSET_POLICY_FIXTURES.filter((f) => f.redirectChain)) {
    it(`fetch() through the redirect chain — ${fixture.name}: ${fixture.reason}`, async () => {
      const chain = fixture.redirectChain!;
      const log = installChain(fixture.url, chain);
      const fetcher = createExternalAssetFetcher(policy);
      const error = await fetcher
        .fetch(fixture.url, { maxBytes: 1024 })
        .then(() => undefined)
        .catch((e: unknown) => e);

      expect(error === undefined).toBe(fixture.allowedAfterRedirect!);
      if (fixture.allowedAfterRedirect) {
        expect(log.urls).toEqual([fixture.url, ...chain]);
      } else {
        // The blocked hop is never requested — the guard runs BEFORE the fetch,
        // so a disallowed final destination sees no traffic at all.
        expect(isExternalAssetBlockedError(error)).toBe(true);
        expect(log.urls).toEqual([fixture.url, ...chain.slice(0, -1)]);
        expect(log.urls).not.toContain(chain[chain.length - 1]);
      }
      for (const init of log.inits) {
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("manual");
      }
    });
  }
});

describe("ExternalAssetPolicy — origin rules", () => {
  it("allows only the configured media origins, not every Atlassian host", () => {
    expect(policy.allow("https://api.media.atlassian.com/file/a/binary")).toBe(true);
    expect(policy.allow("https://other-api.atlassian.com/file/a/binary")).toBe(false);
    expect(ATLASSIAN_MEDIA_ORIGINS).toContain("https://api.media.atlassian.com");
  });

  it("never widens beyond the explicitly configured list", () => {
    const strict = createExternalAssetPolicy({
      siteOrigin: POLICY_FIXTURE_SITE_ORIGIN,
      allowedMediaOrigins: [],
    });
    expect(strict.allow("https://api.media.atlassian.com/file/a/binary")).toBe(false);
    expect(strict.allow(`${POLICY_FIXTURE_SITE_ORIGIN}/wiki/x.png`)).toBe(true);
  });

  it("derives the site origin from a full page URL", () => {
    const fromPage = externalAssetPolicyFromPageUrl(
      `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/spaces/DOCSY/pages/123/Title`
    );
    expect(fromPage.allow(`${POLICY_FIXTURE_SITE_ORIGIN}/wiki/download/x.png`)).toBe(true);
    expect(fromPage.allow("https://elsewhere.atlassian.net/wiki/download/x.png")).toBe(false);
  });

  it("rejects everything but the media origins when the site origin is unparseable", () => {
    const broken = createExternalAssetPolicy({ siteOrigin: "not a url" });
    expect(broken.allow("/relative.png")).toBe(false);
    expect(broken.allow("https://api.media.atlassian.com/file/a/binary")).toBe(true);
  });
});

/**
 * These assert `isPrivateHost` DIRECTLY, never `policy.allow()`.
 *
 * `allow()` rejects a private host and an off-allowlist origin with the same
 * `false`, and every private host is also off-allowlist — so an `allow()`-based
 * assertion passes whether or not the SSRF guard fires. That is precisely how
 * `http://[::ffff:127.0.0.1]/` looked covered while `isPrivateHost` was blind to
 * the hex form WHATWG `URL` actually produces (`[::ffff:7f00:1]`).
 */
describe("SSRF guard — isPrivateHost, asserted on the predicate itself", () => {
  for (const fixture of EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES) {
    it(`${fixture.private ? "rejects" : "allows"} ${fixture.host}: ${fixture.reason}`, () => {
      expect(isPrivateHost(fixture.host)).toBe(fixture.private);
    });
  }

  it("sees the canonical form the URL parser hands the policy, not the source spelling", () => {
    // The regression in one line: this is what `new URL()` leaves for the guard.
    expect(new URL("http://[::ffff:127.0.0.1]/x.png").hostname).toBe("[::ffff:7f00:1]");
    expect(isPrivateHost(new URL("http://[::ffff:127.0.0.1]/x.png").hostname)).toBe(true);
    expect(isPrivateHost(new URL("http://[::ffff:169.254.169.254]/x").hostname)).toBe(true);
    expect(isPrivateHost(new URL("http://[::]/x").hostname)).toBe(true);
  });

  it("collapses every spelling of one address to the same groups", () => {
    const loopback = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1];
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual(loopback);
    expect(parseIpv6("::ffff:7f00:1")).toEqual(loopback);
    expect(parseIpv6("0:0:0:0:0:ffff:7f00:0001")).toEqual(loopback);
    expect(parseIpv6("[::ffff:7f00:1]")).toEqual(loopback);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("8.8.8.8")).toBeUndefined();
    expect(parseIpv6("example.com")).toBeUndefined();
    expect(parseIpv6("::ffff:999.0.0.1")).toBeUndefined();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
  });

  it("blocks a mapped/unspecified IPv6 even when the caller allowlists its origin", () => {
    // The guard runs BEFORE the origin comparison, so a host adapter that adds
    // one of these to `allowedMediaOrigins` still cannot reach it. Without this,
    // an `allow()`-only assertion would pass on the origin mismatch alone.
    for (const origin of ["http://[::ffff:7f00:1]", "http://[::]", "http://[fd00:ec2::254]"]) {
      const permissive = createExternalAssetPolicy({
        siteOrigin: origin,
        allowedMediaOrigins: [origin],
      });
      expect(permissive.allow(`${origin}/internal.png`)).toBe(false);
    }
  });
});

describe("ExternalAssetFetcher — enforcement across the whole request", () => {
  it("fetches an allowed URL without session cookies", async () => {
    const log = installFetch(() => ok());
    const fetcher = createExternalAssetFetcher(policy);
    const { bytes, mediaType } = await fetcher.fetch(
      "https://api.media.atlassian.com/file/a/binary",
      { maxBytes: 1024 }
    );
    expect(bytes.byteLength).toBe(8);
    expect(mediaType).toBe("image/png");
    // The whole point of routing export_view URLs here: no ambient credentials,
    // and manual redirect so every hop is re-checked.
    expect(log.inits[0].credentials).toBe("omit");
    expect(log.inits[0].redirect).toBe("manual");
  });

  it("rejects a disallowed origin without issuing a request at all", async () => {
    const log = installFetch(() => ok());
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch("https://third-party-app.example.com/chart.png", { maxBytes: 1024 })
    ).rejects.toThrow(/blocked by the export asset policy/);
    expect(log.urls).toEqual([]);
  });

  it("re-checks the policy on every redirect hop", async () => {
    const fixture = EXTERNAL_ASSET_POLICY_FIXTURES.find(
      (f) => f.name === "multi-hop redirect ending at a private target"
    )!;
    const log = installChain(fixture.url, fixture.redirectChain!);
    const fetcher = createExternalAssetFetcher(policy);
    // The first TWO urls are allowed — an allowed origin must not be usable as
    // an open redirector into a disallowed one, however many hops it takes.
    expect(policy.allow(fixture.url)).toBe(true);
    expect(policy.allow(fixture.redirectChain![0]!)).toBe(true);
    const error = await fetcher
      .fetch(fixture.url, { maxBytes: 1024 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isExternalAssetBlockedError(error)).toBe(true);
    expect((error as Error).message).toMatch(/redirected to a disallowed origin/);
    // Two requests issued (both allowed hops); the metadata service was never
    // contacted.
    expect(log.urls).toEqual([fixture.url, fixture.redirectChain![0]!]);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const fixture = EXTERNAL_ASSET_POLICY_FIXTURES.find(
      (f) => f.name === "redirect within the allowlist"
    )!;
    const log = installChain(fixture.url, fixture.redirectChain!);
    const fetcher = createExternalAssetFetcher(policy);
    const { bytes } = await fetcher.fetch(fixture.url, { maxBytes: 1024 });
    expect(bytes.byteLength).toBe(8);
    expect(log.urls).toEqual([fixture.url, ...fixture.redirectChain!]);
  });

  it("treats an opaque cross-origin redirect as blocked, not as an empty asset", async () => {
    installFetch(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      return res;
    });
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 1024 })
    ).rejects.toThrow(/opaque cross-origin redirect/);
  });

  it("stops after too many redirects", async () => {
    let n = 0;
    installFetch(() => redirect(`${POLICY_FIXTURE_SITE_ORIGIN}/hop/${n++}`));
    const fetcher = createExternalAssetFetcher(policy, { maxRedirects: 2 });
    await expect(
      fetcher.fetch(`${POLICY_FIXTURE_SITE_ORIGIN}/start`, { maxBytes: 1024 })
    ).rejects.toThrow(/more than 2 redirects/);
  });

  it("caps a declared oversize body before reading any bytes", async () => {
    const log = installFetch(
      () =>
        new Response("x".repeat(64), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "999999" },
        })
    );
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 16 })
    ).rejects.toThrow(/exceeded the 16-byte export limit/);
    expect(log.urls.length).toBe(1);
  });

  it("caps an undeclared oversize body mid-stream", async () => {
    installFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(32));
              controller.enqueue(new Uint8Array(32));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "image/png" } }
        )
    );
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 40 })
    ).rejects.toThrow(/exceeded the 40-byte export limit/);
  });

  /**
   * The stall case. `maxBytes` bounds how much a hostile response can cost;
   * nothing bounded how LONG it could take, and the caller's `AbortSignal` is
   * optional — so a body that stops arriving without ever ending left
   * `reader.read()` pending for the life of the panel.
   */
  describe("internal deadline", () => {
    /** Headers, one byte, then silence — the stream never ends and never errors. */
    function stalledBody(): Response {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            // Deliberately no close(), no error(), no further enqueue.
          },
        }),
        { status: 200, headers: { "content-type": "image/png" } }
      );
    }

    // The explicit per-test timeout is the point of these two: with the internal
    // deadline removed they do not fail, they HANG — there is nothing else in
    // the fetcher that could ever settle them.
    it(
      "gives up on a body that stalls mid-stream, with no caller signal at all",
      async () => {
        installFetch(() => stalledBody());
        const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 25 });
        const error = await fetcher
          .fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 1024 })
          .then(() => undefined)
          .catch((e: unknown) => e);
        expect(isExternalAssetTimeoutError(error)).toBe(true);
        expect((error as Error).message).toMatch(/timed out after 25 ms/);
      },
      2_000
    );

    it(
      "gives up on a response that never arrives",
      async () => {
        // A hop whose headers never come back — the deadline covers the request,
        // not just the body read.
        const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
        const fetcher = createExternalAssetFetcher(policy, { fetchFn: never, timeoutMs: 25 });
        await expect(
          fetcher.fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 1024 })
        ).rejects.toThrow(/timed out after 25 ms/);
      },
      2_000
    );

    it(
      "keeps signed media tokens out of the timeout message",
      async () => {
        installFetch(() => stalledBody());
        const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 25 });
        const error = await fetcher
          .fetch("https://api.media.atlassian.com/file/a/binary?token=SUPERSECRET", {
            maxBytes: 1024,
          })
          .then(() => undefined)
          .catch((e: unknown) => e);
        expect((error as Error).message).not.toContain("SUPERSECRET");
      },
      2_000
    );

    it(
      "still lets the caller's own signal win, with its own reason",
      async () => {
        installFetch(() => stalledBody());
        const controller = new AbortController();
        const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 10_000 });
        const pending = fetcher.fetch("https://api.media.atlassian.com/file/a/binary", {
          maxBytes: 1024,
          signal: controller.signal,
        });
        controller.abort(new Error("panel closed"));
        await expect(pending).rejects.toThrow("panel closed");
      },
      2_000
    );

    it("does not fire on a response that completes inside the budget", async () => {
      installFetch(() => ok());
      const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 5_000 });
      const { bytes } = await fetcher.fetch("https://api.media.atlassian.com/file/a/binary", {
        maxBytes: 1024,
      });
      expect(bytes.byteLength).toBe(8);
    });
  });

  it("keeps signed media tokens out of the report message", async () => {
    installFetch(() => ok());
    const fetcher = createExternalAssetFetcher(policy);
    const error = await fetcher
      .fetch("https://evil.example.com/chart.png?token=SUPERSECRET", { maxBytes: 1024 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("SUPERSECRET");
    expect((error as Error).message).toContain("https://evil.example.com/chart.png");
  });

  it("surfaces a non-2xx from an allowed origin as a fetch failure, not a policy block", async () => {
    installFetch(() => new Response("nope", { status: 502 }));
    const fetcher = createExternalAssetFetcher(policy);
    const error = await fetcher
      .fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 1024 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isExternalAssetBlockedError(error)).toBe(false);
    expect((error as Error).message).toMatch(/External image fetch failed \(502\)/);
  });
});
