import type {
  ExportJobExecutionContext,
  ExportJobExecutionResultV1,
  ExportJobSnapshotV1,
  SpoolRefV1,
  SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type {
  PdfExportResultIntentV1,
  PdfExportResultRecoveryKeyV1,
  PdfExportResultStoreV1,
  PdfReadyToRenderCheckpointV1,
  PdfReadyToRenderStoreV1,
} from "@atlcli/export-wiring/jobs";
import type { PdfExportReport, PreparedPdfExportV1 } from "@atlcli/pdf/browser";
import {
  EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE,
  EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
  EXTENSION_EXPORT_JOBS_STORE,
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  ExtensionExportCatalogError,
  extensionExportRequestResult,
  withExtensionExportTransaction,
} from "./catalog.js";
import {
  IndexedDbExportByteStore,
  extensionExportArtifactRef,
  type IndexedDbExportByteStoreOptions,
} from "./chunk-store.js";
import { IncrementalSha256 } from "./sha256.js";

interface BytesPlaceholderV1 { __atlcliBytes: number; }
interface DatePlaceholderV1 { __atlcliDate: string; }
interface MapPlaceholderV1 { __atlcliMap: Array<[unknown, unknown]>; }
interface SetPlaceholderV1 { __atlcliSet: unknown[]; }

interface PreparedManifestV1 {
  schema: "atlcli.extension-prepared-payload/1";
  value: unknown;
  blobs: SpoolRefV1[];
}

interface ExtensionCheckpointRowV1 {
  key: string;
  jobId: string;
  leaseEpoch: number;
  checkpoint: PdfReadyToRenderCheckpointV1;
  manifestRef: SpoolRefV1;
  updatedAt: number;
}

interface ExtensionResultRowV1 {
  key: string;
  jobId: string;
  leaseEpoch: number;
  intent: PdfExportResultIntentV1;
  reportRef: string;
  reportSpoolRef: SpoolRefV1;
  result?: ExportJobExecutionResultV1;
  updatedAt: number;
}

interface ArtifactRowProjection {
  id: string;
  kind: "artifact";
  state: "writing" | "staged" | "committed";
  jobId: string;
  leaseEpoch: number;
  ref: string;
  byteLength: number;
  sha256?: string;
  mediaType?: string;
  filename?: string;
}

interface JobRowProjection {
  id: string;
  snapshot: ExportJobSnapshotV1;
}

export interface ExtensionPdfExecutorStoreOptionsV1 extends IndexedDbExportByteStoreOptions {
  bytes?: IndexedDbExportByteStore;
  spoolLimits?: SpoolWriteLimitsV1;
}

export const EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1: SpoolWriteLimitsV1 = {
  maxObjectBytes: 256 * 1024 * 1024,
  maxJobBytes: 384 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

function checkpointKey(jobId: string, requestId: string, requestKey: string): string {
  return `pdf:${jobId.length}:${jobId}:${requestId.length}:${requestId}:${requestKey.length}:${requestKey}`;
}

export function cloneExecutorValue<T>(value: T): T {
  return structuredClone(value);
}

export function throwIfExecutorAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The export was cancelled.", "AbortError");
  }
}

