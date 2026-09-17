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
import { open, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { getActiveProfile, loadConfig, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { startNfsServer } from "../vfs/nfs-bridge.js";
import { nfsMountOptionsFor } from "../vfs/mount-transport.js";
import { NfsFilesystem } from "../vfs/nfs-filesystem.js";
import { NfsJournal } from "../vfs/nfs-journal.js";
import { NfsPublisher } from "../vfs/nfs-publisher.js";
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
  it.skipIf(!process.env.ATLCLI_NFS_TEST_HELPER || process.env.ATLCLI_NFS_KERNEL !== "1")("automatically publishes native NFS saves to Confluence", async () => {
    const page = await client.createPage({ spaceKey: E2E_SPACE_KEY,
      title: makeE2eTitle("nfs-auto"), storage: "<p>Native original</p>" });
    created.push(page.id);
    const journal = new NfsJournal(join(cacheDir, "native-auto.sqlite"), "live:DOCSY");
    const endpoint = await startNfsServer({ vfs, spaces: [E2E_SPACE_KEY], journal,
      helperPath: process.env.ATLCLI_NFS_TEST_HELPER! });
    const local = mkdtempSync(join(tmpdir(), "atlcli-live-nfs-"));
    let mounted = false;
    try {
      const path = await vfs.readlink(`/${E2E_SPACE_KEY}/.by-id/${page.id}.md`);
      const original = await vfs.readFile(path);
      const options = nfsMountOptionsFor(platform(), endpoint.port).replace(",ro,soft,", ",rw,hard,");
      const attach = platform() === "linux"
        ? ["sudo", "-n", "mount", "-t", "nfs", "-o", options, "127.0.0.1:/", local]
        : ["mount_nfs", "-o", options, "127.0.0.1:/", local];
      expect(await runMountCommand(attach)).toBe(0); mounted = true;
      const file = await open(join(local, ...path.split("/").slice(2)), "r+");
      try {
        const bytes = Buffer.from(original.replace("Native original", "Native automatically saved"));
        await file.truncate(0);
        await file.write(bytes, 0, bytes.length, 0);
        await file.sync();
      } finally { await file.close(); }
      const deadline = Date.now() + 15000;
      while (journal.pending().length && Date.now() < deadline) await Bun.sleep(50);
      expect(journal.pending()).toHaveLength(0);
      const actual = await client.getPage(page.id);
      expect(actual.version).toBe((page.version ?? 1) + 1);
      expect(actual.storage).toContain("Native automatically saved");
      const destination = join(local, ...path.split("/").slice(2));
      const temporaryPath = join(dirname(destination), ".editor-replacement.tmp");
      const replacementBytes = Buffer.from(original.replace("Native original", "Native atomic replacement 🐴"));
      const temporary = await open(temporaryPath, "wx", 0o600);
      const continued = Buffer.from("\nNative open-descriptor continuation\n");
      try {
        await temporary.write(replacementBytes); await temporary.sync();
        expect((await client.getPage(page.id)).version).toBe(actual.version);
        await rename(temporaryPath, destination);
        await temporary.write(continued); await temporary.sync();
      } finally { await temporary.close(); }
      expect(await readFile(destination)).toEqual(Buffer.concat([replacementBytes, continued]));
      const replacedDeadline = Date.now() + 15000;
      while (journal.pending().length && Date.now() < replacedDeadline) await Bun.sleep(50);
      expect(journal.pending()).toHaveLength(0);
      const replaced = await client.getPage(page.id);
      expect(replaced.id).toBe(page.id);
      expect(replaced.version).toBe((actual.version ?? 1) + 1);
      expect(replaced.storage).toContain("Native atomic replacement 🐴");
      expect(replaced.storage).toContain("Native open-descriptor continuation");
    } finally {
      if (mounted) {
        const detach = platform() === "linux" ? ["sudo", "-n", "umount", local] : ["umount", local];
        let status = await runMountCommand(detach);
        for (let attempt = 0; status !== 0 && attempt < 10; attempt++) {
          await Bun.sleep(100); status = await runMountCommand(detach);
        }
        if (status !== 0) throw new Error(`Test mount remains attached: ${local}`);
      }
      await endpoint.stop(); journal.close(); rmSync(local, { recursive: true, force: true });
      await client.deletePage(page.id); created.splice(created.indexOf(page.id), 1);
    }
  }, 30000);

  it("publishes a durable NFS journal image through the core", async () => {
    const page = await client.createPage({ spaceKey: E2E_SPACE_KEY,
      title: makeE2eTitle("nfs-journal"), storage: "<p>Journal original</p>" });
    created.push(page.id);
    const journal = new NfsJournal(join(cacheDir, "publication.sqlite"), "live:DOCSY");
    try {
      const path = await vfs.readlink(`/${E2E_SPACE_KEY}/.by-id/${page.id}.md`);
      const original = await vfs.readFile(path);
      const fs = new NfsFilesystem(vfs, [E2E_SPACE_KEY], undefined, journal);
      let handle = 1, parent = 1;
      for (const part of path.split("/").slice(2)) { parent = handle; handle = await fs.lookup(handle, part); }
      const edited = Buffer.from(original.replace("Journal original", "Journal saved"));
      await fs.truncate(handle, edited.length);
      await fs.write(handle, 0, edited);
      expect((await fs.getattr(handle)).size).toBe(edited.length);
      expect(Buffer.from((await fs.read(handle, 0, edited.length)).data, "base64")).toEqual(edited);
      const publisher = new NfsPublisher(journal, vfs, [E2E_SPACE_KEY]);
      expect((await publisher.publish(page.id))?.version).toBe((page.version ?? 1) + 1);
      const actual = await client.getPage(page.id);
      expect(actual.storage).toContain("Journal saved");
      expect(journal.pending()).toHaveLength(0);
      expect(await publisher.publish(page.id)).toBeNull();
      expect((await client.getPage(page.id)).version).toBe(actual.version);
      const next = Buffer.from(original.replace("Journal original", "Journal follow-up"));
      const temporary = await fs.create(parent, ".editor-save.tmp");
      expect(await fs.write(temporary, 0, next)).toBeNull();
      expect(journal.pending()).toHaveLength(0);
      expect(await fs.rename(parent, ".editor-save.tmp", parent, "_index.md")).toBe(page.id);
      expect(await fs.lookup(parent, "_index.md")).toBe(handle);
      expect((await publisher.publish(page.id))?.version).toBe((actual.version ?? 1) + 1);
      expect((await client.getPage(page.id)).storage).toContain("Journal follow-up");
    } finally {
      journal.close();
      await client.deletePage(page.id);
      created.splice(created.indexOf(page.id), 1);
    }
  }, 30000);

  it("coalesces rapid editor PUTs into one verified Confluence version", async () => {
    const page = await client.createPage({ spaceKey: E2E_SPACE_KEY,
      title: makeE2eTitle("vfs-debounce"), storage: "<p>Debounce original</p>" });
    created.push(page.id);
    const delayed = await ConfluenceVfsImpl.open({ profile: profile!.name, client,
      spaces: [E2E_SPACE_KEY], mode: "rw", allowDelete: false, offline: false,
      cacheDir: join(cacheDir, "debounce"), coalesceMs: 500 });
    let endpoint: RunningWebdavServer | undefined;
    try {
      endpoint = await startWebdavServer({ vfs: delayed, spaces: [E2E_SPACE_KEY] });
      const path = await delayed.readlink(`/${E2E_SPACE_KEY}/.by-id/${page.id}.md`);
      const original = await delayed.readFile(path);
      const target = new URL(path, endpoint.url);
      const first = fetch(target, { method: "PUT", body: original.replace("Debounce original", "Debounce intermediate") });
      await Bun.sleep(100);
      const second = fetch(target, { method: "PUT", body: original.replace("Debounce original", "Debounce latest") });
      const replies = await Promise.all([first, second]);
      for (const reply of replies) { expect([200, 204]).toContain(reply.status); await reply.text(); }
      const actual = await client.getPage(page.id);
      expect(actual.version).toBe((page.version ?? 1) + 1);
      expect(actual.storage).toContain("Debounce latest");
      expect(actual.storage).not.toContain("Debounce intermediate");
      // Replay the old editor image after dropping its merge base.
      delayed.cache!.forgetPage(page.id);
      const replay = await fetch(target, { method: "PUT", body: original.replace("Debounce original", "Debounce latest") });
      expect([200, 204]).toContain(replay.status);
      await replay.text();
      expect((await client.getPage(page.id)).version).toBe(actual.version);
    } finally {
      await endpoint?.stop();
      await delayed.close();
      await client.deletePage(page.id);
      created.splice(created.indexOf(page.id), 1);
    }
  }, 30000);

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
