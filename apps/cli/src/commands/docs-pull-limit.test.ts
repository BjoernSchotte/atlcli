/**
 * Regression: `docs pull --limit <n>` passed n as the search PAGE SIZE, so the
 * pull drained every page of the scope anyway. `--limit` now caps how many
 * pages are pulled; without it a scope still pulls every page.
 *
 * Real CLI against a real Bun HTTP server standing in for Confluence (same
 * pattern as docs-pull-path-stability.test.ts). The stub caps search pages at
 * two results, like the real API caps `limit`, so draining is exercised too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const IDS = ["91001", "91002", "91003", "91004", "91005"];
const STUB_PAGE_SIZE = 2;

const page = (id: string) => ({
  id,
  type: "page",
  title: `Limit Fixture ${id}`,
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-19T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: `<p>Body ${id}.</p>`, representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${id}` },
});

let server: ReturnType<typeof Bun.serve>;
let home: string;
const trees: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/rest/api/content/search") {
        const start = Number(url.searchParams.get("start") ?? 0);
        const size = Math.min(Number(url.searchParams.get("limit") ?? 25), STUB_PAGE_SIZE);
        const slice = IDS.slice(start, start + size);
        const next = start + size < IDS.length
          ? `/rest/api/content/search?cql=${encodeURIComponent(url.searchParams.get("cql") ?? "")}&limit=${size}&start=${start + size}`
          : undefined;
        return Response.json({
          results: slice.map(page),
          start,
          limit: size,
          size: slice.length,
          _links: next ? { next } : {},
        });
      }
      const attachments = /^\/rest\/api\/content\/(\d+)\/child\/attachment$/.exec(url.pathname);
      if (attachments) return Response.json({ results: [], size: 0 });
      const content = /^\/rest\/api\/content\/(\d+)$/.exec(url.pathname);
      if (content && IDS.includes(content[1]!)) return Response.json(page(content[1]!));
      return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-limit-home-"));
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
  for (const dir of [home, ...trees]) if (dir) await rm(dir, { recursive: true, force: true });
});

async function pull(...extra: string[]) {
  const tree = await mkdtemp(join(tmpdir(), "atlcli-limit-tree-"));
  trees.push(tree);
  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "wiki", "docs", "pull", tree, "--space", "DOCSY", "--skip-user-check", ...extra],
    {
      cwd: tree,
      env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const files = exitCode === 0
    ? (await readdir(tree, { recursive: true }))
        .map(String)
        .filter((f) => f.endsWith(".md") && !f.startsWith(".atlcli"))
    : [];
  return { stdout, stderr, exitCode, files };
}

describe("docs pull --limit", () => {
  it("caps the number of pages pulled across search pages", async () => {
    const result = await pull("--limit", "3");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Pulling 3 page(s)");
    expect(result.files).toHaveLength(3);
  }, 60_000);

  it("pulls every page of the scope without --limit", async () => {
    const result = await pull();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Pulling ${IDS.length} page(s)`);
    expect(result.files).toHaveLength(IDS.length);
  }, 60_000);

  it("rejects a non-positive --limit", async () => {
    for (const bad of ["0", "-1", "abc"]) {
      const result = await pull("--limit", bad);
      expect(result.exitCode, `--limit ${bad}: ${result.stdout}${result.stderr}`).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("--limit must be a positive integer");
    }
  }, 60_000);
});
