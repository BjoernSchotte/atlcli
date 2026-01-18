import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initAtlcliDir,
  createSyncDb,
  type SyncDbAdapter,
  type PageRecord,
  type LinkRecord,
  type UserRecord,
} from "@atlcli/confluence";

describe("audit-wiki", () => {
  let tempDir: string;
  let adapter: SyncDbAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-test-"));

    // Initialize .atlcli directory
    await initAtlcliDir(tempDir, {
      space: "TEST",
      baseUrl: "https://example.atlassian.net",
    });

    // Create sync.db
    const atlcliPath = join(tempDir, ".atlcli");
    adapter = await createSyncDb(atlcliPath, { autoMigrate: true });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("orphan detection", () => {
    test("detects pages with no incoming links", async () => {
      // Create orphan page
      const orphanPage: PageRecord = {
        pageId: "orphan-1",
        path: "orphan.md",
        title: "Orphan Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      // Create linked page
      const linkedPage: PageRecord = {
        ...orphanPage,
        pageId: "linked-1",
        path: "linked.md",
        title: "Linked Page",
      };

      await adapter.upsertPage(orphanPage);
      await adapter.upsertPage(linkedPage);

      // Add link TO linked page
      const link: LinkRecord = {
        sourcePageId: "orphan-1",
        targetPageId: "linked-1",
        targetPath: "./linked.md",
        linkType: "internal",
        linkText: "Link to linked",
        lineNumber: 10,
        isBroken: false,
        createdAt: new Date().toISOString(),
      };
      await adapter.setPageLinks("orphan-1", [link]);

      // Get orphans
      const orphans = await adapter.getOrphanedPages();

      // orphan-1 should be orphan (no incoming links)
      expect(orphans.some((p) => p.pageId === "orphan-1")).toBe(true);
      // linked-1 should NOT be orphan (has incoming link)
      expect(orphans.some((p) => p.pageId === "linked-1")).toBe(false);
    });

    test("pages with parent are not considered orphans", async () => {
      // Create parent page
      const parentPage: PageRecord = {
        pageId: "parent-1",
        path: "parent.md",
        title: "Parent Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      // Create child page with parent
      const childPage: PageRecord = {
        ...parentPage,
        pageId: "child-1",
        path: "parent/child.md",
        title: "Child Page",
        parentId: "parent-1",
        ancestors: ["parent-1"],
      };

      await adapter.upsertPage(parentPage);
      await adapter.upsertPage(childPage);

      const orphans = await adapter.getOrphanedPages();

      // Child has parent, so it's NOT an orphan
      expect(orphans.some((p) => p.pageId === "child-1")).toBe(false);
      // Parent has no incoming links AND no parent, so it IS an orphan
      expect(orphans.some((p) => p.pageId === "parent-1")).toBe(true);
    });
  });

  describe("broken link detection", () => {
    test("detects broken internal links", async () => {
      const page: PageRecord = {
        pageId: "page-1",
        path: "page.md",
        title: "Test Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      await adapter.upsertPage(page);

      // Add broken link
      const brokenLink: LinkRecord = {
        sourcePageId: "page-1",
        targetPageId: null,
        targetPath: "./missing.md",
        linkType: "internal",
        linkText: "Broken link",
        lineNumber: 15,
        isBroken: true,
        createdAt: new Date().toISOString(),
      };

      // Add valid link
      const validLink: LinkRecord = {
        sourcePageId: "page-1",
        targetPageId: "page-1", // Self-link
        targetPath: "./page.md",
        linkType: "internal",
        linkText: "Valid link",
        lineNumber: 20,
        isBroken: false,
        createdAt: new Date().toISOString(),
      };

      await adapter.setPageLinks("page-1", [brokenLink, validLink]);

      const broken = await adapter.getBrokenLinks();
      expect(broken.length).toBe(1);
      expect(broken[0].targetPath).toBe("./missing.md");
      expect(broken[0].lineNumber).toBe(15);
    });
  });

  describe("external link inventory", () => {
    test("lists all external links", async () => {
      const page: PageRecord = {
        pageId: "page-1",
        path: "page.md",
        title: "Test Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      await adapter.upsertPage(page);

      const links: LinkRecord[] = [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "Example",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://github.com/test",
          linkType: "external",
          linkText: "GitHub",
          lineNumber: 20,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: "page-1",
          targetPath: "./page.md",
          linkType: "internal",
          linkText: "Internal",
          lineNumber: 30,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ];

      await adapter.setPageLinks("page-1", links);

      const external = await adapter.getExternalLinks();
      expect(external.length).toBe(2);
      expect(external.some((l) => l.targetPath === "https://example.com")).toBe(true);
      expect(external.some((l) => l.targetPath === "https://github.com/test")).toBe(true);
    });

    test("filters external links by page", async () => {
      const page1: PageRecord = {
        pageId: "page-1",
        path: "page1.md",
        title: "Page 1",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const page2: PageRecord = {
        ...page1,
        pageId: "page-2",
        path: "page2.md",
        title: "Page 2",
      };

      await adapter.upsertPage(page1);
      await adapter.upsertPage(page2);

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "Example",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "https://github.com",
          linkType: "external",
          linkText: "GitHub",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      // Get all external links
      const all = await adapter.getExternalLinks();
      expect(all.length).toBe(2);

      // Get external links for page-1 only
      const page1Links = await adapter.getExternalLinks("page-1");
      expect(page1Links.length).toBe(1);
      expect(page1Links[0].targetPath).toBe("https://example.com");
    });
  });

  describe("contributor risk detection", () => {
    test("detects single contributor (bus factor)", async () => {
      const page: PageRecord = {
        pageId: "page-1",
        path: "page.md",
        title: "Test Page",
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
        createdBy: "user-1",
        createdAt: new Date().toISOString(),
        lastModifiedBy: "user-1",
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      await adapter.upsertPage(page);
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "John Doe",
        email: "john@example.com",
        isActive: true,
        lastCheckedAt: new Date().toISOString(),
      });

      // Add single contributor
      await adapter.setPageContributors("page-1", [
        {
          pageId: "page-1",
          userId: "user-1",
          contributionCount: 5,
          lastContributedAt: new Date().toISOString(),
        },
      ]);

      const contributors = await adapter.getPageContributors("page-1");
      expect(contributors.length).toBe(1);
    });

    test("detects all inactive contributors", async () => {
      const page: PageRecord = {
        pageId: "page-1",
        path: "page.md",
        title: "Test Page",
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
        createdBy: "user-1",
        createdAt: new Date().toISOString(),
        lastModifiedBy: "user-2",
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      await adapter.upsertPage(page);

      // Add inactive users
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "John Doe",
        email: "john@example.com",
        isActive: false,
        lastCheckedAt: new Date().toISOString(),
      });

      await adapter.upsertUser({
        userId: "user-2",
        displayName: "Jane Doe",
        email: "jane@example.com",
        isActive: false,
        lastCheckedAt: new Date().toISOString(),
      });

      // Add multiple inactive contributors
      await adapter.setPageContributors("page-1", [
        {
          pageId: "page-1",
          userId: "user-1",
          contributionCount: 3,
          lastContributedAt: new Date().toISOString(),
        },
        {
          pageId: "page-1",
          userId: "user-2",
          contributionCount: 2,
          lastContributedAt: new Date().toISOString(),
        },
      ]);

      const contributors = await adapter.getPageContributors("page-1");
      expect(contributors.length).toBe(2);

      // Check all users are inactive
      const user1 = await adapter.getUser("user-1");
      const user2 = await adapter.getUser("user-2");
      expect(user1?.isActive).toBe(false);
      expect(user2?.isActive).toBe(false);
    });
  });

  describe("user cache age", () => {
    test("returns oldest user check timestamp", async () => {
      const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const newDate = new Date();

      await adapter.upsertUser({
        userId: "user-1",
        displayName: "Old User",
        email: "old@example.com",
        isActive: true,
        lastCheckedAt: oldDate.toISOString(),
      });

      await adapter.upsertUser({
        userId: "user-2",
        displayName: "New User",
        email: "new@example.com",
        isActive: true,
        lastCheckedAt: newDate.toISOString(),
      });

      const oldest = await adapter.getOldestUserCheck();
      expect(oldest).toBe(oldDate.toISOString());
    });
  });

  describe("missing label detection", () => {
    test("detects pages missing required label", async () => {
      const pageWithLabel: PageRecord = {
        pageId: "page-1",
        path: "page1.md",
        title: "Page With Label",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const pageWithoutLabel: PageRecord = {
        ...pageWithLabel,
        pageId: "page-2",
        path: "page2.md",
        title: "Page Without Label",
      };

      await adapter.upsertPage(pageWithLabel);
      await adapter.upsertPage(pageWithoutLabel);

      // Add label to page-1
      await adapter.setPageLabels("page-1", ["reviewed", "documentation"]);
      await adapter.setPageLabels("page-2", ["documentation"]);

      // Check page-1 has the reviewed label
      const labels1 = await adapter.getPageLabels("page-1");
      expect(labels1).toContain("reviewed");

      // Check page-2 does NOT have the reviewed label
      const labels2 = await adapter.getPageLabels("page-2");
      expect(labels2).not.toContain("reviewed");
      expect(labels2).toContain("documentation");
    });
  });

  describe("restricted page detection", () => {
    test("filters restricted pages", async () => {
      const publicPage: PageRecord = {
        pageId: "public-1",
        path: "public.md",
        title: "Public Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const restrictedPage: PageRecord = {
        ...publicPage,
        pageId: "restricted-1",
        path: "restricted.md",
        title: "Restricted Page",
        isRestricted: true,
      };

      await adapter.upsertPage(publicPage);
      await adapter.upsertPage(restrictedPage);

      // Filter restricted pages
      const restricted = await adapter.listPages({ isRestricted: true });
      expect(restricted.length).toBe(1);
      expect(restricted[0].pageId).toBe("restricted-1");

      // Filter non-restricted pages
      const nonRestricted = await adapter.listPages({ isRestricted: false });
      expect(nonRestricted.length).toBe(1);
      expect(nonRestricted[0].pageId).toBe("public-1");
    });
  });

  describe("content status detection", () => {
    test("filters draft pages", async () => {
      const currentPage: PageRecord = {
        pageId: "current-1",
        path: "current.md",
        title: "Current Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const draftPage: PageRecord = {
        ...currentPage,
        pageId: "draft-1",
        path: "draft.md",
        title: "Draft Page",
        contentStatus: "draft",
      };

      await adapter.upsertPage(currentPage);
      await adapter.upsertPage(draftPage);

      const drafts = await adapter.listPages({ contentStatus: "draft" });
      expect(drafts.length).toBe(1);
      expect(drafts[0].pageId).toBe("draft-1");
    });

    test("filters archived pages", async () => {
      const currentPage: PageRecord = {
        pageId: "current-1",
        path: "current.md",
        title: "Current Page",
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 1,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const archivedPage: PageRecord = {
        ...currentPage,
        pageId: "archived-1",
        path: "archived.md",
        title: "Archived Page",
        contentStatus: "archived",
      };

      await adapter.upsertPage(currentPage);
      await adapter.upsertPage(archivedPage);

      const archived = await adapter.listPages({ contentStatus: "archived" });
      expect(archived.length).toBe(1);
      expect(archived[0].pageId).toBe("archived-1");
    });
  });

  describe("high churn detection", () => {
    test("filters pages by minimum version count", async () => {
      const lowChurnPage: PageRecord = {
        pageId: "low-churn-1",
        path: "low-churn.md",
        title: "Low Churn Page",
        spaceKey: "TEST",
        version: 3,
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
        lastModified: null,
        contentStatus: "current",
        versionCount: 3,
        wordCount: null,
        isRestricted: false,
        syncCreatedAt: new Date().toISOString(),
        syncUpdatedAt: new Date().toISOString(),
        remoteInaccessibleAt: null,
        remoteInaccessibleReason: null,
      };

      const highChurnPage: PageRecord = {
        ...lowChurnPage,
        pageId: "high-churn-1",
        path: "high-churn.md",
        title: "High Churn Page",
        version: 50,
        versionCount: 50,
      };

      await adapter.upsertPage(lowChurnPage);
      await adapter.upsertPage(highChurnPage);

      // Find pages with >= 10 versions
      const highChurn = await adapter.listPages({ minVersionCount: 10 });
      expect(highChurn.length).toBe(1);
      expect(highChurn[0].pageId).toBe("high-churn-1");
      expect(highChurn[0].versionCount).toBe(50);

      // Find pages with >= 3 versions (both should match)
      const all = await adapter.listPages({ minVersionCount: 3 });
      expect(all.length).toBe(2);
    });
  });
});
