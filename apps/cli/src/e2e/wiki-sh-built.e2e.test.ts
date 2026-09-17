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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isMounted, processIdentity, runMountCommand, type MountRecord } from "../commands/wiki-mount.js";
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
  version?: number;
}

const PAGES = new Map<string, StandInPage>([
  ["100", { id: "100", title: "Docs Home", parentId: null, storage: "<p>Home.</p>" }],
  ["202", { id: "202", title: "Detached Root", parentId: null, storage: "<p>Parentless Grüße 🐴</p>" }],
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
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.includes("/user")) {
        return Response.json({ accountId: "acct-1", displayName: "Built Smoke", type: "known" });
      }
      if (path.endsWith("/api/v2/spaces/1/pages") && url.searchParams.get("depth") === "root") {
        return Response.json({ results: [...PAGES.values()].filter(page => page.parentId === null)
          .map(page => ({ id: page.id, title: page.title, spaceId: "1", parentId: null, version: { number: 1 } })), _links: {} });
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
                version: { number: page.version ?? 1, createdAt: "2026-09-16T09:00:00.000Z" },
                ...(withBody ? { body: { storage: { value: page.storage } } } : {}),
                _links: {},
              };
            }),
          _links: {},
        });
      }
      if (path.endsWith("/rest/api/content") && request.method === "POST") {
        const input = await request.json() as { title: string; ancestors: { id: string }[]; body: { storage: { value: string } } };
        const id = String(Math.max(...[...PAGES.keys()].map(Number)) + 1);
        const page = { id, title: input.title, parentId: input.ancestors[0]!.id, storage: input.body.storage.value, version: 1 };
        PAGES.set(id, page);
        return Response.json({ ...page, version: { number: 1 }, space: { key: "DOCSY" }, ancestors: input.ancestors,
          _links: { base: url.origin, webui: `/spaces/DOCSY/pages/${id}` } });
      }
      const content = /\/rest\/api\/content\/(\d+)$/.exec(path);
      if (content) {
        const page = PAGES.get(content[1]!);
        if (!page) return new Response("{}", { status: 404 });
        if (request.method === "PUT") {
          const update = await request.json() as { title: string; version: { number: number }; body: { storage: { value: string } } };
          if (update.version.number !== (page.version ?? 1) + 1) return new Response("conflict", { status: 409 });
          page.title = update.title; page.storage = update.body.storage.value; page.version = update.version.number;
        }
        return Response.json({
          id: page.id,
          title: page.title,
          version: { number: page.version ?? 1 },
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
  if (home) for (const name of readdirSync(home)) {
    if (isMounted(join(home, name))) throw new Error(`Test mount remains attached: ${join(home, name)}`);
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

/**
 * Asynchronous on purpose: `spawnSync` blocks the event loop, so the
 * in-process stand-in could never answer the child's request and the pair
 * would deadlock. (It did, the first time.)
 */
function startCli(args: string[], binary = BINARY) {
  const proc = Bun.spawn([...(binary ? [binary] : ["bun", BUNDLE]), ...args], {
    env: { ...process.env, HOME: home, ATLCLI_API_TOKEN: "token", ATLCLI_NFS_HELPER: undefined },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc;
}

async function finishCli(proc: ReturnType<typeof startCli>): Promise<{ out: string; err: string; code: number }> {
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

async function cli(...args: string[]) { return finishCli(startCli(args)); }

describe.skipIf(!RUN).serial("the built CLI drives a shell session", () => {
  for (const transport of ["nfs", "webdav"] as const) {
  for (const mode of transport === "nfs" ? ["ro", "rw"] as const : ["ro"] as const) {
  for (const shutdownCase of transport === "nfs" ? ["signal", "busy", "helper", "busy-helper", "explicit"] : ["signal"]) {
  it.skipIf(!BINARY || process.env.ATLCLI_NFS_KERNEL !== "1")(`runs compiled ${transport} ${transport === "nfs" ? "with adjacent companion" : "without an NFS companion"} (${mode}; ${shutdownCase})`, async () => {
    const mountpoint = join(home, `${transport}-${mode}-mount-${shutdownCase}`);
    const cache = join(home, `${transport}-${mode}-${shutdownCase}-mount-cache`);
    let binary = BINARY;
    if (transport === "webdav") {
      const directory = join(home, "webdav-binary"); mkdirSync(directory);
      binary = join(directory, "atlcli"); copyFileSync(BINARY!, binary);
    }
    const proc = startCli(["wiki", "mount", mountpoint, "--transport", transport, "--space", "DOCSY",
      "--mode", mode, "--cache-dir", cache, "--json"], binary);
    let holder: ReturnType<typeof Bun.spawn> | undefined;
    let createdPage: string | undefined;
    let pendingImage: string | undefined;
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
      expect(record?.transport).toBe(transport);
      expect(record?.mode).toBe(mode);
      if (transport === "nfs") expect(record?.helperPid).toBeGreaterThan(0);
      else expect(record?.helperPid).toBeUndefined();
      if (platform() === "linux" && transport === "nfs") {
        expect(await runMountCommand(["sudo", "-n", "mount", "-t", "nfs", "-o",
          nfsMountOptionsFor("linux", record!.port, mode), "127.0.0.1:/", mountpoint])).toBe(0);
      }
      if (platform() === "linux" && transport === "webdav") {
        const config = readdirSync(join(cache, "mounts")).find(name => name.endsWith(".davfs.conf"));
        expect(config).toBeDefined();
        expect(readFileSync(join(cache, "mounts", config!), "utf8")).toBe("delay_upload 0\n");
        expect(stderr).toContain(`conf=${join(cache, "mounts", config!)}`);
        // Linux WebDAV attach is manual and CI needs no davfs2 installation.
        const url = new URL("architecture-201/_index.md", record!.url.endsWith("/") ? record!.url : `${record!.url}/`);
        const content = await fetch(url);
        expect(content.status).toBe(200);
        expect(await content.text()).toContain("Grüße 🐴");
        expect((await fetch(url, { method: "PUT", body: "denied" })).status).toBe(403);
      } else {
        expect(isMounted(mountpoint)).toBe(true);
        expect(await readdir(mountpoint)).toContain("architecture-201");
        expect(await readFile(join(mountpoint, "architecture-201", "_index.md"), "utf8")).toContain("Grüße 🐴");
        const pagePath = join(mountpoint, "architecture-201", "_index.md");
        if (mode === "ro") await expect(writeFile(pagePath, "denied")).rejects.toMatchObject({ code: "EROFS" });
        else {
          const marker = `Compiled RW ${shutdownCase} Grüße 🐴`;
          const before = PAGES.get("201")!.version ?? 1;
          const content = await readFile(pagePath, "utf8");
          const started = performance.now();
          await writeFile(pagePath, `${content}\n${marker}\n`);
          expect(await readFile(pagePath, "utf8")).toContain(marker);
          const deadline = Date.now() + 10000;
          while (!PAGES.get("201")!.storage.includes(marker) && Date.now() < deadline) await Bun.sleep(20);
          expect(PAGES.get("201")!.storage).toContain(marker);
          expect(PAGES.get("201")!.version).toBe(before + 1);
          console.error(`Compiled NFS ${shutdownCase} save to API: ${(performance.now() - started).toFixed(1)}ms`);
          if (shutdownCase === "signal") {
            const countBefore = PAGES.size;
            const newPath = join(mountpoint, "compiled-new-page.md");
            const editor = Bun.spawn(["vim", "-u", "NONE", "-U", "NONE", "-i", "NONE", "-n", "-es", newPath,
              "-c", "call setline(1, 'Plain new page Grüße 🐴')", "-c", "wq"], { stdout: "ignore", stderr: "pipe" });
            const error = await new Response(editor.stderr).text();
            expect(await editor.exited, error).toBe(0);
            const deadline = Date.now() + 10000;
            while (!createdPage && Date.now() < deadline) {
              createdPage = [...PAGES.values()].find(page => page.storage.includes("Plain new page Grüße"))?.id;
              if (!createdPage) await Bun.sleep(20);
            }
            expect(createdPage).toBeDefined();
            expect(PAGES.size).toBe(countBefore + 1);
            expect(PAGES.get(createdPage!)!.parentId).toBe("100");
            await writeFile(newPath, "Second plain save Grüße 🐴\n");
            const updated = Date.now() + 10000;
            while (!PAGES.get(createdPage!)!.storage.includes("Second plain save") && Date.now() < updated) await Bun.sleep(20);
            expect(PAGES.get(createdPage!)!.version).toBe(2);
            expect(PAGES.size).toBe(countBefore + 1);
            expect(await readFile(newPath, "utf8")).toContain("Second plain save");
          }
        }
      }
      const busy = shutdownCase.startsWith("busy");
      const helperCrash = shutdownCase.includes("helper");
      if (busy) {
        holder = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(()=>{},1000)"],
          { cwd: mountpoint, stdout: "pipe", stderr: "ignore" });
        const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
        try { expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); }
        finally { reader.releaseLock(); }
      }
      if (helperCrash && mode === "rw") {
        const pagePath = join(mountpoint, "architecture-201", "_index.md");
        pendingImage = `${await readFile(pagePath, "utf8")}\nAcknowledged immediately before helper loss 🐴\n`;
        await writeFile(pagePath, pendingImage);
      }
      if (helperCrash) process.kill(record!.helperPid!, "SIGKILL");
      else if (shutdownCase === "explicit") {
        const detached = await cli("wiki", "mount", "unmount", mountpoint, "--cache-dir", cache, "--json");
        expect(detached.code).toBe(0);
      } else proc.kill(busy ? "SIGINT" : "SIGTERM");
      if (busy) {
        const deadline = Date.now() + 10000;
        while (!stderr.includes("could not unmount") && proc.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
        expect(stderr).toContain("could not unmount");
        expect(proc.exitCode).toBeNull();
        expect(isMounted(mountpoint)).toBe(true);
        const name = readdirSync(join(cache, "mounts")).find(name => name.endsWith(".json"))!;
        const retained = JSON.parse(readFileSync(join(cache, "mounts", name), "utf8"));
        if (helperCrash) {
          expect(retained.helperPid).not.toBe(record!.helperPid);
          expect(processIdentity(retained.helperPid)).toBe(retained.helperIdentity);
        }
        holder!.kill("SIGTERM"); await holder!.exited; holder = undefined;
        proc.kill("SIGINT");
      }
      expect(await Promise.race([proc.exited, Bun.sleep(10000).then(() => { throw new Error("Compiled CLI did not detach"); })])).toBe(helperCrash ? 1 : 0);
      expect(isMounted(mountpoint)).toBe(false);
      expect(readdirSync(join(cache, "mounts")).filter(name => name.endsWith(".json"))).toEqual([]);
      if (pendingImage) {
        const exported = join(cache, "recovered.md");
        const recovery = await cli("wiki", "mount", "recovery", JSON.parse(stdout).journalPath,
          "--id", "201", "--output", exported, "--json");
        expect(recovery.code, recovery.err).toBe(0);
        expect(await readFile(exported, "utf8")).toBe(pendingImage);
      }
    } finally {
      if (holder) { holder.kill("SIGTERM"); await holder.exited; }
      if (isMounted(mountpoint)) await runMountCommand(platform() === "linux"
        ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint]);
      proc.kill("SIGTERM");
      await proc.exited;
      await drained;
      if (createdPage) PAGES.delete(createdPage);
    }
  }, 40000);
  }
  }
  }

  it.skipIf(!BINARY || !["darwin", "linux"].includes(platform()))("keeps the compiled shell independent of missing or unusable NFS helpers", async () => {
    const directory = join(home, "standalone");
    mkdirSync(directory);
    const binary = join(directory, "atlcli");
    copyFileSync(BINARY!, binary);
    const run = (...args: string[]) => finishCli(startCli(args, binary));
    const missing = await run("wiki", "mount", join(home, "missing-helper-mount"), "--transport", "nfs",
      "--space", "DOCSY", "--mode", "ro");
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("NFS helper missing or not executable");
    expect(existsSync(join(home, "missing-helper-mount"))).toBe(false);
    for (const unusable of [false, true]) {
      if (unusable) writeFileSync(join(directory, "atlcli-confluence-nfs"), "#!/bin/sh\nexit 98\n", { mode: 0o700 });
      const version = await run("--version");
      expect(version.code).toBe(0);
      const shell = await run("wiki", "sh", "--space", "DOCSY", "-c", "cat architecture-201/_index.md");
      expect(shell.code).toBe(0);
      expect(shell.out).toContain("Grüße 🐴");
    }
  }, 30000); // Copies a native executable and launches five separate processes.

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

  it("reads a parentless page and resolves its own canonical ID link", async () => {
    const result = await cli("wiki", "sh", "--space", "DOCSY", "-c",
      "cat detached-root-202/_index.md; readlink .by-id/202.md");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Parentless Grüße 🐴");
    expect(result.out).toContain("detached-root-202/_index.md");
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
  }, 15000); // Multiple cold compiled-CLI launches on native CI runners.

  it("runs the extra commands", async () => {
    const status = await cli("wiki", "sh", "--space", "DOCSY", "-c", "vfs-status");
    expect(status.out).toContain("mode:");
    const id = await cli("wiki", "sh", "--space", "DOCSY", "-c", "page-id architecture-201");
    expect(id.out.trim()).toBe("201");
  }, 15000); // Multiple cold compiled-CLI launches on native CI runners.

  it("runs the maintenance commands", async () => {
    const stats = await cli("wiki", "vfs", "cache", "stats", "--json");
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("bodies");
    const conflicts = await cli("wiki", "vfs", "conflicts", "list", "--json");
    expect(conflicts.code).toBe(0);
  }, 15000); // Multiple cold compiled-CLI launches on native CI runners.

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
  }, 15000); // Multiple cold compiled-CLI launches on native CI runners.
});