export function canonicalExecutorValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Durable export metadata contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) throw new Error("Durable export metadata contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalExecutorValue(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Durable export metadata must contain only plain data objects.");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalExecutorValue(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function sameExecutorValue(left: unknown, right: unknown): boolean {
  return canonicalExecutorValue(left) === canonicalExecutorValue(right);
}

export function dehydrateExecutorValue(value: unknown, blobs: Uint8Array[], seen = new Set<object>()): unknown {
  if (value instanceof Uint8Array) {
    const index = blobs.length;
    blobs.push(value);
    return { __atlcliBytes: index } satisfies BytesPlaceholderV1;
  }
  if (value instanceof Date) return { __atlcliDate: value.toISOString() } satisfies DatePlaceholderV1;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Prepared export payload contains a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => dehydrateExecutorValue(entry, blobs, seen));
    if (value instanceof Map) {
      return {
        __atlcliMap: [...value].map(([key, entry]) => [
          dehydrateExecutorValue(key, blobs, seen),
          dehydrateExecutorValue(entry, blobs, seen),
        ]),
      } satisfies MapPlaceholderV1;
    }
    if (value instanceof Set) {
      return { __atlcliSet: [...value].map((entry) => dehydrateExecutorValue(entry, blobs, seen)) } satisfies SetPlaceholderV1;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Prepared export payload must contain plain data.");
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, dehydrateExecutorValue(entry, blobs, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function hydrateExecutorValue(value: unknown, blobs: Uint8Array[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => hydrateExecutorValue(entry, blobs));
  if (
    Object.keys(value).length === 1
    && Number.isSafeInteger((value as Partial<BytesPlaceholderV1>).__atlcliBytes)
  ) {
    const blob = blobs[(value as BytesPlaceholderV1).__atlcliBytes];
    if (!blob) throw new Error("Prepared export payload references a missing blob.");
    return blob;
  }
  if (
    Object.keys(value).length === 1
    && typeof (value as Partial<DatePlaceholderV1>).__atlcliDate === "string"
  ) {
    return new Date((value as DatePlaceholderV1).__atlcliDate);
  }
  if (
    Object.keys(value).length === 1
    && Array.isArray((value as Partial<MapPlaceholderV1>).__atlcliMap)
  ) {
    return new Map((value as MapPlaceholderV1).__atlcliMap.map(
      ([key, entry]) => [hydrateExecutorValue(key, blobs), hydrateExecutorValue(entry, blobs)],
    ));
  }
  if (
    Object.keys(value).length === 1
    && Array.isArray((value as Partial<SetPlaceholderV1>).__atlcliSet)
  ) {
    return new Set((value as SetPlaceholderV1).__atlcliSet.map((entry) => hydrateExecutorValue(entry, blobs)));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, hydrateExecutorValue(entry, blobs)]),
  );
}

export async function collectExecutorBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    if (signal) throwIfExecutorAborted(signal);
    length += chunk.byteLength;
    if (length > maxBytes) throw new RangeError("Durable export object exceeds its configured limit.");
    chunks.push(chunk);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function digestExecutorBytes(bytes: Uint8Array): string {
  const hasher = new IncrementalSha256();
  hasher.update(bytes);
  return hasher.digestHex();
}

export function executorSpoolSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield bytes; })();
}

function assertLiveLease(row: JobRowProjection | undefined, jobId: string, leaseEpoch: number, now: number): void {
  const snapshot = row?.snapshot;
  if (
    !snapshot
    || snapshot.id !== jobId
    || snapshot.state !== "running"
    || snapshot.leaseEpoch !== leaseEpoch
    || snapshot.lease?.epoch !== leaseEpoch
    || snapshot.lease.expiresAt <= now
  ) {
    throw new ExtensionExportCatalogError(
      "revision-conflict",
      "Executor metadata write does not own the live extension job lease.",
    );
  }
}

export async function assertLiveExecutorLeaseInTransaction(
  transaction: IDBTransaction,
  jobId: string,
  leaseEpoch: number,
  now: number,
): Promise<void> {
  const row = await extensionExportRequestResult(
    transaction.objectStore(EXTENSION_EXPORT_JOBS_STORE).get(jobId),
  ) as JobRowProjection | undefined;
  assertLiveLease(row, jobId, leaseEpoch, now);
}

// Keep the PDF store implementation concise while exposing the exact same
// primitives to the DOCX store adapter.
const DEFAULT_SPOOL_LIMITS = EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1;
const clone = cloneExecutorValue;
const throwIfAborted = throwIfExecutorAborted;
const canonical = canonicalExecutorValue;
const same = sameExecutorValue;
const dehydrate = dehydrateExecutorValue;
const hydrate = hydrateExecutorValue;
const collect = collectExecutorBytes;
const digest = digestExecutorBytes;
const spoolSource = executorSpoolSource;
const assertLiveLeaseInTransaction = assertLiveExecutorLeaseInTransaction;

