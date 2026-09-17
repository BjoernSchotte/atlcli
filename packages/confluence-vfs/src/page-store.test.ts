import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeMarkdown,
  parseFrontmatter,
  storageToMarkdown,
} from "@atlcli/confluence/internal";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { PageStore, parseVfsFrontmatter, toStorage } from "./page-store.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

let root: string;
let clock: number;

function seeded(pages = 3): FakeConfluenceClient {
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>Home page.</p>" });
  for (let i = 0; i < pages; i++) {
    client.seedPage({
      id: String(200 + i),
      title: `Page ${i}`,
      spaceKey: "DOCSY",
      parentId: "100",
      position: i,
      storage: `<h1>Page ${i}</h1><p>Body of page ${i} mentioning Kubernetes.</p>`,
    });
  }
  return client;
}

async function openVfs(
  client: FakeConfluenceClient,
  overrides: Record<string, unknown> = {},
): Promise<ConfluenceVfsImpl> {
  return ConfluenceVfsImpl.open({
    profile: "mayflower",
    client,
    mode: "ro",
    allowDelete: false,
    cacheDir: root,
    offline: false,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-store-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readFile", () => {
  it("converts storage to Markdown and prepends the frontmatter", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const text = await vfs.readFile("/DOCSY/page-0-200.md");

    expect(text).toStartWith("---\natlcli:\n");
    expect(text).toContain('  id: "200"');
    expect(text).toContain('  title: "Page 0"');
    expect(text).toContain("  version: 1");
    expect(text).toContain('  url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/200"');
    expect(text).toContain("# Page 0");
    expect(text).toContain("Kubernetes");
    await vfs.close();
  });

  it("writes frontmatter the rest of the repository can still read", async () => {
    const vfs = await openVfs(seeded());
    const text = await vfs.readFile("/DOCSY/page-0-200.md");
    // `docs pull` and `docs push` parse this block; the VFS's extra keys must
    // not break them, or a file could not move between the two.
    expect(parseFrontmatter(text).frontmatter?.id).toBe("200");
    expect(parseVfsFrontmatter(text).frontmatter.version).toBe(1);
    await vfs.close();
  });

  it("survives a title carrying a colon, a quote and a hash", async () => {
    const client = new FakeConfluenceClient()
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>h</p>" })
      .seedPage({
        id: "201",
        title: 'Release: "2026" #1',
        spaceKey: "DOCSY",
        parentId: "100",
        position: 1,
        storage: "<p>body</p>",
      });
    const vfs = await openVfs(client);
    const names = (await vfs.readdir("/DOCSY")).map((e) => e.name);
    const entry = names.find((n) => n.endsWith("-201"))!;
    const text = await vfs.readFile(`/DOCSY/${entry}.md`);
    expect(parseVfsFrontmatter(text).frontmatter.title).toBe('Release: "2026" #1');
    await vfs.close();
  });

  it("reads the space home page through _index.md", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readFile("/DOCSY/_index.md")).toContain("Home page.");
    await vfs.close();
  });

  it("serves a second read from the cache", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readFile("/DOCSY/page-0-200.md");
    client.resetCalls();
    await vfs.readFile("/DOCSY/page-0-200.md");
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("refetches once the server version moves on", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readFile("/DOCSY/page-0-200.md");

    client.bumpVersion("200", "<p>Edited elsewhere.</p>");
    clock += 60_001;
    await vfs.index.revalidate("100");
    client.resetCalls();

    const text = await vfs.readFile("/DOCSY/page-0-200.md");
    expect(text).toContain("Edited elsewhere.");
    expect(client.callsTo("getPage")).toBe(1);
    await vfs.close();
  });

  it("answers EISDIR for a directory", async () => {
    const vfs = await openVfs(seeded());
    await expect(vfs.readFile("/DOCSY/page-0-200")).rejects.toMatchObject({ code: "EISDIR" });
    await vfs.close();
  });

  it("renders a whiteboard as a read-only link stub", async () => {
    const client = seeded().seedPage({
      id: "300",
      title: "Roadmap",
      spaceKey: "DOCSY",
      parentId: "100",
      type: "whiteboard",
      position: 9,
    });
    const vfs = await openVfs(client);
    const json = JSON.parse(await vfs.readFile("/DOCSY/roadmap-300.whiteboard.json"));
    expect(json.type).toBe("whiteboard");
    expect(json.url).toContain("/whiteboards/300");
    // No body fetch: there is no body to fetch.
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("reads a historic version and caches it forever", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await client.updatePage({ id: "200", title: "Page 0", storage: "<p>v2</p>", version: 2 });

    const v1 = await vfs.readFile("/DOCSY/page-0-200/.versions/1.md");
    expect(v1).toContain("Body of page 0");
    expect(parseVfsFrontmatter(v1).frontmatter.parentId).toBeUndefined();
    expect(parseVfsFrontmatter(v1).frontmatter.url).toBeUndefined();
    client.resetCalls();
    await vfs.readFile("/DOCSY/page-0-200/.versions/1.md");
    expect(client.callsTo("getPageAtVersion")).toBe(0);
    await vfs.close();
  });

  it("does not serve a historical rendering as the current editable document", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    try {
      const version = await vfs.readFile("/DOCSY/page-0-200/.versions/1.md");
      expect(parseVfsFrontmatter(version).frontmatter.parentId).toBeUndefined();
      const current = await vfs.readFile("/DOCSY/page-0-200/_index.md");
      expect(parseVfsFrontmatter(current).frontmatter.parentId).toBe("100");
      expect(parseVfsFrontmatter(current).frontmatter.url).toContain("/spaces/DOCSY/pages/200");
      expect(client.callsTo("getPageAtVersion")).toBe(1);
      expect(client.callsTo("getPage")).toBe(1);
    } finally { await vfs.close(); }
  });
});

