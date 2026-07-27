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
 * ## One budget, one eviction policy (T5.6)
 *
 * `PDF_STORE_MAX_BYTES` is a *single* budget with two tenants: the preview cache
 * (T5.3, physically the separate `atlcli-pdf-preview` database) and retained
 * background job records. Letting each feature enforce its own ceiling would
 * mean two features independently filling one disk quota, and the loser would
 * always be whichever wrote second.
 *
 * So admission control ({@link putPdfJob}, {@link completePdfJob}) plans over
 * **both** tenants through {@link planStoreEviction}, in this order — cheapest
 * loss first:
 *
 *   0. anything past `PDF_JOB_MAX_AGE_MS` — garbage under every policy;
 *   1. **the preview cache** — a cache, rebuilt in one debounce;
 *   2. spent job records — cancelled, failed, or complete-and-consumed;
 *   3. preview *job* records — regenerable like the cache;
 *   ∅. a running export, or a finished export nobody has collected yet:
 *      **never evicted**. It is the only copy of work the user waited minutes
 *      for, so a new export is refused rather than served by destroying it.
 *
 * Rule ∅ is the reason the policy is not "drop the biggest" or "drop the
 * oldest": both would happily trade a finished 40 MiB space export for a 2 MiB
 * preview. The cross-database half is reached through an injectable
 * {@link SharedBudgetTenants} port whose default lazily imports
 * `utils/jobs/preview-tenant.js` — lazily, because a static import would close
 * the cycle `job-store → preview-tenant → preview-cache → job-store`.
 *
 * ## Terminal cleanup belongs to whoever outlives the panel
 *
 * `deletePdfJob` used to run from `compile-port.ts`'s `finally` — in the panel,
 * i.e. exactly the context a background export is defined by *not* having. A
 * closed panel therefore left a record holding a full bundle until the 24 h
 * sweep. Now: reaching a terminal state **releases the source bundle**
 * ({@link completePdfJob}, {@link failPdfJob}, {@link cancelPdfJob}) from the
 * worker/offscreen side, which survives the panel; the panel may delete a whole
 * record only once it has consumed the result ({@link markPdfJobConsumed}); and
 * {@link sweepPdfJobs} is the backstop that fails a job whose worker never
 * answered and deletes what nobody is coming back for.
 */
import type { PdfCompilerDiagnostic, PdfSourceBundle } from "@atlcli/pdf/browser";
import type { PdfJobKind } from "../messages.js";
import {
  isPdfJobInFlight,
  planSweep,
  planStoreEviction,
  type BudgetEntry,
  type SweepAction,
} from "../jobs/model.js";

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

// Benchmark-only cap seam (issue #118 Phase 0), mirroring the prepare-side
// `atlcli.pdf.benchmark-asset-budget` hook: the ≥100 MiB image-heavy corpus
// must flow through this REAL store inside the Chrome memory harness, and the
// product caps must not gain a public override to make that possible. Only a
// benchmark harness installs the Symbol on globalThis (page AND compiler
// worker); release code has no path to it.
const BENCHMARK_PDF_JOB_LIMITS = Symbol.for("atlcli.extension.benchmark-pdf-job-limits");

interface BenchmarkPdfJobLimitsOverride {
  jobMaxBytes?: number;
  storeMaxBytes?: number;
}

interface BenchmarkPdfJobLimitsHost {
  [BENCHMARK_PDF_JOB_LIMITS]?: BenchmarkPdfJobLimitsOverride;
}

function pdfJobLimits(): { jobMaxBytes: number; storeMaxBytes: number } {
  const override = (globalThis as BenchmarkPdfJobLimitsHost)[BENCHMARK_PDF_JOB_LIMITS];
  return {
    jobMaxBytes: override?.jobMaxBytes ?? PDF_JOB_MAX_BYTES,
    storeMaxBytes: override?.storeMaxBytes ?? PDF_STORE_MAX_BYTES,
  };
}

/**
 * Job lifecycle.
 *
 * `"prepared"` is the plan's **queued**: stored, compile requested, no worker
 * has claimed it. The panel already renders it as the `queued` export phase.
 * The literal is kept because it is what lives in `atlcli-pdf` today and what
 * `workers/pdf-compiler.ts` compares against; `isPdfJobInFlight` is the name to
 * reason with, so no caller has to remember the spelling.
 */
