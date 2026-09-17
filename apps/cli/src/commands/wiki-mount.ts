/**
 * `atlcli wiki mount` — Confluence as an OS volume (WP7.5, WP7.6).
 *
 * Starts the loopback WebDAV server and hands the mount to the operating
 * system's own client: `mount_webdav` on macOS, `net use` on Windows,
 * `mount -t davfs` on Linux. No kernel extension, no driver, no administrator
 * rights on the default path — which is the whole reason WebDAV was chosen
 * over FUSE (plan section 6).
 *
 * Linux is **instructions, not an action**: `mount -t davfs` needs root or an
 * fstab entry, and a CLI that silently asks for a password to mount a
 * filesystem is a CLI nobody should trust. So it prints the command.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDefaults,
  resolveVfsConfig,
  type OutputOptions,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl, type VfsMode } from "@atlcli/confluence-vfs";
import { assertCliAuthSupported } from "./session-guard.js";

import type { NfsJournal } from "../vfs/nfs-journal.js";
import { findNfsHelper, nfsMountCommandFor, parseMountTransport, type MountTransport } from "../vfs/mount-transport.js";

type Flags = Record<string, string | boolean | string[]>;

/** A single space is the volume root; multiple spaces retain their namespace. */
export function mountUrlFor(serverUrl: string, spaces: readonly string[]): string {
  return spaces.length === 1 ? new URL(`${encodeURIComponent(spaces[0]!)}/`, serverUrl).href : serverUrl;
}

/** The OS client calls our WebDAV server while attaching and detaching. */
export function runMountCommand(command: string[], quiet = false): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: quiet ? "ignore" : "inherit" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

const DEFAULT_CACHE_DIR = join(homedir(), ".atlcli", "vfs");

export interface MountRecord {
  mountpoint: string;
  url: string;
  transport?: MountTransport;
  helperPid?: number;
  helperIdentity?: string;
  processIdentity?: string;
  status?: "listening" | "mounted" | "orphaned";
  serverAlive?: boolean;
  port: number;
  pid: number;
  spaces: string[];
  mode: VfsMode;
  startedAt: string;
}

export function mountStateDir(cacheDir: string): string {
  return join(cacheDir, "mounts");
}

export function mountStatePath(cacheDir: string, mountpoint: string): string {
  const hash = createHash("sha256").update(mountpoint).digest("hex").slice(0, 16);
  return join(mountStateDir(cacheDir), `${hash}.json`);
}

/** The platform command that attaches the volume, or instructions for Linux. */
export function mountCommandFor(
  os: NodeJS.Platform,
  url: string,
  mountpoint: string,
  volumeName: string,
): { run: string[] } | { instructions: string } {
  switch (os) {
    case "darwin":
      // -S suppresses the authentication dialog, which would otherwise appear
      // for a server that needs no authentication.
      return { run: ["mount_webdav", "-S", "-v", volumeName, url, mountpoint] };
    case "win32":
      return { run: ["net", "use", mountpoint, url] };
    default:
      return {
        instructions:
          `Linux needs davfs2 and root to attach a WebDAV volume, so atlcli will not do it for you.\n` +
          `The server is running. Mount it with:\n\n` +
          `    sudo mount -t davfs ${url} ${mountpoint}\n\n` +
          `Or add an fstab entry so it can be mounted without sudo:\n\n` +
          `    ${url} ${mountpoint} davfs user,noauto,rw 0 0\n`,
      };
  }
}

export function unmountCommandFor(
  os: NodeJS.Platform,
  mountpoint: string,
): { run: string[] } | { instructions: string } {
  switch (os) {
    case "darwin":
      return { run: ["umount", mountpoint] };
    case "win32":
      return { run: ["net", "use", mountpoint, "/delete"] };
    default:
      return { instructions: `    sudo umount ${mountpoint}\n` };
  }
}

