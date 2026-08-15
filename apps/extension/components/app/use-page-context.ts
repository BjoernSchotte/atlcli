/**
 * Binds the host's page-context subscription to the pure panel state machine.
 *
 * This is what removes detection logic from the view layer: the reducer in
 * `utils/panel-state.ts` (with its `seq` ordering guard and its `token`
 * stale-response guard) is unchanged and still the only place transitions
 * happen — but nothing here knows about `chrome.runtime.onMessage`,
 * `chrome.windows.getCurrent`, `get-current-entity`, or the visibility/focus
 * re-pull. Those live in the host adapter behind `watchPageContext`.
 */
import { useCallback, useEffect, useReducer } from "react";
import { initialPanelState, reduce, type PanelState } from "../../utils/panel-state.js";
import { ReadError, type ReadErrorKind } from "../../utils/read-path.js";
import type { AppPorts } from "../../utils/ports/index.js";

export interface PageContextBinding {
  state: PanelState;
  /** Re-run the current load (Retry / Reload). */
  retry: () => void;
  /**
   * Discriminates "the same page" from "a different page" for anything that
   * must be reset or re-attached when the user navigates.
   */
  identity: string;
}

export function usePageContext(
  watchPageContext: AppPorts["watchPageContext"],
  loadPage: AppPorts["loadPage"]
): PageContextBinding {
  const [state, dispatch] = useReducer(reduce, initialPanelState);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = watchPageContext((context) => {
      if (cancelled) return;
      dispatch({
        type: "detected",
        url: context.url,
        entity: context.entity,
        seq: context.seq,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [watchPageContext]);

  // Load effect: fires once per `loading` entry, keyed on the correlation token
  // so a tab switch mid-load discards the outgoing load's late result.
  const loadToken = state.status === "loading" ? state.token : 0;
  const contentId = state.status === "loading" ? state.contentId : null;
  useEffect(() => {
    if (contentId === null || loadToken === 0) return;
    let cancelled = false;

    void loadPage(contentId)
      .then((page) => {
        if (!cancelled) dispatch({ type: "load-succeeded", token: loadToken, page });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind: ReadErrorKind = error instanceof ReadError ? error.kind : "unknown";
        dispatch({ type: "load-failed", token: loadToken, kind });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadToken, contentId]);

  const retry = useCallback(() => dispatch({ type: "retry" }), []);

  return { state, retry, identity: pageIdentity(state) };
}

/** `<url>|<id>|<version>` for a loaded page; `""` when nothing is loaded. */
export function pageIdentity(state: PanelState): string {
  if (state.status !== "loaded") return "";
  return `${state.ref.url}|${state.page.details.id}|${state.page.details.version ?? ""}`;
}
