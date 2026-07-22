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
import { ChromeWorkerCompilerHost } from "../../utils/pdf/compiler-host.js";

const pdfHost = new ChromeWorkerCompilerHost({
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
    // The T5.3 scheduling hints ride the message (scalars only) because the
    // panel decides the job kind while the offscreen queue enforces it — see
    // `utils/pdf/compiler-host.ts`, "The job-kind scheduling contract".
    runPdfCompile: async (jobId, hints) => {
      const result = await pdfHost.compile(jobId, { kind: hints?.job, pages: hints?.pages });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    runPdfCancel: (jobId) => pdfHost.cancel(jobId),
  })
);