/** Match the mountpoint itself, not merely its containing filesystem. */
export function isLinuxMounted(mountpoint: string, mountInfo = readFileSync("/proc/self/mountinfo", "utf8")): boolean {
  return mountInfo.split("\n").some((line) => {
    const field = line.split(" ")[4];
    return field?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))) === resolve(mountpoint);
  });
}

async function detachVolume(os: NodeJS.Platform, mountpoint: string): Promise<boolean> {
  if (os === "linux") {
    if (!isLinuxMounted(mountpoint)) return true;
    // fstab/user mounts need no privilege; sudo -n never prompts during shutdown.
    for (const command of [["umount", mountpoint], ["sudo", "-n", "umount", mountpoint]]) {
      try { await runMountCommand(command, true); } catch { /* Try the next permitted method. */ }
      if (!isLinuxMounted(mountpoint)) return true;
    }
    process.stderr.write(`atlcli: could not unmount ${mountpoint}; server stays running. Close files and leave the mount directory, then retry Ctrl-C, or run sudo umount manually.\n`);
    return false;
  }
  if (os === "darwin" && !isMounted(mountpoint)) return true;
  const command = unmountCommandFor(os, mountpoint);
  return "run" in command && await runMountCommand(command.run, true) === 0;
}

export async function handleWikiMount(
  args: string[],
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(wikiMountHelp(), opts);
    return;
  }
  const [first, ...rest] = args;
  if (first === "recovery") {
    if (!rest[0] || rest.length !== 1 || ["id", "output", "image"].some(key => flags[key] !== undefined && (typeof flags[key] !== "string" || !flags[key]))) {
      fail(opts, 2, ERROR_CODES.VALIDATION, "Use recovery <journal.sqlite>; --id, --output and --image require single nonempty values.", {});
      return;
    }
    try {
      const { recoverNfsJournal } = await import("../vfs/nfs-recovery.js");
      output(recoverNfsJournal(rest[0], { id: getFlag(flags, "id"), output: getFlag(flags, "output"), image: getFlag(flags, "image") }), opts);
    } catch (error) { fail(opts, 2, ERROR_CODES.VALIDATION, (error as Error).message, {}); }
    return;
  }
  if (first === "list" || first === "status") {
    await handleList(flags, opts);
    return;
  }
  if (first === "unmount" || first === "umount") {
    await handleUnmount(rest[0], flags, opts);
    return;
  }
  await handleMount(first, flags, opts);
}

