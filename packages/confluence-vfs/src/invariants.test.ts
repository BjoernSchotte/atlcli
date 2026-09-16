/**
 * The demand principle, at scale (WP9.3, WP9.3b, WP9.4).
 *
 * Section 1b of the plan calls its four rules a **binding invariant**, and asks
 * for one test that cannot be skipped. This is that test, plus the load figures
 * WP9.3 wants and the rate-limit behaviour WP9.4 wants.
 *
 * Everything here is a request count or a byte count. That is the point: the
 * demand principle is a claim about what the filesystem *does not* do, and only
 * a counter can prove it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

let root: string;
let clock: number;

/** A space of 5,050 pages: 50 sections of 100, under one home page. */
function hugeSpace(): FakeConfluenceClient {
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "BIG", name: "Big", homepageId: "1" })
    .seedPage({ id: "1", title: "Home", spaceKey: "BIG", storage: "<p>home</p>" });
  for (let section = 0; section < 50; section++) {
    const sectionId = String(10_000 + section);
    client.seedPage({
      id: sectionId,
      title: `Section ${section}`,
      spaceKey: "BIG",
      parentId: "1",
      position: section,
      storage: `<h1>Section ${section}</h1><p>Overview.</p>`,
    });
    for (let page = 0; page < 100; page++) {
      client.seedPage({
        id: `${sectionId}${String(page).padStart(3, "0")}`,
        title: `Page ${section}-${page}`,
        spaceKey: "BIG",
        parentId: sectionId,
        position: page,
        storage: `<h1>Page ${section}-${page}</h1><p>Body mentioning kubernetes clusters.</p>`,
        ...(page % 10 === 0 ? { labels: ["runbook"] } : {}),
      });
    }
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
    spaces: ["BIG"],
    mode: "ro",
    allowDelete: false,
    cacheDir: root,
    offline: false,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...overrides,
  });
}

/** Bytes the cache actually put on disk, blobs included. */
function bytesOnDisk(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else total += stat.size;
    }
  };
  walk(dir);
  return total;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-invariant-"));
  clock = Date.parse("2026-09-16T09:00:00.000Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WP9.3b — the demand principle across 5,050 pages", () => {
  /**
   * The invariant test the plan says cannot be skipped: ten listings, a walk of
   * one subtree, a hundred stats. Nothing may fetch a body.
   */
  it("lists, walks and stats without writing a single body row", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    client.resetCalls();

    // Ten directories.
    const top = await vfs.readdir("/BIG");
    const sections = top.filter((entry) => entry.name.startsWith("section-")).slice(0, 10);
    for (const section of sections) await vfs.readdir(`/BIG/${section.name}`);

    // One subtree walked recursively.
    await vfs.subtreePageIds(`/BIG/${sections[0]!.name}`, "BIG");

    // A hundred files stat'd.
    let statted = 0;
    for (const section of sections) {
      const children = await vfs.readdir(`/BIG/${section.name}`);
      for (const child of children.slice(0, 10)) {
        await vfs.stat(`/BIG/${section.name}/${child.name}`);
        statted += 1;
      }
    }
    expect(statted).toBe(100);

    // The invariant.
    expect(vfs.cache!.stats().bodies).toBe(0);
    expect(vfs.cache!.stats().attachments).toBe(0);
    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    expect(client.callsTo("downloadAttachment")).toBe(0);

    await vfs.close();
  });

  it("costs requests proportional to directories visited, not to space size", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    client.resetCalls();

    await vfs.readdir("/BIG");
    const afterOne = client.callsTo("getPageDirectChildren");
    const top = await vfs.readdir("/BIG");
    const sections = top.filter((entry) => entry.name.startsWith("section-")).slice(0, 10);
    for (const section of sections) await vfs.readdir(`/BIG/${section.name}`);
    const afterEleven = client.callsTo("getPageDirectChildren");

    expect(afterOne).toBe(1);
    // One per directory entered. Not 50, and certainly not 5,050.
    expect(afterEleven).toBe(11);
    await vfs.close();
  });

  it("leaves every unvisited branch unloaded", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    await vfs.readdir("/BIG/section-0-10000");

    expect(vfs.index.isUnloaded("10000")).toBe(false);
    for (const section of [1, 25, 49]) {
      expect(vfs.index.isUnloaded(String(10_000 + section))).toBe(true);
    }
    // The index knows the 50 sections it listed, plus their parent and the 100
    // children of the one section entered — not 5,050 nodes.
    expect(vfs.index.loadedNodes().length).toBeLessThan(200);
    await vfs.close();
  });

  it("puts no page body on disk for a listing-only session", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    for (let section = 0; section < 10; section++) {
      await vfs.readdir(`/BIG/section-${section}-${10_000 + section}`);
    }
    await vfs.close();

    // The database and the snapshot exist; neither holds a page body.
    const reopened = await openVfs(client);
    expect(reopened.cache!.stats().bodies).toBe(0);
    // A tree snapshot of ~1,050 nodes, not 5,050 bodies.
    expect(bytesOnDisk(root)).toBeLessThan(2 * 1024 * 1024);
    await reopened.close();
  });
});

