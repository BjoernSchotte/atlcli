import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await import("node:fs/promises").then(({ chmod }) => chmod(path, PRIVATE_DIRECTORY_MODE));
}

function temporaryPath(path: string): string {
  const suffix = `${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  return join(dirname(path), `.${basename(path)}.${suffix}.tmp`);
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows and some virtual filesystems do not allow opening directories.
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Same-directory temp, file fsync, atomic rename, then directory fsync. */
export async function writeDurableAtomic(
  path: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = temporaryPath(path);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface DurableTempFile {
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
  commit(target: string): Promise<void>;
  discard(): Promise<void>;
}

/** Open an exclusively-owned temp file that callers may fill incrementally. */
export async function openDurableTemp(
  target: string,
  options: { privateDirectory?: boolean; fileMode?: number } = {},
): Promise<DurableTempFile> {
  const directory = dirname(target);
  if (options.privateDirectory !== false) await ensurePrivateDirectory(directory);
  const path = temporaryPath(target);
  const handle = await open(path, "wx", options.fileMode ?? PRIVATE_FILE_MODE);
  let closed = false;
  let consumed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return {
    path,
    handle,
    async commit(finalTarget) {
      if (consumed) throw new Error("Durable temp file was already consumed.");
      consumed = true;
      await handle.sync();
      await close();
      if (options.privateDirectory !== false) await ensurePrivateDirectory(dirname(finalTarget));
      await rename(path, finalTarget);
      await syncDirectory(dirname(finalTarget));
    },
    async discard() {
      if (consumed) return;
      consumed = true;
      await close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
