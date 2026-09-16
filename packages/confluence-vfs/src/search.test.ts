import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";
import { scopeSearchCql } from "./search.js";

describe("body-free indexed previews", () => {
  test("scopes OR expressions, preserves quoted ORDER BY and rejects scope breakouts", () => {
    expect(scopeSearchCql('text ~ "order by" OR label = docs ORDER BY title', ["DOCSY"]))
      .toBe('type = page AND (space = "DOCSY") AND (text ~ "order by" OR label = docs) ORDER BY title');
    expect(() => scopeSearchCql('type = page) OR space = "PRIVATE"', ["DOCSY"])).toThrow();
  });

  test("paginates, caps, rejects foreign rows and cursors; never reads bodies or ancestors", async () => {
    const client = new FakeConfluenceClient().seedSpace({ id: "1", key: "DOCSY", name: "Docs", homepageId: "100" });
    for (let id = 100; id < 205; id++) client.seedPage({ id: String(id), title: `Page ${id}`, spaceKey: "DOCSY", storage: "<p>retrospective</p>" });
    const cacheDir = mkdtempSync(join(tmpdir(), "vfs-excerpts-"));
    const vfs = await ConfluenceVfsImpl.open({ profile: "test", client, mode: "ro", allowDelete: false, offline: false, spaces: ["DOCSY"], cacheDir });
    try {
      const capped = await vfs.searchExcerpts('text ~ "retrospective"');
      expect(capped.results).toHaveLength(100);
      expect(capped).toMatchObject({ complete: false, truncated: true, totalSize: 105 });
      const all = await vfs.searchExcerpts('text ~ "retrospective"', { maxResults: 200 });
      expect(all.results).toHaveLength(105);
      expect(all).toMatchObject({ complete: true, truncated: false });
      expect(all.results[0]).toMatchObject({ path: "/DOCSY/.by-id/100.md", excerpt: "retrospective" });
      expect(client.callsTo("searchDetailed")).toBe(3);
      for (const method of ["getPage", "getPagesBulk", "getAncestors", "getPageDirectChildren"]) expect(client.callsTo(method)).toBe(0);
      await expect(vfs.searchExcerpts("type = page", { spaces: ["PRIVATE"] })).rejects.toThrow("mounted spaces");
      await expect(vfs.searchExcerpts("type = page", { maxResults: 1001 })).rejects.toThrow("between");
      let calls = 0;
      client.searchDetailed = async () => ++calls === 1
        ? { results: [], nextLink: "second" }
        : { results: [{ id: "100", title: "Home", type: "page", spaceKey: "DOCSY" }], totalSize: 1 };
      expect(await vfs.searchExcerpts("type = page")).toMatchObject({ complete: true, results: [{ id: "100", excerpt: "" }] });
      expect(calls).toBe(2);
      client.searchDetailed = async () => ({ results: [{ id: "999", title: "Secret", type: "page", spaceKey: "PRIVATE" }] });
      await expect(vfs.searchExcerpts("type = page")).rejects.toThrow("outside");
      client.searchDetailed = async () => ({ results: [], nextLink: "repeat" });
      await expect(vfs.searchExcerpts("type = page")).rejects.toThrow("repeated");
      client.searchDetailed = async () => ({ results: [], totalSize: 10 });
      expect(await vfs.searchExcerpts("type = page")).toMatchObject({ complete: false, truncated: true });
    } finally { await vfs.close(); rmSync(cacheDir, { recursive: true, force: true }); }
  });
});
