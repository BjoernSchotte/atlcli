import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { NfsJournal } from "./nfs-journal.js";
import { NfsFilesystem, NFS_MAX_READ, NFS_MAX_HANDLES } from "./nfs-filesystem.js";
import { INDEXER_SHIELDS, SHIELD_DIRECTORIES, SweepDetector } from "./mount-client-probes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(spaces = ["DOCSY"], mode: "ro" | "rw" = "ro", treeTtlMs?: number, staging = false) {
  const cacheDir = mkdtempSync(join(tmpdir(), "nfs-core-"));
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Grüße 🐴</p>" })
    .seedSpace({ id: "s2", key: "mayflower", name: "Other", homepageId: "300" })
    .seedPage({ id: "300", title: "Other Home", spaceKey: "mayflower", storage: "<p>Other</p>" });
  for (let i = 0; i < 4; i++) client.seedPage({ id: String(200 + i), title: `Child ${i}`,
    spaceKey: "DOCSY", parentId: "100", storage: `<p>Body ${i}</p>` });
  const vfs = await ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY", "mayflower"],
    mode, allowDelete: mode === "rw", coalesceMs: 0, cacheDir, offline: false, treeTtlMs });
  const journal = staging ? new NfsJournal(join(cacheDir, "journal.sqlite"), "fixture:DOCSY") : undefined;
  cleanup.push(async () => { await vfs.close(); journal?.close(); rmSync(cacheDir, { recursive: true, force: true }); });
  return { fs: new NfsFilesystem(vfs, spaces, undefined, journal), vfs, client, journal };
}

it("exports a single space directly and confines parent lookups", async () => {
  const { fs } = await fixture();
  expect(await fs.lookup(1, "..")).toBe(1);
  expect(await fs.lookup(1, ".")).toBe(1);
  for (const name of ["../mayflower", "", "a/b", "a\0b", "x".repeat(256)]) {
    await expect(fs.lookup(1, name)).rejects.toThrow();
  }
  const entries = await fs.readdir(1, 0, 256);
  expect(entries.entries.some((e) => e.name === "_index.md")).toBe(true);
  expect(entries.entries.some((e) => e.name === "DOCSY" || e.name === "mayflower")).toBe(false);
});

it("keeps selected space directories for multi-space exports", async () => {
  const { fs } = await fixture(["DOCSY", "mayflower"]);
  expect((await fs.readdir(1, 0, 256)).entries.map((e) => e.name)).toEqual(
    [...INDEXER_SHIELDS, ...SHIELD_DIRECTORIES, "DOCSY", "mayflower"].sort());
  expect(await fs.lookup(await fs.lookup(1, "DOCSY"), "..")).toBe(1);
});

it("bounds directory lookup fan-out while retaining every paginated entry", async () => {
  const { fs, client } = await fixture();
  for (let i = 0; i < 100; i++) client.seedPage({ id: String(1000 + i), title: `Large ${i}`,
    spaceKey: "DOCSY", parentId: "100", storage: "<p>Large</p>" });
  const lookup = fs.lookup.bind(fs);
  let active = 0, peak = 0;
  fs.lookup = async (...args) => {
    active++; peak = Math.max(peak, active);
    try { await Bun.sleep(1); return await lookup(...args); }
    finally { active--; }
  };
  const names: string[] = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const result = await fs.readdir(1, after, 17);
    names.push(...result.entries.map(entry => entry.name));
    if (result.end) break;
    after = result.entries.at(-1)!.attr.id;
  }
  expect(peak).toBeLessThanOrEqual(32);
  expect(active).toBe(0);
  expect(new Set(names).size).toBe(names.length);
  for (let i = 0; i < 100; i++) expect(names).toContain(`large-${i}-${1000 + i}`);

  let calls = 0;
  fs.lookup = async (...args) => {
    const first = calls++ === 0;
    active++;
    try {
      if (first) throw Object.assign(new Error("Temporary lookup failure"), { code: "EAGAIN" });
      await Bun.sleep(5);
      return await lookup(...args);
    } finally { active--; }
  };
  await expect(fs.readdir(1, 0, 17)).rejects.toMatchObject({ code: "EAGAIN" });
  expect(calls).toBe(32);
  expect(active).toBe(0);
});

