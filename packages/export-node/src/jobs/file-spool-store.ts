import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExportByteCleanupResultV1,
  type ExportSpoolStore,
  type SpoolObjectV1,
  type SpoolRefV1,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import { ensurePrivateDirectory, writeDurableAtomic } from "./atomic-fs.js";
import { FileExportLock } from "./file-lock.js";
import { dataPathFor, logicalDigest, readFileChunks, readJsonFiles, streamToDurableTemp } from "./file-byte-utils.js";

interface SpoolMarkerV1 extends SpoolObjectV1 { schema: "atlcli.file-spool-object/1"; }
interface ClosedMarkerV1 { schema: "atlcli.file-byte-closed/1"; jobId: string; leaseEpoch?: number; closedAt: number; preserve: SpoolRefV1[]; }

function sameRef(a: SpoolRefV1, b: SpoolRefV1): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function validateRef(ref: SpoolRefV1): void {
  if (!ref.jobId || !ref.namespace || !ref.key || !Number.isSafeInteger(ref.leaseEpoch) || ref.leaseEpoch <= 0) throw new Error("Invalid spool ref.");
}
function publicObject(marker: SpoolMarkerV1): SpoolObjectV1 {
  return { ref: structuredClone(marker.ref), byteLength: marker.byteLength, sha256: marker.sha256, committedAt: marker.committedAt };
}

/** Streaming, quota-enforced file implementation of ExportSpoolStore. */
export class FileExportSpoolStore implements ExportSpoolStore {
  readonly rootDir: string;
  readonly #objectsDir: string;
  readonly #closedJobsDir: string;
  readonly #closedEpochsDir: string;
  readonly #lock: FileExportLock;
  readonly #now: () => number;

  constructor(rootDir: string, options: { now?: () => number; lockTtlMs?: number } = {}) {
    this.rootDir = rootDir; this.#objectsDir = join(rootDir, "spool", "objects");
    this.#closedJobsDir = join(rootDir, "spool", "closed", "jobs"); this.#closedEpochsDir = join(rootDir, "spool", "closed", "epochs");
    this.#lock = new FileExportLock(join(rootDir, "locks", "spool.lock"), { ttlMs: options.lockTtlMs ?? 30_000, now: options.now });
    this.#now = options.now ?? Date.now;
  }
  #markerPath(ref: SpoolRefV1): string { return join(this.#objectsDir, `${logicalDigest(ref)}.json`); }
  #dataPath(ref: SpoolRefV1): string { return join(this.#objectsDir, `${logicalDigest(ref)}.bin`); }
  #jobClosedPath(jobId: string): string { return join(this.#closedJobsDir, `${logicalDigest(jobId)}.json`); }
  #epochClosedPath(jobId: string, epoch: number): string { return join(this.#closedEpochsDir, `${logicalDigest([jobId, epoch])}.json`); }

