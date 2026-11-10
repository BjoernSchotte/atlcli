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

// Cloud emits site-relative next links (`/wiki/rest/api/...`) as well as
// product-relative ones. Stripping only a leading `/rest/api` requested
// `/wiki/rest/api/wiki/rest/api/...` and lost every page after the first.
it("v1 listings follow a site-relative /wiki/rest/api next link", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    paths.push(url.pathname);
    const second = url.searchParams.get("cursor") === "next";
    const next = (path: string) => (second ? {} : { next: `/wiki/rest/api${path}?cursor=next` });
    if (url.pathname === "/wiki/rest/api/content/search") {
      return Response.json({ results: [{ id: second ? "2" : "1", title: "P", version: { number: 1 } }], _links: next("/content/search") });
    }
    if (url.pathname === "/wiki/rest/api/content") {
      return Response.json({ results: [{ id: second ? "4" : "3", title: "T" }], _links: next("/content") });
    }
    if (url.pathname === "/wiki/rest/api/content/9/child/page") {
      return Response.json({ results: [{ id: second ? "6" : "5", title: "C" }], _links: next("/content/9/child/page") });
    }
    return new Response("unexpected " + url.pathname, { status: 404 });
  } });
  try {
    const c = client(server.port!);
    expect((await c.getAllPages({ scope: { type: "tree", ancestorId: "42" } })).map((page) => page.id)).toEqual(["1", "2"]);
    expect((await c.findPagesByTitle("T")).map((page) => page.id)).toEqual(["3", "4"]);
    expect((await c.getChildrenWithPosition("9")).map((page) => page.id)).toEqual(["5", "6"]);
    expect(paths.filter((path) => path.includes("/rest/api/wiki"))).toEqual([]);
  } finally { server.stop(true); }
});

it("a next link outside the configured REST API is refused", async () => {
  const server = Bun.serve({ port: 0, fetch: () =>
    Response.json({ results: [], _links: { next: "https://other.example/wiki/rest/api/content/search?cursor=x" } }) });
  try {
    await expect(client(server.port!).getAllPages({ scope: { type: "tree", ancestorId: "42" } }))
      .rejects.toThrow("outside the configured REST API");
  } finally { server.stop(true); }
});
