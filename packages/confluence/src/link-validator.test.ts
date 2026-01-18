import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSyncDb, type SyncDbAdapter, type PageRecord, type LinkRecord } from "./sync-db/index.js";
import {
  getBrokenLinksFromDb,
  getBrokenLinksByPage,
  getBrokenLinkSummary,
  validatePageLinksQuick,
  getExternalLinks,
} from "./link-validator.js";

describe("link-validator", () => {
  let tempDir: string;
  let adapter: SyncDbAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "link-validator-test-"));
    adapter = await createSyncDb(tempDir, { autoMigrate: true });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const createTestPage = (id: string, title: string): PageRecord => ({
    pageId: id,
    path: `${id}.md`,
    title,
    spaceKey: "TEST",
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    localHash: "abc",
    remoteHash: "abc",
    baseHash: "abc",
    syncState: "synced",
    parentId: null,
    ancestors: [],
    hasAttachments: false,
    createdBy: null,
    createdAt: new Date().toISOString(),
    lastModifiedBy: null,
    lastModified: new Date().toISOString(),
    contentStatus: "current",
    versionCount: 1,
    wordCount: null,
    isRestricted: false,
    syncCreatedAt: new Date().toISOString(),
    syncUpdatedAt: new Date().toISOString(),
    remoteInaccessibleAt: null,
    remoteInaccessibleReason: null,
  });

  describe("getBrokenLinksFromDb", () => {
    test("returns empty array when no broken links", async () => {
      const page = createTestPage("page-1", "Test Page");
      await adapter.upsertPage(page);

      const brokenLinks = await getBrokenLinksFromDb(adapter);
      expect(brokenLinks).toEqual([]);
    });

    test("returns broken links", async () => {
      const page = createTestPage("page-1", "Test Page");
      await adapter.upsertPage(page);

      const brokenLink: LinkRecord = {
        sourcePageId: "page-1",
        targetPageId: null,
        targetPath: "./missing.md",
        linkType: "internal",
        linkText: "Missing link",
        lineNumber: 10,
        isBroken: true,
        createdAt: new Date().toISOString(),
      };
      await adapter.setPageLinks("page-1", [brokenLink]);

      const brokenLinks = await getBrokenLinksFromDb(adapter);
      expect(brokenLinks.length).toBe(1);
      expect(brokenLinks[0].targetPath).toBe("./missing.md");
      expect(brokenLinks[0].isBroken).toBe(true);
    });
  });

  describe("getBrokenLinksByPage", () => {
    test("groups broken links by source page", async () => {
      const page1 = createTestPage("page-1", "Page 1");
      const page2 = createTestPage("page-2", "Page 2");
      await adapter.upsertPage(page1);
      await adapter.upsertPage(page2);

      // Add broken links to page-1
      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing1.md",
          linkType: "internal",
          linkText: "Missing 1",
          lineNumber: 5,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing2.md",
          linkType: "internal",
          linkText: "Missing 2",
          lineNumber: 10,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      // Add broken link to page-2
      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "./missing3.md",
          linkType: "internal",
          linkText: "Missing 3",
          lineNumber: 15,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      const byPage = await getBrokenLinksByPage(adapter);
      expect(byPage.size).toBe(2);
      expect(byPage.get("page-1")?.length).toBe(2);
      expect(byPage.get("page-2")?.length).toBe(1);
    });
  });

  describe("getBrokenLinkSummary", () => {
    test("returns correct summary", async () => {
      const page1 = createTestPage("page-1", "Page 1");
      const page2 = createTestPage("page-2", "Page 2");
      await adapter.upsertPage(page1);
      await adapter.upsertPage(page2);

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing1.md",
          linkType: "internal",
          linkText: "Missing 1",
          lineNumber: 5,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "./missing2.md",
          linkType: "internal",
          linkText: "Missing 2",
          lineNumber: 10,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
      ]);

      const summary = await getBrokenLinkSummary(adapter);
      expect(summary.totalBroken).toBe(2);
      expect(summary.pagesAffected).toBe(2);
      expect(summary.bySourcePage.size).toBe(2);
    });

    test("returns zero counts when no broken links", async () => {
      const summary = await getBrokenLinkSummary(adapter);
      expect(summary.totalBroken).toBe(0);
      expect(summary.pagesAffected).toBe(0);
      expect(summary.bySourcePage.size).toBe(0);
    });
  });

  describe("validatePageLinksQuick", () => {
    test("returns broken and external links for a page", async () => {
      const page = createTestPage("page-1", "Test Page");
      await adapter.upsertPage(page);

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing.md",
          linkType: "internal",
          linkText: "Missing",
          lineNumber: 5,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "External",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: "page-2",
          targetPath: "./other.md",
          linkType: "internal",
          linkText: "Valid",
          lineNumber: 15,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await validatePageLinksQuick(adapter, page);
      expect(result.broken.length).toBe(1);
      expect(result.external.length).toBe(1);
      expect(result.broken[0].targetPath).toBe("./missing.md");
      expect(result.external[0].targetPath).toBe("https://example.com");
    });
  });

  describe("getExternalLinks", () => {
    test("returns all external links", async () => {
      const page1 = createTestPage("page-1", "Page 1");
      const page2 = createTestPage("page-2", "Page 2");
      await adapter.upsertPage(page1);
      await adapter.upsertPage(page2);

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://github.com",
          linkType: "external",
          linkText: "GitHub",
          lineNumber: 5,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "Example",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      const external = await getExternalLinks(adapter);
      expect(external.length).toBe(2);
    });

    test("filters by page ID", async () => {
      const page1 = createTestPage("page-1", "Page 1");
      const page2 = createTestPage("page-2", "Page 2");
      await adapter.upsertPage(page1);
      await adapter.upsertPage(page2);

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://github.com",
          linkType: "external",
          linkText: "GitHub",
          lineNumber: 5,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "Example",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      const external = await getExternalLinks(adapter, "page-1");
      expect(external.length).toBe(1);
      expect(external[0].targetPath).toBe("https://github.com");
    });
  });
});
