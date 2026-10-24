import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_WRITES, maxWritesOf, parseScriptMeta, resolveScriptParams } from "./meta.js";

const base = { name: "close-stale", permissions: ["jira:read", "jira:write:ATLCLI"] };

describe("parseScriptMeta", () => {
  it("accepts a minimal and a full meta", () => {
    expect(parseScriptMeta(base)).toEqual(base as never);
    const full = {
      ...base,
      description: "Close stale bugs",
      permissions: ["confluence:read", "confluence:write:DOCSY", "confluence:read"],
      limits: { maxWrites: 5 },
      params: { days: { type: "number", default: 180 }, dry: { type: "boolean" }, label: { type: "string" } },
    };
    const meta = parseScriptMeta(full);
    expect(meta.permissions).toEqual(["confluence:read", "confluence:write:DOCSY"]);
    expect(maxWritesOf(meta)).toBe(5);
  });

  it("requires a meta export", () => {
    expect(() => parseScriptMeta(null)).toThrow("must export `meta`");
  });

  it.each([
    [{ ...base, name: "Bad Name" }, "Invalid meta.name"],
    [{ ...base, permissions: ["jira:write"] }, "Invalid meta.permissions.0"],
    [{ ...base, permissions: ["jira:write:atlcli"] }, "Invalid meta.permissions.0"],
    [{ ...base, permissions: ["jira:admin"] }, "Invalid meta.permissions.0"],
    [{ ...base, permision: [] }, "Invalid meta"],
    [{ ...base, limits: { maxWrites: 0 } }, "Invalid meta.limits.maxWrites"],
    [{ ...base, params: { days: { type: "date" } } }, "Invalid meta.params.days"],
    [{ ...base, params: { days: { type: "number", default: "180" } } }, "Invalid meta.params.days"],
  ])("rejects %j", (meta, message) => {
    expect(() => parseScriptMeta(meta)).toThrow(message);
  });

  it("defaults maxWrites", () => {
    expect(maxWritesOf(parseScriptMeta(base))).toBe(DEFAULT_MAX_WRITES);
  });
});

describe("resolveScriptParams", () => {
  const meta = parseScriptMeta({
    ...base,
    params: {
      days: { type: "number", default: 180 },
      dry: { type: "boolean", default: false },
      label: { type: "string" },
    },
  });

  it("coerces CLI strings, applies defaults", () => {
    expect(resolveScriptParams(meta, { days: "30", label: "stale" })).toEqual({ days: 30, dry: false, label: "stale" });
    expect(resolveScriptParams(meta, { dry: "true", label: "x" })).toEqual({ days: 180, dry: true, label: "x" });
  });

  it("accepts typed values", () => {
    expect(resolveScriptParams(meta, { days: 7, dry: true, label: "x" })).toEqual({ days: 7, dry: true, label: "x" });
  });

  it.each([
    [{ label: "x", nope: "1" }, "Unknown parameter: nope"],
    [{}, "Missing required parameter: label"],
    [{ label: "x", days: "soon" }, "Parameter days must be a number"],
    [{ label: "x", days: "" }, "Parameter days must be a number"],
    [{ label: "x", dry: "yes" }, "Parameter dry must be a boolean"],
    [{ label: 5 }, "Parameter label must be a string"],
  ])("rejects %j", (raw, message) => {
    expect(() => resolveScriptParams(meta, raw)).toThrow(message);
  });

  it("returns no params when none are declared", () => {
    expect(resolveScriptParams(parseScriptMeta(base))).toEqual({});
  });
});
