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
  type EntityChanged,
  type EntityDetection,
  type OffscreenResponse,
} from "../utils/messages.js";
import { handleExtMessage } from "../utils/listeners.js";
import { closeOffscreen, ensureOffscreen } from "../utils/offscreen.js";
import { createIdleTimer } from "../utils/idle-timer.js";
import {
  detectEntity,
  initialObserverState,
  observeTab,
  type ObserverState,
} from "../utils/tab-observer.js";

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

/**
 * Resolve the active tab's entity for a `get-current-entity` request (panel
 * mount). Queries the last-focused window's active tab so the panel gets an
 * answer without racing the SW's `entity-changed` push (Task 1 AC).
 */
async function getCurrentEntity(): Promise<EntityDetection> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url;
  return url ? detectEntity(url) : { url: null, entity: null };
}

/**
 * Push an `entity-changed` message to the panel (fire-and-forget). The panel may
 * be closed — `sendMessage` then rejects with "no receiving end"; swallow it.
 */
function pushEntityChanged(message: EntityChanged): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* panel not open — nothing to receive; ignore */
  });
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

  // The `true` return from handleExtMessage keeps the channel open for the
  // async sendResponse — see utils/listeners.ts (covered by listeners.test.ts).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handleExtMessage(message, sendResponse, { runWasmSmoke, getCurrentEntity })
  );

  // ---- Tab observation (Task 1) --------------------------------------------
  // The SW is the canonical observer (PLAN §2.1). The dedup memory lives here in
  // the imperative shell; all decision logic is the pure `observeTab` core.
  let observer: ObserverState = initialObserverState();
  const feed = (url: string | undefined | null): void => {
    const { state, message } = observeTab(observer, url);
    observer = state;
    if (message) pushEntityChanged(message);
  };

  // Tab switch: resolve the newly-active tab's URL, then observe it.
  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs
      .get(activeInfo.tabId)
      .then((tab) => feed(tab?.url))
      .catch(() => {
        /* tab gone before we could read it; ignore */
      });
  });

  // URL change (incl. Confluence SPA history navigation): only when the URL
  // actually changed AND it's the active tab — avoids reacting to background
  // tabs the panel isn't showing.
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    if (!tab.active) return;
    feed(changeInfo.url);
  });
  },
});
