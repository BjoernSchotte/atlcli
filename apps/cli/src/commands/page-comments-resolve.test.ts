import { describe, expect, test } from "bun:test";
import { resolveCommentType } from "./page.js";

describe("resolveCommentType", () => {
  // Only inline comments have a resolved state; the old footer default never resolved anything.
  test("defaults to inline", () => {
    expect(resolveCommentType(undefined)).toEqual({ type: "inline" });
  });

  test("accepts an explicit inline type", () => {
    expect(resolveCommentType("inline")).toEqual({ type: "inline" });
  });

  test("rejects footer with a usage message", () => {
    expect(resolveCommentType("footer")).toEqual({
      error: "Footer comments cannot be resolved in Confluence; only inline comments have a resolved state.",
    });
  });

  test("rejects unknown types", () => {
    expect(resolveCommentType("page")).toEqual({ error: '--type must be "inline" (got "page").' });
  });
});
