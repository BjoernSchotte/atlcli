import { expect, test } from "bun:test";
import {
  createPublicationAnalyticsCspV1,
  createPublicationAnalyticsPrivacyDeclarationV1,
  createPlausibleAnalyticsRuntimeV1,
  normalizePlausibleAnalyticsConfigV1,
  PLAUSIBLE_TRACKER_VERSION_V1,
} from "./analytics.js";

test("normalizes only the explicit HTTPS Plausible event endpoint", () => {
  const config = normalizePlausibleAnalyticsConfigV1({ endpoint: "https://stats.example.test/api/event", siteDomain: "docs.example.test", events: ["search-open", "search-open"] });
  expect(config).toMatchObject({ provider: "plausible", endpoint: "https://stats.example.test/api/event", searchTerms: false, respectDoNotTrack: true });
  expect(config.events).toEqual(["search-open"]);
  expect(() => normalizePlausibleAnalyticsConfigV1({ endpoint: "https://stats.example.test/api/event?token=secret", siteDomain: "docs.example.test" })).toThrow();
  expect(() => normalizePlausibleAnalyticsConfigV1({ endpoint: "http://stats.example.test/api/event", siteDomain: "docs.example.test" })).toThrow();
});

test("runtime is pinned and excludes query, referrer, search terms, queues, and credentials", () => {
  const config = normalizePlausibleAnalyticsConfigV1({ endpoint: "https://stats.example.test/api/event", siteDomain: "docs.example.test" });
  const runtime = createPlausibleAnalyticsRuntimeV1(config);
  expect(runtime).toContain(PLAUSIBLE_TRACKER_VERSION_V1);
  expect(runtime).toContain("location.origin+location.pathname");
  expect(runtime).not.toContain("location.search");
  expect(runtime).not.toContain("document.referrer");
  expect(runtime).not.toContain("searchTerms");
  expect(runtime).not.toContain("localStorage");
  expect(runtime).toContain('credentials:"omit"');
  expect(createPublicationAnalyticsCspV1(config)).toContain("connect-src 'self' https://stats.example.test");
  expect(createPublicationAnalyticsPrivacyDeclarationV1()).toMatchObject({ persistentQueue: false, excluded: expect.arrayContaining(["search-terms", "confluence-url"]) });
});

test("runtime sends a redacted pathname pageview, tolerates a blocked endpoint, and honors DNT", () => {
  const config = normalizePlausibleAnalyticsConfigV1({ endpoint: "https://stats.example.test/api/event", siteDomain: "docs.example.test" });
  const runtime = createPlausibleAnalyticsRuntimeV1(config);
  const invoke = new Function("location", "navigator", "fetch", runtime) as (
    location: { origin: string; pathname: string; search: string; hash: string },
    navigator: { doNotTrack: string },
    fetch: (input: string, init: RequestInit) => Promise<Response>,
  ) => void;
  const requests: { input: string; init: RequestInit }[] = [];
  expect(() => invoke(
    { origin: "https://docs.example.test", pathname: "/publish/<guide>", search: "?secret=redact", hash: "#private" },
    { doNotTrack: "0" },
    async (input, init) => {
      requests.push({ input, init });
      throw new Error("blocked by CSP");
    },
  )).not.toThrow();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ input: "https://stats.example.test/api/event", init: { method: "POST", credentials: "omit" } });
  expect(String(requests[0]?.init.body)).toContain("/publish/<guide>");
  expect(String(requests[0]?.init.body)).not.toContain("secret");
  expect(String(requests[0]?.init.body)).not.toContain("private");

  const dntRequests: unknown[] = [];
  invoke(
    { origin: "https://docs.example.test", pathname: "/publish/guide/", search: "", hash: "" },
    { doNotTrack: "1" },
    async (input) => { dntRequests.push(input); return new Response(); },
  );
  expect(dntRequests).toEqual([]);
});
