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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isMounted, runMountCommand, type MountRecord } from "../commands/wiki-mount.js";
import { nfsMountOptionsFor } from "../vfs/mount-transport.js";
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
      storage: "<h1>Architecture</h1><p>Runs on clusters. Grüße 🐴</p>",
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
      if (/\/api\/v2\/pages\/\d+\/(footer-comments|inline-comments)$/.test(path)) {
        return Response.json({ results: [], _links: {} });
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
  if (home && isMounted(join(home, "mount"))) throw new Error(`Test mount remains attached: ${join(home, "mount")}`);
  if (home) rmSync(home, { recursive: true, force: true });
});

/**
 * Asynchronous on purpose: `spawnSync` blocks the event loop, so the
 * in-process stand-in could never answer the child's request and the pair
 * would deadlock. (It did, the first time.)
 */
function startCli(...args: string[]) {
  const proc = Bun.spawn([...(BINARY ? [BINARY] : ["bun", BUNDLE]), ...args], {
    env: { ...process.env, HOME: home, ATLCLI_API_TOKEN: "token", ATLCLI_NFS_HELPER: undefined },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc;
}

async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = startCli(...args);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe.skipIf(!RUN).serial("the built CLI drives a shell session", () => {
  it.skipIf(!BINARY || process.env.ATLCLI_NFS_KERNEL !== "1")("mounts through the compiled CLI and adjacent NFS companion", async () => {
    const mountpoint = join(home, "mount");
    const cache = join(home, "mount-cache");
    const proc = startCli("wiki", "mount", mountpoint, "--transport", "nfs", "--space", "DOCSY",
      "--mode", "ro", "--cache-dir", cache, "--json");
    let stdout = "", stderr = "";
    const drain = async (stream: ReadableStream<Uint8Array>, append: (s: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
    };
    const drained = Promise.all([drain(proc.stdout, text => { stdout += text; }),
      drain(proc.stderr, text => { stderr += text; })]);
    try {
      let record: MountRecord | undefined;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error(`Compiled CLI exited before mount: ${stderr || stdout}`);
        try {
          const name = readdirSync(join(cache, "mounts")).find(name => name.endsWith(".json"));
          if (name) record = JSON.parse(readFileSync(join(cache, "mounts", name), "utf8"));
        } catch { /* Waiting for atomic state publication. */ }
        if (record && stdout.includes('"transport"')) break;
        await Bun.sleep(25);
      }
      expect(record?.transport).toBe("nfs");
      expect(record?.helperPid).toBeGreaterThan(0);
      if (platform() === "linux") {
        expect(await runMountCommand(["sudo", "-n", "mount", "-t", "nfs", "-o",
          nfsMountOptionsFor("linux", record!.port), "127.0.0.1:/", mountpoint])).toBe(0);
      }
      expect(isMounted(mountpoint)).toBe(true);
      expect(await readdir(mountpoint)).toContain("architecture-201");
      expect(await readFile(join(mountpoint, "architecture-201", "_index.md"), "utf8")).toContain("Grüße 🐴");
      await expect(writeFile(join(mountpoint, "architecture-201", "_index.md"), "denied")).rejects.toMatchObject({ code: "EROFS" });
      proc.kill("SIGTERM");
      expect(await Promise.race([proc.exited, Bun.sleep(10000).then(() => { throw new Error("Compiled CLI did not detach"); })])).toBe(0);
      expect(isMounted(mountpoint)).toBe(false);
      expect(readdirSync(join(cache, "mounts")).filter(name => name.endsWith(".json"))).toEqual([]);
    } finally {
      if (isMounted(mountpoint)) await runMountCommand(platform() === "linux"
        ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint]);
      proc.kill("SIGTERM");
      await proc.exited;
      await drained;
    }
  }, 40000);

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
