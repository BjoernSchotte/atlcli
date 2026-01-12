import { describe, test, expect, mock } from "bun:test";
import {
  naturalCompare,
  sortPages,
  isSameOrder,
  PageWithPosition,
  SortStrategy,
} from "./reorder.js";

// Helper to create mock pages
function createPage(
  id: string,
  title: string,
  options: { position?: number | null; createdAt?: string; modifiedAt?: string } = {}
): PageWithPosition {
  return {
    id,
    title,
    spaceKey: "TEST",
    parentId: "parent-1",
    version: 1,
    position: options.position ?? null,
    ...(options.createdAt && { createdAt: options.createdAt }),
    ...(options.modifiedAt && { modifiedAt: options.modifiedAt }),
  } as PageWithPosition;
}

describe("naturalCompare", () => {
  test("compares simple strings alphabetically", () => {
    expect(naturalCompare("apple", "banana")).toBeLessThan(0);
    expect(naturalCompare("banana", "apple")).toBeGreaterThan(0);
    expect(naturalCompare("apple", "apple")).toBe(0);
  });

  test("handles numbers in strings naturally", () => {
    // Natural sort: 1, 2, 10 (not 1, 10, 2)
    expect(naturalCompare("Chapter 1", "Chapter 2")).toBeLessThan(0);
    expect(naturalCompare("Chapter 2", "Chapter 10")).toBeLessThan(0);
    expect(naturalCompare("Chapter 10", "Chapter 2")).toBeGreaterThan(0);
  });

  test("is case insensitive", () => {
    expect(naturalCompare("Apple", "apple")).toBe(0);
    expect(naturalCompare("BANANA", "banana")).toBe(0);
  });

  test("handles mixed numeric and text", () => {
    expect(naturalCompare("file1.txt", "file2.txt")).toBeLessThan(0);
    expect(naturalCompare("file9.txt", "file10.txt")).toBeLessThan(0);
    expect(naturalCompare("v1.0.0", "v1.0.10")).toBeLessThan(0);
  });
});

