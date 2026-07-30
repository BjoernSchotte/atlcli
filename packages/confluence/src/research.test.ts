import { describe, expect, test } from "bun:test";
import * as research from "./research.js";

describe("Confluence research worker entrypoint", () => {
  test("exposes only the worker-safe read and projection surface", () => {
    expect(Object.keys(research).sort()).toEqual([
      "ConfluenceClient",
      "StorageParseError",
      "sanitizeLinkHref",
      "storageToBlocks",
    ]);
    expect(research.ConfluenceClient).toBeTypeOf("function");
    expect(research.storageToBlocks).toBeTypeOf("function");
    expect(research.sanitizeLinkHref).toBeTypeOf("function");
  });
});
