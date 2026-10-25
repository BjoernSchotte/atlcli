import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateFlags, parseVarAssignments, templateValuesFrom } from "./template-flags.js";

const opts = { json: true };

describe("parseVarAssignments", () => {
  test("keeps the old semantics and adds nesting", () => {
    expect(parseVarAssignments(["flag", "n=5", "s=hi", 'list=["a"]', "a.b=c", "a.d=e"])).toEqual({
      flag: true,
      n: 5,
      s: "hi",
      list: ["a"],
      a: { b: "c", d: "e" },
    });
  });
  test("a value may contain =", () => {
    expect(parseVarAssignments(["jql=project = X"])).toEqual({ jql: "project = X" });
  });
});

describe("parseTemplateFlags", () => {
  test("reads --vars-file, --var, --now and --strict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-vars-"));
    const file = join(dir, "v.yml");
    await writeFile(file, "variables:\n  year: { type: number }\nvalues:\n  year: 2026\n");
    const r = await parseTemplateFlags({ "vars-file": file, var: ["year=2027"], now: "2026-10-25T00:00:00Z", strict: true }, opts);
    expect(r).toMatchObject({ values: { year: 2027 }, strict: true, requested: true, missing: [] });
    expect(r.now.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
  test("without flags nothing is requested and now is the current time", async () => {
    const r = await parseTemplateFlags({}, opts);
    expect(r.requested).toBe(false);
    expect(Math.abs(r.now.getTime() - Date.now())).toBeLessThan(5000);
  });
  test("operation declarations report missing required variables", async () => {
    const r = await parseTemplateFlags({}, opts, { declarations: [{ name: "version", type: "string", required: true }] });
    expect(r.missing.map((v) => v.name)).toEqual(["version"]);
  });
  test("templateValuesFrom gives the script runtime's shape", async () => {
    const r = await parseTemplateFlags({ var: ["a=1"], now: "2026-10-25T00:00:00Z" }, opts);
    expect(templateValuesFrom(r)).toEqual({ vars: { a: 1 }, now: "2026-10-25T00:00:00.000Z", strict: false });
  });
});
