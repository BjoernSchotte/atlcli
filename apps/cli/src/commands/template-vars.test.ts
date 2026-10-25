import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { getCompletions } from "../completions.js";
import { summarizeVariables, valuesSkeleton } from "./template-vars.js";

describe("template vars", () => {
  const uses = [
    { name: "year", unit: "TPL-1 summary" },
    { name: "year", unit: "TPL-2 description" },
    { name: "owner", unit: "TPL-1 description" },
  ];
  test("merges uses with declarations", () => {
    expect(
      summarizeVariables(uses, [
        { name: "year", type: "number", required: true, description: "Audit year" },
        { name: "unused", type: "string" },
      ]),
    ).toEqual([
      { name: "owner", type: "string", required: true, usedIn: ["TPL-1 description"] },
      { name: "unused", type: "string", required: false, usedIn: [] },
      { name: "year", type: "number", required: true, description: "Audit year", usedIn: ["TPL-1 summary", "TPL-2 description"] },
    ]);
  });
  test("the skeleton is a valid vars file", () => {
    const rows = summarizeVariables(uses, [{ name: "q", type: "select", options: ["Q1"], default: "Q1" }]);
    expect(parse(valuesSkeleton(rows))).toEqual({ values: { owner: "", q: "Q1", year: "" } });
  });
  test("is offered at the root and completes its subcommand", () => {
    expect(getCompletions([""])).toContain("template");
    expect(getCompletions(["template", ""])).toEqual(["vars"]);
  });
});

describe("atlcli template vars --file", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
  test("lists the variables of a local Jira template file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-tvars-"));
    const file = join(dir, "rel.json");
    await writeFile(file, JSON.stringify({ name: "rel", createdAt: "x", fields: { issuetype: { name: "Task" }, summary: "Release {{version}} for {{team}}" }, variables: [{ name: "team", type: "string", default: "ops" }] }));
    const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "template", "vars", "--file", file, "--json"], {
      env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.variables.map((v: { name: string; required: boolean }) => [v.name, v.required])).toEqual([["team", false], ["version", true]]);
    expect(parse(out.skeleton)).toEqual({ values: { team: "ops", version: "" } });
  }, 30_000);
});
