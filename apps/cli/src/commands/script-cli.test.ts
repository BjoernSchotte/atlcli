/**
 * `atlcli script` through the real CLI against a local Bun server that speaks
 * enough Jira Cloud (v3) and Confluence (v1 REST) for the script verbs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

// Every test spawns the real CLI, several do so up to six times (and the
// export test a nested child). Bun's 5 s default is too tight on CI runners.
setDefaultTimeout(60_000);

type Issue = {
  id: string;
  key: string;
  fields: { summary: string; updated: string; status: { name: string }; labels?: string[] };
  comments: string[];
};
type Page = { id: string; title: string; space: string; version: number; storage: string; labels: string[]; parentId?: string };

let server: ReturnType<typeof Bun.serve>;
let home: string;
let writes: string[] = [];
let links: unknown[] = [];
let issues = new Map<string, Issue>();
let pages = new Map<string, Page>();
let clock = 0;
let nextId = 100;
/** Issues whose comment endpoint answers 400 (no retry), to make an apply fail midway. */
let rejectComments = new Set<string>();
/** Bodies of transition, watcher and notify requests, for assertions. */
let bodies: Array<[string, unknown]> = [];
let watchers = new Map<string, string[]>();

const tick = () => `2026-10-24T10:00:${String(clock++).padStart(2, "0")}.000+0000`;

function reset(): void {
  writes = [];
  rejectComments = new Set();
  bodies = [];
  watchers = new Map([["ATLCLI-1", ["acc-ada"]]]);
  links = [];
  clock = 0;
  nextId = 100;
  issues = new Map(
    ["ATLCLI-1", "ATLCLI-2"].map((key, i) => [
      key,
      { id: String(i + 1), key, fields: { summary: `Old issue ${i + 1}`, updated: tick(), status: { name: "To Do" } }, comments: [] },
    ]),
  );
  pages = new Map([["900", { id: "900", title: "Release Notes", space: "DOCSY", version: 4, storage: "<p>old</p>", labels: [] }]]);
}

