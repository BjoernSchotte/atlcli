/**
 * Deterministic raster normalization (issue #118 Phase 1).
 *
 * The one pipeline behind every non-`original` profile: inspect the header,
 * plan the target from the render envelope and effective PPI, decode with the
 * pinned decoders, box-downsample, and re-encode with the pinned encoders.
 * JPEG stays JPEG; PNG stays PNG (transparency stays lossless); SVG and
 * anything undecodable is KEPT untouched with a stated reason — a profile
 * must never corrupt what it cannot faithfully process, and never upscale.
 */
import { decodeJpegRaster } from "./decode-jpeg.js";
import { decodePngRaster } from "./decode-png.js";
import { encodeJpeg } from "./encode-jpeg.js";
import { encodePng } from "./encode-png.js";
import { boundRasterTarget, decodeImageInfo } from "./inspect.js";
import { NORMALIZED_JPEG_QUALITY } from "./profile.js";
import { boxResampleRgba, rgbaToRgb } from "./resample.js";

/** CSS reference pixel density used for authored `width`/`height` values. */
const CSS_PX_PER_INCH = 96;

/**
 * Skip re-encoding when the target keeps ≥ this share of source width: a
 * 2400→2380 "downscale" would re-encode for no memory win.
 */
const MIN_DOWNSCALE_RATIO = 0.98;

export interface RasterNormalizeRequestV1 {
  bytes: Uint8Array;
  mediaType: string;
  /**
   * Conservative maximum rendered width in points (1/72 in) across every use
   * of the asset — the usable-page-width upper bound when layout-dependent.
   */
  renderEnvelopeWidthPt: number;
  /** Effective target density from the profile/override (never null here). */
  ppi: number;
  /** Author-specified CSS-px dimensions, when the source block carries them. */
  authored?: { widthPx?: number; heightPx?: number };
}

export type RasterKeptReason =
  | "not-raster"
  | "undecodable"
  | "no-downscale"
  | "decode-budget-exceeded"
  | "unsupported-raster-shape";

