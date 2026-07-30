import { defineContentScript } from "wxt/utils/define-content-script";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
} from "../../utils/ports/settings.js";
import {
  watchRovoVisibility,
  type RovoVisibilitySettingsSource,
} from "../../utils/rovo-visibility.js";
import "./style.css";

function chromeSettingsSource(): RovoVisibilitySettingsSource {
  return {
    async load(): Promise<AppSettings> {
      try {
        const stored = await chrome.storage.local.get(APP_SETTINGS_STORAGE_KEY);
        return normalizeSettings(stored?.[APP_SETTINGS_STORAGE_KEY]);
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },

    subscribe(listener): () => void {
      const onChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
      ): void => {
        if (areaName !== "local") return;
        const change = changes[APP_SETTINGS_STORAGE_KEY];
        if (!change) return;
        listener(normalizeSettings(change.newValue));
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}

export default defineContentScript({
  matches: ["https://*.atlassian.net/wiki/*"],
  runAt: "document_start",
  world: "ISOLATED",

  main(ctx) {
    const stop = watchRovoVisibility(
      document.documentElement,
      chromeSettingsSource()
    );
    ctx.onInvalidated(stop);
  },
});
