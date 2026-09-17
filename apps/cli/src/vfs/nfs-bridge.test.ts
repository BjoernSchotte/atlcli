import { afterEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { open, opendir, stat } from "node:fs/promises";
import { getActiveProfile, loadConfig } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { runMountCommand } from "../commands/wiki-mount.js";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { nfsMountOptionsFor } from "./mount-transport.js";
import { NfsJournal } from "./nfs-journal.js";
import { startNfsServer, type RunningNfsServer } from "./nfs-bridge.js";
import { encodeNfsFrame, readNfsFrames } from "./nfs-framing.js";
import { INDEXER_SHIELDS, SHIELD_DIRECTORIES } from "./mount-client-probes.js";

const attachmentBytes = Buffer.alloc(1024 * 1024 + 29, 0xab);
Buffer.from("Grüße 🐴").copy(attachmentBytes, 1024 * 1024 - 5);
const helperPath = process.env.ATLCLI_NFS_TEST_HELPER;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function ints(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((n, i) => result.writeUInt32BE(n >>> 0, i * 4));
  return result;
}
function opaque(value: Buffer): Buffer {
  return Buffer.concat([ints(value.length), value, Buffer.alloc((4 - value.length % 4) % 4)]);
}
async function rpc(server: Pick<RunningNfsServer, "port">, program: number, procedure: number, body: Buffer, acceptStatus = 0): Promise<Buffer> {
  const payload = Buffer.concat([ints(7, 0, 2, program, 3, procedure, 0, 0, 0, 0), body]);
  return new Promise((resolveReply, reject) => {
    const socket = connect(server.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error("RPC timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(Buffer.concat([ints(0x80000000 + payload.length), payload])));
    socket.on("data", (bytes) => {
      response = Buffer.concat([response, typeof bytes === "string" ? Buffer.from(bytes) : bytes]);
      if (response.length >= 4 && response.length >= 4 + (response.readUInt32BE() & 0x7fffffff)) {
        socket.destroy();
        // Accepted RPC response: xid, reply, accepted, AUTH_NONE verifier, success.
        try {
          expect([...Array(6)].map((_, i) => response.readUInt32BE(4 + i * 4))).toEqual([7, 1, 0, 0, 0, acceptStatus]);
          resolveReply(response.subarray(28));
        } catch (error) { reject(error); }
      }
    });
    socket.on("end", () => reject(new Error("RPC closed before reply")));
  });
}
async function fixture(spaces = ["DOCSY"], live = process.env.ATLCLI_NFS_LIVE === "1", now = () => Date.now(), writable = false) {
  if (live && writable) throw new Error("RW wire fixtures must be synthetic");
  const cacheDir = mkdtempSync(join(tmpdir(), "nfs-wire-"));
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Grüße 🐴</p>" })
    .seedSpace({ id: "s2", key: "mayflower", name: "Other", homepageId: "300" })
    .seedPage({ id: "300", title: "Other", spaceKey: "mayflower", storage: "<p>Other</p>" });
  for (let i = 0; i < 32; i++) client.seedPage({ id: String(400 + i), title: `Child ${i}`,
    spaceKey: "DOCSY", parentId: "100", storage: "<p>Test</p>" });
  client.seedAttachment({ id: "a1", pageId: "100", filename: "large.bin", bytes: attachmentBytes,
    mediaType: "application/octet-stream", modified: "2026-09-10T00:00:00.000Z" });
  const profile = live ? getActiveProfile(await loadConfig(), "mayflower") : undefined;
  if (live && !profile) throw new Error("Missing mayflower test profile");
  const vfs = await ConfluenceVfsImpl.open({ profile: profile?.name ?? "fixture",
    client: profile ? new ConfluenceClient(profile) : client, spaces, mode: writable ? "rw" : "ro", allowDelete: false, offline: false, cacheDir, now, coalesceMs: writable ? 0 : undefined });
  const journal = writable ? new NfsJournal(join(cacheDir, "journal.sqlite"), "fixture:DOCSY", 512, 2048) : undefined;
  cleanups.push(async () => { await vfs.close(); journal?.close(); rmSync(cacheDir, { recursive: true, force: true }); });
  const server = await startNfsServer({ vfs, spaces, journal, helperPath: resolve(helperPath!) });
  cleanups.push(() => server.stop());
  return { server, vfs, client, journal };
}

describe.skipIf(!helperPath)("real Rust NFS helper over TCP and Bun pipes", () => {
  it("acknowledges journal-backed WRITE as FILE_SYNC and applies SETATTR sizes", async () => {
    const { server, journal, client } = await fixture(["DOCSY"], false, () => Date.now(), true);
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookup = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from("_index.md"))]));
    expect(lookup.readUInt32BE()).toBe(0);
    const file = lookup.subarray(8, 8 + lookup.readUInt32BE(4));
    const info = await rpc(server, 100003, 19, opaque(file));
    expect(info.readUInt32BE(104)).toBe(1024 * 1024);
    expect(info.readBigUInt64BE(info.length - 20)).toBe(BigInt(64 * 1024 * 1024));
    const truncate = async (size: number, mtime = 0) => rpc(server, 100003, 2,
      Buffer.concat([opaque(file), ints(0, 0, 0, 1, 0, size, 0, mtime, 0)]));
    expect((await truncate(0, 1)).readUInt32BE()).toBe(0);
    const bytes = Buffer.from("Grüße 🐴");
    const cut = bytes.length - 2;
    for (const [offset, data] of [[cut, bytes.subarray(cut)], [0, bytes.subarray(0, cut)]] as const) {
      const reply = await rpc(server, 100003, 7,
        Buffer.concat([opaque(file), ints(0, offset, data.length, 0), opaque(data)]));
      expect(reply.readUInt32BE()).toBe(0);
      expect(reply.readUInt32BE(120)).toBe(data.length);
      expect(reply.readUInt32BE(124)).toBe(2); // FILE_SYNC: durable locally, not yet published.
    }
    expect(Buffer.from(journal!.get("100")!.bytes)).toEqual(bytes);
    const read = await rpc(server, 100003, 6, Buffer.concat([opaque(file), ints(0, 0, 1024)]));
    expect(read.readUInt32BE()).toBe(0);
    expect(read.subarray(20, 20 + read.readUInt32BE(16))).toEqual(bytes);
    const revision = journal!.get("100")!.revision;
    const replay = await rpc(server, 100003, 7,
      Buffer.concat([opaque(file), ints(0, 0, bytes.length, 2), opaque(bytes)]));
    expect(replay.readUInt32BE()).toBe(0);
    for (const [offset, count] of [[0, 0], [2, 3]]) {
      const commit = await rpc(server, 100003, 21, Buffer.concat([opaque(file), ints(0, offset, count)]));
      expect(commit.readUInt32BE()).toBe(0);
      expect(commit.subarray(-8)).toEqual(replay.subarray(-8));
    }
    const badRange = await rpc(server, 100003, 21,
      Buffer.concat([opaque(file), ints(0xffffffff, 0xffffffff, 1)]));
    expect(badRange.readUInt32BE()).toBe(22);
    const directoryCommit = await rpc(server, 100003, 21, Buffer.concat([opaque(root), ints(0, 0, 0)]));
    expect(directoryCommit.readUInt32BE()).toBe(21);
    const stale = Buffer.from(file); stale[0] ^= 0xff;
    const staleCommit = await rpc(server, 100003, 21, Buffer.concat([opaque(stale), ints(0, 0, 0)]));
    expect(staleCommit.readUInt32BE()).toBe(70);
    expect(journal!.get("100")!.revision).toBe(revision);
    expect((await truncate(bytes.length + 3)).readUInt32BE()).toBe(0);
    expect(journal!.get("100")!.bytes.length).toBe(bytes.length + 3);
    // Unsupported metadata changes must not partially apply the accompanying truncate.
    const unsupported = await rpc(server, 100003, 2,
      Buffer.concat([opaque(file), ints(1, 0o600, 0, 0, 1, 0, 0, 0, 0, 0)]));
    expect(unsupported.readUInt32BE()).toBe(10004);
    expect(journal!.get("100")!.bytes.length).toBe(bytes.length + 3);
    expect((await truncate(700)).readUInt32BE()).toBe(28); // NFS3ERR_NOSPC
    expect(journal!.get("100")!.bytes.length).toBe(bytes.length + 3);
    expect(client.callsTo("updatePage")).toBe(0);
  });

  it("preserves immutable version bytes across split-UTF8 wire reads and an external move", async () => {
    let clock = Date.now();
    const { server, client, vfs } = await fixture(["DOCSY", "mayflower"], false, () => clock);
    client.seedPage({ id: "400", title: "Child 0", spaceKey: "DOCSY", parentId: "100",
      storage: `<p>${"Historical Grüße 🐴. ".repeat(2000)}</p>` });
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookup = async (parent: Buffer, name: string) => {
      const reply = await rpc(server, 100003, 3, Buffer.concat([opaque(parent), opaque(Buffer.from(name))]));
      expect(reply.readUInt32BE()).toBe(0);
      return reply.subarray(8, 8 + reply.readUInt32BE(4));
    };
    const directory = await lookup(await lookup(root, "DOCSY"), "child-0-400");
    const live = await lookup(directory, "_index.md");
    const historic = await lookup(await lookup(directory, ".versions"), "1.md");
    const expected = Buffer.from(await vfs.readFileBytes("/DOCSY/child-0-400/.versions/1.md"));
    const cut = expected.indexOf(Buffer.from("🐴")) + 1;
    expect(cut).toBeGreaterThan(1);
    const read = async (handle: Buffer, offset: number, count: number) => {
      const reply = await rpc(server, 100003, 6, Buffer.concat([opaque(handle), ints(0, offset, count)]));
      expect(reply.readUInt32BE()).toBe(0);
      expect(reply.readUInt32BE(4)).toBe(0);
      return reply.subarray(20, 20 + reply.readUInt32BE(16));
    };
    const first = await read(historic, 0, cut);
    client.bumpVersion("400", "<p>New current document</p>");
    await client.movePage("400", "300");
    clock += 60_001;
    vfs.cache!.forgetPage("400");
    const rest = await read(historic, cut, 65536);
    expect(Buffer.concat([first, rest])).toEqual(expected);
    expect((await read(live, 0, 65536)).toString()).toContain("New current document");
    expect(await read(historic, 0, 65536)).toEqual(expected);
    expect(client.callsTo("getPageAtVersion")).toBe(2);
  });
  it("counts protocol requests including backend-free NFS and mount calls", async () => {
    const { server, client } = await fixture(["DOCSY"], false);
    client.resetCalls();
    expect(await server.requestCount()).toBe(0);
    await rpc(server, 100003, 0, Buffer.alloc(0));
    await rpc(server, 100005, 0, Buffer.alloc(0));
    expect(await server.requestCount()).toBe(2);
    expect(await server.requestCount()).toBe(2); // Private accounting is not NFS traffic.
    expect(client.requestCount).toBe(0);
    await server.stop();
    await expect(server.requestCount()).rejects.toThrow("stopped");
  });
  it("retains wire attachment identity after rename and old-name replacement", async () => {
    let clock = Date.now();
    const { server, client } = await fixture(["DOCSY"], false, () => clock);
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookup = async (parent: Buffer, name: string) => {
      const reply = await rpc(server, 100003, 3, Buffer.concat([opaque(parent), opaque(Buffer.from(name))]));
      expect(reply.readUInt32BE()).toBe(0);
      return reply.subarray(8, 8 + reply.readUInt32BE(4));
    };
    const directory = await lookup(root, "_attachments");
    const handle = await lookup(directory, "large.bin");
    client.seedAttachment({ id: "a1", pageId: "100", filename: "renamed.bin", bytes: attachmentBytes });
    client.seedAttachment({ id: "a2", pageId: "100", filename: "large.bin", bytes: Buffer.from("replacement") });
    clock += 60_001;
    const read = await rpc(server, 100003, 6, Buffer.concat([opaque(handle), ints(0, 0, 4096)]));
    expect(read.readUInt32BE()).toBe(0);
    expect(read.readUInt32BE(4)).toBe(0); // READ has no separate post-op attributes.
    expect(read.subarray(20, 20 + read.readUInt32BE(16))).toEqual(attachmentBytes.subarray(0, 4096));
    expect(await lookup(directory, "renamed.bin")).toEqual(handle);
    expect(await lookup(directory, "large.bin")).not.toEqual(handle);
    expect(client.callsTo("downloadAttachment")).toBe(1);
    client.seedAttachment({ id: "a1", pageId: "400", filename: "moved.bin", bytes: attachmentBytes });
    clock += 60_001;
    const movedRead = await rpc(server, 100003, 6, Buffer.concat([opaque(handle), ints(0, 0, 4096)]));
    expect(movedRead.readUInt32BE()).toBe(0);
    expect(movedRead.subarray(20, 20 + movedRead.readUInt32BE(16))).toEqual(attachmentBytes.subarray(0, 4096));
    const newOwner = await lookup(root, "child-0-400");
    expect(await lookup(await lookup(newOwner, "_attachments"), "moved.bin")).toEqual(handle);
    expect(client.callsTo("getAttachment")).toBe(1);
    expect(client.callsTo("getPage")).toBe(0);
    client.seedAttachment({ id: "a1", pageId: "300", filename: "foreign.bin", bytes: attachmentBytes });
    clock += 60_001;
    const foreign = await rpc(server, 100003, 6, Buffer.concat([opaque(handle), ints(0, 0, 4096)]));
    expect(foreign.readUInt32BE()).toBe(70);
    expect(client.callsTo("downloadAttachment")).toBe(1);
  });

  it("rejects expired object handles for ACCESS, FSSTAT, FSINFO and PATHCONF", async () => {
    const { server, vfs, client } = await fixture(["DOCSY"], false);
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookup = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from("child-0-400"))]));
    expect(lookup.readUInt32BE()).toBe(0);
    const file = lookup.subarray(8, 8 + lookup.readUInt32BE(4));
    await client.deletePage("400");
    await vfs.index.loadChildren("100", { force: true });
    for (const procedure of [4, 18, 19, 20]) {
      const reply = await rpc(server, 100003, procedure,
        Buffer.concat([opaque(file), procedure === 4 ? ints(63) : Buffer.alloc(0)]));
      expect(reply.readUInt32BE()).toBe(70); // NFS3ERR_STALE
      expect(reply.readUInt32BE(4)).toBe(0); // absent attributes in error arm
      expect(reply.length).toBe(8);
    }
  });

  it("advertises only implemented capabilities and rejects every supported mutation in RO", async () => {
    const { server, client } = await fixture(["DOCSY"], false);
    const mounted = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mounted.subarray(8, 8 + mounted.readUInt32BE(4));
    const info = await rpc(server, 100003, 19, opaque(root));
    expect(info.readUInt32BE()).toBe(0);
    expect(info.readUInt32BE(4)).toBe(1); // post-op attributes
    expect(info.readUInt32BE(info.length - 4)).toBe(0); // no optional capabilities
    const access = await rpc(server, 100003, 4, Buffer.concat([opaque(root), ints(63)]));
    expect(access.readUInt32BE()).toBe(0);
    expect(access.readUInt32BE(access.length - 4)).toBe(3); // READ | LOOKUP, no writes
    const found = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from("_index.md"))]));
    const file = found.subarray(8, 8 + found.readUInt32BE(4));
    const fileAccess = await rpc(server, 100003, 4, Buffer.concat([opaque(file), ints(63)]));
    expect(fileAccess.readUInt32BE()).toBe(0);
    expect(fileAccess.readUInt32BE(fileAccess.length - 4)).toBe(1); // regular files: READ only
    client.resetCalls();
    // The RO capability gate runs before decoding mutation payloads or backend access.
    for (const procedure of [2, 7, 8, 9, 10, 12, 13, 14, 21]) {
      const reply = await rpc(server, 100003, procedure, Buffer.alloc(0));
      expect(reply.readUInt32BE()).toBe(30); // ROFS
    }
    for (const procedure of [11, 15]) { // MKNOD and LINK are not implemented.
      expect(await rpc(server, 100003, procedure, Buffer.alloc(0), 3)).toEqual(Buffer.alloc(0));
    }
    expect(client.requestCount).toBe(0);
  });

  it("advertises and enforces the same 255-byte filename limit", async () => {
    const { server } = await fixture(["DOCSY"], false);
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const pathconf = await rpc(server, 100003, 20, opaque(root));
    expect(pathconf.readUInt32BE()).toBe(0);
    expect(pathconf.readUInt32BE(4)).toBe(1);
    expect(pathconf.readUInt32BE(96)).toBe(255);
    expect(pathconf.readUInt32BE(100)).toBe(1); // no_trunc
    for (const name of ["x".repeat(256), "ü".repeat(128)]) {
      const reply = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from(name))]));
      expect(reply.readUInt32BE()).toBe(63); // NFS3ERR_NAMETOOLONG
    }
    const boundary = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from("x".repeat(255)))]));
    expect(boundary.readUInt32BE()).toBe(2); // valid length, nonexistent object
  });

  it("mounts, resolves a file, reports exact attributes and reads Unicode bytes", async () => {
    const { server, vfs } = await fixture();
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    expect(mount.readUInt32BE()).toBe(0);
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookup = await rpc(server, 100003, 3, Buffer.concat([opaque(root), opaque(Buffer.from("_index.md"))]));
    expect(lookup.readUInt32BE()).toBe(0);
    const file = lookup.subarray(8, 8 + lookup.readUInt32BE(4));
    const attributes = await rpc(server, 100003, 1, opaque(file));
    expect(attributes.readUInt32BE()).toBe(0);
    const expected = Buffer.from(await vfs.readFileBytes("/DOCSY/_index.md"));
    expect(Number(attributes.readBigUInt64BE(24))).toBe(expected.length);
    const modified = (await vfs.stat("/DOCSY/_index.md")).mtime.getTime();
    expect(attributes.readUInt32BE(72)).toBe(Math.floor(modified / 1000));
    expect(attributes.readUInt32BE(76)).toBe((modified % 1000) * 1_000_000);
    let bodyReads = 0;
    const readBytes = vfs.readFileBytes.bind(vfs);
    vfs.readFileBytes = async (path) => { bodyReads++; return readBytes(path); };
    const read = await rpc(server, 100003, 6, Buffer.concat([opaque(file), ints(0, 0, 1024 * 1024)]));
    expect(bodyReads).toBe(1); // READ must not materialize a separate GETATTR body.
    expect(read.readUInt32BE()).toBe(0);
    expect(read.readUInt32BE(4)).toBe(0); // no separate pre-read attributes
    expect(read.readUInt32BE(8)).toBe(expected.length);
    expect(read.readUInt32BE(12)).toBe(1); // EOF
    expect(read.subarray(20, 20 + read.readUInt32BE(16))).toEqual(expected);
    const write = await rpc(server, 100003, 7, Buffer.concat([opaque(file), ints(0, 0, 1, 2), opaque(Buffer.from("x"))]));
    expect(write.readUInt32BE()).toBe(30); // NFS3ERR_ROFS
    await server.stop();
    await server.exited;
  });

  it("keeps a wire filehandle usable after an externally observed page move", async () => {
    const { server, vfs, client } = await fixture(["DOCSY"], false);
    const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
    const lookupHandle = async (parent: Buffer, name: string) => {
      const reply = await rpc(server, 100003, 3, Buffer.concat([opaque(parent), opaque(Buffer.from(name))]));
      expect(reply.readUInt32BE()).toBe(0);
      return reply.subarray(8, 8 + reply.readUInt32BE(4));
    };
    client.seedPage({ id: "900", type: "folder", title: "Folder", spaceKey: "DOCSY", parentId: "400" });
    const attachmentBytes = Buffer.from("Moved attachment Grüße 🐴");
    client.seedAttachment({ id: "moved-attachment", pageId: "400", filename: "proof.txt", bytes: attachmentBytes });
    const directory = await lookupHandle(root, "child-0-400");
    const file = await lookupHandle(directory, "_index.md");
    const folder = await lookupHandle(directory, "folder-900");
    const folderMetadata = await lookupHandle(folder, "_index.md");
    const attachments = await lookupHandle(directory, "_attachments");
    const attachment = await lookupHandle(attachments, "proof.txt");
    const comments = await lookupHandle(directory, ".comments.md");
    const versions = await lookupHandle(directory, ".versions");
    const historic = await lookupHandle(versions, "1.md");
    await client.movePage("400", "401");
    await vfs.index.loadChildren("100", { force: true });
    const read = await rpc(server, 100003, 6, Buffer.concat([opaque(file), ints(0, 0, 65536)]));
    expect(read.readUInt32BE()).toBe(0);
    const expected = Buffer.from(await vfs.readFileBytes("/DOCSY/child-1-401/child-0-400/_index.md"));
    expect(read.subarray(20, 20 + read.readUInt32BE(16))).toEqual(expected);
    const attachmentRead = await rpc(server, 100003, 6, Buffer.concat([opaque(attachment), ints(0, 0, 65536)]));
    expect(attachmentRead.readUInt32BE()).toBe(0);
    expect(attachmentRead.subarray(20, 20 + attachmentRead.readUInt32BE(16))).toEqual(attachmentBytes);
    expect(await lookupHandle(attachments, "..")).toEqual(directory);
    expect(await lookupHandle(directory, "_attachments")).toEqual(attachments);
    expect(await lookupHandle(attachments, "proof.txt")).toEqual(attachment);
    const metadataRead = await rpc(server, 100003, 6, Buffer.concat([opaque(folderMetadata), ints(0, 0, 65536)]));
    expect(metadataRead.readUInt32BE()).toBe(0);
    expect(metadataRead.subarray(20, 20 + metadataRead.readUInt32BE(16)))
      .toEqual(Buffer.from(await vfs.readFileBytes("/DOCSY/child-1-401/child-0-400/folder-900/_index.md")));
    expect(await lookupHandle(folder, "_index.md")).toEqual(folderMetadata);
    expect(await lookupHandle(folder, "..")).toEqual(directory);
    expect(await lookupHandle(directory, "folder-900")).toEqual(folder);
    const newParent = await lookupHandle(root, "child-1-401");
    expect(await lookupHandle(directory, "..")).toEqual(newParent);
    expect(await lookupHandle(newParent, "child-0-400")).toEqual(directory);
    expect(await lookupHandle(directory, "_index.md")).toEqual(file);
    expect(await lookupHandle(directory, ".comments.md")).toEqual(comments);
    expect(await lookupHandle(directory, ".versions")).toEqual(versions);
    expect(await lookupHandle(versions, "1.md")).toEqual(historic);
    for (const [handle, suffix] of [[comments, ".comments.md"], [historic, ".versions/1.md"]] as const) {
      const body = await rpc(server, 100003, 6, Buffer.concat([opaque(handle), ints(0, 0, 65536)]));
      expect(body.readUInt32BE()).toBe(0);
      expect(body.subarray(20, 20 + body.readUInt32BE(16))).toEqual(
        Buffer.from(await vfs.readFileBytes(`/DOCSY/child-1-401/child-0-400/${suffix}`)));
    }
  });

  it("rejects old handles after restarting a helper even when file IDs are reused", async () => {
    const first = await fixture(["DOCSY"], false);
    const mounted = await rpc(first.server, 100005, 1, opaque(Buffer.from("/")));
    const oldRoot = mounted.subarray(8, 8 + mounted.readUInt32BE(4));
    await first.server.stop();
    const second = await fixture(["DOCSY"], false);
    const remounted = await rpc(second.server, 100005, 1, opaque(Buffer.from("/")));
    const freshRoot = remounted.subarray(8, 8 + remounted.readUInt32BE(4));
    expect(freshRoot).not.toEqual(oldRoot);
    let stats = 0;
    const stat = second.vfs.stat.bind(second.vfs);
    second.vfs.stat = async path => { stats++; return stat(path); };
    expect((await rpc(second.server, 100003, 1, opaque(oldRoot))).readUInt32BE()).toBe(70); // STALE
    expect((await rpc(second.server, 100003, 6, Buffer.concat([opaque(oldRoot), ints(0, 0, 16)]))).readUInt32BE()).toBe(70);
    expect(stats).toBe(0); // Foreign session handles never reach the authoritative VFS.
    expect((await rpc(second.server, 100003, 1, opaque(freshRoot))).readUInt32BE()).toBe(0);
    expect(stats).toBeGreaterThan(0);
  });

  it("closes oversized or excessively fragmented RPCs and survives malformed XDR lengths", async () => {
    const { server } = await fixture(["DOCSY"], false);
    const maximum = 4 * 1024 * 1024;
    const call = ints(9, 0, 2, 100003, 3, 0, 0, 0, 0, 0);
    const invalidAuth = ints(9, 0, 2, 100003, 3, 0, 0, 0xffffffff);
    const authUnix = ints(0, 0, 0, 0, 0xffffffff); // stamp, hostname, uid, gid, group count
    const invalidGroups = Buffer.concat([ints(9, 0, 2, 100003, 3, 0, 1), opaque(authUnix), ints(0, 0)]);
    for (const attack of [
      ints(0x80000000 + maximum + 1),
      Buffer.concat([ints(maximum), Buffer.alloc(maximum), ints(0x80000001)]),
      Buffer.alloc(4 * 1025), // empty non-final fragments still consume the fragment budget
      Buffer.concat([ints(0x80000000 + invalidAuth.length), invalidAuth]),
      Buffer.concat([ints(0x80000000 + invalidGroups.length), invalidGroups]),
    ]) {
      await new Promise<void>((done, reject) => {
        const socket = connect(server.port, "127.0.0.1");
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Malformed RPC was not disconnected")); }, 3000);
        socket.on("connect", () => socket.write(attack));
        socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET" && error.code !== "EPIPE") reject(error); });
        socket.on("close", () => { clearTimeout(timeout); done(); });
      });
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    }
    // A valid fragmented record is accepted, including a header split across writes.
    await new Promise<void>((done, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      socket.setTimeout(3000, () => socket.destroy(new Error("Fragmented RPC timed out")));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(ints(12).subarray(0, 2));
        socket.write(Buffer.concat([ints(12).subarray(2), call.subarray(0, 12), ints(0x80000000 + call.length - 12), call.subarray(12)]));
      });
      let reply = Buffer.alloc(0);
      socket.on("data", (data) => {
        reply = Buffer.concat([reply, Buffer.from(data)]);
        if (reply.length >= 28) {
          try { expect(reply.readUInt32BE(4)).toBe(9); socket.destroy(); done(); }
          catch (error) { socket.destroy(); reject(error); }
        }
      });
    });
  });

  it("bounds persistent connections and pipelined transaction history", async () => {
    const { server } = await fixture(["DOCSY"], false);
    const sockets: ReturnType<typeof connect>[] = [];
    const nullCall = (id: number) => Buffer.concat([ints(0x80000028), ints(id, 0, 2, 100003, 3, 0, 0, 0, 0, 0)]);
    try {
      for (let i = 0; i < 32; i++) {
        await new Promise<void>((done, reject) => {
          const socket = connect(server.port, "127.0.0.1");
          sockets.push(socket);
          socket.setTimeout(5000, () => socket.destroy(new Error("Connection admission timed out")));
          socket.on("error", reject);
          socket.on("connect", () => socket.write(nullCall(i)));
          socket.once("data", () => { socket.setTimeout(0); done(); });
        });
      }
      await new Promise<void>((done, reject) => {
        const extra = connect(server.port, "127.0.0.1");
        extra.setTimeout(3000, () => extra.destroy(new Error("Connection cap not enforced")));
        extra.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
        extra.on("close", () => done());
      });
    } finally {
      await Promise.all(sockets.map((socket) => new Promise<void>((done) => { socket.once("close", done); socket.destroy(); })));
    }
    // Exercise backpressure and the finite replay table with unique pipelined RPCs.
    const received = await new Promise<number[]>((done, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let remaining = Buffer.alloc(0);
      const ids: number[] = [];
      socket.setTimeout(10000, () => socket.destroy(new Error("Pipeline did not complete")));
      socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
      socket.on("connect", () => socket.write(Buffer.concat(Array.from({ length: 4097 }, (_, i) => nullCall(i)))));
      socket.on("data", (data) => {
        remaining = Buffer.concat([remaining, Buffer.from(data)]);
        while (remaining.length >= 28) {
          ids.push(remaining.readUInt32BE(4));
          remaining = remaining.subarray(28);
        }
      });
      socket.on("close", () => done(ids));
    });
    expect(received).toEqual(Array.from({ length: 4096 }, (_, i) => i));
    expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  }, 20000);

  it("disconnects a stalled partial record without blocking other clients", async () => {
    const { server } = await fixture(["DOCSY"], false);
    const socket = connect(server.port, "127.0.0.1");
    const closed = new Promise<void>((done, reject) => {
      socket.setTimeout(65000, () => socket.destroy(new Error("Server read deadline was not enforced")));
      socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
      socket.on("close", done);
      socket.on("connect", () => socket.write(Buffer.from([0x80])));
    });
    try {
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
      await closed;
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    } finally { socket.destroy(); }
  }, 70000);

  it("disconnects a blocked response reader without stalling other clients", async () => {
    const { server, vfs } = await fixture(["DOCSY"], false);
    const mounted = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
    let file = mounted.subarray(8, 8 + mounted.readUInt32BE(4));
    for (const name of ["_attachments", "large.bin"]) {
      const found = await rpc(server, 100003, 3, Buffer.concat([opaque(file), opaque(Buffer.from(name))]));
      expect(found.readUInt32BE()).toBe(0);
      file = found.subarray(8, 8 + found.readUInt32BE(4));
    }
    let reads = 0;
    const read = vfs.readFileBytes.bind(vfs);
    vfs.readFileBytes = async path => { reads++; return read(path); };
    const result = promisify(execFile)("python3", ["-c", `
import base64, json, socket, struct, sys, time
handle = base64.b64decode(sys.argv[2])
def words(*values):
    return struct.pack('>' + 'I' * len(values), *values)
with socket.socket() as client:
    client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    client.settimeout(5)
    client.connect(('127.0.0.1', int(sys.argv[1])))
    for xid in range(32):
        request = words(xid + 100, 0, 2, 100003, 3, 6, 0, 0, 0, 0)
        request += words(len(handle)) + handle + words(0, 0, 1024 * 1024)
        client.sendall(words(0x80000000 + len(request)) + request)
    # Keep the negotiated receive window small until the production 30s write
    # deadline has elapsed. Then drain queued bytes to observe FIN/reset.
    time.sleep(35)
    received = 0
    while True:
        try:
            data = client.recv(1024 * 1024)
        except ConnectionResetError:
            break
        if not data:
            break
        received += len(data)
    print(json.dumps({'received': received}))
`, String(server.port), file.toString("base64")], { timeout: 45_000 });
    // Attach a rejection handler immediately while the independent RPC runs.
    void result.catch(() => {});
    try {
      await Bun.sleep(500);
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
      const { stdout } = await result;
      expect(JSON.parse(stdout).received).toBeLessThan(32 * 1024 * 1024);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThan(32);
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    } finally {
      result.child.kill("SIGTERM");
      await result.catch(() => {});
    }
  }, 50_000);

  it("enforces the dispatch deadline across individually responsive bridge calls", async () => {
    const child = spawn(resolve(helperPath!), ["0"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const exited = new Promise<void>((done, reject) => {
      child.once("close", () => done());
      child.once("error", reject);
    });
    const frames = readNfsFrames(child.stdout);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let calls = 0;
    let socket: ReturnType<typeof connect> | undefined;
    let pump: Promise<void> | undefined;
    try {
      const hello = (await frames.next()).value as { port: number };
      const server = { port: hello.port };
      pump = (async () => {
        for await (const raw of frames) {
          const request = raw as { id: number; op: string; args: { file: number } };
          calls++;
          // LOOKUP performs directory attributes, lookup, then object attributes.
          // Each responds before the bridge's 60s limit; together they exceed 120s.
          const timer = setTimeout(() => {
            timers.delete(timer);
            const result = request.op === "lookup" ? 2 : {
              id: request.args.file, directory: request.args.file === 1, size: 0, mtime: 0,
            };
            child.stdin.write(encodeNfsFrame({ id: request.id, result }));
          }, 45_000);
          timers.add(timer);
        }
      })();
      const mounted = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
      const root = mounted.subarray(8, 8 + mounted.readUInt32BE(4));
      const payload = Buffer.concat([ints(19, 0, 2, 100003, 3, 3, 0, 0, 0, 0),
        opaque(root), opaque(Buffer.from("slow.md"))]);
      const started = performance.now();
      socket = connect(server.port, "127.0.0.1");
      const closed = new Promise<void>((done, reject) => {
        socket!.setTimeout(130_000, () => socket!.destroy(new Error("Dispatch deadline not enforced")));
        socket!.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
        socket!.on("data", () => reject(new Error("Slow RPC replied instead of hitting dispatch deadline")));
        socket!.on("close", done);
        socket!.on("connect", () => socket!.write(Buffer.concat([ints(0x80000000 + payload.length), payload])));
      });
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
      await closed;
      expect(performance.now() - started).toBeGreaterThanOrEqual(118_000);
      expect(calls).toBe(3);
      expect(await rpc(server, 100003, 0, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    } finally {
      for (const timer of timers) clearTimeout(timer);
      socket?.destroy();
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await exited; await pump; }
      finally { clearTimeout(kill); }
    }
  }, 140_000);

  for (const procedure of [16, 17]) {
    it(`paginates NFS procedure ${procedure} without repeating or omitting entries`, async () => {
      const { server, vfs, client } = await fixture(["DOCSY"], false);
      const mount = await rpc(server, 100005, 1, opaque(Buffer.from("/")));
      const root = mount.subarray(8, 8 + mount.readUInt32BE(4));
      for (const budget of [0, 128, 129, 256]) {
        const rejected = await rpc(server, 100003, procedure, Buffer.concat([
          opaque(root), Buffer.alloc(16), procedure === 16 ? ints(budget) : ints(512, budget),
        ]));
        expect(rejected.readUInt32BE()).toBe(10005); // NFS3ERR_TOOSMALL, helper remains usable
      }
      if (procedure === 17) {
        const rejected = await rpc(server, 100003, procedure, Buffer.concat([
          opaque(root), Buffer.alloc(16), ints(0, 768),
        ]));
        expect(rejected.readUInt32BE()).toBe(10005);
      }
      let cookie: Buffer = Buffer.alloc(8);
      let verifier: Buffer = Buffer.alloc(8);
      const names: string[] = [];
      let pages = 0;
      for (;;) {
        const reply = await rpc(server, 100003, procedure, Buffer.concat([
          opaque(root), cookie, verifier, procedure === 16 ? ints(512) : ints(512, 768),
        ]));
        expect(reply.readUInt32BE()).toBe(0);
        let offset = 8 + (reply.readUInt32BE(4) ? 84 : 0);
        verifier = reply.subarray(offset, offset + 8);
        offset += 8;
        let received = 0;
        while (reply.readUInt32BE(offset)) {
          offset += 12; // entry present and file ID
          const length = reply.readUInt32BE(offset);
          offset += 4;
          const name = reply.subarray(offset, offset + length).toString();
          expect(names).not.toContain(name);
          names.push(name);
          offset += (length + 3) & ~3;
          cookie = reply.subarray(offset, offset + 8);
          offset += 8;
          if (procedure === 17) {
            const attr = reply.readUInt32BE(offset);
            offset += 4 + (attr ? 84 : 0);
            const handle = reply.readUInt32BE(offset);
            offset += 4;
            if (handle) offset += 4 + ((reply.readUInt32BE(offset) + 3) & ~3);
          }
          received++;
        }
        pages++;
        if (reply.readUInt32BE(offset + 4)) break;
        expect(received).toBeGreaterThan(0);
        expect(pages).toBeLessThan(100);
      }
      expect(client.callsTo("getPageDirectChildren")).toBe(1);
      expect(Array.from({ length: 32 }, (_, i) => vfs.index.isUnloaded(String(400 + i))).every(Boolean)).toBe(true);
      const expired = await rpc(server, 100003, procedure, Buffer.concat([
        opaque(root), cookie, Buffer.alloc(8, 255), procedure === 16 ? ints(512) : ints(512, 768),
      ]));
      expect(expired.readUInt32BE()).toBe(10003); // NFS3ERR_BAD_COOKIE
      const originalReaddir = vfs.readdir.bind(vfs);
      vfs.readdir = async (path) => (await originalReaddir(path)).filter((entry) => entry.name !== "child-0-400");
      try {
        const changed = await rpc(server, 100003, procedure, Buffer.concat([
          opaque(root), cookie, verifier, procedure === 16 ? ints(512) : ints(512, 768),
        ]));
        expect(changed.readUInt32BE()).toBe(10003);
      } finally { vfs.readdir = originalReaddir; }
      expect(pages).toBeGreaterThan(1);
      expect(names.sort()).toEqual([...INDEXER_SHIELDS, ...SHIELD_DIRECTORIES,
        ...(await vfs.readdir("/DOCSY")).map((e) => e.name)].sort());
    });
  }

  it.skipIf(process.env.ATLCLI_NFS_KERNEL !== "1")("writes and fsyncs existing pages through a native RW kernel mount", async () => {
    const { server, journal, client, vfs } = await fixture(["DOCSY"], false, () => Date.now(), true);
    const mountpoint = mkdtempSync(join(tmpdir(), "atlcli-nfs-rw-"));
    let mounted = false;
    cleanups.push(async () => {
      if (mounted) {
        const command = platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint];
        let status = await runMountCommand(command);
        for (let attempt = 0; status !== 0 && attempt < 10; attempt++) {
          await Bun.sleep(100); status = await runMountCommand(command);
        }
        if (status !== 0) throw new Error(`Test mount remains attached: ${mountpoint}`);
      }
      rmSync(mountpoint, { recursive: true, force: true });
    });
    // RW requires hard retries. This private test does not enable the CLI RW option.
    const options = nfsMountOptionsFor(platform(), server.port).replace(",ro,soft,", ",rw,hard,");
    const command = platform() === "linux"
      ? ["sudo", "-n", "mount", "-t", "nfs", "-o", options, "127.0.0.1:/", mountpoint]
      : ["mount_nfs", "-o", options, "127.0.0.1:/", mountpoint];
    expect(await runMountCommand(command)).toBe(0);
    mounted = true;
    const path = join(mountpoint, "_index.md");
    const metadata = await stat(path);
    expect(metadata.uid).toBe(process.getuid!());
    expect(metadata.mode & 0o777).toBe(0o644);
    const bytes = Buffer.from((await vfs.readFile("/DOCSY/_index.md")).replace("Grüße 🐴", "Native Grüße 🐴"));
    const file = await open(path, "r+");
    try {
      await file.truncate(0);
      const cut = bytes.indexOf(Buffer.from("🐴")) + 1;
      expect((await file.write(bytes.subarray(cut), 0, bytes.length - cut, cut)).bytesWritten).toBe(bytes.length - cut);
      expect((await file.write(bytes.subarray(0, cut), 0, cut, 0)).bytesWritten).toBe(cut);
      await file.sync();
      expect(Buffer.from(journal!.get("100")!.bytes)).toEqual(bytes);
      const read = Buffer.alloc(bytes.length);
      expect((await file.read(read, 0, read.length, 0)).bytesRead).toBe(bytes.length);
      expect(read).toEqual(bytes);
      expect((await file.stat()).size).toBe(bytes.length);
    } finally { await file.close(); }
    const deadline = Date.now() + 3000;
    while (journal!.pending().length && Date.now() < deadline) await Bun.sleep(20);
    expect(journal!.pending()).toHaveLength(0);
    expect(client.callsTo("updatePage")).toBe(1);
    expect(client.peekPage("100")?.storage).toContain("Native Grüße 🐴");
  }, 30000);

  for (const { spaces, attachments, visibility = false, mutation = false, glow = false, snapshot = false } of [
    { spaces: ["DOCSY"], attachments: false },
    { spaces: ["DOCSY", "mayflower"], attachments: false },
    { spaces: ["DOCSY"], attachments: true },
    { spaces: ["DOCSY"], attachments: false, visibility: true },
    { spaces: ["DOCSY"], attachments: false, mutation: true },
    { spaces: ["DOCSY"], attachments: false, glow: true },
    { spaces: ["DOCSY", "mayflower"], attachments: false, snapshot: true },
  ]) {
    it.skipIf(process.env.ATLCLI_NFS_KERNEL !== "1" || (glow && !process.env.ATLCLI_NFS_GLOW))(`reads full content through native kernel mount (${spaces.join(",")}${attachments ? "; attachments" : ""}${visibility ? "; external changes" : ""}${mutation ? "; directory mutation" : ""}${glow ? "; Glow" : ""}${snapshot ? "; snapshot" : ""})`, async () => {
      let clock = Date.now();
      const { server, vfs, client } = await fixture(spaces, attachments || visibility || mutation || glow || snapshot ? false : undefined,
        visibility || mutation || snapshot ? () => clock : undefined);
      if (snapshot) client.seedPage({ id: "400", title: "Child 0", spaceKey: "DOCSY", parentId: "100",
        storage: `<p>${"Historical Grüße 🐴. ".repeat(2000)}</p>` });
      if (mutation) {
        client.seedPage({ id: "9000", title: "Mutation", spaceKey: "DOCSY", parentId: "100", storage: "<p>Directory</p>" });
        for (let i = 1; i <= 600; i++) client.seedPage({ id: String(9000 + i), title: `Item ${i}`,
          spaceKey: "DOCSY", parentId: "9000", storage: "<p>Child</p>" });
      }
      const mountpoint = mkdtempSync(join(tmpdir(), "atlcli-nfs-kernel-"));
      let mounted = false;
      cleanups.push(async () => {
        if (mounted) {
          const command = platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint];
          let status = await runMountCommand(command);
          // Linux can retain a just-closed read briefly; never force or lazily detach.
          for (let attempt = 0; status !== 0 && attempt < 10; attempt++) {
            await Bun.sleep(100);
            status = await runMountCommand(command);
          }
          if (status !== 0) throw new Error(`Test mount remains attached: ${mountpoint}`);
        }
        rmSync(mountpoint, { recursive: true, force: true });
      });
      const options = nfsMountOptionsFor(platform(), server.port);
      const command = platform() === "linux"
        ? ["sudo", "-n", "mount", "-t", "nfs", "-o", options, "127.0.0.1:/", mountpoint]
        : ["mount_nfs", "-o", options, "127.0.0.1:/", mountpoint];
      expect(await runMountCommand(command)).toBe(0);
      mounted = true;
      if (spaces.length > 1) {
        const directory = await opendir(mountpoint);
        const names: string[] = [];
        for await (const entry of directory) names.push(entry.name);
        expect(names.sort()).toEqual([...INDEXER_SHIELDS, ...SHIELD_DIRECTORIES, "DOCSY", "mayflower"].sort());
      }
      const marker = await open(join(mountpoint, ".metadata_never_index"), "r");
      try { expect((await marker.readFile()).length).toBe(0); }
      finally { await marker.close(); }
      const events = await opendir(join(mountpoint, ".fseventsd"));
      const eventNames: string[] = [];
      for await (const entry of events) eventNames.push(entry.name);
      expect(eventNames).toEqual([]);
      const bodyPath = join(mountpoint, ...(spaces.length > 1 ? ["DOCSY"] : []), "_index.md");
      const file = await open(bodyPath, "r");
      try {
        expect(await file.readFile()).toEqual(Buffer.from(await vfs.readFileBytes("/DOCSY/_index.md")));
      } finally { await file.close(); }
      if (snapshot) {
        const expected = Buffer.from(await vfs.readFileBytes("/DOCSY/child-0-400/.versions/1.md"));
        const historical = await open(join(mountpoint, "DOCSY/child-0-400/.versions/1.md"), "r");
        try {
          const cut = expected.indexOf(Buffer.from("🐴")) + 1;
          const first = Buffer.alloc(cut);
          expect((await historical.read(first, 0, cut, 0)).bytesRead).toBe(cut);
          client.bumpVersion("400", "<p>New native current body</p>");
          await client.movePage("400", "300");
          clock += 60_001;
          vfs.cache!.forgetPage("400");
          const rest = Buffer.alloc(expected.length - cut);
          expect((await historical.read(rest, 0, rest.length, cut)).bytesRead).toBe(rest.length);
          expect(Buffer.concat([first, rest])).toEqual(expected);
        } finally { await historical.close(); }
        const moved = await open(join(mountpoint, "mayflower/child-0-400/.versions/1.md"), "r");
        try { expect(await moved.readFile()).toEqual(expected); }
        finally { await moved.close(); }
      }
      if (glow) {
        const probe = await promisify(execFile)("python3", [
          resolve(import.meta.dir, "../../../../scripts/bench/glow-probe.py"),
          process.env.ATLCLI_NFS_GLOW!, join(mountpoint, "child-0-400"), "Test",
        ], { timeout: 20_000 });
        const timing = JSON.parse(probe.stdout);
        expect(timing.listingMs).toBeLessThan(15_000);
        expect(timing.renderMs).toBeLessThan(15_000);
        console.error(`Glow native listing ${timing.listingMs.toFixed(1)}ms; selected view ${timing.renderMs.toFixed(1)}ms`);
      }
      if (mutation) {
        const path = join(mountpoint, "mutation-9000");
        const before = (await vfs.readdir("/DOCSY/mutation-9000")).map(entry => entry.name).sort();
        const cursor = await opendir(path, { bufferSize: 1 });
        const seen: string[] = [];
        let restart = false;
        try {
          const first = await cursor.read();
          expect(first).not.toBeNull();
          seen.push(first!.name);
          await client.deletePage("9500");
          await client.updatePage({ id: "9501", title: "Renamed", storage: "<p>Child</p>", version: 2 });
          client.seedPage({ id: "9999", title: "Inserted", spaceKey: "DOCSY", parentId: "9000", storage: "<p>New</p>" });
          clock += 60_001;
          try {
            for (;;) {
              const entry = await cursor.read();
              if (!entry) break;
              seen.push(entry.name);
              expect(seen.length).toBeLessThan(1300);
            }
          } catch (error) {
            if (!["EIO", "EINVAL", "ESTALE"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            restart = true; // A changed cookie may require a caller to restart.
          }
        } finally { await cursor.close(); }
        if (!restart) {
          expect(new Set(seen).size).toBe(seen.length);
          const stable = (names: string[]) => names.filter(name =>
            !["item-500-9500", "item-501-9501", "renamed-9501", "inserted-9999"].includes(name)).sort();
          expect(stable(seen)).toEqual(stable(before));
        }
        const expected = before.filter(name => !["item-500-9500", "item-501-9501"].includes(name))
          .concat("renamed-9501", "inserted-9999").sort();
        let after: string[] = [];
        const deadline = performance.now() + 5000;
        do {
          after = [];
          for await (const entry of await opendir(path)) after.push(entry.name);
          after.sort();
          if (JSON.stringify(after) === JSON.stringify(expected)) break;
          await Bun.sleep(100);
        } while (performance.now() < deadline);
        expect(after).toEqual(expected);
      }
      if (visibility) {
        const missing = join(mountpoint, "new-page-999", "_index.md");
        await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
        await client.updatePage({ id: "100", title: "Home", storage: "<p>Externally updated Grüße 🐴</p>", version: 2 });
        client.seedPage({ id: "999", title: "New Page", spaceKey: "DOCSY", parentId: "100", storage: "<p>New</p>" });
        // Move only the core clock past its production TTL. Kernel time is real;
        // do not force-refresh the index or flush OS caches.
        clock += 60_001;
        const started = performance.now();
        let updated = false;
        let created = false;
        while (performance.now() - started < 5000) {
          const current = await open(bodyPath, "r");
          try {
            const bytes = await current.readFile();
            updated = bytes.toString().includes("Externally updated Grüße 🐴");
          } finally { await current.close(); }
          try { created = (await stat(missing)).isFile(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (updated && created) break;
          await Bun.sleep(100);
        }
        expect(updated).toBe(true);
        expect(created).toBe(true);
        const refreshed = await open(bodyPath, "r");
        try { expect(await refreshed.readFile()).toEqual(Buffer.from(await vfs.readFileBytes("/DOCSY/_index.md"))); }
        finally { await refreshed.close(); }

        const commentsPath = join(mountpoint, ".comments.md");
        const seedComment = (body: string) => client.seedComments("100", {
          pageId: "100", lastSynced: "2026-09-17T00:00:00Z", inlineComments: [],
          footerComments: [{ id: "c1", author: { displayName: "Ada" },
            created: "2026-09-17T00:00:00Z", body, status: "open", replies: [] }],
        });
        seedComment("<p>Comment A</p>");
        const readComments = async () => {
          const file = await open(commentsPath, "r");
          try { return await file.readFile(); }
          finally { await file.close(); }
        };
        const originalComments = await readComments();
        expect(originalComments.toString()).toContain("Comment A");
        const beforeComments = await stat(commentsPath);
        const pageVersion = (await client.getPageVersions(["100"])).get("100")!.version;
        seedComment("<p>Comment B</p>");
        clock += 60_001;
        const expectedComments = Buffer.from(originalComments.toString().replace("Comment A", "Comment B"));
        expect(expectedComments.length).toBe(originalComments.length);
        const commentStarted = performance.now();
        let actualComments = originalComments;
        while (performance.now() - commentStarted < 5000) {
          actualComments = await readComments();
          if (actualComments.equals(expectedComments)) break;
          await Bun.sleep(100);
        }
        expect(actualComments).toEqual(expectedComments);
        expect((await stat(commentsPath)).mtimeMs).toBeGreaterThan(beforeComments.mtimeMs);
        expect((await client.getPageVersions(["100"])).get("100")!.version).toBe(pageVersion);
      }
      const probe = await promisify(execFile)("python3", ["-c", `
import errno, fcntl, subprocess, sys
child = """
import errno, fcntl, sys
with open(sys.argv[1], 'rb') as file:
    try:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EAGAIN):
            raise
        sys.exit(10)
"""
with open(sys.argv[1], 'rb') as file:
    fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert subprocess.run([sys.executable, '-c', child, sys.argv[1]], timeout=2).returncode == 10
    fcntl.flock(file, fcntl.LOCK_UN)
    assert subprocess.run([sys.executable, '-c', child, sys.argv[1]], timeout=2).returncode == 0
    fcntl.lockf(file, fcntl.LOCK_SH | fcntl.LOCK_NB)
    fcntl.lockf(file, fcntl.LOCK_UN)
print('local locks verified')
`, bodyPath], { timeout: 5000 });
      expect(probe.stdout.trim()).toBe("local locks verified");
      if (attachments) {
        const attachment = join(mountpoint, "_attachments", "large.bin");
        const directory = await opendir(join(mountpoint, "_attachments"));
        const names: string[] = [];
        for await (const entry of directory) names.push(entry.name);
        expect(names).toEqual(["large.bin"]);
        expect((await stat(attachment)).size).toBe(attachmentBytes.length);
        expect(client.callsTo("downloadAttachment")).toBe(0);
        for (let pass = 0; pass < 2; pass++) {
          const opened = await open(attachment, "r");
          try { expect(await opened.readFile()).toEqual(attachmentBytes); }
          finally { await opened.close(); }
        }
        expect(client.callsTo("downloadAttachment")).toBe(1);
      }
    }, 30000);
  }
});
