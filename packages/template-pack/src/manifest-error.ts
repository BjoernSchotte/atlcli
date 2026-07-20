/**
 * Shared manifest-validation error type (spec 007 T2.4, extracted in spec 012
 * so the design/bindings/localization validators can throw it without importing
 * the whole manifest module — avoiding an import cycle).
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

/** Typed rejection reasons carried by {@link ManifestValidationError}. */
export type ManifestErrorReason =
  | "unknown-schema-version"
  | "unknown-api"
  | "compiler-range-mismatch"
  | "shape-error";

/** Thrown by manifest validation on any rejection, with a typed reason. */
export class ManifestValidationError extends Error {
  constructor(
    readonly reason: ManifestErrorReason,
    message: string,
    /** Offending manifest field path, when applicable. */
    readonly path?: string
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}
