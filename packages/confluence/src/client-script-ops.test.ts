import { afterEach, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cloud: Profile = {
  name: "synthetic-cloud",
  baseUrl: "https://example.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "fixture@example.invalid", token: "fixture-token" },
};
const dc: Profile = { ...cloud, name: "synthetic-dc", baseUrl: "https://wiki.example.invalid/confluence", deploymentType: "data-center" };

type Call = { method: string; path: string; query: string; body?: unknown };
function stub(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, query: url.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return calls;
}

test("listPageProperties follows the v2 cursor on Cloud", async () => {
  const calls = stub((c) =>
    c.query.includes("cursor=")
      ? Response.json({ results: [{ key: "b", value: 2 }], _links: {} })
      : Response.json({ results: [{ key: "a", value: { x: 1 } }], _links: { next: "/wiki/api/v2/pages/42/properties?cursor=abc&limit=250" } }),
  );
  expect(await new ConfluenceClient(cloud).listPageProperties("42")).toEqual({ a: { x: 1 }, b: 2 });
  expect(calls.map((c) => c.path)).toEqual(["/wiki/api/v2/pages/42/properties", "/wiki/api/v2/pages/42/properties"]);
  expect(calls[1]!.query).toContain("cursor=abc");
});

test("listPageProperties uses v1 on Data Center", async () => {
  const calls = stub(() => Response.json({ results: [{ key: "k", value: "v" }], _links: {} }));
  expect(await new ConfluenceClient(dc).listPageProperties("42")).toEqual({ k: "v" });
  expect(calls[0]!.path).toBe("/confluence/rest/api/content/42/property");
});

test("deletePageProperty deletes by id on Cloud and skips an absent key", async () => {
  let present = true;
  const calls = stub((c) => {
    if (c.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ results: present ? [{ id: "9", key: "k", value: 1, version: { number: 2 } }] : [] });
  });
  const client = new ConfluenceClient(cloud);
  await client.deletePageProperty("42", "k");
  present = false;
  await client.deletePageProperty("42", "k");
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/wiki/api/v2/pages/42/properties/9"]);
});

test("createBlogPost posts a blogpost in storage format", async () => {
  const calls = stub(() => Response.json({ id: "77", version: { number: 1 } }));
  expect(await new ConfluenceClient(cloud).createBlogPost({ spaceKey: "DOCSY", title: "News", storage: "<p>Hi</p>" })).toEqual({ id: "77", version: 1 });
  expect(calls[0]).toMatchObject({
    method: "POST",
    path: "/wiki/rest/api/content",
    body: { type: "blogpost", title: "News", space: { key: "DOCSY" }, body: { storage: { value: "<p>Hi</p>", representation: "storage" } } },
  });
});

test("listSpaces pages with start and filters by type", async () => {
  const calls = stub(() => Response.json({ results: [{ id: 1, key: "A", name: "A", type: "global" }] }));
  await new ConfluenceClient(cloud).listSpaces(50, { start: 100, type: "global" });
  expect(calls[0]!.query).toBe("?limit=50&start=100&type=global");
});

test("requestJson writes v1 and v2 paths and refuses others", async () => {
  const calls = stub((c) => (c.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "5" })));
  const client = new ConfluenceClient(cloud);
  expect(await client.requestJson("POST", "/rest/api/content/42/label", { body: [{ name: "x" }] })).toEqual({ id: "5" });
  await client.requestJson("DELETE", "/api/v2/pages/42/properties/9");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /wiki/rest/api/content/42/label", "DELETE /wiki/api/v2/pages/42/properties/9"]);
  await expect(client.requestJson("POST", "/rest/../x")).rejects.toThrow(/REST path must start with/);
  await expect(client.requestJson("GET" as never, "/rest/api/space")).rejects.toThrow(/Unsupported method/);
});
