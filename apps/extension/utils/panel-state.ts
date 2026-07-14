/**
 * Pure side-panel state machine (functional core — spec 003 Task 4 / §2.4).
 *
 * `reduce(state, event)` is a pure `(state, event) => state` transition with no
 * `chrome.*`, no React, no IO — so every transition (including the tricky
 * tab-switch-during-load / stale-response cases) is exhaustively unit-testable.
 * The panel component (App.tsx) is the thin shell: it feeds detection + load
 * events in and renders the resulting state.
 *
 * Stale-response discard: each entry into `loading` carries a monotonically
 * increasing correlation `token`. A `load-succeeded` / `load-failed` event
 * carries the token it was issued for; the reducer ignores any result whose
 * token no longer matches the current `loading` token. That is what makes a
 * tab switch mid-load safe — the outgoing load's late result is dropped.
 */
import type { AtlassianEntity } from "@atlcli/core";
import type { LoadedPage, ReadErrorKind } from "./read-path.js";

/** A detected, loadable Confluence entity plus the URL it came from. */
export interface DetectedRef {
  url: string;
  entity: AtlassianEntity;
}

/** Panel states (PLAN §2.4). `token` threads the correlation counter. */
export type PanelState =
  | { status: "idle"; token: number }
  | { status: "unsupported"; token: number; url: string; entity: AtlassianEntity }
  | { status: "loading"; token: number; ref: DetectedRef; contentId: string }
  | { status: "loaded"; token: number; ref: DetectedRef; contentId: string; page: LoadedPage }
  | {
      status: "error";
      token: number;
      ref: DetectedRef;
      contentId: string;
      kind: ReadErrorKind;
    };

/** Events the panel folds into the state machine. */
export type PanelEvent =
  | { type: "detected"; url: string | null; entity: AtlassianEntity | null }
  | { type: "retry" }
  | { type: "load-succeeded"; token: number; page: LoadedPage }
  | { type: "load-failed"; token: number; kind: ReadErrorKind };

/** The starting state (no tab observed yet). */
export const initialPanelState: PanelState = { status: "idle", token: 0 };

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
      const { url, entity } = event;
      // No entity (non-Atlassian tab / unrecognized URL) → idle.
      if (!entity || !url) return { status: "idle", token: state.token };

      const contentId = loadableContentId(entity);
      if (!contentId) {
        return { status: "unsupported", token: state.token, url, entity };
      }

      // De-dup: the same URL is already in flight / shown / errored — keep the
      // current state rather than restart the load (prevents the mount-pull vs.
      // SW-push double-load and needless flicker).
      if (state.status !== "idle" && currentUrl(state) === url) return state;

      const token = state.token + 1;
      return { status: "loading", token, ref: { url, entity }, contentId };
    }

    case "retry": {
      // Only meaningful from an error state; re-enter loading with a fresh token
      // so any (impossible-but-guarded) prior in-flight result is discarded.
      if (state.status !== "error") return state;
      return {
        status: "loading",
        token: state.token + 1,
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
