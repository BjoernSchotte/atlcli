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
} from "./messages.js";
import { routeMessage, type RouterDeps } from "./router.js";
import { runWasmAdd } from "./wasm-smoke.js";

/** Effects the offscreen listener depends on (injectable for tests). */
export interface OffscreenListenerDeps {
  runWasmAdd: (a: number, b: number, bytes?: Uint8Array) => Promise<number>;
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
    .catch((err) =>
      sendResponse({ kind: "wasm-smoke-result", ok: false, error: toMessage(err) })
    );

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
  deps: OffscreenListenerDeps = { runWasmAdd }
): boolean {
  if (!isOffscreenRequest(message)) return false;

  deps
    .runWasmAdd(message.a, message.b)
    .then((result) =>
      sendResponse({ kind: "offscreen:wasm-add-result", ok: true, result })
    )
    .catch((err) =>
      sendResponse({ kind: "offscreen:wasm-add-result", ok: false, error: toMessage(err) })
    );

  return true;
}