describe("WP9.3 — load figures", () => {
  it("reads 50 bodies in one bulk request", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    await vfs.readdir("/BIG/section-0-10000");
    client.resetCalls();

    const ids = Array.from({ length: 50 }, (_, i) => `10000${String(i).padStart(3, "0")}`);
    const result = await vfs.prefetch(ids, { reason: "load test" });

    expect(result.fetched).toBe(50);
    expect(client.callsTo("getPagesBulk")).toBe(1);
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  /**
   * Two ceilings, and the walk budget is the outer one.
   *
   * A recursive walk of the whole space refuses before any prefetch is even
   * considered — 5,050 nodes against a 5,000-node walk budget. That is the
   * right order: the cheaper refusal comes first.
   */
  it("refuses to walk a whole 5,050-page space at all", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    client.resetCalls();

    await expect(vfs.subtreePageIds("/BIG", "BIG")).rejects.toThrow(/Refusing to walk/);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    await vfs.close();
  });

  it("refuses a prefetch over the ceiling, naming the count, the limit and the flag", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    // Ten sections: 1,010 pages. Inside the walk budget, well over the
    // 300-page prefetch ceiling.
    const ids: string[] = [];
    for (let section = 0; section < 10; section++) {
      ids.push(...(await vfs.subtreePageIds(`/BIG/section-${section}-${10_000 + section}`, "BIG")));
    }
    expect(ids.length).toBeGreaterThan(300);
    client.resetCalls();

    await expect(vfs.prefetch(ids, { reason: "grep -r over ten sections" })).rejects.toThrow(
      /\d+ page bodies.*300-page prefetch limit.*--prefetch-max/s,
    );
    // Nothing partial.
    expect(client.callsTo("getPagesBulk")).toBe(0);
    await vfs.close();
  });

  /**
   * The defaults question WP9.3 asks: are 300 pages and 100 MB practical?
   *
   * 300 page bodies of this shape are about 30 KB of Markdown, three orders of
   * magnitude under the 100 MB cache. So the *prefetch* ceiling is what a user
   * meets first, and it meets them at a subtree of 300 pages — which is a large
   * documentation section, not a small one. The defaults stand; the flag is
   * there for the space-wide case, which should be a deliberate act.
   */
  it("shows the prefetch ceiling binds long before the cache ceiling", async () => {
    const client = hugeSpace();
    const vfs = await openVfs(client);
    await vfs.readdir("/BIG");
    await vfs.readdir("/BIG/section-0-10000");

    const ids = Array.from({ length: 100 }, (_, i) => `10000${String(i).padStart(3, "0")}`);
    await vfs.prefetch(ids);
    const stats = vfs.cache!.stats();

    expect(stats.bodies).toBe(100);
    // Well under one percent of the 100 MB budget for a third of the ceiling.
    expect(stats.bytes).toBeLessThan(stats.maxBytes / 100);
    await vfs.close();
  });

  it("keeps the cache under its ceiling while a large prefetch runs", async () => {
    const client = hugeSpace();
    // A ceiling small enough that 100 bodies of ~200 bytes cannot all fit.
    const vfs = await openVfs(client, { cacheMaxMb: 0.005 });
    await vfs.readdir("/BIG");
    await vfs.readdir("/BIG/section-0-10000");

    const ids = Array.from({ length: 100 }, (_, i) => `10000${String(i).padStart(3, "0")}`);
    await vfs.prefetch(ids);

    const stats = vfs.cache!.stats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.bodies).toBeLessThan(100);
    expect(stats.bodies).toBeGreaterThan(0);
    await vfs.close();
  });
});

