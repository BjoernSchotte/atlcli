/**
 * The external-asset boundary, asserted against the SHARED parity fixtures.
 *
 * These cases came from the extension's wave-1 hardening pass (an adversarial
 * review that found an IPv4-mapped-IPv6 bypass, a `::` bypass, a NAT64 bypass
 * and a missing stream deadline). They live here now so the CLI is held to the
 * same bar — before the promotion the CLI's copy of this policy knew none of
 * them.
 *
 * NO HTTP MOCKING: `installFetch` hands back hand-constructed REAL `Response`
 * objects. Every allow/reject decision under test is computed by the real
 * policy over a real `URL`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  createExternalAssetFetcher,
  createExternalAssetPolicy,
  defaultExternalAssetFetcher,
  defaultExternalAssetPolicy,
  isExternalAssetBlockedError,
  isExternalAssetTimeoutError,
  isPrivateHost,
  parseIpv6,
} from "./asset-policy.js";
import {
  EXTERNAL_ASSET_POLICY_FIXTURES,
  EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES,
  POLICY_FIXTURE_ALLOWED_ORIGINS,
  POLICY_FIXTURE_EXTRA_ORIGIN,
  POLICY_FIXTURE_SITE_ORIGIN,
} from "./fixtures.js";

const policy = createExternalAssetPolicy({
  siteOrigin: POLICY_FIXTURE_SITE_ORIGIN,
  allowedOrigins: POLICY_FIXTURE_ALLOWED_ORIGINS,
});

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
  it("covers every category the parity contract names", () => {
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
        // The blocked hop is never requested — the guard runs BEFORE the fetch.
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
  it("allows only the configured extra origins, not every Atlassian host", () => {
    expect(policy.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(true);
    expect(policy.allow("https://other-api.atlassian.com/file/a/binary")).toBe(false);
  });

  /**
   * The package default is the CLI's historical behaviour and the safe floor:
   * a host widens the policy by PASSING origins, never by inheriting a list the
   * shared package chose for it. (The extension's Atlassian media allowlist is
   * a manifest-derived host decision and stays in the extension.)
   */
  it("allows nothing beyond the site origin unless the host says so", () => {
    const bare = createExternalAssetPolicy({ siteOrigin: POLICY_FIXTURE_SITE_ORIGIN });
    expect(bare.allow(`${POLICY_FIXTURE_SITE_ORIGIN}/wiki/x.png`)).toBe(true);
    expect(bare.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(false);
  });

  it("rejects everything when the site origin is unparseable and no origins are configured", () => {
    const broken = createExternalAssetPolicy({ siteOrigin: "not a url" });
    expect(broken.allow("/relative.png")).toBe(false);
    expect(broken.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(false);
  });

  it("defaultExternalAssetPolicy is the same-origin-only floor", () => {
    const cli = defaultExternalAssetPolicy("https://acme.atlassian.net");
    expect(cli.allow("/wiki/download/x.png")).toBe(true);
    expect(cli.allow("https://acme.atlassian.net/img.png")).toBe(true);
    expect(cli.allow("https://evil.example.com/x.png")).toBe(false);
    expect(cli.allow("file:///etc/passwd")).toBe(false);
    expect(cli.allow("javascript:alert(1)")).toBe(false);
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1"]) {
      expect(cli.allow(`http://${host}/x`)).toBe(false);
    }
  });

  /**
   * Cases the CLI's pre-promotion policy accepted. Kept as explicit CLI-facing
   * regression coverage of the upgrade, not just as fixture rows.
   */
  it("rejects the shapes the CLI's own policy used to let through", () => {
    const cli = defaultExternalAssetPolicy("https://acme.atlassian.net");
    // Embedded credentials on the site's own origin.
    expect(cli.allow("https://user:secret@acme.atlassian.net/img.png")).toBe(false);
    // Same-origin spelled as a private literal (only reachable if a host ever
    // configured one, but the guard must not depend on that).
    const permissive = createExternalAssetPolicy({
      siteOrigin: "http://[::ffff:7f00:1]",
      allowedOrigins: ["http://[::ffff:7f00:1]"],
    });
    expect(permissive.allow("http://[::ffff:7f00:1]/internal.png")).toBe(false);
  });
});

/**
 * Asserted against `isPrivateHost` DIRECTLY, never `policy.allow()`.
 *
 * `allow()` rejects a private host and an off-allowlist origin with the same
 * `false`, and every private host is also off-allowlist — so an `allow()`-based
 * assertion passes whether or not the SSRF guard fires. That is precisely how
 * `http://[::ffff:127.0.0.1]/` looked covered while the predicate was blind to
 * the hex form WHATWG `URL` actually produces (`[::ffff:7f00:1]`).
 */
