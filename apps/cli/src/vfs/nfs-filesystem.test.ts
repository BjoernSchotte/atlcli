import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { NfsFilesystem, NFS_MAX_READ } from "./nfs-filesystem.js";

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
  return { fs: new NfsFilesystem(vfs, spaces), vfs };
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
  expect((await fs.readdir(1, 0, 256)).entries.map((e) => e.name)).toEqual(["DOCSY", "mayflower"]);
  expect(await fs.lookup(await fs.lookup(1, "DOCSY"), "..")).toBe(1);
});

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
