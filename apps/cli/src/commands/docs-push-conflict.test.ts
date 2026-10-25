/**
 * Regression #285: `docs push` overwrote a page that was edited in Confluence
 * after the last pull. Real CLI against a Bun HTTP server standing in for
 * Confluence (data-center shape); sandboxed HOME.
 */
import { afterAll, beforeAll, beforeEach, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "80001";
const SLUG = "conflict-fixture";

let version = 2;
let storage = "<p>Original body.</p>";
let puts: number[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;

function page() {
  return {
    id: PAGE_ID,
    type: "page",
    title: "Conflict Fixture",
    space: { key: "DOCSY" },
    version: { number: version, when: "2026-10-20T00:00:00.000Z" },
    ancestors: [],
    history: {
      createdDate: "2026-10-19T00:00:00.000Z",
      createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
      lastUpdated: { when: "2026-10-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
    },
    metadata: { labels: { results: [] }, properties: {} },
    body: { storage: { value: storage, representation: "storage" } },
    _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
  };
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/rest/api/content/${PAGE_ID}`) {
        if (req.method === "PUT") {
          const body = (await req.json()) as { version: { number: number }; body: { storage: { value: string } } };
          puts.push(body.version.number);
          version = body.version.number;
          storage = body.body.storage.value;
        }
        return Response.json(page());
      }
      if (url.pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) return Response.json({ results: [], size: 0 });
      return Response.json({ message: `stub: no route for ${url.pathname}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-conflict-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: { stub: { name: "stub", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" }, space: "DOCSY" } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  await rm(home, { recursive: true, force: true });
  if (tree) await rm(tree, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: tree,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const file = () => join(tree, `${SLUG}.md`);

/** Someone edits the page in Confluence after our pull. */
function remoteEdit(): void {
  version += 1;
  storage = "<p>Colleague edit.</p>";
}

beforeEach(async () => {
  version = 2;
  storage = "<p>Original body.</p>";
  if (tree) await rm(tree, { recursive: true, force: true });
  tree = await mkdtemp(join(tmpdir(), "atlcli-conflict-tree-"));
  expect((await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"])).exitCode).toBe(0);
  const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
  expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);
  puts = [];
});

it("refuses to push a locally edited file over a remote edit", async () => {
  remoteEdit();
  await writeFile(file(), (await readFile(file(), "utf8")).replace("Original body.", "My edit."));
  const push = await runCli(["wiki", "docs", "push", "--json"]);
  expect(push.exitCode).toBe(1);
  const error = JSON.parse(push.stdout).error;
  expect(error.details.conflicts).toEqual([{ file: expect.stringContaining(`${SLUG}.md`), pageId: PAGE_ID, baseVersion: 2, remoteVersion: 3 }]);
  expect(puts).toEqual([]);
  expect(storage).toBe("<p>Colleague edit.</p>");
}, 90_000);

it("skips an unchanged file when the page changed remotely", async () => {
  remoteEdit();
  const push = await runCli(["wiki", "docs", "push", "--json"]);
  expect(push.exitCode, push.stdout).toBe(0);
  expect(puts).toEqual([]);
}, 90_000);

it("--force overwrites the remote edit on purpose", async () => {
  remoteEdit();
  await writeFile(file(), (await readFile(file(), "utf8")).replace("Original body.", "My edit."));
  const push = await runCli(["wiki", "docs", "push", "--force", "--json"]);
  expect(push.exitCode, push.stdout).toBe(0);
  expect(puts).toEqual([4]);
}, 90_000);

it("pushes a local edit when the page did not change remotely, and again after that", async () => {
  await writeFile(file(), (await readFile(file(), "utf8")).replace("Original body.", "My edit."));
  expect((await runCli(["wiki", "docs", "push", "--json"])).exitCode).toBe(0);
  await writeFile(file(), (await readFile(file(), "utf8")).replace("My edit.", "My second edit."));
  expect((await runCli(["wiki", "docs", "push", "--json"])).exitCode).toBe(0);
  expect(puts).toEqual([3, 4]);
}, 90_000);

/** The file as `docs sync` leaves it after a failed merge: frontmatter, then markers. */
async function writeConflict(): Promise<void> {
  const frontmatter = (await readFile(file(), "utf8")).split("\n---\n")[0] + "\n---\n\n";
  await writeFile(file(), `${frontmatter}<<<<<<< LOCAL\nMy edit.\n=======\nColleague edit.\n>>>>>>> REMOTE\n`);
}

it("resolve finds the page through the workspace state, and the resolution pushes (#275)", async () => {
  remoteEdit();
  await writeConflict();
  const resolve = await runCli(["wiki", "docs", "resolve", file(), "--accept", "local", "--json"]);
  expect(resolve.exitCode, resolve.stdout + resolve.stderr).toBe(0);
  expect(JSON.parse(resolve.stdout)).toMatchObject({ resolved: true, accept: "local", baseAdvanced: true });
  expect(await readFile(file(), "utf8")).toContain("My edit.");
  const push = await runCli(["wiki", "docs", "push", "--json"]);
  expect(push.exitCode, push.stdout).toBe(0);
  expect(puts).toEqual([4]);
  expect(storage).toContain("My edit.");
}, 90_000);

it("a remote edit after the conflict keeps the old base, so push still refuses (#275, #285)", async () => {
  remoteEdit();
  await writeConflict();
  version += 1;
  storage = "<p>Another colleague edit.</p>";
  const resolve = await runCli(["wiki", "docs", "resolve", file(), "--accept", "local", "--json"]);
  expect(JSON.parse(resolve.stdout)).toMatchObject({ resolved: true, baseAdvanced: false });
  const push = await runCli(["wiki", "docs", "push", "--json"]);
  expect(push.exitCode).toBe(1);
  expect(puts).toEqual([]);
}, 90_000);

it("--accept merged closes a conflict whose markers were removed by hand (#275)", async () => {
  remoteEdit();
  await writeConflict();
  // A sync run would mark the page as conflicted; emulate its state entry.
  const { createSyncDb, getAtlcliPath } = await import("@atlcli/confluence/internal");
  const db = await createSyncDb(getAtlcliPath(tree), { autoMigrate: false });
  const page = await db.getPage(PAGE_ID);
  await db.upsertPage({ ...page!, syncState: "conflict" });
  await db.close();
  const text = await readFile(file(), "utf8");
  await writeFile(file(), text.replace(/<<<<<<< LOCAL\n|=======\n|>>>>>>> REMOTE\n/g, ""));
  const resolve = await runCli(["wiki", "docs", "resolve", file(), "--accept", "merged", "--json"]);
  expect(resolve.exitCode, resolve.stdout + resolve.stderr).toBe(0);
  expect(JSON.parse(resolve.stdout)).toMatchObject({ resolved: true, accept: "merged" });
}, 90_000);

it("docs sync does not overwrite a local edit when it starts (initial sync)", async () => {
  remoteEdit();
  await writeFile(file(), (await readFile(file(), "utf8")).replace("Original body.", "My edit."));
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "wiki", "docs", "sync", ".", "--poll-interval", "60000"], {
    cwd: tree,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 30_000;
  while (!out.includes("Initial sync complete") && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(1000).then(() => undefined)]);
    if (chunk?.value) out += new TextDecoder().decode(chunk.value);
  }
  proc.kill();
  await proc.exited;
  expect(out, out).toContain("Initial sync complete");
  // Merged or marked as a conflict, but the local edit survives, and so does the frontmatter
  // that ties the file to its page.
  const after = await readFile(file(), "utf8");
  expect(after).toContain("My edit.");
  expect(after).toMatch(/^---\n[\s\S]*id: "?80001"?[\s\S]*\n---\n/);
  expect(puts).toEqual([]);
}, 90_000);
