import { describe, expect, test } from "bun:test";
import { childrenSearch, pageListCql } from "./page.js";

describe("pageListCql", () => {
  test("scopes to --space when no --cql is given (space was silently ignored)", () => {
    expect(pageListCql(undefined, "DOCSY")).toBe('space = "DOCSY" AND type = page');
  });

  test("explicit --cql wins over --space", () => {
    expect(pageListCql('title ~ "x"', "DOCSY")).toBe('title ~ "x"');
  });

  test("labels are added to --cql or --space, never dropped (#296)", () => {
    expect(pageListCql('space = DOCS AND title ~ "release"', "X", ["api"])).toBe('(space = DOCS AND title ~ "release") AND label = "api"');
    expect(pageListCql(undefined, "DOCSY", ["a", 'b"c'])).toBe('space = "DOCSY" AND type = page AND label = "a" AND label = "b\\"c"');
  });

  test("falls back to all pages without space or cql", () => {
    expect(pageListCql(undefined, undefined)).toBe("type = page");
  });
});

describe("page children --limit", () => {
  test("caps the total, not just the page size", () => {
    expect(childrenSearch("42", "3")).toEqual({ cql: "parent=42 AND type=page", pageSize: 3, maxResults: 3 });
    expect(childrenSearch("42", "250")).toEqual({ cql: "parent=42 AND type=page", pageSize: 100, maxResults: 250 });
  });

  test("lists every child without --limit", () => {
    expect(childrenSearch("42")).toEqual({ cql: "parent=42 AND type=page", pageSize: 100, maxResults: undefined });
  });
});