for (const spaces of [["DOCSY"], ["DOCSY", "mayflower"]]) {
  it(`serves empty volume shields without backend requests (${spaces.join(",")})`, async () => {
    const { fs, client } = await fixture(spaces);
    client.resetCalls();
    for (const name of INDEXER_SHIELDS) {
      const id = await fs.lookup(1, name);
      expect(await fs.lookup(1, name)).toBe(id);
      expect(await fs.getattr(id)).toMatchObject({ id, directory: false, size: 0 });
      expect(await fs.read(id, 0, 1024)).toEqual({ data: "", eof: true });
      await expect(fs.readdir(id, 0, 1)).rejects.toMatchObject({ code: "ENOTDIR" });
    }
    const directory = await fs.lookup(1, ".fseventsd");
    expect((await fs.getattr(directory)).directory).toBe(true);
    expect(await fs.readdir(directory, 0, 1)).toEqual({ entries: [], end: true });
    expect(await fs.lookup(directory, "..")).toBe(1);
    expect(await fs.lookup(directory, ".")).toBe(directory);
    await expect(fs.lookup(directory, "absent")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.read(directory, 0, 1)).rejects.toMatchObject({ code: "EISDIR" });
    for (const name of [".DS_Store", "._index.md", ".Spotlight-V100", "desktop.ini", "Thumbs.db"]) {
      await expect(fs.lookup(1, name)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(client.requestCount).toBe(0);
    const names = (await fs.readdir(1, 0, 256)).entries.map(entry => entry.name);
    for (const name of [...INDEXER_SHIELDS, ...SHIELD_DIRECTORIES]) expect(names).toContain(name);
  });
}

it("reports exact cold byte size and reads split UTF-8 ranges through EOF", async () => {
  const { fs, vfs } = await fixture();
  const id = await fs.lookup(1, "_index.md");
  const attr = await fs.getattr(id);
  const expected = Buffer.from(await vfs.readFileBytes("/DOCSY/_index.md"));
  expect(attr.size).toBe(expected.byteLength);
  expect(attr.directory).toBe(false);
  const bytes: Buffer[] = [];
  for (let offset = 0; offset < expected.length; offset++) {
    const result = await fs.read(id, offset, 1);
    bytes.push(Buffer.from(result.data, "base64"));
    expect(result.eof).toBe(offset + 1 === expected.length);
  }
  expect(Buffer.concat(bytes)).toEqual(expected);
  expect(await fs.read(id, expected.length + 100, 10)).toEqual({ data: "", eof: true });
  await expect(fs.read(id, -1, 1)).rejects.toThrow();
  await expect(fs.read(id, 0, NFS_MAX_READ + 1)).rejects.toThrow();
  await expect(fs.read(1, 0, 1)).rejects.toThrow();
});

it("reports the timestamp of the body fetched after older metadata was listed", async () => {
  const { fs, vfs, client } = await fixture();
  const page = await fs.lookup(1, "child-0-200");
  const body = await fs.lookup(page, "_index.md");
  const old = await vfs.stat("/DOCSY/child-0-200/_index.md");
  client.bumpVersion("200", "<p>New external content 🐴</p>");
  const latest = (await client.getPageVersions(["200"])).get("200")!;
  expect(Date.parse(latest.lastModified!)).not.toBe(old.mtime.getTime());
  const attr = await fs.getattr(body);
  expect(attr.mtime).toBe(Date.parse(latest.lastModified!));
  expect(attr.size).toBe((await vfs.readFileBytes("/DOCSY/child-0-200/_index.md")).byteLength);
});

it("does not take a newer index timestamp for an already materialized body", async () => {
  const { fs, vfs } = await fixture();
  const body = await fs.lookup(await fs.lookup(1, "child-0-200"), "_index.md");
  const before = await vfs.stat("/DOCSY/child-0-200/_index.md");
  const read = vfs.readFileBytes.bind(vfs);
  vfs.readFileBytes = async path => {
    const bytes = await read(path);
    vfs.index.upsert({ id: "200", version: 2, lastModified: "2026-09-18T00:00:00Z" });
    return bytes;
  };
  expect((await fs.getattr(body)).mtime).toBe(before.mtime.getTime());
  expect((await vfs.stat("/DOCSY/child-0-200/_index.md")).mtime.getTime()).toBe(Date.parse("2026-09-18T00:00:00Z"));
});

it("paginates without duplicates and rejects unknown cursors/handles", async () => {
  const { fs } = await fixture();
  const all = await fs.readdir(1, 0, 256);
  const names: string[] = [];
  let after = 0;
  for (;;) {
    const page = await fs.readdir(1, after, 2);
    names.push(...page.entries.map((e) => e.name));
    if (page.end) break;
    after = page.entries.at(-1)!.attr.id;
  }
  expect(names).toEqual(all.entries.map((e) => e.name));
  await expect(fs.readdir(1, 999999, 2)).rejects.toThrow("cursor");
  await expect(fs.getattr(999999)).rejects.toThrow("handle");
});

it("does not alias generated files from different spaces", async () => {
  const { fs } = await fixture(["DOCSY", "mayflower"]);
  const first = await fs.lookup(await fs.lookup(1, "DOCSY"), "_space.json");
  const second = await fs.lookup(await fs.lookup(1, "mayflower"), "_space.json");
  expect(first).not.toBe(second);
  expect(Buffer.from((await fs.read(first, 0, 65536)).data, "base64").toString()).toContain("DOCSY");
  expect(Buffer.from((await fs.read(second, 0, 65536)).data, "base64").toString()).toContain("mayflower");
});

it("preserves real page handles across rename and expires deleted handles", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw");
  const directory = await fs.lookup(1, "child-0-200");
  const file = await fs.lookup(directory, "_index.md");
  expect(directory).not.toBe(file);
  await vfs.rename("/DOCSY/child-0-200", "/DOCSY/renamed-200");
  expect(await fs.lookup(1, "renamed-200")).toBe(directory);
  expect(await fs.lookup(directory, "_index.md")).toBe(file);
  await vfs.rm("/DOCSY/renamed-200");
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.getattr(directory)).rejects.toMatchObject({ code: "ESTALE" });
});

it("rechecks resolved space identity on existing handles", async () => {
  const { fs, vfs } = await fixture();
  const file = await fs.lookup(1, "_index.md");
  const original = vfs.resolve.bind(vfs);
  vfs.resolve = async (path) => ({ ...await original(path), spaceKey: "mayflower" });
  await expect(fs.read(file, 0, 128)).rejects.toMatchObject({ code: "EACCES" });
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "EACCES" });
});

it("rejects old directory cookies after rename, insert and delete even when another listing starts", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw");
  const mutations = [
    () => vfs.rename("/DOCSY/child-0-200", "/DOCSY/z-renamed-200"),
    () => vfs.mkdir("/DOCSY/a-new-child"),
    () => vfs.rm("/DOCSY/child-1-201"),
  ];
  for (const mutate of mutations) {
    const { mtime } = await fs.getattr(1);
    const verifier = Buffer.alloc(8);
    verifier.writeUInt32BE(Math.floor(mtime / 1000));
    verifier.writeUInt32BE((mtime % 1000) * 1_000_000, 4);
    const first = await fs.readdir(1, 0, 2, verifier.toString("hex"));
    expect(first.end).toBe(false);
    const cursor = first.entries.at(-1)!.attr.id;
    await mutate();
    const fresh = await fs.readdir(1, 0, 256);
    expect(fresh.end).toBe(true);
    await expect(fs.readdir(1, cursor, 2, verifier.toString("hex"))).rejects.toMatchObject({ code: "EBADCOOKIE" });
  }
});


it("keeps existing page handles after reparenting before any lookup of the new name", async () => {
  const { fs, vfs } = await fixture(["DOCSY", "mayflower"], "rw");
  const docsy = await fs.lookup(1, "DOCSY");
  const directory = await fs.lookup(docsy, "child-0-200");
  const file = await fs.lookup(directory, "_index.md");
  await vfs.rename("/DOCSY/child-0-200", "/DOCSY/child-1-201/moved-200");
  expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64").toString()).toContain("Body 0");
  const parent = await fs.lookup(docsy, "child-1-201");
  expect(await fs.lookup(directory, "..")).toBe(parent);
  expect(await fs.lookup(parent, "moved-200")).toBe(directory);
  expect(await fs.lookup(directory, "_index.md")).toBe(file);
  await vfs.rename("/DOCSY/child-1-201/moved-200", "/mayflower/moved-again-200");
  expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64").toString()).toContain("Body 0");
  expect(await fs.lookup(directory, "..")).toBe(await fs.lookup(1, "mayflower"));
});

it("does not recover moved page handles outside the selected export", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw");
  const directory = await fs.lookup(1, "child-0-200");
  const file = await fs.lookup(directory, "_index.md");
  await vfs.rename("/DOCSY/child-0-200", "/mayflower/moved-200");
  await expect(fs.read(file, 0, 65536)).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.getattr(directory)).rejects.toMatchObject({ code: "ESTALE" });
});


