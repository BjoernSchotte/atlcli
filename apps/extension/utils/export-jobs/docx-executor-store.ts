import type {
  ExportJobExecutionContext,
  ExportJobExecutionResultV1,
  ExportJobSnapshotV1,
  SpoolRefV1,
  SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type {
  DocxExportResultIntentV1,
  DocxExportResultRecoveryKeyV1,
  DocxExportResultStoreV1,
  DocxReadyToRenderCheckpointV1,
  DocxReadyToRenderStoreV1,
} from "@atlcli/export-wiring/jobs";
import type { ExportReport, PreparedDocxExportV1 } from "@atlcli/docx/browser";
import {
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE,
  EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
  EXTENSION_EXPORT_JOBS_STORE,
  ExtensionExportCatalogError,
  extensionExportRequestResult,
  withExtensionExportTransaction,
} from "./catalog.js";
import {
  IndexedDbExportByteStore,
  extensionExportArtifactRef,
  type IndexedDbExportByteStoreOptions,
} from "./chunk-store.js";
import {
  EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1,
  assertLiveExecutorLeaseInTransaction,
  canonicalExecutorValue,
  cloneExecutorValue,
  collectExecutorBytes,
  dehydrateExecutorValue,
  digestExecutorBytes,
  executorSpoolSource,
  hydrateExecutorValue,
  sameExecutorValue,
  throwIfExecutorAborted,
} from "./executor-store.js";

interface PreparedManifestV1 {
  schema: "atlcli.extension-prepared-payload/1";
  value: unknown;
  blobs: SpoolRefV1[];
}

interface BytesPlaceholderV1 {
  __atlcliBytes: number;
}

interface ExtensionDocxCheckpointRowV1 {
  key: string;
  jobId: string;
  leaseEpoch: number;
  checkpoint: DocxReadyToRenderCheckpointV1;
  manifestRef: SpoolRefV1;
  updatedAt: number;
}

interface ExtensionDocxResultRowV1 {
  key: string;
  jobId: string;
  leaseEpoch: number;
  intent: DocxExportResultIntentV1;
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

export interface ExtensionDocxExecutorStoreOptionsV1
  extends IndexedDbExportByteStoreOptions {
  bytes?: IndexedDbExportByteStore;
  spoolLimits?: SpoolWriteLimitsV1;
}

function checkpointKey(jobId: string, requestId: string, requestKey: string): string {
  return `docx:${jobId.length}:${jobId}:${requestId.length}:${requestId}:${requestKey.length}:${requestKey}`;
}

function manifestRef(jobId: string, leaseEpoch: number, key: string): SpoolRefV1 {
  return { jobId, leaseEpoch, namespace: "ready-docx", key: `${key}:manifest` };
}

function blobRef(jobId: string, leaseEpoch: number, key: string, index: number): SpoolRefV1 {
  return { jobId, leaseEpoch, namespace: "ready-docx", key: `${key}:blob:${index}` };
}

function deferPreparedMediaBlobs(value: unknown, blobCount: number): Set<number> {
  const deferred = new Set<number>();
  if (value === null || typeof value !== "object") return deferred;
  const prepared = value as {
    packagingMode?: unknown;
    renderState?: { mediaParts?: unknown };
  };
  if (prepared.packagingMode !== "stream" || !Array.isArray(prepared.renderState?.mediaParts)) {
    return deferred;
  }
  for (const [partIndex, valuePart] of prepared.renderState.mediaParts.entries()) {
    if (valuePart === null || typeof valuePart !== "object") {
      throw new Error(`Prepared DOCX media part ${partIndex} is invalid.`);
    }
    const part = valuePart as {
      bytes?: Partial<BytesPlaceholderV1>;
      sourceRef?: string;
    };
    const blobIndex = part.bytes?.__atlcliBytes;
    if (
      !Number.isSafeInteger(blobIndex)
      || blobIndex! < 0
      || blobIndex! >= blobCount
      || deferred.has(blobIndex!)
    ) {
      throw new Error(`Prepared DOCX media part ${partIndex} has an invalid blob binding.`);
    }
    delete part.bytes;
    part.sourceRef = String(blobIndex);
    deferred.add(blobIndex!);
  }
  return deferred;
}

export function createExtensionDocxReadyToRenderStore(
  options: ExtensionDocxExecutorStoreOptionsV1 = {},
): DocxReadyToRenderStoreV1 {
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1;
  const now = options.now ?? Date.now;
  const lazyMediaRefs = new Map<string, SpoolRefV1[]>();
  return {
    async load({ jobId, request, signal }) {
      throwIfExecutorAborted(signal);
      const key = checkpointKey(jobId, request.id, request.idempotencyKey);
      const row = await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readonly",
        async (transaction) => extensionExportRequestResult(
          transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE).get(key),
        ) as Promise<ExtensionDocxCheckpointRowV1 | undefined>,
      );
      throwIfExecutorAborted(signal);
      return row ? cloneExecutorValue(row.checkpoint) : undefined;
    },

    async commit(input) {
      throwIfExecutorAborted(input.signal);
      const key = checkpointKey(
        input.jobId,
        input.request.id,
        input.request.idempotencyKey,
      );
      const blobs: Uint8Array[] = [];
      const value = dehydrateExecutorValue(input.prepared, blobs);
      const refs: SpoolRefV1[] = [];
      for (const [index, valueBytes] of blobs.entries()) {
        const ref = blobRef(input.jobId, input.leaseEpoch, key, index);
        await bytes.put(ref, executorSpoolSource(valueBytes), limits, {
          signal: input.signal,
        });
        refs.push(ref);
      }
      const durableManifestRef = manifestRef(input.jobId, input.leaseEpoch, key);
      const manifestBytes = new TextEncoder().encode(JSON.stringify({
        schema: "atlcli.extension-prepared-payload/1",
        value,
        blobs: refs,
      } satisfies PreparedManifestV1));
      await bytes.put(
        durableManifestRef,
        executorSpoolSource(manifestBytes),
        limits,
        { signal: input.signal },
      );
      const checkpoint: DocxReadyToRenderCheckpointV1 = {
        schema: "atlcli.docx-ready-to-render/1",
        ref: `extension-ready:${key}`,
        jobId: input.jobId,
        requestId: input.request.id,
        requestKey: input.request.idempotencyKey,
        preparedRef: `extension-prepared:${key}`,
        preparedByteLength: input.binding.byteLength,
        preparedSha256: input.binding.sha256,
        template: cloneExecutorValue(input.template),
        estimate: cloneExecutorValue(input.estimate),
        sourcePageCount: input.sourcePageCount,
        renderAttempts: 0,
      };
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            input.jobId,
            input.leaseEpoch,
            now(),
          );
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE);
          const existing = await extensionExportRequestResult(
            store.get(key),
          ) as ExtensionDocxCheckpointRowV1 | undefined;
          if (existing && !sameExecutorValue(existing.checkpoint, checkpoint)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different DOCX ready-to-render checkpoint already owns this request.",
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
            } satisfies ExtensionDocxCheckpointRowV1));
          }
        },
      );
      return checkpoint;
    },

    async materialize(input) {
      throwIfExecutorAborted(input.signal);
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
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            input.jobId,
            input.leaseEpoch,
            now(),
          );
          return extensionExportRequestResult(
            transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE).get(key),
          ) as Promise<ExtensionDocxCheckpointRowV1 | undefined>;
        },
      );
      if (!row || !sameExecutorValue(row.checkpoint, input.checkpoint)) {
        throw new Error("DOCX ready-to-render checkpoint metadata was not found or changed.");
      }
      const manifestBytes = await collectExecutorBytes(
        bytes.read(row.manifestRef, { signal: input.signal }),
        limits.maxObjectBytes,
        input.signal,
      );
      const manifest = JSON.parse(
        new TextDecoder().decode(manifestBytes),
      ) as PreparedManifestV1;
      if (manifest.schema !== "atlcli.extension-prepared-payload/1") {
        throw new Error("Prepared DOCX manifest schema is unsupported.");
      }
      const deferred = deferPreparedMediaBlobs(manifest.value, manifest.blobs.length);
      const blobs: Uint8Array[] = new Array(manifest.blobs.length);
      for (const [index, ref] of manifest.blobs.entries()) {
        if (deferred.has(index)) continue;
        // Exact-size preallocation via the store's own metadata (issue #118
        // Phase 0.5) — same shape as the PDF twin.
        const stat = await bytes.stat(ref);
        blobs[index] = await collectExecutorBytes(
          bytes.read(ref, { signal: input.signal }),
          limits.maxObjectBytes,
          input.signal,
          stat?.byteLength,
        );
      }
      lazyMediaRefs.set(input.checkpoint.ref, manifest.blobs);
      throwIfExecutorAborted(input.signal);
      return hydrateExecutorValue(manifest.value, blobs) as PreparedDocxExportV1;
    },

    async *readMedia(input) {
      throwIfExecutorAborted(input.signal);
      const refs = lazyMediaRefs.get(input.checkpoint.ref);
      const index = Number(input.sourceRef);
      if (
        !refs
        || !Number.isSafeInteger(index)
        || index < 0
        || index >= refs.length
      ) {
        throw new Error("Prepared DOCX media source is not bound to this checkpoint.");
      }
      yield* bytes.read(refs[index]!, { signal: input.signal });
      throwIfExecutorAborted(input.signal);
    },

    async beginRenderAttempt(input) {
      throwIfExecutorAborted(input.signal);
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
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            input.jobId,
            input.leaseEpoch,
            now(),
          );
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE);
          const row = await extensionExportRequestResult(
            store.get(key),
          ) as ExtensionDocxCheckpointRowV1 | undefined;
          if (!row || !sameExecutorValue(row.checkpoint, input.checkpoint)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "DOCX ready-to-render attempt no longer matches durable state.",
            );
          }
          const checkpoint = {
            ...cloneExecutorValue(row.checkpoint),
            renderAttempts: row.checkpoint.renderAttempts + 1,
          };
          await extensionExportRequestResult(store.put({
            ...row,
            leaseEpoch: input.leaseEpoch,
            checkpoint,
            updatedAt: now(),
          } satisfies ExtensionDocxCheckpointRowV1));
          return checkpoint;
        },
      );
    },
  };
}

