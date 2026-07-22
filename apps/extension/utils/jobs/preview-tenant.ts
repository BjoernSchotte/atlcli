/**
 * The preview cache, seen as a tenant of the shared byte budget (spec 010 T5.6).
 *
 * `PDF_STORE_MAX_BYTES` is one budget with two occupants (see the eviction
 * policy in `utils/pdf/job-store.ts`). The preview cache lives in its own
 * database — `atlcli-pdf-preview`, because its schema must not ride the job
 * store's migrations — which means the job store cannot see it without an
 * adapter. This is that adapter, and it is deliberately the *only* place that
 * knows both databases exist.
 *
 * It reaches the preview database through `preview-cache.ts`'s own exported
 * `openPreviewCacheDb`/`clearPreview`, and it discovers the store to read by
 * enumerating `objectStoreNames` rather than hard-coding one: duplicating the
 * store name here would be a second source of truth for someone else's schema,
 * and the read is a single-slot row either way.
 *
 * Everything is best-effort. A preview cache that cannot be read is reported as
 * holding nothing, which makes the job store's admission control slightly
 * conservative — never wrong in the direction that loses a user's export.
 */
import { clearPreview, openPreviewCacheDb } from "../pdf/preview-cache.js";
import type { BudgetEntry } from "./model.js";

/** Stable id under which the whole (single-slot) preview cache is evicted. */
export const PREVIEW_CACHE_BUDGET_ID = "preview-cache";

export interface PreviewCacheTenant {
  inventory(): Promise<readonly BudgetEntry[]>;
  evict(id: string): Promise<void>;
}

interface CachedRowShape {
  byteLength?: unknown;
  createdAt?: unknown;
}

function readAllRows(db: IDBDatabase): Promise<CachedRowShape[]> {
  const names = [...db.objectStoreNames];
  if (names.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, "readonly");
    const rows: CachedRowShape[] = [];
    for (const name of names) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => rows.push(...(request.result as CachedRowShape[]));
    }
    tx.oncomplete = () => resolve(rows);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

export function previewCacheTenant(factory?: IDBFactory): PreviewCacheTenant {
  return {
    async inventory(): Promise<readonly BudgetEntry[]> {
      let db: IDBDatabase | undefined;
      try {
        db = await openPreviewCacheDb(factory);
        const rows = await readAllRows(db);
        const bytes = rows.reduce(
          (sum, row) => sum + (typeof row.byteLength === "number" ? row.byteLength : 0),
          0
        );
        if (bytes === 0) return [];
        const createdAt = rows.reduce(
          (oldest, row) =>
            typeof row.createdAt === "number" ? Math.min(oldest, row.createdAt) : oldest,
          Number.POSITIVE_INFINITY
        );
        return [
          {
            id: PREVIEW_CACHE_BUDGET_ID,
            tenant: "preview-cache",
            bytes,
            createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
            status: "cached",
            kind: "preview",
            consumed: false,
          },
        ];
      } catch {
        return [];
      } finally {
        db?.close();
      }
    },

    async evict(id: string): Promise<void> {
      if (id !== PREVIEW_CACHE_BUDGET_ID) return;
      await clearPreview(factory).catch(() => undefined);
    },
  };
}
