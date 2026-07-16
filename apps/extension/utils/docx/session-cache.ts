/**
 * Small TTL cache for the panel's per-site export metadata (spec 004 deps).
 *
 * The engine's resolver deps (space + icon, current user, space-homepage
 * storage) are metadata that changes rarely but was re-fetched on EVERY
 * export — three tabs of the same space each paid the ~100ms space/icon
 * round-trip again. Entries are cached per key for a short TTL: repeat
 * exports within the window skip the round-trip, while a renamed space or
 * swapped logo shows up at most `ttlMs` later. In-flight promises are
 * shared (concurrent exports coalesce); rejections are evicted immediately
 * so a transient failure never sticks.
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
