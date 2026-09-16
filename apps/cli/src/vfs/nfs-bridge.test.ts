import { afterEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { open, opendir } from "node:fs/promises";
import { getActiveProfile, loadConfig } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { runMountCommand } from "../commands/wiki-mount.js";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { startNfsServer, type RunningNfsServer } from "./nfs-bridge.js";

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
  const profile = live ? getActiveProfile(await loadConfig(), "mayflower") : undefined;
  if (live && !profile) throw new Error("Missing mayflower test profile");
  const vfs = await ConfluenceVfsImpl.open({ profile: profile?.name ?? "fixture",
    client: profile ? new ConfluenceClient(profile) : client, spaces, mode: "ro", allowDelete: false, offline: false, cacheDir });
  cleanups.push(async () => { await vfs.close(); rmSync(cacheDir, { recursive: true, force: true }); });
  const server = await startNfsServer({ vfs, spaces, helperPath: resolve(helperPath!) });
  cleanups.push(() => server.stop());
  return { server, vfs };
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
    const read = await rpc(server, 100003, 6, Buffer.concat([opaque(file), ints(0, 0, 1024 * 1024)]));
    expect(read.readUInt32BE()).toBe(0);
    expect(read.readUInt32BE(4)).toBe(1); // post-op attributes present (84 bytes)
    expect(read.readUInt32BE(92)).toBe(expected.length);
    expect(read.readUInt32BE(96)).toBe(1); // EOF
    expect(read.subarray(104, 104 + read.readUInt32BE(100))).toEqual(expected);
    const write = await rpc(server, 100003, 7, Buffer.concat([opaque(file), ints(0, 0, 1, 2), opaque(Buffer.from("x"))]));
    expect(write.readUInt32BE()).toBe(30); // NFS3ERR_ROFS
    await server.stop();
    await server.exited;
  });

  for (const procedure of [16, 17]) {
    it(`paginates NFS procedure ${procedure} without repeating or omitting entries`, async () => {
      const { server, vfs } = await fixture(["DOCSY"], false);
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

  for (const spaces of [["DOCSY"], ["DOCSY", "mayflower"]]) {
    it.skipIf(process.env.ATLCLI_NFS_KERNEL !== "1")(`reads full content through native kernel mount (${spaces.join(",")})`, async () => {
      const { server, vfs } = await fixture(spaces);
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
    }, 30000);
  }
});
