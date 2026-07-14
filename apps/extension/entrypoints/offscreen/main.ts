/**
 * Offscreen document WASM host (spec 002 Task 5).
 *
 * Instantiates the minimal inline WASM module on demand and answers
 * `offscreen:wasm-add` messages from the service worker. Instantiation errors
 * are returned as an error response — never a hang.
 */
import {
  isOffscreenRequest,
  type OffscreenResponse,
} from "../../utils/messages.js";
import { runWasmAdd } from "../../utils/wasm-smoke.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenRequest(message)) return false;

  runWasmAdd(message.a, message.b)
    .then((result) =>
      sendResponse({
        kind: "offscreen:wasm-add-result",
        ok: true,
        result,
      } satisfies OffscreenResponse)
    )
    .catch((err) =>
      sendResponse({
        kind: "offscreen:wasm-add-result",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies OffscreenResponse)
    );

  // Keep the channel open for the async response.
  return true;
});
