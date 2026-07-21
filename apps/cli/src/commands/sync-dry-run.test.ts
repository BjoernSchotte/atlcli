/**
 * `atlcli wiki docs sync --dry-run` must not touch the working directory.
 *
 * The help text promises "Show what would sync without changes", but the
 * legacy-format migration inside `SyncEngine.initialSync` ran unguarded: it
 * deleted `<file>.meta.json` and `<file>.base` — the only copy of that
 * metadata — copied the base into `.atlcli/cache/`, and persisted a whole
 * `.atlcli/` state store (config.json + sync.db) into a directory the user had
 * never initialized. The user asked for the safe path and lost files.
 *
 * These are behavioural tests, not source-text assertions: a real CLI process
 * runs against a real local Bun HTTP server standing in for the Confluence REST
 * API, and the fixture directory is compared byte for byte before and after.
 * Asserting only that stdout says "Would pull" is exactly the check that let
 * this regression through.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "12345";

/** Requests the stub could not answer — surfaced in the failure message. */
const unmatched: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let root: string;
let home: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      // Data-center shape (bearer auth ⇒ no /wiki prefix). One route answers
      // both `getPageVersion` and `getPage`; they differ only in `expand`.
      if (pathname === `/rest/api/content/${PAGE_ID}`) {
        return Response.json({
          id: PAGE_ID,
          title: "Legacy Page",
          type: "page",
          space: { key: "DOCSY" },
          // Ahead of the version recorded in the legacy .meta.json, so the dry
          // run has something to report ("Would pull").
          version: { number: 2 },
          ancestors: [],
          history: { lastUpdated: { when: "2026-07-20T00:00:00.000Z" } },
          body: { storage: { value: "<p>Remote body v2.</p>", representation: "storage" } },
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

  root = await mkdtemp(join(tmpdir(), "atlcli-sync-dry-run-"));
  home = join(root, "home");
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  );
});

afterAll(async () => {
  server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * Build a directory in the pre-v2 on-disk format: a markdown file flanked by
 * the sidecar `<file>.meta.json` and `<file>.base` that `initialSync` migrates.
 */
async function makeLegacyFixture(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "legacy.md"),
    `---\natlcli:\n  id: "${PAGE_ID}"\n  title: "Legacy Page"\n---\n\n# Legacy Page\n\nLocal body.\n`
  );
  await writeFile(
    join(dir, "legacy.md.meta.json"),
    JSON.stringify(
      {
        id: PAGE_ID,
        title: "Legacy Page",
        spaceKey: "DOCSY",
        version: 1,
        lastSyncedAt: "2026-07-19T00:00:00.000Z",
        localHash: "hash-local",
        remoteHash: "hash-remote",
        baseHash: "hash-base",
        syncState: "synced",
      },
      null,
      2
    )
  );
  await writeFile(join(dir, "legacy.md.base"), "# Legacy Page\n\nLocal body.\n");
  return dir;
}

/** Relative path → sha256 of the bytes, for every file below `dir`. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
  await walk(dir);
  return out;
}

/** Run the real CLI against the stub server. */
async function runSyncCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "wiki", "docs", "sync", ...args], {
    // Deliberately NOT the fixture directory: the CLI writes project logs into
    // `./.atlcli/logs` when cwd is an initialized sync root, which would muddy
    // the byte-identity assertion with an unrelated concern.
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
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("wiki docs sync --dry-run leaves the working directory untouched", () => {
  it("does not delete the legacy .meta.json/.base sidecars it would migrate", async () => {
    const dir = await makeLegacyFixture("legacy-migration");
    const before = await snapshot(dir);
    expect(Object.keys(before).sort()).toEqual(["legacy.md", "legacy.md.base", "legacy.md.meta.json"]);

    const { stdout, stderr, exitCode } = await runSyncCli([dir, "--page-id", PAGE_ID, "--dry-run"]);

    expect(unmatched).toEqual([]);
    expect(exitCode, `stderr:\n${stderr}`).toBe(0);

    // The dry run still has to be useful: it reports the migration and the pull
    // it *would* perform.
    expect(stdout).toContain("Would migrate: legacy.md");
    expect(stdout).toContain("Would pull: Legacy Page");
    // …in the future tense only.
    expect(stdout).not.toMatch(/^\[STATUS\] Migrated:/m);
    expect(stdout).not.toMatch(/^\[PULL\] Pulled:/m);

    // The regression itself. `legacy.md.meta.json` and `legacy.md.base` used to
    // be unlinked here, and a full `.atlcli/` store (config.json, sync.db,
    // cache/12345.md) created alongside them.
    const after = await snapshot(dir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
    expect(existsSync(join(dir, ".atlcli"))).toBe(false);
  }, 60_000);

  it("does not create the target directory", async () => {
    const dir = join(root, "never-created");
    expect(existsSync(dir)).toBe(false);

    const { stderr, exitCode } = await runSyncCli([dir, "--page-id", PAGE_ID, "--dry-run"]);

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});

describe("wiki docs sync flag validation", () => {
  /**
   * `--dry-run` is on every case so the command terminates either way: without
   * validation the CLI would otherwise start a daemon and never exit, turning a
   * failing assertion into a hung suite.
   */
  const base = (): string[] => [join(root, "unused"), "--page-id", PAGE_ID, "--dry-run"];

  it("rejects an unknown --on-conflict mode instead of silently using merge", async () => {
    const { stdout, stderr, exitCode } = await runSyncCli([...base(), "--on-conflict", "bogus"]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/Unknown --on-conflict "bogus"/);
    expect(`${stdout}${stderr}`).toMatch(/merge, local, remote/);
  }, 30_000);

  it("rejects a non-numeric --poll-interval instead of setInterval(…, NaN)", async () => {
    const { stdout, stderr, exitCode } = await runSyncCli([...base(), "--poll-interval", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/Invalid --poll-interval "abc"/);
  }, 30_000);

  it("rejects an out-of-range --webhook-port", async () => {
    const { stdout, stderr, exitCode } = await runSyncCli([...base(), "--webhook-port", "99999"]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/Invalid --webhook-port "99999"/);
  }, 30_000);

  it("still accepts the documented values", async () => {
    const { stderr, exitCode } = await runSyncCli([
      ...base(),
      "--on-conflict",
      "remote",
      "--poll-interval",
      "5000",
      "--webhook-port",
      "8080",
    ]);
    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
  }, 30_000);
});

describe("wiki docs sync --help", () => {
  /**
   * `handleDocs` used to swallow `--help` for every subcommand, so `syncHelp()`
   * was unreachable and none of the sync-only flags — `--dry-run` among them —
   * could be discovered from the CLI, even though `docsHelp()` tells users to
   * run exactly this command.
   */
  it("prints the sync options rather than the docs overview", async () => {
    const { stdout, exitCode } = await runSyncCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("atlcli wiki docs sync <dir> [options]");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--on-conflict");
    expect(stdout).toContain("--poll-interval");
  }, 30_000);
});
