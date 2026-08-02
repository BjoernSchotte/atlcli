import { describe, expect, test } from "bun:test";
import {
  findRouteCollisions,
  publicationRoutePath,
  trustedAnalyticsConfig,
  trustedConfluenceAction,
} from "./integration.mjs";

describe("T0 route collision policy", () => {
  test("detects a handwritten route that shadows a publication route", () => {
    expect(findRouteCollisions(
      ["/guide", "/reserved"],
      [{ pathname: "/publish/reserved", component: "reserved.astro" }],
    )).toEqual(["/publish/reserved"]);
  });

  test("ignores dynamic catch-all routes without a static pathname", () => {
    expect(findRouteCollisions(
      ["/guide"],
      [{ pathname: undefined, component: "[...slug].astro" }],
    )).toEqual([]);
  });

  test("places non-default locale routes before the owned route prefix", () => {
    expect(publicationRoutePath({ locale: "de", route: "/de/einstieg" })).toBe("/de/publish/einstieg");
    expect(publicationRoutePath({ locale: "ar", route: "/ar/start" })).toBe("/ar/publish/start");
    expect(publicationRoutePath({ locale: "en", route: "/guide" })).toBe("/publish/guide");
  });

  test("detects a localized handwritten route collision", () => {
    expect(findRouteCollisions(
      [{ locale: "de", route: "/de/reserviert" }],
      [{ pathname: "/de/publish/reserviert", component: "reserved.astro" }],
    )).toEqual(["/de/publish/reserviert"]);
  });
});

describe("T0 analytics trust boundary", () => {
  const allowedOrigins = ["https://plausible.example.test"];

  test("accepts only the closed Plausible event endpoint shape", () => {
    expect(trustedAnalyticsConfig({
      domain: "docs.example.test",
      endpoint: "https://plausible.example.test/api/event",
    }, allowedOrigins)).toEqual({
      domain: "docs.example.test",
      endpoint: "https://plausible.example.test/api/event",
    });
  });

  test("rejects hostile endpoints and URL data", () => {
    expect(trustedAnalyticsConfig({ domain: "docs.example.test", endpoint: "https://attacker.example/api/event" }, allowedOrigins)).toBeUndefined();
    expect(trustedAnalyticsConfig({ domain: "docs.example.test", endpoint: "https://plausible.example.test/api/event?source=secret" }, allowedOrigins)).toBeUndefined();
    expect(trustedAnalyticsConfig({ domain: "https://docs.example.test/private", endpoint: "https://plausible.example.test/api/event" }, allowedOrigins)).toBeUndefined();
  });
});

describe("T0 Confluence action trust boundary", () => {
  const providerOrigins = ["https://example.atlassian.net", "https://confluence.example.test"];

  test("accepts provider-returned Cloud edit and Data Center web UI relations", () => {
    expect(trustedConfluenceAction({ kind: "edit", href: "https://example.atlassian.net/wiki/edit?pageId=42" }, providerOrigins)).toEqual({
      href: "https://example.atlassian.net/wiki/edit?pageId=42",
      label: "Edit in Confluence",
    });
    expect(trustedConfluenceAction({ kind: "webui", href: "https://confluence.example.test/pages/viewpage.action?pageId=42" }, providerOrigins)).toEqual({
      href: "https://confluence.example.test/pages/viewpage.action?pageId=42",
      label: "Open in Confluence",
    });
  });

  test("rejects unsafe origins, credentials, and relation kinds", () => {
    expect(trustedConfluenceAction({ kind: "edit", href: "https://attacker.example/edit" }, providerOrigins)).toBeUndefined();
    expect(trustedConfluenceAction({ kind: "edit", href: "https://user:secret@example.atlassian.net/edit" }, providerOrigins)).toBeUndefined();
    expect(trustedConfluenceAction({ kind: "delete", href: "https://example.atlassian.net/delete" }, providerOrigins)).toBeUndefined();
  });
});
