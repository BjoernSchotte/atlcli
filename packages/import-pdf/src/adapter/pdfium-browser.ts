import type { PdfiumAdapterConfig } from "./contracts.js";
import { createPdfiumFactsAdapter } from "./pdfium.js";

/**
 * Browser-worker entry. The host must obtain WASM from a static same-origin
 * asset and inject its bytes; this function never fetches or constructs a URL.
 */
export function createBrowserPdfiumFactsAdapter(config: PdfiumAdapterConfig) {
  return createPdfiumFactsAdapter(config);
}
