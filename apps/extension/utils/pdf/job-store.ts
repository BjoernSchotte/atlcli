/**
 * Durable PDF job store (spec 010, T5.6).
 *
 * IndexedDB is the **byte channel** for PDF export: compiled documents and
 * source bundles never cross `chrome.runtime.sendMessage`, which carries only
 * `{ kind, jobId }` (`compile-port.ts`, `background.ts`, `compiler-host.ts`).
 * That invariant is load-bearing and predates this module comment; nothing here
 * may weaken it.
 *
 * ## Why three stores instead of one
 *
 * Every record used to be one row holding its status *and* its full source
 * bundle *and* its compiled PDF. Two consequences, both measured
 * (`packages/pdf/scripts/bytes-memory.bench.ts`, Bun 1.3.8 / JSC, arm64):
 *
 *   - **`store.getAll()` as a quota check.** `putPdfJob` and `completePdfJob`
 *     deserialized the entire store — every bundle, every asset, every finished
 *     PDF — to add two numbers against `PDF_STORE_MAX_BYTES`. With 8 jobs of
 *     8 MiB seeded, that check cost **+64.0 MiB of live heap**; the same total
 *     read from a numbers-only record cost **+0.0 MiB**. The guard meant to
 *     protect memory was the largest allocator in the store.
 *   - **A status field rewrote the whole payload.** `claimPdfJob` read the
 *     record and `put()` it back to set `status: "compiling"`. For a job with a
 *     32 MiB bundle that read-modify-write cost **+64.0 MiB** (one copy in, one
 *     copy out); writing a separate status record cost **+0.0 MiB**.
 *
 * So the volatile part and the immutable parts now live apart:
 *
 *   - `jobs`     — {@link StoredPdfJobMeta}: status, timestamps, byte *counts*,
 *                  diagnostics. Small, rewritten on every transition.
 *   - `bundles`  — `{ id, bundle }`: the source bundle. Written once at
 *                  `putPdfJob`, never rewritten, deleted on release.
 *   - `results`  — `{ id, pdf }`: the compiled document. Written once at
 *                  `completePdfJob`, never rewritten.
 *
 * Quota enforcement reads `jobs` only. A status transition writes `jobs` only.
 * No operation ever reads a payload store to compute a size.
 *
 * ## Why the cap VALUES did not change
 *
 * `PDF_JOB_MAX_BYTES` (64 MiB) and `PDF_STORE_MAX_BYTES` (128 MiB) are
 * unchanged, deliberately. They are a policy about how much of a user's disk
 * quota one site's exports may hold, and nothing measured says that policy is
 * wrong — what was wrong was *how* the total was computed. T5.6's brief is to
 * change the computation, not the policy; moving both at once would make it
 * impossible to tell which change caused a later regression.
 *
 * ## Dedupe lives in exactly one place, and it is not here
 *
 * Asset deduplication is `preparePdfDocument`'s job
 * (`packages/pdf/src/prepare.ts`): it hashes each asset, compares bytes
 * exactly, and — critically — **rewrites every reference to the canonical
 * path**. This store measures and caps the already-deduped bundle it is handed
 * and must never run a second, independent dedupe pass: dropping a byte-
 * identical asset here would not rewrite anything, leaving the compiler VFS
 * with a dangling asset path. Asserted in `tests/pdf/job-store.test.ts`.
 *
 * ## Shared budget (informative — the eviction policy is T5.3's to land)
 *
 * `PDF_STORE_MAX_BYTES` is a *single* budget that the preview cache (T5.3) and
 * retained background jobs (T5.6) will both draw on. They are not equally
 * evictable: a preview is a cache and may be dropped at any time, whereas a
 * finished-but-unconsumed export job is the user's only copy of work they
 * waited for and may only be dropped by age (`PDF_JOB_MAX_AGE_MS`) or by an
 * explicit dismissal. Any eviction policy added here must respect that
 * asymmetry rather than evicting by size or recency alone.
 */
import type { PdfCompilerDiagnostic, PdfSourceBundle } from "@atlcli/pdf/browser";

const DB_NAME = "atlcli-pdf";
/**
 * v2 splits the single `jobs` store into meta + two payload stores. The upgrade
 * DISCARDS any v1 records rather than migrating them: a job is a transient
 * artifact of one export attempt with a 24 h lifetime
 * ({@link PDF_JOB_MAX_AGE_MS}), so the worst case is that an export in flight
 * across an extension update is re-run.
 */
