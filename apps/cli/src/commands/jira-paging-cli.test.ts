/**
 * Reads that used to trust one request: `worklog report`, `epic progress`,
 * `epic issues` and the bulk selection, through the real CLI against a local
 * Bun server that pages like Jira Cloud (100 issues per search, 50 per Agile
 * page, 1000 worklogs per request).
 */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapInBatches } from "./jira.js";

setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
/** Issues matching each project in the stub. */
const MATCHES: Record<string, number> = { BIG: 1200, SMALL: 250, LOG: 150 };
const HEAVY_WORKLOGS = 1500;
const EPIC_CHILDREN = 120;

let server: ReturnType<typeof Bun.serve>;
let home: string;
let writes: string[] = [];

const issue = (project: string, n: number) => ({
  id: String(n),
  key: `${project}-${n}`,
  fields: { summary: `Issue ${n}`, status: { name: "Done", statusCategory: { key: n % 2 ? "done" : "new" } }, labels: [] },
});

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method !== "GET" && path !== "/rest/api/3/search/jql") writes.push(`${req.method} ${path}`);
      if (path === "/rest/api/3/myself") return Response.json({ accountId: "acc-me", displayName: "Me" });
      if (path === "/rest/api/3/search/jql") {
        const body = (await req.json()) as { jql: string; maxResults: number; nextPageToken?: string };
        const project = body.jql.includes("worklogAuthor") ? "LOG" : (/project = (\w+)/.exec(body.jql)?.[1] ?? "SMALL");
        const total = MATCHES[project]!;
        const start = Number(body.nextPageToken ?? 0);
        const end = Math.min(start + Math.min(100, body.maxResults), total);
        return Response.json({
          issues: Array.from({ length: end - start }, (_, i) => issue(project, start + i + 1)),
          ...(end < total ? { nextPageToken: String(end) } : {}),
        });
      }
      const worklog = /^\/rest\/api\/3\/issue\/(LOG-\d+)\/worklog$/.exec(path);
      if (worklog) {
        const total = worklog[1] === "LOG-1" ? HEAVY_WORKLOGS : 1;
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const end = Math.min(start + Math.min(1000, Number(url.searchParams.get("maxResults"))), total);
        return Response.json({
          startAt: start,
          total,
          worklogs: Array.from({ length: end - start }, (_, i) => ({
            id: `${worklog[1]}-${start + i}`,
            started: new Date().toISOString(),
            timeSpent: "1m",
            timeSpentSeconds: 60,
            author: { accountId: "acc-me", displayName: "Me" },
          })),
        });
      }
      if (path === "/rest/agile/1.0/epic/E-1/issue") {
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const end = Math.min(start + Math.min(50, Number(url.searchParams.get("maxResults"))), EPIC_CHILDREN);
        return Response.json({ startAt: start, total: EPIC_CHILDREN, issues: Array.from({ length: end - start }, (_, i) => issue("E", start + i + 1)) });
      }
      // A team-managed project: the Agile epic endpoint refuses it.
      if (path === "/rest/agile/1.0/epic/TM-1/issue") return Response.json({ errorMessages: ["next-gen"] }, { status: 400 });
      if (path === "/rest/api/3/issue/E-1" || path === "/rest/api/3/issue/TM-1") return Response.json(issue("E", 1));
      return Response.json({ message: `stub: no route for ${path}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-jira-paging-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({ currentProfile: "p", profiles: { p: { name: "p", baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } } } }),
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  writes = [];
});

async function run(...args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", ...args, "--json"], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

test("worklog report reads every matching issue and every worklog of an issue", async () => {
  const res = await run("worklog", "report");
  expect(res.exitCode, res.stderr).toBe(0);
  const { summary } = JSON.parse(res.stdout);
  expect(summary.issueCount).toBe(MATCHES.LOG);
  expect(summary.worklogCount).toBe(HEAVY_WORKLOGS + MATCHES.LOG! - 1);
});

test("epic progress counts every child, not the first Agile page", async () => {
  const res = await run("epic", "progress", "E-1");
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).progress).toMatchObject({ total: EPIC_CHILDREN, done: EPIC_CHILDREN / 2 });
});

test("epic issues --limit above one Agile page returns that many", async () => {
  const res = await run("epic", "issues", "E-1", "--limit", "70");
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).total).toBe(70);
});

test("epic issues of a team-managed project fall back to the parent search", async () => {
  const res = await run("epic", "issues", "TM-1", "--limit", "500");
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).total).toBe(MATCHES.SMALL);
});

test("a bulk selection above the default cap is an error, not the first 1000", async () => {
  const res = await run("bulk", "label", "add", "x", "--jql", "project = BIG");
  expect(res.exitCode).toBe(1);
  expect(JSON.parse(res.stdout).error.message).toContain("More than 1000 issues match");
  expect(writes).toEqual([]);
});

test("an explicit --limit is the caller's bound: processed, with a warning", async () => {
  const res = await run("bulk", "label", "add", "x", "--jql", "project = BIG", "--limit", "150", "--dry-run");
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).count).toBe(150);
  expect(res.stderr).toContain("more than 150 issues match");
});

test("a bulk selection below the cap is read in full", async () => {
  const res = await run("bulk", "label", "add", "x", "--jql", "project = SMALL", "--dry-run");
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).count).toBe(MATCHES.SMALL);
  expect(res.stderr).not.toContain("Warning");
});

test("mapInBatches keeps input order and runs at most `size` at a time", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapInBatches([5, 1, 4, 2, 3], async (ms) => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(ms);
    running -= 1;
    return ms * 2;
  }, 2);
  expect(out).toEqual([10, 2, 8, 4, 6]);
  expect(peak).toBe(2);
});
