/**
 * Restart-safe state for the MV3 tab observer.
 *
 * Chrome may stop the extension service worker between tab events, so observer
 * ordering state cannot live only in a module variable. This helper keeps an
 * arbitrary observer-state shape in an injected `chrome.storage.session`-like
 * adapter. Keeping the state generic lets the observer evolve (for example,
 * from one last URL to per-window URL memory) without coupling persistence to
 * that shape.
 *
 * All loads and transitions share one promise queue. Concurrent tab events and
 * panel pulls therefore cannot both read the same sequence and overwrite one
 * another. A failed operation is returned to its caller but does not poison the
 * queue for later events.
 */

/** Minimal promise-based surface implemented by `chrome.storage.session`. */
export interface ObserverSessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ObserverSessionOptions<State> {
  /** Storage key dedicated to this observer state. */
  key: string;
  /** Fresh fallback used when storage is empty or contains invalid data. */
  initialState: () => State;
  /** Runtime validation for values read from storage and transition results. */
  isState: (value: unknown) => value is State;
}

export interface ObserverTransition<State, Value> {
  state: State;
  value: Value;
}

export interface ObserverSession<State> {
  /** Load the validated state after all earlier queued operations complete. */
  load(): Promise<State>;
  /** Apply and persist one pure observer transition in queue order. */
  mutate<Value>(
    transition: (
      state: State
    ) => ObserverTransition<State, Value> | Promise<ObserverTransition<State, Value>>
  ): Promise<Value>;
}

/**
 * Create one serialized, restart-safe observer-state owner.
 *
 * Missing or invalid stored data is repaired with a validated fresh initial
 * state. Transition results are persisted before their values become visible
 * to callers, so a push is never emitted for state that was not durably saved.
 */
export function createObserverSession<State>(
  storage: ObserverSessionStorage,
  options: ObserverSessionOptions<State>
): ObserverSession<State> {
  let cached: State | undefined;
  let hasCached = false;
  let queue: Promise<void> = Promise.resolve();

  const loadCached = async (): Promise<State> => {
    if (hasCached) return cached as State;

    const stored = await storage.get(options.key);
    const candidate = stored[options.key];
    if (options.isState(candidate)) {
      cached = candidate;
      hasCached = true;
      return candidate;
    }

    const initial = options.initialState();
    if (!options.isState(initial)) {
      throw new TypeError("Observer session initialState returned an invalid value.");
    }
    await storage.set({ [options.key]: initial });
    cached = initial;
    hasCached = true;
    return initial;
  };

  const enqueue = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    load: () => enqueue(loadCached),

    mutate: <Value>(
      transition: (
        state: State
      ) => ObserverTransition<State, Value> | Promise<ObserverTransition<State, Value>>
    ): Promise<Value> =>
      enqueue(async () => {
        const previous = await loadCached();
        const next = await transition(previous);
        if (!options.isState(next.state)) {
          throw new TypeError("Observer session transition returned an invalid state.");
        }

        if (next.state !== previous) {
          await storage.set({ [options.key]: next.state });
          cached = next.state;
          hasCached = true;
        }
        return next.value;
      }),
  };
}
