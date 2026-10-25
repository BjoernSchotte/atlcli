/**
 * `atlcli script` through the real CLI against a local Bun server that speaks
 * enough Jira Cloud (v3) and Confluence (v1 REST) for the script verbs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const tick = () => `2026-10-24T10:00:${String(clock++).padStart(2, "0")}.000+0000`;

function reset(): void {
  writes = [];
  rejectComments = new Set();
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
        if (req.method === "GET") return Response.json({ transitions: [{ id: "31", name: "Done" }, { id: "41", name: "Won't Do" }] });
        issue.fields.status = { name: body.transition.id === "31" ? "Done" : "Won't Do" };
        issue.fields.updated = tick();
        return new Response(null, { status: 204 });
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

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "script", ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
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
    const code = `export default async () => atlcli.render("{{a}} {{@today}} {{nope}}")`;
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
