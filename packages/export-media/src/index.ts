/**
 * `@atlcli/export-media` — format-neutral image inspection, sizing, and
 * deterministic normalization shared by the PDF and DOCX export engines
 * (issue #118 Phase 1).
 *
 * The package is an EXTRACTION, not a fork: header-only inspection, target
 * sizing, and the decompression-bomb budgets moved here from
 * `@atlcli/docx`'s image module so exactly one implementation exists;
 * `@atlcli/docx` re-exports them for its existing consumers. Everything is
 * isomorphic and dependency-light by construction (no canvas, no host zlib,
 * no `CompressionStream` — their outputs are not pinned across engines).
 */
export {
  decodeImageInfo,
  isSvg,
  parseSvgSize,
  resolveTargetSize,
  boundRasterTarget,
  MAX_RASTER_AXIS_PX,
  MAX_RASTER_PIXELS,
  type ImageFormat,
  type ImageInfo,
  type TargetSize,
} from "./inspect.js";
export { sha256Hex } from "./sha256.js";
export { encodePng } from "./encode-png.js";
export { encodeJpeg } from "./encode-jpeg.js";
export { decodePngRaster, type DecodedRaster } from "./decode-png.js";
export { decodeJpegRaster } from "./decode-jpeg.js";
export { boxResampleRgba } from "./resample.js";
export {
  resolveEffectivePpi,
  ExportImageQualityError,
  EXPORT_IMAGE_PPI_MIN,
  EXPORT_IMAGE_PPI_MAX,
  STANDARD_PROFILE_PPI,
  PRINT_PROFILE_PPI,
  NORMALIZED_JPEG_QUALITY,
  IMAGE_NORMALIZER_VERSION,
  type ExportImageProfile,
  type ExportImageQualityV1,
} from "./profile.js";
export {
  normalizeRasterAssetV1,
  type RasterKeptReason,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "./normalize.js";
