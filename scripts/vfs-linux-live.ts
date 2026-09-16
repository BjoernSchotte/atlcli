/** DOCSY synthetic read/write proof: bun --conditions=development scripts/vfs-linux-live.ts
 * Requires Linux davfs2 and passwordless sudo for mount/umount. Always trashes its page.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { ConfluenceClient } from "../packages/confluence/src/client.js";
import { getActiveProfile, loadConfig } from "../packages/core/src/index.js";
import { ConfluenceVfsImpl } from "../packages/confluence-vfs/src/confluence-vfs.js";
import { startWebdavServer } from "../apps/cli/src/vfs/webdav-server.js";
import { mountUrlFor } from "../apps/cli/src/commands/wiki-mount.js";

assert.equal(process.platform, "linux");
const profile = getActiveProfile(await loadConfig(), "mayflower");
assert(profile);
const client = new ConfluenceClient(profile);
const cacheDir = mkdtempSync("/tmp/vfs-linux-live-cache-");
const mountpoint = mkdtempSync("/tmp/vfs-linux-live-mount-");
const title = `vfs-linux-proof-${Date.now()}`;
let pageId: string | undefined;
let vfs: ConfluenceVfsImpl | undefined;
let server: Awaited<ReturnType<typeof startWebdavServer>> | undefined;
let mounted = false;
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: new Blob(["\n\n"]), stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
}
try {
  const page = await client.createPage({ spaceKey: "DOCSY", parentId: (await client.getSpaceHomepageId("DOCSY"))!, title,
    storage: `<p>${"Synthetic Unicode ü read proof. ".repeat(1200)}END-OF-LARGE-PAGE</p>` });
  pageId = page.id;
  vfs = await ConfluenceVfsImpl.open({ profile: profile.name, client, spaces: ["DOCSY"], mode: "rw", allowDelete: false, offline: false, cacheDir, coalesceMs: 0 });
  server = await startWebdavServer({ vfs, spaces: ["DOCSY"] });
  const url = mountUrlFor(server.url, ["DOCSY"]);
  await command(["sudo", "-n", "mount", "-t", "davfs", "-o", `rw,uid=${process.getuid!()},gid=${process.getgid!()}`, url, mountpoint]);
  mounted = true;
  const relative = `${title}-${page.id}/_index.md`;
  const path = `${mountpoint}/${relative}`;
  // No direct GET or VFS body read before this cold native access.
  const size = (await stat(path)).size;
  const original = await readFile(path);
  assert(original.byteLength > 32768);
  assert.equal(size, original.byteLength);
  assert(original.toString().includes("END-OF-LARGE-PAGE"));
  const http = await fetch(new URL(relative, url));
  assert.equal(http.status, 200);
  assert.deepEqual(original, Buffer.from(await http.arrayBuffer()));
  const edited = original.toString().replace("END-OF-LARGE-PAGE", "END-OF-LARGE-PAGE-EDITED");
  await writeFile(path, edited);
  assert.equal(await readFile(path, "utf8"), edited);
  // Real Vim save, including its default backup strategy; no custom save workaround.
  await command(["vim", "-Nu", "NONE", "-n", "-es", "-c", "%s/END-OF-LARGE-PAGE-EDITED/END-OF-LARGE-PAGE-VIM-SAVED/", "-c", "wq", path]);
  // davfs2's FUSE inode attributes can lag an atomic editor save by one second.
  let afterVim = "";
  const refreshStarted = performance.now();
  for (let attempt = 0; attempt < 30; attempt++) {
    afterVim = await readFile(path, "utf8");
    if (afterVim.includes("END-OF-LARGE-PAGE-VIM-SAVED")) break;
    await Bun.sleep(100);
  }
  assert.equal(afterVim, edited.replace("END-OF-LARGE-PAGE-EDITED", "END-OF-LARGE-PAGE-VIM-SAVED"));
  const vimReadRefreshMs = Math.round(performance.now() - refreshStarted);
  // davfs2 buffers uploads; unmount waits for the write queue before API verification.
  await command(["sudo", "-n", "umount", mountpoint]);
  mounted = false;
  const saved = await client.getPage(page.id);
  assert(saved.storage.includes("END-OF-LARGE-PAGE-VIM-SAVED"));
  assert.equal((saved.storage.match(/Synthetic Unicode/g) ?? []).length, 1200);
  console.log(JSON.stringify({ coldNativeReadBytes: original.byteLength, statExact: true, httpEqual: true, nativeWriteApiVerified: true, vimSaveApiVerified: true, vimReadRefreshMs, preservedParagraphRepeats: 1200 }));
} finally {
  if (mounted) await command(["sudo", "-n", "umount", mountpoint]);
  await server?.stop();
  await vfs?.close();
  if (pageId) await client.deletePage(pageId);
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(mountpoint, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanedUp: true }));
}