describe("WP9.4 — rate limits", () => {
  it("retries a 429 and the caller never sees an error", async () => {
    const client = hugeSpace();
    client.failNext({ method: "getPageDirectChildren", status: 429, times: 2, retryAfterMs: 1000 });
    const vfs = await openVfs(client);

    const entries = await vfs.readdir("/BIG");

    expect(entries.length).toBeGreaterThan(50);
    await vfs.close();
  });

  it("honours Retry-After rather than guessing", async () => {
    const client = hugeSpace();
    client.failNext({ method: "getPageDirectChildren", status: 429, times: 1, retryAfterMs: 3000 });
    const waits: number[] = [];
    const vfs = await openVfs(client, {
      logger: {
        debug() {},
        info() {},
        warn: (_message: string, data?: Record<string, unknown>) =>
          void waits.push(data?.waitMs as number),
        error() {},
      },
    });

    await vfs.readdir("/BIG");

    expect(waits).toEqual([3000]);
    await vfs.close();
  });

  it("reports a long wait so a frontend can warn, and a short one too", async () => {
    for (const waitMs of [1000, 7000]) {
      // A fresh cache directory per iteration: sharing one would let the second
      // listing come from the first's snapshot, making no request to throttle.
      root = mkdtempSync(join(tmpdir(), "vfs-invariant-"));
      const client = hugeSpace();
      client.failNext({ method: "getPageDirectChildren", status: 429, times: 1, retryAfterMs: waitMs });
      const seen: number[] = [];
      const vfs = await openVfs(client, {
        logger: {
          debug() {},
          info() {},
          warn: (_m: string, data?: Record<string, unknown>) => void seen.push(data?.waitMs as number),
          error() {},
        },
      });
      await vfs.readdir("/BIG");
      expect(seen).toEqual([waitMs]);
      await vfs.close();
    }
  });

  it("surfaces EAGAIN with the wait and the remedy once retries run out", async () => {
    const client = hugeSpace();
    client.failNext({ method: "getPageDirectChildren", status: 429, times: 99, retryAfterMs: 500 });
    const vfs = await openVfs(client);

    await expect(vfs.readdir("/BIG")).rejects.toMatchObject({ code: "EAGAIN" });
    await expect(vfs.readdir("/BIG")).rejects.toThrow(/--concurrency|Retry after/);
    await vfs.close();
  });

  it("does not retry anything other than a 429", async () => {
    const client = hugeSpace();
    client.failNext({ method: "getPageDirectChildren", status: 404, times: 1 });
    const vfs = await openVfs(client);
    client.resetCalls();

    await expect(vfs.readdir("/BIG")).rejects.toMatchObject({ code: "ENOENT" });
    // Exactly one attempt: retrying a 404 only spends the rate-limit budget.
    expect(client.callsTo("getPageDirectChildren")).toBe(1);
    await vfs.close();
  });
});
