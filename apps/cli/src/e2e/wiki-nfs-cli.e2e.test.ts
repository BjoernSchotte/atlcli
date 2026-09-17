import { nfsMountOptionsFor } from "../vfs/mount-transport.js";
import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { isMounted, readMounts, processIdentity, runMountCommand, type MountRecord } from "../commands/wiki-mount.js";

const run = process.env.ATLCLI_NFS_CLI_E2E === "1";
const binary = process.env.ATLCLI_NFS_TEST_CLI;
const command = binary ? [resolve(binary)] : [process.execPath, "--conditions=development", "run", "--cwd",
  resolve(import.meta.dir, "../.."), "src/index.ts"];
for (const scenario of ["signal", "busy", "explicit", "helper-crash", "helper-crash-busy", "parent-crash"] as const) {
it.skipIf(!run)(`${binary ? "compiled" : "source"} CLI NFS DOCSY lifecycle: ${scenario}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "atlcli-nfs-cli-"));
  const mountpoint = join(root, "wiki docs");
  const cache = join(root, "cache");
  const helper = process.env.ATLCLI_NFS_TEST_HELPER;
  if (!helper && !binary) throw new Error("Set ATLCLI_NFS_TEST_HELPER for source tests");
  const env = { ...process.env };
  if (helper) env.ATLCLI_NFS_HELPER = helper;
  else delete env.ATLCLI_NFS_HELPER; // Compiled tests prove adjacent companion discovery.
  const child = spawn(command[0]!, [...command.slice(1),
    "wiki", "mount", mountpoint, "--profile", "mayflower", "--space", "DOCSY", "--mode", "ro",
    "--transport", "nfs", "--cache-dir", cache, "--json"], {
    cwd: resolve(import.meta.dir, "../../../.."), env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  let holder: ReturnType<typeof spawn> | undefined;
  let replacement: MountRecord | undefined;
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  try {
    let record: MountRecord | undefined;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`CLI exited before mount (${child.exitCode}): ${stderr || stdout}`);
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
        nfsMountOptionsFor("linux", record!.port),
        "127.0.0.1:/", mountpoint])).toBe(0);
    }
    expect(isMounted(mountpoint)).toBe(true);
    const file = await open(join(mountpoint, "_index.md"), "r");
    try { expect((await file.readFile()).byteLength).toBeGreaterThan(0); }
    finally { await file.close(); }
    if (scenario === "parent-crash") {
      expect(record!.helperIdentity).toBeTruthy();
      process.kill(record!.pid, "SIGKILL");
      await Promise.race([exited, Bun.sleep(10000).then(() => { throw new Error("Killed CLI did not exit"); })]);
      const helperDeadline = Date.now() + 5000;
      while (processIdentity(record!.helperPid!) === record!.helperIdentity && Date.now() < helperDeadline) await Bun.sleep(25);
      expect(processIdentity(record!.helperPid!)).not.toBe(record!.helperIdentity);
      expect(isMounted(mountpoint)).toBe(true); // SIGKILL cannot run the parent's detach handler.
      const orphaned = readMounts(cache);
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]!.status).toBe("orphaned");
      expect(orphaned[0]!.serverAlive).toBe(false);
      expect(readdirSync(join(cache, "mounts")).some(name => name.endsWith(".json"))).toBe(true);
      expect(await runMountCommand([...command, "wiki", "mount", "unmount", mountpoint,
        "--profile", "mayflower", "--cache-dir", cache, "--json"], true)).toBe(0);
      expect(isMounted(mountpoint)).toBe(false);
      expect(readMounts(cache)).toEqual([]);
      return;
    }
    if (scenario === "busy" || scenario === "helper-crash-busy") {
      holder = spawn("/bin/sleep", ["30"], { cwd: mountpoint, stdio: "ignore" });
      await new Promise<void>((resolveSpawn, reject) => { holder!.once("spawn", resolveSpawn); holder!.once("error", reject); });
      if (scenario === "helper-crash-busy") {
        process.kill(record!.helperPid!, "SIGKILL");
        const recoveryDeadline = Date.now() + 5000;
        while (Date.now() < recoveryDeadline) {
          replacement = readMounts(cache)[0];
          if (replacement?.helperPid !== record!.helperPid) break;
          await Bun.sleep(25);
        }
        expect(replacement?.helperPid).toBeGreaterThan(0);
        expect(replacement?.helperPid).not.toBe(record!.helperPid);
        expect(replacement?.port).toBe(record!.port);
        expect(processIdentity(replacement!.helperPid!)).toBe(replacement!.helperIdentity);
      } else child.kill("SIGTERM");
      await Bun.sleep(300);
      expect(child.exitCode).toBeNull();
      expect(isMounted(mountpoint)).toBe(true);
      expect(readdirSync(join(cache, "mounts")).some((name) => name.endsWith(".json"))).toBe(true);
      const holderExited = new Promise<void>((done) => holder!.once("close", () => done()));
      holder.kill("SIGTERM");
      await holderExited;
      holder = undefined;
    }
    if (scenario === "explicit") {
      expect(await runMountCommand([...command, "wiki", "mount", "unmount", mountpoint,
        "--profile", "mayflower", "--cache-dir", cache, "--json"], true)).toBe(0);
    } else if (scenario === "helper-crash") process.kill(record!.helperPid!, "SIGKILL");
    else child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(10000).then(() => { throw new Error("CLI did not detach and stop"); })]);
    expect(child.exitCode).toBe(scenario.startsWith("helper-crash") ? 1 : 0);
    if (scenario.startsWith("helper-crash")) {
      expect(stderr).toContain("restoring its endpoint before normal unmount");
      expect(stderr).not.toContain("endpoint recovery failed");
      expect(processIdentity(record!.helperPid!)).not.toBe(record!.helperIdentity);
    }
    if (replacement) expect(processIdentity(replacement.helperPid!)).not.toBe(replacement.helperIdentity);
    expect(isMounted(mountpoint)).toBe(false);
    expect(readdirSync(join(cache, "mounts")).filter((name) => name.endsWith(".json"))).toEqual([]);
  } finally {
    if (holder) {
      const done = new Promise<void>((resolveHolder) => holder!.once("close", () => resolveHolder()));
      holder.kill("SIGTERM"); await done;
    }
    if (isMounted(mountpoint)) await runMountCommand(platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint]);
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(3000)]);
    if (!isMounted(mountpoint)) rmSync(root, { recursive: true, force: true });
  }
}, 40000);

}
