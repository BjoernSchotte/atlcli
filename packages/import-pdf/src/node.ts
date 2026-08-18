import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPdfiumFactsAdapter } from "./adapter/pdfium.js";
import type { PdfiumFactsAdapter } from "./adapter/contracts.js";

export async function loadPackagedPdfiumWasm(): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve("@atlcli/import-pdf/wasm"));
  return new Uint8Array(await readFile(path));
}

export async function createNodePdfiumFactsAdapter(): Promise<PdfiumFactsAdapter> {
  return createPdfiumFactsAdapter({ wasmBinary: await loadPackagedPdfiumWasm() });
}

export * from "./index.js";
