/**
 * Functional core for the Confluence Rovo visibility content script.
 *
 * The content script supplies the Chrome storage adapter. This module only
 * projects a boolean setting onto one owned document attribute, which keeps the
 * lifecycle deterministic and testable without WXT or extension globals.
 */
import type { AppSettings } from "./ports/settings.js";

export const ROVO_HIDDEN_ATTRIBUTE = "data-kiteweave-hide-rovo";

export interface RovoVisibilitySettingsSource {
  load(): Promise<AppSettings>;
  subscribe(listener: (settings: AppSettings) => void): () => void;
}

export function applyRovoVisibility(
  root: Element,
  hideRovoEntrypoints: boolean
): void {
  root.toggleAttribute(ROVO_HIDDEN_ATTRIBUTE, hideRovoEntrypoints);
}

/**
 * Keep one document root aligned with persisted settings.
 *
 * Subscribe before the asynchronous initial read so an update that arrives
 * while `load()` is pending wins over the stale snapshot. The returned cleanup
 * is idempotent and restores the host UI.
 */
export function watchRovoVisibility(
  root: Element,
  source: RovoVisibilitySettingsSource
): () => void {
  let stopped = false;
  let changeRevision = 0;

  const unsubscribe = source.subscribe((settings) => {
    if (stopped) return;
    changeRevision += 1;
    applyRovoVisibility(root, settings.hideRovoEntrypoints);
  });

  const initialRevision = changeRevision;
  void source
    .load()
    .then((settings) => {
      if (stopped || changeRevision !== initialRevision) return;
      applyRovoVisibility(root, settings.hideRovoEntrypoints);
    })
    .catch(() => {
      // Fail open. Storage may be unavailable while the extension reloads;
      // hiding host UI without a confirmed opt-in would be the unsafe default.
      if (!stopped && changeRevision === initialRevision) {
        applyRovoVisibility(root, false);
      }
    });

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    applyRovoVisibility(root, false);
  };
}
