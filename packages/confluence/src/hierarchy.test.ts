import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  computeFilePath,
  parseFilePath,
  moveFile,
  getChildDirectory,
  buildPathMap,
  hasPageMoved,
  validatePathHierarchy,
  PageHierarchyInfo,
  // Index pattern migration
  usesSiblingPattern,
  siblingToIndexPath,
  detectSiblingPatternMigrations,
  migrateSiblingToIndex,
} from "./hierarchy.js";

describe("hierarchy utilities", () => {
  describe("computeFilePath", () => {
    test("computes path for root-level page", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "Getting Started",
        parentId: null,
        ancestors: [],
      };
      const ancestorTitles = new Map([["100", "Getting Started"]]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("getting-started.md");
      expect(result.directory).toBe("");
      expect(result.filename).toBe("getting-started.md");
      expect(result.slug).toBe("getting-started");
    });

    test("computes nested path for child page", () => {
      const page: PageHierarchyInfo = {
        id: "101",
        title: "Installation",
        parentId: "100",
        ancestors: ["100"],
      };
      const ancestorTitles = new Map([
        ["100", "Getting Started"],
        ["101", "Installation"],
      ]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("getting-started/installation.md");
      expect(result.directory).toBe("getting-started");
      expect(result.filename).toBe("installation.md");
    });

    test("computes deeply nested path", () => {
      const page: PageHierarchyInfo = {
        id: "103",
        title: "Linux Setup",
        parentId: "102",
        ancestors: ["100", "101", "102"],
      };
      const ancestorTitles = new Map([
        ["100", "Docs"],
        ["101", "Getting Started"],
        ["102", "Installation"],
        ["103", "Linux Setup"],
      ]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("docs/getting-started/installation/linux-setup.md");
    });

    test("handles special characters in titles", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "API Reference (v2.0)",
        parentId: null,
        ancestors: [],
      };
      const ancestorTitles = new Map([["100", "API Reference (v2.0)"]]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("api-reference-v2-0.md");
    });

    test("avoids duplicate paths", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "Test",
        parentId: null,
        ancestors: [],
      };
      const ancestorTitles = new Map([["100", "Test"]]);
      const existingPaths = new Set(["test.md"]);

      const result = computeFilePath(page, ancestorTitles, existingPaths);

      expect(result.relativePath).toBe("test-2.md");
    });

    test("handles empty title", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "",
        parentId: null,
        ancestors: [],
      };
      const ancestorTitles = new Map([["100", ""]]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("page.md");
    });
  });

  describe("parseFilePath", () => {
    test("parses root-level file", () => {
      const result = parseFilePath("getting-started.md");

      expect(result.slug).toBe("getting-started");
      expect(result.parentSlug).toBeNull();
      expect(result.ancestorSlugs).toEqual([]);
    });

    test("parses nested file", () => {
      const result = parseFilePath("getting-started/installation.md");

      expect(result.slug).toBe("installation");
      expect(result.parentSlug).toBe("getting-started");
      expect(result.ancestorSlugs).toEqual(["getting-started"]);
    });

    test("parses deeply nested file", () => {
      const result = parseFilePath("docs/getting-started/installation/linux.md");

      expect(result.slug).toBe("linux");
      expect(result.parentSlug).toBe("installation");
      expect(result.ancestorSlugs).toEqual(["docs", "getting-started", "installation"]);
    });
  });

  describe("getChildDirectory", () => {
    test("returns slug for root-level page", () => {
      expect(getChildDirectory("parent.md")).toBe("parent");
    });

    test("returns nested path for nested page", () => {
      expect(getChildDirectory("docs/parent.md")).toBe("docs/parent");
    });
  });

  describe("hasPageMoved", () => {
    test("returns false for identical ancestors", () => {
      expect(hasPageMoved(["100", "101"], ["100", "101"])).toBe(false);
    });

    test("returns true for different ancestors", () => {
      expect(hasPageMoved(["100", "101"], ["100", "102"])).toBe(true);
    });

    test("returns true for different length", () => {
      expect(hasPageMoved(["100"], ["100", "101"])).toBe(true);
    });

    test("returns false for empty ancestors", () => {
      expect(hasPageMoved([], [])).toBe(false);
    });

    test("returns true when moved to root", () => {
      expect(hasPageMoved(["100"], [])).toBe(true);
    });
  });

  describe("validatePathHierarchy", () => {
    test("validates root-level file", () => {
      expect(validatePathHierarchy("page.md", null)).toBe(true);
    });

    test("validates nested file", () => {
      expect(validatePathHierarchy("parent/child.md", "parent")).toBe(true);
    });

    test("invalidates mismatched parent", () => {
      expect(validatePathHierarchy("other/child.md", "parent")).toBe(false);
    });
  });

  describe("buildPathMap", () => {
    test("builds paths for flat structure", () => {
      const pages: PageHierarchyInfo[] = [
        { id: "100", title: "Page A", parentId: null, ancestors: [] },
        { id: "101", title: "Page B", parentId: null, ancestors: [] },
      ];

      const pathMap = buildPathMap(pages);

      expect(pathMap.get("100")?.relativePath).toBe("page-a.md");
      expect(pathMap.get("101")?.relativePath).toBe("page-b.md");
    });

    test("builds paths for hierarchical structure", () => {
      const pages: PageHierarchyInfo[] = [
        { id: "100", title: "Parent", parentId: null, ancestors: [] },
        { id: "101", title: "Child", parentId: "100", ancestors: ["100"] },
        { id: "102", title: "Grandchild", parentId: "101", ancestors: ["100", "101"] },
      ];

      const pathMap = buildPathMap(pages);

      expect(pathMap.get("100")?.relativePath).toBe("parent.md");
      expect(pathMap.get("101")?.relativePath).toBe("parent/child.md");
      expect(pathMap.get("102")?.relativePath).toBe("parent/child/grandchild.md");
    });

    test("handles pages in unsorted order", () => {
      const pages: PageHierarchyInfo[] = [
        // Grandchild first
        { id: "102", title: "Grandchild", parentId: "101", ancestors: ["100", "101"] },
        // Then parent
        { id: "100", title: "Parent", parentId: null, ancestors: [] },
        // Then child
        { id: "101", title: "Child", parentId: "100", ancestors: ["100"] },
      ];

      const pathMap = buildPathMap(pages);

      // Should still compute correct paths
      expect(pathMap.get("100")?.relativePath).toBe("parent.md");
      expect(pathMap.get("101")?.relativePath).toBe("parent/child.md");
      expect(pathMap.get("102")?.relativePath).toBe("parent/child/grandchild.md");
    });

    test("avoids existing paths", () => {
      const pages: PageHierarchyInfo[] = [
        { id: "100", title: "Test", parentId: null, ancestors: [] },
      ];
      const existingPaths = new Set(["test.md"]);

      const pathMap = buildPathMap(pages, existingPaths);

      expect(pathMap.get("100")?.relativePath).toBe("test-2.md");
    });
  });

  describe("moveFile", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "hierarchy-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    test("moves file to new location", async () => {
      // Create source file
      await writeFile(join(tempDir, "old.md"), "content");

      await moveFile(tempDir, "old.md", "new.md");

      expect(existsSync(join(tempDir, "old.md"))).toBe(false);
      expect(existsSync(join(tempDir, "new.md"))).toBe(true);
      expect(await readFile(join(tempDir, "new.md"), "utf-8")).toBe("content");
    });

    test("creates directories for nested destination", async () => {
      await writeFile(join(tempDir, "page.md"), "content");

      await moveFile(tempDir, "page.md", "parent/child/page.md");

      expect(existsSync(join(tempDir, "page.md"))).toBe(false);
      expect(existsSync(join(tempDir, "parent/child/page.md"))).toBe(true);
    });

    test("moves file from nested to root", async () => {
      await mkdir(join(tempDir, "parent"), { recursive: true });
      await writeFile(join(tempDir, "parent/page.md"), "content");

      await moveFile(tempDir, "parent/page.md", "page.md");

      expect(existsSync(join(tempDir, "parent/page.md"))).toBe(false);
      expect(existsSync(join(tempDir, "page.md"))).toBe(true);
    });

    test("throws error for non-existent source", async () => {
      await expect(
        moveFile(tempDir, "nonexistent.md", "new.md")
      ).rejects.toThrow("Source file does not exist");
    });

    test("cleans up empty parent directories", async () => {
      await mkdir(join(tempDir, "empty/nested"), { recursive: true });
      await writeFile(join(tempDir, "empty/nested/page.md"), "content");

      await moveFile(tempDir, "empty/nested/page.md", "page.md");

      expect(existsSync(join(tempDir, "empty/nested"))).toBe(false);
      expect(existsSync(join(tempDir, "empty"))).toBe(false);
    });
  });

  // ============ Index Pattern Tests ============

  describe("computeFilePath - index pattern", () => {
    test("leaf page uses slug.md pattern", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "Leaf Page",
        parentId: null,
        ancestors: [],
        hasChildren: false,
      };
      const ancestorTitles = new Map([["100", "Leaf Page"]]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("leaf-page.md");
      expect(result.isIndex).toBe(false);
    });

    test("page with children uses index.md pattern", () => {
      const page: PageHierarchyInfo = {
        id: "100",
        title: "Parent Page",
        parentId: null,
        ancestors: [],
        hasChildren: true,
      };
      const ancestorTitles = new Map([["100", "Parent Page"]]);

      const result = computeFilePath(page, ancestorTitles);

      expect(result.relativePath).toBe("parent-page/index.md");
      expect(result.directory).toBe("parent-page");
      expect(result.filename).toBe("index.md");
      expect(result.isIndex).toBe(true);
    });

    test("folder always uses index.md pattern", () => {
      const folder: PageHierarchyInfo = {
        id: "100",
        title: "My Folder",
        parentId: null,
        ancestors: [],
        contentType: "folder",
      };
      const ancestorTitles = new Map([["100", "My Folder"]]);

      const result = computeFilePath(folder, ancestorTitles);

      expect(result.relativePath).toBe("my-folder/index.md");
      expect(result.isIndex).toBe(true);
    });

    test("nested folder uses index.md pattern", () => {
      const folder: PageHierarchyInfo = {
        id: "101",
        title: "Sub Folder",
        parentId: "100",
        ancestors: ["100"],
        contentType: "folder",
      };
      const ancestorTitles = new Map([
        ["100", "Parent Folder"],
        ["101", "Sub Folder"],
      ]);

      const result = computeFilePath(folder, ancestorTitles);

      expect(result.relativePath).toBe("parent-folder/sub-folder/index.md");
      expect(result.isIndex).toBe(true);
    });

    test("child of page with children is placed correctly", () => {
      const parent: PageHierarchyInfo = {
        id: "100",
        title: "Parent",
        parentId: null,
        ancestors: [],
        hasChildren: true,
      };
      const child: PageHierarchyInfo = {
        id: "101",
        title: "Child",
        parentId: "100",
        ancestors: ["100"],
        hasChildren: false,
      };
      const ancestorTitles = new Map([
        ["100", "Parent"],
        ["101", "Child"],
      ]);

      const parentPath = computeFilePath(parent, ancestorTitles);
      const childPath = computeFilePath(child, ancestorTitles);

      expect(parentPath.relativePath).toBe("parent/index.md");
      expect(childPath.relativePath).toBe("parent/child.md");
    });
  });

  describe("parseFilePath - index pattern", () => {
    test("parses index.md at root level", () => {
      const result = parseFilePath("index.md");

      expect(result.slug).toBe("index");
      expect(result.parentSlug).toBeNull();
      expect(result.isIndex).toBe(true);
    });

    test("parses index.md in directory", () => {
      const result = parseFilePath("parent/index.md");

      expect(result.slug).toBe("parent");
      expect(result.parentSlug).toBeNull();
      expect(result.ancestorSlugs).toEqual([]);
      expect(result.isIndex).toBe(true);
    });

    test("parses deeply nested index.md", () => {
      const result = parseFilePath("docs/getting-started/installation/index.md");

      expect(result.slug).toBe("installation");
      expect(result.parentSlug).toBe("getting-started");
      expect(result.ancestorSlugs).toEqual(["docs", "getting-started"]);
      expect(result.isIndex).toBe(true);
    });

    test("parses regular file alongside index", () => {
      const result = parseFilePath("parent/child.md");

      expect(result.slug).toBe("child");
      expect(result.parentSlug).toBe("parent");
      expect(result.isIndex).toBe(false);
    });
  });

  describe("getChildDirectory - index pattern", () => {
    test("returns directory for index.md", () => {
      expect(getChildDirectory("parent/index.md")).toBe("parent");
    });

    test("returns nested directory for nested index.md", () => {
      expect(getChildDirectory("docs/parent/index.md")).toBe("docs/parent");
    });

    test("returns slug for regular file (legacy)", () => {
      expect(getChildDirectory("parent.md")).toBe("parent");
    });
  });

  describe("buildPathMap - with folders and hasChildren", () => {
    test("builds paths with mixed content types", () => {
      const pages: PageHierarchyInfo[] = [
        { id: "1", title: "Folder", parentId: null, ancestors: [], contentType: "folder" },
        { id: "2", title: "Parent Page", parentId: "1", ancestors: ["1"], hasChildren: true },
        { id: "3", title: "Child Page", parentId: "2", ancestors: ["1", "2"], hasChildren: false },
      ];

      const pathMap = buildPathMap(pages);

      expect(pathMap.get("1")?.relativePath).toBe("folder/index.md");
      expect(pathMap.get("1")?.isIndex).toBe(true);
      expect(pathMap.get("2")?.relativePath).toBe("folder/parent-page/index.md");
      expect(pathMap.get("2")?.isIndex).toBe(true);
      expect(pathMap.get("3")?.relativePath).toBe("folder/parent-page/child-page.md");
      expect(pathMap.get("3")?.isIndex).toBe(false);
    });
  });

  // ============ Sibling to Index Migration Tests ============

  describe("usesSiblingPattern", () => {
    test("returns true for page.md with page/ directory children", () => {
      const existingPaths = new Set([
        "parent.md",
        "parent/child.md",
      ]);

      expect(usesSiblingPattern("parent.md", existingPaths)).toBe(true);
    });

    test("returns false for leaf page without children", () => {
      const existingPaths = new Set([
        "leaf.md",
        "other/child.md",
      ]);

      expect(usesSiblingPattern("leaf.md", existingPaths)).toBe(false);
    });

    test("returns false for index.md files", () => {
      const existingPaths = new Set([
        "parent/index.md",
        "parent/child.md",
      ]);

      expect(usesSiblingPattern("parent/index.md", existingPaths)).toBe(false);
    });

    test("returns true for nested sibling pattern", () => {
      const existingPaths = new Set([
        "docs/parent.md",
        "docs/parent/child.md",
      ]);

      expect(usesSiblingPattern("docs/parent.md", existingPaths)).toBe(true);
    });
  });

  describe("siblingToIndexPath", () => {
    test("converts root-level sibling to index", () => {
      expect(siblingToIndexPath("parent.md")).toBe("parent/index.md");
    });

    test("converts nested sibling to index", () => {
      expect(siblingToIndexPath("docs/parent.md")).toBe("docs/parent/index.md");
    });

    test("converts deeply nested sibling to index", () => {
      expect(siblingToIndexPath("a/b/c.md")).toBe("a/b/c/index.md");
    });
  });

  describe("detectSiblingPatternMigrations", () => {
    test("detects files needing migration", () => {
      const existingPaths = new Set([
        "parent.md",
        "parent/child.md",
        "leaf.md",
        "docs/nested.md",
        "docs/nested/deep.md",
      ]);

      const migrations = detectSiblingPatternMigrations(existingPaths);

      expect(migrations).toHaveLength(2);
      expect(migrations).toContainEqual({ oldPath: "parent.md", newPath: "parent/index.md" });
      expect(migrations).toContainEqual({ oldPath: "docs/nested.md", newPath: "docs/nested/index.md" });
    });

    test("returns empty array when no migration needed", () => {
      const existingPaths = new Set([
        "parent/index.md",
        "parent/child.md",
        "leaf.md",
      ]);

      const migrations = detectSiblingPatternMigrations(existingPaths);

      expect(migrations).toHaveLength(0);
    });
  });

  describe("migrateSiblingToIndex", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "sibling-migration-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    test("migrates parent.md to parent/index.md", async () => {
      // Create sibling pattern files
      await writeFile(join(tempDir, "parent.md"), "parent content");
      await mkdir(join(tempDir, "parent"), { recursive: true });
      await writeFile(join(tempDir, "parent/child.md"), "child content");

      const newPath = await migrateSiblingToIndex(tempDir, "parent.md");

      expect(newPath).toBe("parent/index.md");
      expect(existsSync(join(tempDir, "parent.md"))).toBe(false);
      expect(existsSync(join(tempDir, "parent/index.md"))).toBe(true);
      expect(await readFile(join(tempDir, "parent/index.md"), "utf-8")).toBe("parent content");
      // Child should still exist
      expect(await readFile(join(tempDir, "parent/child.md"), "utf-8")).toBe("child content");
    });

    test("migrates nested sibling pattern", async () => {
      await mkdir(join(tempDir, "docs"), { recursive: true });
      await writeFile(join(tempDir, "docs/parent.md"), "parent content");
      await mkdir(join(tempDir, "docs/parent"), { recursive: true });
      await writeFile(join(tempDir, "docs/parent/child.md"), "child content");

      const newPath = await migrateSiblingToIndex(tempDir, "docs/parent.md");

      expect(newPath).toBe("docs/parent/index.md");
      expect(existsSync(join(tempDir, "docs/parent.md"))).toBe(false);
      expect(existsSync(join(tempDir, "docs/parent/index.md"))).toBe(true);
    });
  });
});