const pageJson = (p: Page) => ({
  id: p.id,
  type: "page",
  title: p.title,
  space: { key: p.space },
  version: { number: p.version },
  body: { storage: { value: p.storage, representation: "storage" } },
  ancestors: p.parentId ? [{ id: p.parentId, title: "parent" }] : [],
  _links: { webui: `/spaces/${p.space}/pages/${p.id}` },
});

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      if (req.method !== "GET") writes.push(`${req.method} ${path}`);
      let m: RegExpExecArray | null;

      if (path === "/rest/api/3/search/jql" && req.method === "POST") {
        writes.pop(); // a search is a read even though it is a POST
        return Response.json({ issues: [...issues.values()].map(({ comments: _, ...i }) => i) });
      }
      if (path === "/rest/api/3/issue" && req.method === "POST") {
        const key = `ATLCLI-${nextId++}`;
        issues.set(key, { id: key, key, fields: { summary: body.fields.summary, updated: tick(), status: { name: "To Do" } }, comments: [] });
        return Response.json({ id: key, key, self: "" }, { status: 201 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(path))) {
        const issue = issues.get(m[1]!);
        if (!issue) return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
        if (req.method === "PUT") {
          if (body.fields?.summary) issue.fields.summary = body.fields.summary;
          for (const change of body.update?.labels ?? []) {
            const labels = (issue.fields.labels ?? []).filter((l) => l !== change.remove);
            issue.fields.labels = change.add ? [...labels, change.add] : labels;
          }
          issue.fields.updated = tick();
          return new Response(null, { status: 204 });
        }
        const { comments: _, ...view } = issue;
        return Response.json(view);
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/.exec(path))) {
        const issue = issues.get(m[1]!)!;
        if (req.method === "GET") return Response.json({ transitions: [{ id: "31", name: "Done", hasScreen: true }, { id: "41", name: "Won't Do", hasScreen: false }] });
        bodies.push(["transition", body]);
        issue.fields.status = { name: body.transition.id === "31" ? "Done" : "Won't Do" };
        issue.fields.updated = tick();
        return new Response(null, { status: 204 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/watchers$/.exec(path))) {
        const list = watchers.get(m[1]!) ?? [];
        if (req.method === "GET") return Response.json({ watchers: list.map((accountId) => ({ accountId })), watchCount: list.length, isWatching: false });
        if (req.method === "POST") watchers.set(m[1]!, [...list, body]);
        if (req.method === "DELETE") watchers.set(m[1]!, list.filter((a) => a !== url.searchParams.get("accountId")));
        return new Response(null, { status: 204 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/notify$/.exec(path))) {
        bodies.push(["notify", body]);
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/api/3/user/search") {
        return Response.json([{ accountId: `acc-${url.searchParams.get("query")?.split("@")[0]}`, displayName: url.searchParams.get("query") }]);
      }
      if (path === "/rest/api/3/issueLinkType") {
        return Response.json({ issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }] });
      }
      if (path === "/rest/api/3/issueLink" && req.method === "POST") {
        links.push(body);
        return new Response(null, { status: 201 });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(path))) {
        if (rejectComments.has(m[1]!)) return Response.json({ errorMessages: ["Comments are locked"] }, { status: 400 });
        const issue = issues.get(m[1]!)!;
        issue.comments.push(JSON.stringify(body.body));
        return Response.json({ id: String(5000 + issue.comments.length), body: body.body }, { status: 201 });
      }

      if (path === "/wiki/rest/api/content/search") {
        const results = [...pages.values()].map((p) => ({ ...pageJson(p), body: undefined }));
        return Response.json({ results, start: 0, limit: 100, size: results.length, _links: {} });
      }
      if (path === "/wiki/rest/api/content" && req.method === "GET") {
        const title = url.searchParams.get("title");
        const space = url.searchParams.get("spaceKey");
        const results = [...pages.values()].filter((p) => p.title === title && (!space || p.space === space)).map(pageJson);
        return Response.json({ results, _links: {} });
      }
      if (path === "/wiki/rest/api/content" && req.method === "POST") {
        const id = String(nextId++);
        const page: Page = { id, title: body.title, space: body.space.key, version: 1, storage: body.body.storage.value, labels: [], parentId: body.ancestors?.[0]?.id };
        pages.set(id, page);
        return Response.json(pageJson(page));
      }
      if ((m = /^\/wiki\/rest\/api\/content\/(\d+)$/.exec(path))) {
        const page = pages.get(m[1]!);
        if (!page) return Response.json({ message: "No content found" }, { status: 404 });
        if (req.method === "DELETE") {
          pages.delete(page.id);
          return new Response(null, { status: 204 });
        }
        if (req.method === "PUT") {
          if (body.version.number !== page.version + 1) return Response.json({ message: "Version conflict" }, { status: 409 });
          Object.assign(page, { title: body.title, storage: body.body.storage.value, version: body.version.number });
          return Response.json(pageJson(page));
        }
        return Response.json(pageJson(page));
      }
      if ((m = /^\/wiki\/rest\/api\/content\/(\d+)\/label\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
        const page = pages.get(m[1]!)!;
        const label = decodeURIComponent(m[2]!);
        if (!page.labels.includes(label)) {
          return Response.json({ statusCode: 404, message: `NotFoundException: No label found with name: ${label}` }, { status: 404 });
        }
        page.labels = page.labels.filter((l) => l !== label);
        return new Response(null, { status: 204 });
      }
      if ((m = /^\/wiki\/rest\/api\/content\/(\d+)\/label$/.exec(path))) {
        const page = pages.get(m[1]!)!;
        page.labels.push(...body.map((l: { name: string }) => l.name));
        return Response.json({ results: page.labels.map((name) => ({ prefix: "global", name })) });
      }
      if (path === "/hook") {
        bodies.push(["hook", { method: req.method, auth: req.headers.get("authorization"), body }]);
        return new Response(null, { status: 204 });
      }
      if (path === "/feed" && req.method === "GET") return Response.json({ items: ["a", "b"], auth: req.headers.get("authorization") });
      if (path === "/rest/api/3/version" && req.method === "POST") {
        bodies.push(["version", body]);
        return Response.json({ id: "10500", name: body.name }, { status: 201 });
      }
      return Response.json({ message: `stub: no route for ${req.method} ${path}${url.search}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-script-cli-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "p",
      profiles: { p: { name: "p", baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } } },
    }),
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(reset);

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "script", ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function script(name: string, source: string): Promise<string> {
  const file = join(home, name);
  await writeFile(file, source, "utf8");
  return file;
}

const HOUSEKEEPING = `
for await (const issue of atlcli.jira.search("project = ATLCLI")) {
  await atlcli.jira.comment(issue.key, "Closing: " + atlcli.params.reason);
  await atlcli.jira.transition(issue.key, "won't do");
}
const notes = await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Release Notes", markdown: "# New" });
await atlcli.confluence.addLabels(notes.id, ["release"]);
console.log("planned", notes.id);
`;

describe("script run", () => {
  test("plans a plain script without writing anything", async () => {
    const file = await script("housekeeping.ts", HOUSEKEEPING);
    const { exitCode, stdout, stderr } = await run(["run", file, "--param", "reason=stale"]);
    expect(exitCode, stderr).toBe(0);
    expect(writes).toEqual([]);
    expect(stdout).toContain("Plan: 6 operations");
    expect(stdout).toContain('jira comment     ATLCLI-1 "Closing: stale"');
    expect(stdout).toContain("jira transition  ATLCLI-2 → won't do");
    expect(stdout).toContain('page update      900 "Release Notes"');
    expect(stdout).toContain("Nothing was changed.");
    expect(stderr).toContain("planned 900");
  });

  test("--plan-out writes a plan that apply executes", async () => {
    const file = await script("housekeeping.ts", HOUSEKEEPING);
    const planFile = join(home, "plan.json");
    expect((await run(["run", file, "--param", "reason=stale", "--plan-out", planFile])).exitCode).toBe(0);
    const plan = JSON.parse(await readFile(planFile, "utf8"));
    expect(plan.schema).toBe("atlcli.script-plan/1");
    expect(plan.script.name).toBe("housekeeping");

    const { exitCode, stdout, stderr } = await run(["apply", planFile, "--yes", "--json"]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).report.status).toBe("applied");
    expect(writes).toEqual([
      "POST /rest/api/3/issue/ATLCLI-1/comment",
      "POST /rest/api/3/issue/ATLCLI-1/transitions",
      "POST /rest/api/3/issue/ATLCLI-2/comment",
      "POST /rest/api/3/issue/ATLCLI-2/transitions",
      "PUT /wiki/rest/api/content/900",
      "POST /wiki/rest/api/content/900/label",
    ]);
    expect(issues.get("ATLCLI-1")!.fields.status.name).toBe("Won't Do");
    expect(pages.get("900")).toMatchObject({ version: 5, labels: ["release"] });
  });

  test("apply aborts with exit 2 and writes nothing when a target drifted", async () => {
    const file = await script("housekeeping.ts", HOUSEKEEPING);
    const planFile = join(home, "plan.json");
    await run(["run", file, "--param", "reason=stale", "--plan-out", planFile]);
    pages.get("900")!.version = 5; // edited by someone else
    const { exitCode, stderr } = await run(["apply", planFile, "--yes"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("page 900 at version 4: now version 5");
    expect(writes).toEqual([]);
  });

  test("apply rejects a modified plan", async () => {
    const file = await script("housekeeping.ts", HOUSEKEEPING);
    const planFile = join(home, "plan.json");
    await run(["run", file, "--param", "reason=stale", "--plan-out", planFile]);
    const plan = JSON.parse(await readFile(planFile, "utf8"));
    plan.operations[0].args.markdown = "something else";
    await writeFile(planFile, JSON.stringify(plan));
    const { exitCode, stderr } = await run(["apply", planFile, "--yes"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("digest mismatch");
    expect(writes).toEqual([]);
  });

  test("--apply --yes plans and applies in one go, creating with real keys", async () => {
    const file = await script(
      "create.ts",
      `const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "New" });
await atlcli.jira.transition(issue.key, "Done");`,
    );
    const { exitCode, stdout, stderr } = await run(["run", "--apply", file, "--yes"]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Applied 2 operations. Created: ATLCLI-100");
    expect(issues.get("ATLCLI-100")!.fields.status.name).toBe("Done");
  });

  test("applies links, labels and deletes; a failing export stops the run with the child's error", async () => {
    pages.get("900")!.labels = ["old"];
    pages.set("901", { id: "901", title: "Obsolete", space: "DOCSY", version: 2, storage: "<p>x</p>", labels: [] });
    const file = await script(
      "more.ts",
      `await atlcli.jira.link("ATLCLI-1", "is blocked by", "ATLCLI-2");
await atlcli.jira.addLabels("ATLCLI-1", ["triaged"]);
await atlcli.confluence.removeLabels("900", ["old", "never-set"]);
await atlcli.confluence.deletePage("901");
await atlcli.confluence.export("900", { format: "pdf", path: "out/notes.pdf" });`,
    );
    const { exitCode, stdout, stderr } = await run(["run", "--apply", file, "--yes"]);
    expect(stdout).toContain("jira link        ATLCLI-2 Blocks ATLCLI-1");
    expect(stdout).toContain('page DELETE      901 "Obsolete" (to trash)');
    expect(stdout).toContain("page export      900 → out/notes.pdf");
    expect(exitCode).toBe(1);
    // The export runs this CLI as a child process; its error comes back as the operation's.
    expect(stderr).toContain(
      "Operation #5 failed: wiki export failed (exit 4): Export failed (exit 4): The Confluence export source could not be resolved. 4 of 5 operations were applied",
    );
    expect(links).toEqual([{ type: { name: "Blocks" }, inwardIssue: { key: "ATLCLI-2" }, outwardIssue: { key: "ATLCLI-1" } }]);
    expect(issues.get("ATLCLI-1")!.fields.labels).toEqual(["triaged"]);
    expect(pages.get("900")!.labels).toEqual([]);
    expect(pages.has("901")).toBe(false);
  });

  test("--apply without a terminal requires --yes", async () => {
    const file = await script("create.ts", `await atlcli.jira.comment("ATLCLI-1", "hi");`);
    const { exitCode, stderr } = await run(["run", file, "--apply"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("pass --yes");
    expect(writes).toEqual([]);
  });

  test("-e runs inline code; the default export is the result", async () => {
    const { exitCode, stdout, stderr } = await run([
      "run",
      "-e",
      `export default (await atlcli.jira.get("ATLCLI-2")).fields.summary`,
      "--json",
    ]);
    expect(exitCode, stderr).toBe(0);
    const { plan } = JSON.parse(stdout);
    expect(plan.value).toBe("Old issue 2");
    expect(plan.script.name).toBe("inline");
  });

  test("typed params from meta; declared permissions are enforced", async () => {
    const file = await script(
      "strict.ts",
      `export const meta = { permissions: ["jira:read"], params: { n: { type: "number", default: 1 } } };
export default async ({ n }) => { await atlcli.jira.comment("ATLCLI-1", "n=" + (n + 1)); };`,
    );
    const denied = await run(["run", file, "--param", "n=41"]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain('Script failed (permission-denied): Script meta.permissions does not grant "jira:write:ATLCLI"');

    const typo = await run(["run", file, "--param", "m=1"]);
    expect(typo.stderr).toContain("Script failed (invalid-script): Unknown parameter: m");
  });

  test("updates that would not change a page are left out of the plan", async () => {
    // Page 900 stores <p>old</p>; "old" round-trips to the same body.
    const file = await script("noop.ts", `await atlcli.confluence.updatePage("900", { markdown: "old" });`);
    const { exitCode, stdout, stderr } = await run(["run", file, "--apply", "--yes"]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("No changes planned.");
    expect(stdout).toContain('Unchanged, not planned: 1\n       page 900 "Release Notes" (same content)');
    expect(writes).toEqual([]);
  });

  test("--timeout, --max-writes and --max-calls override the defaults", async () => {
    const loop = await run(["run", "-e", "for (;;) {}", "--timeout", "1s"]);
    expect(loop.exitCode).toBe(1);
    expect(loop.stderr).toContain("Script failed (interrupted)");

    const many = await script("many.ts", `for (const key of ["ATLCLI-1", "ATLCLI-2"]) await atlcli.jira.comment(key, "x");`);
    const writes = await run(["run", many, "--max-writes", "1"]);
    expect(writes.stderr).toContain("Script failed (write-limit)");

    const calls = await run(["run", "-e", `await atlcli.jira.get("ATLCLI-1"); await atlcli.jira.get("ATLCLI-2");`, "--max-calls", "1"]);
    expect(calls.stderr).toContain("Script failed (host-call-limit)");

    // 0 lifts a limit (no deadline must not mean "expire at once").
    const unlimited = await run(["run", many, "--max-writes", "0", "--max-calls", "0", "--timeout", "0"]);
    expect(unlimited.exitCode).toBe(0);
    expect(unlimited.stdout).toContain("Plan: 2 operations");

    for (const [flag, value] of [["--timeout", "soon"], ["--max-writes", "-3"], ["--memory", "0"]] as const) {
      const bad = await run(["run", "-e", "1", flag, value]);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain(flag);
    }
  });

  test("--var, --now and --strict reach atlcli.render; warnings show in the plan", async () => {
    const code = `export default async () => atlcli.render("{{a}} {{ today }} {{nope}}")`;
    const out = await run(["run", "-e", code, "--var", "a=1", "--now", "2026-10-25T08:00:00Z"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('Result: "1 2026-10-25 {{nope}}"');
    expect(out.stdout).toContain("Templates: rendered at 2026-10-25T08:00:00.000Z");
    expect(out.stdout).toContain("Template warnings (1):");

    const strict = await run(["run", "-e", code, "--strict"]);
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr).toContain("Script failed (template)");
  });

  test("guest errors are reported, not thrown", async () => {
    const file = await script("broken.ts", `await atlcli.jira.get("ATLCLI-404");`);
    const { exitCode, stderr } = await run(["run", file]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Script failed (guest)");
    expect(stderr).toContain("Jira API error (404)");
  });
});

describe("workflow verbs", () => {
  test("transition with fields and comment, watchers and notify reach Jira as expected", async () => {
    const file = await script(
      "wf.ts",
      `await atlcli.jira.transition("ATLCLI-1", "Done", { fields: { resolution: { name: "Fixed" } }, comment: "Closed **now**" });
await atlcli.jira.addWatcher("ATLCLI-1", "bob@example.com");
await atlcli.jira.addWatcher("ATLCLI-1", "ada@example.com");
await atlcli.jira.notify("ATLCLI-1", { subject: "Done", markdown: "It is *done*", to: { assignee: true, users: ["bob@example.com"] } });`,
    );
    const out = await run(["run", file, "--apply", "--yes"]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain("jira transition  ATLCLI-1 → Done with resolution, comment");
    expect(out.stdout).toContain("jira watch       ATLCLI-1 + bob@example.com");
    expect(out.stdout).toContain("Unchanged, not planned: 1");
    const transition = bodies.find(([kind]) => kind === "transition")![1] as any;
    expect(transition.transition).toEqual({ id: "31" });
    expect(transition.fields).toEqual({ resolution: { name: "Fixed" } });
    expect(transition.update.comment[0].add.body.type).toBe("doc");
    expect(watchers.get("ATLCLI-1")).toEqual(["acc-ada", "acc-bob"]);
    const notify = bodies.find(([kind]) => kind === "notify")![1] as any;
    expect(notify).toMatchObject({ subject: "Done", textBody: "It is *done*", to: { assignee: true, users: [{ accountId: "acc-bob" }] } });
    expect(notify.htmlBody).toContain("<em>done</em>");
  });

  test("a transition without a screen gets its comment added separately (Jira would drop it)", async () => {
    const file = await script("noscreen.ts", `await atlcli.jira.transition("ATLCLI-1", "Won't Do", { comment: "Not needed" });`);
    const out = await run(["run", file, "--apply", "--yes"]);
    expect(out.exitCode, out.stderr).toBe(0);
    const transition = bodies.find(([kind]) => kind === "transition")![1] as any;
    expect(transition).toEqual({ transition: { id: "41" } });
    expect(issues.get("ATLCLI-1")!.comments).toHaveLength(1);
  });
});

describe("script apply: journal and resume", () => {
  test("a failed apply resumes where it stopped and never repeats a write", async () => {
    const file = await script("two.ts", `await atlcli.jira.comment("ATLCLI-1", "a"); await atlcli.jira.comment("ATLCLI-2", "b");`);
    const planFile = join(home, "two.plan.json");
    expect((await run(["run", file, "--plan-out", planFile])).exitCode).toBe(0);

    rejectComments.add("ATLCLI-2");
    const failed = await run(["apply", planFile, "--yes"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("--resume");
    expect(issues.get("ATLCLI-1")!.comments).toHaveLength(1);

    const again = await run(["apply", planFile, "--yes"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("1 of 2 operations of this plan were already applied");

    rejectComments.clear();
    const resumed = await run(["apply", planFile, "--yes", "--resume"]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("Resuming: 1 of 2");
    expect(issues.get("ATLCLI-1")!.comments).toHaveLength(1);
    expect(issues.get("ATLCLI-2")!.comments).toHaveLength(1);

    const done = await run(["apply", planFile, "--yes", "--resume"]);
    expect(done.stdout).toContain("already applied");
    expect(issues.get("ATLCLI-2")!.comments).toHaveLength(1);
  });

  test("large plans are summarized, with counts per verb", async () => {
    const file = await script("many.ts", `for (let i = 0; i < 250; i++) await atlcli.jira.comment("ATLCLI-1", "n" + i);`);
    const out = await run(["run", file]);
    expect(out.stdout).toContain("Plan: 250 operations (250 jira.comment)");
    expect(out.stdout).toContain("… and 200 more");
  });

  test("the apply summary lists at most 20 created keys", async () => {
    const file = await script("create25.ts", `for (let i = 0; i < 25; i++) await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "n" + i });`);
    const out = await run(["run", file, "--apply", "--yes", "--concurrency", "4"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/Created: (ATLCLI-\d+, ){19}ATLCLI-\d+ and 5 more\./);
  });

  test("--concurrency is validated", async () => {
    const bad = await run(["run", "-e", "1", "--apply", "--yes", "--concurrency", "99"]);
    expect(bad.exitCode).toBe(0); // nothing to apply, so the flag is never read
    const file = await script("one.ts", `await atlcli.jira.comment("ATLCLI-1", "x");`);
    const rejected = await run(["run", file, "--apply", "--yes", "--concurrency", "99"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("--concurrency expects 1 to 32");
  });
});

describe("script init and check", () => {
  test("init writes types, tsconfig and an example; check validates them", async () => {
    const dir = join(home, "scripts");
    const init = await run(["init", dir]);
    expect(init.exitCode, init.stderr).toBe(0);
    for (const name of ["atlcli.d.ts", "tsconfig.json", "example.ts"]) expect(existsSync(join(dir, name))).toBe(true);

    const again = await run(["init", dir]);
    expect(again.stdout).toContain("Kept existing tsconfig.json, example.ts");

    const ok = await run(["check", join(dir, "example.ts"), "--json"]);
    expect(ok.exitCode, ok.stdout + ok.stderr).toBe(0);
    const okResult = JSON.parse(ok.stdout);
    expect(["ok", "skipped"]).toContain(okResult.typecheck.status);

    await writeFile(join(dir, "bad.ts"), `const n: number = atlcli.params.missing.toUpperCase();`);
    const bad = await run(["check", join(dir, "bad.ts"), "--json"]);
    if (okResult.typecheck.status === "ok") {
      expect(bad.exitCode).toBe(1);
      expect(JSON.parse(bad.stdout).typecheck.status).toBe("errors");
    }
  });

  test("init --each writes a per-issue skeleton; --example and --list-examples", async () => {
    const dir = join(home, "each-scripts");
    const each = await run(["init", dir, "--each", "project = ATLCLI AND updated < -30d"]);
    expect(each.exitCode, each.stderr).toBe(0);
    expect(each.stdout).toContain("Next: atlcli script run");
    const skeleton = await readFile(join(dir, "each.ts"), "utf8");
    expect(skeleton).toContain(`jql: "project = ATLCLI AND updated < -30d"`);
    expect(skeleton).toContain("export default async (issue: JiraIssue)");

    const list = await run(["init", "--list-examples"]);
    expect(list.stdout).toContain("stale-comment");
    expect(list.stdout).toContain("epic-status-page   run");

    const example = await run(["init", dir, "--example", "close-inactive"]);
    expect(example.exitCode).toBe(0);
    expect(await readFile(join(dir, "close-inactive.ts"), "utf8")).toContain("setStatus");

    const unknown = await run(["init", dir, "--example", "nope"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Available: stale-comment");
  });

  test("check rejects invalid meta without running the script", async () => {
    const file = await script("meta.ts", `export const meta = { permissions: ["jira:everything"] }; await atlcli.jira.comment("ATLCLI-1", "x");`);
    const { exitCode, stderr } = await run(["check", file]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid meta.permissions.0");
    expect(writes).toEqual([]);
  });
});

describe("imports, files, state, http and REST writes", () => {
  test("relative imports load; the plan digest covers them; packages and escapes are refused", async () => {
    await mkdir(join(home, "lib"), { recursive: true });
    await writeFile(join(home, "lib", "format.ts"), `export const line = (key: string): string => "Closing " + key;\n`, "utf8");
    const file = await script("imports.ts", `import { line } from "./lib/format.ts";\nexport default line("ATLCLI-1");\n`);
    const first = await run(["run", file, "--json"]);
    expect(first.exitCode).toBe(0);
    const plan = JSON.parse(first.stdout).plan;
    expect(plan.value).toBe("Closing ATLCLI-1");
    await writeFile(join(home, "lib", "format.ts"), `export const line = (key: string): string => "Done " + key;\n`, "utf8");
    const second = JSON.parse((await run(["run", file, "--json"])).stdout).plan;
    expect(second.script.sha256).not.toBe(plan.script.sha256);

    for (const [name, source, message] of [
      ["pkg.ts", `import x from "lodash"; export default x;`, "except relative files"],
      ["up.ts", `import x from "../x.ts"; export default x;`, "leaves the script's directory"],
      ["missing.ts", `import x from "./nope.ts"; export default x;`, "cannot find ./nope.ts"],
    ]) {
      const result = await run(["run", await script(name!, source!)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message!);
    }
    const check = await run(["check", await script("pkg2.ts", `import x from "node:fs"; export default x;`)]);
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain("except relative files");
  });

  test("files, state and HTTP are planned, applied from the plan file, and secrets never reach it", async () => {
    await writeFile(join(home, "input.csv"), "key\nATLCLI-1\n", "utf8");
    const origin = server.url.origin.replace("127.0.0.1", "localhost");
    const file = await script(
      "nightly.ts",
      `export const meta = { name: "nightly", permissions: ["file:read", "file:write", "http:localhost:${server.port}"], secrets: ["HOOK"] };
