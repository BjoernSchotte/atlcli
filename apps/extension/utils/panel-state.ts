/**
 * Pure side-panel state machine (functional core — spec 003 Task 4 / §2.4).
 *
 * `reduce(state, event)` is a pure `(state, event) => state` transition with no
 * `chrome.*`, no React, no IO — so every transition (including the tricky
 * tab-switch-during-load / stale-response cases) is exhaustively unit-testable.
 * The panel component (App.tsx) is the thin shell: it feeds detection + load
 * events in and renders the resulting state.
 *
 * Two independent ordering guards keep the machine correct under races:
 *
 *  - `token` (load correlation): each entry into `loading` bumps it. A
 *    `load-succeeded` / `load-failed` event carries the token it was issued for;
 *    the reducer ignores any result whose token no longer matches the current
 *    `loading` token. That makes a tab switch mid-load safe — the outgoing
 *    load's late result is dropped.
 *
 *  - `lastSeq` (detection ordering): every `detected` event carries the SW's
 *    monotonic detection `seq`. The reducer ignores any detection not strictly
 *    newer than the last one it applied, so a delayed `get-current-entity` pull
 *    for tab A that arrives AFTER a newer `entity-changed` push for tab B can no
 *    longer overwrite B (spec 003, finding: detection ordering / lost update).
 *    Legacy events without a `seq` behave as before (each one applies).
 */
import type { AtlassianEntity } from "@atlcli/core";
import type { LoadedPage, ReadErrorKind } from "./read-path.js";

/** A detected, loadable Confluence entity plus the URL it came from. */
export interface DetectedRef {
  url: string;
  entity: AtlassianEntity;
}

/**
 * Panel states (PLAN §2.4).
 *  - `token`   threads the load correlation counter.
 *  - `lastSeq` threads the last-applied detection ordering `seq`.
 */
export type PanelState =
  | { status: "idle"; token: number; lastSeq: number }
  | { status: "unsupported"; token: number; lastSeq: number; url: string; entity: AtlassianEntity }
  | { status: "loading"; token: number; lastSeq: number; ref: DetectedRef; contentId: string }
  | {
      status: "loaded";
      token: number;
      lastSeq: number;
      ref: DetectedRef;
      contentId: string;
      page: LoadedPage;
    }
  | {
      status: "error";
      token: number;
      lastSeq: number;
      ref: DetectedRef;
      contentId: string;
      kind: ReadErrorKind;
    };

/**
 * Events the panel folds into the state machine. `detected` carries an optional
 * ordering `seq` (the SW stamps it in production); when absent the event is
 * treated as newest (legacy/always-apply).
 */
export type PanelEvent =
  | { type: "detected"; url: string | null; entity: AtlassianEntity | null; seq?: number }
  | { type: "retry" }
  | { type: "load-succeeded"; token: number; page: LoadedPage }
  | { type: "load-failed"; token: number; kind: ReadErrorKind };

/** The starting state (no tab observed yet). */
export const initialPanelState: PanelState = { status: "idle", token: 0, lastSeq: 0 };

/**
 * The content id to load for an entity, or `null` when the entity is detected
 * but not a read target. Confluence pages and blogposts are actionable
 * (PLAN §1); spaces and all Jira entities are informational only.
 */
export function loadableContentId(entity: AtlassianEntity): string | null {
  if (entity.product === "confluence" && entity.type === "page") return entity.pageId;
  if (entity.product === "confluence" && entity.type === "blogpost") return entity.contentId;
  return null;
}

/** The URL currently associated with a non-idle state, if any. */
function currentUrl(state: PanelState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "unsupported":
      return state.url;
    default:
      return state.ref.url;
  }
}

/** Pure transition. Never throws. */
export function reduce(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "detected": {
      // Ordering guard: drop any detection not strictly newer than the last one
      // applied. A missing `seq` (legacy) counts as newest. This is what stops a
      // late pull for tab A from clobbering an already-applied newer push for B.
      const eventSeq = event.seq ?? state.lastSeq + 1;
      if (eventSeq <= state.lastSeq) return state;

      const { url, entity } = event;
      // No entity (non-Atlassian tab / unrecognized URL) → idle.
      if (!entity || !url) return { status: "idle", token: state.token, lastSeq: eventSeq };

      const contentId = loadableContentId(entity);
      if (!contentId) {
        return { status: "unsupported", token: state.token, lastSeq: eventSeq, url, entity };
      }

      // De-dup: the same URL is already in flight / shown / errored — keep the
      // current view rather than restart the load (prevents the mount-pull vs.
      // SW-push double-load and needless flicker). Still advance `lastSeq` so a
      // later out-of-order detection for a DIFFERENT URL can't win.
      if (state.status !== "idle" && currentUrl(state) === url) {
        return { ...state, lastSeq: eventSeq };
      }

      const token = state.token + 1;
      return { status: "loading", token, lastSeq: eventSeq, ref: { url, entity }, contentId };
    }

    case "retry": {
      // Meaningful from `error` (Retry) and `loaded` (Reload): re-enter loading
      // with a fresh token so the load effect re-fires; stale protection intact.
      if (state.status !== "error" && state.status !== "loaded") return state;
      return {
        status: "loading",
        token: state.token + 1,
        lastSeq: state.lastSeq,
        ref: state.ref,
        contentId: state.contentId,
      };
    }

    case "load-succeeded": {
      // Stale-response discard: only accept the result for the active load.
      if (state.status !== "loading" || event.token !== state.token) return state;
      return {
        status: "loaded",
        token: state.token,
        lastSeq: state.lastSeq,
        ref: state.ref,
        contentId: state.contentId,
        page: event.page,
      };
    }

    case "load-failed": {
      if (state.status !== "loading" || event.token !== state.token) return state;
      return {
        status: "error",
        token: state.token,
        lastSeq: state.lastSeq,
        ref: state.ref,
        contentId: state.contentId,
        kind: event.kind,
      };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