describe("sortPages", () => {
  describe("alphabetical sort", () => {
    test("sorts pages alphabetically by title", () => {
      const pages = [
        createPage("3", "Zebra"),
        createPage("1", "Apple"),
        createPage("2", "Banana"),
      ];

      const sorted = sortPages(pages, { type: "alphabetical" });

      expect(sorted.map((p) => p.title)).toEqual(["Apple", "Banana", "Zebra"]);
    });

    test("reverses order when reverse=true", () => {
      const pages = [
        createPage("1", "Apple"),
        createPage("2", "Banana"),
        createPage("3", "Cherry"),
      ];

      const sorted = sortPages(pages, { type: "alphabetical", reverse: true });

      expect(sorted.map((p) => p.title)).toEqual(["Cherry", "Banana", "Apple"]);
    });

    test("does not mutate original array", () => {
      const pages = [
        createPage("1", "Zebra"),
        createPage("2", "Apple"),
      ];
      const original = [...pages];

      sortPages(pages, { type: "alphabetical" });

      expect(pages).toEqual(original);
    });
  });

  describe("natural sort", () => {
    test("sorts numbered content naturally", () => {
      const pages = [
        createPage("1", "Chapter 1"),
        createPage("2", "Chapter 10"),
        createPage("3", "Chapter 2"),
        createPage("4", "Chapter 11"),
      ];

      const sorted = sortPages(pages, { type: "natural" });

      expect(sorted.map((p) => p.title)).toEqual([
        "Chapter 1",
        "Chapter 2",
        "Chapter 10",
        "Chapter 11",
      ]);
    });

    test("handles version numbers", () => {
      const pages = [
        createPage("1", "v1.10.0"),
        createPage("2", "v1.2.0"),
        createPage("3", "v1.9.0"),
      ];

      const sorted = sortPages(pages, { type: "natural" });

      expect(sorted.map((p) => p.title)).toEqual([
        "v1.2.0",
        "v1.9.0",
        "v1.10.0",
      ]);
    });
  });

  describe("created date sort", () => {
    test("sorts by creation date (oldest first)", () => {
      const pages = [
        createPage("1", "Page C", { createdAt: "2025-01-03T00:00:00Z" }),
        createPage("2", "Page A", { createdAt: "2025-01-01T00:00:00Z" }),
        createPage("3", "Page B", { createdAt: "2025-01-02T00:00:00Z" }),
      ];

      const sorted = sortPages(pages, { type: "created" });

      expect(sorted.map((p) => p.title)).toEqual(["Page A", "Page B", "Page C"]);
    });

    test("sorts by creation date (newest first) with reverse", () => {
      const pages = [
        createPage("1", "Page C", { createdAt: "2025-01-03T00:00:00Z" }),
        createPage("2", "Page A", { createdAt: "2025-01-01T00:00:00Z" }),
        createPage("3", "Page B", { createdAt: "2025-01-02T00:00:00Z" }),
      ];

      const sorted = sortPages(pages, { type: "created", reverse: true });

      expect(sorted.map((p) => p.title)).toEqual(["Page C", "Page B", "Page A"]);
    });

    test("falls back to alphabetical when createdAt missing", () => {
      const pages = [
        createPage("1", "Zebra"),
        createPage("2", "Apple"),
        createPage("3", "Banana"),
      ];

      const sorted = sortPages(pages, { type: "created" });

      expect(sorted.map((p) => p.title)).toEqual(["Apple", "Banana", "Zebra"]);
    });
  });

  describe("modified date sort", () => {
    test("sorts by modification date (oldest first)", () => {
      const pages = [
        createPage("1", "Page C", { modifiedAt: "2025-01-03T00:00:00Z" }),
        createPage("2", "Page A", { modifiedAt: "2025-01-01T00:00:00Z" }),
        createPage("3", "Page B", { modifiedAt: "2025-01-02T00:00:00Z" }),
      ];

      const sorted = sortPages(pages, { type: "modified" });

      expect(sorted.map((p) => p.title)).toEqual(["Page A", "Page B", "Page C"]);
    });

    test("falls back to alphabetical when modifiedAt missing", () => {
      const pages = [
        createPage("1", "Zebra"),
        createPage("2", "Apple"),
      ];

      const sorted = sortPages(pages, { type: "modified" });

      expect(sorted.map((p) => p.title)).toEqual(["Apple", "Zebra"]);
    });
  });

  describe("custom order sort", () => {
    test("sorts by explicit ID order", () => {
      const pages = [
        createPage("1", "Page A"),
        createPage("2", "Page B"),
        createPage("3", "Page C"),
      ];

      const sorted = sortPages(pages, { type: "custom", order: ["3", "1", "2"] });

      expect(sorted.map((p) => p.id)).toEqual(["3", "1", "2"]);
    });

    test("puts unspecified pages at the end", () => {
      const pages = [
        createPage("1", "Page A"),
        createPage("2", "Page B"),
        createPage("3", "Page C"),
        createPage("4", "Page D"),
      ];

      const sorted = sortPages(pages, { type: "custom", order: ["3", "1"] });

      expect(sorted.map((p) => p.id)).toEqual(["3", "1", "2", "4"]);
    });
  });
});

describe("isSameOrder", () => {
  test("returns true for identical order", () => {
    const a = [
      createPage("1", "Page A"),
      createPage("2", "Page B"),
      createPage("3", "Page C"),
    ];
    const b = [
      createPage("1", "Page A"),
      createPage("2", "Page B"),
      createPage("3", "Page C"),
    ];

    expect(isSameOrder(a, b)).toBe(true);
  });

  test("returns false for different order", () => {
    const a = [
      createPage("1", "Page A"),
      createPage("2", "Page B"),
      createPage("3", "Page C"),
    ];
    const b = [
      createPage("2", "Page B"),
      createPage("1", "Page A"),
      createPage("3", "Page C"),
    ];

    expect(isSameOrder(a, b)).toBe(false);
  });

  test("returns false for different lengths", () => {
    const a = [
      createPage("1", "Page A"),
      createPage("2", "Page B"),
    ];
    const b = [
      createPage("1", "Page A"),
      createPage("2", "Page B"),
      createPage("3", "Page C"),
    ];

    expect(isSameOrder(a, b)).toBe(false);
  });

  test("returns true for empty arrays", () => {
    expect(isSameOrder([], [])).toBe(true);
  });

  test("compares by ID not title", () => {
    const a = [
      createPage("1", "Same Title"),
      createPage("2", "Same Title"),
    ];
    const b = [
      createPage("2", "Same Title"),
      createPage("1", "Same Title"),
    ];

    expect(isSameOrder(a, b)).toBe(false);
  });
});