async function handleMount(
  mountpoint: string | undefined,
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  if (!mountpoint) {
    fail(opts, 2, ERROR_CODES.VALIDATION, "Pass a mountpoint: atlcli wiki mount <path>", {});
    return;
  }

  let transport: MountTransport;
  let portFlag: number;
  try {
    transport = parseMountTransport(flags.transport, platform());
    if (flags.mode !== undefined && flags.mode !== "ro" && flags.mode !== "rw") {
      throw new Error("Use --mode ro|rw");
    }
    if (flags.port !== undefined && (typeof flags.port !== "string" || !/^[0-9]+$/.test(flags.port))) {
      throw new Error("Use --port with an integer from 0 to 65535");
    }
    portFlag = Number(flags.port ?? 0);
    if (!Number.isInteger(portFlag) || portFlag > 65535) {
      throw new Error("Use --port with an integer from 0 to 65535");
    }
    if (transport === "nfs" && (flags.mode === "rw" || hasFlag(flags, "sync-writes") || hasFlag(flags, "allow-delete"))) {
      throw new Error("Experimental NFS currently supports --mode ro only; write durability acceptance is still pending.");
    }
  }
  catch (error) { fail(opts, 2, ERROR_CODES.VALIDATION, (error as Error).message, {}); return; }

  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {});
    return;
  }
  assertCliAuthSupported(profile, opts);

  const vfsConfig = resolveVfsConfig(config, profile);
  const defaults = resolveDefaults(config, profile);
  const spaceFlag = getFlag(flags, "space");
  const spaces = spaceFlag
    ? spaceFlag.split(",").map((key) => key.trim()).filter(Boolean)
    : (vfsConfig.spaces ?? (defaults.space ? [defaults.space] : []));
  if (spaces.length === 0) {
    fail(opts, 2, ERROR_CODES.VALIDATION, "No space to mount. Pass --space <KEY[,KEY]>.", {});
    return;
  }

  const modeFlag = getFlag(flags, "mode");
  const mode: VfsMode =
    modeFlag === "rw" ? "rw" : modeFlag === "ro" ? "ro" : (vfsConfig.mode ?? "ro");
  const cacheDir = getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR;

  let helperPath: string | undefined;
  if (transport === "nfs") {
    if (mode !== "ro") {
      fail(opts, 2, ERROR_CODES.VALIDATION, "Experimental NFS currently supports --mode ro only; write durability acceptance is still pending.", {});
      return;
    }
    try { helperPath = findNfsHelper(); }
    catch (error) { fail(opts, 2, ERROR_CODES.VALIDATION, (error as Error).message, {}); return; }
    if (!Bun.which(platform() === "darwin" ? "mount_nfs" : "mount.nfs")) {
      fail(opts, 2, ERROR_CODES.VALIDATION, "NFS client missing. Install the platform NFS client (nfs-common on Debian/Ubuntu) or use --transport webdav.", {});
      return;
    }
  }

  const vfs = await ConfluenceVfsImpl.open({
    profile: profile.name,
    client: new ConfluenceClient(profile),
    spaces,
    mode,
    allowDelete: hasFlag(flags, "allow-delete"),
    ...(hasFlag(flags, "sync-writes") ? { coalesceMs: 0 } : {}),
    cacheDir,
    offline: false,
  });

  const onSweep = (report: { reads: number; windowMs: number }) => {
    process.stderr.write(
      `atlcli: ${report.reads} distinct file reads in ${report.windowMs / 1000}s without a recent directory listing — ` +
        `this may be a search indexer walking the volume. ` +
        `Check that .metadata_never_index is honoured, or unmount while indexing.\n`,
    );
  };
  let journal: NfsJournal | undefined;
  let journalPath: string | undefined;
  let helperPid: number | undefined;
  let helperExited: Promise<void> | undefined;
  let running: { port: number; url: string; stop(): Promise<void> };
  try {
    if (transport === "nfs") {
      const { startNfsServer } = await import("../vfs/nfs-bridge.js");
      if (vfs.guard.mode === "rw") {
        const { NfsJournal, nfsJournalLocation } = await import("../vfs/nfs-journal.js");
        if (!vfs.runtime) throw new Error("NFS writes require a verified profile identity");
        const location = nfsJournalLocation({ ...vfs.runtime, profile: profile.name, spaces });
        journalPath = location.path;
        journal = new NfsJournal(location.path, location.scope);
      }
      const nfs = await startNfsServer({ vfs, spaces, onSweep, helperPath: helperPath!,
        port: portFlag, journal });
      helperPid = nfs.pid;
      helperExited = nfs.exited;
      running = { port: nfs.port, url: `nfs://127.0.0.1:${nfs.port}/`, stop: async () => {
        await nfs.stop();
        journal?.close(); journal = undefined;
      } };
    } else {
      const { startWebdavServer } = await import("../vfs/webdav-server.js");
      running = await startWebdavServer({ vfs, spaces,
        port: portFlag,
        onSweep,
      });
    }
  } catch (error) { journal?.close(); await vfs.close(); throw error; }

  const mountUrl = transport === "nfs" ? running.url : mountUrlFor(running.url, spaces);
  const record: MountRecord = {
    mountpoint,
    transport,
    ...(helperPid ? { helperPid, helperIdentity: processIdentity(helperPid) } : {}),
    status: "listening",
    url: mountUrl,
    port: running.port,
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    spaces,
    mode,
    startedAt: new Date().toISOString(),
  };
  try {
    saveMountRecord(cacheDir, record);

    mkdirSync(mountpoint, { recursive: true });
    const attach = transport === "nfs" ? nfsMountCommandFor(platform(), running.port, mountpoint, mode)
      : mountCommandFor(platform(), mountUrl, mountpoint, `atlcli-${spaces[0]}`);
    if ("instructions" in attach) {
      process.stderr.write(attach.instructions);
    } else {
      const status = await runMountCommand(attach.run);
      if (status === 0) record.status = "mounted";
      if (status !== 0) {
        process.stderr.write(
          `atlcli: ${attach.run[0]} exited with ${status ?? "a signal"}. ` +
            `The server is still running at ${mountUrl}; attach it manually if you prefer.\n`,
        );
      }
    }

    saveMountRecord(cacheDir, record);
  } catch (error) {
    if (!isMounted(mountpoint)) { await running.stop(); await vfs.close(); rmSync(mountStatePath(cacheDir, mountpoint), { force: true }); }
    throw error;
  }

  output(
    {
      mounted: transport === "webdav" ? mountpoint : (record.status === "mounted" ? mountpoint : null),
      transport,
      status: record.status,
      mountpoint,
      url: mountUrl,
      spaces,
      mode,
      allowDelete: hasFlag(flags, "allow-delete"),
      ...(journalPath ? { journalPath } : {}),
      note: "Press Ctrl-C to unmount and stop the server.",
    },
    opts,
  );

  let stopping = false;
  const shutdown = waitForShutdown(async () => {
    if (!await detachVolume(platform(), mountpoint)) return false;
    stopping = true;
    await running.stop();
    await vfs.close();
    rmSync(mountStatePath(cacheDir, mountpoint), { force: true });
    return true;
  });
  void helperExited?.then(() => {
    if (stopping) return;
    process.exitCode = 1;
    process.stderr.write("atlcli: NFS helper stopped unexpectedly; attempting normal unmount. Remount after recovery.\n");
    process.emit("SIGTERM");
  });
  await shutdown;
}

