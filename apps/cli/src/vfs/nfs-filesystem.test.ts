import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { NfsFilesystem, NFS_MAX_READ } from "./nfs-filesystem.js";
import { INDEXER_SHIELDS, SHIELD_DIRECTORIES } from "./mount-client-probes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(spaces = ["DOCSY"], mode: "ro" | "rw" = "ro") {
  const cacheDir = mkdtempSync(join(tmpdir(), "nfs-core-"));
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Grüße 🐴</p>" })
    .seedSpace({ id: "s2", key: "mayflower", name: "Other", homepageId: "300" })
    .seedPage({ id: "300", title: "Other Home", spaceKey: "mayflower", storage: "<p>Other</p>" });
  for (let i = 0; i < 4; i++) client.seedPage({ id: String(200 + i), title: `Child ${i}`,
    spaceKey: "DOCSY", parentId: "100", storage: `<p>Body ${i}</p>` });
  const vfs = await ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY", "mayflower"],
    mode, allowDelete: mode === "rw", coalesceMs: 0, cacheDir, offline: false });
  cleanup.push(async () => { await vfs.close(); rmSync(cacheDir, { recursive: true, force: true }); });
  return { fs: new NfsFilesystem(vfs, spaces), vfs, client };
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
