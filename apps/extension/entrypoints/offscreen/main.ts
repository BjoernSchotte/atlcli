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
import { ResearchAgentWorkerHost } from "../../utils/research/worker-host.js";
import {
  normalizeAnthropicApiKey,
} from "../../utils/research/credential.js";
import {
  IndexedDbResearchSessionStoreV1,
  recoverExpiredResearchSessionsAtSafeBoundaryV1,
} from "@atlcli/research/browser";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../../utils/local-model/manifest.js";
import { withLocalRunHeartbeatV1 } from "../../utils/research/run-heartbeat.js";
import {
  BROWSER_CHAT_CALLER_PATH_BACKGROUND_V1,
  BROWSER_CHAT_CALLER_PATH_OFFSCREEN_V1,
  isBrowserChatCallerPathV1,
  type BrowserChatCallerPathBackgroundV1,
} from "../../utils/local-model/caller-path.js";

const BROWSER_RESEARCH_RECOVERY_LEASE_MS_V1 = 60_000;

/**
 * MV3 can discard this document without an orderly worker shutdown. On every
 * recreation, fence and release only pre-proven durable boundaries; never
 * infer the outcome of a provider call that was in flight when the document
 * disappeared. A later user-triggered resume owns actual continuation work.
 */
async function recoverResearchSessionsAfterOffscreenStart(): Promise<void> {
  const store = await IndexedDbResearchSessionStoreV1.open();
  try {
    await recoverExpiredResearchSessionsAtSafeBoundaryV1({
      store,
      ownerId: "owner:browser-recovery",
      leaseDurationMs: BROWSER_RESEARCH_RECOVERY_LEASE_MS_V1,
      at: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

void recoverResearchSessionsAfterOffscreenStart().catch((error) =>
  console.error("Durable research recovery after offscreen startup failed", error),
);

let localModelRuntimeModulePromise: Promise<
  typeof import("../../workers/local-model.js")
> | undefined;

function localModelRuntimeModuleV1() {
  return localModelRuntimeModulePromise ??= import(
    "../../workers/local-model.js"
  );
}

async function connectInstalledLocalModelV1() {
  // Offscreen documents expose only chrome.runtime, not chrome.storage. The
  // background host validates the exact installed activation immediately
  // before it sends a local-gemma run. Load ORT lazily, but execute it in this
  // offscreen Window rather than a nested DedicatedWorker. ORT's WebGPU JSEP
  // bridge has a distinct WorkerGlobalScope path that aborts the Gemma 4 E4B
  // decoder in Chrome MV3 after embedding succeeds.
  const { connectLocalModelPortV1 } = await localModelRuntimeModuleV1();
  const channel = new MessageChannel();
  connectLocalModelPortV1(channel.port2);
  return {
    kind: "local-gemma" as const,
    modelId: LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
    port: channel.port1,
  };
}

const pdfHost = new ChromeWorkerCompilerHost({
  createWorker: () =>
    new Worker(new URL("../../workers/pdf-compiler.ts", import.meta.url), {
      type: "module",
      name: "atlcli-pdf-compiler",
  }),
});

const researchHost = new ResearchAgentWorkerHost({
  createWorker: () =>
    new Worker(new URL("../../workers/research-agent.ts", import.meta.url), {
      type: "module",
      name: "atlcli-research-agent",
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
  onSettled: async (jobId) => {
    await chrome.runtime.sendMessage({
      kind: "jobs:changed",
      jobId,
    }).catch(() => undefined);
  },
});
void exportQueue.startup()
  .then(() => exportQueue.wake(undefined, { scheduleRecovery: true }))
  .catch((error) => console.error("Common export queue recovery failed", error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleOffscreenMessage(message, sendResponse, {
    runWasmAdd: async (a, b) => {
      const { runWasmAdd } = await import("../../utils/wasm-smoke.js");
      return runWasmAdd(a, b);
    },
    prewarmLocalModel: async () => {
      const { prewarmLocalModelRuntimeV1 } = await localModelRuntimeModuleV1();
      const receipt = await prewarmLocalModelRuntimeV1();
      console.info("[local-gemma/offscreen] prewarm completed", receipt);
      return receipt;
    },
    // The T5.3 scheduling hints ride the message (scalars only) because the
    // panel decides the job kind while the offscreen queue enforces it — see
    // `utils/pdf/compiler-host.ts`, "The job-kind scheduling contract".
    runPdfCompile: async (jobId, hints) => {
      const result = await pdfHost.compile(jobId, { kind: hints?.job, pages: hints?.pages });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    runPdfCancel: (jobId) => pdfHost.cancel(jobId),
    prepareDocxRuntime: async (codeTheme) => {
      const { prepareDocxExportRuntime } = await import(
        "@atlcli/docx/browser-entry"
      );
      return prepareDocxExportRuntime([], {
        ...(codeTheme ? { codeTheme } : {}),
        // Opening the DOCX panel is explicit host intent. Keep its
        // opportunistic overlap policy explicit while default empty preflights
        // remain demand-free.
        preloadCodeFont: true,
      });
    },
    runJobsWake: (jobIds, options) => exportQueue.wake(jobIds, options),
    runResearch: async (
      runId,
      sessionId,
      turnId,
      key,
      mode,
      callerPath: BrowserChatCallerPathBackgroundV1 | undefined,
      request,
      policy,
      qualityPolicy,
      hostIdentity,
      resumeAnswer,
      resumeCheckpoint,
      modelProvider,
    ) => {
      if (modelProvider === "local-gemma" && !isBrowserChatCallerPathV1(
        callerPath,
        BROWSER_CHAT_CALLER_PATH_BACKGROUND_V1,
      )) {
        throw new Error("The browser Chat run did not cross the background boundary.");
      }
      const apiKey = modelProvider === "local-gemma"
        ? ""
        : normalizeAnthropicApiKey(key);
      const run = async () => researchHost.run({
        runId,
        sessionId,
        turnId,
        apiKey,
        ...(modelProvider === "local-gemma"
          ? { modelBinding: await connectInstalledLocalModelV1() }
          : {}),
        mode,
        ...(modelProvider === "local-gemma"
          ? { callerPath: BROWSER_CHAT_CALLER_PATH_OFFSCREEN_V1 }
          : {}),
        request,
        policy,
        ...(qualityPolicy ? { qualityPolicy } : {}),
        ...(hostIdentity ? { hostIdentity } : {}),
        ...(resumeAnswer ? { resumeAnswer } : {}),
        ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
        onProgress: (progress) => {
          void chrome.runtime.sendMessage({
            kind: "research:progress",
            runId,
            progress,
          }).catch(() => undefined);
        },
        onEvent: (event) => {
          void chrome.runtime.sendMessage({
            kind: "research:event",
            runId,
            event,
          }).catch(() => undefined);
        },
        onChatPresentation: (event) => {
          void chrome.runtime.sendMessage({
            kind: "research:chat-presentation",
            runId,
            event,
          }).catch(() => undefined);
        },
      });
      return modelProvider === "local-gemma"
        ? withLocalRunHeartbeatV1({
            runId,
            operation: run,
            sendHeartbeat: async (activeRunId) => {
              await chrome.runtime.sendMessage({
                kind: "research:heartbeat",
                runId: activeRunId,
              });
            },
          })
        : run();
    },
    resumeResearch: async (runId, sessionId, turnId, key) => {
      const apiKey = normalizeAnthropicApiKey(key);
      return researchHost.run({
        runId,
        sessionId,
        turnId,
        apiKey,
        resume: true,
        onProgress: (progress) => {
          void chrome.runtime.sendMessage({
            kind: "research:progress",
            runId,
            progress,
          }).catch(() => undefined);
        },
        onEvent: (event) => {
          void chrome.runtime.sendMessage({
            kind: "research:event",
            runId,
            event,
          }).catch(() => undefined);
        },
      });
    },
    pauseResearch: async (runId) => researchHost.pause(runId),
    cancelResearch: async (runId) => researchHost.cancel(runId),
    controlChat: async (runId, controlId, control) =>
      researchHost.control(runId, controlId, control),
  })
);
