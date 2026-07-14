/**
 * Pure tab-observation core (functional core — spec 003 Task 1).
 *
 * The service worker is the canonical tab observer (PLAN §2.1): it watches
 * `chrome.tabs.onActivated` (tab switch) and `chrome.tabs.onUpdated` (SPA URL
 * changes within Confluence) and pushes `entity-changed` to the panel. This
 * module holds ALL the decision logic — URL → entity mapping and de-duplication
 * — as pure functions over synthetic events, so the imperative shell
 * (background.ts) stays a thin adapter and the logic is exhaustively testable
 * without a real browser.
 */
import { type AtlassianEntity, extractEntityFromUrl } from "@atlcli/core";
import type { EntityChanged, EntityDetection } from "./messages.js";

/** Dedup memory: the last URL for which we emitted an `entity-changed`. */
export interface ObserverState {
  lastEmittedUrl: string | null;
}

/** Initial observer state (nothing emitted yet). */
export function initialObserverState(): ObserverState {
  return { lastEmittedUrl: null };
}

/** Resolve a URL to a detection payload (entity or `null`). */
export function detectEntity(url: string): EntityDetection {
  return { url, entity: extractEntityFromUrl(url) };
}

/**
 * Fold one tab event (the active tab's current URL) into the observer.
 *
 * Returns the next state and, when the URL is new, the `entity-changed` message
 * to push. Confluence SPA navigation fires `onUpdated` repeatedly with the same
 * URL; feeding the same URL twice yields `message: null` the second time — the
 * de-dup that prevents a message storm (PLAN §2.1, Task 1 AC).
 *
 * A falsy/empty URL (no active tab, `chrome://` pages without a URL) is a no-op
 * and never resets the dedup memory.
 *
 * @param state  previous observer state.
 * @param url    the active tab's current URL, if any.
 */
export function observeTab(
  state: ObserverState,
  url: string | undefined | null
): { state: ObserverState; message: EntityChanged | null } {
  if (!url) return { state, message: null };
  if (url === state.lastEmittedUrl) return { state, message: null };

  const detection = detectEntity(url);
  return {
    state: { lastEmittedUrl: url },
    message: { kind: "entity-changed", detection },
  };
}

/** Re-export for shells that only need the entity type. */
export type { AtlassianEntity };
