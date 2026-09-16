/**
 * Most of these are request-count assertions rather than output assertions.
 * That is deliberate: the demand principle (plan section 1b) is a statement
 * about what the VFS *does not* fetch, and only a counter can prove it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { FakeConfluenceClient } from "./testing/fake-client.js";
import { TreeIndex, type TreeIndexOptions } from "./tree-index.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function makeIndex(
  client: FakeConfluenceClient,
  overrides: Partial<TreeIndexOptions> = {},
): { index: TreeIndex; advance: (ms: number) => void } {
  let clock = 1_000_000;
  const index = new TreeIndex({
    client,
    ttlMs: 60_000,
    concurrency: 8,
    offline: false,
    logger: silent,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...overrides,
  });
  return { index, advance: (ms) => void (clock += ms) };
}

/** A space of `width` top-level pages, each with `depth` nested children. */
function bigSpace(width: number, depth: number): FakeConfluenceClient {
  const client = new FakeConfluenceClient().seedSpace({
    id: "sp-1",
    key: "DOCSY",
    name: "Docs",
    homepageId: "100",
  });
  client.seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>home</p>" });
  for (let i = 0; i < width; i++) {
    const topId = String(1000 + i);
    client.seedPage({
      id: topId,
      title: `Top ${i}`,
      spaceKey: "DOCSY",
      parentId: "100",
      position: i,
      storage: `<p>top ${i}</p>`,
    });
    let parent = topId;
    for (let d = 0; d < depth; d++) {
      const childId = `${topId}${d}`;
      client.seedPage({
        id: childId,
        title: `Child ${i}-${d}`,
        spaceKey: "DOCSY",
        parentId: parent,
        position: 0,
        storage: `<p>child ${i}-${d}</p>`,
      });
      parent = childId;
    }
  }
  return client;
}

describe("demand principle: one directory, one request", () => {
  let client: FakeConfluenceClient;

  beforeEach(() => {
    client = bigSpace(50, 3);
  });

  it("costs one listing request per directory entered, whatever the space size", async () => {
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    client.resetCalls();

    await index.loadChildren("100");
    await index.loadChildren("1000");
    await index.loadChildren("10000");

    expect(client.callsTo("getPageDirectChildren")).toBe(3);
  });

  it("never fetches a body", async () => {
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("1000");
    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPageAtVersion")).toBe(0);
  });

  it("leaves a sibling branch unloaded", async () => {
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("1000");

    expect(index.isUnloaded("1000")).toBe(false);
    // Every other top-level page was *listed* but never *entered*.
    expect(index.isUnloaded("1001")).toBe(true);
    expect(index.isUnloaded("1049")).toBe(true);
  });

  it("does not grow the request count with space size", async () => {
    const small = bigSpace(3, 1);
    const large = bigSpace(500, 1);
    const a = makeIndex(small).index;
    const b = makeIndex(large).index;
    await a.getHomepageId("DOCSY");
    await b.getHomepageId("DOCSY");
    small.resetCalls();
    large.resetCalls();
    await a.loadChildren("100");
    await b.loadChildren("100");
    expect(small.requestCount).toBe(large.requestCount);
  });
});