it("retains moved handles on temporary resolution errors and rejects foreign relocation targets", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw");
  const directory = await fs.lookup(1, "child-0-200");
  const file = await fs.lookup(directory, "_index.md");
  await vfs.rename("/DOCSY/child-0-200", "/DOCSY/child-1-201/moved-200");
  const readlink = vfs.readlink.bind(vfs);
  vfs.readlink = async () => { throw Object.assign(new Error("retry"), { code: "EAGAIN" }); };
  await expect(fs.read(file, 0, 65536)).rejects.toMatchObject({ code: "EAGAIN" });
  vfs.readlink = async () => "/mayflower/_index.md";
  await expect(fs.read(file, 0, 65536)).rejects.toMatchObject({ code: "EACCES" });
  vfs.readlink = readlink;
  expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64").toString()).toContain("Body 0");
});


it("lists exact attachment sizes without downloads and caches complete ranged reads", async () => {
  const { fs, client } = await fixture();
  const expected = Buffer.alloc(NFS_MAX_READ + 29, 0xab);
  Buffer.from("Grüße 🐴").copy(expected, NFS_MAX_READ - 5);
  client.seedAttachment({ id: "a1", pageId: "100", filename: "large.bin", bytes: expected,
    mediaType: "application/octet-stream", modified: "2026-09-10T00:00:00.000Z" });
  const directory = await fs.lookup(1, "_attachments");
  const listing = await fs.readdir(directory, 0, 256);
  expect(listing.entries).toHaveLength(1);
  const attr = listing.entries[0]!.attr;
  expect(attr.size).toBe(expected.byteLength);
  expect((await fs.getattr(attr.id)).size).toBe(expected.byteLength);
  expect(client.callsTo("downloadAttachment")).toBe(0);
  expect(client.callsTo("getPage")).toBe(0);
  for (let pass = 0; pass < 2; pass++) {
    const first = await fs.read(attr.id, 0, NFS_MAX_READ);
    const second = await fs.read(attr.id, NFS_MAX_READ, NFS_MAX_READ);
    expect(first.eof).toBe(false);
    expect(second.eof).toBe(true);
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")])).toEqual(expected);
  }
  expect(client.callsTo("downloadAttachment")).toBe(1);
});


it("keeps attachment and attachment-directory handles when their owning page moves", async () => {
  const { fs, vfs, client } = await fixture(["DOCSY"], "rw");
  const bytes = Buffer.from("attachment Grüße 🐴");
  client.seedAttachment({ id: "a1", pageId: "200", filename: "proof.txt", bytes,
    mediaType: "text/plain", modified: "2026-09-10T00:00:00.000Z" });
  const page = await fs.lookup(1, "child-0-200");
  const directory = await fs.lookup(page, "_attachments");
  const file = await fs.lookup(directory, "proof.txt");
  await vfs.rename("/DOCSY/child-0-200", "/DOCSY/child-1-201/moved-200");
  expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64")).toEqual(bytes);
  expect(await fs.lookup(directory, "..")).toBe(page);
  expect(await fs.lookup(page, "_attachments")).toBe(directory);
  expect(await fs.lookup(directory, "proof.txt")).toBe(file);
  expect((await fs.readdir(directory, 0, 256)).entries.map(entry => entry.attr.id)).toEqual([file]);
  await vfs.rename("/DOCSY/child-1-201/moved-200", "/mayflower/outside-200");
  await expect(fs.read(file, 0, 65536)).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.getattr(directory)).rejects.toMatchObject({ code: "ESTALE" });
});


it("recovers a folder handle by ID before looking up its new parent", async () => {
  const { fs, vfs, client } = await fixture();
  client.seedPage({ id: "500", title: "Folder", type: "folder", spaceKey: "DOCSY", parentId: "100" });
  const folder = await fs.lookup(1, "folder-500");
  const metadata = await fs.lookup(folder, "_index.md");
  await client.movePage("500", "200");
  await vfs.index.loadChildren("100", { force: true });
  expect(Buffer.from((await fs.read(metadata, 0, 65536)).data, "base64").toString()).toContain("Folder");
  const parent = await fs.lookup(folder, "..");
  expect(await fs.lookup(folder, "_index.md")).toBe(metadata);
  expect(parent).toBe(await fs.lookup(1, "child-0-200"));
  expect(await fs.lookup(parent, "folder-500")).toBe(folder);
  expect(client.callsTo("getFolder")).toBe(1);
  expect(client.callsTo("getAncestors")).toBe(1);
  expect(client.callsTo("getPage")).toBe(0);
  await client.movePage("500", "300");
  await vfs.index.loadChildren("200", { force: true });
  await expect(fs.lookup(folder, "..")).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.read(metadata, 0, 65536)).rejects.toMatchObject({ code: "ESTALE" });
});

it("rejects inconsistent folder ancestry and preserves a handle for retry", async () => {
  const { fs, vfs, client } = await fixture();
  client.seedPage({ id: "500", title: "Folder", type: "folder", spaceKey: "DOCSY", parentId: "100" });
  const folder = await fs.lookup(1, "folder-500");
  await client.movePage("500", "200");
  await vfs.index.loadChildren("100", { force: true });
  const ancestors = client.getAncestors.bind(client);
  client.getAncestors = async () => [{ id: "100", title: "Home" }];
  await expect(fs.lookup(folder, "..")).rejects.toMatchObject({ code: "EAGAIN" });
  client.getAncestors = async () => [{ id: "500", title: "Cycle" }];
  await expect(fs.lookup(folder, "..")).rejects.toMatchObject({ code: "EINVAL" });
  client.getAncestors = ancestors;
  expect(await fs.lookup(folder, "..")).toBe(await fs.lookup(1, "child-0-200"));
});


it("compares v1 numeric space IDs with v2 string folder space IDs", async () => {
  const { vfs, client } = await fixture();
  client.seedPage({ id: "500", title: "Folder", type: "folder", spaceKey: "DOCSY", parentId: "100" });
  const getSpace = client.getSpace.bind(client);
  client.getSpace = async key => ({ ...await getSpace(key), id: 42 as unknown as string });
  const getFolder = client.getFolder.bind(client);
  client.getFolder = async id => ({ ...await getFolder(id), spaceId: "42" });
  expect(await vfs.folderPath("500", "DOCSY")).toBe("/DOCSY/folder-500");
  client.getFolder = async id => ({ ...await getFolder(id), spaceId: "43" });
  await expect(vfs.folderPath("500", "DOCSY")).rejects.toMatchObject({ code: "ENOENT" });
});


it("does not enumerate child directories while returning parent directory attributes", async () => {
  const { fs, vfs, client } = await fixture();
  const listing = await fs.readdir(1, 0, 256);
  expect(listing.entries.filter(entry => entry.name.startsWith("child-"))).toHaveLength(4);
  expect(client.callsTo("getPageDirectChildren")).toBe(1);
  expect(client.callsTo("getPage")).toBe(1);
  for (let id = 200; id < 204; id++) expect(vfs.index.isUnloaded(String(id))).toBe(true);
  const requests = client.requestCount;
  await fs.readdir(1, 0, 256);
  expect(client.requestCount).toBe(requests);
  const child = listing.entries.find(entry => entry.name === "child-0-200")!.attr.id;
  await fs.readdir(child, 0, 256);
  expect(client.callsTo("getPageDirectChildren")).toBe(2);
  expect(vfs.index.isUnloaded("200")).toBe(false);
  expect(vfs.index.isUnloaded("201")).toBe(true);
});

