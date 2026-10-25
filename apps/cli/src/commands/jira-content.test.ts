/**
 * Spec jira-content-workflows A1b: markdown descriptions/comments, comment CRUD,
 * history, unlink, search pagination, bulk --issues / move, CSV import.
 *
 * Runs the real CLI in its own process against a local Bun HTTP server that
 * speaks Jira Cloud (deploymentType: "cloud" ⇒ API v3) — no fetch mocking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROFILE = "cloudstub";

type Request = { method: string; path: string; query: URLSearchParams; body: any };
let requests: Request[] = [];
/** Issue links returned for AB-1 (unlink tests). */
let issueLinks: unknown[] = [];

let server: ReturnType<typeof Bun.serve>;
let home: string;

function issue(n: number) {
  return { id: String(n), key: `AB-${n}`, fields: { summary: `Issue ${n}`, status: { name: "To Do" } } };
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);
      requests.push({ method: req.method, path, query: url.searchParams, body });

      if (path === "/rest/api/3/search/jql") {
        const jql: string = body.jql;
        const keys = /key in \(([^)]*)\)/.exec(jql)?.[1]?.split(",").map((k) => k.trim());
        if (keys) return Response.json({ issues: keys.map((k) => issue(Number(k.split("-")[1]))) });
        // 250 matching issues, served in pages of at most 100.
        const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
        const end = Math.min(start + body.maxResults, 250);
        const issues = Array.from({ length: end - start }, (_, i) => issue(start + i + 1));
        return Response.json({ issues, nextPageToken: end < 250 ? String(end) : undefined });
      }
      if (path === "/rest/api/3/issue" && req.method === "POST") {
        return Response.json({ id: "900", key: "AB-900" });
      }
      if (path === "/rest/api/3/issue/AB-900" || path === "/rest/api/3/issue/AB-1") {
        return Response.json({
          id: "1",
          key: "AB-1",
          fields: {
            summary: "Fix it",
            status: { name: "To Do" },
            issuetype: { name: "Task" },
            labels: ["x"],
            issuelinks: issueLinks,
            description: {
              type: "doc",
              version: 1,
              content: [
                { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
                { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }] },
              ],
            },
          },
        });
      }
      if (path === "/rest/api/3/issue/AB-1/comment" && req.method === "GET") {
        return Response.json({
          comments: [{ id: "5", author: { displayName: "Ann" }, created: "c", updated: "u", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "em" }] }] }] } }],
          total: 1,
        });
      }
      if (path.startsWith("/rest/api/3/issue/AB-1/comment")) {
        return req.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "5", body: body?.body });
      }
      if (path === "/rest/api/3/issue/AB-1/changelog") {
        const startAt = Number(url.searchParams.get("startAt"));
        const entry = (id: string, created: string, field: string) => ({
          id,
          created,
          author: { displayName: "Ann" },
          items: [{ field, fieldtype: "jira", from: null, fromString: "old", to: null, toString: "new" }],
        });
        return Response.json(
          startAt === 0
            ? { values: [entry("1", "2026-01-01", "summary")], startAt: 0, total: 2, isLast: false }
            : { values: [entry("2", "2026-02-01", "status")], startAt: 1, total: 2, isLast: true }
        );
      }
      if (path.startsWith("/rest/api/3/issueLink/")) return new Response(null, { status: 204 });
      if (path === "/rest/agile/1.0/backlog/issue") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ message: `stub: no route for ${req.method} ${path}` }), { status: 404 });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-jira-content-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: PROFILE,
      profiles: { [PROFILE]: { name: PROFILE, baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  issueLinks = [];
});

async function runCli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", NO_COLOR: "1" },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
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

const posts = (path: string) => requests.filter((r) => r.method !== "GET" && r.path === path);