const keys = (await atlcli.files.read("input.csv")).trim().split("\\n").slice(1);
const feed = await atlcli.http.get("${origin}/feed", { headers: { authorization: "Bearer " + atlcli.secret("HOOK") } });
const last = await atlcli.state.get("last");
await atlcli.files.write("out/report.md", "# " + keys.join(", ") + " " + feed.json.items.length);
await atlcli.state.set("last", keys.at(-1));
await atlcli.http.request("POST", "${origin}/hook", { headers: { authorization: "Bearer " + atlcli.secret("HOOK") }, json: { keys } });
export default { last, auth: feed.json.auth };`,
    );
    const env = { ATLCLI_SECRET_HOOK: "hook-secret-1" };
    const planned = await run(["run", file, "--plan-out", "plan.json"], env);
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain("file write       out/report.md");
    expect(planned.stdout).toContain("state set        nightly/last");
    expect(planned.stdout).toContain(`http             POST ${origin}/hook`);
    // The GET went out while planning, with the secret; what the script saw is redacted.
    expect(planned.stdout).toContain('"auth":"Bearer {secret:HOOK}"');
    const planText = await readFile(join(home, "plan.json"), "utf8");
    expect(planText).not.toContain("hook-secret-1");
    expect(bodies.filter((b) => b[0] === "hook")).toEqual([]);
    expect(existsSync(join(home, "out", "report.md"))).toBe(false);

    const applied = await run(["apply", "plan.json", "--yes"], env);
    expect(applied.exitCode).toBe(0);
    expect(await readFile(join(home, "out", "report.md"), "utf8")).toBe("# ATLCLI-1 2");
    expect(JSON.parse(await readFile(join(home, ".atlcli", "state", "nightly.json"), "utf8"))).toEqual({ last: "ATLCLI-1" });
    expect(bodies.filter((b) => b[0] === "hook")).toEqual([["hook", { method: "POST", auth: "Bearer hook-secret-1", body: { keys: ["ATLCLI-1"] } }]]);

    const missing = await run(["run", file]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("ATLCLI_SECRET_HOOK");
  });

  test("jira.request writes through the REST escape hatch on apply", async () => {
    const file = await script("version.ts", `const v = await atlcli.jira.request("POST", "/rest/api/3/version", { body: { name: "2.0", projectId: 1 } });\nawait atlcli.jira.comment("ATLCLI-1", "Released " + v.id);`);
    const result = await run(["run", file, "--apply", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(bodies.filter((b) => b[0] === "version")).toEqual([["version", { name: "2.0", projectId: 1 }]]);
    expect(issues.get("ATLCLI-1")!.comments.join()).toContain("Released 10500");
  });
});

describe("output files", () => {
  test("a dry run writes reports while planning nothing; a template streams into the file", async () => {
    const file = await script(
      "report.ts",
      `export const meta = { permissions: ["jira:read", "file:output"] };
