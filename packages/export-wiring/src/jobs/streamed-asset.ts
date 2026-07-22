import {
  BoundedByteErrorV1,
  type ByteReservationSemaphoreV1,
  copyExactOwnedBytesV1,
} from "@atlcli/export-jobs";

export interface ExportAssetResponseV1 {
  /** Trusted only as a reservation hint; the observed length is still checked. */
  contentLength?: number;
  body: AsyncIterable<Uint8Array>;
}

export interface ExportAssetSourceV1<Reference> {
  fetch(reference: Reference, context: { signal: AbortSignal }): Promise<ExportAssetResponseV1>;
}

export interface StreamedExportAssetLimitsV1 {
  maxAssetBytes: number;
  maxChunkBytes: number;
}

export interface StreamedExportAssetResultV1<Result> {
  result: Result;
  byteLength: number;
  chunkCount: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Asset streaming aborted.", "AbortError");
}

function positiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

/**
 * Fetch and persist one asset without handing an unbounded body to the sink.
 *
 * A known length is reserved before the first body pull. Unknown lengths
 * reserve their complete configured ceiling, which is intentionally
 * conservative and prevents multiple unknown bodies from jointly overrunning
 * the host budget. The reservation is released after the sink settles.
 */
export async function streamBoundedExportAssetV1<Reference, Result>(options: {
  reference: Reference;
  source: ExportAssetSourceV1<Reference>;
  reservations: ByteReservationSemaphoreV1;
  limits: StreamedExportAssetLimitsV1;
  signal?: AbortSignal;
  persist(
    body: AsyncIterable<Uint8Array>,
    context: { declaredByteLength?: number; maxByteLength: number; signal: AbortSignal },
  ): Promise<Result>;
}): Promise<StreamedExportAssetResultV1<Result>> {
  positiveLimit(options.limits.maxAssetBytes, "maxAssetBytes");
  positiveLimit(options.limits.maxChunkBytes, "maxChunkBytes");

  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal ? abortReason(options.signal) : undefined);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    const response = await options.source.fetch(options.reference, { signal: controller.signal });
    const declared = response.contentLength;
    if (
      declared !== undefined &&
      (!Number.isSafeInteger(declared) || declared < 0 || declared > options.limits.maxAssetBytes)
    ) {
      throw new BoundedByteErrorV1(
        "stream-too-large",
        "Asset Content-Length is invalid or exceeds the configured limit.",
      );
    }

    const reservation = await options.reservations.reserve(
      declared ?? options.limits.maxAssetBytes,
      { signal: controller.signal },
    );
    let byteLength = 0;
    let chunkCount = 0;
    let completed = false;

    const boundedBody = (async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of response.body) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        if (!(chunk instanceof Uint8Array)) {
          throw new BoundedByteErrorV1("invalid-chunk", "Asset bodies must yield Uint8Array chunks.");
        }
        if (chunk.byteLength > options.limits.maxChunkBytes) {
          throw new BoundedByteErrorV1("chunk-too-large", "Asset chunk exceeds the configured limit.");
        }
        if (
          !Number.isSafeInteger(byteLength + chunk.byteLength) ||
          byteLength + chunk.byteLength > options.limits.maxAssetBytes ||
          (declared !== undefined && byteLength + chunk.byteLength > declared)
        ) {
          throw new BoundedByteErrorV1("stream-too-large", "Asset body exceeds its reserved length.");
        }
        byteLength += chunk.byteLength;
        if (chunk.byteLength === 0) continue;
        chunkCount += 1;
        yield copyExactOwnedBytesV1(chunk);
      }
      if (declared !== undefined && byteLength !== declared) {
        throw new BoundedByteErrorV1("stream-too-large", "Asset body does not match Content-Length.");
      }
      completed = true;
    })();

    try {
      const result = await options.persist(boundedBody, {
        ...(declared !== undefined ? { declaredByteLength: declared } : {}),
        maxByteLength: options.limits.maxAssetBytes,
        signal: controller.signal,
      });
      if (!completed) throw new Error("Asset sink returned before consuming the complete body.");
      return { result, byteLength, chunkCount };
    } finally {
      reservation.release();
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