describe("the cache is per profile and account", () => {
  it("gives a second profile nothing from the first profile's cache", async () => {
    const client = seeded();
    const a = await openVfs(client, { profile: "alice" });
    await a.readFile("/DOCSY/page-0-200.md");
    await a.close();

    // Same cacheDir, same site, different profile: a cold cache.
    const b = await openVfs(client, { profile: "bob" });
    client.resetCalls();
    await b.readFile("/DOCSY/page-0-200.md");
    expect(client.callsTo("getPage")).toBe(1);
    await b.close();
  });

  it("gives a second account nothing from the first account's cache", async () => {
    const alice = seeded();
    const a = await openVfs(alice);
    await a.readFile("/DOCSY/page-0-200.md");
    await a.close();

    const bobClient = seeded();
    const bob = await ConfluenceVfsImpl.open({
      profile: "mayflower",
      client: new (class extends FakeConfluenceClient {
        override async getCurrentUser() {
          return { accountId: "acct-bob", displayName: "Bob" };
        }
      })().seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" }),
      mode: "ro",
      allowDelete: false,
      cacheDir: root,
      offline: false,
      now: () => clock,
    });
    expect(bob.runtime?.dbPath).not.toBe(a.runtime?.dbPath);
    await bob.close();
    void bobClient;
  });
});

