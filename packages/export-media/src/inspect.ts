/**
 * Header-only image inspection and target sizing (issue #118 Phase 1).
 *
 * EXTRACTED verbatim from `packages/docx/src/image.ts` (spec 005/006) so the
 * PDF and DOCX engines share one implementation of format sniffing, intrinsic
 * dimensions, target sizing, and the decompression-bomb budgets.
 * `@atlcli/docx` re-exports these for its existing consumers.
 *
 * Isomorphic by construction: dimensions come from an in-house header decoder
 * over a `DataView` (no node `Buffer`/`image-size`), bytes are `Uint8Array`.
 */
import { decodeSvgSource } from "@atlcli/confluence";

export type ImageFormat = "png" | "jpeg" | "gif" | "svg";

export interface ImageInfo {
  format: ImageFormat;
  /** Media-part filename extension. */
  ext: string;
  /** MIME type consumers file the bytes under. */
  mime: string;
  /** Intrinsic pixel dimensions from the header. */
  width: number;
  height: number;
}

/**
 * Decode format + intrinsic dimensions from the image header. Returns `null`
 * for anything that is not a well-formed PNG/JPEG/GIF.
 */
export function decodeImageInfo(bytes: Uint8Array): ImageInfo | null {
  return decodePng(bytes) ?? decodeJpeg(bytes) ?? decodeGif(bytes);
}

/** PNG: 8-byte signature, IHDR width/height at offsets 16/20 (big-endian). */
function decodePng(bytes: Uint8Array): ImageInfo | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || SIG.some((b, i) => bytes[i] !== b)) return null;
  // Bytes 12–15 must name the IHDR chunk (always first in a valid PNG).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { format: "png", ext: "png", mime: "image/png", width, height };
}

/** GIF: `GIF87a`/`GIF89a`, logical-screen width/height at 6/8 (little-endian). */
function decodeGif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10) return null;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (!width || !height) return null;
  return { format: "gif", ext: "gif", mime: "image/gif", width, height };
}

/**
 * JPEG: walk the marker segments from SOI until a start-of-frame (SOF0–SOF15,
 * excluding the non-frame C4/C8/CC markers) yields height/width, or the scan
 * data (SOS) begins.
 */
function decodeJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // desynced — not a marker
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers without a length (RSTn, SOI, EOI, TEM).
    if ((marker! >= 0xd0 && marker! <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    const isSof = marker! >= 0xc0 && marker! <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > bytes.length) return null;
      const height = view.getUint16(i + 5);
      const width = view.getUint16(i + 7);
      if (!width || !height) return null;
      return { format: "jpeg", ext: "jpeg", mime: "image/jpeg", width, height };
    }
    if (marker === 0xda) return null; // scan data reached without a SOF
    i += 2 + length;
  }
  return null;
}

/**
 * True when the bytes look like an SVG document (optionally behind a BOM /
 * XML declaration / comments). Only the first 512 bytes are inspected, decoded
 * with BOM/encoding awareness (spec 006 G4 + spec 011): a UTF-16LE/BE SVG must
 * be RECOGNIZED so its content is scanned rather than silently mistaken for
 * unrecognized bytes — otherwise a UTF-16-encoded `<script>` SVG would never
 * reach the safety check.
 */
