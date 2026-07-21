/**
 * `--on-conflict` behaviour for the sync daemon.
 *
 * Two of the three documented modes were broken, in ways only a behavioural
 * test can see:
 *
 *  - `local`: `mergeChanges` called `pushFile`, `pushFile` re-detected that the
 *    remote was ahead and called `mergeChanges` straight back. Unbounded mutual
 *    recursion — tens of thousands of GETs in seconds, zero PUTs, no output, and
 *    the file never pushed. Against a real tenant that is an accidental
 *    denial-of-service against the user's own site.
 *  - `remote`: it wrote the remote content to a *new* file (`stub-page-2.md`,
 *    from the collision suffix in `computeFilePath`) and left the conflicted
 *    file holding the local edit — the one mode whose contract is "remote wins"
 *    was the one that preserved the local version.
 *
 * Each test drives the real CLI daemon against a real local Bun HTTP server
 * standing in for the Confluence REST API, then kills it. Every wait is bounded
 * by an explicit deadline so a regression fails the test instead of hanging the
 * suite.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "12345";
const PAGE_FILE = "stub-page.md";

/** Base (last synced) body, and the remote edit that conflicts with the local one. */
const BASE_STORAGE = "<p>alpha</p><p>beta</p><p>gamma</p>";
const REMOTE_STORAGE = "<p>alpha</p><p>beta-remote</p><p>gamma</p>";

/**
 * A runaway is thousands of requests per second; a healthy resolution is a
 * handful plus one poll per second. Anything under this bound proves
 * termination without being brittle about the exact count.
 */
const MAX_REQUESTS = 200;

interface Harness {
  dir: string;
  proc: Bun.Subprocess;
  server: ReturnType<typeof Bun.serve>;
  lines: string[];
  counts: { get: number; put: number };
  putBodies: string[];
  unmatched: string[];
  setRemote(version: number, storage: string): void;
  cleanup(): Promise<void>;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

/** Wait until `predicate` holds; resolves false on timeout rather than hanging. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

/**
 * Boot a stub Confluence and a real sync daemon over an empty directory, and
 * wait until the daemon has completed its initial sync.
 */
async function startDaemon(mode: "local" | "remote"): Promise<Harness> {
  let remoteVersion = 1;
  let remoteStorage = BASE_STORAGE;
  const counts = { get: 0, put: 0 };
  const putBodies: string[] = [];
  const unmatched: string[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      // Data-center shape (bearer auth ⇒ no /wiki prefix). One route answers
      // getPage, getPageVersion and updatePage.
      if (pathname === `/rest/api/content/${PAGE_ID}`) {
        if (req.method === "PUT") {
          counts.put++;
          const body = (await req.json()) as any;
          putBodies.push(body?.body?.storage?.value ?? "");
          remoteVersion = body?.version?.number ?? remoteVersion + 1;
          remoteStorage = body?.body?.storage?.value ?? remoteStorage;
          return Response.json({
            id: PAGE_ID,
            title: body?.title ?? "Stub Page",
            space: { key: "DOCSY" },
            version: { number: remoteVersion },
          });
        }
        counts.get++;
        return Response.json({
          id: PAGE_ID,
          title: "Stub Page",
          type: "page",
          space: { key: "DOCSY" },
          version: { number: remoteVersion },
          ancestors: [],
          history: { lastUpdated: { when: "2026-07-20T00:00:00.000Z" } },
          body: { storage: { value: remoteStorage, representation: "storage" } },
          _links: { base: "http://example.invalid", webui: `/pages/${PAGE_ID}` },
        });
      }
      unmatched.push(`${req.method} ${pathname}`);
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const root = await mkdtemp(join(tmpdir(), `atlcli-sync-conflict-${mode}-`));
  const home = join(root, "home");
  const dir = join(root, "docs");
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: {
          name: "stub",
          baseUrl: server.url.origin,
          deploymentType: "data-center",
          auth: { type: "bearer", pat: "stub-token" },
        },
      },
      logging: { level: "off", global: false, project: false },
    })
  );

  const proc = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      "run",
      CLI,
      "wiki",
      "docs",
      "sync",
      dir,
      "--page-id",
      PAGE_ID,
      // Poll-driven rather than fs.watch-driven: a timer is deterministic on
      // every platform, and it exercises the "someone else edited the page in
      // Confluence" path that reaches mergeChanges.
      "--no-watch",
      "--poll-interval",
      "1000",
      "--on-conflict",
      mode,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ATLCLI_API_TOKEN: "stub-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const lines: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line.trim()) lines.push(line.trim());
        }
      }
    } catch {
      // Stream closes when the daemon is killed.
    }
  })();

  const h: Harness = {
    dir,
    proc,
    server,
    lines,
    counts,
    putBodies,
    unmatched,
    setRemote(version, storage) {
      remoteVersion = version;
      remoteStorage = storage;
    },
    async cleanup() {
      proc.kill("SIGKILL");
      await proc.exited;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };

  const started = await waitFor(() => lines.some((l) => l.includes("Sync daemon started")), 30_000);
  expect(started, `daemon never started; stdout:\n${lines.join("\n")}`).toBe(true);
  return h;
}

