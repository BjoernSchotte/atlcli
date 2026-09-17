import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyCache, hashStorage, resolveCachePaths } from "./body-cache.js";

let root: string;
let clock: number;

function makeCache(maxBytes = 1_000_000): BodyCache {
  const paths = resolveCachePaths({
    cacheDir: root,
    profile: "mayflower",
    accountId: "acct-1",
    instanceUrl: "https://example.atlassian.net/wiki",
  });
  return new BodyCache({
    dbPath: paths.dbPath,
    blobDir: paths.blobDir,
    maxBytes,
    now: () => clock,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-cache-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cache location", () => {
  it("partitions by profile and account inside the chosen directory", () => {
    const a = resolveCachePaths({
      cacheDir: "/cache",
      profile: "work",
      accountId: "acct-1",
      instanceUrl: "https://site.atlassian.net/wiki",
    });
    const b = resolveCachePaths({
      cacheDir: "/cache",
      profile: "work",
      accountId: "acct-2",
      instanceUrl: "https://site.atlassian.net/wiki",
    });
    const c = resolveCachePaths({
      cacheDir: "/cache",
      profile: "personal",
      accountId: "acct-1",
      instanceUrl: "https://site.atlassian.net/wiki",
    });
    // Two users of the same profile, and two profiles of the same user, must
    // never land in the same database.
    expect(a.dbPath).not.toBe(b.dbPath);
    expect(a.dbPath).not.toBe(c.dbPath);
    expect(a.dbPath).toStartWith("/cache/work/acct-1/");
  });

  it("separates two sites of the same profile and account", () => {
    const a = resolveCachePaths({
      cacheDir: "/cache",
      profile: "work",
      accountId: "acct-1",
      instanceUrl: "https://one.atlassian.net/wiki",
    });
    const b = resolveCachePaths({
      cacheDir: "/cache",
      profile: "work",
      accountId: "acct-1",
      instanceUrl: "https://two.atlassian.net/wiki",
    });
    expect(a.dbPath).not.toBe(b.dbPath);
  });

  it("refuses to let a profile or account name escape its directory", () => {
    for (const hostile of ["../../etc", "..", "/absolute", "a/b", "."]) {
      const resolved = resolveCachePaths({
        cacheDir: "/cache",
        profile: hostile,
        accountId: hostile,
        instanceUrl: "https://site.atlassian.net/wiki",
      });
      expect(resolved.dbPath).toStartWith("/cache/");
      // The real property: no segment is a traversal, so the path cannot walk
      // out of the cache directory however it is normalised.
      const segments = resolved.dbPath.slice("/cache/".length).split("/");
      expect(segments).not.toContain("..");
      expect(segments).not.toContain(".");
      expect(segments).toHaveLength(3);
    }
  });
});

describe("bodies", () => {
  it("hits only on an exact version match", () => {
    const cache = makeCache();
    cache.putBody({ pageId: "1", version: 3, markdown: "# Three", storageHash: hashStorage("<p>3</p>") });
    expect(cache.getBody("1", 3)?.markdown).toBe("# Three");
    // Version 4 is a different page, not a stale version 3.
    expect(cache.getBody("1", 4)).toBeUndefined();
    cache.close();
  });

  it("counts hits and misses", () => {
    const cache = makeCache();
    cache.putBody({ pageId: "1", version: 1, markdown: "x", storageHash: "h" });
    cache.getBody("1", 1);
    cache.getBody("1", 2);
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    cache.close();
  });

  it("forgets every version of a deleted page", () => {
    const cache = makeCache();
    cache.putBody({ pageId: "1", version: 1, markdown: "a", storageHash: "h" });
    cache.putBody({ pageId: "1", version: 2, markdown: "b", storageHash: "h" });
    cache.forgetPage("1");
    expect(cache.getBody("1", 1)).toBeUndefined();
    expect(cache.getBody("1", 2)).toBeUndefined();
    cache.close();
  });
});

describe("attachments", () => {
  it("round-trips bytes through a blob file", () => {
    const cache = makeCache();
    const stored = cache.putAttachment({
      attachmentId: "att-1",
      pageId: "1",
      filename: "diagram.png",
      mediaType: "image/png",
      version: 1,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(stored).toBeDefined();
    const hit = cache.getAttachment("att-1", 1);
    expect(hit?.size).toBe(4);
    expect(cache.readAttachmentBytes(hit!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    cache.close();
  });

  it("misses when the blob was removed underneath it", () => {
    const cache = makeCache();
    const stored = cache.putAttachment({
      attachmentId: "att-1",
      pageId: "1",
      filename: "a.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array([1]),
    })!;
    rmSync(stored.blobPath, { force: true });
    expect(cache.getAttachment("att-1", 1)).toBeUndefined();
    cache.close();
  });

  it("misses on a superseded attachment version", () => {
    const cache = makeCache();
    cache.putAttachment({
      attachmentId: "att-1",
      pageId: "1",
      filename: "a.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array([1]),
    });
    expect(cache.getAttachment("att-1", 2)).toBeUndefined();
    cache.close();
  });
});

describe("the bounded LRU", () => {
  const body = (n: number): string => "x".repeat(n);

  it("never exceeds the ceiling, enforcing it while writing", () => {
    const cache = makeCache(1000);
    for (let i = 0; i < 20; i++) {
      clock += 1000;
      cache.putBody({ pageId: String(i), version: 1, markdown: body(200), storageHash: "h" });
      // The assertion is inside the loop on purpose: rule 4 asks for a ceiling,
      // not a high-water mark that a later sweep brings back down.
      expect(cache.usedBytes()).toBeLessThanOrEqual(1000);
    }
    cache.close();
  });

  it("evicts the least recently accessed entry first", () => {
    const cache = makeCache(700);
    clock += 1000;
    cache.putBody({ pageId: "old", version: 1, markdown: body(200), storageHash: "h" });
    clock += 1000;
    cache.putBody({ pageId: "mid", version: 1, markdown: body(200), storageHash: "h" });
    clock += 1000;
    cache.putBody({ pageId: "new", version: 1, markdown: body(200), storageHash: "h" });

    // Touching "old" makes it the most recent, so "mid" should go next.
    clock += 1000;
    cache.getBody("old", 1);
    clock += 1000;
    cache.putBody({ pageId: "newest", version: 1, markdown: body(200), storageHash: "h" });

    expect(cache.getBody("mid", 1)).toBeUndefined();
    expect(cache.getBody("old", 1)).toBeDefined();
    cache.close();
  });

  it("makes a blob and a body compete for the same budget", () => {
    const cache = makeCache(500);
    clock += 1000;
    cache.putBody({ pageId: "1", version: 1, markdown: body(300), storageHash: "h" });
    clock += 1000;
    cache.putAttachment({
      attachmentId: "att-1",
      pageId: "2",
      filename: "big.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array(300),
    });
    // The body was older, so the blob's arrival evicted it.
    expect(cache.getBody("1", 1)).toBeUndefined();
    expect(cache.usedBytes()).toBeLessThanOrEqual(500);
    cache.close();
  });

  it("deletes the blob file, not just its row", () => {
    const cache = makeCache(400);
    clock += 1000;
    const first = cache.putAttachment({
      attachmentId: "att-1",
      pageId: "1",
      filename: "a.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array(300),
    })!;
    clock += 1000;
    cache.putAttachment({
      attachmentId: "att-2",
      pageId: "1",
      filename: "b.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array(300),
    });
    expect(existsSync(first.blobPath)).toBe(false);
    cache.close();
  });

  it("declines an entry larger than the whole budget rather than emptying itself", () => {
    const cache = makeCache(500);
    cache.putBody({ pageId: "keeper", version: 1, markdown: body(100), storageHash: "h" });
    cache.putBody({ pageId: "huge", version: 1, markdown: body(5000), storageHash: "h" });
    expect(cache.getBody("huge", 1)).toBeUndefined();
    expect(cache.getBody("keeper", 1)).toBeDefined();
    cache.close();
  });

  it("reports plausible statistics after eviction", () => {
    const cache = makeCache(600);
    for (let i = 0; i < 10; i++) {
      clock += 1000;
      cache.putBody({ pageId: String(i), version: 1, markdown: body(200), storageHash: "h" });
    }
    const stats = cache.stats();
    expect(stats.bodies).toBeLessThanOrEqual(3);
    expect(stats.bytes).toBe(stats.bodies * 200);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    cache.close();
  });
});

describe("clear", () => {
  it("empties everything and removes the blobs", () => {
    const cache = makeCache();
    cache.putBody({ pageId: "1", version: 1, markdown: "a", storageHash: "h" });
    const blob = cache.putAttachment({
      attachmentId: "att-1",
      pageId: "1",
      filename: "a.bin",
      mediaType: "application/octet-stream",
      version: 1,
      bytes: new Uint8Array([1]),
    })!;
    cache.clear();
    expect(cache.stats().bodies).toBe(0);
    expect(cache.stats().attachments).toBe(0);
    expect(existsSync(blob.blobPath)).toBe(false);
    cache.close();
  });
});

describe("persistence", () => {
  it("survives a reopen, because the cache is a real file", () => {
    const first = makeCache();
    first.putBody({ pageId: "1", version: 7, markdown: "# Seven", storageHash: "h" });
    first.close();
    const second = makeCache();
    expect(second.getBody("1", 7)?.markdown).toBe("# Seven");
    second.close();
  });
});

it("migrates legacy Markdown rows as misses without dropping attachments and replaces them once", () => {
  const paths = resolveCachePaths({ cacheDir: root, profile: "mayflower", accountId: "acct-1",
    instanceUrl: "https://example.atlassian.net/wiki" });
  const old = makeCache();
  old.putBody({ pageId: "1", version: 1, markdown: "old historic timestamp", storageHash: "h" });
  old.putAttachment({ attachmentId: "a1", pageId: "1", filename: "a.txt", mediaType: "text/plain",
    version: 1, bytes: Buffer.from("keep") });
  old.close();
  const legacy = new Database(paths.dbPath);
  legacy.exec("ALTER TABLE bodies DROP COLUMN render_version; DELETE FROM schema_info WHERE version=2;");
  legacy.run("INSERT OR IGNORE INTO schema_info(version) VALUES(1)");
  legacy.close();
  const migrated = makeCache();
  expect(migrated.getBody("1", 1)).toBeUndefined();
  expect(migrated.readAttachmentBytes(migrated.getAttachment("a1", 1)!)).toEqual(Buffer.from("keep"));
  migrated.putBody({ pageId: "1", version: 1, markdown: "correct historic timestamp", storageHash: "new" });
  expect(migrated.getBody("1", 1)?.markdown).toBe("correct historic timestamp");
  migrated.putBody({ pageId: "1", version: 1, markdown: "must remain immutable", storageHash: "other" });
  expect(migrated.getBody("1", 1)?.markdown).toBe("correct historic timestamp");
  expect(migrated.stats().bodies).toBe(1);
  migrated.close();
  const reopened = makeCache();
  expect(reopened.getBody("1", 1)?.markdown).toBe("correct historic timestamp");
  reopened.close();
});

it("does not evict other bodies when refreshing the access time of an immutable cached body", () => {
  const cache = makeCache(10);
  cache.putBody({ pageId: "1", version: 1, markdown: "12345", storageHash: "h" });
  cache.putBody({ pageId: "2", version: 1, markdown: "67890", storageHash: "h" });
  cache.putBody({ pageId: "1", version: 1, markdown: "other", storageHash: "h" });
  expect(cache.getBody("1", 1)?.markdown).toBe("12345");
  expect(cache.getBody("2", 1)?.markdown).toBe("67890");
  expect(cache.usedBytes()).toBe(10);
  cache.close();
});