const csv = await atlcli.output("reports/issues.csv");
await csv.row(["Key", "Summary"]);
const keys = [];
for await (const issue of atlcli.jira.search("project = ATLCLI")) {
  keys.push(issue.key);
  await csv.row([issue.key, issue.fields.summary]);
}
await csv.close();
const md = await atlcli.output("reports/issues.md");
await md.render("# {{ title }} ({{ team }})\\n{% for k in keys %}\\n- {{ k }}\\n{% endfor %}\\n", { title: "Issues", keys });
export default await md.close();`,
    );
    const result = await run(["run", file, "--out-dir", "out", "--var", "team=core", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.plan.operations).toEqual([]);
    expect(json.outputs.map((o: { path: string }) => o.path)).toEqual(["reports/issues.csv", "reports/issues.md"]);
    const csv = await readFile(join(home, "out", "reports", "issues.csv"), "utf8");
    expect(csv.split("\r\n")[0]).toBe("Key,Summary");
    expect(csv).toContain("ATLCLI-1,");
    expect(await readFile(join(home, "out", "reports", "issues.md"), "utf8")).toBe("# Issues (core)\n- ATLCLI-1\n- ATLCLI-2\n");
    expect(writes).toEqual([]);

    const text = await run(["run", file, "--out-dir", "out"]);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stderr).toContain("Wrote reports/issues.csv (");
  });

  test("an output left open or a failing script leaves no file; the size limit holds", async () => {
    await writeFile(join(home, "kept.txt"), "old", "utf8");
    const open = await run(["run", await script("open.ts", `const o = await atlcli.output("kept.txt"); await o.line("new");`)]);
    expect(open.exitCode).toBe(1);
    expect(open.stderr).toContain("kept.txt was not closed");
    const thrown = await run(["run", await script("throws.ts", `const o = await atlcli.output("kept.txt"); await o.line("new"); throw new Error("boom");`)]);
    expect(thrown.exitCode).toBe(1);
    const big = await run(["run", await script("big.ts", `const o = await atlcli.output("big.txt"); for (let i = 0; i < 40; i++) await o.write("x".repeat(70000)); await o.close();`), "--max-output", "1m"]);
    expect(big.exitCode).toBe(1);
    expect(big.stderr).toContain("exceed 1 MB");
    expect(await readFile(join(home, "kept.txt"), "utf8")).toBe("old");
    expect((await readdir(home)).filter((f) => f.includes("atlcli-tmp") || f === "big.txt")).toEqual([]);
  });

  test("per issue: every issue writes its own file", async () => {
    const file = await script(
      "per-issue.ts",
      `export default async (issue) => {
  const o = await atlcli.output("issues/" + issue.key + ".md");
  await o.render("# {{ key }}", { key: issue.key });
  await o.close();
};`,
    );
    const result = await run(["run", file, "--each", "project = ATLCLI"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readdir(join(home, "issues"))).sort()).toEqual(["ATLCLI-1.md", "ATLCLI-2.md"]);
    expect(await readFile(join(home, "issues", "ATLCLI-2.md"), "utf8")).toBe("# ATLCLI-2");
  });
});

describe("script test", () => {
  test("output files are kept in memory, recorded as expected and compared", async () => {
    const file = await script(
      "export.ts",
      `const out = await atlcli.output("keys.md");