const DB_VERSION = 2;
const META_STORE = "jobs";
const BUNDLE_STORE = "bundles";
const RESULT_STORE = "results";
const ALL_STORES = [META_STORE, BUNDLE_STORE, RESULT_STORE] as const;

export const PDF_JOB_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_STORE_MAX_BYTES = 128 * 1024 * 1024;
export const PDF_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PdfJobStatus = "prepared" | "compiling" | "complete" | "failed" | "cancelled";

/**
 * The volatile record: everything a status transition touches, and nothing
 * else. Sized so that reading every one of them to enforce the store quota
 * costs no measurable memory.
 */
export interface StoredPdfJobMeta {
  id: string;
  sourceIdentity: string;
  createdAt: number;
  status: PdfJobStatus;
  /** Bytes held by this job's source bundle. Zero once the bundle is released. */
  inputBytes: number;
  /** Bytes held by this job's compiled result. Zero until it completes. */
  outputBytes: number;
  diagnostics?: PdfCompilerDiagnostic[];
  compilerVersion?: string;
  error?: string;
}

/** A job with whichever payloads the caller asked for (and that still exist). */
export interface StoredPdfJob extends StoredPdfJobMeta {
  bundle?: PdfSourceBundle;
  pdf?: Uint8Array;
}

/**
 * A job whose source bundle is present — what a compiler worker needs.
 * {@link claimPdfJob} returns this or nothing, so a caller never has to prove
 * the bundle survived.
 */
export interface ClaimedPdfJob extends StoredPdfJobMeta {
  bundle: PdfSourceBundle;
}

/** Which payloads {@link getPdfJob} should join onto the meta record. */
export interface PdfJobReadOptions {
  /** Load the source bundle (default `true`). */
  bundle?: boolean;
  /** Load the compiled result (default `true`). */
  pdf?: boolean;
}

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const value = factory ?? globalThis.indexedDB;
  if (!value) throw new Error("IndexedDB is unavailable for PDF export.");
  return value;
}

export function isPdfJobId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createPdfJobId(randomUUID: () => string = () => crypto.randomUUID()): string {
  const id = randomUUID();
  if (!isPdfJobId(id)) throw new Error("PDF job id generator returned an invalid UUID.");
  return id;
}

/**
 * Size of a bundle, measured ONCE on the way in and then carried as a number.
 *
 * This walks the assets to add byte lengths; it deliberately does NOT hash them
 * or compare them. `preparePdfDocument` already deduplicated this bundle and
 * rewrote its references — see the module comment.
 */
function sourceBundleBytes(bundle: PdfSourceBundle): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(bundle.main).byteLength +
    encoder.encode(bundle.template).byteLength +
    bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0)
  );
}

/** Bytes one job holds, from its meta record alone — no payload read. */
function storedJobBytes(meta: StoredPdfJobMeta): number {
  return meta.inputBytes + meta.outputBytes;
}

/**
 * A structural snapshot of the caller's bundle, taken synchronously on entry to
 * {@link putPdfJob}.
 *
 * `putPdfJob` measures the bundle, then `await`s an IndexedDB open, and only
 * *then* does the `add()` whose structured clone is what actually gets stored.
 * `PdfSourceBundle` is a plain mutable object (`packages/pdf/src/types.ts`), so
 * everything the caller does to it in that window used to land in the store
 * without ever being measured:
 *
 *   - appending assets made the meta record claim 3 bytes for 1025 stored, so
 *     `PDF_STORE_MAX_BYTES` was enforced against a number that bore no relation
 *     to the disk quota actually consumed;
 *   - the same trick walked a bundle straight past `PDF_JOB_MAX_BYTES`;
 *   - swapping `main` or an asset `path` made the compiler consume content
 *     other than what the caps were checked against.
 *
 * Copying the container closes all three: from here on nothing reads the
 * caller's object again, so the bytes that were measured are the bytes that get
 * cloned into IndexedDB.
 *
 * Asset BYTES are referenced, not copied. A `Uint8Array`'s `byteLength` is
 * fixed for the life of the view, so a shared reference cannot grow past a cap
 * the way a mutable container can — and copying up to 64 MiB here to prove a
 * point would reintroduce exactly the allocation T5.6 exists to remove. The
 * one case a fixed `byteLength` does not cover is a view onto a *resizable*
 * `ArrayBuffer`; the re-measure inside the write transaction covers that.
 */
function snapshotSourceBundle(bundle: PdfSourceBundle): PdfSourceBundle {
  return {
    ...bundle,
    assets: bundle.assets.map((asset) => ({ ...asset })),
    sourceMap: [...bundle.sourceMap],
    notes: [...bundle.notes],
  };
}

