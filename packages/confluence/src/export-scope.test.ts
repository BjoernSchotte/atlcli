import { describe, test, expect } from "bun:test";
import {
  validateExportScope,
  normalizeLabelFilter,
  hasActiveLabelFilter,
  ExportScopeError,
  type ExportScope,
} from "./export-scope.js";

describe("validateExportScope", () => {
  test("accepts valid scopes and returns them unchanged", () => {
    const page: ExportScope = { kind: "page", pageId: "123" };
    const tree: ExportScope = { kind: "tree", rootPageId: "123", includeRoot: false, maxDepth: 2 };
    const space: ExportScope = { kind: "space", spaceKey: "DOCSY", maxDepth: 2 };
    expect(validateExportScope(page)).toBe(page);
    expect(validateExportScope(tree)).toBe(tree);
    expect(validateExportScope(space)).toBe(space);
  });

  test("rejects empty ids/keys", () => {
    expect(() => validateExportScope({ kind: "page", pageId: "" })).toThrow(ExportScopeError);
    expect(() => validateExportScope({ kind: "tree", rootPageId: "  " })).toThrow(ExportScopeError);
    expect(() => validateExportScope({ kind: "space", spaceKey: "" })).toThrow(ExportScopeError);
  });

  test("rejects a negative or non-integer maxDepth", () => {
    expect(() => validateExportScope({ kind: "tree", rootPageId: "1", maxDepth: -1 })).toThrow(
      ExportScopeError
    );
    expect(() => validateExportScope({ kind: "tree", rootPageId: "1", maxDepth: 1.5 })).toThrow(
      ExportScopeError
    );
    expect(() => validateExportScope({ kind: "space", spaceKey: "DOCS", maxDepth: -1 })).toThrow(
      ExportScopeError
    );
    // 0 is allowed (root-only tree).
    expect(validateExportScope({ kind: "tree", rootPageId: "1", maxDepth: 0 }).kind).toBe("tree");
    expect(validateExportScope({ kind: "space", spaceKey: "DOCS", maxDepth: 0 }).kind).toBe("space");
  });
});

describe("normalizeLabelFilter", () => {
  test("returns undefined for an empty or all-empty filter", () => {
    expect(normalizeLabelFilter(undefined)).toBeUndefined();
    expect(normalizeLabelFilter({})).toBeUndefined();
    expect(normalizeLabelFilter({ include: [], exclude: [] })).toBeUndefined();
    expect(normalizeLabelFilter({ include: ["  ", ""] })).toBeUndefined();
  });

  test("trims, drops empties, de-duplicates, and defaults excludeMode", () => {
    const normalized = normalizeLabelFilter({
      include: [" public ", "public", "handbook", ""],
      exclude: ["internal", "internal"],
    });
    expect(normalized).toEqual({
      include: ["public", "handbook"],
      exclude: ["internal"],
      excludeMode: "prune-subtree",
    });
  });

  test("preserves an explicit excludeMode", () => {
    expect(normalizeLabelFilter({ exclude: ["x"], excludeMode: "page-only" })?.excludeMode).toBe(
      "page-only"
    );
  });

  test("hasActiveLabelFilter mirrors normalize", () => {
    expect(hasActiveLabelFilter(undefined)).toBe(false);
    expect(hasActiveLabelFilter({ include: [] })).toBe(false);
    expect(hasActiveLabelFilter({ exclude: ["x"] })).toBe(true);
  });
});
