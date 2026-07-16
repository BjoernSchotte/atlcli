/**
 * Offscreen document WASM host (spec 002 Task 5).
 *
 * Instantiates the minimal inline WASM module on demand and answers
 * `offscreen:wasm-add` messages from the service worker. Instantiation errors
 * are returned as an error response — never a hang. The listener body lives in
 * the exported `handleOffscreenMessage` adapter (utils/listeners.ts) so the
 * load-bearing `true` return is unit-tested.
 */
import { handleOffscreenMessage } from "../../utils/listeners.js";
import { PdfCompilerHost } from "../../utils/pdf/compiler-host.js";

const pdfHost = new PdfCompilerHost({
  createWorker: () =>
    new Worker(new URL("../../workers/pdf-compiler.ts", import.meta.url), {
      type: "module",
      name: "atlcli-pdf-compiler",
    }),
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleOffscreenMessage(message, sendResponse, {
    runWasmAdd: async (a, b) => {
      const { runWasmAdd } = await import("../../utils/wasm-smoke.js");
      return runWasmAdd(a, b);
    },
    runPdfCompile: async (jobId) => {
      const result = await pdfHost.compile(jobId);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    runPdfCancel: (jobId) => pdfHost.cancel(jobId),
  })
);