/**
 * Block until the process is asked to stop, then clean up exactly once.
 *
 * A mount that outlives its server is a directory that hangs every `ls`, so
 * the unmount has to happen on the signal path rather than being left to the
 * user.
 */
export async function waitForShutdown(cleanup: () => Promise<boolean>): Promise<void> {
  await new Promise<void>((resolve) => {
    let running = false;
    const finish = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        if (await cleanup()) {
          process.removeListener("SIGINT", finish);
          process.removeListener("SIGTERM", finish);
          resolve();
        }
      } catch (error) {
        process.stderr.write(`atlcli: shutdown failed; retry after resolving the error: ${String(error)}\n`);
      } finally { running = false; }
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

async function handleList(flags: Flags, opts: OutputOptions): Promise<void> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  const vfsConfig = resolveVfsConfig(config, profile);
  const cacheDir = getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR;
  output(readMounts(cacheDir), opts);
}

/** The identity must match before a saved PID may be signalled. */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform() === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    }
    if (platform() === "darwin") {
      return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8" }).trim() || undefined;
    }
  } catch { /* A dead or inaccessible process has no proven identity. */ }
  return undefined;
}

export function isMounted(mountpoint: string): boolean {
  if (platform() === "linux") return isLinuxMounted(mountpoint);
  if (platform() === "darwin") {
    try {
      // Do not realpath the mounted directory itself: synchronous NFS lookup
      // can deadlock against the server running on this same Bun event loop.
      const absolute = resolve(mountpoint);
      const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
      return execFileSync("/sbin/mount", [], { encoding: "utf8" }).split("\n")
        .some((line) => line.match(/ on (.*) \(/)?.[1] === canonical);
    } catch { return false; }
  }
  return false;
}

function saveMountRecord(cacheDir: string, record: MountRecord): void {
  mkdirSync(mountStateDir(cacheDir), { recursive: true, mode: 0o700 });
  const path = mountStatePath(cacheDir, record.mountpoint);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Active mounts, with records whose process is gone pruned as they are read. */
export function readMounts(cacheDir: string): MountRecord[] {
  const dir = mountStateDir(cacheDir);
  if (!existsSync(dir)) return [];
  const records: MountRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as MountRecord;
      record.transport ??= "webdav";
      const mounted = isMounted(record.mountpoint);
      const parentAlive = isRunning(record.pid) && (!record.processIdentity || record.processIdentity === processIdentity(record.pid));
      record.serverAlive = parentAlive && (!record.helperPid ||
        (isRunning(record.helperPid) && (!record.helperIdentity || record.helperIdentity === processIdentity(record.helperPid))));
      record.status = mounted ? (record.serverAlive ? "mounted" : "orphaned") : "listening";
      if (parentAlive || mounted) records.push(record);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return records;
}

function isRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function handleUnmount(
  mountpoint: string | undefined,
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  if (!mountpoint) {
    fail(opts, 2, ERROR_CODES.VALIDATION, "Pass a mountpoint to unmount.", {});
    return;
  }
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  const vfsConfig = resolveVfsConfig(config, profile);
  const cacheDir = getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR;

  if (!await detachVolume(platform(), mountpoint)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Unmount failed; the server and mount record were preserved.", {});
    return;
  }

  const file = mountStatePath(cacheDir, mountpoint);
  if (existsSync(file)) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as MountRecord;
      if (record.processIdentity && record.processIdentity === processIdentity(record.pid)) {
        process.kill(record.pid, "SIGTERM");
      }
    } catch {
      // A malformed record is nothing to act on; removing it is the fix.
    }
    rmSync(file, { force: true });
  }
  output({ unmounted: mountpoint }, opts);
}