it("counts distinct successful NFS file reads, excluding metadata, ranges and shields", async () => {
  const { vfs } = await fixture();
  const reports: unknown[] = [];
  const fs = new NfsFilesystem(vfs, ["DOCSY"], new SweepDetector(2, 1000, report => reports.push(report)));
  await fs.getattr(1); // Internal directory hydration is not a client listing.
  const home = await fs.lookup(1, "_index.md");
  await fs.getattr(home);
  const marker = await fs.lookup(1, ".metadata_never_index");
  await fs.read(marker, 0, 1);
  await expect(fs.read(1, 0, 1)).rejects.toThrow();
  await expect(fs.read(home, -1, 1)).rejects.toThrow();
  for (let i = 0; i < 60; i++) await fs.read(home, i, 1);
  expect(reports).toHaveLength(0);
  const child = await fs.lookup(1, "child-0-200");
  await fs.read(await fs.lookup(child, "_index.md"), 0, 1);
  expect(reports).toEqual([{ reads: 2, windowMs: 1000 }]);
});

it("only successful client listings suppress NFS sweep warnings", async () => {
  const { vfs } = await fixture();
  const reports: unknown[] = [];
  const fs = new NfsFilesystem(vfs, ["DOCSY"], new SweepDetector(1, 1000, report => reports.push(report)));
  await fs.readdir(1, 0, 256);
  await fs.read(await fs.lookup(1, "_index.md"), 0, 1);
  expect(reports).toHaveLength(0);
  const child = await fs.lookup(1, "child-0-200");
  await expect(fs.readdir(child, 0, 256, "bad")).rejects.toThrow();
  await fs.read(await fs.lookup(child, "_index.md"), 0, 1);
  expect(reports).toHaveLength(1);
});

it("retains an attachment handle across rename and filename reuse without downloading other bodies", async () => {
  const { fs, client } = await fixture(["DOCSY"], "ro", 0);
  const original = Buffer.from("original Grüße 🐴");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "old.txt", bytes: original });
  const directory = await fs.lookup(1, "_attachments");
  const file = await fs.lookup(directory, "old.txt");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "renamed.txt", bytes: original });
  client.seedAttachment({ id: "a2", pageId: "100", filename: "old.txt", bytes: Buffer.from("replacement") });
  expect(Buffer.from((await fs.read(file, 0, 1000)).data, "base64")).toEqual(original);
  expect(await fs.lookup(directory, "renamed.txt")).toBe(file);
  expect(await fs.lookup(directory, "old.txt")).not.toBe(file);
  expect(client.callsTo("getPage")).toBe(0);
  expect(client.callsTo("downloadAttachment")).toBe(1);
  await client.deleteAttachment("a1");
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "ESTALE" });
});

it("preserves renamed attachment handles on a temporary metadata error and confines recovery to the owner", async () => {
  const { fs, client } = await fixture(["DOCSY"], "ro", 0);
  const bytes = Buffer.from("owner scoped");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "old.txt", bytes });
  const directory = await fs.lookup(1, "_attachments");
  const file = await fs.lookup(directory, "old.txt");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "new.txt", bytes });
  const list = client.listAttachments.bind(client);
  client.listAttachments = async () => { throw Object.assign(new Error("temporary"), { status: 503 }); };
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "EAGAIN" });
  client.listAttachments = list;
  expect((await fs.getattr(file)).size).toBe(bytes.length);
  expect(await fs.lookup(directory, "new.txt")).toBe(file);
  client.seedAttachment({ id: "a1", pageId: "300", filename: "new.txt", bytes });
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "ESTALE" });
});

it("recovers attachment handles after an independent owner change inside the export", async () => {
  const { fs, client } = await fixture(["DOCSY", "mayflower"], "ro", 0);
  const bytes = Buffer.from("moved attachment Grüße 🐴");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "old.txt", bytes });
  const docsy = await fs.lookup(1, "DOCSY");
  const oldDirectory = await fs.lookup(docsy, "_attachments");
  const file = await fs.lookup(oldDirectory, "old.txt");
  client.seedAttachment({ id: "a1", pageId: "200", filename: "new.txt", bytes });
  expect((await fs.getattr(file)).size).toBe(bytes.length);
  const child = await fs.lookup(docsy, "child-0-200");
  const newDirectory = await fs.lookup(child, "_attachments");
  expect(await fs.lookup(newDirectory, "new.txt")).toBe(file);
  expect(client.callsTo("getAttachment")).toBe(1);
  expect(client.callsTo("getPage")).toBe(0);
  expect(client.callsTo("downloadAttachment")).toBe(0);
  client.seedAttachment({ id: "a1", pageId: "300", filename: "other.txt", bytes });
  expect(Buffer.from((await fs.read(file, 0, 1000)).data, "base64")).toEqual(bytes);
  const other = await fs.lookup(await fs.lookup(1, "mayflower"), "_attachments");
  expect(await fs.lookup(other, "other.txt")).toBe(file);
});

it("checks fresh owner scope and rejects malformed attachment relocation metadata", async () => {
  const { fs, client } = await fixture(["DOCSY"], "ro", 0);
  const bytes = Buffer.from("private attachment");
  client.seedAttachment({ id: "a1", pageId: "100", filename: "old.txt", bytes });
  const file = await fs.lookup(await fs.lookup(1, "_attachments"), "old.txt");
  await fs.lookup(1, "child-0-200"); // Owner is cached in the original space.
  client.seedAttachment({ id: "a1", pageId: "200", filename: "new.txt", bytes });
  const get = client.getAttachment.bind(client);
  client.getAttachment = async id => ({ ...await get(id), filename: "../escape" });
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "EINVAL" });
  client.getAttachment = async id => ({ ...await get(id), id: "different" });
  await expect(fs.getattr(file)).rejects.toMatchObject({ code: "EINVAL" });
  client.getAttachment = get;
  await client.movePage("200", "300");
  await expect(fs.read(file, 0, 1000)).rejects.toMatchObject({ code: "ESTALE" });
  expect(client.callsTo("downloadAttachment")).toBe(0);
  expect(client.callsTo("getPage")).toBe(0);
});