export type PdfJobStatus = "prepared" | "compiling" | "complete" | "failed" | "cancelled";

/** "Page 37 of 210" — the only progress a caller can report before compiling. */
export interface PdfJobProgress {
  done: number;
  total: number;
}

/**
 * The volatile record: everything a status transition touches, and nothing
 * else. Sized so that reading every one of them to enforce the store quota
 * costs no measurable memory.
 *
 * Everything added for T5.6 is **optional**, so a record written by the previous
 * build (jobs live at most 24 h, so both can coexist across an update) still
 * reads back cleanly with sane defaults rather than forcing a schema version
 * bump and discarding an export in flight.
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

  // --- durability metadata (T5.6) ------------------------------------------
  /**
   * Scheduling class. Only `"export"` jobs are durable; a preview is panel-owned
   * and swept as soon as it is terminal. Absent → `"export"` (the conservative
   * reading of a record written before this field existed).
   */
  kind?: PdfJobKind;
  /** Atlassian site the job belongs to, so the Jobs list stays per-site. */
  siteOrigin?: string;
  /** Document title, for the job row. */
  title?: string;
  /** What the download will be called. */
  filename?: string;
  /** Human-readable scope ("Page", "Tree · 37 pages"). */
  scopeLabel?: string;
  /** Compile progress, when the caller can report one. */
  progress?: PdfJobProgress;
  /** Last transition — job age in the UI is measured from `createdAt`, staleness from here. */
  updatedAt?: number;
  /**
   * Wall clock after which an unfinished job is declared failed.
   *
   * The watchdog for the case durability exists for: a service worker torn down
   * mid-compile drops the `sendMessage` response, and without a deadline the
   * record would read `compiling` until the 24 h sweep with nobody to answer it.
   */
  deadlineAt?: number;
  /** True once the panel has handed these bytes to the user. */
  consumed?: boolean;
  /** Hidden compiler subrecords belong to a common outer job and never become Activity rows. */
  activityVisibility?: "visible" | "private";
  /** Common outer job owning a private transition-period compiler record. */
  parentJobId?: string;
  /** Fencing epoch of the outer job that created this compiler record. */
  parentLeaseEpoch?: number;
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

function isOpaqueExportJobId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096;
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
 * The other tenant of {@link PDF_STORE_MAX_BYTES}: the preview cache.
 *
 * A port rather than an import, so this module keeps no knowledge of the preview
 * database and the two can be tested apart. The default implementation is loaded
 * lazily (see the module comment on the import cycle).
 */
export interface SharedBudgetTenants {
  /** What the other tenants currently hold. */
  inventory(): Promise<readonly BudgetEntry[]>;
  /** Drop one entry `inventory()` reported. Best-effort. */
  evict(id: string): Promise<void>;
}

const lazyPreviewTenants: SharedBudgetTenants = {
  async inventory() {
    const module = await import("../jobs/preview-tenant.js");
    return module.previewCacheTenant().inventory();
  },
  async evict(id) {
    const module = await import("../jobs/preview-tenant.js");
    await module.previewCacheTenant().evict(id);
  },
};

let sharedTenants: SharedBudgetTenants = lazyPreviewTenants;

/**
 * Replace the co-tenant view of the shared budget (tests, and a host that has no
 * preview cache). Returns a restore function.
 */
export function setSharedBudgetTenants(tenants: SharedBudgetTenants): () => void {
  const previous = sharedTenants;
  sharedTenants = tenants;
  return () => {
    sharedTenants = previous;
  };
}

/** Map a meta record onto the shared budget's structural entry. */
function budgetEntryOf(meta: StoredPdfJobMeta): BudgetEntry {
  return {
    id: meta.id,
    tenant: "job",
    bytes: storedJobBytes(meta),
    createdAt: meta.createdAt,
    status: meta.status,
    kind: meta.kind ?? "export",
    consumed: meta.consumed === true,
  };
}

/**
 * Make room for `incomingBytes` across **both** tenants, before any write
 * transaction opens.
 *
 * Deliberately outside the transaction: IndexedDB transactions cannot span an
 * `await`, and the preview cache is a different database entirely. The write
 * path re-checks the quota inside its own transaction afterwards, so a
 * concurrent writer that ate the space we just freed still gets a clean
 * rejection rather than an overdrawn store.
 */
