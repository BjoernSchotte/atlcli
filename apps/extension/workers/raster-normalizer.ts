import {
  classifyImageBitmapEligibilityV1,
  encodePng,
  encodeRasterTargetV1,
  normalizeRasterAssetV1,
  planRasterNormalizationV1,
  type RasterNormalizationPlanV1,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "@atlcli/export-media";
import {
  IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
  parseRasterNormalizerWorkerRequestV1,
  PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
  RASTER_NORMALIZER_WORKER_SCHEMA_V1,
  type RasterNormalizerWorkerBackendV1,
  type RasterNormalizerWorkerErrorResponseV1,
  type RasterNormalizerWorkerResponseV1,
  type RasterNormalizerWorkerRevisionV1,
} from "../utils/pdf/raster-normalizer-protocol.js";

const workerScope = self as DedicatedWorkerGlobalScope;
let backend: RasterNormalizerWorkerBackendV1 | undefined;
let revision: RasterNormalizerWorkerRevisionV1 | undefined;
let initializing = false;
let activeRequestId: number | undefined;
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

function mediaType(plan: RasterNormalizationPlanV1): "image/png" | "image/jpeg" {
  return plan.sourceFormat === "png" ? "image/png" : "image/jpeg";
}

function targetHasAlpha(pixels: Uint8ClampedArray): boolean {
  for (let index = 3; index < pixels.byteLength; index += 4) {
    if (pixels[index] !== 0xff) return true;
  }
  return false;
}

async function probeImageBitmapCapability(): Promise<void> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("ImageBitmap and OffscreenCanvas are unavailable.");
  }
  const bytes = encodePng(new Uint8Array([0x20, 0x40, 0x60]), 1, 1, false);
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes as BlobPart], { type: "image/png" }),
      {
        resizeWidth: 1,
        resizeHeight: 1,
        resizeQuality: "medium",
        imageOrientation: "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      },
    );
    if (bitmap.width !== 1 || bitmap.height !== 1) {
      throw new Error("ImageBitmap capability probe returned unexpected geometry.");
    }
    canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("OffscreenCanvas 2D is unavailable.");
    context.drawImage(bitmap, 0, 0);
    if (context.getImageData(0, 0, 1, 1).data.byteLength !== 4) {
      throw new Error("ImageBitmap capability probe returned invalid pixels.");
    }
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

async function normalizeImageBitmap(
  request: RasterNormalizeRequestV1,
): Promise<RasterNormalizeResultV1> {
  const planned = planRasterNormalizationV1(request);
  if (planned.kind === "kept") return planned;
  const eligibility = classifyImageBitmapEligibilityV1(request.bytes);
  if (
    eligibility.kind === "ineligible"
    || eligibility.format !== planned.plan.sourceFormat
    || eligibility.width !== planned.plan.sourceWidth
    || eligibility.height !== planned.plan.sourceHeight
  ) {
    return { kind: "kept", reason: "unsupported-raster-shape" };
  }

  const { plan } = planned;
  let source: Blob | undefined = new Blob([request.bytes as BlobPart], {
    type: mediaType(plan),
  });
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    bitmap = await createImageBitmap(source, {
      resizeWidth: plan.targetWidth,
      resizeHeight: plan.targetHeight,
      resizeQuality: "medium",
      imageOrientation: "none",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    source = undefined;
    request.bytes = new Uint8Array(0);
    if (bitmap.width !== plan.targetWidth || bitmap.height !== plan.targetHeight) {
      throw new Error("ImageBitmap target geometry disagrees with the shared plan.");
    }

    canvas = new OffscreenCanvas(plan.targetWidth, plan.targetHeight);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("OffscreenCanvas 2D is unavailable.");
    context.drawImage(bitmap, 0, 0, plan.targetWidth, plan.targetHeight);
    bitmap.close();
    bitmap = undefined;
    const pixels = context.getImageData(0, 0, plan.targetWidth, plan.targetHeight).data;
    canvas.width = 1;
    canvas.height = 1;
    canvas = undefined;
    return encodeRasterTargetV1({
      plan,
      pixels,
      hasAlpha: eligibility.mayHaveAlpha && targetHasAlpha(pixels),
    });
  } finally {
    source = undefined;
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

async function initialize(
  requestedBackend: RasterNormalizerWorkerBackendV1,
  requestedRevision: RasterNormalizerWorkerRevisionV1,
): Promise<void> {
  if (backend || initializing) {
    fail("protocol-error", "Raster normalizer worker was initialized twice.", { fatal: true });
    return;
  }
  initializing = true;
  try {
    if (requestedBackend === IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1) {
      await probeImageBitmapCapability();
    }
    backend = requestedBackend;
    revision = requestedRevision;
    post({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "ready",
      backend: requestedBackend,
      revision: requestedRevision,
    } as RasterNormalizerWorkerResponseV1);
  } catch {
    fail(
      "capability-unavailable",
      "ImageBitmap raster capability probe failed.",
      { fatal: true },
    );
  } finally {
    initializing = false;
  }
}

async function normalize(id: number, request: RasterNormalizeRequestV1): Promise<void> {
  if (!backend || !revision || initializing) {
    fail("protocol-error", "Raster normalizer worker is not initialized.", { id, fatal: true });
    return;
  }
  if (activeRequestId !== undefined || id <= lastRequestId) {
    fail("protocol-error", "Raster normalizer request IDs must increase exactly once.", {
      id,
      fatal: true,
    });
    return;
  }
  lastRequestId = id;
  activeRequestId = id;
  if (cancelledIds.delete(id)) {
    activeRequestId = undefined;
    fail("cancelled", "Raster normalization was cancelled before it started.", {
      id,
      fatal: false,
    });
    return;
  }
  try {
    const result = backend === PURE_TS_RASTER_NORMALIZER_BACKEND_V1
      ? normalizeRasterAssetV1(request)
      : await normalizeImageBitmap(request);
    if (cancelledIds.delete(id)) {
      fail("cancelled", "Raster normalization was cancelled.", { id, fatal: false });
      return;
    }
    post(
      {
        schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
        kind: "result",
        id,
        result,
      },
      result.kind === "normalized"
        ? [result.bytes.buffer as ArrayBuffer]
        : [],
    );
  } catch {
    fail(
      backend === IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1
        ? "native-path-failed"
        : "normalization-failed",
      backend === IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1
        ? "ImageBitmap raster normalization failed."
        : "Pure raster normalization failed.",
      { id, fatal: true },
    );
  } finally {
    activeRequestId = undefined;
  }
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
    void initialize(request.backend, request.revision);
    return;
  }
  if (request.kind === "shutdown") {
    workerScope.close();
    return;
  }
  if (request.kind === "cancel") {
    if (request.id > lastRequestId || request.id === activeRequestId) {
      cancelledIds.add(request.id);
    }
    return;
  }
  void normalize(request.id, request.request);
});
