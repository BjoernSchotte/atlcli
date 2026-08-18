import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

const EXPECTED_WASM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8";

interface PdfiumMemory {
  HEAPU8: Uint8Array;
}

function memory(module: WrappedPdfiumModule): PdfiumMemory {
  return module.pdfium as unknown as PdfiumMemory;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function analyze(bytes: Uint8Array): Promise<object> {
  const response = await fetch(new URL("./pdfium.wasm", self.location.href), { credentials: "same-origin" });
  if (!response.ok) throw new Error(`WASM response ${response.status}`);
  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  const wasmSha256 = await sha256(wasmBinary);
  if (wasmSha256 !== EXPECTED_WASM_SHA256) throw new Error(`WASM digest mismatch: ${wasmSha256}`);
  const module = await init({ wasmBinary });
  module.PDFiumExt_Init();
  const pointer = module.pdfium.wasmExports.malloc(bytes.byteLength);
  if (!pointer) throw new Error("input allocation failed");
  memory(module).HEAPU8.set(bytes, pointer);
  const document = module.FPDF_LoadMemDocument64(pointer, bytes.byteLength, "");
  if (!document) {
    const error = module.FPDF_GetLastError();
    module.pdfium.wasmExports.free(pointer);
    module.FPDF_DestroyLibrary();
    throw new Error(`document load failed: ${error}`);
  }
  try {
    const pageCount = module.FPDF_GetPageCount(document);
    const page = module.FPDF_LoadPage(document, 0);
    if (!page) throw new Error("page load failed");
    try {
      const textPage = module.FPDFText_LoadPage(page);
      if (!textPage) throw new Error("text page load failed");
      try {
        const count = module.FPDFText_CountChars(textPage);
        let text = "";
        for (let index = 0; index < count; index += 1) {
          const unicode = module.FPDFText_GetUnicode(textPage, index);
          if (unicode > 0) text += String.fromCodePoint(unicode);
        }
        return {
          pageCount,
          tagged: module.FPDFCatalog_IsTagged(document),
          tokenFound: text.includes("Quarterly Garden Notes"),
          wasmSha256,
        };
      } finally {
        module.FPDFText_ClosePage(textPage);
      }
    } finally {
      module.FPDF_ClosePage(page);
    }
  } finally {
    module.FPDF_CloseDocument(document);
    module.pdfium.wasmExports.free(pointer);
    module.FPDF_DestroyLibrary();
  }
}

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ ok: true, result: await analyze(new Uint8Array(event.data)) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
