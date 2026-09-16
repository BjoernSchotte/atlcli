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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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
  const portFlag = Number(getFlag(flags, "port") ?? 0);

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

  const { startWebdavServer } = await import("../vfs/webdav-server.js");
  const running = await startWebdavServer({
    vfs,
    spaces,
    port: Number.isFinite(portFlag) && portFlag > 0 ? portFlag : 0,
    onSweep: (report) => {
      // Rule 3: a sweep is exactly what the demand principle is defending
      // against, so it is reported rather than absorbed.
      process.stderr.write(
        `atlcli: ${report.reads} file reads in ${report.windowMs / 1000}s without a directory listing — ` +
          `this looks like a search indexer walking the volume. ` +
          `Check that .metadata_never_index is honoured, or unmount while indexing.\n`,
      );
    },
  });

  const mountUrl = mountUrlFor(running.url, spaces);
  const record: MountRecord = {
    mountpoint,
    url: mountUrl,
    port: running.port,
    pid: process.pid,
    spaces,
    mode,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(mountStateDir(cacheDir), { recursive: true });
  writeFileSync(mountStatePath(cacheDir, mountpoint), JSON.stringify(record, null, 2));

  const attach = mountCommandFor(platform(), mountUrl, mountpoint, `atlcli-${spaces[0]}`);
  if ("instructions" in attach) {
    process.stderr.write(attach.instructions);
  } else {
    mkdirSync(mountpoint, { recursive: true });
    const status = await runMountCommand(attach.run);
    if (status !== 0) {
      process.stderr.write(
        `atlcli: ${attach.run[0]} exited with ${status ?? "a signal"}. ` +
          `The server is still running at ${mountUrl}; attach it manually if you prefer.\n`,
      );
    }
  }

  output(
    {
      mounted: mountpoint,
      url: mountUrl,
      spaces,
      mode,
      allowDelete: hasFlag(flags, "allow-delete"),
      note: "Press Ctrl-C to unmount and stop the server.",
    },
    opts,
  );

  await waitForShutdown(async () => {
    const detach = unmountCommandFor(platform(), mountpoint);
    if ("run" in detach) await runMountCommand(detach.run, true);
    await running.stop();
    await vfs.close();
    rmSync(mountStatePath(cacheDir, mountpoint), { force: true });
  });
}

/**
 * Block until the process is asked to stop, then clean up exactly once.
 *
 * A mount that outlives its server is a directory that hangs every `ls`, so
 * the unmount has to happen on the signal path rather than being left to the
 * user.
 */
async function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      void cleanup().finally(() => resolve());
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function handleList(flags: Flags, opts: OutputOptions): Promise<void> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  const vfsConfig = resolveVfsConfig(config, profile);
  const cacheDir = getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR;
  output(readMounts(cacheDir), opts);
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
      if (isRunning(record.pid)) records.push(record);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return records;
}

function isRunning(pid: number): boolean {
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

  const detach = unmountCommandFor(platform(), mountpoint);
  if ("instructions" in detach) {
    process.stderr.write(detach.instructions);
  } else {
    await runMountCommand(detach.run);
  }

  const file = mountStatePath(cacheDir, mountpoint);
  if (existsSync(file)) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as MountRecord;
      if (isRunning(record.pid)) process.kill(record.pid, "SIGTERM");
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

Mount Confluence as a real filesystem, through a WebDAV server on loopback.
No kernel extension, no driver, no administrator rights on macOS or Windows.

Usage:
  atlcli wiki mount ~/confluence --space DOCSY
  atlcli wiki mount list
  atlcli wiki mount unmount ~/confluence

Options:
  --space <KEY[,KEY]>  Spaces to expose (default: the profile's space)
  --mode ro|rw         Write posture (default: ro)
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

Full-text search:
  A mount does not enforce the shell prefetch budget — the kernel knows nothing about it — so
  a recursive grep over a mounted volume reads every page. Use
  'atlcli wiki sh -c "grep -rlw <word> ."' for search instead.
`;
}
