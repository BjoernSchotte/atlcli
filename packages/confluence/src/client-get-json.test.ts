import { afterEach, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const profile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("getJson reaches v1 and v2 below the Confluence base", async () => {
  const urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new ConfluenceClient(profile);
  expect(await client.getJson("/rest/api/content/1/restriction", { query: { limit: 5 } })).toEqual({ ok: true });
  expect(await client.getJson("/api/v2/pages/1/properties")).toEqual({ ok: true });
  expect(urls).toEqual([
    "https://test.atlassian.net/wiki/rest/api/content/1/restriction?limit=5",
    "https://test.atlassian.net/wiki/api/v2/pages/1/properties",
  ]);
});

test("getJson rejects other paths", async () => {
  const client = new ConfluenceClient(profile);
  for (const path of ["/rest/other", "/api/v2/../x", "/api/v2/pages?x=1", "/wiki/rest/api/content"]) {
    await expect(client.getJson(path)).rejects.toThrow(/REST path must start with/);
  }
});