export type RasterNormalizeResultV1 =
  | {
      kind: "normalized";
      bytes: Uint8Array;
      mediaType: "image/png" | "image/jpeg";
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | { kind: "kept"; reason: RasterKeptReason };

/**
 * Optional host boundary for raster decode/resize implementations.
 *
 * The default implementation stays synchronous and deterministic. Browser
 * hosts may inject an async disposable-worker adapter (for example
 * WebCodecs, ImageBitmap, or Pica) while keeping the target and pinned output
 * contracts in this package.
 */
export interface RasterNormalizerPortV1 {
  normalize(
    request: RasterNormalizeRequestV1,
  ): RasterNormalizeResultV1 | Promise<RasterNormalizeResultV1>;
}

/**
 * Pure target plan shared by the deterministic normalizer and browser-hosted
 * decoder experiments. Host adapters may change how pixels are decoded and
 * resized, but they must all consume this exact geometry contract.
 */
export interface RasterNormalizationPlanV1 {
  sourceFormat: "png" | "jpeg";
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}

export type RasterNormalizationPlanResultV1 =
  | { kind: "normalize"; plan: RasterNormalizationPlanV1 }
  | { kind: "kept"; reason: RasterKeptReason };

/** Header-only, allocation-bounded planning; never decodes source pixels. */
export function planRasterNormalizationV1(
  request: RasterNormalizeRequestV1,
): RasterNormalizationPlanResultV1 {
  const info = decodeImageInfo(request.bytes);
  // GIF may be animated and both PNG-decoder paths would lie about it; SVG
  // and unknown formats are vector/unsupported — all kept untouched.
  if (!info || info.format === "gif" || info.format === "svg") {
    return { kind: "kept", reason: "not-raster" };
  }

  // Rendered width in inches: the smaller of the authored CSS width and the
  // envelope cap (authored heights follow via aspect at the resample stage).
  const envelopeInches = request.renderEnvelopeWidthPt / 72;
  const authoredInches =
    request.authored?.widthPx !== undefined && request.authored.widthPx > 0
      ? request.authored.widthPx / CSS_PX_PER_INCH
      : undefined;
  const renderedInches =
    authoredInches === undefined ? envelopeInches : Math.min(authoredInches, envelopeInches);

  // Never upscale: cap the target at the source raster.
  const targetWidth = Math.min(info.width, Math.ceil(renderedInches * request.ppi));
  if (targetWidth >= info.width * MIN_DOWNSCALE_RATIO) {
    return { kind: "kept", reason: "no-downscale" };
  }
  if (!boundRasterTarget({ widthPx: info.width, heightPx: info.height })) {
    return { kind: "kept", reason: "decode-budget-exceeded" };
  }

  return {
    kind: "normalize",
    plan: {
      sourceFormat: info.format,
      sourceWidth: info.width,
      sourceHeight: info.height,
      targetWidth,
      targetHeight: Math.max(1, Math.round((info.height * targetWidth) / info.width)),
    },
  };
}

export interface EncodeRasterTargetRequestV1 {
  plan: RasterNormalizationPlanV1;
  /** Exactly targetWidth × targetHeight × 4 RGBA bytes. */
  pixels: Uint8Array | Uint8ClampedArray;
  /** Whether any source/output pixel needs a non-opaque alpha channel. */
  hasAlpha: boolean;
}

/**
 * Pinned output stage shared by pure-TS and native browser decoder lanes.
 * Keeping encoding here prevents Chrome-version-specific Canvas encoders from
 * turning a decoder benchmark into an output-codec comparison.
 */
export function encodeRasterTargetV1(
  request: EncodeRasterTargetRequestV1,
): Extract<RasterNormalizeResultV1, { kind: "normalized" }> {
  const { plan } = request;
  const expectedBytes = plan.targetWidth * plan.targetHeight * 4;
  if (request.pixels.byteLength !== expectedBytes) {
    throw new RangeError(
      `Raster target contains ${request.pixels.byteLength} bytes; expected ${expectedBytes}.`,
    );
  }
  const pixels = new Uint8Array(
    request.pixels.buffer,
    request.pixels.byteOffset,
    request.pixels.byteLength,
  );

  if (plan.sourceFormat === "jpeg") {
    // The pinned JPEG encoder works in whole 8x8 blocks; pad the target up to
    // the next multiple of 8 via edge replication, never invented black.
    const paddedWidth = Math.ceil(plan.targetWidth / 8) * 8;
    const paddedHeight = Math.ceil(plan.targetHeight / 8) * 8;
    const padded =
      paddedWidth === plan.targetWidth && paddedHeight === plan.targetHeight
        ? pixels
        : padRgba(
            pixels,
            plan.targetWidth,
            plan.targetHeight,
            paddedWidth,
            paddedHeight,
          );
    return {
      kind: "normalized",
      bytes: encodeJpeg(rgbaToRgb(padded), paddedWidth, paddedHeight, NORMALIZED_JPEG_QUALITY),
      mediaType: "image/jpeg",
      width: paddedWidth,
      height: paddedHeight,
      sourceWidth: plan.sourceWidth,
      sourceHeight: plan.sourceHeight,
    };
  }

  return {
    kind: "normalized",
    bytes: encodePng(
      request.hasAlpha ? pixels : rgbaToRgb(pixels),
      plan.targetWidth,
      plan.targetHeight,
      request.hasAlpha,
    ),
    mediaType: "image/png",
    width: plan.targetWidth,
    height: plan.targetHeight,
    sourceWidth: plan.sourceWidth,
    sourceHeight: plan.sourceHeight,
  };
}

export function normalizeRasterAssetV1(
  request: RasterNormalizeRequestV1,
): RasterNormalizeResultV1 {
  const planned = planRasterNormalizationV1(request);
  if (planned.kind === "kept") return planned;
  const { plan } = planned;

  const decoded =
    plan.sourceFormat === "png" ? decodePngRaster(request.bytes)
    : plan.sourceFormat === "jpeg" ? decodeJpegRaster(request.bytes)
    : null;
  if (!decoded) return { kind: "kept", reason: "undecodable" };
  if (decoded.width !== plan.sourceWidth || decoded.height !== plan.sourceHeight) {
    return { kind: "kept", reason: "undecodable" };
  }

  const resampled = boxResampleRgba(
    decoded.pixels,
    decoded.width,
    decoded.height,
    plan.targetWidth,
    plan.targetHeight,
  );
  return encodeRasterTargetV1({ plan, pixels: resampled, hasAlpha: decoded.hasAlpha });
}

/** Edge-replicate pad (bottom/right) so JPEG's 8x8 blocks never invent black. */
function padRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  paddedWidth: number,
  paddedHeight: number,
): Uint8Array {
  const out = new Uint8Array(paddedWidth * paddedHeight * 4);
  for (let y = 0; y < paddedHeight; y += 1) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < paddedWidth; x += 1) {
      const sx = Math.min(x, width - 1);
      const src = (sy * width + sx) * 4;
      const dst = (y * paddedWidth + x) * 4;
      out[dst] = pixels[src]!;
      out[dst + 1] = pixels[src + 1]!;
      out[dst + 2] = pixels[src + 2]!;
      out[dst + 3] = pixels[src + 3]!;
    }
  }
  return out;
}