it("keeps comments and historic-version handles attached to a renamed and reparented page", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw");
  const page = await fs.lookup(1, "child-0-200");
  const comments = await fs.lookup(page, ".comments.md");
  const versions = await fs.lookup(page, ".versions");
  const historic = await fs.lookup(versions, "1.md");
  const commentBytes = await fs.read(comments, 0, 65536);
  const historicBytes = await fs.read(historic, 0, 65536);
  const otherPage = await fs.lookup(1, "child-1-201");
  expect(await fs.lookup(otherPage, ".comments.md")).not.toBe(comments);
  expect(await fs.lookup(await fs.lookup(otherPage, ".versions"), "1.md")).not.toBe(historic);
  await vfs.rename("/DOCSY/child-0-200", "/DOCSY/child-1-201/moved-200");
  expect(await fs.read(historic, 0, 65536)).toEqual(historicBytes);
  // Rendered comment headings may change with the page title, but identity remains.
  expect((await fs.read(comments, 0, 65536)).eof).toBe(commentBytes.eof);
  expect(await fs.lookup(page, ".comments.md")).toBe(comments);
  expect(await fs.lookup(page, ".versions")).toBe(versions);
  expect(await fs.lookup(versions, "1.md")).toBe(historic);
  expect(await fs.lookup(versions, "..")).toBe(page);
  await vfs.rename("/DOCSY/child-1-201/moved-200", "/mayflower/outside-200");
  for (const id of [comments, versions, historic]) {
    await expect(fs.getattr(id)).rejects.toMatchObject({ code: "ESTALE" });
  }
});

it("keeps a version snapshot byte-identical across ranged reads, live edits, moves and cache eviction", async () => {
  const { fs, vfs, client } = await fixture(["DOCSY", "mayflower"], "rw", 0);
  const docsy = await fs.lookup(1, "DOCSY");
  const page = await fs.lookup(docsy, "child-0-200");
  const live = await fs.lookup(page, "_index.md");
  // Warming the live rendering must not determine the immutable rendering.
  await fs.read(live, 0, 65536);
  const snapshot = await fs.lookup(await fs.lookup(page, ".versions"), "1.md");
  const expected = Buffer.from((await fs.read(snapshot, 0, 65536)).data, "base64");
  const cut = Math.floor(expected.length / 2);
  const first = Buffer.from((await fs.read(snapshot, 0, cut)).data, "base64");
  const oldSize = (await fs.getattr(snapshot)).size;
  client.bumpVersion("200", "<p>New live body Grüße 🐴</p>");
  await vfs.rename("/DOCSY/child-0-200", "/mayflower/moved-200");
  vfs.cache!.forgetPage("200");
  const rest = await fs.read(snapshot, cut, 65536);
  expect(Buffer.concat([first, Buffer.from(rest.data, "base64")])).toEqual(expected);
  expect(rest.eof).toBe(true);
  expect((await fs.getattr(snapshot)).size).toBe(oldSize);
  expect(Buffer.from((await fs.read(live, 0, 65536)).data, "base64").toString()).toContain("New live body");
  expect(await fs.lookup(await fs.lookup(page, ".versions"), "1.md")).toBe(snapshot);
  // Refetch the same historic version without any current-body cache to reuse.
  vfs.cache!.forgetPage("200");
  expect(Buffer.from((await fs.read(snapshot, 0, 65536)).data, "base64")).toEqual(expected);
  expect(client.callsTo("getPageAtVersion")).toBe(3);
});

it("uses the historic version timestamp for its Markdown and exact NFS attributes", async () => {
  const { fs, vfs, client } = await fixture();
  const original = await client.getPageAtVersion("200", 1);
  await client.updatePage({ id: "200", title: "Child 0", storage: "<p>New version</p>", version: 2 });
  await vfs.readFile("/DOCSY/child-0-200/_index.md");
  const page = await fs.lookup(1, "child-0-200");
  const historic = await fs.lookup(await fs.lookup(page, ".versions"), "1.md");
  const attributes = await fs.getattr(historic);
  const data = Buffer.from((await fs.read(historic, 0, 65536)).data, "base64");
  expect(data.toString()).toContain(original.lastModified!);
  expect(attributes.mtime).toBe(Date.parse(original.lastModified!));
  expect(attributes.size).toBe(data.length);
  expect(data.toString()).toContain("Body 0");
  expect(data.toString()).not.toContain("New version");
});

it("does not label historic content with the current timestamp when the historic API omits it", async () => {
  const { fs, vfs, client } = await fixture();
  await client.updatePage({ id: "200", title: "Child 0", storage: "<p>New version</p>", version: 2 });
  await vfs.readFile("/DOCSY/child-0-200/_index.md");
  const get = client.getPageAtVersion.bind(client);
  client.getPageAtVersion = async (id, version) => ({ ...await get(id, version), lastModified: undefined });
  const historic = await fs.lookup(await fs.lookup(await fs.lookup(1, "child-0-200"), ".versions"), "1.md");
  expect((await fs.getattr(historic)).mtime).toBe(0);
  expect(Buffer.from((await fs.read(historic, 0, 65536)).data, "base64").toString()).not.toContain("lastModified:");
});

it("changes generated-view attributes for same-size content edits without a page version", async () => {
  const { fs, vfs } = await fixture();
  const page = await fs.lookup(1, "child-0-200");
  const id = await fs.lookup(page, ".comments.md");
  const originalRead = vfs.readFileBytes.bind(vfs);
  let content = "comment A";
  vfs.readFileBytes = async path => path.endsWith("/.comments.md")
    ? Buffer.from(content) : originalRead(path);
  const before = await fs.getattr(id);
  expect(await fs.getattr(id)).toEqual(before);
  expect(await fs.lookup(page, ".comments.md")).toBe(id);
  expect(await fs.getattr(id)).toEqual(before);
  content = "comment B";
  const after = await fs.getattr(id);
  expect(after.size).toBe(before.size);
  expect(after.mtime).toBeGreaterThan(before.mtime);
  expect(await fs.getattr(id)).toEqual(after);
  expect(Buffer.from((await fs.read(id, 0, 1024)).data, "base64").toString()).toBe(content);
});

it("bounds retained handles without evicting live identities or recycling stale IDs", async () => {
  const { fs, vfs } = await fixture();
  const rootStat = await vfs.stat("/DOCSY");
  const rootNode = await vfs.resolve("/DOCSY");
  let removed = "";
  vfs.stat = async path => {
    if (path === removed) throw Object.assign(new Error("Removed"), { code: "ENOENT" });
    return path === "/DOCSY" ? rootStat : { ...rootStat, id: path,
      kind: "virtual-file", isDirectory: false, isFile: true };
  };
  vfs.resolve = async () => rootNode;
  const first = await fs.lookup(1, "entry-0");
  // Root and volume shields also count toward the bound.
  const available = NFS_MAX_HANDLES - 1 - INDEXER_SHIELDS.size - SHIELD_DIRECTORIES.size;
  for (let i = 1; i < available; i++) await fs.lookup(1, `entry-${i}`);
  expect(await fs.lookup(1, "entry-0")).toBe(first);
  const overflow = await Promise.allSettled([fs.lookup(1, "overflow-a"), fs.lookup(1, "overflow-b")]);
  for (const result of overflow) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason.code).toBe("ENOSPC");
  }
  removed = "/DOCSY/entry-0";
  await expect(fs.getattr(first)).rejects.toMatchObject({ code: "ESTALE" });
  const replacement = await fs.lookup(1, "replacement");
  expect(replacement).toBeGreaterThan(first);
  await expect(fs.getattr(first)).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.lookup(1, "still-full")).rejects.toMatchObject({ code: "ENOSPC" });
});