export function isSvg(bytes: Uint8Array): boolean {
  const head = decodeSvgSource(bytes.subarray(0, 512))
    .replace(/^﻿/, "")
    .trimStart();
  if (!head.startsWith("<")) return false;
  return /<svg[\s>]/i.test(head);
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

export interface TargetSize {
  widthPx: number;
  heightPx: number;
}

/**
 * Resolve the rendered size: author-specified px override the intrinsic size
 * (one missing axis scales by the intrinsic aspect ratio), then the result is
 * capped to `maxWidthPx` preserving aspect (spec 005: width-capping).
 */
export function resolveTargetSize(
  intrinsic: { width: number; height: number },
  wanted: { widthPx?: number; heightPx?: number },
  maxWidthPx: number
): TargetSize {
  let w = intrinsic.width;
  let h = intrinsic.height;
  if (wanted.widthPx && wanted.heightPx) {
    w = wanted.widthPx;
    h = wanted.heightPx;
  } else if (wanted.widthPx) {
    h = Math.round((intrinsic.height * wanted.widthPx) / intrinsic.width);
    w = wanted.widthPx;
  } else if (wanted.heightPx) {
    w = Math.round((intrinsic.width * wanted.heightPx) / intrinsic.height);
    h = wanted.heightPx;
  }
  if (w > maxWidthPx) {
    h = Math.round((h * maxWidthPx) / w);
    w = maxWidthPx;
  }
  return { widthPx: Math.max(1, w), heightPx: Math.max(1, h) };
}

/**
 * Parse an SVG's intrinsic pixel size from its opening `<svg>` tag (spec 006
 * G4). Prefers explicit `width`/`height` (px or unitless — `%`/`em`/other
 * units are treated as undeterminable), falling back to the `viewBox`'s width
 * and height. Returns `null` when neither yields a usable positive size, so the
 * caller can apply a default. Pure over the decoded SVG string.
 */
export function parseSvgSize(source: string): TargetSize | null {
  const open = source.replace(/^﻿/, "").match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const tag = open[0];
  const num = (attr: string): number | null => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
    if (!m) return null;
    const raw = (m[1] ?? m[2] ?? "").trim();
    // Accept a bare number or an explicit px length; reject %, em, and friends.
    const px = raw.match(/^([0-9]+(?:\.[0-9]+)?)(px)?$/i);
    if (!px) return null;
    const v = Number.parseFloat(px[1]!);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = num("width");
  const h = num("height");
  if (w !== null && h !== null) return { widthPx: Math.round(w), heightPx: Math.round(h) };
  const vb = tag.match(/\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (vb) {
    const parts = (vb[1] ?? vb[2] ?? "").trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const vw = parts[2]!;
      const vh = parts[3]!;
      if (vw > 0 && vh > 0) return { widthPx: Math.round(vw), heightPx: Math.round(vh) };
    }
  }
  return null;
}

/**
 * Symmetric per-axis raster cap (spec 006 G4). `resolveTargetSize` caps only
 * `widthPx`; an SVG's own `viewBox`/`width`/`height` and Confluence's
 * `ac:width`/`ac:height` are unbounded author input, so an extreme aspect
 * ratio can leave `heightPx` (or the total pixel count) enormous even after
 * width-capping. Chosen well above any plausible authored figure so normal
 * content (including tall flowcharts) is never rejected — the guard exists to
 * catch malformed/pathological dimensions before they reach a decoder or
 * rasterizer allocation, not to constrain real usage.
 */
export const MAX_RASTER_AXIS_PX = 10000;
/** Total-pixel raster budget (spec 006 G4): ~40 megapixels. */
export const MAX_RASTER_PIXELS = 40_000_000;

/**
 * Budget guard for a decoder/rasterizer target (spec 006 G4): reject
 * non-finite / non-safe-integer / non-positive axes, either axis above
 * {@link MAX_RASTER_AXIS_PX}, or a total pixel count above
 * {@link MAX_RASTER_PIXELS}. Returns the same size when within budget, or
 * `null` when it is exceeded (the caller degrades with a note instead of
 * decoding).
 */
export function boundRasterTarget(size: TargetSize): TargetSize | null {
  const { widthPx, heightPx } = size;
  for (const axis of [widthPx, heightPx]) {
    if (!Number.isFinite(axis) || !Number.isSafeInteger(axis) || axis < 1) return null;
    if (axis > MAX_RASTER_AXIS_PX) return null;
  }
  if (widthPx * heightPx > MAX_RASTER_PIXELS) return null;
  return size;
}