async function makeRoomFor(
  incomingBytes: number,
  factory: IDBFactory | undefined,
  now: number
): Promise<void> {
  const jobs = (await listPdfJobMeta(factory)).map(budgetEntryOf);
  const others = await sharedTenants.inventory().catch(() => [] as readonly BudgetEntry[]);
  const plan = planStoreEviction([...jobs, ...others], incomingBytes, {
    limit: pdfJobLimits().storeMaxBytes,
    now,
    maxAgeMs: PDF_JOB_MAX_AGE_MS,
  });
  for (const entry of plan.evict) {
    if (entry.tenant === "job") await deletePdfJob(entry.id, factory).catch(() => undefined);
    else await sharedTenants.evict(entry.id).catch(() => undefined);
  }
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

/** Everything a caller may record about a job when it is stored. */
export interface PutPdfJobInput {
  id: string;
  sourceIdentity: string;
  bundle: PdfSourceBundle;
  createdAt?: number;
  kind?: PdfJobKind;
  siteOrigin?: string;
  title?: string;
  filename?: string;
  scopeLabel?: string;
  deadlineAt?: number;
  progress?: PdfJobProgress;
  activityVisibility?: "visible" | "private";
  parentJobId?: string;
  parentLeaseEpoch?: number;
}

export async function putPdfJob(
  input: PutPdfJobInput,
  factory?: IDBFactory
): Promise<StoredPdfJob> {
  if (!isPdfJobId(input.id)) throw new Error("Invalid PDF job id.");
  if (input.activityVisibility === "private") {
    if (!isOpaqueExportJobId(input.parentJobId)) {
      throw new Error("Private PDF compiler jobs require a valid parent job id.");
    }
    if (!Number.isSafeInteger(input.parentLeaseEpoch) || input.parentLeaseEpoch! < 1) {
      throw new Error("Private PDF compiler jobs require a positive parent lease epoch.");
    }
  } else if (input.parentJobId !== undefined || input.parentLeaseEpoch !== undefined) {
    throw new Error("Only private PDF compiler jobs may reference an outer job.");
  }
  // Snapshot BEFORE measuring — see snapshotSourceBundle. Everything below
  // reads `bundle`, never `input.bundle`.
  const bundle = snapshotSourceBundle(input.bundle);
  const inputBytes = sourceBundleBytes(bundle);
  const limits = pdfJobLimits();
  if (inputBytes > limits.jobMaxBytes) {
    throw new Error(`PDF export input exceeds the ${limits.jobMaxBytes} byte job limit.`);
  }
  const createdAt = input.createdAt ?? Date.now();
  const meta: StoredPdfJobMeta = {
    id: input.id,
    sourceIdentity: input.sourceIdentity,
    createdAt,
    status: "prepared",
    inputBytes,
    outputBytes: 0,
    kind: input.kind ?? "export",
    updatedAt: createdAt,
    ...(input.siteOrigin === undefined ? {} : { siteOrigin: input.siteOrigin }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.activityVisibility === undefined ? {} : { activityVisibility: input.activityVisibility }),
    ...(input.parentJobId === undefined ? {} : { parentJobId: input.parentJobId }),
    ...(input.parentLeaseEpoch === undefined ? {} : { parentLeaseEpoch: input.parentLeaseEpoch }),
  };
  // Admission control across BOTH tenants of the shared budget, before the write
  // transaction opens (see the module comment).
  await makeRoomFor(inputBytes, factory, createdAt);
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
        if (total + inputBytes > limits.storeMaxBytes) {
          reject(new Error(`PDF export storage exceeds the ${limits.storeMaxBytes} byte total quota.`));
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

/**
 * Every meta record — the durable source of truth the panel re-attaches to.
 *
 * Cheap by construction: the meta store holds numbers and short strings only,
 * measured at +0.0 MiB for a store whose payloads total 64 MiB. That is what
 * makes "read the whole inventory" an acceptable primitive for the Jobs list,
 * the quota check and the sweep alike.
 */
export function listPdfJobMeta(factory?: IDBFactory): Promise<StoredPdfJobMeta[]> {
  return withDb(factory, (db) =>
    transaction<StoredPdfJobMeta[]>(db, [META_STORE], "readonly", (stores, done, reject) => {
      const request = stores[META_STORE]!.getAll();
      request.onsuccess = () => done(request.result as StoredPdfJobMeta[]);
      request.onerror = () => reject(request.error);
    })
  );
}

/**
 * How many jobs a compiler still owns, **from the durable records**.
 *
 * This is what replaces `background.ts#activePdfJobs`. That counter was a plain
 * in-memory `let` that reset to `0` on every service-worker restart, so a
 * restart mid-compile let the *next* job's completion arm the offscreen idle
 * timer under a job that was still running — and five minutes later the idle
 * close tore down the offscreen document, killing it. The records survive the
 * restart; the counter did not.
 */
export async function countInFlightPdfJobs(factory?: IDBFactory): Promise<number> {
  const all = await listPdfJobMeta(factory);
  return all.filter((meta) => isPdfJobInFlight(meta.status)).length;
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
          if (current.status !== "prepared") {
            // Reject before opening the payload row: a duplicate wakeup must
            // not deserialize a bundle owned by the winning compiler.
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
            const next: StoredPdfJobMeta = { ...current, status: "compiling", updatedAt: Date.now() };
            const write = stores[META_STORE]!.put(next);
            write.onerror = () => reject(write.error);
            write.onsuccess = () => done({ ...next, bundle: row.bundle });
          };
        };
      }
    )
  );
}