export function openPdfJobDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1's `jobs` store held payloads inline and cannot be read as meta, so it
      // is dropped rather than migrated (see DB_VERSION).
      if (db.objectStoreNames.contains(META_STORE)) db.deleteObjectStore(META_STORE);
      const meta = db.createObjectStore(META_STORE, { keyPath: "id" });
      meta.createIndex("createdAt", "createdAt");
      for (const name of [BUNDLE_STORE, RESULT_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open PDF job database."));
  });
}

function transaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  run: (
    stores: Record<string, IDBObjectStore>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void
  ) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores as string[], mode);
    let value: T;
    let hasValue = false;
    const finish = (result: T): void => {
      value = result;
      hasValue = true;
    };
    try {
      const handles: Record<string, IDBObjectStore> = {};
      for (const name of stores) handles[name] = tx.objectStore(name);
      run(handles, finish, reject);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      if (!hasValue) reject(new Error("PDF job transaction completed without a result."));
      else resolve(value!);
    };
    tx.onabort = () => reject(tx.error ?? new Error("PDF job transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("PDF job transaction failed."));
  });
}

async function withDb<T>(factory: IDBFactory | undefined, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openPdfJobDb(factory);
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

export async function putPdfJob(
  input: { id: string; sourceIdentity: string; bundle: PdfSourceBundle; createdAt?: number },
  factory?: IDBFactory
): Promise<StoredPdfJob> {
  if (!isPdfJobId(input.id)) throw new Error("Invalid PDF job id.");
  // Snapshot BEFORE measuring — see snapshotSourceBundle. Everything below
  // reads `bundle`, never `input.bundle`.
  const bundle = snapshotSourceBundle(input.bundle);
  const inputBytes = sourceBundleBytes(bundle);
  if (inputBytes > PDF_JOB_MAX_BYTES) {
    throw new Error(`PDF export input exceeds the ${PDF_JOB_MAX_BYTES} byte job limit.`);
  }
  const meta: StoredPdfJobMeta = {
    id: input.id,
    sourceIdentity: input.sourceIdentity,
    createdAt: input.createdAt ?? Date.now(),
    status: "prepared",
    inputBytes,
    outputBytes: 0,
  };
  return withDb(factory, (db) =>
    transaction<StoredPdfJob>(db, [META_STORE, BUNDLE_STORE], "readwrite", (stores, done, reject) => {
      // Quota from the META store only: numbers, never payloads.
      const inventory = stores[META_STORE]!.getAll();
      inventory.onerror = () => reject(inventory.error);
      inventory.onsuccess = () => {
        const total = (inventory.result as StoredPdfJobMeta[]).reduce(
          (sum, stored) => sum + storedJobBytes(stored),
          0
        );
        if (total + inputBytes > PDF_STORE_MAX_BYTES) {
          reject(new Error("PDF export storage exceeds the 128 MB total quota."));
          return;
        }
        // Re-measure in the SAME synchronous turn as the `add()` below. IndexedDB
        // structured-clones at the moment `add()` is called, and a single JS turn
        // cannot be interleaved, so agreeing here proves the number written to
        // the meta record describes the bytes written to the payload store — the
        // one thing a snapshot alone cannot prove for a view onto a resizable
        // ArrayBuffer.
        if (sourceBundleBytes(bundle) !== inputBytes) {
          reject(new Error("PDF export input changed size while it was being stored."));
          return;
        }
        const addMeta = stores[META_STORE]!.add(meta);
        addMeta.onerror = () => reject(addMeta.error ?? new Error("Failed to store PDF job."));
        addMeta.onsuccess = () => {
          const addBundle = stores[BUNDLE_STORE]!.add({ id: input.id, bundle });
          addBundle.onsuccess = () => done({ ...meta, bundle });
          addBundle.onerror = () =>
            reject(addBundle.error ?? new Error("Failed to store PDF job bundle."));
        };
      };
    })
  );
}

/** The small record alone — the cheap read, and what quota logic uses. */
export function getPdfJobMeta(id: string, factory?: IDBFactory): Promise<StoredPdfJobMeta | undefined> {
  return withDb(factory, (db) =>
    transaction<StoredPdfJobMeta | undefined>(db, [META_STORE], "readonly", (stores, done, reject) => {
      const request = stores[META_STORE]!.get(id);
      request.onsuccess = () => done(request.result as StoredPdfJobMeta | undefined);
      request.onerror = () => reject(request.error);
    })
  );
}

export function getPdfJob(
  id: string,
  factory?: IDBFactory,
  options: PdfJobReadOptions = {}
): Promise<StoredPdfJob | undefined> {
  const wantBundle = options.bundle ?? true;
  const wantPdf = options.pdf ?? true;
  const stores = [
    META_STORE,
    ...(wantBundle ? [BUNDLE_STORE] : []),
    ...(wantPdf ? [RESULT_STORE] : []),
  ];
  return withDb(factory, (db) =>
    transaction<StoredPdfJob | undefined>(db, stores, "readonly", (handles, done, reject) => {
      const request = handles[META_STORE]!.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const meta = request.result as StoredPdfJobMeta | undefined;
        if (!meta) {
          done(undefined);
          return;
        }
        const job: StoredPdfJob = { ...meta };
        let pending = 0;
        const settle = (): void => {
          if (pending === 0) done(job);
        };
        if (wantBundle) {
          pending += 1;
          const bundle = handles[BUNDLE_STORE]!.get(id);
          bundle.onerror = () => reject(bundle.error);
          bundle.onsuccess = () => {
            const row = bundle.result as { bundle: PdfSourceBundle } | undefined;
            if (row) job.bundle = row.bundle;
            pending -= 1;
            settle();
          };
        }
        if (wantPdf) {
          pending += 1;
          const result = handles[RESULT_STORE]!.get(id);
          result.onerror = () => reject(result.error);
          result.onsuccess = () => {
            const row = result.result as { pdf: Uint8Array } | undefined;
            if (row) job.pdf = row.pdf;
            pending -= 1;
            settle();
          };
        }
        settle();
      };
    })
  );
}

