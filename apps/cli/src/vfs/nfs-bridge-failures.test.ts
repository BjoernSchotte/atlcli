import { afterEach, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConfluenceVfs } from "@atlcli/confluence-vfs";
import { encodeNfsFrame, readNfsFrames, NFS_BRIDGE_VERSION } from "./nfs-framing.js";
import { startNfsServer } from "./nfs-bridge.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
// Handshake failures must not perform any VFS operation.
const vfs = new Proxy({} as ConfluenceVfs, { get() { throw new Error("Unexpected VFS access"); } });
function helper(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "nfs-helper-fault-"));
  directories.push(directory);
  const path = join(directory, "helper.js");
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
}
function send(value: unknown): string {
  return `process.stdout.write(Buffer.from(${JSON.stringify(encodeNfsFrame(value).toString("base64"))}, "base64"));`;
}

it("fails promptly when the helper executable is missing", async () => {
  await expect(startNfsServer({ vfs, spaces: ["DOCSY"], helperPath: "/no-such-nfs-helper" })).rejects.toThrow("NFS helper");
});

it("rejects incompatible version, capability and bound-port handshakes", async () => {
  for (const message of [
    { hello: 999, mode: "ro", port: 12345 },
    { hello: NFS_BRIDGE_VERSION, mode: "rw", port: 12345 },
    { hello: NFS_BRIDGE_VERSION, mode: "ro", port: 0 },
    { hello: NFS_BRIDGE_VERSION, mode: "ro", port: 12346 },
  ]) {
    await expect(startNfsServer({ vfs, spaces: ["DOCSY"], port: 12345,
      helperPath: helper(`${send(message)}setInterval(()=>{},1000);`) })).rejects.toThrow("handshake");
  }
});

it("detects early EOF and malformed frames without leaving a helper alive", async () => {
  await expect(startNfsServer({ vfs, spaces: ["DOCSY"], helperPath: helper("process.exit(0);") })).rejects.toThrow("handshake");
  await expect(startNfsServer({ vfs, spaces: ["DOCSY"],
    helperPath: helper("process.stdout.write(Buffer.from([255,255,255,255]));setInterval(()=>{},1000);") })).rejects.toThrow("frame size");
});

it("exposes helper death after readiness and allows repeated stop", async () => {
  const server = await startNfsServer({ vfs, spaces: ["DOCSY"],
    helperPath: helper(`${send({ hello: NFS_BRIDGE_VERSION, mode: "ro", port: 12345 })}setTimeout(()=>process.exit(0),50);`) });
  await server.exited;
  await server.stop();
  await server.stop();
  expect(() => process.kill(server.pid, 0)).toThrow();
});


it.skipIf(!process.env.ATLCLI_NFS_TEST_HELPER)("real helper exits when its parent pipe closes cleanly or mid-frame", async () => {
  for (const tail of [Buffer.alloc(0), Buffer.from([0, 0])]) {
    const child = spawn(process.env.ATLCLI_NFS_TEST_HELPER!, ["0"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const exited = new Promise<number | null>((done, reject) => {
      child.once("close", done);
      child.once("error", reject);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const frames = readNfsFrames(child.stdout);
      expect((await frames.next()).value).toMatchObject({ hello: NFS_BRIDGE_VERSION, mode: "ro" });
      child.stdin.end(tail);
      expect(await exited).toBe(0);
      expect((await frames.next()).done).toBe(true);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
}, 12000);
