import { expect, it } from "bun:test";
import { ConfluenceClient } from "./client.js";

// getSpaceFolders runs on every poll. It used to drain a CQL search of every
// page in the space just to find the homepage, which is normally the first hit.

function client(port: number): ConfluenceClient {
  return new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${port}`,
    deploymentType: "cloud", auth: { type: "apiToken", email: "fixture@example.com", token: "fixture" } });
}

function serve(rootId: string) {
  const calls = { search: 0, page: [] as string[] };
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/rest/api/content/search")) {
      calls.search += 1;
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const results = Array.from({ length: 50 }, (_, i) => ({ id: String(start + i), title: "P", version: { number: 1 } }));
      // 150 pages in the space, always with a live next link until the end.
      return Response.json({ results, _links: start < 100 ? { next: `/rest/api/content/search?cursor=${start + 50}` } : {} });
    }
    const page = /\/content\/(\d+)$/.exec(url.pathname);
    if (page) {
      calls.page.push(page[1]!);
      return Response.json({ id: page[1], title: "P", version: { number: 1 }, space: { key: "DOCSY" },
        ancestors: page[1] === rootId ? [] : [{ id: rootId }], body: { storage: { value: "" } } });
    }
    if (url.pathname.endsWith("/direct-children")) return Response.json({ results: [] });
    return new Response("unexpected " + url.pathname, { status: 404 });
  } });
  return { server, calls };
}

it("getSpaceFolders finds the homepage from the first search batch", async () => {
  const { server, calls } = serve("0");
  try {
    expect(await client(server.port!).getSpaceFolders("DOCSY")).toEqual([]);
    expect(calls.search).toBe(1);
    expect(calls.page).toEqual(["0"]);
  } finally { server.stop(true); }
});

it("getSpaceFolders still finds a homepage beyond the first batch", async () => {
  const { server, calls } = serve("60");
  try {
    expect(await client(server.port!).getSpaceFolders("DOCSY")).toEqual([]);
    // Pages 0..49 from the first batch, then 50..60 from the full drain.
    expect(calls.page).toEqual(Array.from({ length: 61 }, (_, i) => String(i)));
  } finally { server.stop(true); }
});