describe("rich text", () => {
  it("--description-file - reads markdown from stdin and sends ADF", async () => {
    const { exitCode } = await runCli(
      ["jira", "issue", "create", "--project", "AB", "--type", "Task", "--summary", "S", "--description-file", "-", "--json"],
      "## Steps\n\n- [ ] one\n\n`code`"
    );
    expect(exitCode).toBe(0);
    const description = posts("/rest/api/3/issue")[0]!.body.fields.description;
    expect(description.type).toBe("doc");
    expect(description.content.map((n: { type: string }) => n.type)).toEqual(["heading", "taskList", "paragraph"]);
  }, 30_000);

  it("--description and --description-file together is a usage error", async () => {
    const { exitCode, stderr, stdout } = await runCli(["jira", "issue", "update", "--key", "AB-1", "--description", "a", "--description-file", "x.md", "--json"]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("not both");
  }, 30_000);

  it("issue get --format markdown prints front matter and markdown", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "get", "--key", "AB-1", "--format", "markdown"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("key: AB-1");
    expect(stdout).toContain('summary: "Fix it"');
    expect(stdout).toContain("## Steps\n\n**bold**");
  }, 30_000);

  it("issue get --format markdown piped into update --description-file - drops the front block", async () => {
    const got = await runCli(["jira", "issue", "get", "--key", "AB-1", "--format", "markdown"]);
    const { exitCode } = await runCli(
      ["jira", "issue", "update", "--key", "AB-1", "--description-file", "-", "--json"],
      got.stdout.replace("**bold**", "**bolder**")
    );
    expect(exitCode).toBe(0);
    const description = posts("/rest/api/3/issue/AB-1").find((r) => r.method === "PUT")!.body.fields.description;
    expect(JSON.stringify(description)).not.toContain("key: AB-1");
    expect(description.content.map((n: { type: string }) => n.type)).toEqual(["heading", "paragraph"]);
    expect(description.content[1].content[0]).toEqual({ type: "text", text: "bolder", marks: [{ type: "strong" }] });
  }, 30_000);

  it("a description that only starts with a rule keeps it", async () => {
    await runCli(
      ["jira", "issue", "update", "--key", "AB-1", "--description-file", "-", "--json"],
      "---\n\nNot front matter: a rule, then text.\n"
    );
    const description = posts("/rest/api/3/issue/AB-1").find((r) => r.method === "PUT")!.body.fields.description;
    expect(description.content.map((n: { type: string }) => n.type)).toEqual(["rule", "paragraph"]);
  }, 30_000);

  it("issue get --json adds descriptionMarkdown", async () => {
    const { stdout } = await runCli(["jira", "issue", "get", "--key", "AB-1", "--json"]);
    expect(JSON.parse(stdout).issue.descriptionMarkdown).toBe("## Steps\n\n**bold**");
  }, 30_000);
});

describe("comments and history", () => {
  it("comments list returns markdown bodies", async () => {
    const { stdout } = await runCli(["jira", "issue", "comments", "list", "--key", "AB-1", "--json"]);
    expect(JSON.parse(stdout).comments).toEqual([
      { id: "5", author: "Ann", authorId: undefined, created: "c", updated: "u", body: "*hi*" },
    ].map(({ authorId, ...rest }) => rest));
  }, 30_000);

  it("comments edit sends ADF from --body", async () => {
    const { exitCode } = await runCli(["jira", "issue", "comments", "edit", "--key", "AB-1", "--id", "5", "--body", "**new**", "--json"]);
    expect(exitCode).toBe(0);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/rest/api/3/issue/AB-1/comment/5");
    expect(put.body.body.content[0].content[0]).toEqual({ type: "text", text: "new", marks: [{ type: "strong" }] });
  }, 30_000);

  it("comments delete needs --confirm", async () => {
    expect((await runCli(["jira", "issue", "comments", "delete", "--key", "AB-1", "--id", "5", "--json"])).exitCode).toBe(1);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    expect((await runCli(["jira", "issue", "comments", "delete", "--key", "AB-1", "--id", "5", "--confirm", "--json"])).exitCode).toBe(0);
  }, 30_000);

  it("history pages through the changelog, newest first", async () => {
    const { stdout } = await runCli(["jira", "issue", "history", "--key", "AB-1", "--json"]);
    const rows = JSON.parse(stdout).history;
    expect(rows.map((r: { field: string }) => r.field)).toEqual(["status", "summary"]);
    expect(rows[0]).toMatchObject({ from: "old", to: "new", author: "Ann" });
  }, 30_000);
});

