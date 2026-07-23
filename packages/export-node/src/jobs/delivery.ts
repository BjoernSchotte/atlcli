import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExportArtifactStore, ExportArtifactV1 } from "@atlcli/export-jobs";
import { openDurableTemp, syncDirectory } from "./atomic-fs.js";

export class ExportArtifactDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = "ExportArtifactDeliveryError"; }
}

/** Deliver only finalized bytes, preserving the CLI's atomic no-clobber/force contract. */
export async function deliverFileExportArtifact(
  store: ExportArtifactStore,
  artifact: ExportArtifactV1,
  targetPath: string,
  options: { overwriteExisting?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const path = resolve(targetPath); const directory = dirname(path); await mkdir(directory, { recursive: true });
  const staging = join(directory, `.${basename(path)}.delivery-${process.pid.toString(36)}-${randomBytes(8).toString("hex")}.tmp`);
  const temp = await openDurableTemp(staging, { privateDirectory: false, fileMode: 0o666 }); const hash = createHash("sha256"); let byteLength = 0;
  try {
    for await (const chunk of store.read(artifact.ref, { signal: options.signal })) {
      options.signal?.throwIfAborted(); await temp.handle.write(chunk); hash.update(chunk); byteLength += chunk.byteLength;
      if (byteLength > artifact.byteLength) throw new ExportArtifactDeliveryError("Artifact grew while being delivered.");
    }
    if (byteLength !== artifact.byteLength || hash.digest("hex") !== artifact.sha256.toLowerCase()) throw new ExportArtifactDeliveryError("Committed artifact bytes do not match their descriptor.");
    await temp.commit(staging);
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try { existing = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new ExportArtifactDeliveryError(`Refusing non-regular output target ${path}.`);
    if (existing && !options.overwriteExisting) throw new ExportArtifactDeliveryError(`Output file already exists: ${path}.`);
    options.signal?.throwIfAborted();
    if (existing) await rename(staging, path);
    else { await link(staging, path); await rm(staging, { force: true }); }
    await syncDirectory(directory);
  } finally { await temp.discard(); await rm(staging, { force: true }).catch(() => undefined); }
}
