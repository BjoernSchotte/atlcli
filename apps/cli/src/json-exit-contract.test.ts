/**
 * Bundle 2 regressions (#273, #291, #293, #294, #300, #301, #302, #305): a
 * failure exits 1, and under --json stdout carries exactly one JSON document.
 * Real CLI against a stand-in Jira/Confluence server; sandboxed HOME.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
let server: ReturnType<typeof Bun.serve>;
let home: string;
let config: string;

const ISSUE = { id: "10001", key: "PROJ-1", fields: { summary: "One", status: { name: "Open" }, project: { key: "PROJ" } } };

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (/\/issue\/PROJ-404$/.test(pathname)) return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
      if (/\/field$/.test(pathname)) return Response.json([{ id: "customfield_10050", name: "Team", custom: true, schema: { type: "option" } }]);
      if (/\/field\/customfield_10050\/context/.test(pathname)) return Response.json({ errorMessages: ["Only Jira administrators can access field configurations."] }, { status: 403 });
      if (/\/search/.test(pathname)) return Response.json({ issues: [ISSUE], total: 1, startAt: 0, maxResults: 100 });
      if (/\/issue\/PROJ-1\/comment/.test(pathname)) return Response.json({ errorMessages: ["Forbidden"] }, { status: 403 });
      if (/\/issue\/PROJ-1$/.test(pathname)) return Response.json({ ...ISSUE, fields: { ...ISSUE.fields, attachment: [] } });
      if (/\/content\/12345$/.test(pathname)) return Response.json({ id: "12345", type: "page", title: "Old notes", version: { number: 1 }, space: { key: "DOCSY" }, body: { storage: { value: "<p/>" } } });
      return Response.json({ message: `stub: ${pathname}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-contract-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  config = join(home, ".atlcli", "config.json");
  await writeFile(
    config,
    JSON.stringify({
      currentProfile: "stub",
      profiles: { stub: { name: "stub", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" } } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  await rm(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

/** Exactly one JSON document on stdout. */
function single(stdout: string): any {
  return JSON.parse(stdout);
}

describe("failures exit 1 with one JSON error document", () => {
  test.each([
    [["wiki", "page", "lsit"], "ATLCLI_ERR_USAGE"],
    [["config", "lsit"], "ATLCLI_ERR_USAGE"],
    [["bogus"], "ATLCLI_ERR_USAGE"],
    [["config", "set", "flow.statusMap", "Fertig=done"], "ATLCLI_ERR_USAGE"],
    [["config", "unset", "profiles.stub.auth"], "ATLCLI_ERR_USAGE"],
    [["jira", "import", "--file", "export.json"], "ATLCLI_ERR_USAGE"],
    [["jira", "export", "-o", "x.json"], "ATLCLI_ERR_USAGE"],
    [["jira", "issue", "get", "--key", "PROJ-404"], "ATLCLI_ERR_NOT_FOUND"],
    [["jira", "field", "options", "customfield_10050"], "ATLCLI_ERR_FORBIDDEN"],
  ])("%p → %s", async (args, code) => {
    const before = await readFile(config, "utf8");
    const result = await run([...args, "--json"]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(single(result.stdout).error.code).toBe(code);
    expect(await readFile(config, "utf8")).toBe(before);
  }, 30_000);

  test("a bare group still prints its help and exits 0", async () => {
    const result = await run(["jira", "export"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("jira export");
  }, 30_000);
});

test("jira export marks failed fetches in the file and exits 1 (#293)", async () => {
  const out = join(home, "export.json");
  const result = await run(["jira", "export", "--jql", "project = PROJ", "-o", out, "--no-attachments"]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("PROJ-1: comments not exported");
  const file = JSON.parse(await readFile(out, "utf8"));
  expect(file.issues[0].exportErrors).toEqual([{ part: "comments", message: expect.stringContaining("403") }]);
}, 30_000);

test("wiki page delete --dry-run --json prints one document (#301)", async () => {
  const result = await run(["wiki", "page", "delete", "--id", "12345", "--dry-run", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(single(result.stdout)).toEqual({ schemaVersion: "1", dryRun: true, pages: [{ id: "12345", title: "Old notes" }] });
}, 30_000);

test("plugin list --json is an object, not a JSON-encoded string (#302)", async () => {
  const result = await run(["plugin", "list", "--json"]);
  const parsed = single(result.stdout);
  expect(parsed.schemaVersion).toBe("1");
  expect(parsed.plugins.map((p: { name: string }) => p.name)).toContain("git");
}, 30_000);
