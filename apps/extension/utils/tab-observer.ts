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
 * Dedup + ordering memory. `lastEmittedUrl` de-duplicates SPA URL storms;
 * `seq` is the monotonic detection counter shared by pushes and pulls so the
 * panel can order out-of-order deliveries (see {@link EntityDetection.seq}).
 */
export interface ObserverState {
  lastEmittedUrl: string | null;
  seq: number;
}

/** Initial observer state (nothing emitted yet). */
export function initialObserverState(): ObserverState {
  return { lastEmittedUrl: null, seq: 0 };
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
export function classifyUrl(url: string): Omit<EntityDetection, "seq"> {
  const entity = isAtlassianCloudUrl(url) ? extractEntityFromUrl(url) : null;
  return { url, entity };
}

/** Resolve a URL to a full detection payload stamped with `seq`. */
export function detectEntity(url: string, seq: number): EntityDetection {
  return { ...classifyUrl(url), seq };
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

  const seq = state.seq + 1;
  const detection = detectEntity(url, seq);
  return {
    state: { lastEmittedUrl: url, seq },
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
 *   - no URL    → null detection stamped with the current seq (won't supersede
 *     an already-applied real detection at the same seq).
 */
export function currentDetection(
  state: ObserverState,
  url: string | undefined | null
): { state: ObserverState; detection: EntityDetection } {
  if (!url) {
    return { state, detection: { url: null, entity: null, seq: state.seq } };
  }
  if (url === state.lastEmittedUrl) {
    return { state, detection: detectEntity(url, state.seq) };
  }
  const seq = state.seq + 1;
  return { state: { lastEmittedUrl: url, seq }, detection: detectEntity(url, seq) };
}

/** Re-export for shells that only need the entity type. */
export type { AtlassianEntity };
