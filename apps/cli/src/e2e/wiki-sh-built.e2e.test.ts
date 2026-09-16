/**
 * The **built bundle**, driven against a local Confluence stand-in (WP9.5).
 *
 * Every other test in this feature imports TypeScript sources. This one runs
 * `dist/index.js` as a child process over real HTTP, which is the only way to
 * catch the class of failure that only exists in the artifact:
 *
 *  - the dynamic `import("just-bash")` failing to resolve inside the bundle,
 *  - a command not reaching the dispatcher,
 *  - the exit code not surviving the process boundary.
 *
 * Skipped unless `dist/index.js` exists, so `bun run test` on a fresh checkout
 * does not fail for want of a build. Run it with:
 *
 *   bun run build:cli && bun run test apps/cli/src/e2e/wiki-sh-built.e2e.test.ts
 *
 * Set ATLCLI_VFS_TEST_BINARY=/absolute/path/to/atlcli to exercise a compiled
 * release executable with the same HTTP stand-in and assertions.
 *
 * The stand-in serves the handful of endpoints the VFS touches. It is not a
 * Confluence emulator and does not try to be — `FakeConfluenceClient` covers
 * behaviour; this covers packaging.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BINARY = process.env.ATLCLI_VFS_TEST_BINARY;
const BUNDLE = BINARY ?? resolve(import.meta.dir, "../../../../dist/index.js");
const RUN = Boolean(BINARY) || existsSync(BUNDLE);

interface StandInPage {
  id: string;
  title: string;
  parentId: string | null;
  storage: string;
}

const PAGES = new Map<string, StandInPage>([
  ["100", { id: "100", title: "Docs Home", parentId: null, storage: "<p>Home.</p>" }],
  [
    "200",
    {
      id: "200",
      title: "Getting Started",
      parentId: "100",
      storage: "<h1>Getting Started</h1><p>Install with kubernetes.</p>",
    },
  ],
  [
    "201",
    {
      id: "201",
      title: "Architecture",
      parentId: "100",
      storage: "<h1>Architecture</h1><p>Runs on clusters.</p>",
    },
  ],
]);

let server: ReturnType<typeof Bun.serve> | undefined;
let home: string;

beforeAll(() => {
  if (!RUN) return;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.includes("/user")) {
        return Response.json({ accountId: "acct-1", displayName: "Built Smoke", type: "known" });
      }
      if (path.includes("/api/v2/spaces")) {
        // Cloud resolves the home page from here, not from the v1 space record.
        return Response.json({
          results: [
            {
              id: "1",
              key: "DOCSY",
              name: "Docs",
              type: "global",
              status: "current",
              homepageId: "100",
            },
          ],
          _links: {},
        });
      }
      if (path.endsWith("/rest/api/space/DOCSY") || path.endsWith("/rest/api/space")) {
        return Response.json({
          id: 1,
          key: "DOCSY",
          name: "Docs",
          type: "global",
          status: "current",
          homepage: { id: "100" },
          _links: { base: url.origin, webui: "/spaces/DOCSY" },
        });
      }
      const children = /\/api\/v2\/pages\/(\d+)\/direct-children/.exec(path);
      if (children) {
        const parent = children[1]!;
        return Response.json({
          results: [...PAGES.values()]
            .filter((page) => page.parentId === parent)
            .map((page, index) => ({
              id: page.id,
              title: page.title,
              type: "page",
              status: "current",
              childPosition: index,
              _links: {},
            })),
          _links: {},
        });
      }
      if (path.endsWith("/api/v2/pages")) {
        const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
        const withBody = url.searchParams.get("body-format") === "storage";
        return Response.json({
          results: ids
            .filter((id) => PAGES.has(id))
            .map((id) => {
              const page = PAGES.get(id)!;
              return {
                id,
                title: page.title,
                parentId: page.parentId,
                version: { number: 1, createdAt: "2026-09-16T09:00:00.000Z" },
                ...(withBody ? { body: { storage: { value: page.storage } } } : {}),
                _links: {},
              };
            }),
          _links: {},
        });
      }
      const content = /\/rest\/api\/content\/(\d+)$/.exec(path);
      if (content) {
        const page = PAGES.get(content[1]!);
        if (!page) return new Response("{}", { status: 404 });
        return Response.json({
          id: page.id,
          title: page.title,
          version: { number: 1 },
          space: { key: "DOCSY" },
          ancestors: page.parentId ? [{ id: page.parentId, title: "Docs Home" }] : [],
          body: { storage: { value: page.storage } },
          _links: { base: url.origin, webui: `/spaces/DOCSY/pages/${page.id}` },
        });
      }
      return new Response(JSON.stringify({ message: `unmapped ${path}` }), { status: 404 });
    },
  });

  home = mkdtempSync(join(tmpdir(), "atlcli-built-"));
  mkdirSync(join(home, ".atlcli"), { recursive: true });
  writeFileSync(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "smoke",
      profiles: {
        smoke: {
          name: "smoke",
          baseUrl: `http://127.0.0.1:${server.port}`,
          deploymentType: "cloud",
          auth: { type: "apiToken", email: "smoke@example.com", token: "token" },
        },
      },
    }),
  );
});

afterAll(() => {
  if (!RUN) return;
  server?.stop(true);
  if (home) rmSync(home, { recursive: true, force: true });
});

/**
 * Asynchronous on purpose: `spawnSync` blocks the event loop, so the
 * in-process stand-in could never answer the child's request and the pair
 * would deadlock. (It did, the first time.)
 */
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([...(BINARY ? [BINARY] : ["bun", BUNDLE]), ...args], {
    env: { ...process.env, HOME: home, ATLCLI_API_TOKEN: "token" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe.skipIf(!RUN).serial("the built CLI drives a shell session", () => {
  it("lists a space", async () => {
    const result = await cli("wiki", "sh", "--space", "DOCSY", "-c", "ls");
    expect(result.code).toBe(0);
    expect(result.out).toContain("getting-started-200");
    expect(result.out).toContain("architecture-201");
  });

  it("reads a page, frontmatter and all", async () => {
    const result = await cli("wiki", "sh", "--space", "DOCSY", "-c", "cat architecture-201/_index.md");
    expect(result.out).toContain("atlcli:");
    expect(result.out).toContain("Runs on clusters");
  });

  it("greps, and names the path it took on stderr", async () => {
    const result = await cli("wiki", "sh", "--space", "DOCSY", "-c", "grep -rl kubernetes .");
    expect(result.out).toContain("getting-started-200");
    expect(result.err).toContain("grep:");
  });

  it("refuses a write in the default mode", async () => {
    const result = await cli(
      "wiki",
      "sh",
      "--space",
      "DOCSY",
      "-c",
      "echo x > architecture-201/_index.md",
    );
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("EROFS");
    expect(result.err).toContain("--mode rw");
  });

  it("emits the documented --json shape", async () => {
    const result = await cli("wiki", "sh", "--space", "DOCSY", "--json", "-c", "ls");
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(parsed.requests).toBeGreaterThan(0);
    expect(parsed.rateLimits).toBe(0);
    for (const key of ["stdout", "stderr", "exitCode", "diagnostics", "cacheHits", "prefetched", "requests", "rateLimits"]) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it("exits with the bash exit code, so it composes from outside", async () => {
    const miss = await cli("wiki", "sh", "--space", "DOCSY", "-c", "grep -q nothing-matches .");
    expect(miss.code).toBe(1);
    const hit = await cli("wiki", "sh", "--space", "DOCSY", "-c", "ls > /dev/null");
    expect(hit.code).toBe(0);
  });

  it("runs the extra commands", async () => {
    const status = await cli("wiki", "sh", "--space", "DOCSY", "-c", "vfs-status");
    expect(status.out).toContain("mode:");
    const id = await cli("wiki", "sh", "--space", "DOCSY", "-c", "page-id architecture-201");
    expect(id.out.trim()).toBe("201");
  });

  it("runs the maintenance commands", async () => {
    const stats = await cli("wiki", "vfs", "cache", "stats", "--json");
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("bodies");
    const conflicts = await cli("wiki", "vfs", "conflicts", "list", "--json");
    expect(conflicts.code).toBe(0);
  });

  it("prints help for every new command", async () => {
    for (const command of [
      ["wiki", "sh", "--help"],
      ["wiki", "mount", "--help"],
      ["wiki", "vfs", "--help"],
    ]) {
      const result = await cli(...command);
      expect(result.code).toBe(0);
      expect(result.out.length).toBeGreaterThan(100);
    }
  });
});
