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

test("requestJson sends the method, body and query to a site-relative path and returns the JSON ({} for no content)", async () => {
  const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), method: init.method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return init.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ id: "10001", name: "2.0" }), { status: 201 });
  }) as unknown as typeof fetch;
  const client = new JiraClient(profile);
  expect(await client.requestJson("POST", "/rest/api/3/version", { body: { name: "2.0", projectId: 1 }, query: { expand: "x" } })).toEqual({ id: "10001", name: "2.0" });
  expect(await client.requestJson("DELETE", "/rest/api/3/version/10001")).toEqual({});
  expect(seen).toEqual([
    { url: "https://test.atlassian.net/rest/api/3/version?expand=x", method: "POST", body: { name: "2.0", projectId: 1 } },
    { url: "https://test.atlassian.net/rest/api/3/version/10001", method: "DELETE" },
  ]);
});

test("requestJson refuses GET and the paths getJson refuses", async () => {
  const client = new JiraClient(profile);
  await expect(client.requestJson("GET" as never, "/rest/api/3/field")).rejects.toThrow(/Unsupported method/);
  for (const path of ["/wiki/rest/api/content", "/rest/../secure", "/rest/api/3/field?x=1"]) {
    await expect(client.requestJson("POST", path)).rejects.toThrow(/REST path must start with/);
  }
});
