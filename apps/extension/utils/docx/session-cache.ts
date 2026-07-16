/**
 * Small TTL cache for the panel's stable per-site export metadata.
 *
 * The extension uses this for space + icon only: current-user and homepage
 * content have no safe same-site invalidation signal and stay per-export.
 * Entries are cached per key for a short TTL. In-flight promises are shared
 * (concurrent exports coalesce); rejections are evicted immediately so a
 * transient failure never sticks.
 */
export interface SessionCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
}

export function sessionCache<T>(
  ttlMs: number,
  maxEntries = 32,
  now: () => number = Date.now
): SessionCache<T> {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      const value = load();
      // Delete-then-set keeps Map insertion order = recency, so the
      // max-entries eviction below always drops the stalest key.
      entries.delete(key);
      entries.set(key, { at: now(), value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return value;
    },
  };
}
