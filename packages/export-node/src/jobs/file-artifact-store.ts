import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExportArtifactFinalizationIntentV1,
  type ExportArtifactStore,
  type ExportArtifactV1,
  type ExportByteCleanupResultV1,
  type PendingArtifactV1,
  type StagedArtifactV1,
} from "@atlcli/export-jobs";
import { ensurePrivateDirectory, writeDurableAtomic } from "./atomic-fs.js";
import { FileExportLock } from "./file-lock.js";
import { logicalDigest, readFileChunks, readJsonFiles, streamToDurableTemp } from "./file-byte-utils.js";

interface ArtifactMarkerV1 { schema: "atlcli.file-artifact/1"; state: "staged" | "committed"; metadata: StagedArtifactV1; }
interface ClosedV1 { schema: "atlcli.file-artifact-closed/1"; jobId: string; leaseEpoch?: number; at: number; }
function refFor(jobId: string, leaseEpoch: number): string { return `artifact:${jobId.length}:${jobId}:${leaseEpoch}`; }

/** Fenced staged/committed artifact byte store with streaming hash validation. */
export class FileExportArtifactStore implements ExportArtifactStore {
  readonly rootDir: string; readonly #objectsDir: string; readonly #closedDir: string; readonly #lock: FileExportLock; readonly #now: () => number;
  readonly #maxArtifactBytes: number; readonly #maxTotalBytes: number;
  constructor(rootDir: string, options: { now?: () => number; lockTtlMs?: number; maxArtifactBytes?: number; maxTotalBytes?: number } = {}) {
    this.rootDir = rootDir; this.#objectsDir = join(rootDir, "artifacts", "objects"); this.#closedDir = join(rootDir, "artifacts", "closed"); this.#now = options.now ?? Date.now;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? Number.MAX_SAFE_INTEGER; this.#maxTotalBytes = options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
    this.#lock = new FileExportLock(join(rootDir, "locks", "artifacts.lock"), { ttlMs: options.lockTtlMs ?? 30_000, now: options.now });
  }
  #markerPath(ref: string): string { return join(this.#objectsDir, `${logicalDigest(ref)}.json`); }
  #dataPath(ref: string): string { return join(this.#objectsDir, `${logicalDigest(ref)}.bin`); }
  #closedPath(jobId: string, epoch?: number): string { return join(this.#closedDir, `${logicalDigest([jobId, epoch ?? "all"])}.json`); }
  async stage(jobId: string, leaseEpoch: number, artifact: PendingArtifactV1, options?: { signal?: AbortSignal }): Promise<StagedArtifactV1> {
    if (!jobId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) throw new Error("Invalid artifact ownership.");
    if (artifact.byteLength > this.#maxArtifactBytes) throw new RangeError("Artifact byte limit exceeded.");
    const ref = refFor(jobId, leaseEpoch); await ensurePrivateDirectory(this.rootDir); await ensurePrivateDirectory(this.#objectsDir);
    const collected = await streamToDurableTemp(this.#dataPath(ref), artifact.bytes, this.#maxArtifactBytes, options?.signal);
    const lease = await this.#lock.acquire({ signal: options?.signal, label: "artifact-stage" });
    try {
      if (await this.#closed(jobId, leaseEpoch)) throw new Error("Artifact epoch is closed.");
      if (collected.byteLength !== artifact.byteLength) throw new Error("Artifact length does not match.");
      if (collected.sha256.toLowerCase() !== artifact.sha256.toLowerCase()) throw new Error("Artifact SHA-256 does not match.");
      const markers = (await readJsonFiles<ArtifactMarkerV1>(this.#objectsDir)).map((e) => e.value); const existing = markers.find((m) => m.metadata.ref === ref);
      if (existing) {
        if (existing.metadata.sha256.toLowerCase() !== collected.sha256 || existing.metadata.filename !== artifact.filename || existing.metadata.mediaType !== artifact.mediaType) throw new Error("Artifact ref cannot be replaced.");
        await collected.temp.discard(); return structuredClone(existing.metadata);
      }
      if (markers.reduce((sum, m) => sum + m.metadata.byteLength, 0) + collected.byteLength > this.#maxTotalBytes) throw new RangeError("Total artifact byte limit exceeded.");
      await collected.temp.commit(this.#dataPath(ref));
      const metadata: StagedArtifactV1 = { ref, mediaType: artifact.mediaType, filename: artifact.filename, byteLength: collected.byteLength, sha256: collected.sha256, jobId, leaseEpoch, stagedAt: this.#now() };
      await writeDurableAtomic(this.#markerPath(ref), `${JSON.stringify({ schema: "atlcli.file-artifact/1", state: "staged", metadata } satisfies ArtifactMarkerV1)}\n`);
      return structuredClone(metadata);
    } catch (error) { await collected.temp.discard(); throw error; }
    finally { await lease.release(); }
  }
  async getStaged(jobId: string, leaseEpoch: number): Promise<StagedArtifactV1 | undefined> { const marker = await this.#find(refFor(jobId, leaseEpoch)); return marker?.state === "staged" ? structuredClone(marker.metadata) : undefined; }
  read(ref: string, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    const load = async function* (self: FileExportArtifactStore): AsyncIterable<Uint8Array> { const marker = await self.#find(ref); if (!marker || marker.state !== "committed") throw new Error("Artifact is not committed."); yield* readFileChunks(self.#dataPath(ref), options?.signal); };
    return load(this);
  }
  async deleteStaged(ref: string): Promise<void> { const lease = await this.#lock.acquire({ label: "artifact-delete" }); try { const marker = await this.#find(ref); if (marker?.state === "staged") { await rm(this.#dataPath(ref), { force: true }); await rm(this.#markerPath(ref), { force: true }); } } finally { await lease.release(); } }
  async deleteStagedEpoch(jobId: string, leaseEpoch: number): Promise<ExportByteCleanupResultV1> { return this.#cleanup(jobId, leaseEpoch, false); }
  async cleanupJob(jobId: string): Promise<ExportByteCleanupResultV1> { return this.#cleanup(jobId, undefined, true); }
  async #cleanup(jobId: string, leaseEpoch: number | undefined, includeCommitted: boolean): Promise<ExportByteCleanupResultV1> {
    await ensurePrivateDirectory(this.rootDir);
    const lease = await this.#lock.acquire({ label: "artifact-cleanup" });
    try {
      await ensurePrivateDirectory(this.#closedDir); await writeDurableAtomic(this.#closedPath(jobId, leaseEpoch), `${JSON.stringify({ schema: "atlcli.file-artifact-closed/1", jobId, ...(leaseEpoch === undefined ? {} : { leaseEpoch }), at: this.#now() } satisfies ClosedV1)}\n`);
      let objectsDeleted = 0, bytesDeleted = 0;
      for (const entry of await readJsonFiles<ArtifactMarkerV1>(this.#objectsDir)) { const m = entry.value; if (m.metadata.jobId !== jobId || (leaseEpoch !== undefined && m.metadata.leaseEpoch !== leaseEpoch) || (!includeCommitted && m.state === "committed")) continue; await rm(this.#dataPath(m.metadata.ref), { force: true }); await rm(entry.path, { force: true }); objectsDeleted++; bytesDeleted += m.metadata.byteLength; }
      return { objectsDeleted, bytesDeleted };
    } finally { await lease.release(); }
  }
  async commitFinalization(intent: ExportArtifactFinalizationIntentV1): Promise<ExportArtifactV1> {
    const staged = intent.finalize.stagedArtifact; const lease = await this.#lock.acquire({ label: "artifact-commit" });
    try {
      if (await this.#closed(staged.jobId, staged.leaseEpoch)) throw new Error("Artifact epoch is closed.");
      const marker = await this.#find(staged.ref); if (!marker || JSON.stringify(marker.metadata) !== JSON.stringify(staged)) throw new Error("Exact staged artifact is missing.");
      if (marker.state === "staged") await writeDurableAtomic(this.#markerPath(staged.ref), `${JSON.stringify({ ...marker, state: "committed" } satisfies ArtifactMarkerV1)}\n`);
      return structuredClone(intent.artifact);
    } finally { await lease.release(); }
  }
  async #find(ref: string): Promise<ArtifactMarkerV1 | undefined> { return (await readJsonFiles<ArtifactMarkerV1>(this.#objectsDir)).map((e) => e.value).find((m) => m.metadata.ref === ref); }
  async #closed(jobId: string, epoch: number): Promise<boolean> { return (await readJsonFiles<ClosedV1>(this.#closedDir)).some((e) => e.value.jobId === jobId && (e.value.leaseEpoch === undefined || e.value.leaseEpoch === epoch)); }
}