describe("loadChildren", () => {
  it("returns children in child position order", async () => {
    const client = new FakeConfluenceClient()
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY" })
      .seedPage({ id: "103", title: "Third", spaceKey: "DOCSY", parentId: "100", position: 3 })
      .seedPage({ id: "101", title: "First", spaceKey: "DOCSY", parentId: "100", position: 1 })
      .seedPage({ id: "102", title: "Second", spaceKey: "DOCSY", parentId: "100", position: 2 });
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");
    expect(children.map((c) => c.title)).toEqual(["First", "Second", "Third"]);
  });

  it("serves a second listing from cache while the TTL holds", async () => {
    const client = bigSpace(3, 1);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.resetCalls();
    await index.loadChildren("100");
    expect(client.requestCount).toBe(0);
  });

  it("refetches once the TTL expires", async () => {
    const client = bigSpace(3, 1);
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.resetCalls();
    advance(60_001);
    await index.loadChildren("100");
    expect(client.callsTo("getPageDirectChildren")).toBe(1);
  });

  it("collapses concurrent listings of the same directory into one request", async () => {
    const client = bigSpace(3, 1);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    client.resetCalls();
    await Promise.all([
      index.loadChildren("100"),
      index.loadChildren("100"),
      index.loadChildren("100"),
    ]);
    expect(client.callsTo("getPageDirectChildren")).toBe(1);
  });

  it("keeps folders and non-page children, and drops drafts", async () => {
    const client = new FakeConfluenceClient()
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY" })
      .seedPage({ id: "101", title: "Page", spaceKey: "DOCSY", parentId: "100", position: 1 })
      .seedPage({
        id: "102",
        title: "Runbooks",
        spaceKey: "DOCSY",
        parentId: "100",
        type: "folder",
        position: 2,
      })
      .seedPage({
        id: "103",
        title: "Board",
        spaceKey: "DOCSY",
        parentId: "100",
        type: "whiteboard",
        position: 3,
      })
      .seedPage({
        id: "104",
        title: "Draft",
        spaceKey: "DOCSY",
        parentId: "100",
        status: "draft",
        position: 4,
      });
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");
    expect(children.map((c) => c.type)).toEqual(["page", "folder", "whiteboard"]);
  });
});

describe("loadSubtree", () => {
  it("walks only the requested branch, leaving siblings unloaded", async () => {
    const client = bigSpace(20, 2);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.resetCalls();

    const walked = await index.loadSubtree("1000");
    expect(walked.map((n) => n.id).sort()).toEqual(["10000", "10001"]);
    expect(index.isUnloaded("1001")).toBe(true);
  });

  it("stops rather than truncating when the node budget is exhausted", async () => {
    const client = bigSpace(30, 2);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await expect(index.loadSubtree("100", { maxNodes: 5 })).rejects.toMatchObject({
      code: "EINVAL",
    });
  });

  it("fetches no bodies", async () => {
    const client = bigSpace(5, 2);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadSubtree("100");
    expect(client.callsTo("getPage")).toBe(0);
  });
});

describe("revalidation", () => {
  let client: FakeConfluenceClient;
  beforeEach(() => {
    client = bigSpace(5, 1);
  });

  it("picks up a version bump through the body-free probe", async () => {
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.bumpVersion("1000", "<p>edited elsewhere</p>");
    advance(60_001);
    await index.revalidate("100");
    expect(index.node("1000")?.version).toBe(2);
    expect(client.callsTo("getPage")).toBe(0);
  });

  it("drops a page that disappeared from the server", async () => {
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await client.deletePage("1000");
    advance(60_001);
    await index.revalidate("100");
    expect(index.node("1000")).toBeUndefined();
  });

  it("picks up a new page through the fresh listing", async () => {
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.seedPage({ id: "2000", title: "Brand New", spaceKey: "DOCSY", parentId: "100", position: 99 });
    advance(60_001);
    await index.revalidate("100");
    expect(index.node("2000")?.title).toBe("Brand New");
  });

  it("follows a page that moved to another parent", async () => {
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("1000");
    await client.movePage("1001", "1000");
    advance(60_001);
    await index.revalidate("100");
    expect(index.node("1001")).toBeUndefined();
    await index.loadChildren("1000", { force: true });
    expect(index.node("1001")?.parentId).toBe("1000");
  });

  it("costs nothing for a branch nobody entered", async () => {
    const client = bigSpace(50, 2);
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("1000");
    advance(60_001);
    client.resetCalls();

    await index.revalidate("1000");

    // One version probe plus one listing, both scoped to 1000's own children.
    expect(client.callsTo("getPageVersions")).toBe(1);
    expect(client.callsTo("getPageDirectChildren")).toBe(1);
    expect(client.calls.find((c) => c.arg.includes("1001"))).toBeUndefined();
  });

  it("does nothing while the TTL still holds", async () => {
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.resetCalls();
    await index.revalidate("100");
    expect(client.requestCount).toBe(0);
  });
});

