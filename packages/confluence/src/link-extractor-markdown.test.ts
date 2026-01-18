import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLinksFromMarkdown,
  extractLinksFromMarkdownToRecords,
  findBrokenLinks,
  getLinkStats,
  compareLinkSets,
  type MarkdownLinkWithResolution,
} from "./link-extractor-markdown.js";
import type { SyncDbAdapter, PageRecord } from "./sync-db/types.js";

/**
 * Helper to create a mock PageRecord with required fields.
 */
function createMockPageRecord(overrides: Partial<PageRecord> = {}): PageRecord {
  const now = new Date().toISOString();
  return {
    pageId: "mock-page-id",
    path: "mock-page.md",
    title: "Mock Page",
    spaceKey: "TEST",
    version: 1,
    lastSyncedAt: now,
    localHash: "abc123",
    remoteHash: "abc123",
    baseHash: "abc123",
    syncState: "synced",
    parentId: null,
    ancestors: [],
    hasAttachments: false,
    contentType: "page",
    createdBy: "user-123",
    createdAt: now,
    lastModifiedBy: "user-123",
    lastModified: now,
    contentStatus: "current",
    versionCount: 1,
    wordCount: null,
    isRestricted: false,
    syncCreatedAt: now,
    syncUpdatedAt: now,
    remoteInaccessibleAt: null,
    remoteInaccessibleReason: null,
    ...overrides,
  };
}

/**
 * Helper to create a mock MarkdownLinkWithResolution.
 */
function createMockLink(overrides: Partial<MarkdownLinkWithResolution> = {}): MarkdownLinkWithResolution {
  return {
    type: "relative-path",
    target: "./page.md",
    text: "Page",
    line: 1,
    column: 1,
    raw: "[Page](./page.md)",
    resolvedPath: "page.md",
    resolvedPageId: null,
    isResolved: false,
    isBroken: false,
    ...overrides,
  };
}

describe("extractLinksFromMarkdown", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "link-extract-"));
    rootDir = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("extracts relative path links", async () => {
    const markdown = `
# Test Document

See [other page](./other-page.md) for details.
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
    });

    expect(links.length).toBe(1);
    expect(links[0].type).toBe("relative-path");
    expect(links[0].target).toBe("./other-page.md");
    expect(links[0].text).toBe("other page");
    expect(links[0].resolvedPath).toBe("other-page.md");
  });

  test("extracts external links", async () => {
    const markdown = `
Visit [Example](https://example.com) for more info.
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
      includeExternal: true,
    });

    expect(links.length).toBe(1);
    expect(links[0].type).toBe("external");
    expect(links[0].target).toBe("https://example.com");
    expect(links[0].isResolved).toBe(true);
  });

  test("excludes external links when disabled", async () => {
    const markdown = `
Visit [Example](https://example.com) for more info.
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
      includeExternal: false,
    });

    expect(links.length).toBe(0);
  });

  test("extracts anchor links when enabled", async () => {
    const markdown = `
Jump to [Section 1](#section-1).
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
      includeAnchors: true,
    });

    expect(links.length).toBe(1);
    expect(links[0].type).toBe("anchor");
    expect(links[0].isResolved).toBe(true);
  });

  test("excludes anchor links by default", async () => {
    const markdown = `
Jump to [Section 1](#section-1).
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
    });

    expect(links.length).toBe(0);
  });

  test("resolves relative paths from subdirectories", async () => {
    const markdown = `
See [parent page](../parent.md) and [sibling](./sibling.md).
`;
    await mkdir(join(rootDir, "subdir"));
    const filePath = join(rootDir, "subdir", "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
    });

    expect(links.length).toBe(2);
    expect(links[0].resolvedPath).toBe("parent.md");
    expect(links[1].resolvedPath).toBe("subdir/sibling.md");
  });

  test("strips anchor from resolved path", async () => {
    const markdown = `
See [section](./page.md#section).
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
    });

    expect(links.length).toBe(1);
    expect(links[0].resolvedPath).toBe("page.md");
  });

  test("resolves page ID via adapter", async () => {
    const markdown = `
See [other](./other-page.md).
`;
    const filePath = join(rootDir, "test.md");

    const mockAdapter: Partial<SyncDbAdapter> = {
      getPageByPath: async (path: string) => {
        if (path === "other-page.md") {
          return createMockPageRecord({ pageId: "12345", path: "other-page.md", title: "Other Page" });
        }
        return null;
      },
    };

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
      adapter: mockAdapter as SyncDbAdapter,
    });

    expect(links.length).toBe(1);
    expect(links[0].resolvedPageId).toBe("12345");
    expect(links[0].isResolved).toBe(true);
    expect(links[0].isBroken).toBe(false);
  });

  test("marks link as broken when page not found", async () => {
    const markdown = `
See [missing](./missing-page.md).
`;
    const filePath = join(rootDir, "test.md");

    const mockAdapter: Partial<SyncDbAdapter> = {
      getPageByPath: async () => null,
    };

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
      adapter: mockAdapter as SyncDbAdapter,
    });

    expect(links.length).toBe(1);
    expect(links[0].resolvedPageId).toBeNull();
    expect(links[0].isBroken).toBe(true);
  });

  test("extracts multiple links", async () => {
    const markdown = `
# Links

- [Page 1](./page1.md)
- [Page 2](./page2.md)
- [External](https://example.com)
`;
    const filePath = join(rootDir, "test.md");

    const links = await extractLinksFromMarkdown(markdown, {
      filePath,
      rootDir,
    });

    expect(links.length).toBe(3);
    expect(links.filter((l) => l.type === "relative-path")).toHaveLength(2);
    expect(links.filter((l) => l.type === "external")).toHaveLength(1);
  });
});