for await (const issue of atlcli.jira.search("project = ATLCLI")) await out.line("- " + issue.key);
await out.render("{{ n }} issues", { n: 2 });
await out.close();`,
    );
    const recorded = await run(["test", file, "--record", "export"]);
    expect(recorded.exitCode).toBe(0);
    expect(existsSync(join(home, "keys.md"))).toBe(false);
    const testFile = JSON.parse(await readFile(join(home, "export.test.json"), "utf8"));
    expect(testFile.cases[0].expect.outputs).toEqual({ "keys.md": "- ATLCLI-1\n- ATLCLI-2\n2 issues" });
    expect((await run(["test", file])).exitCode).toBe(0);
    await writeFile(file, (await readFile(file, "utf8")).replace('"- "', '"* "'), "utf8");
    const failed = await run(["test", file]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("Output keys.md differs");
    expect(existsSync(join(home, "keys.md"))).toBe(false);
    // Later tests run every case in the directory.
    await rm(file);
    await rm(join(home, "export.test.json"));
  });

  test("records a case against the site, replays it offline, shows a diff, updates and runs test(plan)", async () => {
    const file = await script(
      "triage.ts",
      `for await (const issue of atlcli.jira.search("project = ATLCLI")) await atlcli.jira.addLabels(issue.key, ["triaged"]);