describe("visibility", () => {
  it("hides an invisible page from listings and from the index", async () => {
    const client = bigSpace(5, 1);
    client.hiddenIds.add("1002");
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");
    expect(children.map((c) => c.id)).not.toContain("1002");
    expect(index.knowsId("1002")).toBe(false);
  });

  it("answers ENOENT rather than EACCES for an invisible space", async () => {
    const client = bigSpace(2, 1);
    client.hiddenIds.add("sp-1");
    const { index } = makeIndex(client);
    await expect(index.getSpace("DOCSY")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restricts to the configured spaces without revealing others", async () => {
    const client = bigSpace(2, 1).seedSpace({ id: "sp-2", key: "OTHER", name: "Other" });
    const { index } = makeIndex(client, { spaces: ["DOCSY"] });
    expect((await index.listSpaces()).map((s) => s.key)).toEqual(["DOCSY"]);
    await expect(index.getSpace("OTHER")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("data center", () => {
  it("uses the v1 children endpoint and never touches a v2 one", async () => {
    const client = new FakeConfluenceClient({ deploymentType: "data-center" })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY" })
      .seedPage({ id: "101", title: "One", spaceKey: "DOCSY", parentId: "100", position: 1 })
      .seedPage({ id: "102", title: "Two", spaceKey: "DOCSY", parentId: "100", position: 2 });
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");
    expect(children.map((c) => c.title)).toEqual(["One", "Two"]);
    expect(client.callsTo("getChildren")).toBe(1);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
  });
});

describe("offline", () => {
  it("serves a hydrated snapshot without any request", async () => {
    const client = bigSpace(3, 1);
    const online = makeIndex(client).index;
    await online.getHomepageId("DOCSY");
    await online.loadChildren("100");
    const snapshot = online.snapshot();

    const offline = makeIndex(client, { offline: true }).index;
    offline.hydrate(snapshot);
    client.resetCalls();
    const children = await offline.loadChildren("100");
    expect(children).toHaveLength(3);
    expect(client.requestCount).toBe(0);
  });

  it("explains the flag on a cache miss", async () => {
    const client = bigSpace(3, 1);
    const { index } = makeIndex(client, { offline: true });
    await expect(index.loadChildren("100")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(index.loadChildren("100")).rejects.toThrow(/--offline/);
  });
});

describe("mutation helpers", () => {
  it("attaches a newly created page so the next listing needs no request", async () => {
    const client = bigSpace(2, 1);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    index.attachChild("100", { id: "9999", title: "Fresh", type: "page", spaceKey: "DOCSY" });
    client.resetCalls();
    const children = await index.loadChildren("100");
    expect(children.map((c) => c.id)).toContain("9999");
    expect(client.requestCount).toBe(0);
  });

  it("forgets a subtree, detaching it from its parent", async () => {
    const client = bigSpace(3, 2);
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("1000");
    index.forget("1000");
    expect(index.knowsId("1000")).toBe(false);
    expect(index.knowsId("10000")).toBe(false);
    expect(index.node("100")?.children).not.toContain("1000");
  });
});

describe("rate limits", () => {
  it("retries a 429 and succeeds without the caller seeing an error", async () => {
    const client = bigSpace(3, 1);
    client.failNext({ method: "getPageDirectChildren", status: 429, times: 1, retryAfterMs: 1 });
    const { index } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");
    expect(children).toHaveLength(3);
  });

  it("reports the wait so a frontend can warn", async () => {
    const client = bigSpace(3, 1);
    client.failNext({ method: "getPageDirectChildren", status: 429, times: 1, retryAfterMs: 7000 });
    const waits: unknown[] = [];
    const { index } = makeIndex(client, {
      logger: { ...silent, warn: (_m, data) => void waits.push(data?.waitMs) },
    });
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    expect(waits).toEqual([7000]);
  });
});

describe("data center revalidation", () => {
  /**
   * Regression: `getPageVersions` is Cloud v2 only and throws a TypeError
   * anywhere else, so the Cloud revalidation path crashed every Data Center
   * listing once its TTL expired.
   */
  it("revalidates without the Cloud-only bulk version endpoint", async () => {
    const client = new FakeConfluenceClient({ deploymentType: "data-center" })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY" })
      .seedPage({ id: "101", title: "One", spaceKey: "DOCSY", parentId: "100", position: 1 });
    const { index, advance } = makeIndex(client);
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    client.bumpVersion("101", "<p>edited</p>");
    advance(60_001);

    await index.revalidate("100");

    expect(index.node("101")?.version).toBe(2);
    expect(client.callsTo("getPageVersions")).toBe(0);
    expect(client.callsTo("getChildren")).toBe(2);
  });
});
