import {
  boxResampleRgba,
  decodeJpegRaster,
  decodePngRaster,
  encodeRasterTargetV1,
  planRasterNormalizationV1,
  type RasterNormalizationPlanV1,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "@atlcli/export-media";
import pica, { type Pica } from "pica/pica_main";
import type {
  RasterNormalizerPhase,
  RasterNormalizerVariant,
} from "./protocol.js";

interface InitRequest {
  kind: "init";
  variant: RasterNormalizerVariant;
}

interface NormalizeRequest {
  kind: "normalize";
  id: number;
  request: RasterNormalizeRequestV1;
  probe: boolean;
}

type WorkerRequest = InitRequest | NormalizeRequest | { kind: "continue" } | { kind: "shutdown" };

type Detail = Record<string, number | string | boolean>;

type WorkerResponse =
  | { kind: "ready"; variant: RasterNormalizerVariant; detail: Detail }
  | {
      kind: "phase";
      id: number;
      phase: Extract<
        RasterNormalizerPhase,
        "source-held" | "decoded-held" | "target-held" | "encoded-held"
      >;
      detail: Detail;
    }
  | {
      kind: "result";
      id: number;
      result: RasterNormalizeResultV1;
      elapsedMs: number;
      detail: Detail;
    }
  | { kind: "error"; id?: number; message: string };

interface DecoderFrame {
  image: VideoFrame;
  complete: boolean;
}

interface BrowserImageDecoder {
  decode(options?: { frameIndex?: number; completeFramesOnly?: boolean }): Promise<DecoderFrame>;
  close(): void;
}

type BrowserImageDecoderConstructor = new (init: {
  type: string;
  data: BufferSource;
  desiredWidth?: number;
  desiredHeight?: number;
  preferAnimation?: boolean;
}) => BrowserImageDecoder;

const scope = self as DedicatedWorkerGlobalScope;
let variant: RasterNormalizerVariant | undefined;
let resumeProbe: (() => void) | undefined;
let picaRuntime: Pica | undefined;

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer);
}

function imageDecoderConstructor(): BrowserImageDecoderConstructor | undefined {
  return (globalThis as typeof globalThis & {
    ImageDecoder?: BrowserImageDecoderConstructor;
  }).ImageDecoder;
}

function mediaTypeFor(plan: RasterNormalizationPlanV1): "image/png" | "image/jpeg" {
  return plan.sourceFormat === "png" ? "image/png" : "image/jpeg";
}

function hasAlpha(pixels: Uint8Array | Uint8ClampedArray): boolean {
  for (let index = 3; index < pixels.byteLength; index += 4) {
    if (pixels[index] !== 0xff) return true;
  }
  return false;
}

async function phase(
  payload: NormalizeRequest,
  value: "source-held" | "decoded-held" | "target-held" | "encoded-held",
  detail: Detail,
): Promise<void> {
  if (!payload.probe) return;
  post({ kind: "phase", id: payload.id, phase: value, detail });
  await new Promise<void>((resolve) => {
    resumeProbe = resolve;
  });
  resumeProbe = undefined;
}

function targetPixelsFromCanvas(
  canvas: OffscreenCanvas,
  plan: RasterNormalizationPlanV1,
): Uint8ClampedArray {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("OffscreenCanvas 2D is unavailable.");
  const pixels = context.getImageData(0, 0, plan.targetWidth, plan.targetHeight).data;
  // Drop Chrome's canvas backing before the target-held sample. The returned
  // ImageData is the only full target copy the pinned encoder needs.
  canvas.width = 1;
  canvas.height = 1;
  return pixels;
}

async function pureTsPixels(
  payload: NormalizeRequest,
  plan: RasterNormalizationPlanV1,
): Promise<{ pixels: Uint8Array; alpha: boolean }> {
  let decoded: ReturnType<typeof decodePngRaster> =
    plan.sourceFormat === "png"
      ? decodePngRaster(payload.request.bytes)
      : decodeJpegRaster(payload.request.bytes);
  if (!decoded) throw new Error(`The pure-TS ${plan.sourceFormat} decoder rejected the asset.`);
  if (decoded.width !== plan.sourceWidth || decoded.height !== plan.sourceHeight) {
    throw new Error("The pure-TS decoder dimensions disagree with the shared header plan.");
  }
  await phase(payload, "decoded-held", {
    sourceFormat: plan.sourceFormat,
    decodedWidth: decoded.width,
    decodedHeight: decoded.height,
    decodedBytes: decoded.pixels.byteLength,
  });
  const alpha = decoded.hasAlpha;
  const pixels = boxResampleRgba(
    decoded.pixels,
    decoded.width,
    decoded.height,
    plan.targetWidth,
    plan.targetHeight,
  );
  decoded = null;
  payload.request.bytes = new Uint8Array(0);
  return { pixels, alpha };
}

