/** Explicit DOCSY-only live proof: bun --conditions=development scripts/vfs-delete-live.ts
 * Creates three synthetic pages, verifies recursive trash, always cleans each id.
 * Logs aggregate evidence only; no tenant content or credentials.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { ConfluenceClient } from "../packages/confluence/src/client.js";
import { getActiveProfile, loadConfig } from "../packages/core/src/index.js";
import { ConfluenceVfsImpl } from "../packages/confluence-vfs/src/confluence-vfs.js";

const profile = getActiveProfile(await loadConfig(), "mayflower");
assert(profile, "mayflower profile required");
const client = new ConfluenceClient(profile);
const created: string[] = [];
const deleted: string[] = [];
const nativeDelete = client.deletePage.bind(client);
client.deletePage = async (id: string) => { await nativeDelete(id); deleted.push(id); };
const cacheDir = mkdtempSync("/tmp/vfs-delete-live-");
const prefix = `vfs-delete-proof-${Date.now()}`;
let vfs: ConfluenceVfsImpl | undefined;
const missing = (error: unknown): boolean => /\b404\b/.test(String(error));
try {
  const home = await client.getSpaceHomepageId("DOCSY");
  assert(home);
  let parent = home;
  for (let i = 0; i < 2; i++) {
    const page = await client.createPage({ spaceKey: "DOCSY", parentId: parent, title: `${prefix}-${i}`, storage: "<p>Synthetic recursive delete fixture.</p>" });
    created.push(page.id);
    parent = page.id;
  }
  vfs = await ConfluenceVfsImpl.open({ profile: "mayflower", client, spaces: ["DOCSY"], mode: "rw", allowDelete: true, offline: false, cacheDir });
  const rootPath = `/DOCSY/${prefix}-0-${created[0]}`;
  await vfs.readdir(rootPath);
  await vfs.readdir(`${rootPath}/${prefix}-1-${created[1]}`);
  // Add a descendant after listing so deletion must refresh the cached tree.
  const grandchild = await client.createPage({ spaceKey: "DOCSY", parentId: parent, title: `${prefix}-2`, storage: "<p>Created after cached listing.</p>" });
  created.push(grandchild.id);
  const started = performance.now();
  await vfs.rm(rootPath, { recursive: true });
  assert.deepEqual(deleted, [...created].reverse(), "must trash grandchildren before child and root");
  for (const id of created) {
    await assert.rejects(() => client.getPageMetadata(id), missing, "deleted fixture must not remain current");
    assert.equal(vfs.index.knowsId(id), false);
  }
  console.log(JSON.stringify({ proof: "DOCSY recursive trash", pages: created.length, leafFirst: true, cachedTreeRefreshed: true, allCurrentMetadata404: true, ms: Math.round(performance.now() - started) }));
} finally {
  await vfs?.close();
  let cleanupFailures = 0;
  for (const id of [...created].reverse()) {
    try {
      await client.getPageMetadata(id);
      await nativeDelete(id);
    } catch (error) { if (!missing(error)) cleanupFailures++; }
  }
  rmSync(cacheDir, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanupChecked: created.length, cleanupFailures }));
  assert.equal(cleanupFailures, 0, "fixture cleanup incomplete");
}
