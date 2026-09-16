/**
 * Live certification for `atlcli wiki mount` (WP7.9).
 *
 * Skipped unless `ATLCLI_WIKI_MOUNT_E2E=1`. Two levels, because they need
 * different machines:
 *
 *   ATLCLI_WIKI_MOUNT_E2E=1 bun run test apps/cli/src/e2e/wiki-mount-live.e2e.test.ts
 *     Drives the WebDAV server against a live tenant over HTTP. Runs anywhere.
 *
 *   ATLCLI_WIKI_MOUNT_E2E=1 ATLCLI_WIKI_MOUNT_KERNEL=1 ... (macOS only)
 *     Additionally attaches the volume with `mount_webdav` and works through
 *     the real kernel client — the Finder path the plan's section 6 is about.
 *
 * The kernel half cannot run in CI: a container has no `mount_webdav`, and
 * Linux `davfs2` needs root. That is a stated limitation of WP7.8, not an
 * oversight.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveProfile, loadConfig, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { startWebdavServer, type RunningWebdavServer } from "../vfs/webdav-server.js";
import { mountUrlFor, mountCommandFor, unmountCommandFor, runMountCommand } from "../commands/wiki-mount.js";
import { E2E_SPACE_KEY, makeE2eTitle } from "./resources.js";

const RUN = process.env.ATLCLI_WIKI_MOUNT_E2E === "1";
const KERNEL = RUN && process.env.ATLCLI_WIKI_MOUNT_KERNEL === "1" && platform() === "darwin";

let profile: Profile | undefined;
let client: ConfluenceClient;
let vfs: ConfluenceVfsImpl;
let server: RunningWebdavServer;
let cacheDir: string;
let mountpoint: string;
const created: string[] = [];

beforeAll(async () => {
  if (!RUN) return;
  const config = await loadConfig();
  profile = getActiveProfile(config, process.env.ATLCLI_E2E_PROFILE ?? "mayflower");
  if (!profile) throw new Error("No profile for the live wiki mount E2E run");
  client = new ConfluenceClient(profile);
  cacheDir = mkdtempSync(join(tmpdir(), "vfs-mount-e2e-"));
  mountpoint = mkdtempSync(join(tmpdir(), "vfs-mountpoint-"));

  vfs = await ConfluenceVfsImpl.open({
    profile: profile.name,
    client,
    spaces: [E2E_SPACE_KEY],
    mode: "rw",
    allowDelete: true,
    cacheDir,
    offline: false,
    coalesceMs: 0,
  });
  server = await startWebdavServer({ vfs, spaces: [E2E_SPACE_KEY] });

  if (KERNEL) {
    const attach = mountCommandFor("darwin", mountUrlFor(server.url, [E2E_SPACE_KEY]), mountpoint, "atlcli-e2e");
    if ("run" in attach) expect(await runMountCommand(attach.run)).toBe(0);
  }
});

afterAll(async () => {
  if (!RUN) return;
  if (KERNEL) {
    const detach = unmountCommandFor("darwin", mountpoint);
    if ("run" in detach) await runMountCommand(detach.run, true);
  }
  for (const id of created) {
    try {
      await client.deletePage(id);
    } catch (error) {
      console.warn(`[e2e] could not delete page ${id}: ${String(error)}`);
    }
  }
  await server?.stop();
  await vfs?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  if (mountpoint) rmSync(mountpoint, { recursive: true, force: true });
});

describe.skipIf(!RUN).serial("wiki mount against a live tenant", () => {
  it("lists the space over PROPFIND", async () => {
    const response = await fetch(new URL(`/${E2E_SPACE_KEY}`, server.url), {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    const body = await response.text();
    expect(response.status).toBe(207);
    expect(body).toContain("_index.md");
  });

  it("reads a page with an exact Content-Length", async () => {
    const listing = await fetch(new URL(`/${E2E_SPACE_KEY}`, server.url), {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    const body = await listing.text();
    const first = [...body.matchAll(/<D:href>[^<]*\/([^/<]+-\d+)\/<\/D:href>/g)][0]?.[1];
    expect(first).toBeDefined();

    const page = await fetch(new URL(`/${E2E_SPACE_KEY}/${first}/_index.md`, server.url));
    const text = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-length")).toBe(String(Buffer.byteLength(text, "utf8")));
  });

  it("creates and then trashes a page through PUT and DELETE", async () => {
    const title = makeE2eTitle("vfs-mount");
    const put = await fetch(new URL(`/${E2E_SPACE_KEY}/${title}.md`, server.url), {
      method: "PUT",
      body: `# ${title}\n\nCreated by the live mount E2E.\n`,
    });
    expect([200, 201, 204]).toContain(put.status);

    const listing = await fetch(new URL(`/${E2E_SPACE_KEY}`, server.url), {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    const body = await listing.text();
    const created_ = [...body.matchAll(new RegExp(`<D:href>[^<]*\\/(${title.toLowerCase()}-(\\d+))\\/<\\/D:href>`, "g"))][0];
    expect(created_).toBeDefined();
    created.push(created_![2]!);

    const del = await fetch(new URL(`/${E2E_SPACE_KEY}/${created_![1]}`, server.url), {
      method: "DELETE",
    });
    expect([200, 204]).toContain(del.status);
    created.splice(created.indexOf(created_![2]!), 1);
  });
});

describe.skipIf(!KERNEL).serial("wiki mount through the macOS kernel client", () => {
  it("creates and updates a page through native filesystem writes", async () => {
    const title = makeE2eTitle("vfs-kernel");
    await writeFile(join(mountpoint, `${title}.md`), "Kernel original\n");
    const entries = await vfs.readdir(`/${E2E_SPACE_KEY}`);
    const entry = entries.find((item) => item.name.startsWith(title.toLowerCase()));
    expect(entry).toBeDefined();
    const node = await vfs.resolve(`/${E2E_SPACE_KEY}/${entry!.name}`);
    created.push(node.id);
    const file = join(mountpoint, entry!.name, "_index.md");
    const body = await readFile(file, "utf8");
    expect(body).toContain("Kernel original");
    await writeFile(file, body.replace("Kernel original", "Kernel edited"));
    expect((await client.getPage(node.id)).storage).toContain("Kernel edited");
  });

  it("lists the volume through the real filesystem", async () => {
    const entries = await readdir(mountpoint);
    expect(entries).toContain("_index.md");
    expect(entries).not.toContain(E2E_SPACE_KEY);
  });

  it("reads a page through the real filesystem", async () => {
    const spaceDir = mountpoint;
    const first = (await readdir(spaceDir)).find((name) => /-\d+$/.test(name));
    expect(first).toBeDefined();
    const text = await readFile(join(spaceDir, first!, "_index.md"), "utf8");
    expect(text).toContain("atlcli:");
  });

  /**
   * The exclusion has to be *readable*, not merely absent-and-404: Spotlight
   * checks for the file, and a 404 is an invitation to index the volume.
   */
  it("exposes the Spotlight exclusion at the volume root", async () => {
    expect(await readdir(mountpoint)).toContain(".metadata_never_index");
    expect(await readFile(join(mountpoint, ".metadata_never_index"), "utf8")).toBe("");
  });
});
