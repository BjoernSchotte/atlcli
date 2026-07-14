/**
 * Service worker (imperative shell — spec 002 Task 3/4/5).
 *
 * Owns three responsibilities and nothing else; all decision logic lives in the
 * pure `routeMessage` core and the injectable `ensureOffscreen` helper:
 *   1. open the side panel on the toolbar action click,
 *   2. route panel requests (`ping`, `wasm-smoke`) via the pure router,
 *   3. manage the offscreen document lifecycle for the WASM round-trip.
 */
import { defineBackground } from "wxt/utils/define-background";
// Import from @atlcli/core's BROWSER entry. Presence in the bundle proves Vite
// resolves the `browser` export condition (PLAN §6 risk 4); the Task 6 output
// scan then proves this pulls in zero node:/bun: specifiers.
import { extractEntityFromUrl } from "@atlcli/core";
import {
  isExtRequest,
  type ExtResponse,
  type OffscreenResponse,
} from "../utils/messages.js";
import { routeMessage } from "../utils/router.js";
import { closeOffscreen, ensureOffscreen } from "../utils/offscreen.js";
import { createIdleTimer } from "../utils/idle-timer.js";

/**
 * Idle-close policy (PLAN §2.3): after 5 minutes with no offscreen request,
 * close the offscreen document; the next request re-creates it via
 * `ensureOffscreen`. Best-effort — the SW may be torn down first, and the
 * offscreen document dies with the extension process anyway.
 */
const OFFSCREEN_IDLE_MS = 5 * 60 * 1000;
const offscreenIdle = createIdleTimer({
  delayMs: OFFSCREEN_IDLE_MS,
  onIdle: () => {
    void closeOffscreen().catch((err) =>
      console.error("closeOffscreen (idle) failed", err)
    );
  },
});

/**
 * Effect wired into the pure router: ensure the offscreen document exists,
 * then round-trip the WASM computation through it. Rejects on failure so the
 * router turns it into an error response. Each call (re)arms the idle-close
 * timer so the document is closed once traffic stops.
 */
async function runWasmSmoke(a: number, b: number): Promise<number> {
  offscreenIdle.reset();
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({
    kind: "offscreen:wasm-add",
    a,
    b,
  })) as OffscreenResponse | undefined;

  if (!res || res.kind !== "offscreen:wasm-add-result") {
    throw new Error("offscreen document returned no result");
  }
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export default defineBackground({
  // Emit `"background": { "type": "module", ... }` in the manifest (PLAN §2.3).
  type: "module",
  main() {
  // Retain the @atlcli/core import (spec 003 uses it for page detection);
  // logging keeps it from being tree-shaken away, proving browser resolution.
  console.debug("[atlcli] @atlcli/core browser entry loaded:", typeof extractEntityFromUrl);

  // Toolbar action opens the side panel (Task 4 AC).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed", err));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Ignore anything that isn't a panel-facing request (e.g. offscreen replies).
    if (!isExtRequest(message)) return false;

    routeMessage(message, { runWasmSmoke })
      .then((response: ExtResponse) => sendResponse(response))
      .catch((err) =>
        sendResponse({
          kind: "wasm-smoke-result",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies ExtResponse)
      );

    // Keep the message channel open for the async response.
    return true;
  });
  },
});
