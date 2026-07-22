/**
 * App preferences, loaded once through the {@link SettingsStore} port.
 *
 * Sits above the i18n provider because the chosen locale *is* a preference:
 * `settings.locale ?? host language` is resolved here and handed down, so no
 * component ever asks the host what language it is in.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsStore,
} from "../../utils/ports/settings.js";

export interface AppSettingsApi {
  settings: AppSettings;
  /** Merge a patch, persist it, and reflect it immediately. */
  update(patch: Partial<AppSettings>): Promise<void>;
}

const SettingsContext = createContext<AppSettingsApi | null>(null);

export function SettingsProvider({
  store,
  children,
}: {
  store: SettingsStore;
  children: React.ReactNode;
}): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void store
      .load()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch(() => {
        // A host that cannot read preferences still gets a working app on the
        // defaults; the Settings screen surfaces write failures separately.
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const update = useCallback<AppSettingsApi["update"]>(
    async (patch) => {
      const next = { ...settings, ...patch };
      // Optimistic: the UI must not lag behind a language switch while storage
      // round-trips. A rejected save propagates to the caller.
      setSettings(next);
      await store.save(next);
    },
    [settings, store]
  );

  const value = useMemo<AppSettingsApi>(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings(): AppSettingsApi {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useAppSettings must be used inside a <SettingsProvider>.");
  }
  return context;
}