function manifestRef(jobId: string, leaseEpoch: number, key: string): SpoolRefV1 {
  return { jobId, leaseEpoch, namespace: "ready-pdf", key: `${key}:manifest` };
}

function blobRef(jobId: string, leaseEpoch: number, key: string, index: number): SpoolRefV1 {
  return { jobId, leaseEpoch, namespace: "ready-pdf", key: `${key}:blob:${index}` };
}

export function createExtensionPdfReadyToRenderStore(
  options: ExtensionPdfExecutorStoreOptionsV1 = {},
): PdfReadyToRenderStoreV1 {
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? DEFAULT_SPOOL_LIMITS;
  const now = options.now ?? Date.now;
  return {
    async load({ jobId, request, signal }) {
      throwIfAborted(signal);
      const key = checkpointKey(jobId, request.id, request.idempotencyKey);
      const row = await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readonly",
        async (transaction) => extensionExportRequestResult(
          transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE).get(key),
        ) as Promise<ExtensionCheckpointRowV1 | undefined>,
      );
      throwIfAborted(signal);
      return row ? clone(row.checkpoint) : undefined;
    },

    async commit(input) {
      throwIfAborted(input.signal);
      const key = checkpointKey(
        input.jobId,
        input.request.id,
        input.request.idempotencyKey,
      );
      const blobs: Uint8Array[] = [];
      const value = dehydrate(input.prepared, blobs);
      const refs: SpoolRefV1[] = [];
      for (const [index, valueBytes] of blobs.entries()) {
        const ref = blobRef(input.jobId, input.leaseEpoch, key, index);
        await bytes.put(ref, spoolSource(valueBytes), limits, { signal: input.signal });
        refs.push(ref);
      }
      const durableManifestRef = manifestRef(input.jobId, input.leaseEpoch, key);
      const manifestBytes = new TextEncoder().encode(JSON.stringify({
        schema: "atlcli.extension-prepared-payload/1",
        value,
        blobs: refs,
      } satisfies PreparedManifestV1));
      await bytes.put(durableManifestRef, spoolSource(manifestBytes), limits, { signal: input.signal });
      const checkpoint: PdfReadyToRenderCheckpointV1 = {
        schema: "atlcli.pdf-ready-to-render/1",
        ref: `extension-ready:${key}`,
        jobId: input.jobId,
        requestId: input.request.id,
        requestKey: input.request.idempotencyKey,
        preparedRef: `extension-prepared:${key}`,
        preparedByteLength: input.binding.byteLength,
        preparedSha256: input.binding.sha256,
        estimate: clone(input.estimate),
        sourcePageCount: input.sourcePageCount,
        renderAttempts: 0,
      };
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, input.jobId, input.leaseEpoch, now());
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE);
          const existing = await extensionExportRequestResult(store.get(key)) as ExtensionCheckpointRowV1 | undefined;
          if (existing && !same(existing.checkpoint, checkpoint)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different ready-to-render checkpoint already owns this request.",
            );
          }
          if (!existing) {
            await extensionExportRequestResult(store.add({
              key,
              jobId: input.jobId,
              leaseEpoch: input.leaseEpoch,
              checkpoint,
              manifestRef: durableManifestRef,
              updatedAt: now(),
            } satisfies ExtensionCheckpointRowV1));
          }
        },
      );
      return checkpoint;
    },

    async materialize(input) {
      throwIfAborted(input.signal);
      const key = checkpointKey(
        input.checkpoint.jobId,
        input.checkpoint.requestId,
        input.checkpoint.requestKey,
      );
      const row = await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readonly",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, input.jobId, input.leaseEpoch, now());
          return extensionExportRequestResult(
            transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE).get(key),
          ) as Promise<ExtensionCheckpointRowV1 | undefined>;
        },
      );
      if (!row || !same(row.checkpoint, input.checkpoint)) {
        throw new Error("Ready-to-render checkpoint metadata was not found or changed.");
      }
      const manifestBytes = await collect(bytes.read(row.manifestRef, { signal: input.signal }), limits.maxObjectBytes, input.signal);
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as PreparedManifestV1;
      if (manifest.schema !== "atlcli.extension-prepared-payload/1") {
        throw new Error("Prepared PDF manifest schema is unsupported.");
      }
      const blobs: Uint8Array[] = [];
      for (const ref of manifest.blobs) {
        blobs.push(await collect(bytes.read(ref, { signal: input.signal }), limits.maxObjectBytes, input.signal));
      }
      throwIfAborted(input.signal);
      return hydrate(manifest.value, blobs) as PreparedPdfExportV1;
    },

    async beginRenderAttempt(input) {
      throwIfAborted(input.signal);
      const key = checkpointKey(
        input.checkpoint.jobId,
        input.checkpoint.requestId,
        input.checkpoint.requestKey,
      );
      return withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, input.jobId, input.leaseEpoch, now());
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE);
          const row = await extensionExportRequestResult(store.get(key)) as ExtensionCheckpointRowV1 | undefined;
          if (!row || !same(row.checkpoint, input.checkpoint)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "Ready-to-render attempt no longer matches durable state.",
            );
          }
          const checkpoint = {
            ...clone(row.checkpoint),
            renderAttempts: row.checkpoint.renderAttempts + 1,
          };
          await extensionExportRequestResult(store.put({
            ...row,
            leaseEpoch: input.leaseEpoch,
            checkpoint,
            updatedAt: now(),
          } satisfies ExtensionCheckpointRowV1));
          return checkpoint;
        },
      );
    },
  };
}

