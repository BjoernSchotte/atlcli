/**
 * App preferences port (spec 010 Phase 0).
 *
 * The extension stores these in `chrome.storage.local`; a Forge host would use
 * its own storage. The app only ever sees {@link AppSettings}, which is why the
 * Settings screen has no host knowledge at all.
 */
import { isLocale, type Locale } from "../i18n/messages.js";

export const APP_WORKSPACES = ["ai", "publishing"] as const;
export type AppWorkspace = (typeof APP_WORKSPACES)[number];

function isAppWorkspace(value: unknown): value is AppWorkspace {
  return APP_WORKSPACES.includes(value as AppWorkspace);
}

export interface AppSettings {
  /** `null` = follow the host/browser language. */
  locale: Locale | null;
  /** `null` = open Kiteweave AI, the first-run workspace. */
  lastWorkspace: AppWorkspace | null;
  /** Hide the two persistent Rovo entry points in the Confluence Cloud UI. */
  hideRovoEntrypoints: boolean;
  /**
   * The one-time Kiteweave AI disclosure ("selected content goes to the
   * chosen LLM provider") was confirmed. Confirmed once, it stays confirmed
   * until withdrawn from the composer's status line (sidebar redesign,
   * 2026-10); it never auto-confirms — only an explicit user action writes it.
   */
  aiDisclosureConfirmed: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: null,
  lastWorkspace: null,
  hideRovoEntrypoints: false,
  aiDisclosureConfirmed: false,
};

/** Shared record key used by every Chrome extension context. */
export const APP_SETTINGS_STORAGE_KEY = "app-settings-v1";

export interface SettingsStore {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

/**
 * Coerce an untrusted stored value into {@link AppSettings}.
 *
 * Storage outlives any single version of this app, so a record written by an
 * older (or newer) build must degrade to the default rather than crash the
 * panel on mount.
 */
export function normalizeSettings(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const candidate = value as {
    locale?: unknown;
    lastWorkspace?: unknown;
    hideRovoEntrypoints?: unknown;
    aiDisclosureConfirmed?: unknown;
  };
  return {
    locale: isLocale(candidate.locale) ? candidate.locale : null,
    lastWorkspace: isAppWorkspace(candidate.lastWorkspace) ? candidate.lastWorkspace : null,
    // Fail open: malformed or legacy records must never hide host UI.
    hideRovoEntrypoints: candidate.hideRovoEntrypoints === true,
    // Fail closed: consent is only ever an explicit `true`.
    aiDisclosureConfirmed: candidate.aiDisclosureConfirmed === true,
  };
}

/** In-memory store — the default for hosts without persistence, and for tests. */
export function memorySettingsStore(initial: AppSettings = DEFAULT_SETTINGS): SettingsStore {
  let current: AppSettings = { ...initial };
  return {
    load: async () => ({ ...current }),
    save: async (settings) => {
      current = { ...settings };
    },
  };
}