/** Diverge local and remote from the pulled base, so the three-way merge fails. */
async function createConflict(h: Harness): Promise<void> {
  const pulled = await readFile(join(h.dir, PAGE_FILE), "utf-8");
  expect(pulled).toContain("beta");
  await writeFile(join(h.dir, PAGE_FILE), pulled.replace("beta", "beta-local"));
  h.setRemote(2, REMOTE_STORAGE);
}

describe("wiki docs sync --on-conflict local", () => {
  it("pushes the local version once and terminates", async () => {
    const h = (harness = await startDaemon("local"));
    const requestsAfterInitialSync = h.counts.get + h.counts.put;
    await createConflict(h);

    // The regression: this never became true — mergeChanges and pushFile called
    // each other forever, issuing GETs and never a single PUT.
    const pushed = await waitFor(() => h.counts.put > 0, 20_000);
    expect(
      pushed,
      `no PUT within 20s (${h.counts.get} GETs seen — runaway recursion?); stdout:\n${h.lines.join("\n")}`
    ).toBe(true);

    // Let anything still in flight settle, then bound the traffic.
    await Bun.sleep(2_000);
    const requests = h.counts.get + h.counts.put - requestsAfterInitialSync;
    expect(requests).toBeLessThan(MAX_REQUESTS);

    expect(h.putBodies.length).toBeGreaterThan(0);
    expect(h.putBodies[0]).toContain("beta-local");
    expect(h.putBodies[0]).not.toContain("beta-remote");
    // Conflict markers must never be pushed to Confluence.
    expect(h.putBodies.join("")).not.toContain("<<<<<<<");

    expect(h.lines.join("\n")).toContain("keeping local (--on-conflict local)");
    expect(h.unmatched).toEqual([]);
  }, 90_000);
});

describe("wiki docs sync --on-conflict remote", () => {
  it("overwrites the conflicted file in place instead of creating a second one", async () => {
    const h = (harness = await startDaemon("remote"));
    await createConflict(h);

    const resolved = await waitFor(() => h.lines.some((l) => l.includes("keeping remote")), 20_000);
    expect(resolved, `conflict never resolved; stdout:\n${h.lines.join("\n")}`).toBe(true);

    // The initial sync already logged one "[PULL] Pulled:"; the conflict
    // resolution is the second.
    const pulled = await waitFor(
      () => h.lines.filter((l) => l.startsWith("[PULL] Pulled:")).length >= 2,
      20_000
    );
    expect(pulled, `remote content never applied; stdout:\n${h.lines.join("\n")}`).toBe(true);
    // Let the write and any trailing poll settle before inspecting the tree.
    await Bun.sleep(1_500);

    // The regression: the remote content landed in `stub-page-2.md` while
    // `stub-page.md` kept the local edit.
    const files = (await readdir(h.dir)).filter((f) => f.endsWith(".md")).sort();
    expect(files).toEqual([PAGE_FILE]);

    const content = await readFile(join(h.dir, PAGE_FILE), "utf-8");
    expect(content).toContain("beta-remote");
    expect(content).not.toContain("beta-local");

    // "remote wins" means the local edit is discarded, not pushed.
    expect(h.counts.put).toBe(0);
    expect(h.unmatched).toEqual([]);
  }, 90_000);
});
