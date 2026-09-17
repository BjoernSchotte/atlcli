import { expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { startWebdavServer } from "./webdav-server.js";
import { mountUrlFor, runMountCommand } from "../commands/wiki-mount.js";

for (const backup of [false, true]) it.skipIf(process.env.ATLCLI_WEBDAV_KERNEL !== "1")(`creates and repeatedly saves plain Markdown with native Vim over WebDAV (backup=${backup})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlcli-dav-editor-"));
  const mountpoint = join(root, "mount"); mkdirSync(mountpoint);
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Home</p>" });
  const vfs = await ConfluenceVfsImpl.open({ profile: "synthetic", client, spaces: ["DOCSY"],
    mode: "rw", allowDelete: true, cacheDir: join(root, "core"), offline: false, coalesceMs: 0 });
  const server = await startWebdavServer({ vfs, spaces: ["DOCSY"] });
  let mounted = false;
  try {
    const url = mountUrlFor(server.url, ["DOCSY"]);
    let command = ["mount_webdav", "-S", url, mountpoint];
    if (platform() === "linux") {
      const config = join(root, "davfs.conf"), cache = join(root, "davfs-cache"); mkdirSync(cache);
      chmodSync(root, 0o755);
      // Synthetic data only: the system davfs daemon needs cache access.
      chmodSync(cache, 0o777);
      writeFileSync(config, `ask_auth 0\ndelay_upload 0\ncache_dir ${cache}\n`);
      command = ["sudo", "-n", "mount", "-t", "davfs", "-o",
        `rw,uid=${process.getuid!()},gid=${process.getgid!()},conf=${config}`, url, mountpoint];
    }
    expect(await runMountCommand(command)).toBe(0); mounted = true;
    const path = join(mountpoint, "newpage.md");
    let pageId: string | undefined;
    for (const text of ["First plain page 🐴", "Second plain page 🐴", "Third plain page 🐴"]) {
      await promisify(execFile)("vim", ["-Nu", "NONE", "-i", "NONE", "-n", "-es", path,
        "-c", `set nomodeline ${backup ? "backupskip= backupdir=. backup writebackup backupcopy=no" : "nobackup nowritebackup"}`, "-c", `call setline(1, '${text}')`, "-c", "wq"], { timeout: 15000 });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try { pageId = (await vfs.resolve("/DOCSY/newpage.md")).id; } catch { /* davfs may still upload after close */ }
        if (pageId && client.peekPage(pageId)?.storage.includes(text)) break;
        await Bun.sleep(50);
      }
      expect(pageId).toBeDefined();
      expect(client.peekPage(pageId!)?.storage).toContain(text);
      let readback = await readFile(path, "utf8");
      const readDeadline = Date.now() + 10000;
      while (!readback.includes(text) && Date.now() < readDeadline) { await Bun.sleep(100); readback = await readFile(path, "utf8"); }
      expect(readback).toContain(text);
      expect(client.callsTo("createPage")).toBe(1);
    }
  } finally {
    if (mounted) {
      const command = platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint];
      const status = await runMountCommand(command);
      if (status !== 0) throw new Error(`Test mount remains attached: ${mountpoint}`);
    }
    await server.stop(); await vfs.close();
    if (platform() === "linux") {
      expect(await runMountCommand(["sudo", "-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, join(root, "davfs-cache")])).toBe(0);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
