import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, writeDurableAtomic } from "./atomic-fs.js";

interface FileExportLockOwnerV1 {
  schema: "atlcli.file-export-lock/1";
  nonce: string;
  pid: number;
  acquiredAt: number;
  expiresAt: number;
  label?: string;
}

export interface FileExportLockOptions {
  ttlMs?: number;
  pollMs?: number;
  now?: () => number;
}

export interface FileExportLockLease {
  readonly nonce: string;
  readonly expiresAt: number;
  refresh(): Promise<void>;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Lock acquisition was cancelled.", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readOwner(path: string): Promise<FileExportLockOwnerV1 | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as FileExportLockOwnerV1;
    if (
      value.schema !== "atlcli.file-export-lock/1" ||
      typeof value.nonce !== "string" || value.nonce.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      !Number.isFinite(value.acquiredAt) ||
      !Number.isFinite(value.expiresAt)
    ) return undefined;
    return value;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * The mutation guard is only ever held across one owner.json read, one durable
 * owner.json write, or one directory rename (milliseconds), never across caller
 * work. It carries no owner, so a process killed inside that window would
 * otherwise block the lock forever. A guard this old (file mtime against the
 * wall clock: unlike the lease TTL it cannot follow an injected clock) is
 * abandoned.
 */
const GUARD_STALE_MS = 10_000;
/** Backstop: waiting this long for a guard means stale recovery is not working; fail instead of hanging. */
const GUARD_WAIT_LIMIT_MS = 3 * GUARD_STALE_MS;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Remove the guard if it is abandoned. Never removes a guard created after the staleness check. */
async function clearStaleGuard(guard: string): Promise<void> {
  try {
    const seen = await stat(guard);
    if (Date.now() - seen.mtimeMs < GUARD_STALE_MS) return;
    // Two contenders can both judge the same guard stale; the slower one would
    // then remove the faster one's fresh guard. Move it aside, and put it back
    // if it is not the file that was judged.
    const aside = `${guard}.${randomBytes(8).toString("hex")}`;
    await rename(guard, aside);
    const moved = await stat(aside);
    if (moved.ino !== seen.ino || moved.mtimeMs !== seen.mtimeMs) await link(aside, guard).catch(() => undefined);
    await unlink(aside);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function guardStuck(since: number): Error | undefined {
  return Date.now() - since > GUARD_WAIT_LIMIT_MS
    ? new Error("File export lock mutation guard could not be acquired; remove the stale lock directory.")
    : undefined;
}

/** Cross-process mutex backed by atomic directory creation and nonce-fenced stale recovery. */
export class FileExportLock {
  readonly path: string;
  readonly #ttlMs: number;
  readonly #pollMs: number;
  readonly #now: () => number;

  constructor(path: string, options: FileExportLockOptions = {}) {
    this.path = path;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#pollMs = options.pollMs ?? 25;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) throw new RangeError("Lock TTL must be positive.");
    if (!Number.isFinite(this.#pollMs) || this.#pollMs <= 0) throw new RangeError("Lock poll interval must be positive.");
  }

  async acquire(options: { signal?: AbortSignal; label?: string } = {}): Promise<FileExportLockLease> {
    await ensurePrivateDirectory(dirname(this.path));
    let guardBlockedSince: number | undefined;
    for (;;) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const acquiredAt = this.#now();
      const owner: FileExportLockOwnerV1 = {
        schema: "atlcli.file-export-lock/1",
        nonce: randomBytes(16).toString("hex"),
        pid: process.pid,
        acquiredAt,
        expiresAt: acquiredAt + this.#ttlMs,
        ...(options.label ? { label: options.label } : {}),
      };
      try {
        await mkdir(this.path, { mode: 0o700 });
        await writeDurableAtomic(join(this.path, "owner.json"), `${JSON.stringify(owner)}\n`);
        return this.#lease(owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await rm(this.path, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }

      const current = await readOwner(this.path);
      let stale = current ? current.expiresAt <= this.#now() : false;
      if (!current) {
        try {
          stale = this.#now() - (await stat(this.path)).mtimeMs >= this.#ttlMs;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (!stale) guardBlockedSince = undefined;
      if (stale) {
        const guard = join(this.path, ".mutation.guard");
        let guardHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          guardHandle = await open(guard, "wx", 0o600);
          await guardHandle.close();
        } catch (error) {
          await guardHandle?.close().catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            guardBlockedSince ??= Date.now();
            const stuck = guardStuck(guardBlockedSince); if (stuck) throw stuck;
            await clearStaleGuard(guard); await delay(this.#pollMs, options.signal); continue;
          }
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        guardBlockedSince = undefined;
        const guardedOwner = await readOwner(this.path);
        if (guardedOwner && guardedOwner.expiresAt > this.#now()) { await unlink(guard).catch(() => undefined); await delay(this.#pollMs, options.signal); continue; }
        const quarantine = `${this.path}.stale-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}`;
        try {
          await rename(this.path, quarantine);
          await rm(quarantine, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      await delay(this.#pollMs, options.signal);
    }
  }

  #lease(initial: FileExportLockOwnerV1): FileExportLockLease {
    let owner = initial;
    let released = false;
    const assertOwned = async (): Promise<void> => {
      if (released) throw new Error("File export lock lease was released.");
      const current = await readOwner(this.path);
      if (!current || current.nonce !== owner.nonce) throw new Error("File export lock lease was lost.");
    };
    const withGuard = async <T>(operation: () => Promise<T>): Promise<T> => {
      const guard = join(this.path, ".mutation.guard");
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      const waitingSince = Date.now();
      for (;;) {
        try { handle = await open(guard, "wx", 0o600); await handle.close(); break; }
        catch (error) {
          await handle?.close().catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const stuck = guardStuck(waitingSince); if (stuck) throw stuck;
            await clearStaleGuard(guard); await delay(1); continue;
          }
          throw error;
        }
      }
      try { await assertOwned(); return await operation(); }
      finally { await unlink(guard).catch(() => undefined); }
    };
    return {
      get nonce() { return owner.nonce; },
      get expiresAt() { return owner.expiresAt; },
      assertOwned,
      refresh: async () => {
        await withGuard(async () => {
          owner = { ...owner, expiresAt: this.#now() + this.#ttlMs };
          await writeDurableAtomic(join(this.path, "owner.json"), `${JSON.stringify(owner)}\n`);
          await assertOwned();
        });
      },
      release: async () => {
        if (released) return;
        await withGuard(async () => {
          const quarantine = `${this.path}.release-${owner.nonce}`;
          await rename(this.path, quarantine);
          released = true;
          await rm(quarantine, { recursive: true, force: true });
        });
      },
    };
  }
}
