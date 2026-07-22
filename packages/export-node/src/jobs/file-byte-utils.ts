import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { openDurableTemp, type DurableTempFile } from "./atomic-fs.js";

export function logicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Export byte operation was cancelled.", "AbortError");
}

export async function streamToDurableTemp(
  target: string,
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ temp: DurableTempFile; byteLength: number; sha256: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Byte limit must be non-negative.");
  const temp = await openDurableTemp(target);
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    throwIfAborted(signal);
    for await (const chunk of source) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new TypeError("Byte stores accept Uint8Array chunks.");
      if (!Number.isSafeInteger(byteLength + chunk.byteLength) || byteLength + chunk.byteLength > maxBytes) throw new RangeError("Object byte limit exceeded.");
      await temp.handle.write(chunk);
      hash.update(chunk);
      byteLength += chunk.byteLength;
    }
    throwIfAborted(signal);
    return { temp, byteLength, sha256: hash.digest("hex") };
  } catch (error) {
    await temp.discard();
    throw error;
  }
}

export async function readJsonFiles<T>(directory: string): Promise<Array<{ path: string; value: T }>> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => ({ path: join(directory, name), value: JSON.parse(await readFile(join(directory, name), "utf8")) as T })));
}

export async function* readFileChunks(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  throwIfAborted(signal);
  const stream = createReadStream(path);
  const abort = (): void => {
    stream.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      yield new Uint8Array(chunk as Buffer);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}

export function dataPathFor(markerPath: string): string {
  return join(markerPath.slice(0, -basename(markerPath).length), `${basename(markerPath, ".json")}.bin`);
}
