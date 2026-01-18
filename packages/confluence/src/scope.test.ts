import { describe, test, expect } from "bun:test";
import {
  parseScope,
  buildCqlFromScope,
  scopeToString,
  scopesEqual,
} from "./scope.js";
import type { SyncScope } from "./client.js";

describe("scope utilities", () => {
  describe("parseScope", () => {
    test("returns null when no scope flags provided", () => {
      const result = parseScope({});
      expect(result).toBeNull();
    });

    test("parses --page-id flag", () => {
      const result = parseScope({ "page-id": "12345" });

      expect(result).not.toBeNull();
      expect(result!.scope).toEqual({ type: "page", pageId: "12345" });
      expect(result!.spaceKey).toBeUndefined();
    });

    test("parses --ancestor flag", () => {
      const result = parseScope({ ancestor: "67890" });

      expect(result).not.toBeNull();
      expect(result!.scope).toEqual({ type: "tree", ancestorId: "67890" });
    });

    test("parses --space flag", () => {
      const result = parseScope({ space: "TEAM" });

      expect(result).not.toBeNull();
      expect(result!.scope).toEqual({ type: "space", spaceKey: "TEAM" });
      expect(result!.spaceKey).toBe("TEAM");
    });

    test("--page-id takes precedence over --space", () => {
      const result = parseScope({ "page-id": "12345", space: "TEAM" });

      expect(result!.scope.type).toBe("page");
      expect(result!.spaceKey).toBe("TEAM");
    });

    test("--page-id takes precedence over --ancestor", () => {
      const result = parseScope({ "page-id": "12345", ancestor: "67890" });

      expect(result!.scope.type).toBe("page");
    });

    test("--ancestor takes precedence over --space", () => {
      const result = parseScope({ ancestor: "67890", space: "TEAM" });

      expect(result!.scope.type).toBe("tree");
      expect(result!.spaceKey).toBe("TEAM");
    });

    test("ignores empty string values", () => {
      const result = parseScope({ "page-id": "", space: "TEAM" });

      expect(result!.scope.type).toBe("space");
    });

    test("ignores boolean values", () => {
      const result = parseScope({ "page-id": true as any, space: "TEAM" });

      expect(result!.scope.type).toBe("space");
    });
  });

  describe("buildCqlFromScope", () => {
    test("returns null for single page scope", () => {
      const scope: SyncScope = { type: "page", pageId: "12345" };
      expect(buildCqlFromScope(scope)).toBeNull();
    });

    test("returns CQL for tree scope", () => {
      const scope: SyncScope = { type: "tree", ancestorId: "67890" };
      expect(buildCqlFromScope(scope)).toBe("ancestor=67890 AND type=page");
    });

    test("returns CQL for space scope", () => {
      const scope: SyncScope = { type: "space", spaceKey: "TEAM" };
      expect(buildCqlFromScope(scope)).toBe('space="TEAM" AND type=page');
    });
  });

  describe("scopeToString", () => {
    test("formats page scope", () => {
      const scope: SyncScope = { type: "page", pageId: "12345" };
      expect(scopeToString(scope)).toBe("page 12345");
    });

    test("formats tree scope", () => {
      const scope: SyncScope = { type: "tree", ancestorId: "67890" };
      expect(scopeToString(scope)).toBe("tree under 67890");
    });

    test("formats space scope", () => {
      const scope: SyncScope = { type: "space", spaceKey: "TEAM" };
      expect(scopeToString(scope)).toBe("space TEAM");
    });
  });

  describe("scopesEqual", () => {
    test("returns true for identical page scopes", () => {
      const a: SyncScope = { type: "page", pageId: "12345" };
      const b: SyncScope = { type: "page", pageId: "12345" };
      expect(scopesEqual(a, b)).toBe(true);
    });

    test("returns false for different page IDs", () => {
      const a: SyncScope = { type: "page", pageId: "12345" };
      const b: SyncScope = { type: "page", pageId: "67890" };
      expect(scopesEqual(a, b)).toBe(false);
    });

    test("returns true for identical tree scopes", () => {
      const a: SyncScope = { type: "tree", ancestorId: "12345" };
      const b: SyncScope = { type: "tree", ancestorId: "12345" };
      expect(scopesEqual(a, b)).toBe(true);
    });

    test("returns false for different ancestor IDs", () => {
      const a: SyncScope = { type: "tree", ancestorId: "12345" };
      const b: SyncScope = { type: "tree", ancestorId: "67890" };
      expect(scopesEqual(a, b)).toBe(false);
    });

    test("returns true for identical space scopes", () => {
      const a: SyncScope = { type: "space", spaceKey: "TEAM" };
      const b: SyncScope = { type: "space", spaceKey: "TEAM" };
      expect(scopesEqual(a, b)).toBe(true);
    });

    test("returns false for different space keys", () => {
      const a: SyncScope = { type: "space", spaceKey: "TEAM" };
      const b: SyncScope = { type: "space", spaceKey: "DEV" };
      expect(scopesEqual(a, b)).toBe(false);
    });

    test("returns false for different scope types", () => {
      const a: SyncScope = { type: "page", pageId: "12345" };
      const b: SyncScope = { type: "tree", ancestorId: "12345" };
      expect(scopesEqual(a, b)).toBe(false);
    });
  });
});