it("stages split UTF-8 writes durably and serves exact local bytes through aliases", async () => {
  const { fs, journal, client } = await fixture(["DOCSY"], "rw", undefined, true);
  const directory = await fs.lookup(1, "child-0-200");
  const file = await fs.lookup(directory, "_index.md");
  const original = await fs.getattr(file);
  const content = Buffer.from("Local Grüße 🐴");
  await fs.truncate(file, 0);
  for (let i = content.length - 1; i >= 0; i--) await fs.write(file, i, content.subarray(i, i + 1));
  const stat = await fs.getattr(file);
  expect(stat.size).toBe(content.length);
  expect(stat.mtime).toBeGreaterThan(original.mtime);
  expect((await fs.getattr(file)).mtime).toBe(stat.mtime);
  expect(Buffer.from((await fs.read(file, 0, 1024)).data, "base64")).toEqual(content);
  expect(Buffer.from(journal!.get("200")!.bytes)).toEqual(content);
  const alias = await fs.lookup(1, "child-0-200.md");
  expect(Buffer.from((await fs.read(alias, 0, 1024)).data, "base64")).toEqual(content);
  await fs.truncate(file, content.length + 3);
  expect((await fs.getattr(file)).size).toBe(content.length + 3);
  expect(Buffer.from((await fs.read(file, content.length, 3)).data, "base64")).toEqual(Buffer.alloc(3));
  expect(client.callsTo("updatePage")).toBe(0);
});

it("refuses staging without a journal, through a read-only core or into generated views", async () => {
  const disabled = await fixture(["DOCSY"], "rw");
  await expect(disabled.fs.write(await disabled.fs.lookup(1, "_index.md"), 0, Buffer.from("x")))
    .rejects.toMatchObject({ code: "EROFS" });
  const readonly = await fixture(["DOCSY"], "ro", undefined, true);
  await expect(readonly.fs.truncate(await readonly.fs.lookup(1, "_index.md"), 0))
    .rejects.toMatchObject({ code: "EROFS" });
  expect(readonly.journal!.get("100")).toBeNull();
  const writable = await fixture(["DOCSY"], "rw", undefined, true);
  await expect(writable.fs.write(await writable.fs.lookup(1, "_space.json"), 0, Buffer.from("x")))
    .rejects.toMatchObject({ code: "EROFS" });
  await expect(writable.fs.truncate(1, 0)).rejects.toMatchObject({ code: "EISDIR" });
  const file = await writable.fs.lookup(1, "_index.md");
  await expect(writable.fs.write(file, -1, Buffer.from("x"))).rejects.toMatchObject({ code: "EINVAL" });
  await expect(writable.fs.write(file, 0, new Uint8Array(NFS_MAX_READ + 1))).rejects.toMatchObject({ code: "EINVAL" });
  expect(writable.journal!.get("100")).toBeNull();
});


it("serves local editor files, preserves renamed handles and expires removed identities", async () => {
  const { fs, vfs, journal, client } = await fixture(["DOCSY"], "rw", undefined, true);
  const id = await fs.create(1, ".editor.tmp");
  expect(await fs.write(id, 0, Buffer.from("draft 🐴"))).toBeNull();
  expect((await fs.getattr(id)).size).toBe(Buffer.byteLength("draft 🐴"));
  expect(Buffer.from((await fs.read(id, 0, 1024)).data, "base64").toString()).toBe("draft 🐴");
  expect((await fs.readdir(1, 0, 256)).entries.map(e => e.name)).toContain(".editor.tmp");
  expect(journal!.pending()).toEqual([]);
  const other = await fs.create(1, "backup.tmp");
  expect(await fs.rename(1, ".editor.tmp", 1, "backup.tmp")).toBeNull();
  expect(await fs.lookup(1, "backup.tmp")).toBe(id);
  await expect(fs.getattr(other)).rejects.toMatchObject({ code: "ESTALE" });
  await expect(fs.lookup(1, ".editor.tmp")).rejects.toMatchObject({ code: "ENOENT" });
  const recovered = new NfsFilesystem(vfs, ["DOCSY"], undefined, journal);
  const recoveredId = await recovered.lookup(1, "backup.tmp");
  expect(Buffer.from((await recovered.read(recoveredId, 0, 1024)).data, "base64").toString()).toBe("draft 🐴");
  await recovered.remove(1, "backup.tmp");
  await expect(fs.read(id, 0, 100)).rejects.toMatchObject({ code: "ESTALE" });
  expect(client.callsTo("createPage")).toBe(0);
  expect(client.callsTo("updatePage")).toBe(0);
});

it("stages editor replacement under the original page ID without exposing a temporary page", async () => {
  const { fs, vfs, journal, client } = await fixture(["DOCSY"], "rw", undefined, true);
  const page = await fs.lookup(1, "_index.md");
  const local = await fs.create(1, ".save.tmp");
  const content = (await vfs.readFile("/DOCSY/_index.md")).replace("Grüße 🐴", "Replacement 🐴");
  await fs.write(local, 0, Buffer.from(content));
  expect(await fs.rename(1, ".save.tmp", 1, "_index.md")).toBe("100");
  expect(await fs.lookup(1, "_index.md")).toBe(page);
  expect(Buffer.from((await fs.read(page, 0, 65536)).data, "base64").toString()).toBe(content);
  expect(journal!.pending().map(f => f.id)).toEqual(["100"]);
  expect((await fs.getattr(local)).size).toBe(Buffer.byteLength(content));
  expect(client.callsTo("updatePage")).toBe(0);
});

