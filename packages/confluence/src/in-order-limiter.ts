/**
 * In-order-delivery concurrency limiter.
 *
 * Runs at most `limit` jobs at once but resolves each caller's promise strictly
 * in the order the jobs were *issued*, regardless of the order they *complete*.
 * A job that finishes early is held until every lower-indexed job has settled,
 * then delivered — so consumers see a deterministic sequence even under
 * parallel, out-of-order completion.
 *
 * This is the one shared implementation used by both the PDF asset pipeline
 * (`packages/pdf/src/prepare.ts`, deterministic asset paths) and the export
 * tree body-fetch pool (`packages/confluence/src/tree-fetch.ts`, pre-order
 * result slots). Isomorphic: no `node:`/`bun:` specifiers — only Promise/Map.
 */
export function createInOrderLimiter(
  limit: number
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  let issued = 0;
  let nextToDeliver = 0;
  const queue: Array<{
    index: number;
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const finished = new Map<
    number,
    { ok: true; value: unknown } | { ok: false; reason: unknown }
  >();

  const flush = (): void => {
    while (finished.has(nextToDeliver)) {
      const result = finished.get(nextToDeliver)!;
      finished.delete(nextToDeliver);
      const item = delivered.get(nextToDeliver)!;
      delivered.delete(nextToDeliver);
      if (result.ok) item.resolve(result.value);
      else item.reject(result.reason);
      nextToDeliver += 1;
    }
  };
  const delivered = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const next = (): void => {
    while (active < limit) {
      const item = queue.shift();
      if (!item) return;
      active += 1;
      void item
        .task()
        .then(
          (value) => finished.set(item.index, { ok: true, value }),
          (reason) => finished.set(item.index, { ok: false, reason })
        )
        .finally(() => {
          active -= 1;
          flush();
          next();
        });
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const index = issued;
      issued += 1;
      delivered.set(index, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      queue.push({ index, task, resolve: resolve as (value: unknown) => void, reject });
      next();
    });
}
