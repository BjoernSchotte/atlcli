import { describe, expect, test } from "bun:test";
import { parseArgs } from "./utils.js";

describe("parseArgs", () => {
  test("a lone '-' after a long flag is its value (stdin), not a positional", () => {
    const parsed = parseArgs(["issue", "create", "--description-file", "-", "--json"]);
    expect(parsed.flags["description-file"]).toBe("-");
    expect(parsed.flags.json).toBe(true);
    expect(parsed._).toEqual(["issue", "create"]);
  });

  test("a dash before a digit is a value: relative dates, negative numbers", () => {
    expect(parseArgs(["--updated", "-7d", "--offset", "-2", "--json"]).flags).toEqual({ updated: "-7d", offset: "-2", json: true });
  });

  test("a following flag still makes the long flag boolean", () => {
    expect(parseArgs(["--dry-run", "--json"]).flags).toEqual({ "dry-run": true, json: true });
  });
});
