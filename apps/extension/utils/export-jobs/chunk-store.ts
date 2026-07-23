import {
  copyExactOwnedBytesV1,
  type ExportArtifactStore,
  type ExportByteCleanupResultV1,
  type ExportSpoolStore,
  type PendingArtifactV1,
  type SpoolObjectV1,
  type SpoolRefV1,
  type SpoolWriteLimitsV1,
  type StagedArtifactV1,
} from "@atlcli/export-jobs";
import {
  EXTENSION_EXPORT_BYTE_CHUNKS_STORE,
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  EXTENSION_EXPORT_COORDINATION_STORE,
  extensionExportRequestResult,
  withExtensionExportTransaction,
  type ExtensionExportCatalogOptions,
} from "./catalog.js";
import { IncrementalSha256 } from "./sha256.js";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

type ByteObjectState = "writing" | "committed" | "staged";
type ByteObjectKind = "spool" | "artifact";

interface ByteFenceRow {
  key: string;
  kind: "byte-job-fence" | "byte-epoch-fence";
  jobId: string;
  leaseEpoch?: number;
  closedAt: number;
}

interface ByteObjectRow {
  id: string;
  kind: ByteObjectKind;
  state: ByteObjectState;
  jobId: string;
  leaseEpoch: number;
  namespace?: string;
  key?: string;
  ref?: string;
  byteLength: number;
  chunkCount: number;
  sha256?: string;
  createdAt: number;
  committedAt?: number;
  mediaType?: PendingArtifactV1["mediaType"];
  filename?: string;
}

interface ByteChunkRow {
  objectId: string;
  index: number;
  bytes: Uint8Array;
}

export type ExtensionExportByteStoreErrorCode =
  | "invalid-limit"
  | "object-limit"
  | "job-limit"
  | "total-limit"
  | "length-mismatch"
  | "digest-mismatch"
  | "ownership-mismatch"
  | "not-committed";

export class ExtensionExportByteStoreError extends Error {
  readonly code: ExtensionExportByteStoreErrorCode;

  constructor(code: ExtensionExportByteStoreErrorCode, message: string) {
    super(message);
    this.name = "ExtensionExportByteStoreError";
    this.code = code;
  }
}

export interface IndexedDbExportByteStoreOptions extends ExtensionExportCatalogOptions {
  chunkBytes?: number;
  randomUUID?: () => string;
  /** Optional physical cap used by artifacts, which have no SpoolWriteLimits argument. */
  maxArtifactBytes?: number;
  maxJobBytes?: number;
  maxTotalBytes?: number;
  afterChunkWrite?: (index: number) => void;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExtensionExportByteStoreError("invalid-limit", `${label} must be a positive safe integer.`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The export was cancelled.", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function sameSpoolRef(row: ByteObjectRow, ref: SpoolRefV1): boolean {
  return row.kind === "spool"
    && row.jobId === ref.jobId
    && row.leaseEpoch === ref.leaseEpoch
    && row.namespace === ref.namespace
    && row.key === ref.key;
}

function spoolRefOf(row: ByteObjectRow): SpoolRefV1 {
  if (row.namespace === undefined || row.key === undefined) {
    throw new ExtensionExportByteStoreError("ownership-mismatch", "Stored spool ownership is incomplete.");
  }
  return { jobId: row.jobId, leaseEpoch: row.leaseEpoch, namespace: row.namespace, key: row.key };
}

function encodedJobId(jobId: string): string {
  return `${jobId.length}:${jobId}`;
}

function jobFenceKey(jobId: string): string {
  return `byte-fence:job:${encodedJobId(jobId)}`;
}

function epochFenceKey(jobId: string, leaseEpoch: number): string {
  return `byte-fence:epoch:${encodedJobId(jobId)}:${leaseEpoch}`;
}

export function extensionExportArtifactRef(jobId: string, leaseEpoch: number): string {
  return `artifact:${encodedJobId(jobId)}:${leaseEpoch}`;
}

function artifactObjectId(jobId: string, leaseEpoch: number): string {
  return `object:artifact:${encodedJobId(jobId)}:${leaseEpoch}`;
}

export class IndexedDbExportByteStore implements ExportSpoolStore, ExportArtifactStore {
  readonly #options: IndexedDbExportByteStoreOptions;
  readonly #chunkBytes: number;

