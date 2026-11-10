import { afterAll, beforeAll, expect, it } from "bun:test";
import { ConfluenceClient } from "./client.js";

// Folder discovery runs on every poll. It used to walk direct-children from the
// root pages and descend only into folders, so a folder below a sub-page or at
// space root was never found and the poller never reported changes for it. A
// failed fetch silently dropped a folder, which the poller reports as deleted.

// A 500 is retried with backoff; skip the waits.
const retrySchedulerHook = Symbol.for("atlcli.confluence.retry-scheduler.test-hook");
const host = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalScheduler = host[retrySchedulerHook];
beforeAll(() => { host[retrySchedulerHook] = async () => {}; });
afterAll(() => {
  if (originalScheduler) host[retrySchedulerHook] = originalScheduler;
  else delete host[retrySchedulerHook];
});

function client(port: number, deploymentType: "cloud" | "data-center" = "cloud"): ConfluenceClient {
  return new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${port}`,
    deploymentType, auth: { type: "apiToken", email: "fixture@example.com", token: "fixture" } });
}

/**
 * Space DOCSY: page 10 > page 11 > folder f1 > folder f2; folder f3 at space
 * root. The search is served in two pages to prove the next link is followed.
 */
const FOLDERS = [
  { id: "f1", title: "One", ancestors: ["10", "11"] },
  { id: "f2", title: "Two", ancestors: ["10", "11", "f1"] },
  { id: "f3", title: "Three", ancestors: [] },
];

function serve(fail: Record<string, number> = {}) {
  const calls: string[] = [];
  const cqls: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/wiki/, "");
    calls.push(path);
    if (fail[path]) return new Response("boom", { status: fail[path] });
    if (path === "/rest/api/content/search") {
      const cql = url.searchParams.get("cql") ?? "";
      if (!url.searchParams.has("cursor")) cqls.push(cql);
      const ancestor = /^ancestor="([^"]+)" AND type=folder$/.exec(cql)?.[1];
      if (!ancestor && cql !== 'space="DOCSY" AND type=folder') return new Response("bad cql " + cql, { status: 400 });
      const matches = FOLDERS.filter((f) => !ancestor || f.ancestors.includes(ancestor));
      const page = url.searchParams.has("cursor") ? matches.slice(1) : matches.slice(0, 1);
      return Response.json({
        results: page.map((f) => ({ id: f.id, type: "folder", title: f.title, space: { id: 1, key: "DOCSY" },
          ancestors: f.ancestors.map((id) => ({ id })) })),
        _links: !url.searchParams.has("cursor") && matches.length > 1
          ? { next: `/rest/api/content/search?cql=${encodeURIComponent(cql)}&cursor=2` } : {},
      });
    }
    const version = /^\/rest\/api\/content\/(f\d)$/.exec(path);
    if (version) return Response.json({ id: version[1], version: { number: 4 } });
    return new Response("unexpected " + path, { status: 404 });
  } });
  return { server, calls, cqls };
}

it("getSpaceFolders finds folders under a sub-page, inside a folder and at space root, without walking the tree", async () => {
  const { server, calls, cqls } = serve();
  try {
    const folders = await client(server.port!).getSpaceFolders("DOCSY");
    expect(folders.map((f) => [f.id, f.title, f.parentId, f.spaceId])).toEqual([
      ["f1", "One", "11", "1"],
      ["f2", "Two", "f1", "1"],
      ["f3", "Three", null, "1"],
    ]);
    expect(cqls).toEqual(['space="DOCSY" AND type=folder']);
    expect(calls).toEqual(["/rest/api/content/search", "/rest/api/content/search"]);
  } finally { server.stop(true); }
});

it("getFoldersInTree finds every folder below the ancestor, also below a sub-page", async () => {
  const { server, cqls } = serve();
  try {
    expect((await client(server.port!).getFoldersInTree("10")).map((f) => f.id)).toEqual(["f1", "f2"]);
    expect((await client(server.port!).getFoldersInTree("f1")).map((f) => f.id)).toEqual(["f2"]);
    expect(cqls).toEqual(['ancestor="10" AND type=folder', 'ancestor="f1" AND type=folder']);
  } finally { server.stop(true); }
});

it("folder listings are empty on Data Center, which has no folders, without a request", async () => {
  const { server, calls } = serve();
  try {
    const dc = client(server.port!, "data-center");
    expect(await dc.getSpaceFolders("DOCSY")).toEqual([]);
    expect(await dc.getFoldersInTree("10")).toEqual([]);
    expect(await dc.getAllFoldersWithVersions({ scope: { type: "space", spaceKey: "DOCSY" } })).toEqual([]);
    expect(calls).toEqual([]);
  } finally { server.stop(true); }
});

it("getAllFoldersWithVersions returns every folder with its version", async () => {
  const { server } = serve();
  try {
    expect(await client(server.port!).getAllFoldersWithVersions({ scope: { type: "space", spaceKey: "DOCSY" } })).toEqual([
      { id: "f1", title: "One", version: 4 },
      { id: "f2", title: "Two", version: 4 },
      { id: "f3", title: "Three", version: 4 },
    ]);
    expect(await client(server.port!).getAllFoldersWithVersions({ scope: { type: "page", pageId: "10" } })).toEqual([]);
  } finally { server.stop(true); }
});

it("a folder deleted meanwhile (404) is left out", async () => {
  const { server } = serve({ "/rest/api/content/f2": 404 });
  try {
    const folders = await client(server.port!).getAllFoldersWithVersions({ scope: { type: "tree", ancestorId: "10" } });
    expect(folders.map((f) => f.id)).toEqual(["f1"]);
    const space = await client(server.port!).getAllFoldersWithVersions({ scope: { type: "space", spaceKey: "DOCSY" } });
    expect(space.map((f) => f.id)).toEqual(["f1", "f3"]);
  } finally { server.stop(true); }
});

// A swallowed failure made the folder vanish from the listing, and the poller
// turned that into a `deleted` event.
for (const [path, status] of [["/rest/api/content/search", 500], ["/rest/api/content/f2", 500], ["/rest/api/content/f2", 403]] as const) {
  it(`a ${status} on ${path} fails the folder listing instead of dropping folders`, async () => {
    const { server } = serve({ [path]: status });
    try {
      await expect(client(server.port!).getAllFoldersWithVersions({ scope: { type: "tree", ancestorId: "10" } }))
        .rejects.toThrow(String(status));
    } finally { server.stop(true); }
  });
}

it("getAllFoldersWithVersions takes the version from the search and sends no per-folder request", async () => {
  const server = Bun.serve({ port: 0, fetch: (req) => {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/rest/api/content/search")) return new Response("unexpected " + url.pathname, { status: 500 });
    expect(url.searchParams.get("expand")).toContain("version");
    return Response.json({ results: [{ id: "f9", type: "folder", title: "Nine", version: { number: 7 }, ancestors: [] }], _links: {} });
  } });
  try {
    expect(await client(server.port!).getAllFoldersWithVersions({ scope: { type: "space", spaceKey: "DOCSY" } }))
      .toEqual([{ id: "f9", title: "Nine", version: 7 }]);
  } finally {
    server.stop(true);
  }
});