describe("unlink", () => {
  const link = (id: string, type: string) => ({ id, type: { name: type, inward: `${type} by`, outward: type }, outwardIssue: { id: "2", key: "AB-2" } });

  it("several links between the pair fail with the candidates", async () => {
    issueLinks = [link("10", "Blocks"), link("11", "Relates")];
    const { exitCode, stdout } = await runCli(["jira", "issue", "unlink", "--from", "AB-1", "--to", "AB-2", "--confirm", "--json"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Several links");
    expect(requests.some((r) => r.path.startsWith("/rest/api/3/issueLink/"))).toBe(false);
  }, 30_000);

  it("--type picks one link and --confirm deletes it", async () => {
    issueLinks = [link("10", "Blocks"), link("11", "Relates")];
    const { exitCode } = await runCli(["jira", "issue", "unlink", "--from", "AB-1", "--to", "AB-2", "--type", "relates", "--confirm", "--json"]);
    expect(exitCode).toBe(0);
    expect(requests.find((r) => r.method === "DELETE")!.path).toBe("/rest/api/3/issueLink/11");
  }, 30_000);
});

describe("search pagination (regression: --limit above one page was truncated)", () => {
  it("--limit 120 fetches across pages and reports hasMore", async () => {
    const { stdout } = await runCli(["jira", "search", "--jql", "project = AB", "--limit", "120", "--json"]);
    const result = JSON.parse(stdout);
    expect(result.issues).toHaveLength(120);
    expect(result.total).toBe(120);
    expect(result.hasMore).toBe(true);
    expect(requests.filter((r) => r.path === "/rest/api/3/search/jql").map((r) => r.body.maxResults)).toEqual([100, 20]);
  }, 30_000);
});

describe("bulk", () => {
  it("--issues becomes a key in (...) query", async () => {
    const { stdout } = await runCli(["jira", "bulk", "label", "add", "x", "--issues", "AB-1,AB-2", "--dry-run", "--json"]);
    expect(JSON.parse(stdout).jql).toBe("key in (AB-1, AB-2)");
  }, 30_000);

  it("edit --set keeps commas inside a value and accepts repeated --set (regression)", async () => {
    const { stdout, exitCode } = await runCli([
      "jira", "bulk", "edit", "--issues", "AB-1", "--set", "labels=backend,tech-debt", "--set", "priority=High", "--dry-run", "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).fields).toEqual({ labels: ["backend", "tech-debt"], priority: { name: "High" } });
  }, 30_000);

  it("--jql and --issues together is a usage error", async () => {
    expect((await runCli(["jira", "bulk", "delete", "--jql", "x", "--issues", "AB-1", "--confirm", "--json"])).exitCode).toBe(1);
  }, 30_000);

  it("move --backlog chunks requests at 50 issues", async () => {
    const { exitCode, stdout } = await runCli(["jira", "bulk", "move", "--jql", "project = AB", "--backlog", "--limit", "60", "--json"]);
    expect(exitCode).toBe(0);
    expect(posts("/rest/agile/1.0/backlog/issue").map((r) => r.body.issues.length)).toEqual([50, 10]);
    expect(JSON.parse(stdout).result).toMatchObject({ total: 60, successful: 60, failed: 0 });
  }, 30_000);
});

describe("import (regression: v3 rejected plain-string descriptions)", () => {
  it("CSV markdown descriptions are sent as ADF, multi-line cells intact", async () => {
    await writeFile(join(home, "issues.csv"), 'Title,Body\n"One","- a\n- b"\n');
    const { exitCode } = await runCli([
      "jira", "import", "--file", "issues.csv", "--project", "AB",
      "--map-field", "Title=summary", "--map-field", "Body=description", "--json",
    ]);
    expect(exitCode).toBe(0);
    const created = posts("/rest/api/3/issue")[0]!.body.fields;
    expect(created.summary).toBe("One");
    expect(created.description.content[0].type).toBe("bulletList");
  }, 30_000);
});
