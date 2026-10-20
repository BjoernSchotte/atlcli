#!/usr/bin/env bun
/**
 * Proves that advisory locks on a (mounted) file work across processes.
 *
 *   bun native-lock-probe.ts <path> rw|ro            -> prints "local locks verified"
 *   bun native-lock-probe.ts --try <path> rw|ro flock|posix   -> exit 0 acquired, 10 busy
 *
 * For each lock kind (flock, and POSIX record locks when writable) the parent
 * holds an exclusive lock, a child must find it busy, and after unlocking the
 * child must acquire it. Finally a shared POSIX lock must be grantable.
 */
import { cc } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";

type Kind = "flock" | "posix";
const native = cc({
  source: resolve(import.meta.dir, "native-lock-probe.c"),
  symbols: {
    lock_flock: { args: ["i32", "i32"], returns: "i32" },
    unlock_flock: { args: ["i32"], returns: "i32" },
    lock_posix: { args: ["i32", "i32"], returns: "i32" },
    unlock_posix: { args: ["i32"], returns: "i32" },
  },
}).symbols;

function check(rc: number, what: string): number {
  if (rc < 0) throw new Error(`${what} failed with errno ${-rc}`);
  return rc;
}
const lock = (fd: number, kind: Kind, exclusive: boolean) =>
  check(kind === "flock" ? native.lock_flock(fd, exclusive ? 1 : 0) : native.lock_posix(fd, exclusive ? 1 : 0), `${kind} lock`);
const unlock = (fd: number, kind: Kind) =>
  check(kind === "flock" ? native.unlock_flock(fd) : native.unlock_posix(fd), `${kind} unlock`);
const openMode = (mode: string) => (mode === "rw" ? "r+" : "r");

function childExit(path: string, mode: string, kind: Kind): number {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--try", path, mode, kind], { timeout: 2_000 });
  if (child.exitCode !== 0 && child.exitCode !== 10) throw new Error(`lock child failed: ${child.stderr.toString()}`);
  return child.exitCode;
}

const args = process.argv.slice(2);
if (args[0] === "--try") {
  const [, path, mode, kind] = args as [string, string, string, Kind];
  const fd = openSync(path, openMode(mode));
  process.exit(lock(fd, kind, true) === 0 ? 0 : 10);
}

const [path, mode] = args as [string, string];
for (const kind of (mode === "rw" ? ["flock", "posix"] : ["flock"]) as Kind[]) {
  const fd = openSync(path, openMode(mode));
  try {
    if (lock(fd, kind, true) !== 0) throw new Error(`${kind} lock was not granted`);
    if (childExit(path, mode, kind) !== 10) throw new Error(`${kind} lock was not visible to another process`);
    unlock(fd, kind);
    if (childExit(path, mode, kind) !== 0) throw new Error(`${kind} lock was not released`);
  } finally {
    closeSync(fd);
  }
}
const fd = openSync(path, openMode(mode));
try {
  if (lock(fd, "posix", false) !== 0) throw new Error("shared posix lock was not granted");
  unlock(fd, "posix");
} finally {
  closeSync(fd);
}
console.log("local locks verified");
