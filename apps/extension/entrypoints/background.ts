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
import { createObserverSession } from "../utils/observer-session.js";
import {
  currentDetection,
  initialObserverState,
  isObserverState,
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
const TAB_OBSERVER_STORAGE_KEY = "tab-observer-state-v1";
const offscreenIdle = createIdleTimer({
  delayMs: OFFSCREEN_IDLE_MS,
  onIdle: () => {
    void closeOffscreen().catch((err) =>
      console.error("closeOffscreen (idle) failed", err)
    );
  },
});

let activePdfJobs = 0;

/**
 * Effect wired into the pure router: ensure the offscreen document exists,
 * then round-trip the WASM computation through it. Rejects on failure so the
 * router turns it into an error response. Each call (re)arms the idle-close
 * timer so the document is closed once traffic stops.
 */
async function runWasmSmoke(a: number, b: number): Promise<number> {
  if (activePdfJobs === 0) offscreenIdle.reset();
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

async function runPdfCompile(jobId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  activePdfJobs += 1;
  offscreenIdle.stop();
  try {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:pdf-compile",
      jobId,
    })) as OffscreenResponse | undefined;
    if (!response || response.kind !== "offscreen:pdf-compile-result" || response.jobId !== jobId) {
      return { ok: false, error: "Offscreen PDF compiler returned no correlated result." };
    }
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  } finally {
    activePdfJobs = Math.max(0, activePdfJobs - 1);
    if (activePdfJobs === 0) offscreenIdle.reset();
  }
}

async function runPdfCancel(jobId: string): Promise<boolean> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    kind: "offscreen:pdf-cancel",
    jobId,
  })) as OffscreenResponse | undefined;
  return Boolean(
    response &&
      response.kind === "offscreen:pdf-cancel-result" &&
      response.jobId === jobId &&
      response.cancelled
  );
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

  // ---- Tab observation (Task 1) --------------------------------------------
  // The SW is the canonical observer (PLAN §2.1), but MV3 workers are
  // disposable. Keep the ordering cursor in storage.session so a worker wakeup
  // cannot restart `seq` at 1 while a still-open panel retains a higher
  // `lastSeq`. The session also serializes pulls and pushes, including the tab
  // query itself, so a slow pull cannot be stamped newer than a tab-switch push.
  const observerSession = createObserverSession<ObserverState>(chrome.storage.session, {
    key: TAB_OBSERVER_STORAGE_KEY,
    initialState: initialObserverState,
    isState: isObserverState,
  });

  const feed = async (
    windowId: number,
    url: string | undefined | null
  ): Promise<void> => {
    const message = await observerSession.mutate((observer) => {
      const result = observeTab(observer, windowId, url);
      return { state: result.state, value: result.message };
    });
    if (message) pushEntityChanged(message);
  };

  /**
   * Resolve the active tab's entity for a `get-current-entity` request (panel
   * mount). Feeds the active tab's URL through the shared observer so the pull
   * response carries an ordering `seq` comparable to the pushes — a late pull
   * for tab A can then be dropped by the panel once a newer push for tab B has
   * been applied (Task 1 AC, no lost-update race).
   */
  const getCurrentEntity = (windowId: number): Promise<EntityDetection> =>
    observerSession.mutate(async (observer) => {
      let url: string | undefined;
      try {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        url = tabs[0]?.url;
      } catch {
        // The panel's window may have closed while its request was in flight.
        // Never fall back to a tab from another window.
        url = undefined;
      }
      const result = currentDetection(observer, windowId, url);
      return { state: result.state, value: result.detection };
    });

  // The `true` return from handleExtMessage keeps the channel open for the
  // async sendResponse — see utils/listeners.ts (covered by listeners.test.ts).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handleExtMessage(message, sendResponse, {
      runWasmSmoke,
      getCurrentEntity,
      runPdfCompile,
      runPdfCancel,
    })
  );

  // Tab switch: resolve the newly-active tab's URL, then observe it.
  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs
      .get(activeInfo.tabId)
      .then((tab) => {
        void feed(activeInfo.windowId, tab?.url).catch((err) =>
          console.error("tab observer persistence failed", err)
        );
      })
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
    void feed(tab.windowId, changeInfo.url).catch((err) =>
      console.error("tab observer persistence failed", err)
    );
  });
  },
});