function reportSpoolRef(
  jobId: string,
  leaseEpoch: number,
  key: PdfExportResultRecoveryKeyV1,
): SpoolRefV1 {
  return {
    jobId,
    leaseEpoch,
    namespace: "result-pdf-report",
    key: `${key.ref}:report`,
  };
}

export function createExtensionPdfExportResultStore(
  options: ExtensionPdfExecutorStoreOptionsV1 = {},
): PdfExportResultStoreV1 {
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? DEFAULT_SPOOL_LIMITS;
  const now = options.now ?? Date.now;
  return {
    async recover(key, context) {
      throwIfAborted(context.signal);
      const recovered = await withExtensionExportTransaction(
        options,
        [
          EXTENSION_EXPORT_JOBS_STORE,
          EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
          EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
        ],
        "readwrite",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, context.jobId, context.leaseEpoch, now());
          const results = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const row = await extensionExportRequestResult(
            results.get(key.ref),
          ) as ExtensionResultRowV1 | undefined;
          if (!row || !row.result) return undefined;
          if (row.jobId !== context.jobId || !same(row.intent.key, key)) {
            throw new Error("Recovered PDF result is not bound to this execution key.");
          }
          if (row.leaseEpoch === context.leaseEpoch) {
            return { intent: clone(row.intent), result: clone(row.result) };
          }

          const priorArtifact = row.result.stagedArtifact;
          const artifacts = transaction.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE);
          const physical = await extensionExportRequestResult(
            artifacts.index("artifactRef").get(priorArtifact.ref),
          ) as ArtifactRowProjection | undefined;
          if (
            !physical
            || physical.kind !== "artifact"
            || physical.state !== "staged"
            || physical.jobId !== context.jobId
            || physical.leaseEpoch !== priorArtifact.leaseEpoch
            || physical.byteLength !== priorArtifact.byteLength
            || physical.sha256 !== priorArtifact.sha256
            || physical.mediaType !== priorArtifact.mediaType
            || physical.filename !== priorArtifact.filename
          ) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "Completed PDF result lost its exact staged artifact.",
            );
          }
          const nextRef = extensionExportArtifactRef(context.jobId, context.leaseEpoch);
          const conflicting = await extensionExportRequestResult(
            artifacts.index("artifactRef").get(nextRef),
          ) as ArtifactRowProjection | undefined;
          if (conflicting && conflicting.id !== physical.id) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "The recovered PDF lease already owns another staged artifact.",
            );
          }
          const stagedArtifact = {
            ...clone(priorArtifact),
            ref: nextRef,
            leaseEpoch: context.leaseEpoch,
          };
          const result = { ...clone(row.result), stagedArtifact };
          await extensionExportRequestResult(artifacts.put({
            ...physical,
            ref: nextRef,
            leaseEpoch: context.leaseEpoch,
          } satisfies ArtifactRowProjection));
          await extensionExportRequestResult(results.put({
            ...row,
            leaseEpoch: context.leaseEpoch,
            result,
            updatedAt: now(),
          } satisfies ExtensionResultRowV1));
          return { intent: clone(row.intent), result };
        },
      );
      throwIfAborted(context.signal);
      return recovered;
    },

    async prepare({ intent, report }, context) {
      throwIfAborted(context.signal);
      if (intent.key.jobId !== context.jobId) {
        throw new Error("PDF result intent belongs to another job.");
      }
      const reportBytes = new TextEncoder().encode(canonical(report));
      if (digest(reportBytes) !== intent.reportSha256) {
        throw new Error("PDF report does not match its durable result intent.");
      }
      const ref = reportSpoolRef(context.jobId, context.leaseEpoch, intent.key);
      await bytes.put(ref, spoolSource(reportBytes), limits, { signal: context.signal });
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, context.jobId, context.leaseEpoch, now());
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const existing = await extensionExportRequestResult(
            store.get(intent.key.ref),
          ) as ExtensionResultRowV1 | undefined;
          if (
            existing
            && existing.leaseEpoch === context.leaseEpoch
            && (!same(existing.intent, intent) || !same(existing.reportSpoolRef, ref))
          ) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different PDF result intent already owns this lease.",
            );
          }
          await extensionExportRequestResult(store.put({
            key: intent.key.ref,
            jobId: context.jobId,
            leaseEpoch: context.leaseEpoch,
            intent: clone(intent),
            reportRef: intent.reportRef,
            reportSpoolRef: ref,
            ...(existing?.leaseEpoch === context.leaseEpoch && existing.result
              ? { result: clone(existing.result) }
              : {}),
            updatedAt: now(),
          } satisfies ExtensionResultRowV1));
        },
      );
      return clone(intent);
    },

    async stage({ intent, artifact }, context) {
      throwIfAborted(context.signal);
      const stagedArtifact = await context.artifacts.stage(artifact, { signal: context.signal });
      const result: ExportJobExecutionResultV1 = {
        stagedArtifact,
        reportRef: intent.reportRef,
        reportSummary: clone(intent.reportSummary),
      };
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveLeaseInTransaction(transaction, context.jobId, context.leaseEpoch, now());
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const row = await extensionExportRequestResult(
            store.get(intent.key.ref),
          ) as ExtensionResultRowV1 | undefined;
          if (
            !row
            || row.jobId !== context.jobId
            || row.leaseEpoch !== context.leaseEpoch
            || !same(row.intent, intent)
          ) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "PDF artifact has no matching durable result intent.",
            );
          }
          if (row.result && !same(row.result, result)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different PDF artifact already completed this result intent.",
            );
          }
          await extensionExportRequestResult(store.put({
            ...row,
            result: clone(result),
            updatedAt: now(),
          } satisfies ExtensionResultRowV1));
        },
      );
      return result;
    },
  };
}

/** Read a retained full PDF report without exposing its physical spool ref to Activity. */
export async function readExtensionPdfExportReport(
  reportRef: string,
  options: ExtensionPdfExecutorStoreOptionsV1 = {},
  signal?: AbortSignal,
): Promise<PdfExportReport | undefined> {
  if (signal) throwIfAborted(signal);
  const row = await withExtensionExportTransaction(
    options,
    [EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
    "readonly",
    async (transaction) => extensionExportRequestResult(
      transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE)
        .index("reportRef")
        .get(reportRef),
    ) as Promise<ExtensionResultRowV1 | undefined>,
  );
  if (!row) return undefined;
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? DEFAULT_SPOOL_LIMITS;
  const reportBytes = await collect(bytes.read(row.reportSpoolRef, { signal }), limits.maxObjectBytes, signal);
  if (digest(reportBytes) !== row.intent.reportSha256) {
    throw new Error("Retained PDF report failed its durable digest check.");
  }
  return JSON.parse(new TextDecoder().decode(reportBytes)) as PdfExportReport;
}
