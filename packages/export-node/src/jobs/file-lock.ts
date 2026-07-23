import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    }, { once: true });
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
      if (stale) {
        const guard = join(this.path, ".mutation.guard");
        let guardHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          guardHandle = await open(guard, "wx", 0o600);
          await guardHandle.close();
        } catch (error) {
          await guardHandle?.close().catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") { await delay(this.#pollMs, options.signal); continue; }
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
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
      for (;;) {
        try { handle = await open(guard, "wx", 0o600); await handle.close(); break; }
        catch (error) {
          await handle?.close().catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") { await delay(1); continue; }
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