  async put(ref: SpoolRefV1, source: AsyncIterable<Uint8Array>, limits: SpoolWriteLimitsV1, options?: { signal?: AbortSignal }): Promise<SpoolObjectV1> {
    validateRef(ref);
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Spool limits must be non-negative.");
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.#objectsDir);
    const collected = await streamToDurableTemp(this.#dataPath(ref), source, limits.maxObjectBytes, options?.signal);
    const lease = await this.#lock.acquire({ signal: options?.signal, label: "spool-put" });
    try {
      const closed = await this.#closed(ref);
      if (closed) throw new Error("The spool namespace is closed against late writes.");
      const markers = (await readJsonFiles<SpoolMarkerV1>(this.#objectsDir)).map((entry) => entry.value);
      const existing = markers.find((m) => sameRef(m.ref, ref));
      if (existing) {
        if (existing.byteLength !== collected.byteLength || existing.sha256 !== collected.sha256) throw new Error("A spool ref cannot be replaced by different bytes.");
        await collected.temp.discard(); return publicObject(existing);
      }
      const jobBytes = markers.filter((m) => m.ref.jobId === ref.jobId).reduce((sum, m) => sum + m.byteLength, 0) + collected.byteLength;
      const totalBytes = markers.reduce((sum, m) => sum + m.byteLength, 0) + collected.byteLength;
      if (jobBytes > limits.maxJobBytes) throw new RangeError("Per-job spool byte limit exceeded.");
      if (totalBytes > limits.maxTotalBytes) throw new RangeError("Total spool byte limit exceeded.");
      await collected.temp.commit(this.#dataPath(ref));
      const marker: SpoolMarkerV1 = { schema: "atlcli.file-spool-object/1", ref: structuredClone(ref), byteLength: collected.byteLength, sha256: collected.sha256, committedAt: this.#now() };
      await writeDurableAtomic(this.#markerPath(ref), `${JSON.stringify(marker)}\n`);
      return publicObject(marker);
    } catch (error) { await collected.temp.discard(); throw error; }
    finally { await lease.release(); }
  }
  read(ref: SpoolRefV1, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    const load = async function* (self: FileExportSpoolStore): AsyncIterable<Uint8Array> {
      const marker = await self.stat(ref); if (!marker) throw new Error("Spool object was not found.");
      yield* readFileChunks(self.#dataPath(ref), options?.signal);
    };
    return load(this);
  }
  async stat(ref: SpoolRefV1): Promise<SpoolObjectV1 | undefined> {
    validateRef(ref);
    const marker = (await readJsonFiles<SpoolMarkerV1>(this.#objectsDir)).map((e) => e.value).find((m) => sameRef(m.ref, ref));
    return marker ? publicObject(marker) : undefined;
  }
  /** Snapshot refs already committed for one epoch so recovery can close it without losing checkpoints. */
  async listNamespaceRefs(jobId: string, leaseEpoch: number): Promise<SpoolRefV1[]> {
    if (!jobId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) throw new Error("Invalid spool namespace.");
    return (await readJsonFiles<SpoolMarkerV1>(this.#objectsDir)).map((entry) => entry.value.ref)
      .filter((ref) => ref.jobId === jobId && ref.leaseEpoch === leaseEpoch).map((ref) => structuredClone(ref));
  }
  async deleteNamespace(jobId: string, leaseEpoch: number, options?: { preserve?: readonly SpoolRefV1[] }): Promise<ExportByteCleanupResultV1> {
    const preserve = [...(options?.preserve ?? [])];
    if (preserve.some((ref) => ref.jobId !== jobId || ref.leaseEpoch !== leaseEpoch)) throw new Error("Preserved refs must belong to the cleaned epoch.");
    return this.#cleanup({ jobId, leaseEpoch, preserve });
  }
  async cleanupJob(jobId: string): Promise<ExportByteCleanupResultV1> { return this.#cleanup({ jobId, preserve: [] }); }
  async #cleanup(closed: Omit<ClosedMarkerV1, "schema" | "closedAt">): Promise<ExportByteCleanupResultV1> {
    await ensurePrivateDirectory(this.rootDir);
    const lease = await this.#lock.acquire({ label: "spool-cleanup" });
    try {
      const marker: ClosedMarkerV1 = { schema: "atlcli.file-byte-closed/1", ...closed, closedAt: this.#now() };
      await writeDurableAtomic(closed.leaseEpoch === undefined ? this.#jobClosedPath(closed.jobId) : this.#epochClosedPath(closed.jobId, closed.leaseEpoch), `${JSON.stringify(marker)}\n`);
      let objectsDeleted = 0, bytesDeleted = 0;
      for (const entry of await readJsonFiles<SpoolMarkerV1>(this.#objectsDir)) {
        const value = entry.value;
        if (value.ref.jobId !== closed.jobId || (closed.leaseEpoch !== undefined && value.ref.leaseEpoch !== closed.leaseEpoch) || closed.preserve.some((ref) => sameRef(ref, value.ref))) continue;
        await rm(dataPathFor(entry.path), { force: true }); await rm(entry.path, { force: true }); objectsDeleted += 1; bytesDeleted += value.byteLength;
      }
      return { objectsDeleted, bytesDeleted };
    } finally { await lease.release(); }
  }
  async #closed(ref: SpoolRefV1): Promise<boolean> {
    const jobs = await readJsonFiles<ClosedMarkerV1>(this.#closedJobsDir); if (jobs.some((e) => e.value.jobId === ref.jobId)) return true;
    const epochs = await readJsonFiles<ClosedMarkerV1>(this.#closedEpochsDir); return epochs.some((e) => e.value.jobId === ref.jobId && e.value.leaseEpoch === ref.leaseEpoch);
  }
}
