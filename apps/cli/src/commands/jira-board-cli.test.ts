/**
 * `jira board create` and `jira board delete` through the real CLI against a
 * local Bun server that speaks Jira Cloud's platform and Agile APIs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

type Req = { method: string; path: string; body: any };
let requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
/** Whether POST /board fails, as Jira does for a filter it cannot use. */
let boardFails = false;

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
});

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", "board", ...args], {
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
});
