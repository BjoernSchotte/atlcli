/**
 * The host seam for durable jobs (spec 010 T5.6).
 *
 * `JobsScreen` is a portable screen: it must render under happy-dom with
 * `globalThis.chrome` deleted, exactly like every other screen
 * (`tests/app-portability.test.tsx`). So it never reaches for IndexedDB or
 * `chrome.*` itself — it asks this context for a {@link DurableJobsPort} and
 * renders nothing when there is none.
 *
 * The default is built **lazily, on first use inside an effect**, never at module
 * scope: a module-scope `chrome.runtime.getManifest()` is the exact defect Phase
 * 0 removed from `App.tsx`, and the same rule applies to `indexedDB`. A host
 * with neither simply has no jobs, which is also the correct answer.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { chromeDurableJobsStore, type DurableJob, type DurableJobsPort } from "./store.js";

const DurableJobsContext = createContext<DurableJobsPort | null | undefined>(undefined);

/** Provide an explicit port (tests, and any host that wires one itself). */
export function DurableJobsProvider({
  port,
  children,
}: {
  port: DurableJobsPort | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return <DurableJobsContext.Provider value={port}>{children}</DurableJobsContext.Provider>;
}

/**
 * Swappable creator for the ambient port, so the seam can be exercised without
 * a real Chrome. `null` disables the ambient default entirely.
 */
let ambientFactory: (() => DurableJobsPort) | null = chromeDurableJobsStore;

export function setAmbientDurableJobsFactory(factory: (() => DurableJobsPort) | null): void {
  ambientFactory = factory;
}

/**
 * The ambient default: the Chrome-backed store, but only where both halves it
 * needs actually exist. Evaluated at first render, never at module scope.
 */
function ambientDurableJobs(): DurableJobsPort | null {
  const scope = globalThis as unknown as { chrome?: { runtime?: unknown }; indexedDB?: unknown };
  if (!scope.chrome?.runtime || !scope.indexedDB) return null;
  try {
    return ambientFactory?.() ?? null;
  } catch {
    return null;
  }
}

/** The port for this host, or `null` when durable jobs are not available here. */
export function useDurableJobsPort(): DurableJobsPort | null {
  const provided = useContext(DurableJobsContext);
  const [ambient] = useState<DurableJobsPort | null>(() =>
    provided === undefined ? ambientDurableJobs() : null
  );
  return provided === undefined ? ambient : provided;
}

export interface DurableJobsView {
  jobs: readonly DurableJob[];
  /** False until the first read settles, so an empty list is never shown too early. */
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
  download: (id: string) => void;
}

/** Poll cadence while at least one job is running. */
export const JOBS_POLL_MS = 1_000;
/** Poll cadence when nothing is running (a background job may still finish). */
export const JOBS_IDLE_POLL_MS = 5_000;

/**
 * Read the durable jobs for one site and keep them fresh.
 *
 * Polling, not subscription, on purpose: the records are written by an offscreen
 * worker and by a service worker that may be restarted between two of its own
 * writes. A push channel would have to be re-established after every one of
 * those restarts and would still have to fall back to a read — so the read *is*
 * the mechanism, and re-attaching after a panel close is the same code path as
 * the steady state rather than a special case.
 */
export function useDurableJobs(siteOrigin: string | null): DurableJobsView {
  const port = useDurableJobsPort();
  const [jobs, setJobs] = useState<readonly DurableJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!port) {
      setJobs([]);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = async (): Promise<void> => {
      try {
        const next = await port.list({ siteOrigin });
        if (cancelled) return;
        setJobs(next);
        setError(null);
        setLoaded(true);
        timer = setTimeout(
          () => void read(),
          next.some((job) => job.running) ? JOBS_POLL_MS : JOBS_IDLE_POLL_MS
        );
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoaded(true);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [port, siteOrigin, tick]);

  const act = useCallback(
    (run: (port: DurableJobsPort) => Promise<unknown>) => {
      if (!port) return;
      void run(port)
        .catch((reason) => {
          if (alive.current) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        })
        .finally(() => {
          if (alive.current) refresh();
        });
    },
    [port, refresh]
  );

  return useMemo<DurableJobsView>(
    () => ({
      jobs,
      loaded,
      error,
      refresh,
      cancel: (id) => act((p) => p.cancel(id)),
      dismiss: (id) => act((p) => p.dismiss(id)),
      download: (id) => act((p) => p.download(id)),
    }),
    [jobs, loaded, error, refresh, act]
  );
}
