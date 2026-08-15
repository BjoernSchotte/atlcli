/**
 * App preferences, loaded once through the {@link SettingsStore} port.
 *
 * Sits above the i18n provider because the chosen locale *is* a preference:
 * `settings.locale ?? host language` is resolved here and handed down, so no
 * component ever asks the host what language it is in.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsStore,
} from "../../utils/ports/settings.js";

export interface AppSettingsApi {
  settings: AppSettings;
  loaded: boolean;
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
  const [loaded, setLoaded] = useState(false);
  const currentRef = useRef<AppSettings>(DEFAULT_SETTINGS);
  const persistedRef = useRef<AppSettings>(DEFAULT_SETTINGS);
  const revisionRef = useRef(0);
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void store
      .load()
      .then((loaded) => {
        if (!cancelled) {
          currentRef.current = loaded;
          persistedRef.current = loaded;
          setSettings(loaded);
          setLoaded(true);
        }
      })
      .catch(() => {
        // A host that cannot read preferences still gets a working app on the
        // defaults; the Settings screen surfaces write failures separately.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const update = useCallback<AppSettingsApi["update"]>(
    async (patch) => {
      const next = { ...currentRef.current, ...patch };
      const revision = revisionRef.current + 1;
      revisionRef.current = revision;
      // Optimistic: the UI must not lag behind a language switch while storage
      // round-trips. Saves are serialized so rapid patches cannot overwrite one
      // another with stale whole-record snapshots.
      currentRef.current = next;
      setSettings(next);

      const save = saveTailRef.current.then(async () => {
        await store.save(next);
        persistedRef.current = next;
      });
      saveTailRef.current = save.catch(() => undefined);

      try {
        await save;
      } catch (error) {
        // Only the newest failed update may roll the UI back. If a newer save
        // is queued, its whole-record snapshot includes this patch and becomes
        // the next authority. Otherwise return to the last durable record.
        if (revisionRef.current === revision) {
          currentRef.current = persistedRef.current;
          setSettings(persistedRef.current);
        }
        throw error;
      }
    },
    [store]
  );

  const value = useMemo<AppSettingsApi>(
    () => ({ settings, loaded, update }),
    [settings, loaded, update],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings(): AppSettingsApi {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useAppSettings must be used inside a <SettingsProvider>.");
  }
  return context;
}
