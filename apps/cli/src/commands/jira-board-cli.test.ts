/**
 * `jira board create`, `jira board delete` and `jira issue rank` through the real CLI against a
 * local Bun server that speaks Jira Cloud's platform and Agile APIs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

type Req = { method: string; path: string; body: any };
let requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
/** Whether POST /board fails, as Jira does for a filter it cannot use. */
let boardFails = false;
/** Boards GET /board?filterId=500 lists (other boards on the deleted board's filter). */
let filterBoards: number[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);
      requests.push({ method: req.method, path, body });

      if (path === "/rest/api/3/filter" && req.method === "POST") return Response.json({ id: "500", name: body.name, jql: body.jql });
      if (path === "/rest/api/3/filter/500/permission") return Response.json([{ id: 1, type: "project", project: { id: "10001" } }]);
      if (path.startsWith("/rest/api/3/filter/") && req.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/rest/api/3/project/AB") return Response.json({ id: "10001", key: "AB", name: "Alpha" });
      if (path === "/rest/agile/1.0/board" && req.method === "POST") {
        if (boardFails) return Response.json({ errorMessages: ["The filter is not valid for a board."], errors: {} }, { status: 400 });
        return Response.json({ id: 77, name: body.name, type: body.type });
      }
      if (path === "/rest/agile/1.0/board/77/configuration") return Response.json({ id: 77, filter: { id: "500" } });
      if (path === "/rest/agile/1.0/board/77" && req.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/rest/agile/1.0/board" && url.searchParams.get("filterId") === "500") {
        return Response.json({ values: filterBoards.map((id) => ({ id, name: `Board ${id}`, type: "scrum" })), total: filterBoards.length });
      }
      if (path === "/rest/agile/1.0/issue/rank" && req.method === "PUT") {
        // AB-9 cannot be ranked: Jira answers 207 with one entry per issue.
        if (!body.issues.includes("AB-9")) return new Response(null, { status: 204 });
        return Response.json({ entries: body.issues.map((k: string) => (k === "AB-9" ? { issueKey: k, status: 403, errors: ["No permission"] } : { issueKey: k, status: 200 })) }, { status: 207 });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${req.method} ${path}` }), { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-jira-board-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "p",
      global: { project: "AB" },
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
  boardFails = false;
  filterBoards = [];
});

async function run(args: string[], area = "board") {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", area, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}
const writes = () => requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
const sent = (method: string, path: string) => requests.find((r) => r.method === method && r.path === path)?.body;

describe("board create", () => {
  test("without --filter: a project filter, shared with the project, then the board located there", async () => {
    const { exitCode, stdout } = await run(["create", "--name", "Team AB", "--json"]);
    expect(exitCode).toBe(0);
    expect(writes()).toEqual(["POST /rest/api/3/filter", "POST /rest/api/3/filter/500/permission", "POST /rest/agile/1.0/board"]);
    expect(sent("POST", "/rest/api/3/filter")).toEqual({ name: "Team AB", jql: 'project = "AB" ORDER BY Rank ASC' });
    expect(sent("POST", "/rest/api/3/filter/500/permission")).toEqual({ type: "project", projectId: "10001" });
    expect(sent("POST", "/rest/agile/1.0/board")).toEqual({ name: "Team AB", type: "scrum", filterId: 500, location: { type: "project", projectKeyOrId: "AB" } });
    expect(JSON.parse(stdout)).toMatchObject({ board: { id: 77, type: "scrum" }, filter: { id: "500", created: true } });
  });

  test("--filter uses that filter as it is: nothing created or shared", async () => {
    const { exitCode, stdout } = await run(["create", "--name", "K", "--type", "kanban", "--filter", "42", "--json"]);
    expect(exitCode).toBe(0);
    expect(writes()).toEqual(["POST /rest/agile/1.0/board"]);
    expect(sent("POST", "/rest/agile/1.0/board")).toMatchObject({ type: "kanban", filterId: 42 });
    expect(JSON.parse(stdout).filter).toEqual({ id: "42", created: false });
  });

  test("--jql becomes the new filter's query", async () => {
    await run(["create", "--name", "Bugs", "--jql", "project = AB AND type = Bug ORDER BY Rank", "--json"]);
    expect(sent("POST", "/rest/api/3/filter").jql).toBe("project = AB AND type = Bug ORDER BY Rank");
  });

  test("a failed board removes the filter it made (no orphan)", async () => {
    boardFails = true;
    const { exitCode, stdout } = await run(["create", "--name", "X", "--json"]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("The filter is not valid for a board.");
    expect(writes()).toEqual(["POST /rest/api/3/filter", "POST /rest/api/3/filter/500/permission", "POST /rest/agile/1.0/board", "DELETE /rest/api/3/filter/500"]);
  });

  test("usage errors write nothing", async () => {
    for (const args of [["create", "--json"], ["create", "--name", "X", "--type", "simple", "--json"], ["create", "--name", "X", "--filter", "1", "--jql", "x", "--json"], ["create", "--name", "X", "--filter", "abc", "--json"]]) {
      const { exitCode } = await run(args);
      expect(exitCode).toBe(1);
    }
    expect(writes()).toEqual([]);
  });
});

describe("board delete", () => {
  test("needs --confirm", async () => {
    const { exitCode } = await run(["delete", "--id", "77", "--json"]);
    expect(exitCode).toBe(1);
    expect(writes()).toEqual([]);
  });

  test("keeps the filter by default", async () => {
    const { exitCode, stdout } = await run(["delete", "--id", "77", "--confirm", "--json"]);
    expect(exitCode).toBe(0);
    expect(writes()).toEqual(["DELETE /rest/agile/1.0/board/77"]);
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: "1", deleted: 77 });
  });

  test("--delete-filter reads the board's filter first, then removes both", async () => {
    const { exitCode, stdout } = await run(["delete", "--id", "77", "--confirm", "--delete-filter", "--json"]);
    expect(exitCode).toBe(0);
    expect(writes()).toEqual(["DELETE /rest/agile/1.0/board/77", "DELETE /rest/api/3/filter/500"]);
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: "1", deleted: 77, deletedFilter: "500" });
  });

  // Regression: --delete-filter deleted a filter other boards still used, breaking them.
  test("--delete-filter keeps a filter another board still uses", async () => {
    filterBoards = [88];
    const { exitCode, stdout } = await run(["delete", "--id", "77", "--confirm", "--delete-filter", "--json"]);
    expect(exitCode).toBe(0);
    expect(writes()).toEqual(["DELETE /rest/agile/1.0/board/77"]);
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: "1", deleted: 77, keptFilter: { id: "500", usedByBoards: [88] } });
  });
});

describe("issue rank", () => {
  const rank = (args: string[]) => run(["rank", ...args, "--json"], "issue");
  const ranks = () => requests.filter((r) => r.path === "/rest/agile/1.0/issue/rank").map((r) => r.body);

  test("--before ranks the issues above the target in one call", async () => {
    const { exitCode, stdout } = await rank(["AB-1", "AB-2", "--before", "AB-5"]);
    expect(exitCode).toBe(0);
    expect(ranks()).toEqual([{ issues: ["AB-1", "AB-2"], rankBeforeIssue: "AB-5" }]);
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: "1", ranked: { issues: ["AB-1", "AB-2"], before: "AB-5" } });
  });

  test("more than 50 issues: --after chains each chunk on the last ranked issue", async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `AB-${100 + i}`);
    const { exitCode } = await rank([...keys, "--after", "AB-5"]);
    expect(exitCode).toBe(0);
    expect(ranks()).toEqual([
      { issues: keys.slice(0, 50), rankAfterIssue: "AB-5" },
      { issues: [keys[50]], rankAfterIssue: keys[49] },
    ]);
  });

  test("an issue Jira could not rank fails with its error", async () => {
    const { exitCode, stdout, stderr } = await rank(["AB-1", "AB-9", "--before", "AB-5"]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("AB-9: No permission");
  });

  test("usage errors write nothing", async () => {
    for (const args of [["--before", "AB-5"], ["AB-1"], ["AB-1", "--before", "AB-5", "--after", "AB-6"]]) {
      expect((await rank(args)).exitCode).toBe(1);
    }
    expect(writes()).toEqual([]);
  });
});
