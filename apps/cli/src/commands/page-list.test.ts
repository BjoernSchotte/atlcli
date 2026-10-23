import { describe, expect, test } from "bun:test";
import { pageListCql } from "./page.js";

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
