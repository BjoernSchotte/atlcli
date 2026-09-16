import { afterEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
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
import { startNfsServer, type RunningNfsServer } from "./nfs-bridge.js";

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
async function rpc(server: RunningNfsServer, program: number, procedure: number, body: Buffer): Promise<Buffer> {
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
          expect([...Array(6)].map((_, i) => response.readUInt32BE(4 + i * 4))).toEqual([7, 1, 0, 0, 0, 0]);
          resolveReply(response.subarray(28));
        } catch (error) { reject(error); }
      }
    });
    socket.on("end", () => reject(new Error("RPC closed before reply")));
  });
}
async function fixture(spaces = ["DOCSY"], live = process.env.ATLCLI_NFS_LIVE === "1") {
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
    client: profile ? new ConfluenceClient(profile) : client, spaces, mode: "ro", allowDelete: false, offline: false, cacheDir });
  cleanups.push(async () => { await vfs.close(); rmSync(cacheDir, { recursive: true, force: true }); });
  const server = await startNfsServer({ vfs, spaces, helperPath: resolve(helperPath!) });
  cleanups.push(() => server.stop());
  return { server, vfs, client };
}

describe.skipIf(!helperPath)("real Rust NFS helper over TCP and Bun pipes", () => {
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
      expect(names.sort()).toEqual((await vfs.readdir("/DOCSY")).map((e) => e.name).sort());
    });
  }

  for (const { spaces, attachments } of [
    { spaces: ["DOCSY"], attachments: false },
    { spaces: ["DOCSY", "mayflower"], attachments: false },
    { spaces: ["DOCSY"], attachments: true },
  ]) {
    it.skipIf(process.env.ATLCLI_NFS_KERNEL !== "1")(`reads full content through native kernel mount (${spaces.join(",")}${attachments ? "; attachments" : ""})`, async () => {
      const { server, vfs, client } = await fixture(spaces, attachments ? false : undefined);
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
      const options = `vers=3,tcp,ro,soft,timeo=10,retrans=2,port=${server.port},mountport=${server.port}`;
      const command = platform() === "linux"
        ? ["sudo", "-n", "mount", "-t", "nfs", "-o", `${options},nolock`, "127.0.0.1:/", mountpoint]
        : ["mount_nfs", "-o", `${options},nolocks`, "127.0.0.1:/", mountpoint];
      expect(await runMountCommand(command)).toBe(0);
      mounted = true;
      if (spaces.length > 1) {
        const directory = await opendir(mountpoint);
        const names: string[] = [];
        for await (const entry of directory) names.push(entry.name);
        expect(names.sort()).toEqual(["DOCSY", "mayflower"]);
      }
      const file = await open(join(mountpoint, ...(spaces.length > 1 ? ["DOCSY"] : []), "_index.md"), "r");
      try {
        expect(await file.readFile()).toEqual(Buffer.from(await vfs.readFileBytes("/DOCSY/_index.md")));
      } finally { await file.close(); }
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
