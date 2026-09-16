/** macOS native mount, synthetic backend: bun --conditions=development scripts/vfs-mount-perf.ts */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { ConfluenceVfsImpl } from "../packages/confluence-vfs/src/confluence-vfs.js";
import { FakeConfluenceClient } from "../packages/confluence-vfs/src/testing/fake-client.js";
import { startWebdavServer } from "../apps/cli/src/vfs/webdav-server.js";
import { mountCommandFor, unmountCommandFor, runMountCommand } from "../apps/cli/src/commands/wiki-mount.js";

assert.equal(process.platform, "darwin", "requires native macOS WebDAV");
const client = new FakeConfluenceClient()
  .seedSpace({ id: "sp-1", key: "BIG", name: "Synthetic", homepageId: "1" })
  .seedPage({ id: "1", title: "Home", spaceKey: "BIG", storage: "<p>home</p>" });
for (let s = 0; s < 5; s++) {
  const parentId = String(10000 + s);
  client.seedPage({ id: parentId, title: `Section ${s}`, spaceKey: "BIG", parentId: "1", storage: "<p>section</p>" });
  for (let p = 0; p < 100; p++) client.seedPage({ id: `${parentId}${String(p).padStart(3, "0")}`, title: `Page ${p}`, spaceKey: "BIG", parentId, storage: "<p>syntheticneedle</p>" });
}
const cacheDir = mkdtempSync("/tmp/vfs-native-perf-cache-");
const mount = mkdtempSync("/tmp/vfs-native-perf-mount-");
const vfs = await ConfluenceVfsImpl.open({ profile: "synthetic", client, spaces: ["BIG"], mode: "ro", allowDelete: false, offline: false, cacheDir });
let server: Awaited<ReturnType<typeof startWebdavServer>> | undefined;
let mounted = false;
async function measure(name: string, command: string[]) {
  client.resetCalls();
  const started = performance.now();
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr);
  const result = { name, ms: Math.round(performance.now() - started), backendCalls: client.requestCount, bodyReads: client.callsTo("getPage") + client.callsTo("getPageAtVersion"), lines: stdout.trim().split("\n").length };
  console.log(JSON.stringify(result));
  return result;
}
try {
  server = await startWebdavServer({ vfs, spaces: ["BIG"] });
  const command = mountCommandFor("darwin", server.url, mount, "atlcli-synthetic-perf");
  assert("run" in command);
  assert.equal(await runMountCommand(command.run), 0);
  mounted = true;
  const walk = await measure("ls-R-500-pages", ["/bin/ls", "-R", `${mount}/BIG`]);
  assert.equal(walk.bodyReads, 506, "one exact body length per listed page/container");
  const listing = await measure("warm-ls-100-pages", ["/bin/ls", `${mount}/BIG/section-0-10000`]);
  assert(listing.ms < 1000, "warm directory listing exceeds one second");
  assert.equal(listing.bodyReads, 0);
  const grep = await measure("native-grep-100-pages", ["/usr/bin/grep", "-r", "--include=_index.md", "syntheticneedle", `${mount}/BIG/section-0-10000`]);
  assert.equal(grep.lines, 100);
  assert.equal(grep.bodyReads, 0, "the preceding recursive listing already cached exact bodies");
} finally {
  if (mounted) {
    const command = unmountCommandFor("darwin", mount);
    assert("run" in command);
    assert.equal(await runMountCommand(command.run, true), 0, "unmount failed; preserve mount/cache");
  }
  await server?.stop();
  await vfs.close();
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(mount, { recursive: true, force: true });
}