describe("prefetch", () => {
  it("keeps the fetched version timestamp in the index and cached Markdown", async () => {
    const client = seeded(1);
    const vfs = await openVfs(client);
    try {
      await vfs.readdir("/DOCSY");
      client.bumpVersion("200", "<p>External update</p>");
      const modified = (await client.getPageVersions(["200"])).get("200")!.lastModified!;
      await vfs.prefetch(["200"]);
      expect(vfs.index.node("200")?.lastModified).toBe(modified);
      expect(parseVfsFrontmatter(await vfs.readFile("/DOCSY/page-0-200.md")).frontmatter.lastModified).toBe(modified);
      expect(client.callsTo("getPage")).toBe(0);
    } finally { await vfs.close(); }
  });

  function storeFor(vfs: ConfluenceVfsImpl, client: FakeConfluenceClient): PageStore {
    return new PageStore({ client, cache: vfs.cache!, index: vfs.index,
      instanceUrl: "https://example.atlassian.net/wiki", offline: false,
      concurrency: 8, prefetchMaxPages: 300,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
  }

  it("bounds cold downloads even when prefetched bodies do not fit in the cache", async () => {
    const client = seeded(2);
    const vfs = await openVfs(client, { cacheMaxMb: 0.0001 });
    await vfs.readdir("/DOCSY");
    const store = storeFor(vfs, client);
    await store.withBodyBudget(2, async () => {
      expect(await store.prefetchBodies(["200", "201"])).toEqual({ fetched: 2, fromCache: 0 });
      await expect(store.readBody(vfs.index.node("200")!, "/DOCSY/page-0-200.md")).rejects.toThrow(/cold page bodies.*cacheMaxMb/);
    });
    expect(client.callsTo("getPagesBulk")).toBe(1);
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("keeps concurrent operations' download budgets independent", async () => {
    const client = seeded(2);
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    const store = storeFor(vfs, client);
    await Promise.all([
      store.withBodyBudget(0, async () => {
        await Promise.resolve();
        await expect(store.readBody(vfs.index.node("200")!, "/DOCSY/page-0-200.md")).rejects.toThrow(/prefetch limit/);
      }),
      store.withBodyBudget(1, async () => {
        await Promise.resolve();
        expect(await store.readBody(vfs.index.node("201")!, "/DOCSY/page-1-201.md")).toContain("Body of page 1");
      }),
    ]);
    expect(client.calls.filter((call) => call.method === "getPage").map((call) => call.arg)).toEqual(["201"]);
    // The context ends with the operation; ordinary reads remain available.
    expect(await store.readBody(vfs.index.node("200")!, "/DOCSY/page-0-200.md")).toContain("Body of page 0");
    await vfs.close();
  });

  it("counts historic reads and Data Center downloads once", async () => {
    const client = new FakeConfluenceClient({ deploymentType: "data-center" })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>old</p>" });
    const vfs = await openVfs(client);
    await vfs.index.getHomepageId("DOCSY");
    client.bumpVersion("100", "<p>new</p>");
    const store = storeFor(vfs, client);
    await store.withBodyBudget(1, async () => {
      expect(await store.prefetchBodies(["100"])).toEqual({ fetched: 1, fromCache: 0 });
      await expect(store.readVersion(vfs.index.node("100")!, 1, "/DOCSY/.versions/1.md")).rejects.toThrow(/prefetch limit/);
    });
    expect(client.callsTo("getPage")).toBe(1);
    expect(client.callsTo("getPageAtVersion")).toBe(0);
    await vfs.close();
  });

  it("does not redownload unchanged bodies, and refreshes only changed versions after TTL", async () => {
    const client = seeded(2);
    const vfs = await openVfs(client);
    await vfs.index.getHomepageId("DOCSY");
    const ids = ["100", ...(await vfs.index.loadSubtree("100")).map((node) => node.id)];
    expect(await vfs.prefetch(ids)).toEqual({ fetched: 3, fromCache: 0 });
    client.resetCalls();
    await vfs.index.loadSubtree("100");
    expect(await vfs.prefetch(ids)).toEqual({ fetched: 0, fromCache: 3 });
    expect(client.callsTo("getPagesBulk")).toBe(0);
    client.bumpVersion("100", "<p>Changed home.</p>");
    client.bumpVersion("200", "<p>Changed child.</p>");
    clock += 60_001;
    await vfs.index.loadSubtree("100");
    expect(await vfs.prefetch(ids)).toEqual({ fetched: 2, fromCache: 1 });
    expect(await vfs.readFile("/DOCSY/_index.md")).toContain("Changed home.");
    expect(await vfs.readFile("/DOCSY/page-0-200.md")).toContain("Changed child.");
    expect(client.callsTo("getPagesBulk")).toBe(1);
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("fills the real parent when prefetching a search-seeded node", async () => {
    const client = seeded(1);
    const vfs = await openVfs(client);
    try {
      vfs.index.upsert({ id: "200", title: "Page 0", type: "page", spaceKey: "DOCSY", version: 1 });
      expect(await vfs.prefetch(["200"])).toEqual({ fetched: 1, fromCache: 0 });
      expect(await vfs.readFile("/DOCSY/.by-id/200.md")).toContain('parentId: "100"');
      expect(vfs.index.node("200")?.parentId).toBe("100");
      expect(client.callsTo("getPage")).toBe(0);
      expect(client.callsTo("getPageDirectChildren")).toBe(0);
    } finally { await vfs.close(); }
  });

  it("fails explicitly if the bulk endpoint omits a requested body", async () => {
    const client = seeded(2);
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    client.hiddenIds.add("201");
    await expect(vfs.prefetch(["200", "201"])).rejects.toThrow(/Bulk fetch omitted 1 requested page bodies/);
    client.hiddenIds.delete("201");
    // An incomplete response was not accepted as a successful cache fill.
    expect(await vfs.prefetch(["200", "201"])).toEqual({ fetched: 2, fromCache: 0 });
    await vfs.close();
  });

  it("refreshes a stale Data Center root without Cloud endpoints or repeated warm downloads", async () => {
    const client = new FakeConfluenceClient({ deploymentType: "data-center" })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>old</p>" });
    const vfs = await openVfs(client);
    await vfs.index.getHomepageId("DOCSY");
    await vfs.index.loadSubtree("100");
    await vfs.prefetch(["100"]);
    client.bumpVersion("100", "<p>new</p>");
    clock += 60_001;
    await vfs.index.loadSubtree("100");
    expect(await vfs.prefetch(["100"])).toEqual({ fetched: 1, fromCache: 0 });
    expect(await vfs.readFile("/DOCSY/_index.md")).toContain("new");
    client.resetCalls();
    await vfs.index.loadSubtree("100");
    expect(await vfs.prefetch(["100"])).toEqual({ fetched: 0, fromCache: 1 });
    expect(client.requestCount).toBe(0);
    await vfs.close();
  });

  it("fills many bodies in one bulk request", async () => {
    const client = seeded(10);
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    client.resetCalls();

    const ids = Array.from({ length: 10 }, (_, i) => String(200 + i));
    const result = await vfs.prefetch(ids, { reason: "grep" });

    expect(result.fetched).toBe(10);
    expect(client.callsTo("getPagesBulk")).toBe(1);
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("serves the cached ones without asking for them again", async () => {
    const client = seeded(5);
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readFile("/DOCSY/page-0-200.md");
    client.resetCalls();

    const result = await vfs.prefetch(["200", "201", "202"]);
    expect(result.fromCache).toBe(1);
    expect(result.fetched).toBe(2);
    await vfs.close();
  });

  it("aborts over the budget without downloading anything", async () => {
    const client = seeded(10);
    const vfs = await openVfs(client, { prefetchMaxPages: 4 });
    await vfs.readdir("/DOCSY");
    client.resetCalls();

    const ids = Array.from({ length: 10 }, (_, i) => String(200 + i));
    await expect(vfs.prefetch(ids, { reason: "grep -r" })).rejects.toMatchObject({
      code: "EINVAL",
    });
    // Nothing partial: the budget is checked before the first request.
    expect(client.callsTo("getPagesBulk")).toBe(0);
    await vfs.close();
  });

  it("names the count, the limit and the flag that raises it", async () => {
    const client = seeded(10);
    const vfs = await openVfs(client, { prefetchMaxPages: 4 });
    await vfs.readdir("/DOCSY");
    const ids = Array.from({ length: 10 }, (_, i) => String(200 + i));
    await expect(vfs.prefetch(ids, { reason: "grep -r" })).rejects.toThrow(
      /10 page bodies.*4-page prefetch limit.*--prefetch-max/s,
    );
    await vfs.close();
  });

  it("accepts a raised budget for the same call", async () => {
    const client = seeded(10);
    const vfs = await openVfs(client, { prefetchMaxPages: 4 });
    await vfs.readdir("/DOCSY");
    const ids = Array.from({ length: 10 }, (_, i) => String(200 + i));
    const result = await vfs.prefetch(ids, { budget: 50 });
    expect(result.fetched).toBe(10);
    await vfs.close();
  });

  it("falls back to per-page fetches on Data Center", async () => {
    const client = new FakeConfluenceClient({ deploymentType: "data-center" })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>home</p>" })
      .seedPage({ id: "201", title: "One", spaceKey: "DOCSY", parentId: "100", position: 1, storage: "<p>one</p>" })
      .seedPage({ id: "202", title: "Two", spaceKey: "DOCSY", parentId: "100", position: 2, storage: "<p>two</p>" });
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    client.resetCalls();

    const result = await vfs.prefetch(["201", "202"]);
    expect(result.fetched).toBe(2);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    expect(client.callsTo("getPage")).toBe(2);
    await vfs.close();
  });
});

describe("offline", () => {
  it("lists and reads from the persisted cache with no requests at all", async () => {
    const client = seeded(3);
    const warm = await openVfs(client);
    await warm.readdir("/DOCSY");
    await warm.readFile("/DOCSY/page-0-200.md");
    await warm.close();

    const cold = await openVfs(client, { offline: true });
    client.resetCalls();
    const names = (await cold.readdir("/DOCSY")).map((e) => e.name);
    expect(names).toContain("page-0-200");
    expect(await cold.readFile("/DOCSY/page-0-200.md")).toContain("Body of page 0");
    expect(client.requestCount).toBe(0);
    await cold.close();
  });

  it("explains the flag on a body that was never cached", async () => {
    const client = seeded(3);
    const warm = await openVfs(client);
    await warm.readdir("/DOCSY");
    await warm.close();

    const cold = await openVfs(client, { offline: true });
    await expect(cold.readFile("/DOCSY/page-1-201.md")).rejects.toThrow(/--offline/);
    await expect(cold.readFile("/DOCSY/page-1-201.md")).rejects.toMatchObject({ code: "ENOENT" });
    await cold.close();
  });

  it("refuses a prefetch rather than silently returning an empty cache", async () => {
    const client = seeded(3);
    const warm = await openVfs(client);
    await warm.readdir("/DOCSY");
    await warm.close();

    const cold = await openVfs(client, { offline: true });
    await expect(cold.prefetch(["201", "202"])).rejects.toMatchObject({ code: "ENOENT" });
    await cold.close();
  });
});

describe("round trip", () => {
  /**
   * The VFS is only useful for editing if what it hands an agent converts back
   * to the same storage. These cases are the ones `markdown.test.ts` already
   * treats as the load-bearing shapes.
   */
  const shapes: [string, string][] = [
    ["heading and paragraph", "<h1>Title</h1><p>Body text.</p>"],
    ["bullet list", "<ul><li><p>one</p></li><li><p>two</p></li></ul>"],
    ["ordered list", "<ol><li><p>first</p></li><li><p>second</p></li></ol>"],
    ["inline emphasis", "<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>"],
    ["link", '<p><a href="https://example.com">example</a></p>'],
    [
      "table",
      "<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>",
    ],
  ];

  for (const [name, storage] of shapes) {
    it(`preserves ${name} through markdown and back`, async () => {
      const client = new FakeConfluenceClient()
        .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
        .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>h</p>" })
        .seedPage({
          id: "201",
          title: "Shape",
          spaceKey: "DOCSY",
          parentId: "100",
          position: 1,
          storage,
        });
      const vfs = await openVfs(client);
      const markdown = await vfs.readFile("/DOCSY/shape-201.md");
      const { body } = parseVfsFrontmatter(markdown);

      // Frontmatter must never reach Confluence.
      const backToStorage = toStorage(body);
      expect(backToStorage).not.toContain("atlcli:");
      // And converting the round-tripped storage again must be a fixed point.
      expect(normalizeMarkdown(storageToMarkdown(backToStorage))).toBe(
        normalizeMarkdown(storageToMarkdown(storage)),
      );
      await vfs.close();
    });
  }
});

for (const deploymentType of ["cloud", "data-center"] as const) {
it(`revalidates directly reopened cached bodies after the metadata TTL (${deploymentType})`, async () => {
  const client = new FakeConfluenceClient({ deploymentType })
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>Home page.</p>" });
  const vfs = await openVfs(client);
  try {
    const initial = await vfs.readFile("/DOCSY/_index.md");
    await client.updatePage({ id: "100", title: "Docs Home", storage: "<p>Updated Grüße 🐴</p>", version: 2 });
    const calls = client.calls.length;
    expect(await vfs.readFile("/DOCSY/_index.md")).toBe(initial);
    expect(client.calls.length).toBe(calls);
    clock += 60_001;
    const updated = await vfs.readFile("/DOCSY/_index.md");
    expect(updated).toContain("Updated Grüße 🐴");
    expect(updated).toContain("  version: 2");
    const freshCalls = client.calls.length;
    expect(await vfs.readFile("/DOCSY/_index.md")).toBe(updated);
    expect(client.calls.length).toBe(freshCalls);
  } finally { await vfs.close(); }
});
}
