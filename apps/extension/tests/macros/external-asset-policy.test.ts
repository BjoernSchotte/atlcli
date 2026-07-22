/**
 * The extension's half of the external-asset boundary (spec 010 T5.4, W2-0).
 *
 * The policy MECHANICS — SSRF guard, redirect re-checking, byte cap, deadline,
 * error taxonomy — are owned and exhaustively tested by `@atlcli/export-wiring`
 * (`packages/export-wiring/src/asset-policy.test.ts`, including all 37
 * private-host fixtures asserted against the predicate itself). Repeating them
 * here would not add coverage; it would add a second thing to keep in sync,
 * which is exactly what this promotion removed.
 *
 * What IS the extension's own, and therefore what this file asserts:
 *
 *  1. the origin allowlist matches the manifest and nothing wider;
 *  2. the SHARED parity fixtures produce the shared verdicts through the
 *     EXTENSION's policy instance — i.e. the panel and the CLI reject the same
 *     URLs, which is the claim the whole fixture set exists to support.
 *
 * NO HTTP MOCKING: `installFetch` hands back hand-constructed REAL `Response`
 * objects.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  EXTERNAL_ASSET_POLICY_FIXTURES,
  EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES,
  POLICY_FIXTURE_ALLOWED_ORIGINS,
  POLICY_FIXTURE_EXTRA_ORIGIN,
  POLICY_FIXTURE_SITE_ORIGIN,
} from "@atlcli/export-wiring/fixtures";
import {
  ATLASSIAN_MEDIA_ORIGINS,
  createExtensionAssetPolicy,
  createExternalAssetFetcher,
  extensionAssetPolicyFromPageUrl,
  isExternalAssetBlockedError,
  isPrivateHost,
} from "../../utils/macros/external-asset-policy.js";

const policy = createExtensionAssetPolicy({ siteOrigin: POLICY_FIXTURE_SITE_ORIGIN });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FetchLog {
  urls: string[];
  inits: RequestInit[];
}

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

function installChain(start: string, chain: readonly string[]): FetchLog {
  const hops = [start, ...chain];
  return installFetch((url) => {
    const at = hops.indexOf(url);
    return at >= 0 && at < chain.length ? redirect(chain[at]!) : ok();
  });
}

describe("the extension's origin allowlist", () => {
  it("is exactly the set the manifest grants — the fixture allowlist, not a superset", () => {
    // The parity fixtures are evaluated against POLICY_FIXTURE_ALLOWED_ORIGINS.
    // If this extension ever grants more (or fewer) origins than that, the
    // fixture verdicts below stop describing the extension and this fails first,
    // pointing at the manifest rather than at a mystery fixture failure.
    expect([...ATLASSIAN_MEDIA_ORIGINS]).toEqual([...POLICY_FIXTURE_ALLOWED_ORIGINS]);
    expect(ATLASSIAN_MEDIA_ORIGINS).toContain("https://api.media.atlassian.com");
  });

  it("allows the configured media origin but not every Atlassian host", () => {
    expect(policy.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(true);
    expect(policy.allow("https://other-api.atlassian.com/file/a/binary")).toBe(false);
  });

  it("never widens beyond the explicitly configured list", () => {
    const strict = createExtensionAssetPolicy({
      siteOrigin: POLICY_FIXTURE_SITE_ORIGIN,
      allowedMediaOrigins: [],
    });
    expect(strict.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(false);
    expect(strict.allow(`${POLICY_FIXTURE_SITE_ORIGIN}/wiki/x.png`)).toBe(true);
  });

  it("derives the site origin from a full page URL", () => {
    const fromPage = extensionAssetPolicyFromPageUrl(
      `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/spaces/DOCSY/pages/123/Title`
    );
    expect(fromPage.allow(`${POLICY_FIXTURE_SITE_ORIGIN}/wiki/download/x.png`)).toBe(true);
    expect(fromPage.allow("https://elsewhere.atlassian.net/wiki/download/x.png")).toBe(false);
  });

  it("falls back to the media origins alone when the tab URL is unparseable", () => {
    const broken = createExtensionAssetPolicy({ siteOrigin: "not a url" });
    expect(broken.allow("/relative.png")).toBe(false);
    expect(broken.allow(`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/a/binary`)).toBe(true);
  });
});

describe("cross-host parity — the shared fixtures through the extension's policy", () => {
  for (const fixture of EXTERNAL_ASSET_POLICY_FIXTURES) {
    it(`allow() — ${fixture.name}: ${fixture.reason}`, () => {
      expect(policy.allow(fixture.url)).toBe(fixture.allowed);
    });
  }

  for (const fixture of EXTERNAL_ASSET_POLICY_FIXTURES.filter((f) => f.redirectChain)) {
    it(`fetch() through the redirect chain — ${fixture.name}`, async () => {
      const chain = fixture.redirectChain!;
      const log = installChain(fixture.url, chain);
      const fetcher = createExternalAssetFetcher(policy);
      const error = await fetcher
        .fetch(fixture.url, { maxBytes: 1024 })
        .then(() => undefined)
        .catch((e: unknown) => e);

      expect(error === undefined).toBe(fixture.allowedAfterRedirect!);
      if (!fixture.allowedAfterRedirect) {
        // The blocked hop is never requested — the guard runs BEFORE the fetch.
        expect(isExternalAssetBlockedError(error)).toBe(true);
        expect(log.urls).not.toContain(chain[chain.length - 1]);
      }
      for (const init of log.inits) {
        // Third-party macro-rendered URLs must never ride the user's Atlassian
        // session cookies — that is the difference between this fetcher and the
        // panel's ordinary `credentials: "include"` client.
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("manual");
      }
    });
  }

  it("the SSRF guard the extension uses is the shared predicate", () => {
    // Spot-checks only: the full 37-fixture sweep runs in the package suite.
    // What matters here is that `isPrivateHost` reaching the extension IS that
    // predicate, so the panel cannot drift to a weaker one.
    for (const fixture of EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES) {
      expect(isPrivateHost(fixture.host)).toBe(fixture.private);
    }
  });
});
