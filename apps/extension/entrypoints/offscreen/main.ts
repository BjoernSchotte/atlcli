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
import type {
  ExportJobExecutor,
  ExportJobRequestV1,
  ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import { ChromeWorkerCompilerHost } from "../../utils/pdf/compiler-host.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createProductiveExtensionPdfExecutor,
  EXTENSION_PDF_MAX_OUTPUT_BYTES_V1,
  EXTENSION_PDF_SPOOL_LIMITS_V1,
} from "../../utils/export-jobs/pdf-executor.js";
import { createExtensionExportQueueRunner } from "../../utils/export-jobs/queue-runner.js";
import { BrowserRenderReservationPoolV1 } from "../../utils/export-jobs/render-reservation.js";
import { runClaimedExtensionExportJob } from "../../utils/export-jobs/runtime.js";

const pdfHost = new ChromeWorkerCompilerHost({
  createWorker: () =>
    new Worker(new URL("../../workers/pdf-compiler.ts", import.meta.url), {
      type: "module",
      name: "atlcli-pdf-compiler",
  }),
});

const exportCatalog = new IndexedDbExportJobCatalog();
const exportBytes = new IndexedDbExportByteStore({
  maxArtifactBytes: EXTENSION_PDF_MAX_OUTPUT_BYTES_V1,
  maxJobBytes: EXTENSION_PDF_SPOOL_LIMITS_V1.maxJobBytes,
  maxTotalBytes: EXTENSION_PDF_SPOOL_LIMITS_V1.maxTotalBytes,
});
// PR-H binds DOCX to this exact pool as well. The global heavy slot therefore
// already lives at the host boundary rather than inside either format engine.
const renderPool = new BrowserRenderReservationPoolV1();
const pdfExecutor = createProductiveExtensionPdfExecutor({
  catalog: exportCatalog,
  bytes: exportBytes,
  compilerHost: pdfHost,
  renderPool,
});
let docxExecutorPromise:
  | Promise<ExportJobExecutor<ExportJobRequestV1>>
  | undefined;

function docxExecutor(): Promise<ExportJobExecutor<ExportJobRequestV1>> {
  return docxExecutorPromise ??= import(
    "../../utils/export-jobs/docx-executor.js"
  ).then(({ createProductiveExtensionDocxExecutor }) =>
    createProductiveExtensionDocxExecutor({
      bytes: exportBytes,
      renderPool,
    })
  );
}

async function executeClaimedExport(claimed: ExportJobSnapshotV1) {
  const executor = claimed.format === "docx"
    ? await docxExecutor()
    : pdfExecutor;
  return runClaimedExtensionExportJob({
    claimed,
    catalog: exportCatalog,
    bytes: exportBytes,
    executor,
    // Both productive browser engines intentionally share this envelope.
    spoolLimits: EXTENSION_PDF_SPOOL_LIMITS_V1,
  });
}

const exportQueue = createExtensionExportQueueRunner({
  catalog: exportCatalog,
  bytes: exportBytes,
  execute: executeClaimedExport,
  onExecutionError: (error, jobId) =>
    console.error(`Common export job ${jobId} failed outside its executor`, error),
});
void exportQueue.startup()
  .then(() => exportQueue.wake())
  .catch((error) => console.error("Common export queue recovery failed", error));

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
    runJobsWake: (jobIds, options) => exportQueue.wake(jobIds, options),
  })
);
