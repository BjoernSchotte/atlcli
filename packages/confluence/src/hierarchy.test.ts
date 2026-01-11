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
});
