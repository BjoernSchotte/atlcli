import type { PdfFactsAdapter, PdfFactsAdapterV2 } from "../contracts.js";

export interface PdfiumAdapterConfig {
  /** Caller-owned local bytes are copied at construction and digest-verified. */
  wasmBinary: Uint8Array;
}

export type PdfiumFailureStage =
  | "after-init"
  | "after-input"
  | "after-load"
  | "after-page-load"
  | "after-text-page"
  | "after-structure-tree"
  | "after-annotation"
  | "after-page-objects"
  | "after-bitmap"
  | "after-render"
  | "before-finalize";

/** Test-only fault seam; never exported from the package barrel. */
export interface PdfiumAdapterTestConfig extends PdfiumAdapterConfig {
  failAt?: PdfiumFailureStage;
}

export type PdfiumFactsAdapter = PdfFactsAdapter;
export type PdfiumFactsAdapterV2 = PdfFactsAdapterV2;
