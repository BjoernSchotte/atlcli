/**
 * "Which page is the panel showing?" — the Chrome half (spec 010 Phase 0).
 *
 * A plain function, not an interface: this is Chrome-specific by nature, and
 * the pieces it composes already exist — `extractEntityFromUrl` runs in the
 * service worker's tab observer, `EntityDetection` is the existing payload, and
 * the ordering `seq` is stamped by that observer. All that is added here is the
 * wiring `App.tsx` used to hold inline.
 *
 * A global side panel belongs to ONE Chrome window, and that window must be
 * resolved from the panel context — in the service worker "current window"
 * falls back to the last-focused window, which is a different question.
 * Snapshots arriving before the window id is known are dropped; the pull
 * recovers the current URL.
 *
 * The visibility/focus re-pull lives here too: after an extension reload an
 * already-open Confluence tab fires no tab event, so re-resolving on focus is
 * the only recovery path short of a page reload. The reducer's `seq` guard
 * makes a stale answer harmless.
 */
import { isEntityChangedForWindow, type ExtResponse } from "../../../utils/messages.js";
import type { PageContext } from "../../../utils/ports/index.js";
import type { SiteContext } from "./site-context.js";

export function watchChromePageContext(
  site: SiteContext,
  onChange: (context: PageContext) => void
): () => void {
  let windowId: number | null = null;
  let stopped = false;

  const publish = (context: PageContext): void => {
    if (stopped) return;
    site.set(context.url);
    onChange(context);
  };

  const resolveWindowId = async (): Promise<number | null> => {
    if (windowId !== null) return windowId;
    try {
      windowId = (await chrome.windows.getCurrent()).id ?? null;
    } catch {
      // The window closed before initialization; never fall back elsewhere.
      windowId = null;
    }
    return windowId;
  };

  const pull = async (): Promise<void> => {
    const id = await resolveWindowId();
    if (id === null || stopped) return;
    try {
      const response = (await chrome.runtime.sendMessage({
        kind: "get-current-entity",
        windowId: id,
      })) as ExtResponse | undefined;
      if (!response || response.kind !== "current-entity") return;
      const { detection } = response;
      if (detection.windowId !== id) return;
      publish({ url: detection.url, entity: detection.entity, seq: detection.seq });
    } catch {
      // Service worker asleep / no answer — a push will follow on the next tab
      // event.
    }
  };

  const onMessage = (message: unknown): void => {
    if (windowId === null) return;
    if (!isEntityChangedForWindow(message, windowId)) return;
    const { detection } = message;
    publish({ url: detection.url, entity: detection.entity, seq: detection.seq });
  };
  chrome.runtime.onMessage.addListener(onMessage);

  const onVisible = (): void => {
    if (document.visibilityState === "visible") void pull();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);

  void pull();

  return () => {
    stopped = true;
    chrome.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
