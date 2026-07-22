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
  type PdfCompileHints,
} from "../utils/messages.js";
import { handleExtMessage } from "../utils/listeners.js";
import { closeOffscreen, ensureOffscreen } from "../utils/offscreen.js";
import { createIdleTimer } from "../utils/idle-timer.js";
import { createOffscreenActivityTracker } from "../utils/pdf/offscreen-activity.js";
import { createDurableIdleGate } from "../utils/jobs/idle-gate.js";
import { jobBadgeText } from "../utils/jobs/model.js";
import {
  countInFlightPdfJobs,
  listPdfJobMeta,
  sweepPdfJobs,
} from "../utils/pdf/job-store.js";
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

/**
 * Idle-close policy for the offscreen document (spec 010 T5.3/T5.6).
 *
 * **Preview compiles are offscreen activity like any other**, which is what
 * lets the warm compiler survive a debounce pause: previews arrive as ordinary
 * `pdf:compile` requests, so they go through {@link runPdfCompile} and stop the
 * idle timer exactly the way an export does. The tracker also guarantees the
 * other half — once the last job finishes the timer is re-armed, so a panel
 * that goes quiet still closes the document and releases the ≥ 20 MB wasm
 * artifact.
 *
 * T5.6 closes Architecture point 3(b): the tracker's counter is in-memory and
 * resets to zero when the service worker restarts, so after a restart a *second*
 * job's completion would arm the timer under a first job that is still
 * compiling — and five minutes later close the document out from under it. The
 * counter still decides "did this worker's own traffic stop"; whether the timer
 * may actually be armed is decided by {@link createDurableIdleGate} from the
 * durable job records, which survived the restart. Both former call sites
 * (`runWasmSmoke`'s `touch()`, `runPdfCompile`'s `end()`) funnel through the
 * gate's `reset()`, so neither can arm the timer under a running compile.
 */
const durableIdle = createDurableIdleGate({
  timer: offscreenIdle,
  countInFlight: () => countInFlightPdfJobs(),
  onError: (error) => console.error("in-flight job lookup failed", error),
});
const offscreenActivity = createOffscreenActivityTracker(durableIdle);

/**
 * Toolbar badge: the only notification channel this folder may use.
 *
 * `chrome.notifications` would need a new manifest permission and this folder
 * ships none (`tests/manifest.test.ts`). The badge shows how many finished
 * exports are waiting to be collected, is set when a job finishes with **no side
 * panel open**, and is cleared the moment the panel talks to the worker again.
 * Optional-chained throughout: a host without an `action` key simply has no
 * badge, and losing a notification must never take a compile down with it.
 */
async function isPanelOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return contexts.length > 0;
  } catch {
    // Older Chrome, or a filter it does not know: assume open, which only ever
    // costs a badge that was not shown.
    return true;
  }
}

async function setJobBadge(): Promise<void> {
  try {
    const all = await listPdfJobMeta();
    const waiting = all.filter(
      (meta) =>
        (meta.kind ?? "export") === "export" &&
        meta.status === "complete" &&
        meta.outputBytes > 0 &&
        meta.consumed !== true
    ).length;
    await chrome.action?.setBadgeText?.({ text: jobBadgeText(waiting) });
  } catch (error) {
    console.debug("[atlcli] badge update skipped", error);
  }
}

function clearJobBadge(): void {
  void Promise.resolve(chrome.action?.setBadgeText?.({ text: "" })).catch(() => undefined);
}

/**
 * The watchdog + retention pass, run from the worker (which outlives the panel).
 *
 * Not `chrome.alarms` — that is a permission this folder does not have. Instead
 * it runs on worker start-up and, throttled, whenever the panel talks to the
 * worker: both are moments where being wrong about a stuck record is about to
 * become visible.
 */
const SWEEP_THROTTLE_MS = 60_000;
let lastSweep = 0;
function sweepJobs(force = false): void {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_THROTTLE_MS) return;
  lastSweep = now;
  void sweepPdfJobs().catch((error) => console.error("PDF job sweep failed", error));
}

/**
 * Effect wired into the pure router: ensure the offscreen document exists,
 * then round-trip the WASM computation through it. Rejects on failure so the
 * router turns it into an error response. Each call (re)arms the idle-close
 * timer so the document is closed once traffic stops.
 */
async function runWasmSmoke(a: number, b: number): Promise<number> {
  offscreenActivity.touch();
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

async function runPdfCompile(
  jobId: string,
  hints?: PdfCompileHints
): Promise<{ ok: true } | { ok: false; error: string }> {
  offscreenActivity.begin();
  try {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:pdf-compile",
      jobId,
      // Forwarded verbatim: the SW makes no scheduling decision of its own, it
      // just carries the panel's `job`/`pages` scalars to the offscreen queue.
      job: hints?.job,
      pages: hints?.pages,
    })) as OffscreenResponse | undefined;
    if (!response || response.kind !== "offscreen:pdf-compile-result" || response.jobId !== jobId) {
      return { ok: false, error: "Offscreen PDF compiler returned no correlated result." };
    }
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  } finally {
    offscreenActivity.end();
    // A job that finished while nobody was watching is the whole point of
    // durable jobs — say so on the toolbar rather than losing it silently.
    // Previews are excluded: they are never retained, so there is nothing to
    // collect, and a debounced preview loop would poll `getContexts` per
    // keystroke for an answer that is always "nothing to show".
    if (hints?.job !== "preview") {
      void isPanelOpen().then((open) => {
        if (!open) void setJobBadge();
      });
    }
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

async function runJobsWake(jobIds?: string[]): Promise<string | undefined> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    kind: "offscreen:jobs-wake",
    ...(jobIds ? { jobIds } : {}),
  })) as OffscreenResponse | undefined;
  if (!response || response.kind !== "offscreen:jobs-wake-result") {
    throw new Error("Offscreen export queue returned no result.");
  }
  if (response.error !== undefined) throw new Error(response.error);
  return response.claimedJobId;
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

  /**
   * This extension's own origin, so the observer can tell "the user navigated
   * away" from "we opened our own large-preview tab". Resolved once here rather
   * than inside the pure core, which must not know about `chrome`.
   */
  const ownOrigin = chrome.runtime.getURL("/");

  const feed = async (
    windowId: number,
    url: string | undefined | null
  ): Promise<void> => {
    const message = await observerSession.mutate((observer) => {
      const result = observeTab(observer, windowId, url, ownOrigin);
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
      const result = currentDetection(observer, windowId, url, ownOrigin);
      return { state: result.state, value: result.detection };
    });

  // Start-up pass: a worker that just woke may be looking at records whose
  // compile died with the previous one.
  sweepJobs(true);

  // The `true` return from handleExtMessage keeps the channel open for the
  // async sendResponse — see utils/listeners.ts (covered by listeners.test.ts).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handled = handleExtMessage(message, sendResponse, {
      runWasmSmoke,
      getCurrentEntity,
      runPdfCompile,
      runPdfCancel,
      runJobsWake,
    });
    if (handled) {
      // A panel-facing request means a panel is open and looking: the badge has
      // done its job, and this is a cheap moment to run the watchdog.
      clearJobBadge();
      sweepJobs();
    }
    return handled;
  });

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
