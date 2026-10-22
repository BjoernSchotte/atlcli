/**
 * `jira analyze flow | aging | cfd` and the changelog N+1 regression, through
 * the real CLI in its own process against a local Bun HTTP server that speaks
 * the Jira Cloud paths (the profile sets `deploymentType: "cloud"`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWindowDays, resolveIssueSelection, stripOrderBy } from "./jira-flow.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const STATUSES = [
  { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "2", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  { id: "3", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
];
const status = (id: string) => STATUSES.find((s) => s.id === id)!;

function issue(n: number, summary: string, current: string, created: string, extra: Record<string, unknown> = {}) {
  return {
    id: String(n),
    key: `ATLCLI-${n}`,
    self: "",
    fields: { summary, status: status(current), issuetype: { id: "1", name: "Story" }, created, ...extra },
  };
}
function move(id: string, from: string, to: string, at: string) {
  return {
    id,
    author: { accountId: "u", displayName: "U" },
    created: Date.parse(at),
    items: [{ field: "status", fieldtype: "jira", fieldId: "status", from, fromString: status(from).name, to, toString: status(to).name }],
  };
}

const FLOW_ISSUES = [
  issue(1, "In progress", "2", ago(10)),
  issue(2, 'Done, with "quotes", and commas', "3", ago(10)),
  issue(3, "Still to do", "1", ago(1)),
];
const CHANGELOGS: Record<string, unknown[]> = {
  "1": [move("h1", "1", "2", ago(3))],
  // bulkfetch returns newest first; the client sorts.
  "2": [move("h3", "2", "3", ago(2)), move("h2", "1", "2", ago(5))],
};

let requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;
      requests.push({ method: req.method, path: pathname, body });
      if (pathname === "/rest/api/3/status") return Response.json(STATUSES);
      if (pathname === "/rest/api/3/search/jql") {
        const limit = Number(body?.maxResults);
        const start = body?.nextPageToken ? Number(body.nextPageToken) : 0;
        const page = FLOW_ISSUES.slice(start, start + limit);
        const next = start + limit < FLOW_ISSUES.length ? String(start + limit) : undefined;
        return Response.json({ issues: page, nextPageToken: next });
      }
      if (pathname === "/rest/api/3/changelog/bulkfetch") {
        const keys = body?.issueIdsOrKeys as string[];
        return Response.json({
          issueChangeLogs: keys.map((key) => {
            const id = key.replace("ATLCLI-", "");
            return { issueId: id, changeHistories: CHANGELOGS[id] ?? [] };
          }),
        });
      }
      if (pathname === "/rest/agile/1.0/board/7/configuration") return Response.json({ filter: { id: "70" } });
      if (pathname === "/rest/api/3/filter/70") return Response.json({ id: "70", jql: "project = ATLCLI ORDER BY Rank ASC" });
      if (pathname === "/rest/agile/1.0/sprint/1") {
        return Response.json({ id: 1, name: "S1", state: "closed", startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-03T00:00:00.000Z" });
      }
      if (pathname === "/rest/agile/1.0/sprint/1/issue") {
        return Response.json({
          issues: Array.from({ length: 30 }, (_, i) =>
            issue(100 + i, `S${i}`, i < 10 ? "3" : "2", "2026-09-30T00:00:00.000Z", { customfield_10016: 1 })
          ),
          total: 30,
        });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), { status: 404 });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-jira-flow-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "p",
      profiles: { p: { name: "p", baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

async function runCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
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

describe("jira analyze flow | aging | cfd", () => {
  test("flow --json: one search, one statuses read, one bulk changelog read", async () => {
    const { stdout, exitCode, stderr } = await runCli(["jira", "analyze", "flow", "--project", "ATLCLI", "--since", "30d", "--json"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.query).toBe('(project = "ATLCLI") AND (statusCategory != Done OR updated >= -30d) ORDER BY created ASC');
    expect(out.metrics.cycleTime).toMatchObject({ count: 1, p50: 3, p85: null });
    expect(out.metrics.leadTime).toMatchObject({ count: 1, p50: 8 });
    expect(out.metrics.wip.count).toBe(1);
    expect(out.metrics.wip.aging[0]).toMatchObject({ key: "ATLCLI-1", ageDays: 3, overP85: null });
    expect(out.diagnostics.warnings).toEqual([]);
    expect(requests.map((r) => r.path)).toEqual([
      "/rest/api/3/status",
      "/rest/api/3/search/jql",
      "/rest/api/3/changelog/bulkfetch",
    ]);
    expect(requests[2].body?.fieldIds).toEqual(["status"]);
  });

  test("flow --csv is RFC 4180 (quotes and commas in summaries stay inside one field)", async () => {
    const { stdout, exitCode } = await runCli(["jira", "analyze", "flow", "--project", "ATLCLI", "--csv"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("key,type,created,startedAt,doneAt,leadDays,cycleDays");
    expect(lines[1]).toMatch(/^ATLCLI-2,Story,.*,8,3$/);
    const aging = await runCli(["jira", "analyze", "aging", "--project", "ATLCLI", "--csv"]);
    expect(aging.stdout.trim().split("\n")[1]).toMatch(/^ATLCLI-1,In Progress,.*,3,$/);
  });

  test("--limit 2 with 3 matches warns about truncation", async () => {
    const { stdout, stderr } = await runCli(["jira", "analyze", "aging", "--project", "ATLCLI", "--limit", "2"]);
    expect(stderr).toContain("Warning: truncated: more than 2 issues matched");
    expect(stdout).toContain("ATLCLI-1");
  });

  test("--board reads the board filter and strips its ORDER BY", async () => {
    const { stdout } = await runCli(["jira", "analyze", "cfd", "--board", "7", "--since", "2d", "--group-by", "category", "--json"]);
    const out = JSON.parse(stdout);
    expect(out.query).toBe("(project = ATLCLI) AND (statusCategory != Done OR updated >= -2d) ORDER BY created ASC");
    const last = out.days[out.days.length - 1].counts;
    expect(last).toEqual({ todo: 1, wip: 1, done: 1 });
  });

  test("no selection fails with ATLCLI_ERR_USAGE; a bad --status-map too", async () => {
    const none = await runCli(["jira", "analyze", "flow", "--json"]);
    expect(none.exitCode).toBe(1);
    expect(JSON.parse(none.stdout).error.code).toBe("ATLCLI_ERR_USAGE");
    const bad = await runCli(["jira", "analyze", "flow", "--project", "ATLCLI", "--status-map", "Review=doing", "--json"]);
    expect(JSON.parse(bad.stdout).error.message).toContain("Invalid status map entry");
  });
});

describe("changelog N+1 regression", () => {
  test("analyze burndown over 30 sprint issues makes one changelog request, not 30", async () => {
    const { stdout, exitCode } = await runCli(["jira", "analyze", "burndown", "--sprint", "1", "--points-field", "customfield_10016", "--json"]);
    expect(exitCode).toBe(0);
    const changelogCalls = requests.filter((r) => r.path.includes("changelog") || r.path.startsWith("/rest/api/3/issue/"));
    expect(changelogCalls.map((r) => r.path)).toEqual(["/rest/api/3/changelog/bulkfetch"]);
    expect((changelogCalls[0].body?.issueIdsOrKeys as string[]).length).toBe(30);
    const out = JSON.parse(stdout);
    expect(out.totalPoints).toBe(30);
    expect(out.burndown.map((d: { remaining: number }) => d.remaining)).toEqual([30, 30, 30]);
  });
});

describe("selection helpers", () => {
  test("precedence: --jql > --board > --project > defaults.board > defaults.project", () => {
    const defaults = { board: 9, project: "DEF" };
    expect(resolveIssueSelection({ jql: "a", board: "1", project: "P" }, defaults)).toEqual({ kind: "jql", value: "a" });
    expect(resolveIssueSelection({ board: "1", project: "P" }, defaults)).toEqual({ kind: "board", value: "1" });
    expect(resolveIssueSelection({ project: "P" }, defaults)).toEqual({ kind: "project", value: "P" });
    expect(resolveIssueSelection({}, defaults)).toEqual({ kind: "board", value: "9" });
    expect(resolveIssueSelection({}, { project: "DEF" })).toEqual({ kind: "project", value: "DEF" });
    expect(resolveIssueSelection({}, {})).toBeUndefined();
  });

  test("stripOrderBy drops a trailing ORDER BY but not one inside a quoted value", () => {
    expect(stripOrderBy("project = A ORDER BY Rank ASC")).toBe("project = A");
    expect(stripOrderBy("project = A order by created DESC, key")).toBe("project = A");
    expect(stripOrderBy('summary ~ "order by x"')).toBe('summary ~ "order by x"');
    expect(stripOrderBy("project = A")).toBe("project = A");
  });

  test("parseWindowDays", () => {
    expect(parseWindowDays(undefined, 90)).toBe(90);
    expect(parseWindowDays("30d", 90)).toBe(30);
    expect(parseWindowDays("2w", 90)).toBe(14);
    expect(parseWindowDays("7", 90)).toBe(7);
    expect(parseWindowDays("0d", 90)).toBeUndefined();
    expect(parseWindowDays("3m", 90)).toBeUndefined();
  });
});