async function webCodecsPixels(
  payload: NormalizeRequest,
  plan: RasterNormalizationPlanV1,
): Promise<{ pixels: Uint8ClampedArray; alpha: boolean }> {
  const Decoder = imageDecoderConstructor();
  if (!Decoder) throw new Error("WebCodecs ImageDecoder is unavailable in this worker.");
  let decoder: BrowserImageDecoder | undefined = new Decoder({
    type: mediaTypeFor(plan),
    data: payload.request.bytes.buffer as ArrayBuffer,
    desiredWidth: plan.targetWidth,
    desiredHeight: plan.targetHeight,
    preferAnimation: false,
  });
  let frame: VideoFrame | undefined = (await decoder.decode({
    frameIndex: 0,
    completeFramesOnly: true,
  })).image;
  await phase(payload, "decoded-held", {
    sourceFormat: plan.sourceFormat,
    decodedWidth: frame.displayWidth,
    decodedHeight: frame.displayHeight,
    decodedBytes: frame.displayWidth * frame.displayHeight * 4,
    decoderRequestedTarget: true,
  });
  const canvas = new OffscreenCanvas(plan.targetWidth, plan.targetHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("OffscreenCanvas 2D is unavailable.");
  context.drawImage(frame as unknown as CanvasImageSource, 0, 0, plan.targetWidth, plan.targetHeight);
  frame.close();
  frame = undefined;
  decoder.close();
  decoder = undefined;
  payload.request.bytes = new Uint8Array(0);
  const pixels = targetPixelsFromCanvas(canvas, plan);
  return { pixels, alpha: plan.sourceFormat === "png" && hasAlpha(pixels) };
}

async function imageBitmapPixels(
  payload: NormalizeRequest,
  plan: RasterNormalizationPlanV1,
): Promise<{ pixels: Uint8ClampedArray; alpha: boolean }> {
  let bitmap: ImageBitmap | undefined = await createImageBitmap(
    new Blob([payload.request.bytes as BlobPart], { type: mediaTypeFor(plan) }),
    {
      resizeWidth: plan.targetWidth,
      resizeHeight: plan.targetHeight,
      resizeQuality: "high",
      imageOrientation: "from-image",
      premultiplyAlpha: "default",
      colorSpaceConversion: "default",
    },
  );
  await phase(payload, "decoded-held", {
    sourceFormat: plan.sourceFormat,
    decodedWidth: bitmap.width,
    decodedHeight: bitmap.height,
    decodedBytes: bitmap.width * bitmap.height * 4,
    decoderRequestedTarget: true,
  });
  const canvas = new OffscreenCanvas(plan.targetWidth, plan.targetHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("OffscreenCanvas 2D is unavailable.");
  context.drawImage(bitmap, 0, 0, plan.targetWidth, plan.targetHeight);
  bitmap.close();
  bitmap = undefined;
  payload.request.bytes = new Uint8Array(0);
  const pixels = targetPixelsFromCanvas(canvas, plan);
  return { pixels, alpha: plan.sourceFormat === "png" && hasAlpha(pixels) };
}

async function picaPixels(
  payload: NormalizeRequest,
  plan: RasterNormalizationPlanV1,
): Promise<{ pixels: Uint8ClampedArray; alpha: boolean }> {
  if (!picaRuntime) throw new Error("Pica was not initialized.");
  let bitmap: ImageBitmap | undefined = await createImageBitmap(
    new Blob([payload.request.bytes as BlobPart], { type: mediaTypeFor(plan) }),
    { imageOrientation: "from-image", premultiplyAlpha: "default" },
  );
  await phase(payload, "decoded-held", {
    sourceFormat: plan.sourceFormat,
    decodedWidth: bitmap.width,
    decodedHeight: bitmap.height,
    decodedBytes: bitmap.width * bitmap.height * 4,
    decoderRequestedTarget: false,
  });
  const canvas = new OffscreenCanvas(plan.targetWidth, plan.targetHeight);
  await picaRuntime.resize(bitmap, canvas, { filter: "mks2013" });
  bitmap.close();
  bitmap = undefined;
  payload.request.bytes = new Uint8Array(0);
  const pixels = targetPixelsFromCanvas(canvas, plan);
  return { pixels, alpha: plan.sourceFormat === "png" && hasAlpha(pixels) };
}

async function normalize(payload: NormalizeRequest): Promise<void> {
  const startedAt = performance.now();
  const planned = planRasterNormalizationV1(payload.request);
  if (planned.kind === "kept") {
    post({
      kind: "result",
      id: payload.id,
      result: planned,
      elapsedMs: performance.now() - startedAt,
      detail: { normalized: false, reason: planned.reason },
    });
    return;
  }
  const { plan } = planned;
  await phase(payload, "source-held", {
    sourceFormat: plan.sourceFormat,
    sourceWidth: plan.sourceWidth,
    sourceHeight: plan.sourceHeight,
    sourceBytes: payload.request.bytes.byteLength,
    targetWidth: plan.targetWidth,
    targetHeight: plan.targetHeight,
  });

  const target: { pixels: Uint8Array | Uint8ClampedArray; alpha: boolean } =
    variant === "pure-ts"
      ? await pureTsPixels(payload, plan)
      : variant === "webcodecs"
        ? await webCodecsPixels(payload, plan)
        : variant === "image-bitmap"
          ? await imageBitmapPixels(payload, plan)
          : await picaPixels(payload, plan);
  await phase(payload, "target-held", {
    sourceFormat: plan.sourceFormat,
    targetWidth: plan.targetWidth,
    targetHeight: plan.targetHeight,
    targetBytes: target.pixels.byteLength,
  });
  const result = encodeRasterTargetV1({
    plan,
    pixels: target.pixels,
    hasAlpha: target.alpha,
  });
  target.pixels = new Uint8Array(0);
  await phase(payload, "encoded-held", {
    sourceFormat: plan.sourceFormat,
    outputWidth: result.width,
    outputHeight: result.height,
    outputBytes: result.bytes.byteLength,
  });
  const transfer = [result.bytes.buffer as ArrayBuffer];
  post(
    {
      kind: "result",
      id: payload.id,
      result,
      elapsedMs: performance.now() - startedAt,
      detail: {
        normalized: true,
        sourceWidth: plan.sourceWidth,
        sourceHeight: plan.sourceHeight,
        targetWidth: plan.targetWidth,
        targetHeight: plan.targetHeight,
      },
    },
    transfer,
  );
}

async function initialize(value: RasterNormalizerVariant): Promise<void> {
  variant = value;
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const hasImageBitmap = typeof createImageBitmap === "function";
  const hasWebCodecs = imageDecoderConstructor() !== undefined;
  if (value === "webcodecs" && (!hasWebCodecs || !hasOffscreenCanvas)) {
    throw new Error("WebCodecs ImageDecoder/OffscreenCanvas is unavailable.");
  }
  if ((value === "image-bitmap" || value === "pica") && (!hasImageBitmap || !hasOffscreenCanvas)) {
    throw new Error("createImageBitmap/OffscreenCanvas is unavailable.");
  }
  if (value === "pica") {
    // No nested Blob worker: the benchmark worker itself is disposable. Pica
    // gets its JS+WASM math paths and a single lane, which is MV3-CSP safe.
    picaRuntime = pica({ features: ["js", "wasm"], concurrency: 1 });
    await picaRuntime.init();
    // Pica 10's capability probe recognizes OffscreenCanvas in its own
    // nested worker, but not when Pica itself already runs in a worker with
    // `ww` disabled. The API exposes canvas creation as a host seam; bind it
    // to the platform primitive we just proved above.
    picaRuntime.createCanvas = (width: number, height: number) =>
      new OffscreenCanvas(width, height);
  }
  post({
    kind: "ready",
    variant: value,
    detail: {
      hasOffscreenCanvas,
      hasImageBitmap,
      hasWebCodecs,
      picaWasmRequested: value === "pica",
      picaOffscreenCanvasHostShim: value === "pica",
    },
  });
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.kind === "continue") {
    resumeProbe?.();
    return;
  }
  if (request.kind === "shutdown") {
    scope.close();
    return;
  }
  if (request.kind === "init") {
    void initialize(request.variant).catch((error) => {
      post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  void normalize(request).catch((error) => {
    post({
      kind: "error",
      id: request.id,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });
});
