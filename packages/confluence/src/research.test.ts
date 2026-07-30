import { describe, expect, test } from "bun:test";
import * as research from "./research.js";

describe("Confluence research worker entrypoint", () => {
  test("exposes only the worker-safe read and projection surface", () => {
    expect(research.ConfluenceClient).toBeTypeOf("function");
    expect(research.storageToBlocks).toBeTypeOf("function");
    expect(research.sanitizeLinkHref).toBeTypeOf("function");
    expect("storageToMarkdown" in research).toBe(false);
    expect("markdownToStorage" in research).toBe(false);
  });
});
