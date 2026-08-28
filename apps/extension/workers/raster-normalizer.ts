import { normalizeRasterAssetV1 } from "@atlcli/export-media";
import {
  parseRasterNormalizerWorkerRequestV1,
  PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
  PURE_TS_RASTER_NORMALIZER_REVISION_V1,
  RASTER_NORMALIZER_WORKER_SCHEMA_V1,
  type RasterNormalizerWorkerErrorResponseV1,
  type RasterNormalizerWorkerResponseV1,
} from "../utils/pdf/raster-normalizer-protocol.js";

const workerScope = self as DedicatedWorkerGlobalScope;
let initialized = false;
let lastRequestId = 0;
const cancelledIds = new Set<number>();

function post(
  response: RasterNormalizerWorkerResponseV1,
  transfer: Transferable[] = [],
): void {
  workerScope.postMessage(response, transfer);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Raster normalization failed.";
  return normalized.slice(0, 512);
}

function fail(
  code: RasterNormalizerWorkerErrorResponseV1["code"],
  error: unknown,
  options: { id?: number; fatal: boolean },
): void {
  post({
    schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
    kind: "error",
    code,
    message: boundedMessage(error),
    fatal: options.fatal,
    ...(options.id !== undefined ? { id: options.id } : {}),
  });
  if (options.fatal) workerScope.close();
}

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  let request: ReturnType<typeof parseRasterNormalizerWorkerRequestV1>;
  try {
    request = parseRasterNormalizerWorkerRequestV1(event.data);
  } catch (error) {
    fail("protocol-error", error, { fatal: true });
    return;
  }

  if (request.kind === "init") {
    if (initialized) {
      fail("protocol-error", "Raster normalizer worker was initialized twice.", {
        fatal: true,
      });
      return;
    }
    initialized = true;
    post({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "ready",
      backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
      revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
    });
    return;
  }

  if (request.kind === "shutdown") {
    workerScope.close();
    return;
  }

  if (!initialized) {
    fail("protocol-error", "Raster normalizer worker is not initialized.", {
      ...(request.kind === "normalize" || request.kind === "cancel"
        ? { id: request.id }
        : {}),
      fatal: true,
    });
    return;
  }

  if (request.kind === "cancel") {
    if (request.id > lastRequestId) cancelledIds.add(request.id);
    return;
  }

  if (request.id <= lastRequestId) {
    fail("protocol-error", "Raster normalizer request IDs must increase exactly once.", {
      id: request.id,
      fatal: true,
    });
    return;
  }
  lastRequestId = request.id;
  if (cancelledIds.delete(request.id)) {
    fail("cancelled", "Raster normalization was cancelled before it started.", {
      id: request.id,
      fatal: false,
    });
    return;
  }

  try {
    const result = normalizeRasterAssetV1(request.request);
    const response: RasterNormalizerWorkerResponseV1 = {
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: request.id,
      result,
    };
    post(
      response,
      result.kind === "normalized"
        ? [result.bytes.buffer as ArrayBuffer]
        : [],
    );
  } catch (error) {
    fail("normalization-failed", error, { id: request.id, fatal: true });
  }
});
