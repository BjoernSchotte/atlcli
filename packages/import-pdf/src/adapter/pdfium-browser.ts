import type { PdfiumAdapterConfig } from "./contracts.js";
import { createPdfiumFactsAdapter, createPdfiumFactsAdapterV2 } from "./pdfium.js";

/**
 * Browser-worker entry. The host must obtain WASM from a static same-origin
 * asset and inject its bytes; this function never fetches or constructs a URL.
 */
export function createBrowserPdfiumFactsAdapter(config: PdfiumAdapterConfig) {
  return createPdfiumFactsAdapter(config);
}

/** Browser-worker V2 facts entry with the same caller-owned WASM boundary. */
export function createBrowserPdfiumFactsAdapterV2(config: PdfiumAdapterConfig) {
  return createPdfiumFactsAdapterV2(config);
}
