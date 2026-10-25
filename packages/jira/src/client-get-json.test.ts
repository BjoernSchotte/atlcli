import { afterEach, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";

const profile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("getJson GETs a site-relative REST path with query", async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify([{ id: "summary" }]), { status: 200 });
  }) as unknown as typeof fetch;
  const value = await new JiraClient(profile).getJson("/rest/api/3/field", { query: { expand: "x" } });
  expect(value).toEqual([{ id: "summary" }]);
  expect(seen).toEqual([{ url: "https://test.atlassian.net/rest/api/3/field?expand=x", method: "GET" }]);
});

test("getJson rejects paths outside /rest/, queries, dot segments and encoded escapes", async () => {
  const client = new JiraClient(profile);
  for (const path of ["/wiki/rest/api/content", "rest/api/3/field", "/rest/api/3/field?x=1", "/rest/../secure", "/rest/api/%2e%2e/x", "https://evil/rest/x"]) {
    await expect(client.getJson(path)).rejects.toThrow(/REST path must start with/);
  }
});
