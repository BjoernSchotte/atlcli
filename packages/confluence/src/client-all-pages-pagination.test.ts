import { expect, it } from "bun:test";
import { ConfluenceClient } from "./client.js";

// A short page that still carries `_links.next` is not the last page. The
// poller treats pages missing from getAllPages() as deleted, so stopping on
// `results.length < limit` dropped live pages.

function client(port: number): ConfluenceClient {
  return new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${port}`,
    deploymentType: "cloud", auth: { type: "apiToken", email: "fixture@example.com", token: "fixture" } });
}

it("getAllPages (space scope) follows the next link after a short page", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/space/DOCSY")) return Response.json({ id: "1", key: "DOCSY", name: "Docs" });
    if (!url.pathname.endsWith("/api/v2/spaces/1/pages")) return new Response("unexpected", { status: 404 });
    const second = url.searchParams.get("cursor") === "next";
    return Response.json({
      results: [{ id: second ? "101" : "100", title: "P", version: { number: 2, createdAt: "2026-01-01T00:00:00Z" } }],
      _links: second ? {} : { next: "/wiki/api/v2/spaces/1/pages?cursor=next" },
    });
  } });
  try {
    const pages = await client(server.port!).getAllPages({ scope: { type: "space", spaceKey: "DOCSY" }, limit: 100 });
    expect(pages.map((page) => page.id)).toEqual(["100", "101"]);
    expect(pages.every((page) => page.spaceKey === "DOCSY" && page.version === 2)).toBe(true);
  } finally { server.stop(true); }
});

it("getAllPages (tree scope) follows the next link after a short page", async () => {
  const cqls: (string | null)[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/rest/api/content/search")) return new Response("unexpected", { status: 404 });
    const second = url.searchParams.get("cursor") === "next";
    if (!second) cqls.push(url.searchParams.get("cql"));
    return Response.json({
      results: [{ id: second ? "201" : "200", title: "P", version: { number: 3 }, space: { key: "DOCSY" } }],
      _links: second ? {} : { next: "/rest/api/content/search?cursor=next&limit=100" },
    });
  } });
  try {
    const pages = await client(server.port!).getAllPages({ scope: { type: "tree", ancestorId: "42" }, limit: 100 });
    expect(pages.map((page) => [page.id, page.version, page.spaceKey])).toEqual([["200", 3, "DOCSY"], ["201", 3, "DOCSY"]]);
    expect(cqls).toEqual(["ancestor=42 AND type=page"]);
  } finally { server.stop(true); }
});