/**
 * Take ownership of a `prepared` job for compiling.
 *
 * The status write touches the META store only — the bundle is *read* (the
 * compiler needs it) but never written back. That read-modify-**write** of the
 * payload was measured at +64.0 MiB for a 32 MiB bundle; it is gone.
 *
 * Returns nothing when the job is absent or its bundle has been released, so a
 * caller never receives a claim it cannot compile.
 */
export function claimPdfJob(id: string, factory?: IDBFactory): Promise<ClaimedPdfJob | undefined> {
  return withDb(factory, (db) =>
    transaction<ClaimedPdfJob | undefined>(
      db,
      [META_STORE, BUNDLE_STORE],
      "readwrite",
      (stores, done, reject) => {
        const request = stores[META_STORE]!.get(id);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const current = request.result as StoredPdfJobMeta | undefined;
          if (!current) {
            done(undefined);
            return;
          }
          const bundleRequest = stores[BUNDLE_STORE]!.get(id);
          bundleRequest.onerror = () => reject(bundleRequest.error);
          bundleRequest.onsuccess = () => {
            const row = bundleRequest.result as { bundle: PdfSourceBundle } | undefined;
            if (!row) {
              // Released (cancelled, cleaned up) — nothing left to compile.
              done(undefined);
              return;
            }
            if (current.status !== "prepared") {
              // Not ours to claim; hand back the current state unchanged so the
              // caller can report *why*, without writing anything.
              done({ ...current, bundle: row.bundle });
              return;
            }
            const next: StoredPdfJobMeta = { ...current, status: "compiling" };
            const write = stores[META_STORE]!.put(next);
            write.onerror = () => reject(write.error);
            write.onsuccess = () => done({ ...next, bundle: row.bundle });
          };
        };
      }
    )
  );
}

export async function completePdfJob(
  id: string,
  output: { pdf: Uint8Array; diagnostics: PdfCompilerDiagnostic[]; compilerVersion: string },
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  if (output.pdf.byteLength > PDF_JOB_MAX_BYTES) {
    throw new Error(`PDF result exceeds the ${PDF_JOB_MAX_BYTES} byte job limit.`);
  }
  return withDb(factory, (db) =>
    transaction<StoredPdfJobMeta | undefined>(
      db,
      [META_STORE, RESULT_STORE],
      "readwrite",
      (stores, done, reject) => {
        // Quota over meta records; the bundle store is not even in this
        // transaction, so completing a job cannot re-serialize a single asset.
        const inventory = stores[META_STORE]!.getAll();
        inventory.onerror = () => reject(inventory.error);
        inventory.onsuccess = () => {
          const all = inventory.result as StoredPdfJobMeta[];
          const current = all.find((meta) => meta.id === id);
          if (!current || current.status !== "compiling") {
            done(current);
            return;
          }
          const total = all.reduce((sum, meta) => sum + storedJobBytes(meta), 0);
          if (total + output.pdf.byteLength > PDF_STORE_MAX_BYTES) {
            reject(new Error("PDF export storage exceeds the 128 MB total quota."));
            return;
          }
          const next: StoredPdfJobMeta = {
            ...current,
            status: "complete",
            outputBytes: output.pdf.byteLength,
            diagnostics: output.diagnostics,
            compilerVersion: output.compilerVersion,
          };
          const addResult = stores[RESULT_STORE]!.put({ id, pdf: output.pdf });
          addResult.onerror = () => reject(addResult.error);
          addResult.onsuccess = () => {
            const write = stores[META_STORE]!.put(next);
            write.onsuccess = () => done(next);
            write.onerror = () => reject(write.error);
          };
        };
      }
    )
  );
}