/**
 * Release a job's **source bundle** — up to 64 MiB — keeping the meta record.
 *
 * Runs as its own transaction, deliberately: `completePdfJob`'s transaction is
 * scoped to `jobs` + `results` precisely so that finishing a job cannot touch a
 * payload store, and the measured guarantee behind that scope
 * (`tests/pdf/job-store.test.ts`) is worth more than making the release atomic
 * with the completion. If a service worker dies between the two commits, the
 * record simply still holds its bundle until {@link sweepPdfJobs} — the same
 * backstop that covers every other half-finished transition.
 */
export async function releasePdfJobBundle(id: string, factory?: IDBFactory): Promise<void> {
  await withDb(factory, (db) =>
    transaction<undefined>(db, [META_STORE, BUNDLE_STORE], "readwrite", (stores, done, reject) => {
      const request = stores[META_STORE]!.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result as StoredPdfJobMeta | undefined;
        stores[BUNDLE_STORE]!.delete(id);
        if (!current || current.inputBytes === 0) {
          done(undefined);
          return;
        }
        const write = stores[META_STORE]!.put({ ...current, inputBytes: 0 });
        write.onsuccess = () => done(undefined);
        write.onerror = () => reject(write.error);
      };
    })
  );
}

export async function completePdfJob(
  id: string,
  output: { pdf: Uint8Array; diagnostics: PdfCompilerDiagnostic[]; compilerVersion: string },
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  const limits = pdfJobLimits();
  if (output.pdf.byteLength > limits.jobMaxBytes) {
    throw new Error(`PDF result exceeds the ${limits.jobMaxBytes} byte job limit.`);
  }
  // The result is about to be added while the bundle is about to go away, so the
  // net demand is the difference. Asking for the full result would evict a
  // co-tenant to make room for bytes the same job is already holding.
  const current = await getPdfJobMeta(id, factory).catch(() => undefined);
  const net = output.pdf.byteLength - (current?.inputBytes ?? 0);
  if (net > 0) await makeRoomFor(net, factory, Date.now());
  const completed = await withDb(factory, (db) =>
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
          if (total + output.pdf.byteLength > limits.storeMaxBytes) {
            reject(new Error(`PDF export storage exceeds the ${limits.storeMaxBytes} byte total quota.`));
            return;
          }
          const next: StoredPdfJobMeta = {
            ...current,
            status: "complete",
            outputBytes: output.pdf.byteLength,
            diagnostics: output.diagnostics,
            compilerVersion: output.compilerVersion,
            updatedAt: Date.now(),
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
  // Terminal state reached — the source bundle is dead weight from here on, and
  // this runs in the worker/offscreen context, which outlives the panel.
  if (completed?.status === "complete") {
    await releasePdfJobBundle(id, factory).catch(() => undefined);
    return { ...completed, inputBytes: 0 };
  }
  return completed;
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

/**
 * Fail a job and **release its bundle**.
 *
 * Same ownership rule as {@link completePdfJob}: this runs on the
 * worker/offscreen side, so the 64 MiB of source is dropped by the context that
 * survives the panel rather than waiting for the 24 h sweep. The meta record
 * (with its error and diagnostics) stays — a failed export the user can read
 * about is the point of re-attachment.
 */
export async function failPdfJob(
  id: string,
  error: string,
  diagnostics: PdfCompilerDiagnostic[] = [],
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  const failed = await updateMeta(id, (meta) =>
    isPdfJobInFlight(meta.status)
      ? { ...meta, status: "failed", error, diagnostics, updatedAt: Date.now() }
      : null, factory
  );
  if (failed?.status === "failed" && failed.inputBytes > 0) {
    await releasePdfJobBundle(id, factory).catch(() => undefined);
    return { ...failed, inputBytes: 0 };
  }
  return failed;
}

/** Record compile progress ("Page 37 of 210"). Meta-only; never touches a payload. */
export function updatePdfJobProgress(
  id: string,
  progress: PdfJobProgress,
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  return updateMeta(
    id,
    (meta) => (isPdfJobInFlight(meta.status) ? { ...meta, progress, updatedAt: Date.now() } : null),
    factory
  );
}

/**
 * Mark a finished job as collected.
 *
 * The panel's licence to delete: `compile-port.ts` may remove a whole record
 * only for a job it is actively watching **and** whose bytes it has handed to
 * the user. Everything else is the sweep's business.
 */
export function markPdfJobConsumed(
  id: string,
  factory?: IDBFactory
): Promise<StoredPdfJobMeta | undefined> {
  return updateMeta(
    id,
    (meta) => (meta.consumed ? null : { ...meta, consumed: true, updatedAt: Date.now() }),
    factory
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
 *
 * A **preview** job is the exception: nobody re-attaches to a preview, so a
 * cancelled one is removed outright. Otherwise debounced preview churn would
 * leave a trail of `cancelled` tombstones in a store the Jobs list reads.
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
          updatedAt: Date.now(),
        };
        if (current.kind === "preview") {
          stores[BUNDLE_STORE]!.delete(id);
          stores[RESULT_STORE]!.delete(id);
          const drop = stores[META_STORE]!.delete(id);
          drop.onsuccess = () => done(next);
          drop.onerror = () => reject(drop.error);
          return;
        }
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

/**
 * The backstop that keeps "durable" from meaning "stuck".
 *
 * Runs on the service-worker side (startup, and whenever the panel talks to it),
 * and applies {@link planSweep}:
 *
 *   - a job whose `deadlineAt` has passed while still in flight ends **failed**
 *     with a recoverable message — the case an MV3 worker teardown creates, and
 *     the reason a record can never read `compiling` forever;
 *   - consumed, preview, expired and long-terminal records are deleted.
 *
 * Returns what it did, so a caller can log or badge on it.
 */
export async function sweepPdfJobs(
  options: { now?: number; maxAgeMs?: number; terminalGraceMs?: number } = {},
  factory?: IDBFactory
): Promise<SweepAction[]> {
  const now = options.now ?? Date.now();
  const all = await listPdfJobMeta(factory);
  const actions = planSweep(
    all.map((meta) => ({
      id: meta.id,
      status: meta.status,
      kind: meta.kind ?? "export",
      createdAt: meta.createdAt,
      ...(meta.deadlineAt === undefined ? {} : { deadlineAt: meta.deadlineAt }),
      consumed: meta.consumed === true,
    })),
    { now, maxAgeMs: options.maxAgeMs ?? PDF_JOB_MAX_AGE_MS, ...(options.terminalGraceMs === undefined ? {} : { terminalGraceMs: options.terminalGraceMs }) }
  );
  for (const action of actions) {
    if (action.action === "delete") await deletePdfJob(action.id, factory).catch(() => undefined);
    else await failPdfJob(action.id, action.error, [], factory).catch(() => undefined);
  }
  return actions;
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
