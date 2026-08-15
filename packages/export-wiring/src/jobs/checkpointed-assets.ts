import {
  ByteReservationSemaphoreV1,
  type ExportJobExecutionContext,
  type SpoolRefV1,
} from "@atlcli/export-jobs";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_TOTAL_BYTES,
  AssetPipelineError,
} from "@atlcli/confluence";
import type { AssetFetcher, AssetRef } from "@atlcli/docx";
import type {
  PdfAssetRef,
  PdfAssetResolver,
  PdfResolvedAsset,
} from "@atlcli/pdf";

const CHECKPOINT_PREFIX = "atlcli.export-asset-spool/1:";
const CHECKPOINT_MAX_BYTES = 64 * 1024;
const MAX_RECOVERY_CHAIN = 10_000;

interface AssetCheckpointPayloadV1 {
  schema: "atlcli.export-asset-checkpoint/1";
  jobId: string;
  requestKey: string;
  referenceSha256: string;
  contentSha256: string;
  byteLength: number;
  dataRef: SpoolRefV1;
  previousRef?: string;
  mediaType?: string;
  filename?: string;
}

interface CachedAssetV1 {
  contentSha256: string;
  byteLength: number;
  dataRef: SpoolRefV1;
  mediaType?: string;
  filename?: string;
}

function encodeCheckpointRef(ref: SpoolRefV1): string {
  return `${CHECKPOINT_PREFIX}${encodeURIComponent(JSON.stringify(ref))}`;
}

function parseCheckpointRef(value: string): SpoolRefV1 {
  if (!value.startsWith(CHECKPOINT_PREFIX)) {
    throw new Error("Asset checkpoint is not an export-asset spool ref.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeURIComponent(value.slice(CHECKPOINT_PREFIX.length)),
    );
  } catch {
    throw new Error("Asset checkpoint contains an invalid spool ref.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SpoolRefV1).jobId !== "string" ||
    !Number.isSafeInteger((parsed as SpoolRefV1).leaseEpoch) ||
    typeof (parsed as SpoolRefV1).namespace !== "string" ||
    typeof (parsed as SpoolRefV1).key !== "string"
  ) {
    throw new Error("Asset checkpoint contains malformed spool coordinates.");
  }
  return parsed as SpoolRefV1;
}

/**
 * Stream publish-owned bytes to the spool WITHOUT a producer-side copy: every
 * spool sink owns what it stores (the extension chunk store copies per chunk,
 * the file store streams to disk, the in-memory store consolidates), and the
 * only callers pass buffers `publish()` privately owns — so a defensive copy
 * here was pure transient waste (issue #118 Phase 0.5 ratchet).
 */
function bytesSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncIterable<Uint8Array> {
    yield bytes;
  })();
}

