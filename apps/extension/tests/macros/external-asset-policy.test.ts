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
  externalAssetPolicyFromPageUrl,
  isExternalAssetBlockedError,
  isPrivateHost,
  POLICY_FIXTURE_SITE_ORIGIN,
  type ExternalAssetPolicyFixture,
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

describe("ExternalAssetPolicy — shared fixture set", () => {
  const direct = EXTERNAL_ASSET_POLICY_FIXTURES.filter((f) => !f.redirectsTo);

  it("covers every category the plan names", () => {
    const names = EXTERNAL_ASSET_POLICY_FIXTURES.map((f) => f.name);
    expect(names).toContain("site origin");
    expect(names).toContain("allowed Atlassian media origin");
    expect(names).toContain("disallowed third-party origin");
    expect(names).toContain("redirect to a disallowed origin");
    expect(names).toContain("loopback target");
    expect(names).toContain("private RFC1918 target");
  });

  for (const fixture of direct) {
    it(`allow() — ${fixture.name}: ${fixture.reason}`, () => {
      expect(policy.allow(fixture.url)).toBe(fixture.allowed);
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

describe("SSRF guard", () => {
  const privateHosts = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
    "intranet",
  ];
  for (const host of privateHosts) {
    it(`rejects ${host}`, () => {
      expect(isPrivateHost(host)).toBe(true);
    });
  }

  it("does not reject ordinary public hosts", () => {
    expect(isPrivateHost("fixture.atlassian.net")).toBe(false);
    expect(isPrivateHost("api.media.atlassian.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });

  it("rejects an IPv4-mapped loopback address", () => {
    expect(policy.allow("http://[::ffff:127.0.0.1]/x.png")).toBe(false);
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
      (f) => f.name === "redirect to a disallowed origin"
    ) as ExternalAssetPolicyFixture;
    const log = installFetch((url) =>
      url === fixture.url ? redirect(fixture.redirectsTo!) : ok()
    );
    const fetcher = createExternalAssetFetcher(policy);
    // The FIRST url is allowed — an allowed origin must not be usable as an
    // open redirector into a disallowed one.
    expect(policy.allow(fixture.url)).toBe(true);
    const error = await fetcher
      .fetch(fixture.url, { maxBytes: 1024 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isExternalAssetBlockedError(error)).toBe(true);
    expect((error as Error).message).toMatch(/redirected to a disallowed origin/);
    // One request issued (the allowed hop); the disallowed hop was never fetched.
    expect(log.urls).toEqual([fixture.url]);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const fixture = EXTERNAL_ASSET_POLICY_FIXTURES.find(
      (f) => f.name === "redirect within the allowlist"
    ) as ExternalAssetPolicyFixture;
    const log = installFetch((url) =>
      url === fixture.url ? redirect(fixture.redirectsTo!) : ok()
    );
    const fetcher = createExternalAssetFetcher(policy);
    const { bytes } = await fetcher.fetch(fixture.url, { maxBytes: 1024 });
    expect(bytes.byteLength).toBe(8);
    expect(log.urls).toEqual([fixture.url, fixture.redirectsTo!]);
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