describe("SSRF guard — isPrivateHost, asserted on the predicate itself", () => {
  for (const fixture of EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES) {
    it(`${fixture.private ? "rejects" : "allows"} ${fixture.host}: ${fixture.reason}`, () => {
      expect(isPrivateHost(fixture.host)).toBe(fixture.private);
    });
  }

  it("sees the canonical form the URL parser hands the policy, not the source spelling", () => {
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
});

describe("ExternalAssetFetcher — enforcement across the whole request", () => {
  it("fetches an allowed URL without ambient credentials", async () => {
    const log = installFetch(() => ok());
    const fetcher = createExternalAssetFetcher(policy);
    const { bytes, mediaType } = await fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, {
      maxBytes: 1024,
    });
    expect(bytes.byteLength).toBe(8);
    expect(mediaType).toBe("image/png");
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

  it("treats an opaque cross-origin redirect as blocked, not as an empty asset", async () => {
    installFetch(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      return res;
    });
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 1024 })
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

  it("rejects a redirect with no Location header", async () => {
    installFetch(() => new Response(null, { status: 302 }));
    const fetcher = createExternalAssetFetcher(policy);
    await expect(
      fetcher.fetch(`${POLICY_FIXTURE_SITE_ORIGIN}/start`, { maxBytes: 1024 })
    ).rejects.toThrow(/redirect without a Location header/);
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
      fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 16 })
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
      fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 40 })
    ).rejects.toThrow(/exceeded the 40-byte export limit/);
  });

  /**
   * The stall case. `maxBytes` bounds how much a hostile response can cost;
   * nothing bounded how LONG it could take, and the caller's `AbortSignal` is
   * optional. The explicit per-test timeout is the point: with the internal
   * deadline removed these do not fail, they HANG.
   */
  describe("internal deadline", () => {
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

    it(
      "gives up on a body that stalls mid-stream, with no caller signal at all",
      async () => {
        installFetch(() => stalledBody());
        const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 25 });
        const error = await fetcher
          .fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 1024 })
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
        const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
        const fetcher = createExternalAssetFetcher(policy, { fetchFn: never, timeoutMs: 25 });
        await expect(
          fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 1024 })
        ).rejects.toThrow(/timed out after 25 ms/);
      },
      2_000
    );

    it(
      "still lets the caller's own signal win, with its own reason",
      async () => {
        installFetch(() => stalledBody());
        const controller = new AbortController();
        const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 10_000 });
        const pending = fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, {
          maxBytes: 1024,
          signal: controller.signal,
        });
        controller.abort(new Error("export cancelled"));
        await expect(pending).rejects.toThrow("export cancelled");
      },
      2_000
    );

    it("does not fire on a response that completes inside the budget", async () => {
      installFetch(() => ok());
      const fetcher = createExternalAssetFetcher(policy, { timeoutMs: 5_000 });
      const { bytes } = await fetcher.fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, {
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
      .fetch(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`, { maxBytes: 1024 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isExternalAssetBlockedError(error)).toBe(false);
    expect((error as Error).message).toMatch(/External image fetch failed \(502\)/);
  });

  /**
   * The host swaps `globalThis.fetch` (TLS/proxy setup in the CLI, a stub in a
   * suite) AFTER the fetcher is built. Capturing it at construction time reads
   * as "the stub was ignored and a real request went out".
   */
  it("resolves globalThis.fetch at call time, not at construction time", async () => {
    const fetcher = createExternalAssetFetcher(policy);
    const log = installFetch(() => ok());
    const { bytes } = await fetcher.fetch(`${POLICY_FIXTURE_SITE_ORIGIN}/late.png`, {
      maxBytes: 1024,
    });
    expect(bytes.byteLength).toBe(8);
    expect(log.urls).toEqual([`${POLICY_FIXTURE_SITE_ORIGIN}/late.png`]);
  });

  it("defaultExternalAssetFetcher is the same enforced fetcher", async () => {
    const cliPolicy = defaultExternalAssetPolicy("https://acme.atlassian.net");
    const fetcher = defaultExternalAssetFetcher(cliPolicy);
    installFetch((url) =>
      url.startsWith("https://acme.atlassian.net")
        ? redirect("https://evil.example.com/x.png")
        : ok()
    );
    await expect(
      fetcher.fetch("https://acme.atlassian.net/start.png", { maxBytes: 1000 })
    ).rejects.toThrow(/redirected to a disallowed origin/);
  });
});
