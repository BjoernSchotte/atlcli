import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { DEFAULT_MAX_WRITES, extractScriptMeta, maxWritesOf, parseScriptMeta, resolveScriptParams } from "./meta.js";

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

  it("treats absent meta as empty: everything optional", () => {
    expect(parseScriptMeta(null)).toEqual({});
    expect(parseScriptMeta({})).toEqual({});
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

  it("passes undeclared params through as given", () => {
    expect(resolveScriptParams(parseScriptMeta(base))).toEqual({});
    expect(resolveScriptParams({}, { project: "ATLCLI", days: "30" })).toEqual({ project: "ATLCLI", days: "30" });
    expect(() => resolveScriptParams({}, { x: {} })).toThrow("must be a string, number or boolean");
  });
});

describe("extractScriptMeta", () => {
  const extract = (js: string) => extractScriptMeta(js, { variant: DEBUG_VARIANT });

  it("reads the literal without running the script", async () => {
    const js = `export const meta = {
  name: "x", // a { brace in a comment
  description: "braces } in \\"strings\\" and \`templates }\`",
  permissions: ["jira:read"], /* and } here */
  params: { days: { type: "number", default: 3 } },
};
throw new Error("must not run");`;
    expect(await extract(js)).toEqual({
      name: "x",
      description: 'braces } in "strings" and `templates }`',
      permissions: ["jira:read"],
      params: { days: { type: "number", default: 3 } },
    });
  });

  it("returns null when there is no meta", async () => {
    expect(await extract(`for await (const i of atlcli.jira.search("x")) {}`)).toBeNull();
  });

  it.each([
    [`const m = {}; export { m as meta };`, "Declare meta as"],
    [`export let meta = {};`, "Declare meta as"],
    [`export const meta = makeMeta();`, "must be an object literal"],
    [`const p = ["jira:read"]; export const meta = { permissions: p };`, "self-contained literal"],
    [`export const meta = { name: "x"`, "not closed"],
  ])("rejects %s", async (js, message) => {
    await expect(extract(js)).rejects.toThrow(message);
  });
});
