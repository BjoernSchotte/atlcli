import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { findTimeBounds, parseIndexedFind, runIndexedFind } from "./find-cql.js";
import { createWikiShell } from "./wiki-shell.js";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const DAY = 86_400_000;
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); });

async function setup() {
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "space", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", lastModified: "2026-01-01T00:00:00Z" })
    .seedPage({ id: "101", title: "Recent", parentId: "100", spaceKey: "DOCSY", lastModified: "2026-09-16T11:00:00Z" })
    .seedPage({ id: "102", title: "Old", parentId: "100", spaceKey: "DOCSY", lastModified: "2026-08-01T00:00:00Z" });
  const root = mkdtempSync(join(tmpdir(), "vfs-find-cql-"));
  const vfs = await ConfluenceVfsImpl.open({ client, profile: "mayflower", mode: "ro", cacheDir: root, allowDelete: false, offline: false });
  close.push(async () => { await vfs.close(); rmSync(root, { recursive: true, force: true }); });
  const diagnostics: string[] = [];
  return { client, vfs, cwd: "/DOCSY", spaces: ["DOCSY"], now: NOW, diagnostics, diagnostic: (line: string) => diagnostics.push(line) };
}

describe("find time CQL", () => {
  it("only accepts simple page Markdown conjunctions, leaving all other expressions untouched", () => {
    const base = [".", "-type", "f", "-name", "*.md", "-mtime", "-7"];
    expect(parseIndexedFind(base)?.times).toEqual([{ kind: "-mtime", value: "-7" }]);
    for (const args of [[".", "-mtime", "-7"], [...base, "-o", "-name", "*.txt"], [...base, "-delete"],
      [...base, "-maxdepth", "1"], [...base, "-name", "foo*"], [...base, "!", "-name", "x"], [...base, "-mtime", "bad"]]) {
      expect(parseIndexedFind(args)).toBeUndefined();
    }
    expect(parseIndexedFind([...base, "-print", "-print0"])).toBeUndefined();
  });

  it("widens CQL around timezone/minute boundaries and exactly verifies bundled mtime semantics", () => {
    const recent = findTimeBounds({ kind: "-mtime", value: "-7" }, NOW);
    expect(recent.query).toBe('lastmodified >= "2026-09-08 12:00"');
    expect(recent.matches(NOW - 7 * DAY)).toBe(false);
    expect(recent.matches(NOW - 7 * DAY + 1)).toBe(true);
    const older = findTimeBounds({ kind: "-mtime", value: "+7" }, NOW);
    expect(older.matches(NOW - 7 * DAY - 1)).toBe(true);
    expect(older.matches(NOW - 7 * DAY)).toBe(false);
    const exact = findTimeBounds({ kind: "-mtime", value: "7" }, NOW);
    expect(exact.matches(NOW - 7 * DAY)).toBe(true);
    expect(exact.matches(NOW - 8 * DAY + 1)).toBe(true);
    expect(exact.matches(NOW - 8 * DAY)).toBe(false);
    expect(() => findTimeBounds({ kind: "-newermt", value: 'bad" OR type=page' }, NOW)).toThrow();
  });

  it("filters false-positive index dates without downloading any body or walking children", async () => {
    const options = await setup();
    const result = await runIndexedFind([".", "-type", "f", "-name", "*.md", "-mtime", "-7"], options);
    expect(result).toEqual({ stdout: "/DOCSY/.by-id/101.md\n", stderr: "", exitCode: 0 });
    expect(options.client.callsTo("getPageDirectChildren")).toBe(0);
    expect(options.client.callsTo("getPage")).toBe(0);
    expect(options.client.callsTo("getPagesBulk")).toBe(0);
    expect(options.client.calls.some((call) => call.method === "searchDetailed" && call.arg.includes("lastmodified"))).toBe(true);
    expect(options.diagnostics.join("\n")).toContain("attachments excluded");
  });

  it("supports newermt, newer references, combined predicates and NUL output", async () => {
    const options = await setup();
    const base = [".", "-type", "f", "-name", "*.md"];
    expect((await runIndexedFind([...base, "-newermt", "2026-09-16T10:00:00Z", "-print0"], options))?.stdout).toBe("/DOCSY/.by-id/101.md\0");
    expect((await runIndexedFind([...base, "-newer", "/DOCSY/.by-id/102.md", "-mtime", "-1"], options))?.stdout).toBe("/DOCSY/.by-id/101.md\n");
    expect((await runIndexedFind([...base, "-newermt", "invalid"], options))?.exitCode).toBe(2);
  });

  it("scopes dates to the requested page subtree and preserves missing-path failures via fallback", async () => {
    const options = await setup();
    const flags = ["-type", "f", "-name", "*.md", "-newermt", "2020-01-01"];
    const result = await runIndexedFind(["old-102", ...flags], options);
    expect(result?.stdout).toBe("/DOCSY/.by-id/102.md\n");
    expect(options.client.calls.some((call) => call.method === "searchDetailed" && call.arg.includes("id = 102 OR ancestor = 102"))).toBe(true);
    expect((await runIndexedFind(["missing", ...flags], options))?.exitCode).toBe(2);
  });

  it("fails on truncation and falls back on unavailable CQL without reading bodies", async () => {
    const options = await setup();
    const base = [".", "-type", "f", "-name", "*.md", "-mtime", "-7"];
    options.client.searchDetailed = async () => ({ results: [], totalSize: 1001 });
    expect((await runIndexedFind(base, options))?.exitCode).toBe(2);
    options.client.searchDetailed = async () => { throw new Error("offline"); };
    expect(await runIndexedFind(base, options)).toBeUndefined();
    expect(options.client.callsTo("getPage")).toBe(0);
  });

  it("executes indexed time search through the interactive shell command", async () => {
    const options = await setup();
    const shell = await createWikiShell({ vfs: options.vfs, spaces: options.spaces, onDiagnostic: options.diagnostic });
    const result = await shell.exec("find . -type f -name '*.md' -newermt '2026-09-16T10:00:00Z'");
    expect(result).toEqual({ stdout: "/DOCSY/.by-id/101.md\n", stderr: "", exitCode: 0 });
    expect(options.client.callsTo("getPageDirectChildren")).toBe(0);
    expect(options.client.callsTo("getPage")).toBe(0);
    expect(options.client.callsTo("searchDetailed")).toBe(1);
  });
});
