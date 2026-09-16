/** Explicit live proof: bun --conditions=development scripts/vfs-search-live.ts
 * Creates synthetic DOCSY pages, always trashes them; MAYFLOWER is GET-only.
 * Prints aggregate timings and counts, never tenant content or credentials.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { ConfluenceClient } from "../packages/confluence/src/client.js";
import { getActiveProfile, loadConfig } from "../packages/core/src/index.js";
import { ConfluenceVfsImpl } from "../packages/confluence-vfs/src/confluence-vfs.js";
import { createWikiShell } from "../apps/cli/src/vfs/wiki-shell.js";
import { planGrepCql } from "../apps/cli/src/vfs/grep-cql.js";
import { parseGrepArgs } from "../apps/cli/src/vfs/grep-flags.js";

const profile = getActiveProfile(await loadConfig(), "mayflower");
assert(profile, "mayflower profile required");
const created: string[] = [];
const prefix = `vfs-search-proof-${Date.now()}`;
let requests = 0;
let bodies = 0;
let bytes = 0;
const nativeFetch = globalThis.fetch;
let readOnlyPhase = false;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (readOnlyPhase && method !== "GET") throw new Error("MAYFLOWER GET-only guard");
  requests++;
  return nativeFetch(input, init);
}, nativeFetch);
const client = new ConfluenceClient(profile);
const getPage = client.getPage.bind(client);
client.getPage = async (...args) => { const page = await getPage(...args); bodies++; bytes += Buffer.byteLength(page.storage); return page; };
const getBulk = client.getPagesBulk.bind(client);
client.getPagesBulk = async (...args) => { const pages = await getBulk(...args); bodies += pages.length; bytes += pages.reduce((n, page) => n + Buffer.byteLength(page.storage), 0); return pages; };
const cacheDir = mkdtempSync("/tmp/vfs-search-live-");
let clock = Date.now();
let vfs: ConfluenceVfsImpl | undefined;
async function measure(name: string, task: () => Promise<void>): Promise<void> {
  const start = performance.now(), r = requests, b = bodies, size = bytes;
  await task();
  console.log(JSON.stringify({ name, ms: Math.round(performance.now() - start), requests: requests-r, bodies: bodies-b, storageBytes: bytes-size }));
}
try {
  const homepage = await client.getSpaceHomepageId("DOCSY");
  assert(homepage);
  const parent = await client.createPage({ spaceKey: "DOCSY", title: prefix, parentId: homepage, storage: "<p>Synthetic search fixture root.</p>" });
  created.push(parent.id);
  for (let i = 0; i < 4; i++) {
    const page = await client.createPage({ spaceKey: "DOCSY", title: `${prefix}-child-${i}`, parentId: parent.id,
      storage: i === 3 ? "<p>Retrospektive craftsmanship prefix.zqxmarker.suffix</p>" : "<p>Synthetic neutral content.</p>" });
    created.push(page.id);
  }
  const target = `/DOCSY/${prefix}-${parent.id}`;
  vfs = await ConfluenceVfsImpl.open({ profile: "mayflower", client, spaces: ["DOCSY"], mode: "ro", allowDelete: false, offline: false, cacheDir, now: () => clock });
  const shell = await createWikiShell({ vfs, spaces: ["DOCSY"], prefetchMax: 10, cqlGrep: false });
  await measure("DOCSY cold exact", async () => {
    const b = bodies; const result = await shell.exec(`grep -rni craftsmanship ${target}`);
    assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /Retrospektive craftsmanship/); assert.equal(bodies-b, 5);
  });
  await measure("DOCSY warm exact", async () => {
    const b = bodies, r = requests; const result = await shell.exec(`grep -rnw zqxmarker ${target}`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(bodies, b); assert.equal(requests, r);
  });
  await measure("DOCSY warm quiet", async () => {
    const b = bodies, r = requests; assert.equal((await shell.exec(`grep -rqi retrospektive ${target}`)).exitCode, 0);
    assert.equal(bodies, b); assert.equal(requests, r);
  });
  const changedId = created[1]!;
  const current = await getPage(changedId);
  await client.updatePage({ id: changedId, title: current.title, version: current.version! + 1, storage: "<p>zqxfreshmarker after remote edit</p>" });
  clock += 61_000;
  await measure("DOCSY changed exact", async () => {
    const b = bodies; const result = await shell.exec(`grep -rl zqxfreshmarker ${target}`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(bodies-b, 1);
  });
  await vfs.close(); vfs = undefined;
  rmSync(cacheDir, { recursive: true, force: true });
  vfs = await ConfluenceVfsImpl.open({ profile: "mayflower", client, spaces: ["DOCSY"], mode: "ro", allowDelete: false, offline: false, cacheDir });
  const freshShell = await createWikiShell({ vfs, spaces: ["DOCSY"], prefetchMax: 1 });
  await measure("DOCSY by-id metadata within zero budget", async () => {
    const b = bodies;
    const zeroBudget = await createWikiShell({ vfs: vfs!, spaces: ["DOCSY"], prefetchMax: 0 });
    const result = await zeroBudget.exec(`grep -r neutral /DOCSY/.by-id/${created[2]}.md`);
    assert.equal(result.exitCode, 2); assert.equal(bodies, b);
  });
  await measure("DOCSY by-id exact one body", async () => {
    const b = bodies; const result = await freshShell.exec(`grep -r neutral /DOCSY/.by-id/${created[2]}.md`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(bodies-b, 1);
  });
  await measure("DOCSY excluded before download", async () => {
    const b = bodies; assert.equal((await freshShell.exec(`grep -r --include '*.txt' craftsmanship ${target}`)).exitCode, 1); assert.equal(bodies,b);
  });
  await measure("DOCSY budget before download", async () => {
    const b = bodies; const result = await freshShell.exec(`grep --no-cql -r craftsmanship ${target}`);
    assert.equal(result.exitCode, 2); assert.match(result.stderr, /prefetch limit/); assert.equal(bodies,b);
  });
  // Wait only for our synthetic fixture to become visible in the search index.
  const plan = planGrepCql(parseGrepArgs(["-rqi", "retrospektive", target]));
  assert("query" in plan);
  let indexed = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await freshShell.exec(`cql --json --limit 1000 '(${plan.query}) AND ((id = ${parent.id} OR ancestor = ${parent.id}))'`);
    assert.equal(result.exitCode, 0, result.stderr);
    if (JSON.parse(result.stdout).results.some((row: { id: string }) => row.id === created[4])) { indexed = true; break; }
    console.log(JSON.stringify({ waitingForSyntheticIndex: attempt + 1 }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(indexed, "Synthetic fixture did not become indexed within 30 seconds");
  await measure("DOCSY CQL-prioritized quiet subtree", async () => {
    const b = bodies; const result = await freshShell.exec(`grep -rqi retrospektive ${target}`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(bodies-b,1);
  });
  // Explicit body scope proves exact quiet matching even before CQL indexes writes.
  await measure("DOCSY cold quiet one file", async () => {
    const b = bodies; const result = await freshShell.exec(`grep -rq zqxfreshmarker ${target}/${prefix}-child-0-${created[1]}/_index.md`);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(bodies-b,1);
  });
} finally {
  await vfs?.close();
  const cleanupErrors: unknown[] = [];
  for (const id of created.reverse()) {
    try { await client.deletePage(id); } catch (error) { cleanupErrors.push(error); }
  }
  rmSync(cacheDir, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "DOCSY fixture cleanup failed");
  console.log(JSON.stringify({ cleanup: "DOCSY synthetic fixtures trashed", pages: created.length }));
}

const readonlyDir = mkdtempSync("/tmp/vfs-search-readonly-");
requests = bodies = bytes = 0;
readOnlyPhase = true;
const readonlyClient = new ConfluenceClient(profile, {
  guardTransport(event) { if (event.type === "attempt" && event.method !== "GET") throw new Error("MAYFLOWER read-only guard"); },
});
readonlyClient.getPage = async () => { throw new Error("Excerpt search must not fetch bodies"); };
readonlyClient.getPagesBulk = async () => { throw new Error("Excerpt search must not fetch bodies"); };
const readonlyVfs = await ConfluenceVfsImpl.open({ profile: "mayflower", client: readonlyClient, spaces: ["mayflower"], mode: "ro", allowDelete: false, offline: false, cacheDir: readonlyDir });
try {
  const shell = await createWikiShell({ vfs: readonlyVfs, spaces: ["mayflower"] });
  for (const term of ["retrospektive", "craftsmanship"]) {
    await measure(`MAYFLOWER indexed ${term}`, async () => {
      const result = await shell.exec(`cql --json --limit 5 'text ~ "${term}"'`);
      assert.equal(result.exitCode, 0, result.stderr);
      const rows = JSON.parse(result.stdout);
      assert.equal(rows.source, "confluence-index"); assert(rows.results.length <= 5);
      assert(rows.results.every((row: { spaceKey: string }) => row.spaceKey === "mayflower"));
      assert.equal(readonlyVfs.cache!.stats().bodies, 0);
      console.log(JSON.stringify({ indexedRows: rows.results.length, truncated: rows.truncated, excerpts: rows.results.filter((row: { excerpt: string }) => !!row.excerpt).length }));
    });
  }
} finally { await readonlyVfs.close(); rmSync(readonlyDir, { recursive: true, force: true }); }
