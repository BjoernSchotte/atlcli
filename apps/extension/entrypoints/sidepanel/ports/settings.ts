/**
 * Chrome adapter for {@link SettingsStore} (spec 010 Phase 0).
 *
 * `chrome.storage.local` — already in the manifest's `permissions`, so this
 * adds no new capability to the extension (asserted by `tests/manifest.test.ts`).
 */
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
  type SettingsStore,
} from "../../../utils/ports/settings.js";

const STORAGE_KEY = "app-settings-v1";

export function chromeSettingsStore(): SettingsStore {
  return {
    async load(): Promise<AppSettings> {
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        return normalizeSettings(stored?.[STORAGE_KEY]);
      } catch {
        // Storage unavailable (profile locked, quota, extension reload mid-read):
        // the app is fully usable on defaults, so never fail the mount.
        return { ...DEFAULT_SETTINGS };
      }
    },

    async save(settings: AppSettings): Promise<void> {
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    },
  };
}
