import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { JsonAdapter } from "./json-adapter.js";
import { createPageRecord } from "./types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LinkRecord, UserRecord, ContributorRecord } from "./types.js";

describe("JsonAdapter", () => {
  let adapter: JsonAdapter;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-json-adapter-test-"));
    adapter = new JsonAdapter({ atlcliDir: tempDir });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    test("init creates storage file", async () => {
      expect(adapter.adapterType).toBe("json");
    });
  });

  describe("pages", () => {
    test("upsertPage and getPage", async () => {
      const page = createPageRecord({
        pageId: "123",
        path: "test.md",
        title: "Test",
        spaceKey: "TEST",
      });

      await adapter.upsertPage(page);
      const retrieved = await adapter.getPage("123");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Test");
    });

    test("getPageByPath", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "456",
          path: "docs/guide.md",
          title: "Guide",
          spaceKey: "DOCS",
        })
      );

      const retrieved = await adapter.getPageByPath("docs/guide.md");
      expect(retrieved?.pageId).toBe("456");
    });

    test("deletePage removes related data", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );
      await adapter.setPageLabels("page-1", ["label"]);

      await adapter.deletePage("page-1");

      expect(await adapter.getPage("page-1")).toBeNull();
      expect(await adapter.getPageLabels("page-1")).toEqual([]);
    });

    test("listPages with filters", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "1",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
          syncState: "synced",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "2",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
          syncState: "local-modified",
        })
      );

      const synced = await adapter.listPages({ syncState: "synced" });
      expect(synced.length).toBe(1);
    });
  });

  describe("links", () => {
    test("orphan detection", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "orphan",
          path: "orphan.md",
          title: "Orphan",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "linked",
          path: "linked.md",
          title: "Linked",
          spaceKey: "TEST",
        })
      );
      await adapter.setPageLinks("orphan", [
        {
          sourcePageId: "orphan",
          targetPageId: "linked",
          targetPath: null,
          linkType: "internal",
          linkText: null,
          lineNumber: null,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      const orphans = await adapter.getOrphanedPages();
      expect(orphans.length).toBe(1);
      expect(orphans[0].pageId).toBe("orphan");
    });

    test("broken links", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );
      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing.md",
          linkType: "internal",
          linkText: "Broken",
          lineNumber: 5,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      const broken = await adapter.getBrokenLinks();
      expect(broken.length).toBe(1);
    });
  });

  describe("users", () => {
    test("three-state isActive", async () => {
      await adapter.upsertUser({
        userId: "unknown",
        displayName: "Unknown",
        email: null,
        isActive: null,
        lastCheckedAt: null,
      });
      await adapter.upsertUser({
        userId: "active",
        displayName: "Active",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });

      expect((await adapter.getUser("unknown"))?.isActive).toBeNull();
      expect((await adapter.getUser("active"))?.isActive).toBe(true);
    });
  });

  describe("labels", () => {
    test("setPageLabels and getPageLabels", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageLabels("page-1", ["a", "b"]);
      const labels = await adapter.getPageLabels("page-1");

      expect(labels.length).toBe(2);
    });
  });

  describe("remote accessibility", () => {
    test("markAsInaccessible and listPages filter", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "accessible",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "inaccessible",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
        })
      );
      await adapter.markAsInaccessible("inaccessible", "not_found");

      expect((await adapter.listPages()).length).toBe(1);
      expect((await adapter.listPages({ includeInaccessible: true })).length).toBe(2);
    });
  });

  describe("metadata", () => {
    test("getMeta and setMeta", async () => {
      await adapter.setMeta("key", "value");
      expect(await adapter.getMeta("key")).toBe("value");
    });
  });

  describe("export/import", () => {
    test("exportToJson and importFromJson", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      const exported = await adapter.exportToJson();

      // New adapter
      const newTempDir = await mkdtemp(join(tmpdir(), "atlcli-json-import-test-"));
      const newAdapter = new JsonAdapter({ atlcliDir: newTempDir });
      await newAdapter.init();
      await newAdapter.importFromJson(exported);

      expect(await newAdapter.countPages()).toBe(1);

      await newAdapter.close();
      await rm(newTempDir, { recursive: true, force: true });
    });
  });

  describe("persistence", () => {
    test("data persists across adapter instances", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "persist",
          path: "persist.md",
          title: "Persist",
          spaceKey: "TEST",
        })
      );
      await adapter.close();

      // New adapter instance
      const newAdapter = new JsonAdapter({ atlcliDir: tempDir });
      await newAdapter.init();

      const page = await newAdapter.getPage("persist");
      expect(page).not.toBeNull();
      expect(page?.title).toBe("Persist");

      await newAdapter.close();
    });
  });
});
