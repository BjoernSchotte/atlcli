/**
 * Explicit image-quality profiles (issue #118 Phase 1, PLAN.md "Image
 * profiles and normalization").
 *
 * Profiles are PRESETS over one numeric core parameter: the normalizer
 * always computes `ceil(rendered inches × effective PPI), capped at source
 * pixels`. `standard`/`print` name pinned PPI choices; `imagePpi` is the
 * advanced override on the same code path. `original` never re-encodes and
 * never combines with an override — nothing silently reduces quality.
 */
export type ExportImageProfile = "original" | "standard" | "print";

export interface ExportImageQualityV1 {
  imageProfile: ExportImageProfile;
  /** Advanced override in [{@link EXPORT_IMAGE_PPI_MIN}, {@link EXPORT_IMAGE_PPI_MAX}]. */
  imagePpi?: number;
}

export const EXPORT_IMAGE_PPI_MIN = 72;
export const EXPORT_IMAGE_PPI_MAX = 1200;

/**
 * Phase 1 candidate pins (PLAN.md: `standard` benchmarked in 160–200 PPI,
 * `print` around 300). Confirmed or revised with the measured corpus results;
 * a changed pin bumps {@link IMAGE_NORMALIZER_VERSION}.
 */
export const STANDARD_PROFILE_PPI = 180;
export const PRINT_PROFILE_PPI = 300;

/** Re-encode quality for photographic JPEG derivatives. */
export const NORMALIZED_JPEG_QUALITY = 85;

/**
 * Versioned normalizer identity: one content hash maps to one normalized
 * result per version. Any change to pins, codec, or resampling bumps this.
 */
export const IMAGE_NORMALIZER_VERSION = 1;

export class ExportImageQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportImageQualityError";
  }
}

/**
 * Validate a quality request and resolve its effective PPI.
 * Returns `null` for `original` (no re-encode path at all).
 */
export function resolveEffectivePpi(quality: ExportImageQualityV1): number | null {
  if (quality.imagePpi !== undefined) {
    if (quality.imageProfile === "original") {
      throw new ExportImageQualityError(
        "imagePpi cannot combine with the 'original' profile: original never re-encodes.",
      );
    }
    if (
      !Number.isSafeInteger(quality.imagePpi) ||
      quality.imagePpi < EXPORT_IMAGE_PPI_MIN ||
      quality.imagePpi > EXPORT_IMAGE_PPI_MAX
    ) {
      throw new ExportImageQualityError(
        `imagePpi must be an integer in [${EXPORT_IMAGE_PPI_MIN}, ${EXPORT_IMAGE_PPI_MAX}].`,
      );
    }
    return quality.imagePpi;
  }
  switch (quality.imageProfile) {
    case "original":
      return null;
    case "standard":
      return STANDARD_PROFILE_PPI;
    case "print":
      return PRINT_PROFILE_PPI;
  }
}