it("guards local namespace operations by core mode, content directories and reserved paths", async () => {
  const readonly = await fixture(["DOCSY"], "ro", undefined, true);
  await expect(readonly.fs.create(1, "draft.tmp")).rejects.toMatchObject({ code: "EROFS" });
  expect(readonly.journal!.localEntries("/DOCSY")).toEqual([]);
  readonly.journal!.createLocal("/DOCSY/recovered.tmp");
  const recovered = await readonly.fs.lookup(1, "recovered.tmp");
  await expect(readonly.fs.write(recovered, 0, Buffer.from("x"))).rejects.toMatchObject({ code: "EROFS" });
  await expect(readonly.fs.remove(1, "recovered.tmp")).rejects.toMatchObject({ code: "EROFS" });
  await expect(readonly.fs.rename(1, "recovered.tmp", 1, "new.tmp")).rejects.toMatchObject({ code: "EROFS" });
  const { fs, journal } = await fixture(["DOCSY"], "rw", undefined, true);
  for (const name of ["..", ".", "x/y", "a\0b"]) await expect(fs.create(1, name)).rejects.toMatchObject({ code: "EINVAL" });
  await expect(fs.create(1, "x".repeat(256))).rejects.toMatchObject({ code: "ENAMETOOLONG" });
  await expect(fs.create(1, "_index.md")).rejects.toMatchObject({ code: "EEXIST" });
  for (const name of [".DS_Store", ".metadata_never_index", ".fseventsd"]) {
    await expect(fs.create(1, name)).rejects.toMatchObject({ code: "EROFS" });
  }
  for (const directory of [".by-id", ".versions", "_attachments"]) {
    await expect(fs.create(await fs.lookup(1, directory), "draft.tmp")).rejects.toMatchObject({ code: "EROFS" });
  }
  await fs.create(1, "draft.tmp");
  await expect(fs.rename(1, "draft.tmp", 1, "_space.json")).rejects.toMatchObject({ code: "EROFS" });
  expect(journal!.local("/DOCSY/draft.tmp")).not.toBeNull();
  await expect(fs.remove(1, "_index.md")).rejects.toMatchObject({ code: "EROFS" });
});


it("enforces staged file modes and allows restoring write permissions", async () => {
  const { fs, journal } = await fixture(["DOCSY"], "rw", undefined, true);
  for (const id of [await fs.create(1, "private.tmp"), await fs.lookup(1, "_index.md")]) {
    await fs.setAttributes(id, { mode: 0o400, atime: 0, mtime: 1234 });
    expect(await fs.getattr(id)).toMatchObject({ mode: 0o400, atime: 0, mtime: 1234 });
    await expect(fs.write(id, 0, Buffer.from("x"))).rejects.toMatchObject({ code: "EROFS" });
    await fs.setAttributes(id, { mode: 0o600 });
    await fs.write(id, 0, Buffer.from("x"));
    expect((await fs.getattr(id)).mode).toBe(0o600);
  }
  expect(journal!.pending().map(file => file.id)).toEqual(["100"]);
});


it("keeps a replacement source handle writable after rename without changing the page handle", async () => {
  const { fs, vfs } = await fixture(["DOCSY"], "rw", undefined, true);
  const page = await fs.lookup(1, "_index.md");
  const temporary = await fs.create(1, ".open.tmp");
  const bytes = Buffer.from(await vfs.readFile("/DOCSY/_index.md"));
  await fs.setAttributes(temporary, { mode: 0o600, atime: 1234 });
  await fs.write(temporary, 0, bytes);
  await fs.rename(1, ".open.tmp", 1, "_index.md");
  expect(await fs.getattr(page)).toMatchObject({ mode: 0o600, atime: 1234 });
  const tail = Buffer.from("\nSaved through the still-open descriptor\n");
  expect(await fs.write(temporary, bytes.length, tail)).toBe("100");
  expect(await fs.lookup(1, "_index.md")).toBe(page);
  const expected = Buffer.concat([bytes, tail]);
  expect(Buffer.from((await fs.read(page, 0, 65536)).data, "base64")).toEqual(expected);
  expect(Buffer.from((await fs.read(temporary, 0, 65536)).data, "base64")).toEqual(expected);
});


it("projects durable local editor directories and keeps handles across tree rename", async () => {
  const { fs, journal, client } = await fixture(["DOCSY"], "rw", undefined, true);
  const dir = await fs.mkdir(1, "_index.md.sb-test");
  const nested = await fs.mkdir(dir, "nested");
  const file = await fs.create(nested, "draft", "0123456789abcdef");
  expect(await fs.write(file, 0, Buffer.from("local draft"))).toBeNull();
  await fs.setAttributes(dir, { mode: 0o700 });
  expect(await fs.getattr(dir)).toMatchObject({ directory: true, mode: 0o700, size: 0 });
  expect((await fs.readdir(dir, 0, 10)).entries.map(entry => entry.name)).toEqual(["nested"]);
  expect((await fs.readdir(nested, 0, 10)).entries[0]!.attr.size).toBe(11);
  await expect(fs.remove(1, "_index.md.sb-test", true)).rejects.toMatchObject({ code: "ENOTEMPTY" });
  await expect(fs.remove(1, "_index.md.sb-test")).rejects.toMatchObject({ code: "EISDIR" });
  await expect(fs.write(dir, 0, Buffer.from("x"))).rejects.toMatchObject({ code: "EISDIR" });
  await expect(fs.read(dir, 0, 1)).rejects.toMatchObject({ code: "EISDIR" });
  await fs.setAttributes(dir, { mode: 0o500 });
  await expect(fs.create(dir, "denied")).rejects.toMatchObject({ code: "EACCES" });
  await fs.setAttributes(dir, { mode: 0o700 });
  await fs.rename(1, "_index.md.sb-test", 1, "renamed");
  expect(await fs.lookup(1, "renamed")).toBe(dir);
  expect(await fs.lookup(dir, "nested")).toBe(nested);
  expect(await fs.lookup(nested, "draft")).toBe(file);
  expect(Buffer.from((await fs.read(file, 0, 100)).data, "base64").toString()).toBe("local draft");
  expect(await fs.lookup(nested, "..")).toBe(dir);
  expect(await fs.rename(nested, "draft", 1, "_index.md")).toBe("100");
  expect(Buffer.from((await fs.read(file, 0, 100)).data, "base64").toString()).toBe("local draft");
  await fs.remove(dir, "nested", true);
  await fs.remove(1, "renamed", true);
  await expect(fs.getattr(dir)).rejects.toMatchObject({ code: "ESTALE" });
  expect(journal!.pending().map(entry => entry.id)).toEqual(["100"]);
  expect(client.callsTo("updatePage")).toBe(0);
});

it("keeps recovered local directories read-only and out of generated views", async () => {
  const { fs, journal } = await fixture(["DOCSY"], "ro", undefined, true);
  journal!.createLocalDirectory("/DOCSY/recovered");
  const dir = await fs.lookup(1, "recovered");
  expect(await fs.getattr(dir)).toMatchObject({ directory: true, mode: 0o555, writable: false });
  await expect(fs.mkdir(dir, "child")).rejects.toThrow();
  await expect(fs.setAttributes(dir, { mode: 0o777 })).rejects.toThrow();
  await expect(fs.remove(1, "recovered", true)).rejects.toThrow();
  const writable = await fixture(["DOCSY"], "rw", undefined, true);
  const byId = await writable.fs.lookup(1, ".by-id");
  await expect(writable.fs.mkdir(byId, "escape")).rejects.toThrow();
  await expect(writable.fs.mkdir(1, "../escape")).rejects.toThrow();
  await expect(writable.fs.mkdir(1, ".Spotlight-V100")).rejects.toThrow();
});


