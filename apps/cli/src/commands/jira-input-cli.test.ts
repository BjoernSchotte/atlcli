/**
 * User resolution, search flags, the issue table, clone, web links, internal
 * comments, `filter run`/`share --user` and `field list --system`, through the
 * real CLI against a local Bun server that speaks Jira Cloud.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

type Req = { method: string; path: string; query: URLSearchParams; body: any };
let requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

const USERS = [
  { accountId: "acc-ann", displayName: "Ann Lee", emailAddress: "ann@example.com", active: true },
  { accountId: "acc-anna", displayName: "Anna Lee", emailAddress: "anna@example.com", active: true },
];
const ISSUE = {
  id: "1",
  key: "AB-1",
  fields: {
    project: { key: "AB" },
    summary: "Fix it, v1",
    status: { name: "To Do" },
    issuetype: { name: "Bug" },
    priority: { id: "3", name: "Medium" },
    labels: ["x"],
    components: [{ id: "10", name: "Core" }],
    customfield_10016: 3,
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "see v1" }] }] },
  },
};

/** ISSUE as Jira returns it for `?expand=changelog,renderedFields` (plus the `expand` list Jira always sends). */
const EXPANDED = {
  ...ISSUE,
  expand: "renderedFields,names,schema,changelog",
  renderedFields: { description: "<p>see v1</p>" },
  changelog: {
    startAt: 0,
    maxResults: 1,
    total: 1,
    histories: [
      {
        id: "100",
        author: { accountId: "acc-ann", displayName: "Ann Lee" },
        created: "2026-10-01T10:00:00.000+0000",
        items: [{ field: "status", fieldtype: "jira", from: "1", fromString: "To Do", to: "3", toString: "In Progress" }],
      },
    ],
  },
};

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);
      requests.push({ method: req.method, path, query: url.searchParams, body });

      if (path === "/rest/api/3/myself") return Response.json({ accountId: "acc-me", displayName: "Me" });
      if (path === "/rest/api/3/user/search") {
        const q = url.searchParams.get("query")!.toLowerCase();
        return Response.json(USERS.filter((u) => u.displayName.toLowerCase().includes(q) || u.emailAddress.includes(q)));
      }
      if (path === "/rest/api/3/search/jql") return Response.json({ issues: [ISSUE] });
      if (path === "/rest/api/3/field") return Response.json([{ id: "customfield_10016", name: "Story Points", custom: true }, { id: "summary", name: "Summary", custom: false }]);
      if (path === "/rest/api/3/filter/7") return Response.json({ id: "7", name: "Mine", jql: "project = AB ORDER BY rank" });
      // Jira answers with all of the filter's permissions, the new one among them.
      if (path === "/rest/api/3/filter/7/permission") {
        return Response.json([
          { id: 1, type: "group", group: { name: "devs" } },
          { id: 2, type: "user", user: { accountId: body.accountId, displayName: "Anna Lee" } },
          { id: 3, type: "global" },
        ]);
      }
      if (path === "/rest/api/3/issue" && req.method === "POST") return Response.json({ id: "2", key: "AB-2" });
      if (path === "/rest/api/3/issue/AB-1/assignee") return new Response(null, { status: 204 });
      if (path === "/rest/api/3/issue/AB-1/comment") return Response.json({ id: "9", body: body.body });
      if (path === "/rest/api/3/issue/AB-1/remotelink" && req.method === "POST") return Response.json({ id: 77, self: "" });
      if (path === "/rest/api/3/issue/AB-1/remotelink/77") return new Response(null, { status: 204 });
      if (path === "/rest/api/3/issue/NOPE-1") return Response.json({ errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} }, { status: 404 });
      if (path.startsWith("/rest/api/3/issue/") && url.searchParams.get("expand")) return Response.json(EXPANDED);
      if (path.startsWith("/rest/api/3/issue/")) return Response.json(ISSUE);
      if (path === "/rest/api/3/project/AB") return Response.json({ id: "1", key: "AB", name: "Alpha" });
      if (path === "/rest/api/3/project/AB/statuses" || path === "/rest/api/3/issue/createmeta/AB/issuetypes") return Response.json({ issueTypes: [], values: [] });
      // 120 boards and 60 sprints, served in pages of at most 50 whatever maxResults asks for.
      if (path === "/rest/agile/1.0/board" || path === "/rest/agile/1.0/board/9/sprint") {
        const all = path.endsWith("/sprint") ? 60 : 120;
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const end = Math.min(start + Math.min(50, Number(url.searchParams.get("maxResults"))), all);
        const values = Array.from({ length: end - start }, (_, i) => ({ id: start + i + 1, name: `B${start + i + 1}`, state: "closed" }));
        return Response.json({ values, total: all, isLast: end >= all });
      }
      if (path === "/rest/agile/1.0/board/9/epic") return Response.json({ values: [], total: 0 });
      if (path.endsWith("/content/55")) return Response.json({ id: "55", title: "Spec", type: "page", space: { key: "DOCSY" }, version: { number: 1 }, ancestors: [] });
      return new Response(JSON.stringify({ message: `stub: no route for ${path}` }), { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-jira-input-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "p",
      global: { board: 9 },
      profiles: {
        p: { name: "p", baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } },
        dc: { name: "dc", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" } },
      },
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

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}
const sent = (path: string) => requests.find((r) => r.path === path && r.method !== "GET")?.body;

describe("users", () => {
  test("search --assignee by email resolves to the account id", async () => {
    const { exitCode } = await run(["search", "--assignee", "ann@example.com", "--json"]);
    expect(exitCode).toBe(0);
    expect(sent("/rest/api/3/search/jql").jql).toBe('assignee = "acc-ann"');
  });

  test("an ambiguous name is a usage error listing the candidates", async () => {
    const { exitCode, stdout } = await run(["issue", "assign", "--key", "AB-1", "--assignee", "lee", "--json"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain("Ann Lee <ann@example.com>, Anna Lee");
  });

  test("assign default and create --assignee me", async () => {
    await run(["issue", "assign", "--key", "AB-1", "--assignee", "default", "--json"]);
    expect(sent("/rest/api/3/issue/AB-1/assignee")).toEqual({ accountId: "-1" });
    await run(["issue", "create", "--project", "AB", "--type", "Task", "--summary", "s", "--assignee", "me", "--json"]);
    expect(sent("/rest/api/3/issue").fields.assignee).toEqual({ accountId: "acc-me" });
  });
});

describe("search", () => {
  test("list flags, watching and relative dates build one JQL", async () => {
    await run(["search", "--project", "AB", "--type", "Bug,Task", "--watching", "--updated", "-7d", "--json"]);
    expect(sent("/rest/api/3/search/jql").jql).toBe(
      'project = AB AND issuetype in ("Bug", "Task") AND watcher = currentUser() AND updated >= -7d'
    );
  });

  test("a bad --created is a usage error", async () => {
    const { exitCode } = await run(["search", "--created", "yesterday"]);
    expect(exitCode).toBe(1);
  });

  test("text output is a table; --columns with a field name and --csv", async () => {
    const table = await run(["search", "--project", "AB"]);
    expect(table.stdout).toBe("key   type  status  assignee  summary\nAB-1  Bug   To Do             Fix it, v1\n");
    const csv = await run(["search", "--project", "AB", "--columns", "key,Story Points,summary", "--csv", "--no-headers"]);
    expect(csv.stdout).toBe('AB-1,3,"Fix it, v1"\n');
  });

  test("filter run searches the filter's JQL", async () => {
    const { stdout } = await run(["filter", "run", "7", "--json"]);
    expect(sent("/rest/api/3/search/jql").jql).toBe("project = AB ORDER BY rank");
    expect(JSON.parse(stdout).issues[0].key).toBe("AB-1");
  });
});

describe("issue", () => {
  test("clone copies fields and applies --replace to summary and description", async () => {
    const { exitCode } = await run(["issue", "clone", "AB-1", "--replace", "v1:v2", "--json"]);
    expect(exitCode).toBe(0);
    const fields = sent("/rest/api/3/issue").fields;
    expect(fields).toMatchObject({
      project: { key: "AB" },
      issuetype: { name: "Bug" },
      summary: "Fix it, v2",
      labels: ["x"],
      components: [{ id: "10" }],
    });
    expect(fields.description.content[0].content[0].text).toBe("see v2");
    // Not copied: the source's priority may be outside the target's scheme (live: 400).
    expect(fields.priority).toBeUndefined();
  });

  test("web link add and remove", async () => {
    const add = await run(["issue", "link", "--key", "AB-1", "--url", "https://example.com", "--title", "Spec", "--json"]);
    expect(JSON.parse(add.stdout).linked.linkId).toBe(77);
    expect(sent("/rest/api/3/issue/AB-1/remotelink")).toEqual({ object: { url: "https://example.com", title: "Spec" } });
    await run(["issue", "unlink", "--key", "AB-1", "--remote", "77", "--json"]);
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/rest/api/3/issue/AB-1/remotelink/77")).toBe(true);
  });

  test("comments add --internal sets the JSM property", async () => {
    await run(["issue", "comments", "add", "--key", "AB-1", "hello", "--internal", "--json"]);
    expect(sent("/rest/api/3/issue/AB-1/comment").properties).toEqual([{ key: "sd.public.comment", value: { internal: true } }]);
  });

  test("--edit without a terminal is a usage error", async () => {
    const { exitCode, stdout } = await run(["issue", "comments", "add", "--key", "AB-1", "--edit", "--json"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain("--edit needs a terminal");
  });
});

describe("paging and fixes from the docs audit", () => {
  test("board list and sprint list page past Jira's 50 per page (regression: stopped at 50)", async () => {
    const boards = await run(["board", "list", "--all-projects", "--limit", "120", "--json"]);
    expect(JSON.parse(boards.stdout).boards).toHaveLength(120);
    const capped = await run(["board", "list", "--all-projects", "--json"]);
    expect(JSON.parse(capped.stdout).boards).toHaveLength(50);
    expect(capped.stderr).toContain("Showing 50 of 120 boards");
    const sprints = await run(["sprint", "list", "--board", "9", "--limit", "100", "--json"]);
    expect(JSON.parse(sprints.stdout).sprints.map((s: { id: number }) => s.id)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  test("project get takes the key positionally (regression: only --key worked)", async () => {
    const { exitCode, stdout } = await run(["project", "get", "AB", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).project.key).toBe("AB");
  });

  test("bulk link-page --comment posts the comment (regression: a bare --comment was dropped)", async () => {
    const { exitCode } = await run(["bulk", "link-page", "--issues", "AB-1", "--page", "55", "--comment", "--json"]);
    expect(exitCode).toBe(0);
    expect(requests.some((r) => r.method === "POST" && r.path === "/rest/api/3/issue/AB-1/comment")).toBe(true);
  });

  test("bulk link-page --comment posts the same link comment as issue link-page (#290)", async () => {
    await run(["issue", "link-page", "--key", "AB-1", "--page", "55", "--comment", "--json"]);
    const single = sent("/rest/api/3/issue/AB-1/comment");
    requests = [];
    await run(["bulk", "link-page", "--issues", "AB-1", "--page", "55", "--comment", "--json"]);
    expect(sent("/rest/api/3/issue/AB-1/comment")).toEqual(single);
    expect(JSON.stringify(single)).toContain("Linked to Confluence page: ");
  });

  test("link-page --comment <text> posts that text as Markdown, not the fixed text (#290)", async () => {
    for (const args of [["issue", "link-page", "--key", "AB-1"], ["bulk", "link-page", "--issues", "AB-1"]]) {
      requests = [];
      await run([...args, "--page", "55", "--comment", "See **spec**", "--json"]);
      expect(sent("/rest/api/3/issue/AB-1/comment").body.content[0].content).toEqual([
        { type: "text", text: "See " },
        { type: "text", text: "spec", marks: [{ type: "strong" }] },
      ]);
    }
  });

  test("bulk link-page --dry-run says which comment would be added (#290)", async () => {
    const without = JSON.parse((await run(["bulk", "link-page", "--issues", "AB-1", "--page", "55", "--dry-run", "--json"])).stdout);
    expect(without.comment).toBeNull();
    const bare = JSON.parse((await run(["bulk", "link-page", "--issues", "AB-1", "--page", "55", "--comment", "--dry-run", "--json"])).stdout);
    expect(bare.comment).toStartWith("Linked to Confluence page: [Spec](");
    const text = JSON.parse((await run(["bulk", "link-page", "--issues", "AB-1", "--page", "55", "--comment", "hi", "--dry-run", "--json"])).stdout);
    expect(text.comment).toBe("hi");
    expect(requests.some((r) => r.path.endsWith("/comment"))).toBe(false);
  });

  test("epic list --project wins over defaults.board (regression: board path taken)", async () => {
    await run(["epic", "list", "--project", "AB", "--json"]);
    expect(requests.some((r) => r.path === "/rest/api/3/search/jql")).toBe(true);
    expect(requests.some((r) => r.path.endsWith("/epic"))).toBe(false);
  });
});

describe("errors, detail views, Data Center", () => {
  test("--json: an API error is the error object on stdout, coded by status (regression: plain text)", async () => {
    const { stdout, exitCode } = await run(["issue", "get", "--key", "NOPE-1", "--json"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error).toEqual({
      code: "ATLCLI_ERR_NOT_FOUND",
      message: expect.stringContaining("Jira API error (404)"),
      details: { status: 404 },
    });
  });

  test("issue get prints a text view; --format json keeps the JSON", async () => {
    const text = await run(["issue", "get", "--key", "AB-1"]);
    expect(text.stdout).toStartWith("AB-1  Fix it, v1\n\nStatus");
    expect(text.stdout).toContain("Assignee    (unassigned)");
    expect(text.stdout).toContain("Description\n  see v1");
    const json = await run(["issue", "get", "--key", "AB-1", "--format", "json"]);
    expect(JSON.parse(json.stdout).issue.key).toBe("AB-1");
  });

  test("issue get --expand keeps the expanded sections next to issue (#292)", async () => {
    const { stdout } = await run(["issue", "get", "--key", "AB-1", "--expand", "changelog,renderedFields", "--json"]);
    const out = JSON.parse(stdout);
    expect(requests.find((r) => r.path === "/rest/api/3/issue/AB-1")?.query.get("expand")).toBe("changelog,renderedFields");
    expect(out.issue.key).toBe("AB-1");
    expect(out.changelog).toEqual(EXPANDED.changelog);
    expect(out.renderedFields).toEqual(EXPANDED.renderedFields);
    // Jira's list of available expands is noise, not data.
    expect(out.expand).toBeUndefined();
    const plain = JSON.parse((await run(["issue", "get", "--key", "AB-1", "--json"])).stdout);
    expect(Object.keys(plain)).toEqual(["schemaVersion", "issue"]);
  });

  test("issue get --expand changelog shows History in the text view; markdown stays writable (#292)", async () => {
    const text = await run(["issue", "get", "--key", "AB-1", "--expand", "changelog,renderedFields"]);
    expect(text.stdout).toContain("History\n  2026-10-01  Ann Lee  status: To Do → In Progress");
    expect(text.stderr).toContain("Note: renderedFields only shown with --format json.");
    const md = await run(["issue", "get", "--key", "AB-1", "--expand", "changelog", "--format", "markdown"]);
    expect(md.stdout).not.toContain("In Progress");
    // The stub always answers with both sections.
    expect(md.stderr).toContain("Note: renderedFields, changelog only shown with --format json.");
  });

  test("Data Center: --lead fails clearly instead of being dropped (regression: silently ignored)", async () => {
    const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", "component", "create", "--project", "AB", "--name", "X", "--lead", "me", "--profile", "dc", "--json"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(JSON.parse(out).error.message).toBe("--lead needs Jira Cloud; on Data Center set it in Jira.");
    expect(requests.some((r) => r.path.includes("component"))).toBe(false);
  });
});

describe("filters and fields (regressions: documented, missing)", () => {
  test("filter share --user shares with the resolved account", async () => {
    const { exitCode, stdout } = await run(["filter", "share", "7", "--user", "anna@example.com", "--json"]);
    expect(exitCode).toBe(0);
    expect(sent("/rest/api/3/filter/7/permission")).toEqual({ type: "user", accountId: "acc-anna" });
    // Regression (live): the answer is a list; the output showed an empty permission.
    expect(JSON.parse(stdout).shared.permission).toMatchObject({ id: 2, type: "user", user: "Anna Lee" });
  });

  test("field list --system leaves out custom fields", async () => {
    const { stdout } = await run(["field", "list", "--system", "--json"]);
    expect(JSON.parse(stdout).fields.map((f: { id: string }) => f.id)).toEqual(["summary"]);
  });
});
