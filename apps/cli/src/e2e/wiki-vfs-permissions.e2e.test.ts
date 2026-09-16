/**
 * Live permission isolation (WP9.2).
 *
 * Skipped unless `ATLCLI_VFS_PERMISSIONS_E2E=1` **and** two profiles are named,
 * because it needs two identities against the same tenant:
 *
 *   ATLCLI_VFS_PERMISSIONS_E2E=1 \
 *   ATLCLI_E2E_PROFILE_A=mayflower ATLCLI_E2E_PROFILE_B=restricted \
 *   bun run test apps/cli/src/e2e/wiki-vfs-permissions.e2e.test.ts
 *
 * The claim under test is the one the whole design leans on: **the VFS has no
 * access-control logic of its own, because Confluence enforces visibility
 * server-side per caller.** That is only safe if two things hold against a real
 * tenant:
 *
 *  1. A page restricted away from B is `ENOENT` for B — in listings, by direct
 *     path, and by id — while A sees it normally.
 *  2. A's cache gives B nothing, because the databases are separate files.
 *
 * The second is unit-tested against the fake (`security.test.ts`); this proves
 * the first, which no fake can.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveProfile, loadConfig, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { E2E_SPACE_KEY, makeE2eTitle } from "./resources.js";

const RUN =
  process.env.ATLCLI_VFS_PERMISSIONS_E2E === "1" &&
  !!process.env.ATLCLI_E2E_PROFILE_A &&
  !!process.env.ATLCLI_E2E_PROFILE_B;

let profileA: Profile;
let profileB: Profile;
let clientA: ConfluenceClient;
/** One cache directory for both, which is the point: they must still not mix. */
let sharedCacheDir: string;
let restrictedPageId: string | undefined;
let restrictedName: string | undefined;

beforeAll(async () => {
  if (!RUN) return;
  const config = await loadConfig();
  const a = getActiveProfile(config, process.env.ATLCLI_E2E_PROFILE_A);
  const b = getActiveProfile(config, process.env.ATLCLI_E2E_PROFILE_B);
  if (!a || !b) throw new Error("Both ATLCLI_E2E_PROFILE_A and _B must name real profiles");
  profileA = a;
  profileB = b;
  clientA = new ConfluenceClient(profileA);
  sharedCacheDir = mkdtempSync(join(tmpdir(), "vfs-perm-e2e-"));

  const title = makeE2eTitle("vfs-restricted");
  const homepageId = await clientA.getSpaceHomepageId(E2E_SPACE_KEY);
  const created = await clientA.createPage({
    spaceKey: E2E_SPACE_KEY,
    title,
    storage: "<p>Only profile A may read this.</p>",
    ...(homepageId ? { parentId: homepageId } : {}),
  });
  restrictedPageId = created.id;
  restrictedName = title.toLowerCase();

  // Restrict reading to A alone. B is then in exactly the position a
  // restricted colleague is in.
  const me = await clientA.getCurrentUser();
  await clientA.setContentRestrictions(created.id, { read: { accountIds: [me.accountId] } });
});

afterAll(async () => {
  if (!RUN) return;
  if (restrictedPageId) {
    try {
      await clientA.deletePage(restrictedPageId);
    } catch (error) {
      console.warn(`[e2e] could not delete page ${restrictedPageId}: ${String(error)}`);
    }
  }
  if (sharedCacheDir) rmSync(sharedCacheDir, { recursive: true, force: true });
});

async function open(profile: Profile): Promise<ConfluenceVfsImpl> {
  return ConfluenceVfsImpl.open({
    profile: profile.name,
    client: new ConfluenceClient(profile),
    spaces: [E2E_SPACE_KEY],
    mode: "ro",
    allowDelete: false,
    cacheDir: sharedCacheDir,
    offline: false,
  });
}

describe.skipIf(!RUN).serial("permission isolation against a live tenant", () => {
  it("profile A sees the restricted page and reads it", async () => {
    const vfs = await open(profileA);
    try {
      const names = (await vfs.readdir(`/${E2E_SPACE_KEY}`)).map((entry) => entry.name);
      const entry = names.find((name) => name.startsWith(restrictedName!));
      expect(entry).toBeDefined();
      expect(await vfs.readFile(`/${E2E_SPACE_KEY}/${entry}/_index.md`)).toContain(
        "Only profile A may read this.",
      );
    } finally {
      await vfs.close();
    }
  });

  it("profile B gets ENOENT everywhere, and never EACCES", async () => {
    const vfs = await open(profileB);
    try {
      const names = (await vfs.readdir(`/${E2E_SPACE_KEY}`)).map((entry) => entry.name);
      expect(names.find((name) => name.startsWith(restrictedName!))).toBeUndefined();

      // By id, which is the route that would leak existence if the VFS mapped
      // a 403 to EACCES.
      await expect(
        vfs.stat(`/${E2E_SPACE_KEY}/.by-id/${restrictedPageId}.md`),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        vfs.readFile(`/${E2E_SPACE_KEY}/.by-id/${restrictedPageId}.md`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await vfs.close();
    }
  });

  it("gives B nothing from A's cache, though both use one cache directory", async () => {
    const a = await open(profileA);
    const names = (await a.readdir(`/${E2E_SPACE_KEY}`)).map((entry) => entry.name);
    const entry = names.find((name) => name.startsWith(restrictedName!))!;
    await a.readFile(`/${E2E_SPACE_KEY}/${entry}/_index.md`);
    const aDb = a.runtime!.dbPath;
    await a.close();

    const b = await open(profileB);
    try {
      expect(b.runtime!.dbPath).not.toBe(aDb);
      expect(b.cache!.getBody(restrictedPageId!, 1)).toBeUndefined();
      await expect(
        vfsReadById(b, restrictedPageId!),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await b.close();
    }
  });
});

function vfsReadById(vfs: ConfluenceVfsImpl, pageId: string): Promise<string> {
  return vfs.readFile(`/${E2E_SPACE_KEY}/.by-id/${pageId}.md`);
}
