/**
 * Pure tab-observation core (functional core — spec 003 Task 1).
 *
 * The service worker is the canonical tab observer (PLAN §2.1): it watches
 * `chrome.tabs.onActivated` (tab switch) and `chrome.tabs.onUpdated` (SPA URL
 * changes within Confluence) and pushes `entity-changed` to the panel. This
 * module holds ALL the decision logic — URL → entity mapping, origin gating,
 * de-duplication, and detection ordering — as pure functions over synthetic
 * events, so the imperative shell (background.ts) stays a thin adapter and the
 * logic is exhaustively testable without a real browser.
 */
import { type AtlassianEntity, extractEntityFromUrl } from "@atlcli/core";
import type { EntityChanged, EntityDetection } from "./messages.js";
import { isAtlassianCloudUrl } from "./profile.js";

/**
 * Dedup + ordering memory. `lastEmittedUrlByWindow` de-duplicates SPA URL
 * storms independently for each Chrome window;
 * `seq` is the monotonic detection counter shared by pushes and pulls so the
 * panel can order out-of-order deliveries (see {@link EntityDetection.seq}).
 */
export interface ObserverState {
  lastEmittedUrlByWindow: Record<string, string>;
  seq: number;
}

/** Initial observer state (nothing emitted yet). */
export function initialObserverState(): ObserverState {
  return { lastEmittedUrlByWindow: {}, seq: 0 };
}

/** Validate observer state restored from `chrome.storage.session`. */
export function isObserverState(value: unknown): value is ObserverState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ObserverState>;
  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq ?? -1) < 0) return false;
  if (
    !candidate.lastEmittedUrlByWindow ||
    typeof candidate.lastEmittedUrlByWindow !== "object" ||
    Array.isArray(candidate.lastEmittedUrlByWindow)
  ) {
    return false;
  }
  return Object.entries(candidate.lastEmittedUrlByWindow).every(
    ([windowId, url]) => /^\d+$/.test(windowId) && typeof url === "string"
  );
}

/**
 * Resolve a URL to an entity classification (without a seq).
 *
 * The extractor recognizes Confluence/Jira URL SHAPES on any host, so we gate
 * on a valid Atlassian Cloud origin first (single source of truth:
 * {@link isAtlassianCloudUrl}). A Confluence-shaped path on a foreign origin
 * (`https://evil-atlassian.net/wiki/spaces/D/pages/123/A`) is therefore a
 * non-entity from the start — consistent with `profileFromTabUrl` returning
 * null for it, so the panel lands on the idle/unsupported state instead of a
 * spurious "unknown error" (spec 003, finding: foreign-origin gating).
 */
export function classifyUrl(url: string): Omit<EntityDetection, "seq" | "windowId"> {
  const entity = isAtlassianCloudUrl(url) ? extractEntityFromUrl(url) : null;
  return { url, entity };
}

/** Resolve a URL to a full detection payload stamped with `seq`. */
export function detectEntity(url: string, seq: number, windowId: number): EntityDetection {
  return { ...classifyUrl(url), seq, windowId };
}

/**
 * Is `url` one of THIS extension's own pages?
 *
 * Our large-preview tab opens in the same Chrome window and becomes the active
 * tab, which is an `onActivated` event carrying a `chrome-extension:` URL. Folding
 * that in as an ordinary tab switch is wrong twice over: the preview page pulls
 * back a null entity and has no page to preview, and the side panel behind it —
 * listening on the same window — loses its page as well.
 *
 * The exemption is deliberately narrow. It is keyed on the extension's OWN
 * origin, supplied by the host (`chrome.runtime.getURL("/")`), not on the
 * `chrome-extension:` scheme: another extension's page is a genuine navigation
 * away and must still clear the context, exactly like any foreign site. A host
 * that supplies nothing gets the old behaviour rather than a guess.
 */
function isOwnSurface(url: string, ownOrigin: string | undefined): boolean {
  return ownOrigin !== undefined && ownOrigin.length > 0 && url.startsWith(ownOrigin);
}

/**
 * Fold one tab event (the active tab's current URL) into the observer.
 *
 * Returns the next state and, when the URL is new, the `entity-changed` message
 * to push. Confluence SPA navigation fires `onUpdated` repeatedly with the same
 * URL; feeding the same URL twice yields `message: null` the second time — the
 * de-dup that prevents a message storm (PLAN §2.1, Task 1 AC). Each real
 * emission bumps `seq` so the panel can order deliveries.
 *
 * A falsy/empty URL (no active tab, `chrome://` pages without a URL) is a no-op
 * and never resets the dedup memory. One of THIS extension's own pages is
 * treated the same way — see {@link isOwnSurface}.
 *
 * @param state      previous observer state.
 * @param url        the active tab's current URL, if any.
 * @param ownOrigin  this extension's origin (`chrome.runtime.getURL("/")`).
 */
export function observeTab(
  state: ObserverState,
  windowId: number,
  url: string | undefined | null,
  ownOrigin?: string
): { state: ObserverState; message: EntityChanged | null } {
  if (!url || isOwnSurface(url, ownOrigin)) return { state, message: null };
  const windowKey = String(windowId);
  if (url === state.lastEmittedUrlByWindow[windowKey]) return { state, message: null };

  const seq = state.seq + 1;
  const detection = detectEntity(url, seq, windowId);
  return {
    state: {
      lastEmittedUrlByWindow: { ...state.lastEmittedUrlByWindow, [windowKey]: url },
      seq,
    },
    message: { kind: "entity-changed", detection },
  };
}

/**
 * Resolve the CURRENT detection for a panel-initiated pull (`get-current-entity`).
 *
 * Unlike {@link observeTab} it always yields a detection (the panel needs an
 * answer on mount even when the URL is unchanged), and it shares the SAME `seq`
 * counter so pulls and pushes are globally ordered:
 *   - new URL   → behaves like an observation: bump `seq`, remember the URL.
 *   - same URL  → return the seq of that URL's emission (no bump, no re-push).
 *   - own page  → answer with the page this window is STILL showing, so the
 *     large-preview tab (which is itself the active tab when it asks) inherits
 *     the context it was opened from instead of clearing it.
 *   - no URL    → null detection stamped with the current seq (won't supersede
 *     an already-applied real detection at the same seq).
 */
export function currentDetection(
  state: ObserverState,
  windowId: number,
  url: string | undefined | null,
  ownOrigin?: string
): { state: ObserverState; detection: EntityDetection } {
  const windowKey = String(windowId);
  if (url && isOwnSurface(url, ownOrigin)) {
    const remembered = state.lastEmittedUrlByWindow[windowKey];
    return {
      state,
      detection: remembered
        ? detectEntity(remembered, state.seq, windowId)
        : { windowId, url: null, entity: null, seq: state.seq },
    };
  }
  if (!url) {
    return { state, detection: { windowId, url: null, entity: null, seq: state.seq } };
  }
  if (url === state.lastEmittedUrlByWindow[windowKey]) {
    return { state, detection: detectEntity(url, state.seq, windowId) };
  }
  const seq = state.seq + 1;
  return {
    state: {
      lastEmittedUrlByWindow: { ...state.lastEmittedUrlByWindow, [windowKey]: url },
      seq,
    },
    detection: detectEntity(url, seq, windowId),
  };
}

/** Re-export for shells that only need the entity type. */
export type { AtlassianEntity };
