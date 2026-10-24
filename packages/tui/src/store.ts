import { useSyncExternalStore } from "react";

/**
 * A synchronous store. Keys can arrive in one batch (fast typing, paste,
 * tmux) before React re-renders, so every update applies at once and the
 * next key already sees it; React only renders the result.
 */
export interface Store<S> {
  get(): S;
  set(update: (state: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(update) {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<S, T>(store: Store<S>, select: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
