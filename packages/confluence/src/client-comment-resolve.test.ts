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

type Call = { method: string; path: string; body?: Record<string, unknown> };

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

/** Fake inline-comment endpoint: PUT changes the state only when the body carries `resolved: true`. */
function fakeInlineComment(calls: Call[]) {
  let resolutionStatus = "open";
  let version = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (method === "PUT") {
      // Confluence Cloud ignores unknown fields such as `resolutionStatus`.
      if (body?.resolved === true) resolutionStatus = "resolved";
      version += 1;
    }
    return json({
      id: "77",
      resolutionStatus,
      version: { number: version },
      body: { storage: { value: "<p>Bitte ändern</p>" } },
    });
  }) as typeof fetch;
}

// Live bug (Confluence Cloud, 27.10.2026): PUT with `resolutionStatus: "resolved"`
// returned 200 and the CLI reported success, but the comment stayed open.
test("resolveComment resolves an inline comment with `resolved: true`", async () => {
  const calls: Call[] = [];
  fakeInlineComment(calls);

  await new ConfluenceClient(profile).resolveComment("77", "inline");

  const put = calls.find((c) => c.method === "PUT");
  expect(put?.path).toBe("/wiki/api/v2/inline-comments/77");
  expect(put?.body).toMatchObject({
    version: { number: 2 },
    body: { representation: "storage", value: "<p>Bitte ändern</p>" },
    resolved: true,
  });
});

test("resolveComment fails when Confluence still reports the comment as open", async () => {
  globalThis.fetch = (async () =>
    json({ id: "77", resolutionStatus: "open", version: { number: 1 }, body: { storage: { value: "" } } })) as unknown as typeof fetch;

  await expect(new ConfluenceClient(profile).resolveComment("77", "inline")).rejects.toThrow(/still open/);
});

test("resolveComment rejects footer comments without writing", async () => {
  const calls: Call[] = [];
  fakeInlineComment(calls);

  await expect(new ConfluenceClient(profile).resolveComment("77", "footer")).rejects.toThrow(/footer comments/i);
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
});

test("reopenComment sends `resolved: false` and checks the comment is open again", async () => {
  const calls: Call[] = [];
  let resolutionStatus = "resolved";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: new URL(String(input)).pathname, ...(body ? { body } : {}) });
    if (method === "PUT" && body?.resolved === false) resolutionStatus = "reopened";
    return json({ id: "77", resolutionStatus, version: { number: 2 }, body: { storage: { value: "<p>x</p>" } } });
  }) as typeof fetch;

  await new ConfluenceClient(profile).reopenComment("77");
  expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ version: { number: 3 }, resolved: false });
});