it("keeps regular CREATE scoped and truncates an existing page under its original identity", async () => {
  const { fs, journal } = await fixture(["DOCSY"], "rw", undefined, true);
  const original = await fs.lookup(1, "_index.md");
  await expect(fs.createRegular(1, "_index.md", true, { size: 0 })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.createRegular(1, "_index.md", false, { size: 0 })).toEqual({ file: original, pageId: "100" });
  expect(journal!.get("100")!.bytes.byteLength).toBe(0);
  const local = await fs.createRegular(1, "local", true, { mode: 0o400 });
  await expect(fs.createRegular(1, "local", false, { size: 0 })).rejects.toMatchObject({ code: "EROFS" });
  expect((await fs.getattr(local.file)).mode).toBe(0o400);
  await expect(fs.createRegular(1, "_space.json", false, {})).rejects.toThrow();
  await expect(fs.createRegular(await fs.lookup(1, ".by-id"), "new", false, {})).rejects.toThrow();
  await expect(fs.createRegular(1, "../escape", false, {})).rejects.toThrow();
  const readonly = await fixture(["DOCSY"], "ro", undefined, true);
  await expect(readonly.fs.createRegular(1, "new", false, {})).rejects.toThrow();
});


it("moves page handles to backups and restores replacement under the original page ID", async () => {
  const { fs, journal, vfs, client } = await fixture(["DOCSY"], "rw", undefined, true);
  const original = await fs.lookup(1, "_index.md");
  const before = Buffer.from((await fs.read(original, 0, 65536)).data, "base64");
  expect(await fs.rename(1, "_index.md", 1, "backup.md")).toBeNull();
  expect(await fs.lookup(1, "backup.md")).toBe(original);
  await expect(fs.lookup(1, "_index.md")).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(1, 0, 256)).entries.map(entry => entry.name)).not.toContain("_index.md");
  expect(Buffer.from((await fs.read(original, 0, 65536)).data, "base64")).toEqual(before);
  const incoming = await fs.create(1, "new.tmp");
  await fs.write(incoming, 0, Buffer.concat([before, Buffer.from("new content")]));
  expect(await fs.rename(1, "new.tmp", 1, "_index.md")).toBe("100");
  expect(await fs.lookup(1, "_index.md")).toBe(incoming);
  expect(Buffer.from((await fs.read(original, 0, 65536)).data, "base64")).toEqual(before);
  expect(Buffer.from((await fs.read(incoming, 0, 65536)).data, "base64").toString()).toContain("new content");
  expect(await fs.write(original, before.length, Buffer.from("backup only"))).toBeNull();
  expect(journal!.pending().map(file => file.id)).toEqual(["100"]);
  expect(Buffer.from(journal!.get("100")!.bytes).toString()).not.toContain("backup only");
  const recovered = new NfsFilesystem(vfs, ["DOCSY"], undefined, journal);
  expect(Buffer.from((await recovered.read(await recovered.lookup(1, "_index.md"), 0, 65536)).data, "base64").toString()).toContain("new content");
  await fs.remove(1, "backup.md");
  await expect(fs.getattr(original)).rejects.toMatchObject({ code: "ESTALE" });
  expect(client.callsTo("updatePage")).toBe(0);
});

it("recovers a vacant page path and permits restoring its backup without changing content", async () => {
  const { fs, journal, vfs } = await fixture(["DOCSY"], "rw", undefined, true);
  await fs.rename(1, "_index.md", 1, "backup.md");
  const recovered = new NfsFilesystem(vfs, ["DOCSY"], undefined, journal);
  await expect(recovered.lookup(1, "_index.md")).rejects.toMatchObject({ code: "ENOENT" });
  const backup = await recovered.lookup(1, "backup.md");
  expect(await recovered.rename(1, "backup.md", 1, "_index.md")).toBe("100");
  expect(await recovered.lookup(1, "_index.md")).toBe(backup);
  expect(journal!.displaced("/DOCSY/_index.md")).toBeNull();
  expect(journal!.pending()).toEqual([]);
});


it("recreates a backed-up page through ordinary and exclusive CREATE under the same ID", async () => {
  const { fs, journal } = await fixture(["DOCSY"], "rw", undefined, true);
  await fs.rename(1, "_index.md", 1, "backup-one");
  const ordinary = await fs.createRegular(1, "_index.md", true, { mode: 0o600 });
  expect(ordinary.pageId).toBe("100");
  expect((await fs.getattr(ordinary.file)).size).toBe(0);
  await fs.write(ordinary.file, 0, Buffer.from("draft"));
  await fs.rename(1, "_index.md", 1, "backup-two");
  const exclusive = await fs.create(1, "_index.md", "0123456789abcdef");
  expect(await fs.write(exclusive, 0, Buffer.from("new draft"))).toBe("100");
  expect(await fs.create(1, "_index.md", "0123456789abcdef")).toBe(exclusive);
  await expect(fs.create(1, "_index.md", "fedcba9876543210")).rejects.toMatchObject({ code: "EEXIST" });
  expect(Buffer.from(journal!.get("100")!.bytes).toString()).toBe("new draft");
});


it("checks exclusive recreation replay against the current page identity and scope", async () => {
  const { fs, journal, vfs, client } = await fixture(["DOCSY"], "rw", undefined, true);
  await fs.rename(1, "_index.md", 1, "backup");
  const verifier = "0123456789abcdef";
  const handle = await fs.create(1, "_index.md", verifier);
  await fs.write(handle, 0, Buffer.from("acknowledged bytes"));
  const before = journal!.get("100");
  const recovered = new NfsFilesystem(vfs, ["DOCSY"], undefined, journal);
  const stat = vfs.stat.bind(vfs);
  vfs.stat = async path => {
    const result = await stat(path);
    return path === "/DOCSY/_index.md" ? { ...result, id: "999" } : result;
  };
  await expect(recovered.create(1, "_index.md", verifier)).rejects.toMatchObject({ code: "ESTALE" });
  expect(journal!.get("100")).toEqual(before);
  vfs.stat = stat;
  const resolve = vfs.resolve.bind(vfs);
  vfs.resolve = async path => {
    const result = await resolve(path);
    return path === "/DOCSY/_index.md" ? { ...result, spaceKey: "mayflower" } : result;
  };
  await expect(recovered.create(1, "_index.md", verifier)).rejects.toMatchObject({ code: "EACCES" });
  expect(journal!.get("100")).toEqual(before);
  vfs.resolve = resolve;
  const replay = await recovered.create(1, "_index.md", verifier);
  expect(Buffer.from((await recovered.read(replay, 0, 65536)).data, "base64").toString()).toBe("acknowledged bytes");
  expect(client.callsTo("updatePage")).toBe(0);
});
