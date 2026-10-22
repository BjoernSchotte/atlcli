/**
 * `atlcli digest` through the real CLI in its own process (temporary HOME)
 * against one local Bun HTTP server that serves both the Jira Cloud and the
 * Confluence paths. Covers the per-product marker, partial failure, the
 * profile-name path guard and the request budget.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestStatePath } from "./digest.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let failing: { jira: boolean; confluence: boolean } = { jira: false, confluence: false };
let paths: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

const ISSUE = {
  id: "1",
  key: "ATLCLI-1",
  self: "",
  fields: { summary: "Fix login", status: { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } }, assignee: { accountId: "me-j" } },
};

function confluenceSearch(cql: string) {
  if (cql.includes("creator = currentUser() ORDER BY")) return [{ id: "11", type: "page", title: "My page" }, { id: "12", type: "page", title: "Other page" }];
  if (cql.startsWith("mention")) {
    return [{ id: "13", type: "page", title: "Mentioned", space: { key: "DOCSY" }, version: { by: { accountId: "other", displayName: "Bob" } }, history: { lastUpdated: { when: ago(5) } } }];
  }
  if (cql.startsWith("type = comment")) {
    return [{ id: "21", type: "comment", title: "Re: My page", container: { id: "11", title: "My page" }, history: { createdBy: { accountId: "other", displayName: "Eve" }, createdDate: ago(3) } }];
  }
  return [];
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname);
      const confluence = url.pathname.startsWith("/wiki/");
      if (confluence ? failing.confluence : failing.jira) {
        return Response.json({ message: "forbidden for this test" }, { status: 403 });
      }
      switch (url.pathname) {
        case "/rest/api/3/myself":
          return Response.json({ accountId: "me-j", displayName: "Me" });
        case "/rest/api/3/search/jql":
          return Response.json({ issues: [ISSUE] });
        case "/rest/api/3/changelog/bulkfetch":
          return Response.json({
            issueChangeLogs: [{ issueId: "1", changeHistories: [{ id: "h", author: { accountId: "other", displayName: "Ann" }, created: Date.now() - 60_000, items: [{ field: "status", fieldtype: "jira", from: "1", fromString: "To Do", to: "2", toString: "In Progress" }] }] }],
          });
        case "/wiki/rest/api/user/current":
          return Response.json({ accountId: "me-c", displayName: "Me" });
        case "/wiki/rest/api/content/search":
          return Response.json({ results: confluenceSearch(url.searchParams.get("cql") ?? ""), start: 0, limit: 25, size: 1 });
        case "/wiki/rest/api/content/11/child/comment":
          return Response.json({
            results: [{ id: "31", type: "comment", title: "Re: My page", container: { id: "11", title: "My page" }, history: { createdBy: { accountId: "other", displayName: "Eve" }, createdDate: ago(600) }, extensions: { location: "inline", resolution: { status: "open" } } }],
          });
        case "/wiki/rest/api/content/12/child/comment":
          return Response.json({ results: [] });
      }
      return Response.json({ message: `stub: no route for ${url.pathname}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-digest-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  const profile = (name: string) => ({ name, baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({ currentProfile: "p", profiles: { p: profile("p"), "../evil": profile("../evil") } })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  failing = { jira: false, confluence: false };
  paths = [];
  await rm(join(home, ".atlcli", "profiles"), { recursive: true, force: true });
});

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1", ANTHROPIC_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const statePath = () => join(home, ".atlcli", "profiles", "p", "digest-state.json");
const readState = async () => JSON.parse(await readFile(statePath(), "utf8"));

describe("atlcli digest", () => {
  test("first run uses 24h and writes both markers with the start time; the next run uses lastrun", async () => {
    const before = Date.now();
    const first = await runCli(["digest", "--json"]);
    expect(first.exitCode).toBe(0);
    const digest = JSON.parse(first.stdout);
    expect(digest.since.source).toBe("default");
    expect(digest.jira.waiting.map((i: { key: string }) => i.key)).toEqual(["ATLCLI-1"]);
    expect(digest.jira.changed[0].changes[0]).toMatchObject({ field: "status", to: "In Progress", author: "Ann" });
    expect(digest.confluence.mentions.map((p: { id: string }) => p.id)).toEqual(["13"]);
    expect(digest.confluence.comments.map((c: { id: string }) => c.id)).toEqual(["21"]);
    expect(digest.confluence.openInline.map((c: { id: string }) => c.id)).toEqual(["31"]);
    const state = await readState();
    expect(state.schemaVersion).toBe(2);
    expect(Date.parse(state.jira.lastRunAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(state.confluence.lastRunAt).toBe(state.jira.lastRunAt);

    const second = JSON.parse((await runCli(["digest", "--json"])).stdout);
    expect(second.since.source).toBe("lastrun");
  });

  test("--since 7d and --no-mark leave the marker alone", async () => {
    await runCli(["digest", "--json"]);
    const original = await readFile(statePath(), "utf8");
    await runCli(["digest", "--since", "7d", "--json"]);
    await runCli(["digest", "--no-mark", "--json"]);
    expect(await readFile(statePath(), "utf8")).toBe(original);
  });

  test("Confluence failing: Jira still printed, exit 0, only the Jira marker moves", async () => {
    failing.confluence = true;
    const { stdout, exitCode } = await runCli(["digest"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ATLCLI-1");
    expect(stdout).toContain("Warnings:");
    expect(stdout).toContain("confluence.mentions:");
    const state = await readState();
    expect(state.jira).toBeDefined();
    expect(state.confluence).toBeUndefined();
  });

  test("both products failing exits 1 and writes no marker", async () => {
    failing = { jira: true, confluence: true };
    const { exitCode } = await runCli(["digest", "--json"]);
    expect(exitCode).toBe(1);
    expect(existsSync(statePath())).toBe(false);
  });

  test("a profile name with ../ cannot leave ~/.atlcli/profiles", async () => {
    const { exitCode } = await runCli(["digest", "--profile", "../evil", "--only", "jira", "--json"]);
    expect(exitCode).toBe(0);
    expect(existsSync(join(home, ".atlcli", "evil"))).toBe(false);
    expect(existsSync(join(home, ".atlcli", "profiles", "%2E%2E%2Fevil", "digest-state.json"))).toBe(true);
    expect(digestStatePath("../evil").endsWith(join(".atlcli", "profiles", "%2E%2E%2Fevil", "digest-state.json"))).toBe(true);
    expect(digestStatePath("..").endsWith(join("profiles", "%2E%2E", "digest-state.json"))).toBe(true);
  });

  test("the request budget holds and --verbose reports it", async () => {
    const { stderr } = await runCli(["digest", "--verbose", "--json"]);
    expect(paths.length).toBeLessThanOrEqual(20);
    expect(stderr).toContain(`${paths.length} request(s) in`);
    expect(stderr).toContain("jira.waiting: assignee = currentUser()");
  });

  test("--summarize without a key: warning, digest still printed, exit 0; key flags are refused", async () => {
    const { stdout, exitCode } = await runCli(["digest", "--summarize", "--no-mark"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ATLCLI-1");
    expect(stdout).toContain("summary: ANTHROPIC_API_KEY is not set; no summary.");
    const refused = await runCli(["digest", "--api-key", "sk-ant-x", "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.message).toContain("never accepted as command-line flags");
  });
});