  constructor(options: IndexedDbExportByteStoreOptions = {}) {
    this.#options = options;
    this.#chunkBytes = positiveLimit(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, "Chunk size");
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #id(prefix: string): string {
    const random = (this.#options.randomUUID ?? (() => crypto.randomUUID()))();
    return `${prefix}:${random}`;
  }

  async #findSpool(ref: SpoolRefV1): Promise<ByteObjectRow | undefined> {
    return withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readonly", async (tx) =>
      extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).index("spoolRef").get([
        ref.jobId,
        ref.leaseEpoch,
        ref.namespace,
        ref.key,
      ])) as Promise<ByteObjectRow | undefined>);
  }

  async #findArtifact(ref: string): Promise<ByteObjectRow | undefined> {
    return withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readonly", async (tx) =>
      extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).index("artifactRef").get(ref)) as Promise<ByteObjectRow | undefined>);
  }

  async #begin(row: ByteObjectRow): Promise<void> {
    await withExtensionExportTransaction(
      this.#options,
      [EXTENSION_EXPORT_COORDINATION_STORE, EXTENSION_EXPORT_BYTE_OBJECTS_STORE],
      "readwrite",
      async (tx) => {
        const fences = tx.objectStore(EXTENSION_EXPORT_COORDINATION_STORE);
        const [jobFence, epochFence] = await Promise.all([
          extensionExportRequestResult(fences.get(jobFenceKey(row.jobId))),
          extensionExportRequestResult(fences.get(epochFenceKey(row.jobId, row.leaseEpoch))),
        ]);
        if (jobFence || epochFence) {
          throw new ExtensionExportByteStoreError(
            "ownership-mismatch",
            "The byte namespace is closed against late executor writes.",
          );
        }
        await extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).add(row));
      },
    );
  }

  async #assertOpen(jobId: string, leaseEpoch: number): Promise<void> {
    await withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_COORDINATION_STORE], "readonly", async (tx) => {
      const fences = tx.objectStore(EXTENSION_EXPORT_COORDINATION_STORE);
      const [jobFence, epochFence] = await Promise.all([
        extensionExportRequestResult(fences.get(jobFenceKey(jobId))),
        extensionExportRequestResult(fences.get(epochFenceKey(jobId, leaseEpoch))),
      ]);
      if (jobFence || epochFence) {
        throw new ExtensionExportByteStoreError(
          "ownership-mismatch",
          "The byte namespace is closed against late executor writes.",
        );
      }
    });
  }

  async #measureSource(
    source: AsyncIterable<Uint8Array>,
    maxObjectBytes: number,
    signal?: AbortSignal,
  ): Promise<{ byteLength: number; sha256: string }> {
    const hasher = new IncrementalSha256();
    let byteLength = 0;
    for await (const incoming of source) {
      assertNotAborted(signal);
      if (!(incoming instanceof Uint8Array)) throw new TypeError("Byte sources must yield Uint8Array chunks.");
      byteLength += incoming.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength > maxObjectBytes) {
        throw new ExtensionExportByteStoreError("object-limit", "The byte object exceeds its configured limit.");
      }
      hasher.update(incoming);
    }
    assertNotAborted(signal);
    return { byteLength, sha256: hasher.digestHex() };
  }

  async #reuseSpool(
    existing: ByteObjectRow,
    ref: SpoolRefV1,
    source: AsyncIterable<Uint8Array>,
    maxObjectBytes: number,
    signal?: AbortSignal,
  ): Promise<SpoolObjectV1> {
    const measured = await this.#measureSource(source, maxObjectBytes, signal);
    if (
      measured.byteLength !== existing.byteLength ||
      measured.sha256 !== existing.sha256
    ) {
      throw new ExtensionExportByteStoreError(
        "ownership-mismatch",
        "A committed spool ref cannot be replaced by different bytes.",
      );
    }
    await this.#assertOpen(existing.jobId, existing.leaseEpoch);
    return {
      ref: cloneSpoolRef(ref),
      byteLength: existing.byteLength,
      sha256: existing.sha256!,
      committedAt: existing.committedAt!,
    };
  }

  async #reuseArtifact(
    existing: ByteObjectRow,
    artifact: PendingArtifactV1,
    signal?: AbortSignal,
  ): Promise<StagedArtifactV1> {
    const maxObjectBytes = positiveLimit(this.#options.maxArtifactBytes ?? 256 * 1024 * 1024, "Artifact byte limit");
    const measured = await this.#measureSource(artifact.bytes, maxObjectBytes, signal);
    if (measured.byteLength !== artifact.byteLength) {
      throw new ExtensionExportByteStoreError("length-mismatch", "Artifact byte length does not match its manifest.");
    }
    if (measured.sha256 !== artifact.sha256.toLowerCase()) {
      throw new ExtensionExportByteStoreError("digest-mismatch", "Artifact digest does not match its manifest.");
    }
    if (
      existing.byteLength !== measured.byteLength ||
      existing.sha256 !== measured.sha256 ||
      existing.mediaType !== artifact.mediaType ||
      existing.filename !== artifact.filename ||
      !existing.ref ||
      existing.committedAt === undefined
    ) {
      throw new ExtensionExportByteStoreError(
        "ownership-mismatch",
        "A staged artifact ref cannot be replaced by different bytes or metadata.",
      );
    }
    await this.#assertOpen(existing.jobId, existing.leaseEpoch);
    return {
      ref: existing.ref,
      mediaType: artifact.mediaType,
      filename: artifact.filename,
      byteLength: existing.byteLength,
      sha256: existing.sha256,
      jobId: existing.jobId,
      leaseEpoch: existing.leaseEpoch,
      stagedAt: existing.committedAt,
    };
  }

  async #append(
    objectId: string,
    index: number,
    bytes: Uint8Array,
    limits: { maxObjectBytes: number; maxJobBytes: number; maxTotalBytes: number },
  ): Promise<void> {
    await withExtensionExportTransaction(
      this.#options,
      [EXTENSION_EXPORT_BYTE_OBJECTS_STORE, EXTENSION_EXPORT_BYTE_CHUNKS_STORE],
      "readwrite",
      async (tx) => {
        const objects = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE);
        const current = await extensionExportRequestResult(objects.get(objectId)) as ByteObjectRow | undefined;
        if (!current || current.state !== "writing" || current.chunkCount !== index) {
          throw new ExtensionExportByteStoreError("ownership-mismatch", "The byte writer no longer owns this object.");
        }
        const nextLength = current.byteLength + bytes.byteLength;
        if (nextLength > limits.maxObjectBytes) {
          throw new ExtensionExportByteStoreError("object-limit", "The byte object exceeds its configured limit.");
        }
        const inventory = await extensionExportRequestResult(objects.getAll()) as ByteObjectRow[];
        const withoutCurrent = inventory.filter((row) => row.id !== objectId);
        const jobBytes = withoutCurrent.filter((row) => row.jobId === current.jobId).reduce((sum, row) => sum + row.byteLength, 0);
        const totalBytes = withoutCurrent.reduce((sum, row) => sum + row.byteLength, 0);
        if (jobBytes + nextLength > limits.maxJobBytes) {
          throw new ExtensionExportByteStoreError("job-limit", "The export job exceeds its configured byte limit.");
        }
        if (totalBytes + nextLength > limits.maxTotalBytes) {
          throw new ExtensionExportByteStoreError("total-limit", "Extension export storage exceeds its configured limit.");
        }
        await extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).add({
          objectId,
          index,
          bytes,
        } satisfies ByteChunkRow));
        await extensionExportRequestResult(objects.put({ ...current, byteLength: nextLength, chunkCount: index + 1 }));
      },
    );
    this.#options.afterChunkWrite?.(index);
  }

  async #finish(objectId: string, state: "committed" | "staged", sha256: string): Promise<ByteObjectRow> {
    return withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readwrite", async (tx) => {
      const store = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE);
      const current = await extensionExportRequestResult(store.get(objectId)) as ByteObjectRow | undefined;
      if (!current || current.state !== "writing") {
        throw new ExtensionExportByteStoreError("ownership-mismatch", "The byte writer no longer owns this object.");
      }
      const next = { ...current, state, sha256, committedAt: this.#now() } satisfies ByteObjectRow;
      await extensionExportRequestResult(store.put(next));
      return next;
    });
  }

  async #write(
    row: ByteObjectRow,
    source: AsyncIterable<Uint8Array>,
    limits: { maxObjectBytes: number; maxJobBytes: number; maxTotalBytes: number },
    state: "committed" | "staged",
    signal?: AbortSignal,
  ): Promise<ByteObjectRow> {
    const hasher = new IncrementalSha256();
    await this.#begin(row);
    let index = 0;
    try {
      for await (const incoming of source) {
        assertNotAborted(signal);
        if (!(incoming instanceof Uint8Array)) throw new TypeError("Byte sources must yield Uint8Array chunks.");
        for (let offset = 0; offset < incoming.byteLength; offset += this.#chunkBytes) {
          assertNotAborted(signal);
          const bytes = copyExactOwnedBytesV1(incoming.subarray(offset, Math.min(offset + this.#chunkBytes, incoming.byteLength)));
          if (bytes.byteLength === 0) continue;
          hasher.update(bytes);
          await this.#append(row.id, index, bytes, limits);
          index += 1;
        }
      }
      assertNotAborted(signal);
      return await this.#finish(row.id, state, hasher.digestHex());
    } catch (error) {
      await this.#deleteObject(row.id).catch(() => undefined);
      throw error;
    }
  }

  async put(
    ref: SpoolRefV1,
    source: AsyncIterable<Uint8Array>,
    limits: SpoolWriteLimitsV1,
    options: { signal?: AbortSignal } = {},
  ): Promise<SpoolObjectV1> {
    positiveLimit(limits.maxObjectBytes, "Object byte limit");
    positiveLimit(limits.maxJobBytes, "Job byte limit");
    positiveLimit(limits.maxTotalBytes, "Total byte limit");
    const existing = await this.#findSpool(ref);
    if (existing?.state === "committed" && existing.sha256 && existing.committedAt !== undefined) {
      return this.#reuseSpool(existing, ref, source, limits.maxObjectBytes, options.signal);
    }
    if (existing) await this.#deleteObject(existing.id);
    const stored = await this.#write({
      id: this.#id("spool"),
      kind: "spool",
      state: "writing",
      ...cloneSpoolRef(ref),
      byteLength: 0,
      chunkCount: 0,
      createdAt: this.#now(),
    }, source, limits, "committed", options.signal);
    return { ref: cloneSpoolRef(ref), byteLength: stored.byteLength, sha256: stored.sha256!, committedAt: stored.committedAt! };
  }

  async *read(ref: SpoolRefV1 | string, options: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const row = typeof ref === "string" ? await this.#findArtifact(ref) : await this.#findSpool(ref);
    if (!row || row.state !== "committed") throw new ExtensionExportByteStoreError("not-committed", "The byte object is not committed.");
    for (let index = 0; index < row.chunkCount; index += 1) {
      assertNotAborted(options.signal);
      const chunk = await withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_BYTE_CHUNKS_STORE], "readonly", async (tx) =>
        extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).get([row.id, index])) as Promise<ByteChunkRow | undefined>);
      if (!chunk) throw new ExtensionExportByteStoreError("not-committed", "A committed byte object is missing a chunk.");
      yield copyExactOwnedBytesV1(chunk.bytes);
    }
  }

  async stat(ref: SpoolRefV1): Promise<SpoolObjectV1 | undefined> {
    const row = await this.#findSpool(ref);
    if (!row || row.state !== "committed" || !row.sha256 || row.committedAt === undefined) return undefined;
    return { ref: cloneSpoolRef(ref), byteLength: row.byteLength, sha256: row.sha256, committedAt: row.committedAt };
  }

  /** Enumerate committed spool ownership without reading any stored byte chunks. */
  async listNamespaceRefs(jobId: string, leaseEpoch: number): Promise<SpoolRefV1[]> {
    const rows = await withExtensionExportTransaction(
      this.#options,
      [EXTENSION_EXPORT_BYTE_OBJECTS_STORE],
      "readonly",
      async (tx) => extensionExportRequestResult(
        tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE)
          .index("jobEpoch")
          .getAll([jobId, leaseEpoch]),
      ) as Promise<ByteObjectRow[]>,
    );
    return rows
      .filter((row) => row.kind === "spool" && row.state === "committed")
      .map(spoolRefOf);
  }

  async stage(
    jobId: string,
    leaseEpoch: number,
    artifact: PendingArtifactV1,
    options: { signal?: AbortSignal } = {},
  ): Promise<StagedArtifactV1> {
    const maxObjectBytes = positiveLimit(this.#options.maxArtifactBytes ?? 256 * 1024 * 1024, "Artifact byte limit");
    const limits = {
      maxObjectBytes,
      maxJobBytes: positiveLimit(this.#options.maxJobBytes ?? maxObjectBytes, "Job byte limit"),
      maxTotalBytes: positiveLimit(this.#options.maxTotalBytes ?? 512 * 1024 * 1024, "Total byte limit"),
    };
    const ref = extensionExportArtifactRef(jobId, leaseEpoch);
    const existing = await this.#findArtifact(ref);
    if (existing?.state === "staged") {
      if (existing.jobId !== jobId || existing.leaseEpoch !== leaseEpoch) {
        throw new ExtensionExportByteStoreError("ownership-mismatch", "The artifact ref belongs to another executor epoch.");
      }
      return this.#reuseArtifact(existing, artifact, options.signal);
    }
    if (existing) {
      throw new ExtensionExportByteStoreError(
        "ownership-mismatch",
        existing.state === "committed"
          ? "A finalized artifact cannot be staged again."
          : "The artifact ref is already being written.",
      );
    }
    const stored = await this.#write({
      id: artifactObjectId(jobId, leaseEpoch),
      kind: "artifact",
      state: "writing",
      jobId,
      leaseEpoch,
      ref,
      byteLength: 0,
      chunkCount: 0,
      createdAt: this.#now(),
      mediaType: artifact.mediaType,
      filename: artifact.filename,
    }, artifact.bytes, limits, "staged", options.signal);
    if (stored.byteLength !== artifact.byteLength) {
      await this.#deleteObject(stored.id);
      throw new ExtensionExportByteStoreError("length-mismatch", "Artifact byte length does not match its manifest.");
    }
    if (stored.sha256!.toLowerCase() !== artifact.sha256.toLowerCase()) {
      await this.#deleteObject(stored.id);
      throw new ExtensionExportByteStoreError("digest-mismatch", "Artifact digest does not match its manifest.");
    }
    return {
      ref,
      mediaType: artifact.mediaType,
      filename: artifact.filename,
      byteLength: stored.byteLength,
      sha256: stored.sha256!,
      jobId,
      leaseEpoch,
      stagedAt: stored.committedAt!,
    };
  }

  async getStaged(jobId: string, leaseEpoch: number): Promise<StagedArtifactV1 | undefined> {
    const row = await this.#findArtifact(extensionExportArtifactRef(jobId, leaseEpoch));
    if (row && (row.jobId !== jobId || row.leaseEpoch !== leaseEpoch || row.kind !== "artifact")) {
      throw new ExtensionExportByteStoreError("ownership-mismatch", "The artifact ref belongs to another executor epoch.");
    }
    if (!row?.ref || !row.sha256 || row.committedAt === undefined || !row.mediaType || !row.filename) return undefined;
    if (row.state !== "staged") return undefined;
    return {
      ref: row.ref,
      mediaType: row.mediaType,
      filename: row.filename,
      byteLength: row.byteLength,
      sha256: row.sha256,
      jobId,
      leaseEpoch,
      stagedAt: row.committedAt,
    };
  }

  async deleteStaged(ref: string): Promise<void> {
    const row = await this.#findArtifact(ref);
    if (row?.state === "staged") await this.#deleteObject(row.id);
  }

  async deleteStagedEpoch(jobId: string, leaseEpoch: number): Promise<ExportByteCleanupResultV1> {
    await this.#closeEpoch(jobId, leaseEpoch);
    return this.#deleteMatching((row) => row.kind === "artifact" && row.jobId === jobId && row.leaseEpoch === leaseEpoch && row.state !== "committed");
  }

  async deleteNamespace(
    jobId: string,
    leaseEpoch: number,
    options: { preserve?: readonly SpoolRefV1[] } = {},
  ): Promise<ExportByteCleanupResultV1> {
    for (const ref of options.preserve ?? []) {
      if (ref.jobId !== jobId || ref.leaseEpoch !== leaseEpoch) {
        throw new ExtensionExportByteStoreError(
          "ownership-mismatch",
          "Preserved spool refs must belong to the cleaned epoch.",
        );
      }
    }
    await this.#closeEpoch(jobId, leaseEpoch);
    return this.#deleteMatching((row) => row.kind === "spool"
      && row.jobId === jobId
      && row.leaseEpoch === leaseEpoch
      && !(options.preserve ?? []).some((ref) => sameSpoolRef(row, ref)));
  }

  async cleanupJob(jobId: string): Promise<ExportByteCleanupResultV1> {
    await this.#closeJob(jobId);
    return this.#deleteMatching((row) => row.jobId === jobId);
  }

  /** Recovery sweep for contexts terminated between chunk writes and manifest commit. */
  recoverIncompleteWrites(): Promise<ExportByteCleanupResultV1> {
    return this.#deleteMatching((row) => row.state === "writing");
  }

  async #closeJob(jobId: string): Promise<void> {
    await this.#putFence({
      key: jobFenceKey(jobId),
      kind: "byte-job-fence",
      jobId,
      closedAt: this.#now(),
    });
  }

  async #closeEpoch(jobId: string, leaseEpoch: number): Promise<void> {
    await this.#putFence({
      key: epochFenceKey(jobId, leaseEpoch),
      kind: "byte-epoch-fence",
      jobId,
      leaseEpoch,
      closedAt: this.#now(),
    });
  }

  async #putFence(fence: ByteFenceRow): Promise<void> {
    await withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_COORDINATION_STORE], "readwrite", async (tx) => {
      const store = tx.objectStore(EXTENSION_EXPORT_COORDINATION_STORE);
      const existing = await extensionExportRequestResult(store.get(fence.key)) as ByteFenceRow | undefined;
      if (existing && (existing.kind !== fence.kind || existing.jobId !== fence.jobId || existing.leaseEpoch !== fence.leaseEpoch)) {
        throw new ExtensionExportByteStoreError("ownership-mismatch", "A byte fence key has conflicting ownership.");
      }
      if (!existing) await extensionExportRequestResult(store.add(fence));
    });
  }

  async #deleteMatching(predicate: (row: ByteObjectRow) => boolean): Promise<ExportByteCleanupResultV1> {
    const rows = await withExtensionExportTransaction(this.#options, [EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readonly", async (tx) =>
      extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).getAll()) as Promise<ByteObjectRow[]>);
    let objectsDeleted = 0;
    let bytesDeleted = 0;
    for (const row of rows.filter(predicate)) {
      await this.#deleteObject(row.id);
      objectsDeleted += 1;
      bytesDeleted += row.byteLength;
    }
    return { objectsDeleted, bytesDeleted };
  }

  async #deleteObject(objectId: string): Promise<void> {
    await withExtensionExportTransaction(
      this.#options,
      [EXTENSION_EXPORT_BYTE_OBJECTS_STORE, EXTENSION_EXPORT_BYTE_CHUNKS_STORE],
      "readwrite",
      async (tx) => {
        const chunks = tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE);
        await deleteChunkKeys(chunks, objectId);
        await extensionExportRequestResult(tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).delete(objectId));
      },
    );
  }
}

async function deleteChunkKeys(chunks: IDBObjectStore, objectId: string): Promise<void> {
  const index = chunks.index("objectId");
  while (true) {
    // Keep cleanup byte-blind and key-memory bounded even for very large
    // artifacts. Re-querying after each batch is safe because every returned
    // primary key is deleted in this same readwrite transaction.
    const keys = await extensionExportRequestResult(index.getAllKeys(objectId, 128));
    if (keys.length === 0) return;
    for (const key of keys) {
      await extensionExportRequestResult(chunks.delete(key));
    }
  }
}

function cloneSpoolRef(ref: SpoolRefV1): SpoolRefV1 {
  return { jobId: ref.jobId, leaseEpoch: ref.leaseEpoch, namespace: ref.namespace, key: ref.key };
}