/** Detached mode (WP7.6): the server keeps running after the shell exits. */
export function spawnDetached(argv: string[], logFile: string): number {
  mkdirSync(join(logFile, ".."), { recursive: true });
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child.pid ?? 0;
}

export function wikiMountHelp(): string {
  return `atlcli wiki mount <mountpoint>

Mount Confluence through WebDAV (default) or experimental read-only NFS on loopback.
No kernel extension, no driver, no administrator rights on macOS or Windows.

Usage:
  atlcli wiki mount ~/confluence --space DOCSY
  atlcli wiki mount list
  atlcli wiki mount recovery <journal.sqlite> [--id <id> --output <new-file>]
  atlcli wiki mount unmount ~/confluence

Options:
  --space <KEY[,KEY]>  Spaces to expose (default: the profile's space)
  --mode ro|rw         Write posture (default: ro)
  --transport <name>  webdav (default) or nfs (experimental, macOS/Linux, ro only)
  --allow-delete       Additionally allow deletion, which moves pages to the trash
  --sync-writes        Persist each write immediately (disable 500 ms coalescing)
  --cache-dir <path>   Cache root (default: ~/.atlcli/vfs)
  --port <n>           Bind to a fixed port (default: a free one)
  --profile <name>     Use a specific auth profile
  --json               JSON output

Platform notes:
  macOS    mount_webdav attaches the volume; LOCK is implemented, so it mounts
           read-write rather than read-only.
  Windows  net use maps a drive letter. The WebClient refuses files over 50 MB,
           which affects large attachments only.
  Linux    davfs2 and root are needed, so atlcli prints the mount command
           instead of running it.

NFS development:
  Build packages/confluence-nfs with cargo build --locked and set ATLCLI_NFS_HELPER
  to the absolute helper binary path. Published installs need the matching helper
  beside atlcli. There is no runtime download or automatic transport fallback.

Recovery:
  Inspect local NFS journal metadata without authentication or network access.
  Export exact bytes with --id and --output; --image current|intent|base selects
  the local image (default: current), unresolved publication, or last published
  source. Existing output files are never overwritten. Recovery does not publish
  or alter journal records. Keep the journal until remote publication is verified.

Full-text search:
  A mount does not enforce the shell prefetch budget — the kernel knows nothing about it — so
  a recursive grep over a mounted volume reads every page. Use
  'atlcli wiki sh -c "grep -rlw <word> ."' for search instead.
`;
}
