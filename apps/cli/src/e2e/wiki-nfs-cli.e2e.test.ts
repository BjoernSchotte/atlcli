import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { isMounted, runMountCommand, type MountRecord } from "../commands/wiki-mount.js";

const run = process.env.ATLCLI_NFS_CLI_E2E === "1";
it.skipIf(!run)("source CLI mounts DOCSY with NFS, reports transport, reads and detaches on SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlcli-nfs-cli-"));
  const mountpoint = join(root, "wiki docs");
  const cache = join(root, "cache");
  const helper = process.env.ATLCLI_NFS_TEST_HELPER;
  if (!helper) throw new Error("Set ATLCLI_NFS_TEST_HELPER");
  const child = spawn(process.execPath, ["--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts",
    "wiki", "mount", mountpoint, "--profile", "mayflower", "--space", "DOCSY", "--mode", "ro",
    "--transport", "nfs", "--cache-dir", cache, "--json"], {
    cwd: resolve(import.meta.dir, "../../../.."), env: { ...process.env, ATLCLI_NFS_HELPER: helper },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  try {
    let record: MountRecord | undefined;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`CLI exited before mount: ${stderr}`);
      try {
        const file = readdirSync(join(cache, "mounts")).find((name) => name.endsWith(".json"));
        if (file) record = JSON.parse(readFileSync(join(cache, "mounts", file), "utf8"));
      } catch { /* Waiting for atomic state publication. */ }
      if (record && stdout.includes('"transport"')) break;
      await Bun.sleep(25);
    }
    expect(record?.transport).toBe("nfs");
    expect(record?.helperPid).toBeGreaterThan(0);
    expect(record?.processIdentity).toBeTruthy();
    if (platform() === "linux") {
      expect(record!.status).toBe("listening");
      expect(await runMountCommand(["sudo", "-n", "mount", "-t", "nfs", "-o",
        `vers=3,tcp,ro,nolock,soft,timeo=10,retrans=2,port=${record!.port},mountport=${record!.port}`,
        "127.0.0.1:/", mountpoint])).toBe(0);
    }
    expect(isMounted(mountpoint)).toBe(true);
    const file = await open(join(mountpoint, "_index.md"), "r");
    try { expect((await file.readFile()).byteLength).toBeGreaterThan(0); }
    finally { await file.close(); }
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(10000).then(() => { throw new Error("CLI did not detach and stop"); })]);
    expect(child.exitCode).toBe(0);
    expect(isMounted(mountpoint)).toBe(false);
    expect(readdirSync(join(cache, "mounts")).filter((name) => name.endsWith(".json"))).toEqual([]);
  } finally {
    if (isMounted(mountpoint)) await runMountCommand(platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint]);
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(3000)]);
    if (!isMounted(mountpoint)) rmSync(root, { recursive: true, force: true });
  }
}, 40000);
