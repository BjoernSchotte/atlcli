/**
 * `atlcli script` through the real CLI against a local Bun server that speaks
 * enough Jira Cloud (v3) and Confluence (v1 REST) for the script verbs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

type Issue = { id: string; key: string; fields: { summary: string; updated: string; status: { name: string } }; comments: string[] };
type Page = { id: string; title: string; space: string; version: number; storage: string; labels: string[]; parentId?: string };

let server: ReturnType<typeof Bun.serve>;
let home: string;
let writes: string[] = [];
let issues = new Map<string, Issue>();
let pages = new Map<string, Page>();
let clock = 0;
let nextId = 100;

const tick = () => `2026-10-24T10:00:${String(clock++).padStart(2, "0")}.000+0000`;

function reset(): void {
  writes = [];
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
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(path))) {
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
        if (req.method === "PUT") {
          if (body.version.number !== page.version + 1) return Response.json({ message: "Version conflict" }, { status: 409 });
          Object.assign(page, { title: body.title, storage: body.body.storage.value, version: body.version.number });
          return Response.json(pageJson(page));
        }
        return Response.json(pageJson(page));
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

    for (const [flag, value] of [["--timeout", "soon"], ["--max-writes", "0"], ["--memory", "-1"]] as const) {
      const bad = await run(["run", "-e", "1", flag, value]);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain(flag);
    }
  });

  test("guest errors are reported, not thrown", async () => {
    const file = await script("broken.ts", `await atlcli.jira.get("ATLCLI-404");`);
    const { exitCode, stderr } = await run(["run", file]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Script failed (guest)");
    expect(stderr).toContain("Jira API error (404)");
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

  test("check rejects invalid meta without running the script", async () => {
    const file = await script("meta.ts", `export const meta = { permissions: ["jira:everything"] }; await atlcli.jira.comment("ATLCLI-1", "x");`);
    const { exitCode, stderr } = await run(["check", file]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid meta.permissions.0");
    expect(writes).toEqual([]);
  });
});
