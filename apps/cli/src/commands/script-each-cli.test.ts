/**
 * `atlcli script run --each` jobs through the real CLI against a local Bun
 * server with enough Jira Cloud for per-issue runs: paged search, `id in (…)`
 * batches, comments and labels.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
setDefaultTimeout(120_000);

type Issue = { id: string; key: string; fields: { summary: string; updated: string; status: { name: string }; labels: string[] }; comments: string[] };

let server: ReturnType<typeof Bun.serve>;
let home: string;
let issues = new Map<string, Issue>();
let rejectComments = new Set<string>();
let searches: string[] = [];
let clock = 0;
const tick = () => `2026-10-25T10:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock++ % 60).padStart(2, "0")}.000+0000`;

function reset(count = 250): void {
  clock = 0;
  searches = [];
  rejectComments = new Set();
  issues = new Map();
  for (let n = 1; n <= count; n++) {
    const key = `ATLCLI-${n}`;
    issues.set(String(n), { id: String(n), key, fields: { summary: `Issue ${n}`, updated: tick(), status: { name: n % 5 === 0 ? "Done" : "Open" }, labels: [] }, comments: [] });
  }
}

const view = ({ comments: _, ...issue }: Issue) => issue;
const byKeyOrId = (ref: string) => issues.get(ref) ?? [...issues.values()].find((i) => i.key === ref);

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      let m: RegExpExecArray | null;
      if (path === "/rest/api/3/search/jql" && req.method === "POST") {
        searches.push(body.jql);
        const ids = /^id in \(([^)]*)\)$/.exec(body.jql);
        const all = ids ? ids[1]!.split(",").map((id) => issues.get(id.trim())).filter((i): i is Issue => Boolean(i)) : [...issues.values()];
        const start = Number(body.nextPageToken ?? 0);
        const end = start + Math.min(body.maxResults ?? 50, 100);
        return Response.json({ issues: all.slice(start, end).map(view), ...(end < all.length ? { nextPageToken: String(end) } : {}) });
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/.exec(path))) {
        const issue = byKeyOrId(m[1]!);
        if (!issue) return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
        if (req.method === "PUT") {
          for (const change of body.update?.labels ?? []) {
            const labels = issue.fields.labels.filter((l) => l !== change.remove);
            issue.fields.labels = change.add ? [...labels, change.add] : labels;
          }
          issue.fields.updated = tick();
          return new Response(null, { status: 204 });
        }
        return Response.json(view(issue));
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(path))) {
        if (rejectComments.has(m[1]!)) return Response.json({ errorMessages: ["Comments are locked"] }, { status: 400 });
        const issue = byKeyOrId(m[1]!)!;
        issue.comments.push(JSON.stringify(body.body));
        return Response.json({ id: String(9000 + issue.comments.length) }, { status: 201 });
      }
      return Response.json({ message: `stub: no route for ${req.method} ${path}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-script-each-"));
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

beforeEach(async () => {
  reset();
  await rm(join(home, ".atlcli", "jobs"), { recursive: true, force: true });
});

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

const jobIds = async () => (existsSync(join(home, ".atlcli", "jobs")) ? await readdir(join(home, ".atlcli", "jobs")) : []);
const comments = () => [...issues.values()].reduce((n, i) => n + i.comments.length, 0);

const STALE = `export default async (issue) => {
  if (issue.fields.status.name !== "Done") await atlcli.jira.comment(issue.key, "Still needed?");
};`;

describe("script run --each", () => {
  test("plans every issue without writing, then applies the reviewed job", async () => {
    const file = await script("stale.ts", STALE);
    const planned = await run(["run", file, "--each", "project = ATLCLI"]);
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain("Issues: 250 · 200 planned, 50 unchanged");
    expect(planned.stdout).toContain("Planned operations this run: 200 (200 jira.comment)");
    expect(planned.stdout).toContain("Nothing was changed");
    expect(comments()).toBe(0);
    // Batches by id: one snapshot page per 100 plus one fetch per 100.
    expect(searches.filter((q) => q.startsWith("id in")).length).toBe(3);

    const [id] = await jobIds();
    const listed = await run(["jobs"]);
    expect(listed.stdout).toContain(`${id}  plan/planned  250/250  stale`);

    const applied = await run(["apply", id!, "--yes", "--concurrency", "8"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("200 applied");
    expect(applied.stdout).toContain("Done.");
    expect(comments()).toBe(200);

    const again = await run(["apply", id!, "--yes"]);
    expect(again.stdout).toContain("Nothing left to apply.");
    expect(comments()).toBe(200);
  });

  test("issues edited after planning are left alone and reported as drift, not as resumable", async () => {
    const file = await script("label.ts", `export default async (issue) => atlcli.jira.addLabels(issue.key, ["x"]);`);
    await run(["run", file, "--each", "project = ATLCLI", "--max-items", "250"]);
    const [id] = await jobIds();
    issues.get("7")!.fields.updated = tick(); // someone edits ATLCLI-7 before the apply
    const out = await run(["apply", id!, "--yes"]);
    expect(out.stdout).toContain("249 applied, 1 drift");
    expect(out.stdout).toContain("1 issue changed after planning and was left alone");
    expect(out.stdout).not.toContain("resuming retries");
    expect(issues.get("7")!.fields.labels).toEqual([]);
  });

  test("refuses to apply a job whose plans were edited", async () => {
    const file = await script("stale.ts", STALE);
    await run(["run", file, "--each", "project = ATLCLI"]);
    const [id] = await jobIds();
    const plans = join(home, ".atlcli", "jobs", id!, "plans.jsonl");
    await writeFile(plans, (await readFile(plans, "utf8")).replace("Still needed?", "Delete me"), "utf8");
    const out = await run(["apply", id!, "--yes"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("were modified after planning");
    expect(comments()).toBe(0);
  });

  test("stream mode stops at the failure limit and resumes without repeating writes", async () => {
    const file = await script("stale.ts", STALE);
    for (const n of [3, 4, 6, 7]) rejectComments.add(`ATLCLI-${n}`);
    const first = await run(["run", file, "--each", "project = ATLCLI", "--apply", "--yes", "--max-failures", "3", "--concurrency", "1"]);
    expect(first.exitCode).toBe(1);
    expect(first.stdout).toContain("Stopped: 3 failures");
    expect(first.stdout).toContain("script resume");
    const [id] = await jobIds();
    const before = comments();
    expect(before).toBeLessThan(200);

    rejectComments.clear();
    const resumed = await run(["resume", id!, "--yes"]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("Done.");
    // Every open issue has exactly one comment: the failed ones were retried, none was repeated.
    for (const issue of issues.values()) expect(issue.comments.length).toBe(issue.fields.status.name === "Done" ? 0 : 1);
  });

  test("meta.each makes a plain run per-issue; params reach the function", async () => {
    const file = await script(
      "label.ts",
      `export const meta = { each: { jql: "project = ATLCLI", fields: ["labels"] }, params: { label: { type: "string" } } };
export default async (issue, { label }) => {
  if (!issue.fields.labels.includes(label)) await atlcli.jira.addLabels(issue.key, [label]);
};`,
    );
    const out = await run(["run", file, "--param", "label=triaged", "--apply", "--yes", "--max-items", "10"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("10 applied");
    expect([...issues.values()].filter((i) => i.fields.labels.includes("triaged")).length).toBe(10);
    expect(out.stdout).toContain("240 issues not done");
  });

  test("script errors are recorded per issue; resume --script retries them with a fixed script", async () => {
    const broken = await script("broken.ts", `export default async (issue) => { if (issue.key === "ATLCLI-2") throw new Error("boom"); };`);
    const out = await run(["run", broken, "--each", "project = ATLCLI"]);
    expect(out.stderr).toContain("ATLCLI-2: guest: Error: boom");
    expect(out.stdout).toContain("1 issue not done");
    const [id] = await jobIds();
    const fixed = await script("fixed.ts", `export default async () => {};`);
    const resumed = await run(["resume", id!, "--script", fixed]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("Nothing was changed. Review the plans");
  });

  test("a script without a function export is rejected in per-issue mode", async () => {
    const out = await run(["run", "-e", `await atlcli.jira.comment("ATLCLI-1", "x")`, "--each", "project = ATLCLI"]);
    expect(out.stderr).toContain("export default async (issue)");
    expect(out.stdout).toContain("Stopped: the script is invalid");
    expect(out.stderr.match(/✗/g)?.length).toBeLessThanOrEqual(4); // stopped after the first batch in flight
  });
});
