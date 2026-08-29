import type {
  RasterKeptReason,
  RasterNormalizeRequestV1,
  RasterNormalizeResultV1,
} from "@atlcli/export-media";

export const RASTER_NORMALIZER_WORKER_SCHEMA_V1 =
  "atlcli.raster-normalizer-worker/1" as const;
export const PURE_TS_RASTER_NORMALIZER_BACKEND_V1 = "pure-ts" as const;
export const PURE_TS_RASTER_NORMALIZER_REVISION_V1 = "pure-ts-v1" as const;
export const IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1 = "image-bitmap" as const;
export const IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1 = "image-bitmap-v1" as const;

export type RasterNormalizerWorkerBackendV1 =
  | typeof PURE_TS_RASTER_NORMALIZER_BACKEND_V1
  | typeof IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1;
export type RasterNormalizerWorkerRevisionV1 =
  | typeof PURE_TS_RASTER_NORMALIZER_REVISION_V1
  | typeof IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1;

/** Mirrors the productive per-asset ceiling without granting a larger worker input. */
export const RASTER_NORMALIZER_WORKER_MAX_BYTES_V1 = 64 * 1024 * 1024;

export type RasterNormalizerWorkerInitRequestV1 = {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "init";
  backend: typeof PURE_TS_RASTER_NORMALIZER_BACKEND_V1;
  revision: typeof PURE_TS_RASTER_NORMALIZER_REVISION_V1;
} | {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "init";
  backend: typeof IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1;
  revision: typeof IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1;
};

export interface RasterNormalizerWorkerNormalizeRequestV1 {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "normalize";
  id: number;
  request: RasterNormalizeRequestV1;
}

export interface RasterNormalizerWorkerCancelRequestV1 {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "cancel";
  id: number;
}

export interface RasterNormalizerWorkerShutdownRequestV1 {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "shutdown";
}

export type RasterNormalizerWorkerRequestV1 =
  | RasterNormalizerWorkerInitRequestV1
  | RasterNormalizerWorkerNormalizeRequestV1
  | RasterNormalizerWorkerCancelRequestV1
  | RasterNormalizerWorkerShutdownRequestV1;

export type RasterNormalizerWorkerReadyResponseV1 = {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "ready";
  backend: typeof PURE_TS_RASTER_NORMALIZER_BACKEND_V1;
  revision: typeof PURE_TS_RASTER_NORMALIZER_REVISION_V1;
} | {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "ready";
  backend: typeof IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1;
  revision: typeof IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1;
};

export interface RasterNormalizerWorkerResultResponseV1 {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "result";
  id: number;
  result: RasterNormalizeResultV1;
}

export interface RasterNormalizerWorkerErrorResponseV1 {
  schema: typeof RASTER_NORMALIZER_WORKER_SCHEMA_V1;
  kind: "error";
  id?: number;
  code:
    | "cancelled"
    | "normalization-failed"
    | "capability-unavailable"
    | "native-path-failed"
    | "protocol-error";
  message: string;
  fatal: boolean;
}

export type RasterNormalizerWorkerResponseV1 =
  | RasterNormalizerWorkerReadyResponseV1
  | RasterNormalizerWorkerResultResponseV1
  | RasterNormalizerWorkerErrorResponseV1;

const KEPT_REASONS = new Set<RasterKeptReason>([
  "not-raster",
  "undecodable",
  "no-downscale",
  "decode-budget-exceeded",
  "unsupported-raster-shape",
]);

function isBackendRevisionPair(
  backend: unknown,
  revision: unknown,
): backend is RasterNormalizerWorkerBackendV1 {
  return (
    backend === PURE_TS_RASTER_NORMALIZER_BACKEND_V1
    && revision === PURE_TS_RASTER_NORMALIZER_REVISION_V1
  ) || (
    backend === IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1
    && revision === IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isAuthoredSize(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, [], ["widthPx", "heightPx"])) {
    return false;
  }
  if (Object.keys(value).length === 0) return false;
  return (value.widthPx === undefined || isPositiveFinite(value.widthPx))
    && (value.heightPx === undefined || isPositiveFinite(value.heightPx));
}

function isNormalizeRequest(value: unknown): value is RasterNormalizeRequestV1 {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(
      value,
      ["bytes", "mediaType", "renderEnvelopeWidthPt", "ppi"],
      ["authored"],
    )
    || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength === 0
    || value.bytes.byteLength > RASTER_NORMALIZER_WORKER_MAX_BYTES_V1
    || typeof value.mediaType !== "string"
    || value.mediaType.length === 0
    || value.mediaType.length > 64
    || !isPositiveFinite(value.renderEnvelopeWidthPt)
    || !isPositiveFinite(value.ppi)
  ) {
    return false;
  }
  return value.authored === undefined || isAuthoredSize(value.authored);
}