export default "done";
export function test(plan) {
  if (plan.operations.some((op) => op.verb !== "jira.addLabels")) throw new Error("only labels expected");
}
`,
    );
    const recorded = await run(["test", file, "--record", "two issues"]);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout).toContain('Recorded case "two issues"');
    expect(writes).toEqual([]);
    const testFile = JSON.parse(await readFile(join(home, "triage.test.json"), "utf8"));
    expect(testFile.cases[0].expect.operations.map((o: { args: { key: string } }) => o.args.key)).toEqual(["ATLCLI-1", "ATLCLI-2"]);

    // Offline: the site's data changes, the replay does not.
    issues.clear();
    const passed = await run(["test", file]);
    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toContain("✓ two issues");

    await writeFile(file, (await readFile(file, "utf8")).replace(`["triaged"]`, `["triaged", "v2"]`), "utf8");
    const failed = await run(["test", file]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("✗ two issues");
    expect(failed.stdout).toContain("- #1 jira labels      ATLCLI-1 + triaged");
    expect(failed.stdout).toContain("+ #1 jira labels      ATLCLI-1 + triaged, v2");

    expect((await run(["test", file, "--update"])).exitCode).toBe(0);
    expect((await run(["test", home, "--json"])).exitCode).toBe(0);

    await writeFile(file, (await readFile(file, "utf8")).replace(`addLabels(issue.key, ["triaged", "v2"])`, `comment(issue.key, "hi")`), "utf8");
    const custom = await run(["test", file, "--update", "--json"]);
    expect(custom.exitCode).toBe(1);
    const result = JSON.parse(custom.stdout).results[0];
    expect(result.problems).toEqual(["test(plan) failed: Error: only labels expected"]);
  });

  test("a script without a test file says how to record one", async () => {
    const file = await script("untested.ts", `export default 1;`);
    const result = await run(["test", file]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--record <name>");
  });
});
