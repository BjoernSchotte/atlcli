import { describe, expect, it } from "bun:test";
import { encodePng } from "@atlcli/export-media";
import {
  IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
  IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
  parseRasterNormalizerWorkerRequestV1,
  parseRasterNormalizerWorkerResponseV1,
  PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
  PURE_TS_RASTER_NORMALIZER_REVISION_V1,
  RASTER_NORMALIZER_WORKER_MAX_BYTES_V1,
  RASTER_NORMALIZER_WORKER_SCHEMA_V1,
} from "../../utils/pdf/raster-normalizer-protocol.js";

function request() {
  return {
    bytes: encodePng(new Uint8Array([0, 0, 0, 0xff]), 1, 1, false),
    mediaType: "image/png",
    renderEnvelopeWidthPt: 72,
    ppi: 96,
  };
}

describe("productive raster normalizer worker protocol", () => {
  it("accepts the complete closed request set", () => {
    expect(parseRasterNormalizerWorkerRequestV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "init",
      backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
      revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
    }).kind).toBe("init");
    expect(parseRasterNormalizerWorkerRequestV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "init",
      backend: IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
      revision: IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
    }).kind).toBe("init");
    expect(parseRasterNormalizerWorkerRequestV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "normalize",
      id: 1,
      request: { ...request(), authored: { widthPx: 20 } },
    }).kind).toBe("normalize");
    expect(parseRasterNormalizerWorkerRequestV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "cancel",
      id: 1,
    }).kind).toBe("cancel");
    expect(parseRasterNormalizerWorkerRequestV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "shutdown",
    }).kind).toBe("shutdown");
  });

  it("rejects unknown fields, kinds, stale IDs, malformed geometry, and oversized bytes", () => {
    const base = {
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "normalize",
      id: 1,
      request: request(),
    };
    expect(() => parseRasterNormalizerWorkerRequestV1({ ...base, secret: "x" }))
      .toThrow("normalize request");
    expect(() => parseRasterNormalizerWorkerRequestV1({ ...base, kind: "execute" }))
      .toThrow("kind");
    expect(() => parseRasterNormalizerWorkerRequestV1({ ...base, id: 0 }))
      .toThrow("normalize request");
    expect(() => parseRasterNormalizerWorkerRequestV1({
      ...base,
      request: { ...request(), ppi: Number.NaN },
    })).toThrow("normalize request");
    expect(() => parseRasterNormalizerWorkerRequestV1({
      ...base,
      request: {
        ...request(),
        bytes: new Uint8Array(RASTER_NORMALIZER_WORKER_MAX_BYTES_V1 + 1),
      },
    })).toThrow("normalize request");
  });

  it("accepts only bounded ready, result, kept, and error responses", () => {
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "ready",
      backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
      revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
    }).kind).toBe("ready");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "ready",
      backend: IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
      revision: IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
    }).kind).toBe("ready");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: 1,
      result: { kind: "kept", reason: "undecodable" },
    }).kind).toBe("result");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: 2,
      result: {
        kind: "normalized",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        width: 1,
        height: 1,
        sourceWidth: 2,
        sourceHeight: 2,
      },
    }).kind).toBe("result");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "error",
      id: 2,
      code: "normalization-failed",
      message: "synthetic",
      fatal: true,
    }).kind).toBe("error");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "error",
      code: "capability-unavailable",
      message: "synthetic",
      fatal: true,
    }).kind).toBe("error");
    expect(parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: 3,
      result: { kind: "kept", reason: "unsupported-raster-shape" },
    }).kind).toBe("result");
  });

  it("fails closed for drifted, duplicate-looking, and unbounded responses", () => {
    expect(() => parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "ready",
      backend: "image-bitmap",
      revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
    })).toThrow("ready response");
    expect(() => parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: 1,
      result: { kind: "kept", reason: "invented" },
    })).toThrow("result response");
    expect(() => parseRasterNormalizerWorkerResponseV1({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "error",
      code: "protocol-error",
      message: "x".repeat(513),
      fatal: true,
      extra: true,
    })).toThrow("error response");
  });
});