function isKeptResult(value: Record<string, unknown>): value is Extract<
  RasterNormalizeResultV1,
  { kind: "kept" }
> {
  return hasExactKeys(value, ["kind", "reason"])
    && value.kind === "kept"
    && typeof value.reason === "string"
    && KEPT_REASONS.has(value.reason as RasterKeptReason);
}

function isNormalizedResult(value: Record<string, unknown>): value is Extract<
  RasterNormalizeResultV1,
  { kind: "normalized" }
> {
  return hasExactKeys(
    value,
    ["kind", "bytes", "mediaType", "width", "height", "sourceWidth", "sourceHeight"],
  )
    && value.kind === "normalized"
    && value.bytes instanceof Uint8Array
    && value.bytes.byteLength > 0
    && value.bytes.byteLength <= RASTER_NORMALIZER_WORKER_MAX_BYTES_V1
    && (value.mediaType === "image/png" || value.mediaType === "image/jpeg")
    && isRequestId(value.width)
    && isRequestId(value.height)
    && isRequestId(value.sourceWidth)
    && isRequestId(value.sourceHeight);
}

function isNormalizeResult(value: unknown): value is RasterNormalizeResultV1 {
  return isPlainRecord(value) && (isKeptResult(value) || isNormalizedResult(value));
}

export function parseRasterNormalizerWorkerRequestV1(
  value: unknown,
): RasterNormalizerWorkerRequestV1 {
  if (!isPlainRecord(value) || value.schema !== RASTER_NORMALIZER_WORKER_SCHEMA_V1) {
    throw new Error("Raster normalizer worker request schema is invalid.");
  }
  if (value.kind === "init") {
    if (
      !hasExactKeys(value, ["schema", "kind", "backend", "revision"])
      || !isBackendRevisionPair(value.backend, value.revision)
    ) {
      throw new Error("Raster normalizer worker init request is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerInitRequestV1;
  }
  if (value.kind === "normalize") {
    if (
      !hasExactKeys(value, ["schema", "kind", "id", "request"])
      || !isRequestId(value.id)
      || !isNormalizeRequest(value.request)
    ) {
      throw new Error("Raster normalizer worker normalize request is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerNormalizeRequestV1;
  }
  if (value.kind === "cancel") {
    if (!hasExactKeys(value, ["schema", "kind", "id"]) || !isRequestId(value.id)) {
      throw new Error("Raster normalizer worker cancel request is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerCancelRequestV1;
  }
  if (value.kind === "shutdown") {
    if (!hasExactKeys(value, ["schema", "kind"])) {
      throw new Error("Raster normalizer worker shutdown request is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerShutdownRequestV1;
  }
  throw new Error("Raster normalizer worker request kind is invalid.");
}

export function parseRasterNormalizerWorkerResponseV1(
  value: unknown,
): RasterNormalizerWorkerResponseV1 {
  if (!isPlainRecord(value) || value.schema !== RASTER_NORMALIZER_WORKER_SCHEMA_V1) {
    throw new Error("Raster normalizer worker response schema is invalid.");
  }
  if (value.kind === "ready") {
    if (
      !hasExactKeys(value, ["schema", "kind", "backend", "revision"])
      || !isBackendRevisionPair(value.backend, value.revision)
    ) {
      throw new Error("Raster normalizer worker ready response is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerReadyResponseV1;
  }
  if (value.kind === "result") {
    if (
      !hasExactKeys(value, ["schema", "kind", "id", "result"])
      || !isRequestId(value.id)
      || !isNormalizeResult(value.result)
    ) {
      throw new Error("Raster normalizer worker result response is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerResultResponseV1;
  }
  if (value.kind === "error") {
    if (
      !hasExactKeys(value, ["schema", "kind", "code", "message", "fatal"], ["id"])
      || (value.id !== undefined && !isRequestId(value.id))
      || ![
        "cancelled",
        "normalization-failed",
        "capability-unavailable",
        "native-path-failed",
        "protocol-error",
      ].includes(value.code as string)
      || typeof value.message !== "string"
      || value.message.length === 0
      || value.message.length > 512
      || typeof value.fatal !== "boolean"
    ) {
      throw new Error("Raster normalizer worker error response is invalid.");
    }
    return value as unknown as RasterNormalizerWorkerErrorResponseV1;
  }
  throw new Error("Raster normalizer worker response kind is invalid.");
}
