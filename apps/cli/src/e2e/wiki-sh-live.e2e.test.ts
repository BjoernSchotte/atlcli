/**
 * Live certification for `atlcli wiki sh` (WP6.9).
 *
 * Skipped unless `ATLCLI_WIKI_SH_E2E=1`, because it creates and deletes real
 * Confluence content:
 *
 *   ATLCLI_WIKI_SH_E2E=1 bun run test apps/cli/src/e2e/wiki-sh-live.e2e.test.ts
 *
 * What it certifies that the fake cannot: that the *real* REST surface the VFS
 * depends on behaves as the core assumes — direct-children ordering, the
 * version-plus-one update contract, the search index, and the trash. Every page
 * it creates is named and marked per spec 011 and removed in a `finally`, so a
 * crashed run leaves only what the nightly sweeper is built to recover.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveProfile, loadConfig, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { createWikiShell, type WikiShell } from "../vfs/wiki-shell.js";
import { E2E_SPACE_KEY, makeE2eTitle } from "./resources.js";

const RUN = process.env.ATLCLI_WIKI_SH_E2E === "1";

let profile: Profile | undefined;
let client: ConfluenceClient;
let cacheDir: string;
/** Pages this run created, deleted in afterAll whatever happened. */
const created: string[] = [];

async function openShell(
  options: { mode: "ro" | "rw"; allowDelete?: boolean } = { mode: "ro" },
): Promise<{ shell: WikiShell; vfs: ConfluenceVfsImpl }> {
  const vfs = await ConfluenceVfsImpl.open({
    profile: profile!.name,
    client,
    spaces: [E2E_SPACE_KEY],
    mode: options.mode,
    allowDelete: options.allowDelete ?? false,
    cacheDir,
    offline: false,
    coalesceMs: 0,
  });
  const shell = await createWikiShell({ vfs, spaces: [E2E_SPACE_KEY] });
  return { shell, vfs };
}

beforeAll(async () => {
  if (!RUN) return;
  const config = await loadConfig();
  profile = getActiveProfile(config, process.env.ATLCLI_E2E_PROFILE ?? "mayflower");
  if (!profile) throw new Error("No profile for the live wiki sh E2E run");
  client = new ConfluenceClient(profile);
  cacheDir = mkdtempSync(join(tmpdir(), "vfs-e2e-"));
});

afterAll(async () => {
  if (!RUN) return;
  for (const id of created) {
    try {
      await client.deletePage(id);
    } catch (error) {
      console.warn(`[e2e] could not delete page ${id}: ${String(error)}`);
    }
  }
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe.skipIf(!RUN).serial("wiki sh against a live tenant", () => {
  it("lists the space without fetching a body", async () => {
    const { shell, vfs } = await openShell();
    try {
      const result = await shell.exec("ls");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      // Nothing was read, so nothing should be cached.
      expect(vfs.cache!.stats().bodies).toBe(0);
    } finally {
      await vfs.close();
    }
  });

  it("reads a page and caches it", async () => {
    const { shell, vfs } = await openShell();
    try {
      const listing = await shell.exec("ls");
      const first = listing.stdout.split("\n").find((name) => /-\d+$/.test(name.trim()));
      expect(first).toBeDefined();
      const result = await shell.exec(`cat '${first!.trim()}/_index.md'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("atlcli:");
      expect(vfs.cache!.stats().bodies).toBeGreaterThan(0);
    } finally {
      await vfs.close();
    }
  });

  it("runs grep and find over real content", async () => {
    const { shell, vfs } = await openShell();
    try {
      const grep = await shell.exec("grep -rlw the . | head -5");
      // Exit 0 with matches or 1 without; anything else is a failure.
      expect([0, 1]).toContain(grep.exitCode);

      const find = await shell.exec("find . -name '*-*' -type d | head -5");
      expect(find.exitCode).toBe(0);
    } finally {
      await vfs.close();
    }
  });

  it("refuses to write in the default mode", async () => {
    const { shell, vfs } = await openShell();
    try {
      const result = await shell.exec("echo x > vfs-e2e-should-not-exist.md");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("EROFS");
    } finally {
      await vfs.close();
    }
  });

  it("creates, edits, renames, moves and trashes a page", async () => {
    const { shell, vfs } = await openShell({ mode: "rw", allowDelete: true });
    const title = makeE2eTitle("vfs-sh");
    try {
      const create = await shell.exec(`echo '# ${title}' > '${title}.md'`);
      expect(create.exitCode).toBe(0);

      const listing = await shell.exec(`ls | grep -F '${title.toLowerCase()}'`);
      const entry = listing.stdout.trim().split("\n")[0]!;
      expect(entry).toBeTruthy();
      const pageId = (await shell.exec(`page-id '${entry}'`)).stdout.trim();
      expect(pageId).toMatch(/^\d+$/);
      created.push(pageId);

      const edit = await shell.exec(`sed -i 's/${title}/${title} edited/' '${entry}/_index.md'`);
      expect(edit.exitCode).toBe(0);
      expect((await shell.exec(`cat '${entry}/_index.md'`)).stdout).toContain("edited");

      const renamed = `${title}-renamed`;
      const rename = await shell.exec(`mv '${entry}' '${renamed}-${pageId}'`);
      expect(rename.exitCode).toBe(0);

      const remove = await shell.exec(`rm -r '${renamed}-${pageId}'`);
      expect(remove.exitCode).toBe(0);
      // Trashed, so it is gone from the listing.
      expect((await shell.exec(`ls | grep -F '${pageId}'`)).exitCode).toBe(1);
    } finally {
      await vfs.close();
    }
  });
});
