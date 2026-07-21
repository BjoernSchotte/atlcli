/**
 * Regression: repeated `docs pull` renamed a tracked page's local file and
 * eventually duplicated it on disk.
 *
 * The write loop reuses `existingState.path` for a page that has not moved, but
 * the sync.db upsert at the end of `handlePull` stored `computed.relativePath`
 * from `buildPathMap()`. `buildPathMap()` seeds its `usedPaths` set from the
 * paths already recorded in state, without knowing that `<slug>.md` belongs to
 * the very page being placed, so it handed out `<slug>-2.md`. sync.db (which
 * `readState()` prefers over state.json) then claimed the page lived at
 * `<slug>-2.md`, and the next pull wrote a second markdown file plus a second
 * `.attachments/` directory there - forever alternating between the two names.
 *
 * Everything runs through the real CLI against a real Bun HTTP server standing
 * in for the Confluence REST API - no fetch mocking, no Atlassian traffic, and
 * a sandboxed HOME so the developer's own ~/.atlcli/config.json is never read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncDb, getAtlcliPath, readState } from "@atlcli/confluence/internal";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "78001";
const PAGE_TITLE = "Path Stability Fixture";
const SLUG = "path-stability-fixture";
const ATTACHMENT_ID = "att78001";
const ATTACHMENT_NAME = "diagram.png";
const DOWNLOAD_PATH = `/download/attachments/${PAGE_ID}/${ATTACHMENT_NAME}`;

const ATTACHMENT_BYTES = new Uint8Array(Buffer.from("PNG stub payload ".repeat(16)));

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: PAGE_TITLE,
  space: { key: "DOCSY" },
  version: { number: 3, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-19T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Stable body.</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

const ATTACHMENTS = {
  results: [
    {
      id: ATTACHMENT_ID,
      type: "attachment",
      title: ATTACHMENT_NAME,
      version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
      extensions: { mediaType: "image/png", fileSize: ATTACHMENT_BYTES.byteLength },
      metadata: { mediaType: "image/png" },
      _links: { download: DOWNLOAD_PATH },
    },
  ],
  size: 1,
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;

/** Any non-GET request would mean the test wrote to "Confluence". */
let writes: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "GET") writes.push(`${req.method} ${pathname}`);

      // Data-center shape (bearer auth => no /wiki prefix).
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) return Response.json(ATTACHMENTS);
      if (pathname === DOWNLOAD_PATH) {
        return new Response(ATTACHMENT_BYTES, { headers: { "content-type": "image/png" } });
      }

      // Folder discovery (v2 API) is best-effort in pull and tolerates 404s.
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-path-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: {
          name: "stub",
          baseUrl: server.url.origin,
          deploymentType: "data-center",
          auth: { type: "bearer" },
          space: "DOCSY",
        },
      },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
  if (tree) await rm(tree, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: tree,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ATLCLI_API_TOKEN: "stub-token",
      ATLCLI_DISABLE_UPDATE_CHECK: "1",
    },
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

/** Every markdown file in the tree, excluding the .atlcli metadata directory. */
async function markdownFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md")) found.push(rel);
    }
  };
  await walk(tree);
  return found.sort();
}

/** Every `*.attachments` directory in the tree. */
async function attachmentDirs(): Promise<string[]> {
  const entries = await readdir(tree, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".attachments"))
    .map((e) => e.name)
    .sort();
}

async function pull(): Promise<void> {
  const result = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
}

describe("docs pull: a tracked page keeps its filename across repeated pulls", () => {
  beforeEach(async () => {
    if (tree) await rm(tree, { recursive: true, force: true });
    tree = await mkdtemp(join(tmpdir(), "atlcli-path-tree-"));
    writes = [];

    const init = await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"]);
    expect(init.exitCode, init.stderr).toBe(0);
  });

  it("writes exactly one markdown file after three pulls", async () => {
    await pull();
    expect(await markdownFiles()).toEqual([`${SLUG}.md`]);

    await pull();
    expect(await markdownFiles()).toEqual([`${SLUG}.md`]);

    // The third pull is where the mis-recorded sync.db path used to surface as
    // a real second file on disk.
    await pull();
    expect(await markdownFiles()).toEqual([`${SLUG}.md`]);

    expect(writes).toEqual([]);
  }, 90_000);

  it("does not spawn a second attachments directory", async () => {
    await pull();
    await pull();
    await pull();

    expect(await attachmentDirs()).toEqual([`${SLUG}.attachments`]);
  }, 90_000);

  it("records the path it actually wrote in sync.db", async () => {
    await pull();
    expect((await readState(tree)).pages[PAGE_ID].path).toBe(`${SLUG}.md`);

    // After pull #2 the tree still looks right on disk; the damage was purely
    // in sync.db, which readState() prefers over state.json. That stale path is
    // what pull #3 then treats as the page's home.
    await pull();
    expect((await readState(tree)).pages[PAGE_ID].path).toBe(`${SLUG}.md`);

    const status = await runCli(["wiki", "docs", "status", "--json"]);
    expect(status.exitCode, status.stderr).toBe(0);

    const parsed = JSON.parse(status.stdout);
    expect(parsed.stats.synced).toBe(1);
    expect(parsed.stats.untracked).toBe(0);
    expect(parsed.stats.localModified).toBe(0);
  }, 90_000);

  it("recovers a tree whose sync.db already points at the alias", async () => {
    await pull();

    // Reproduce what a pre-fix pull left behind: the record names a file that
    // was never written. Upgrading must not make the next pull create it.
    const adapter = await createSyncDb(getAtlcliPath(tree), { autoMigrate: false });
    const record = await adapter.getPage(PAGE_ID);
    await adapter.upsertPage({ ...record!, path: `${SLUG}-2.md` });
    await adapter.close();

    await pull();

    expect(await markdownFiles()).toEqual([`${SLUG}.md`]);
    expect((await readState(tree)).pages[PAGE_ID].path).toBe(`${SLUG}.md`);
  }, 90_000);
});