function reportSpoolRef(
  jobId: string,
  leaseEpoch: number,
  key: DocxExportResultRecoveryKeyV1,
): SpoolRefV1 {
  return {
    jobId,
    leaseEpoch,
    namespace: "result-docx-report",
    key: `${key.ref}:report`,
  };
}

export function createExtensionDocxExportResultStore(
  options: ExtensionDocxExecutorStoreOptionsV1 = {},
): DocxExportResultStoreV1 {
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1;
  const now = options.now ?? Date.now;
  return {
    async recover(key, context) {
      throwIfExecutorAborted(context.signal);
      const recovered = await withExtensionExportTransaction(
        options,
        [
          EXTENSION_EXPORT_JOBS_STORE,
          EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
          EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
        ],
        "readwrite",
        async (transaction) => {
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            context.jobId,
            context.leaseEpoch,
            now(),
          );
          const results = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const row = await extensionExportRequestResult(
            results.get(key.ref),
          ) as ExtensionDocxResultRowV1 | undefined;
          if (!row || !row.result) return undefined;
          if (row.jobId !== context.jobId || !sameExecutorValue(row.intent.key, key)) {
            throw new Error("Recovered DOCX result is not bound to this execution key.");
          }
          if (row.leaseEpoch === context.leaseEpoch) {
            return {
              intent: cloneExecutorValue(row.intent),
              result: cloneExecutorValue(row.result),
            };
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
              "Completed DOCX result lost its exact staged artifact.",
            );
          }
          const nextRef = extensionExportArtifactRef(context.jobId, context.leaseEpoch);
          const conflicting = await extensionExportRequestResult(
            artifacts.index("artifactRef").get(nextRef),
          ) as ArtifactRowProjection | undefined;
          if (conflicting && conflicting.id !== physical.id) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "The recovered DOCX lease already owns another staged artifact.",
            );
          }
          const stagedArtifact = {
            ...cloneExecutorValue(priorArtifact),
            ref: nextRef,
            leaseEpoch: context.leaseEpoch,
          };
          const result = { ...cloneExecutorValue(row.result), stagedArtifact };
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
          } satisfies ExtensionDocxResultRowV1));
          return { intent: cloneExecutorValue(row.intent), result };
        },
      );
      throwIfExecutorAborted(context.signal);
      return recovered;
    },

    async prepare({ intent, report }, context) {
      throwIfExecutorAborted(context.signal);
      if (intent.key.jobId !== context.jobId) {
        throw new Error("DOCX result intent belongs to another job.");
      }
      const reportBytes = new TextEncoder().encode(canonicalExecutorValue(report));
      if (digestExecutorBytes(reportBytes) !== intent.reportSha256) {
        throw new Error("DOCX report does not match its durable result intent.");
      }
      const ref = reportSpoolRef(context.jobId, context.leaseEpoch, intent.key);
      await bytes.put(ref, executorSpoolSource(reportBytes), limits, {
        signal: context.signal,
      });
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            context.jobId,
            context.leaseEpoch,
            now(),
          );
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const existing = await extensionExportRequestResult(
            store.get(intent.key.ref),
          ) as ExtensionDocxResultRowV1 | undefined;
          if (
            existing
            && existing.leaseEpoch === context.leaseEpoch
            && (
              !sameExecutorValue(existing.intent, intent)
              || !sameExecutorValue(existing.reportSpoolRef, ref)
            )
          ) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different DOCX result intent already owns this lease.",
            );
          }
          await extensionExportRequestResult(store.put({
            key: intent.key.ref,
            jobId: context.jobId,
            leaseEpoch: context.leaseEpoch,
            intent: cloneExecutorValue(intent),
            reportRef: intent.reportRef,
            reportSpoolRef: ref,
            ...(existing?.leaseEpoch === context.leaseEpoch && existing.result
              ? { result: cloneExecutorValue(existing.result) }
              : {}),
            updatedAt: now(),
          } satisfies ExtensionDocxResultRowV1));
        },
      );
      return cloneExecutorValue(intent);
    },

    async stage({ intent, artifact }, context) {
      throwIfExecutorAborted(context.signal);
      const stagedArtifact = await context.artifacts.stage(artifact, {
        signal: context.signal,
      });
      const result: ExportJobExecutionResultV1 = {
        stagedArtifact,
        reportRef: intent.reportRef,
        reportSummary: cloneExecutorValue(intent.reportSummary),
      };
      await withExtensionExportTransaction(
        options,
        [EXTENSION_EXPORT_JOBS_STORE, EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
        "readwrite",
        async (transaction) => {
          await assertLiveExecutorLeaseInTransaction(
            transaction,
            context.jobId,
            context.leaseEpoch,
            now(),
          );
          const store = transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
          const row = await extensionExportRequestResult(
            store.get(intent.key.ref),
          ) as ExtensionDocxResultRowV1 | undefined;
          if (
            !row
            || row.jobId !== context.jobId
            || row.leaseEpoch !== context.leaseEpoch
            || !sameExecutorValue(row.intent, intent)
          ) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "DOCX artifact has no matching durable result intent.",
            );
          }
          if (row.result && !sameExecutorValue(row.result, result)) {
            throw new ExtensionExportCatalogError(
              "revision-conflict",
              "A different DOCX artifact already completed this result intent.",
            );
          }
          await extensionExportRequestResult(store.put({
            ...row,
            result: cloneExecutorValue(result),
            updatedAt: now(),
          } satisfies ExtensionDocxResultRowV1));
        },
      );
      return result;
    },
  };
}

