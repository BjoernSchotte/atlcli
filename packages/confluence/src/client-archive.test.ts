import { afterEach, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const profile: Profile = {
  name: "synthetic-cloud",
  baseUrl: "https://example.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "fixture@example.invalid", token: "fixture-token" },
};

// Cloud accepts a content PUT with status "archived" and leaves the page
// current; archiving is POST /content/archive (seen live in DOCSY).
test("archivePage posts to /content/archive, never PUTs the page", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "POST") return new Response(JSON.stringify({ id: "task-1" }), { status: 202, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({ id: "42", title: "Old page", version: { number: 3 }, space: { key: "TEST" }, ancestors: [], body: { storage: { value: "" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const page = await new ConfluenceClient(profile).archivePage("42");
  expect(page).toMatchObject({ id: "42", title: "Old page", spaceKey: "TEST" });
  expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "POST", path: "/wiki/rest/api/content/archive", body: { pages: [{ id: "42" }] } }]);
});
