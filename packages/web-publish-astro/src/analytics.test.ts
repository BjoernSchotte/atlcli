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