/** Meta-only status transition. Never opens a payload store. */
function updateMeta(
  id: string,
  update: (meta: StoredPdfJobMeta) => StoredPdfJobMeta | null,
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  return withDb(factory, (db) =>
    transaction<StoredPdfJobMeta | undefined>(db, [META_STORE], "readwrite", (stores, done, reject) => {
      const request = stores[META_STORE]!.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result as StoredPdfJobMeta | undefined;
        if (!current) {
          done(undefined);
          return;
        }
        const next = update(current);
        if (!next) {
          done(current);
          return;
        }
        const write = stores[META_STORE]!.put(next);
        write.onsuccess = () => done(next);
        write.onerror = () => reject(write.error);
      };
    })
  );
}

export function failPdfJob(
  id: string,
  error: string,
  diagnostics: PdfCompilerDiagnostic[] = [],
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  return updateMeta(id, (meta) =>
    meta.status === "prepared" || meta.status === "compiling"
      ? { ...meta, status: "failed", error, diagnostics }
      : null, factory
  );
}

/**
 * Cancel a job and **release its bundle**.
 *
 * Setting a status was not enough: a panel closed mid-export used to leave a
 * `cancelled` record still holding the full source bundle against
 * `PDF_STORE_MAX_BYTES` until the 24 h sweep. Cancelling now deletes both
 * payload rows and zeroes the byte counts, so the quota reflects the release
 * immediately. The meta record survives on purpose — the re-attach UI needs to
 * tell "cancelled" apart from "never existed".
 */
export function cancelPdfJob(id: string, factory?: IDBFactory): Promise<StoredPdfJobMeta | undefined> {
  return withDb(factory, (db) =>
    transaction<StoredPdfJobMeta | undefined>(db, ALL_STORES, "readwrite", (stores, done, reject) => {
      const request = stores[META_STORE]!.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result as StoredPdfJobMeta | undefined;
        if (!current) {
          done(undefined);
          return;
        }
        if (current.status === "complete" || current.status === "failed") {
          done(current);
          return;
        }
        const next: StoredPdfJobMeta = {
          ...current,
          status: "cancelled",
          error: "PDF export was cancelled.",
          inputBytes: 0,
          outputBytes: 0,
        };
        stores[BUNDLE_STORE]!.delete(id);
        stores[RESULT_STORE]!.delete(id);
        const write = stores[META_STORE]!.put(next);
        write.onsuccess = () => done(next);
        write.onerror = () => reject(write.error);
      };
    })
  );
}

export async function deletePdfJob(id: string, factory?: IDBFactory): Promise<void> {
  await withDb(factory, (db) =>
    transaction<undefined>(db, ALL_STORES, "readwrite", (stores, done, reject) => {
      stores[BUNDLE_STORE]!.delete(id);
      stores[RESULT_STORE]!.delete(id);
      const request = stores[META_STORE]!.delete(id);
      request.onsuccess = () => done(undefined);
      request.onerror = () => reject(request.error);
    })
  );
}

export async function cleanupPdfJobs(
  options: { now?: number; maxAgeMs?: number } = {},
  factory?: IDBFactory
): Promise<number> {
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? PDF_JOB_MAX_AGE_MS);
  return withDb(factory, (db) =>
    transaction<number>(db, ALL_STORES, "readwrite", (stores, done, reject) => {
      let deleted = 0;
      // A KEY cursor over the createdAt index: expiry needs ids and timestamps,
      // never payloads, so no record is materialized to decide it.
      const request = stores[META_STORE]!
        .index("createdAt")
        .openKeyCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(deleted);
          return;
        }
        const id = cursor.primaryKey as string;
        stores[META_STORE]!.delete(id);
        stores[BUNDLE_STORE]!.delete(id);
        stores[RESULT_STORE]!.delete(id);
        deleted += 1;
        cursor.continue();
      };
    })
  );
}
