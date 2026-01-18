import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteAdapter } from "./sqlite-adapter.js";
import { createPageRecord, createAttachmentRecord } from "./types.js";
import type {
  PageRecord,
  AttachmentRecord,
  LinkRecord,
  UserRecord,
  ContributorRecord,
  ContentPropertyRecord,
} from "./types.js";

describe("SqliteAdapter", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    // Use in-memory database for tests
    adapter = new SqliteAdapter({ dbPath: ":memory:" });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe("lifecycle", () => {
    test("init creates database and tables", async () => {
      expect(adapter.version).toBe(1);
      expect(adapter.adapterType).toBe("sqlite");
    });

    test("close finalizes connection", async () => {
      await adapter.close();
      // Should not throw on double close
      await adapter.close();
    });
  });

  describe("pages", () => {
    test("upsertPage and getPage", async () => {
      const page = createPageRecord({
        pageId: "123",
        path: "test/page.md",
        title: "Test Page",
        spaceKey: "TEST",
        version: 1,
        syncState: "synced",
      });

      await adapter.upsertPage(page);
      const retrieved = await adapter.getPage("123");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.pageId).toBe("123");
      expect(retrieved?.title).toBe("Test Page");
      expect(retrieved?.spaceKey).toBe("TEST");
    });

    test("getPageByPath", async () => {
      const page = createPageRecord({
        pageId: "456",
        path: "docs/guide.md",
        title: "Guide",
        spaceKey: "DOCS",
      });

      await adapter.upsertPage(page);
      const retrieved = await adapter.getPageByPath("docs/guide.md");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.pageId).toBe("456");
    });

    test("deletePage", async () => {
      const page = createPageRecord({
        pageId: "789",
        path: "to-delete.md",
        title: "Delete Me",
        spaceKey: "TEST",
      });

      await adapter.upsertPage(page);
      expect(await adapter.getPage("789")).not.toBeNull();

      await adapter.deletePage("789");
      expect(await adapter.getPage("789")).toBeNull();
    });

    test("listPages with no filter", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "1",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "2",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
        })
      );

      const pages = await adapter.listPages();
      expect(pages.length).toBe(2);
    });

    test("listPages with filter", async () => {
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
      await adapter.upsertPage(
        createPageRecord({
          pageId: "3",
          path: "c.md",
          title: "C",
          spaceKey: "OTHER",
          syncState: "synced",
        })
      );

      // Filter by sync state
      let pages = await adapter.listPages({ syncState: "synced" });
      expect(pages.length).toBe(2);

      // Filter by space key
      pages = await adapter.listPages({ spaceKey: "TEST" });
      expect(pages.length).toBe(2);

      // Filter by both
      pages = await adapter.listPages({ spaceKey: "TEST", syncState: "synced" });
      expect(pages.length).toBe(1);
    });

    test("listPages with pathPrefix filter", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "1",
          path: "docs/guide.md",
          title: "Guide",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "2",
          path: "docs/api.md",
          title: "API",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "3",
          path: "other/file.md",
          title: "Other",
          spaceKey: "TEST",
        })
      );

      const pages = await adapter.listPages({ pathPrefix: "docs/" });
      expect(pages.length).toBe(2);
    });

    test("countPages", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "1",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "2",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
        })
      );

      expect(await adapter.countPages()).toBe(2);
      expect(await adapter.countPages({ spaceKey: "OTHER" })).toBe(0);
    });

    test("upsert updates existing page", async () => {
      const page = createPageRecord({
        pageId: "123",
        path: "test.md",
        title: "Original",
        spaceKey: "TEST",
      });

      await adapter.upsertPage(page);

      const updated = { ...page, title: "Updated" };
      await adapter.upsertPage(updated);

      const retrieved = await adapter.getPage("123");
      expect(retrieved?.title).toBe("Updated");
    });
  });

  describe("attachments", () => {
    test("upsertAttachment and getAttachment", async () => {
      // First create a page
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      const attachment = createAttachmentRecord({
        attachmentId: "att-1",
        pageId: "page-1",
        filename: "image.png",
        localPath: "page.attachments/image.png",
        mediaType: "image/png",
        fileSize: 1024,
      });

      await adapter.upsertAttachment(attachment);
      const retrieved = await adapter.getAttachment("att-1");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.filename).toBe("image.png");
    });

    test("getAttachmentsByPage", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.upsertAttachment(
        createAttachmentRecord({
          attachmentId: "att-1",
          pageId: "page-1",
          filename: "a.png",
          localPath: "a.png",
          mediaType: "image/png",
        })
      );
      await adapter.upsertAttachment(
        createAttachmentRecord({
          attachmentId: "att-2",
          pageId: "page-1",
          filename: "b.pdf",
          localPath: "b.pdf",
          mediaType: "application/pdf",
        })
      );

      const attachments = await adapter.getAttachmentsByPage("page-1");
      expect(attachments.length).toBe(2);
    });

    test("deleteAttachment", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.upsertAttachment(
        createAttachmentRecord({
          attachmentId: "att-1",
          pageId: "page-1",
          filename: "file.png",
          localPath: "file.png",
          mediaType: "image/png",
        })
      );

      await adapter.deleteAttachment("att-1");
      expect(await adapter.getAttachment("att-1")).toBeNull();
    });
  });

  describe("links", () => {
    test("setPageLinks and getOutgoingLinks", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "source.md",
          title: "Source",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-2",
          path: "target.md",
          title: "Target",
          spaceKey: "TEST",
        })
      );

      const links: LinkRecord[] = [
        {
          sourcePageId: "page-1",
          targetPageId: "page-2",
          targetPath: null,
          linkType: "internal",
          linkText: "Link to Target",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ];

      await adapter.setPageLinks("page-1", links);
      const outgoing = await adapter.getOutgoingLinks("page-1");

      expect(outgoing.length).toBe(1);
      expect(outgoing[0].targetPageId).toBe("page-2");
    });

    test("getIncomingLinks", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "source.md",
          title: "Source",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-2",
          path: "target.md",
          title: "Target",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: "page-2",
          targetPath: null,
          linkType: "internal",
          linkText: null,
          lineNumber: null,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      const incoming = await adapter.getIncomingLinks("page-2");
      expect(incoming.length).toBe(1);
      expect(incoming[0].sourcePageId).toBe("page-1");
    });

    test("getOrphanedPages", async () => {
      // Page with no incoming links and no parent
      await adapter.upsertPage(
        createPageRecord({
          pageId: "orphan",
          path: "orphan.md",
          title: "Orphan",
          spaceKey: "TEST",
          parentId: null,
        })
      );

      // Page with incoming link
      await adapter.upsertPage(
        createPageRecord({
          pageId: "linked",
          path: "linked.md",
          title: "Linked",
          spaceKey: "TEST",
          parentId: null,
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

      // Page with parent (not orphan even without links)
      await adapter.upsertPage(
        createPageRecord({
          pageId: "child",
          path: "child.md",
          title: "Child",
          spaceKey: "TEST",
          parentId: "orphan",
        })
      );

      const orphans = await adapter.getOrphanedPages();
      expect(orphans.length).toBe(1);
      expect(orphans[0].pageId).toBe("orphan");
    });

    test("getBrokenLinks", async () => {
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
      expect(broken[0].targetPath).toBe("./missing.md");
    });

    test("getExternalLinks returns all external links", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page1.md",
          title: "Page 1",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-2",
          path: "page2.md",
          title: "Page 2",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageLinks("page-1", [
        {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "https://github.com/example",
          linkType: "external",
          linkText: "GitHub",
          lineNumber: 10,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        {
          sourcePageId: "page-1",
          targetPageId: "page-2",
          targetPath: "./page2.md",
          linkType: "internal",
          linkText: "Page 2",
          lineNumber: 15,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      await adapter.setPageLinks("page-2", [
        {
          sourcePageId: "page-2",
          targetPageId: null,
          targetPath: "https://docs.atlassian.com",
          linkType: "external",
          linkText: "Atlassian Docs",
          lineNumber: 5,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      // Get all external links
      const allExternal = await adapter.getExternalLinks();
      expect(allExternal.length).toBe(2);
      expect(allExternal.map((l) => l.targetPath)).toContain("https://github.com/example");
      expect(allExternal.map((l) => l.targetPath)).toContain("https://docs.atlassian.com");

      // Get external links for specific page
      const page1External = await adapter.getExternalLinks("page-1");
      expect(page1External.length).toBe(1);
      expect(page1External[0].targetPath).toBe("https://github.com/example");

      const page2External = await adapter.getExternalLinks("page-2");
      expect(page2External.length).toBe(1);
      expect(page2External[0].targetPath).toBe("https://docs.atlassian.com");
    });
  });

  describe("users", () => {
    test("upsertUser and getUser", async () => {
      const user: UserRecord = {
        userId: "user-1",
        displayName: "John Doe",
        email: "john@example.com",
        isActive: true,
        lastCheckedAt: new Date().toISOString(),
      };

      await adapter.upsertUser(user);
      const retrieved = await adapter.getUser("user-1");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.displayName).toBe("John Doe");
      expect(retrieved?.isActive).toBe(true);
    });

    test("listUsers", async () => {
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "User 1",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });
      await adapter.upsertUser({
        userId: "user-2",
        displayName: "User 2",
        email: null,
        isActive: false,
        lastCheckedAt: null,
      });

      const users = await adapter.listUsers();
      expect(users.length).toBe(2);
    });

    test("isActive three-state (null, true, false)", async () => {
      // Unknown status
      await adapter.upsertUser({
        userId: "unknown",
        displayName: "Unknown",
        email: null,
        isActive: null,
        lastCheckedAt: null,
      });

      // Active user
      await adapter.upsertUser({
        userId: "active",
        displayName: "Active",
        email: null,
        isActive: true,
        lastCheckedAt: new Date().toISOString(),
      });

      // Inactive user
      await adapter.upsertUser({
        userId: "inactive",
        displayName: "Inactive",
        email: null,
        isActive: false,
        lastCheckedAt: new Date().toISOString(),
      });

      expect((await adapter.getUser("unknown"))?.isActive).toBeNull();
      expect((await adapter.getUser("active"))?.isActive).toBe(true);
      expect((await adapter.getUser("inactive"))?.isActive).toBe(false);
    });

    test("getOldestUserCheck returns oldest lastCheckedAt", async () => {
      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

      // User with no lastCheckedAt should be excluded
      await adapter.upsertUser({
        userId: "unchecked",
        displayName: "Unchecked",
        email: null,
        isActive: null,
        lastCheckedAt: null,
      });

      // User checked 3 days ago
      await adapter.upsertUser({
        userId: "recent",
        displayName: "Recent",
        email: null,
        isActive: true,
        lastCheckedAt: threeDaysAgo,
      });

      // User checked 1 week ago (oldest)
      await adapter.upsertUser({
        userId: "old",
        displayName: "Old",
        email: null,
        isActive: true,
        lastCheckedAt: oneWeekAgo,
      });

      // User checked yesterday
      await adapter.upsertUser({
        userId: "yesterday",
        displayName: "Yesterday",
        email: null,
        isActive: false,
        lastCheckedAt: yesterday,
      });

      const oldest = await adapter.getOldestUserCheck();
      expect(oldest).toBe(oneWeekAgo);
    });

    test("getOldestUserCheck returns null when no users have been checked", async () => {
      await adapter.upsertUser({
        userId: "unchecked1",
        displayName: "Unchecked 1",
        email: null,
        isActive: null,
        lastCheckedAt: null,
      });

      const oldest = await adapter.getOldestUserCheck();
      expect(oldest).toBeNull();
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

      await adapter.setPageLabels("page-1", ["important", "reviewed"]);
      const labels = await adapter.getPageLabels("page-1");

      expect(labels.length).toBe(2);
      expect(labels).toContain("important");
      expect(labels).toContain("reviewed");
    });

    test("getPagesWithLabel", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-2",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageLabels("page-1", ["featured"]);
      await adapter.setPageLabels("page-2", ["featured", "other"]);

      const pages = await adapter.getPagesWithLabel("featured");
      expect(pages.length).toBe(2);
    });

    test("listAllLabels", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageLabels("page-1", ["alpha", "beta", "gamma"]);
      const labels = await adapter.listAllLabels();

      expect(labels).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  describe("contributors", () => {
    test("setPageContributors and getPageContributors", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "User",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });

      const contributors: ContributorRecord[] = [
        {
          pageId: "page-1",
          userId: "user-1",
          contributionCount: 5,
          lastContributedAt: new Date().toISOString(),
        },
      ];

      await adapter.setPageContributors("page-1", contributors);
      const retrieved = await adapter.getPageContributors("page-1");

      expect(retrieved.length).toBe(1);
      expect(retrieved[0].contributionCount).toBe(5);
    });

    test("getTopContributors", async () => {
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "User 1",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });
      await adapter.upsertUser({
        userId: "user-2",
        displayName: "User 2",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });

      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "a.md",
          title: "A",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-2",
          path: "b.md",
          title: "B",
          spaceKey: "TEST",
        })
      );

      await adapter.setPageContributors("page-1", [
        { pageId: "page-1", userId: "user-1", contributionCount: 10, lastContributedAt: null },
        { pageId: "page-1", userId: "user-2", contributionCount: 5, lastContributedAt: null },
      ]);
      await adapter.setPageContributors("page-2", [
        { pageId: "page-2", userId: "user-1", contributionCount: 3, lastContributedAt: null },
      ]);

      const top = await adapter.getTopContributors(10);
      expect(top.length).toBe(2);
      expect(top[0].userId).toBe("user-1"); // 13 total contributions
      expect(top[0].totalContributions).toBe(13);
      expect(top[0].pageCount).toBe(2);
    });
  });

  describe("content properties", () => {
    test("setContentProperties and getContentProperties", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      const props: ContentPropertyRecord[] = [
        {
          pageId: "page-1",
          key: "app.setting",
          valueJson: { enabled: true },
          version: 1,
          lastSyncedAt: new Date().toISOString(),
        },
      ];

      await adapter.setContentProperties("page-1", props);
      const retrieved = await adapter.getContentProperties("page-1");

      expect(retrieved.length).toBe(1);
      expect(retrieved[0].valueJson).toEqual({ enabled: true });
    });

    test("getContentProperty", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.setContentProperties("page-1", [
        {
          pageId: "page-1",
          key: "my.prop",
          valueJson: 42,
          version: 1,
          lastSyncedAt: new Date().toISOString(),
        },
      ]);

      const prop = await adapter.getContentProperty("page-1", "my.prop");
      expect(prop).not.toBeNull();
      expect(prop?.valueJson).toBe(42);
    });
  });

  describe("remote accessibility", () => {
    test("markAsInaccessible and getInaccessiblePages", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.markAsInaccessible("page-1", "not_found");

      const page = await adapter.getPage("page-1");
      expect(page?.remoteInaccessibleAt).not.toBeNull();
      expect(page?.remoteInaccessibleReason).toBe("not_found");

      const inaccessible = await adapter.getInaccessiblePages();
      expect(inaccessible.length).toBe(1);
    });

    test("markAsAccessible clears inaccessible state", async () => {
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );

      await adapter.markAsInaccessible("page-1", "forbidden");
      expect((await adapter.getPage("page-1"))?.remoteInaccessibleAt).not.toBeNull();

      await adapter.markAsAccessible("page-1");
      const page = await adapter.getPage("page-1");
      expect(page?.remoteInaccessibleAt).toBeNull();
      expect(page?.remoteInaccessibleReason).toBeNull();
    });

    test("listPages excludes inaccessible by default", async () => {
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

      const pages = await adapter.listPages();
      expect(pages.length).toBe(1);
      expect(pages[0].pageId).toBe("accessible");

      // With includeInaccessible
      const allPages = await adapter.listPages({ includeInaccessible: true });
      expect(allPages.length).toBe(2);
    });
  });

  describe("metadata", () => {
    test("getMeta and setMeta", async () => {
      await adapter.setMeta("last_sync", "2024-01-01T00:00:00Z");
      const value = await adapter.getMeta("last_sync");
      expect(value).toBe("2024-01-01T00:00:00Z");
    });

    test("deleteMeta", async () => {
      await adapter.setMeta("key", "value");
      await adapter.deleteMeta("key");
      expect(await adapter.getMeta("key")).toBeNull();
    });
  });

  describe("transactions", () => {
    test("transaction commits on success", async () => {
      await adapter.transaction(async (tx) => {
        await tx.upsertPage(
          createPageRecord({
            pageId: "tx-page",
            path: "tx.md",
            title: "TX",
            spaceKey: "TEST",
          })
        );
      });

      expect(await adapter.getPage("tx-page")).not.toBeNull();
    });

    test("transaction rolls back on error", async () => {
      try {
        await adapter.transaction(async (tx) => {
          await tx.upsertPage(
            createPageRecord({
              pageId: "rollback-page",
              path: "rollback.md",
              title: "Rollback",
              spaceKey: "TEST",
            })
          );
          throw new Error("Force rollback");
        });
      } catch {
        // Expected
      }

      expect(await adapter.getPage("rollback-page")).toBeNull();
    });
  });

  describe("export/import", () => {
    test("exportToJson and importFromJson", async () => {
      // Create some data
      await adapter.upsertPage(
        createPageRecord({
          pageId: "page-1",
          path: "page.md",
          title: "Page",
          spaceKey: "TEST",
        })
      );
      await adapter.upsertUser({
        userId: "user-1",
        displayName: "User",
        email: null,
        isActive: true,
        lastCheckedAt: null,
      });
      await adapter.setMeta("key", "value");

      // Export
      const exported = await adapter.exportToJson();
      expect(exported.pages.length).toBe(1);
      expect(exported.users.length).toBe(1);

      // Create new adapter and import
      const newAdapter = new SqliteAdapter({ dbPath: ":memory:" });
      await newAdapter.init();
      await newAdapter.importFromJson(exported);

      // Verify
      expect(await newAdapter.countPages()).toBe(1);
      expect((await newAdapter.listUsers()).length).toBe(1);
      expect(await newAdapter.getMeta("key")).toBe("value");

      await newAdapter.close();
    });
  });
});