describe("extractLinksFromMarkdownToRecords", () => {
  test("converts links to LinkRecord format", async () => {
    const markdown = `
See [other](./other.md).
`;
    const records = await extractLinksFromMarkdownToRecords(
      markdown,
      "source-page-123",
      {
        filePath: "/root/test.md",
        rootDir: "/root",
      }
    );

    expect(records.length).toBe(1);
    expect(records[0].sourcePageId).toBe("source-page-123");
    expect(records[0].targetPath).toBe("./other.md");
    expect(records[0].linkType).toBe("internal");
    expect(records[0].linkText).toBe("other");
    expect(records[0].createdAt).toBeDefined();
  });

  test("maps link types correctly", async () => {
    const markdown = `
[Internal](./page.md)
[External](https://example.com)
`;
    const records = await extractLinksFromMarkdownToRecords(
      markdown,
      "source",
      {
        filePath: "/root/test.md",
        rootDir: "/root",
      }
    );

    expect(records.length).toBe(2);
    expect(records[0].linkType).toBe("internal");
    expect(records[1].linkType).toBe("external");
  });
});

describe("findBrokenLinks", () => {
  test("returns only broken links", async () => {
    const markdown = `
[Good](./good.md)
[Bad](./bad.md)
`;
    const mockAdapter: Partial<SyncDbAdapter> = {
      getPageByPath: async (path: string) => {
        if (path === "good.md") {
          return createMockPageRecord({ pageId: "123", path: "good.md", title: "Good" });
        }
        return null;
      },
    };

    const broken = await findBrokenLinks(markdown, {
      filePath: "/root/test.md",
      rootDir: "/root",
      adapter: mockAdapter as SyncDbAdapter,
    });

    expect(broken.length).toBe(1);
    expect(broken[0].target).toBe("./bad.md");
  });
});

describe("getLinkStats", () => {
  test("returns accurate statistics", async () => {
    const markdown = `
[Page 1](./page1.md)
[Page 2](./page2.md)
[External](https://example.com)
[Another External](https://test.com)
[Section](#section)
`;
    const stats = await getLinkStats(markdown, {
      filePath: "/root/test.md",
      rootDir: "/root",
      includeAnchors: true,
    });

    expect(stats.total).toBe(5);
    expect(stats.internal).toBe(2);
    expect(stats.external).toBe(2);
    expect(stats.anchors).toBe(1);
  });
});

describe("compareLinkSets", () => {
  test("identifies added links", () => {
    const oldLinks: MarkdownLinkWithResolution[] = [
      createMockLink({ target: "./page1.md", text: "Page 1", line: 1, resolvedPath: "page1.md" }),
    ];
    const newLinks: MarkdownLinkWithResolution[] = [
      createMockLink({ target: "./page1.md", text: "Page 1", line: 1, resolvedPath: "page1.md" }),
      createMockLink({ target: "./page2.md", text: "Page 2", line: 2, resolvedPath: "page2.md" }),
    ];

    const result = compareLinkSets(oldLinks, newLinks);

    expect(result.added.length).toBe(1);
    expect(result.added[0].target).toBe("./page2.md");
    expect(result.removed.length).toBe(0);
    expect(result.unchanged.length).toBe(1);
  });

  test("identifies removed links", () => {
    const oldLinks: MarkdownLinkWithResolution[] = [
      createMockLink({ target: "./page1.md", text: "Page 1", line: 1, resolvedPath: "page1.md" }),
      createMockLink({ target: "./page2.md", text: "Page 2", line: 2, resolvedPath: "page2.md" }),
    ];
    const newLinks: MarkdownLinkWithResolution[] = [
      createMockLink({ target: "./page1.md", text: "Page 1", line: 1, resolvedPath: "page1.md" }),
    ];

    const result = compareLinkSets(oldLinks, newLinks);

    expect(result.removed.length).toBe(1);
    expect(result.removed[0].target).toBe("./page2.md");
    expect(result.added.length).toBe(0);
    expect(result.unchanged.length).toBe(1);
  });

  test("handles empty sets", () => {
    const result = compareLinkSets([], []);

    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(0);
    expect(result.unchanged.length).toBe(0);
  });
});
