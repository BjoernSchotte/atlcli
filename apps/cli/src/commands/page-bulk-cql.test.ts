/**
 * Bulk `--cql` operations and `page comments`, through the real CLI against a
 * local Bun server that speaks Confluence.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_SIZE = 100;
const TOTAL = 250;

let server: ReturnType<typeof Bun.serve>;
let home: string;
let requests: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/rest/api/content/search") {
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const results = Array.from({ length: Math.min(PAGE_SIZE, TOTAL - start) }, (_, i) => ({
          id: String(start + i + 1),
          title: `Page ${start + i + 1}`,
          type: "page",
          space: { key: "DOC" },
        }));
        const next = start + PAGE_SIZE;
        return Response.json({
          results,
          size: results.length,
          _links: next < TOTAL ? { next: `/rest/api/content/search?cql=x&cursor=${next}` } : {},
        });
      }
      return Response.json({ message: `No fixture route for ${url.pathname}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-page-bulk-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "t",
      profiles: { t: { name: "t", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" } } },
    }),
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  requests = [];
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args, "--json"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1", ATLCLI_API_TOKEN: "fixture-token" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

for (const args of [
  ["wiki", "page", "delete", "--cql", "space=DOC"],
  ["wiki", "page", "archive", "--cql", "space=DOC"],
  ["wiki", "page", "label", "add", "x", "--cql", "space=DOC"],
  ["wiki", "page", "label", "remove", "x", "--cql", "space=DOC"],
]) {
  test(`${args.slice(2, -2).join(" ")} --cql reads every result page, not only the first request`, async () => {
    const res = await run(...args, "--dry-run");
    expect(res.exitCode, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as { count: number; pages: Array<{ id: string }> };
    expect(out.count).toBe(TOTAL);
    expect(out.pages.at(-1)?.id).toBe(String(TOTAL));
  });
}

test("page comments <typo> is an unknown subcommand, not a list", async () => {
  const res = await run("wiki", "page", "comments", "lsit", "--id", "1");
  expect(res.exitCode).toBe(1);
  expect(JSON.parse(res.stdout).error).toMatchObject({ code: "ATLCLI_ERR_USAGE", message: "Unknown subcommand: lsit" });
  expect(requests).toEqual([]);
});