/** Read the retained full DOCX report through its opaque Activity reference. */
export async function readExtensionDocxExportReport(
  reportRef: string,
  options: ExtensionDocxExecutorStoreOptionsV1 = {},
  signal?: AbortSignal,
): Promise<ExportReport | undefined> {
  if (signal) throwIfExecutorAborted(signal);
  const row = await withExtensionExportTransaction(
    options,
    [EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE],
    "readonly",
    async (transaction) => extensionExportRequestResult(
      transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE)
        .index("reportRef")
        .get(reportRef),
    ) as Promise<ExtensionDocxResultRowV1 | undefined>,
  );
  if (!row) return undefined;
  const bytes = options.bytes ?? new IndexedDbExportByteStore(options);
  const limits = options.spoolLimits ?? EXTENSION_EXPORT_EXECUTOR_DEFAULT_SPOOL_LIMITS_V1;
  const reportBytes = await collectExecutorBytes(
    bytes.read(row.reportSpoolRef, { signal }),
    limits.maxObjectBytes,
    signal,
  );
  if (digestExecutorBytes(reportBytes) !== row.intent.reportSha256) {
    throw new Error("Retained DOCX report failed its durable digest check.");
  }
  return JSON.parse(new TextDecoder().decode(reportBytes)) as ExportReport;
}