async function collectBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  expectedByteLength?: number,
): Promise<Uint8Array> {
  if (expectedByteLength !== undefined) {
    // Known-length read-back (the checkpoint records the exact size): write
    // chunks straight into one preallocated buffer instead of buffering a
    // chunk list plus a concatenated copy.
    if (
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength < 0 ||
      expectedByteLength > maxBytes
    ) {
      throw new Error("Checkpointed asset exceeds its bounded object limit.");
    }
    const bytes = new Uint8Array(expectedByteLength);
    let offset = 0;
    for await (const chunk of source) {
      signal.throwIfAborted();
      if (offset + chunk.byteLength > expectedByteLength) {
        throw new Error("Checkpointed asset exceeds its bounded object limit.");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== expectedByteLength) {
      throw new Error("Checkpointed asset bytes do not match their binding.");
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(byteLength + chunk.byteLength) ||
      byteLength + chunk.byteLength > maxBytes
    ) {
      throw new Error("Checkpointed asset exceeds its bounded object limit.");
    }
    byteLength += chunk.byteLength;
    chunks.push(Uint8Array.from(chunk));
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  // WebCrypto snapshots its input synchronously at call time, and digesting a
  // typed-array VIEW hashes exactly the view's range — the old copy-then-
  // digest-the-buffer dance doubled every asset transiently for nothing.
  // Only a SharedArrayBuffer-backed view (which WebCrypto rejects) still
  // needs one owned copy.
  const source: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  signal.throwIfAborted();
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function validateSpoolRef(
  value: unknown,
  context: ExportJobExecutionContext,
): SpoolRefV1 {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as SpoolRefV1).jobId !== "string" ||
    !Number.isSafeInteger((value as SpoolRefV1).leaseEpoch) ||
    typeof (value as SpoolRefV1).namespace !== "string" ||
    typeof (value as SpoolRefV1).key !== "string"
  ) {
    throw new Error("Asset checkpoint contains an invalid data ref.");
  }
  const ref = value as SpoolRefV1;
  if (ref.jobId !== context.jobId || ref.leaseEpoch > context.leaseEpoch) {
    throw new Error("Asset checkpoint escaped its job or lease history.");
  }
  return ref;
}

function validatePayload(
  value: unknown,
  context: ExportJobExecutionContext,
  requestKey: string,
): AssetCheckpointPayloadV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as AssetCheckpointPayloadV1).schema !==
      "atlcli.export-asset-checkpoint/1" ||
    (value as AssetCheckpointPayloadV1).jobId !== context.jobId ||
    (value as AssetCheckpointPayloadV1).requestKey !== requestKey ||
    !/^[a-f0-9]{64}$/.test(
      (value as AssetCheckpointPayloadV1).referenceSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      (value as AssetCheckpointPayloadV1).contentSha256,
    ) ||
    !Number.isSafeInteger((value as AssetCheckpointPayloadV1).byteLength) ||
    (value as AssetCheckpointPayloadV1).byteLength <= 0 ||
    (value as AssetCheckpointPayloadV1).byteLength > ASSET_MAX_BYTES ||
    (
      (value as AssetCheckpointPayloadV1).previousRef !== undefined &&
      typeof (value as AssetCheckpointPayloadV1).previousRef !== "string"
    ) ||
    (
      (value as AssetCheckpointPayloadV1).mediaType !== undefined &&
      typeof (value as AssetCheckpointPayloadV1).mediaType !== "string"
    ) ||
    (
      (value as AssetCheckpointPayloadV1).filename !== undefined &&
      typeof (value as AssetCheckpointPayloadV1).filename !== "string"
    )
  ) {
    throw new Error("Asset checkpoint payload is malformed or mismatched.");
  }
  const payload = value as AssetCheckpointPayloadV1;
  validateSpoolRef(payload.dataRef, context);
  return payload;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function assetPipelineError(error: unknown): AssetPipelineError {
  if (error instanceof AssetPipelineError) return error;
  return new AssetPipelineError(
    `Durable asset checkpoint failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

interface CheckpointedAssetCacheV1<Result extends { bytes: Uint8Array }> {
  resolve(
    reference: unknown,
    load: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result>;
}

function createCheckpointedAssetCacheV1<
  Result extends { bytes: Uint8Array; mediaType?: string; filename?: string },
>(
  context: ExportJobExecutionContext,
  requestKey: string,
): CheckpointedAssetCacheV1<Result> {
  if (!context.readSpool) {
    throw new Error("This export host cannot read prior-epoch asset checkpoints.");
  }
  const reservations = new ByteReservationSemaphoreV1({
    maxBytes: ASSET_MAX_TOTAL_BYTES,
    maxReservations: 6,
  });
  const byReference = new Map<string, CachedAssetV1>();
  const byContent = new Map<string, CachedAssetV1>();
  const inFlight = new Map<string, Promise<Result>>();
  let initialized = false;
  let latestRef = context.checkpointRef;
  let checkpointSequence = 0;
  let commitTail = Promise.resolve();

  const readCheckpoint = async (
    encodedRef: string,
    signal: AbortSignal,
  ): Promise<AssetCheckpointPayloadV1> => {
    const ref = parseCheckpointRef(encodedRef);
    if (ref.jobId !== context.jobId || ref.leaseEpoch > context.leaseEpoch) {
      throw new Error("Asset checkpoint escaped its job or lease history.");
    }
    const bytes = await collectBytes(
      context.readSpool!(ref, { signal }),
      CHECKPOINT_MAX_BYTES,
      signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Asset checkpoint JSON is corrupt.");
    }
    return validatePayload(parsed, context, requestKey);
  };

  const recover = async (signal: AbortSignal): Promise<void> => {
    if (initialized) return;
    initialized = true;
    if (!latestRef?.startsWith(CHECKPOINT_PREFIX)) return;
    const seen = new Set<string>();
    let cursor: string | undefined = latestRef;
    for (let depth = 0; cursor?.startsWith(CHECKPOINT_PREFIX); depth += 1) {
      signal.throwIfAborted();
      if (depth >= MAX_RECOVERY_CHAIN) {
        throw new Error("Asset checkpoint chain exceeds its safety bound.");
      }
      if (seen.has(cursor)) {
        throw new Error("Asset checkpoint chain contains a cycle.");
      }
      seen.add(cursor);
      const payload = await readCheckpoint(cursor, signal);
      const cached: CachedAssetV1 = {
        contentSha256: payload.contentSha256,
        byteLength: payload.byteLength,
        dataRef: payload.dataRef,
        ...(payload.mediaType ? { mediaType: payload.mediaType } : {}),
        ...(payload.filename ? { filename: payload.filename } : {}),
      };
      if (!byReference.has(payload.referenceSha256)) {
        byReference.set(payload.referenceSha256, cached);
      }
      if (!byContent.has(payload.contentSha256)) {
        byContent.set(payload.contentSha256, cached);
      }
      checkpointSequence += 1;
      cursor = payload.previousRef;
    }
  };

  const loadCached = async (
    cached: CachedAssetV1,
    signal: AbortSignal,
  ): Promise<Result> => {
    const bytes = await collectBytes(
      context.readSpool!(cached.dataRef, { signal }),
      ASSET_MAX_BYTES,
      signal,
      cached.byteLength,
    );
    if (
      bytes.byteLength !== cached.byteLength ||
      await sha256Hex(bytes, signal) !== cached.contentSha256
    ) {
      throw new Error("Checkpointed asset bytes do not match their binding.");
    }
    return {
      bytes,
      ...(cached.mediaType ? { mediaType: cached.mediaType } : {}),
      ...(cached.filename ? { filename: cached.filename } : {}),
    } as Result;
  };

  const publish = async (
    referenceSha256: string,
    loaded: Result,
    signal: AbortSignal,
  ): Promise<Result> => {
    // THE ownership boundary: one owned snapshot of the host-fetched bytes,
    // taken before size/digest binding, so a caller mutating its buffer
    // afterwards cannot bypass what gets committed (the job-store applies the
    // same pattern). Everything downstream — digest, spool write, the value
    // returned to the engine — reuses this snapshot without further copies.
    const bytes = Uint8Array.from(loaded.bytes);
    if (bytes.byteLength === 0 || bytes.byteLength > ASSET_MAX_BYTES) {
      throw new Error(
        `Asset has ${bytes.byteLength} bytes; expected 1..${ASSET_MAX_BYTES}.`,
      );
    }
    const contentSha256 = await sha256Hex(bytes, signal);
    const commit = commitTail.then(async (): Promise<Result> => {
      signal.throwIfAborted();
      const existing = byReference.get(referenceSha256);
      if (existing) return loadCached(existing, signal);

      let content = byContent.get(contentSha256);
      if (!content) {
        const ref = {
          namespace: "assets",
          key: contentSha256,
        };
        const prior = await context.spool.stat(ref);
        const object = prior ?? await context.spool.put(
          ref,
          bytesSource(bytes),
          { signal },
        );
        if (
          object.byteLength !== bytes.byteLength ||
          object.sha256 !== contentSha256
        ) {
          throw new Error("Asset spool changed the content-addressed binding.");
        }
        content = {
          contentSha256,
          byteLength: bytes.byteLength,
          dataRef: object.ref,
          ...(loaded.mediaType ? { mediaType: loaded.mediaType } : {}),
          ...(loaded.filename ? { filename: loaded.filename } : {}),
        };
        byContent.set(contentSha256, content);
      }

      const payload: AssetCheckpointPayloadV1 = {
        schema: "atlcli.export-asset-checkpoint/1",
        jobId: context.jobId,
        requestKey,
        referenceSha256,
        contentSha256,
        byteLength: bytes.byteLength,
        dataRef: content.dataRef,
        ...(latestRef ? { previousRef: latestRef } : {}),
        ...(loaded.mediaType ? { mediaType: loaded.mediaType } : {}),
        ...(loaded.filename ? { filename: loaded.filename } : {}),
      };
      checkpointSequence += 1;
      const checkpoint = await context.spool.put(
        {
          namespace: "asset-checkpoints",
          key:
            `asset-${String(checkpointSequence).padStart(6, "0")}-` +
            referenceSha256.slice(0, 16),
        },
        bytesSource(new TextEncoder().encode(JSON.stringify(payload))),
        { signal },
      );
      latestRef = encodeCheckpointRef(checkpoint.ref);
      await context.checkpoint(latestRef);
      const cached: CachedAssetV1 = {
        ...content,
        ...(loaded.mediaType ? { mediaType: loaded.mediaType } : {}),
        ...(loaded.filename ? { filename: loaded.filename } : {}),
      };
      byReference.set(referenceSha256, cached);
      return {
        ...loaded,
        bytes,
      };
    });
    commitTail = commit.then(() => undefined, () => undefined);
    return commit;
  };

  return {
    async resolve(reference, load, signal) {
      signal.throwIfAborted();
      let referenceSha256: string;
      try {
        await recover(signal);
        referenceSha256 = await sha256Hex(
          new TextEncoder().encode(canonical(reference)),
          signal,
        );
        const cached = byReference.get(referenceSha256);
        if (cached) return await loadCached(cached, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw assetPipelineError(error);
      }
      const existing = inFlight.get(referenceSha256);
      if (existing) return existing;

      const run = (async (): Promise<Result> => {
        // Current engine ports do not expose Content-Length. Reserve the full
        // per-asset cap before the host fetch, which is conservative but keeps
        // unknown-length downloads bounded across PDF and DOCX.
        const reservation = await reservations.reserve(ASSET_MAX_BYTES, {
          signal,
        });
        try {
          signal.throwIfAborted();
          const loaded = await load();
          signal.throwIfAborted();
          try {
            return await publish(referenceSha256, loaded, signal);
          } catch (error) {
            signal.throwIfAborted();
            throw assetPipelineError(error);
          }
        } finally {
          reservation.release();
        }
      })();
      inFlight.set(referenceSha256, run);
      try {
        return await run;
      } finally {
        inFlight.delete(referenceSha256);
      }
    },
  };
}

/** Add byte reservation, content-addressed spooling, and recovery to DOCX assets. */
export function checkpointDocxAssetsV1(
  context: ExportJobExecutionContext,
  requestKey: string,
  delegate: AssetFetcher,
): AssetFetcher {
  const cache = createCheckpointedAssetCacheV1<{ bytes: Uint8Array }>(
    context,
    requestKey,
  );
  return {
    async fetch(ref: AssetRef, callContext) {
      const signal = callContext?.signal ?? context.signal;
      const result = await cache.resolve(
        { format: "docx", ref },
        async () => ({ bytes: await delegate.fetch(ref, { signal }) }),
        signal,
      );
      return result.bytes;
    },
  };
}

/** Add byte reservation, content-addressed spooling, and recovery to PDF assets. */
export function checkpointPdfAssetsV1(
  context: ExportJobExecutionContext,
  requestKey: string,
  delegate: PdfAssetResolver,
): PdfAssetResolver {
  const cache = createCheckpointedAssetCacheV1<PdfResolvedAsset>(
    context,
    requestKey,
  );
  return {
    resolve(ref: PdfAssetRef, callContext) {
      const signal = callContext?.signal ?? context.signal;
      return cache.resolve(
        { format: "pdf", ref },
        () => delegate.resolve(ref, { signal }),
        signal,
      );
    },
  };
}
