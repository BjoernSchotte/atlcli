/**
 * `chrome.runtime.onMessage` adapters (imperative-shell glue — spec 002).
 *
 * These wrap the pure router / WASM effects onto the listener contract. The
 * synchronous `true` return is LOAD-BEARING: MV3 keeps the message channel open
 * for an asynchronous `sendResponse` only when the listener returns `true`.
 * Returning `false` (or nothing) for a handled async request would drop the
 * reply. Extracting the bodies here makes that contract unit-testable — a
 * regression that removes the `true` now fails a test instead of silently
 * closing the channel.
 */
import {
  isExtRequest,
  isOffscreenRequest,
  type ExtResponse,
  type OffscreenResponse,
  type PdfCompileHints,
} from "./messages.js";
import { routeMessage, type RouterDeps } from "./router.js";
import { runWasmAdd } from "./wasm-smoke.js";

/** Effects the offscreen listener depends on (injectable for tests). */
export interface OffscreenListenerDeps {
  runWasmAdd: (a: number, b: number, bytes?: Uint8Array) => Promise<number>;
  runPdfCompile: (
    jobId: string,
    hints?: PdfCompileHints
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  runPdfCancel: (jobId: string) => Promise<boolean>;
  runJobsWake?: (
    jobIds?: string[],
    options?: { resumeWaiting?: boolean },
  ) => Promise<string | undefined>;
}

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Background service-worker adapter: route panel-facing requests and answer via
 * `sendResponse`. Returns `true` (keep the channel open) for a handled request,
 * `false` for anything else (e.g. offscreen replies) so the SW doesn't hold the
 * channel open for messages it won't answer.
 */
export function handleExtMessage(
  message: unknown,
  sendResponse: (response: ExtResponse) => void,
  deps: RouterDeps
): boolean {
  if (!isExtRequest(message)) return false;

  // routeMessage never throws (it captures the wasm failure path itself); the
  // catch is belt-and-suspenders so a listener bug still yields a response.
  routeMessage(message, deps)
    .then((response) => sendResponse(response))
    .catch((err) => {
      switch (message.kind) {
        case "pdf:compile":
          sendResponse({ kind: "pdf:compile-result", jobId: message.jobId, ok: false, error: toMessage(err) });
          break;
        case "pdf:cancel":
          sendResponse({ kind: "pdf:cancel-result", jobId: message.jobId, cancelled: false });
          break;
        case "jobs:wake":
          sendResponse({ kind: "jobs:wake-result", error: toMessage(err) });
          break;
        case "ping":
        case "wasm-smoke":
        case "get-current-entity":
          sendResponse({ kind: "wasm-smoke-result", ok: false, error: toMessage(err) });
          break;
      }
    });

  return true;
}

/**
 * Offscreen-document adapter: run the WASM computation for `offscreen:wasm-add`
 * requests and answer via `sendResponse`. Returns `true` for a handled request,
 * `false` otherwise.
 */
export function handleOffscreenMessage(
  message: unknown,
  sendResponse: (response: OffscreenResponse) => void,
  deps: OffscreenListenerDeps = {
    runWasmAdd,
    runPdfCompile: async () => ({ ok: false, error: "PDF compiler host is not configured." }),
    runPdfCancel: async () => false,
    runJobsWake: async () => undefined,
  }
): boolean {
  if (!isOffscreenRequest(message)) return false;

  switch (message.kind) {
    case "offscreen:wasm-add":
      deps.runWasmAdd(message.a, message.b)
        .then((result) => sendResponse({ kind: "offscreen:wasm-add-result", ok: true, result }))
        .catch((err) => sendResponse({ kind: "offscreen:wasm-add-result", ok: false, error: toMessage(err) }));
      break;
    case "offscreen:pdf-compile":
      deps.runPdfCompile(message.jobId, { job: message.job, pages: message.pages })
        .then((result) => sendResponse(result.ok
          ? { kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: true }
          : { kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: false, error: result.error }))
        .catch((err) => sendResponse({ kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: false, error: toMessage(err) }));
      break;
    case "offscreen:pdf-cancel":
      deps.runPdfCancel(message.jobId)
        .then((cancelled) => sendResponse({ kind: "offscreen:pdf-cancel-result", jobId: message.jobId, cancelled }))
        .catch(() => sendResponse({ kind: "offscreen:pdf-cancel-result", jobId: message.jobId, cancelled: false }));
      break;
    case "offscreen:jobs-wake":
      (deps.runJobsWake?.(message.jobIds, {
        resumeWaiting: message.resumeWaiting,
      }) ?? Promise.resolve(undefined))
        .then((claimedJobId) => sendResponse({
          kind: "offscreen:jobs-wake-result",
          ...(claimedJobId ? { claimedJobId } : {}),
        }))
        .catch((error) => sendResponse({
          kind: "offscreen:jobs-wake-result",
          error: toMessage(error),
        }));
      break;
  }

  return true;
}
