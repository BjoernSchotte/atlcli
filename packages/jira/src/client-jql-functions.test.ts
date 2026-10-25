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
  delete process.env.ATLCLI_JQL_FUNCTIONS;
});

/** Records the JQL of every /search/jql POST; inner query "project = A" has A-1. */
function recordSearches(): string[] {
  const sent: string[] = [];
  globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body.jql);
    const issues = body.jql === "project = A" ? [{ id: "1", key: "A-1", fields: {} }] : [];
    const next = body.jql !== "project = A" && !body.nextPageToken ? { nextPageToken: "p2" } : {};
    return new Response(JSON.stringify({ issues, ...next }), { status: 200 });
  }) as unknown as typeof fetch;
  return sent;
}

test("search expands atlcli JQL functions once, also across pages", async () => {
  const sent = recordSearches();
  const client = new JiraClient(profile);
  const jql = `issue in subtasksOf("project = A") ORDER BY key`;
  const first = await client.search(jql);
  await client.search(jql, { nextPageToken: first.nextPageToken });
  expect(sent).toEqual(["project = A", "parent IN (A-1) ORDER BY key", "parent IN (A-1) ORDER BY key"]);
});

test("jqlFunctions: false and ATLCLI_JQL_FUNCTIONS=off send JQL unchanged", async () => {
  const sent = recordSearches();
  const jql = `issue in subtasksOf("project = A")`;
  await new JiraClient(profile, { jqlFunctions: false }).search(jql);
  process.env.ATLCLI_JQL_FUNCTIONS = "off";
  await new JiraClient(profile).search(jql);
  expect(sent).toEqual([jql, jql]);
});
