/**
 * IndexedDB template store (spec 004 Task 3 / PLAN §2.4, extended to a
 * multi-slot **template library** by spec 010 T5.2 / Architecture point 4).
 *
 * Persists uploaded `.docx` templates so they survive panel reloads. Uses the
 * native IndexedDB API directly (no wrapper dep) so it runs unchanged in the MV3
 * panel and — crucially — under `fake-indexeddb` in tests, which is a
 * spec-complete in-memory IndexedDB (real transactions/cursors), not a stub. The
 * store is exercised end-to-end in tests: put → reopen → get → replace → delete.
 *
 * The `IDBFactory` is injectable (defaults to `globalThis.indexedDB`) so a test
 * can pass a fresh `fake-indexeddb` factory for isolation without touching
 * globals. Template bytes are stored as `ArrayBuffer` (universally structured-
 * cloneable) rather than `Blob`.
 *
 * ## v1 → v2
 *
 * v1 held a single anonymous `"current"` slot keyed by `id`. v2 is a library:
 * many records, `global` vs. `space` scope, resolved by the **pure, shared**
 * `resolveTemplate` from `@atlcli/core` — the panel grows no precedence rules
 * of its own.
 *
 * ### Two keys, deliberately
 *
 * {@link StoredTemplateRecord.recordKey} is the IDB primary key: unique per
 * *physical upload* (`<siteOrigin>|<engine>|<templateId>|<scope>[|<spaceKey>]`).
 * {@link StoredTemplateRecord.templateId} is the *logical* id `resolveTemplate`
 * matches on. They must not be the same field: with `keyPath: "id"`, inserting
 * a space-scoped override carrying the same id as the global entry would
 * `put()` straight over it (a put on the primary key replaces the row), so
 * "space beats global" could never actually be exercised. With the split both
 * rows persist and `resolveTemplate` picks the space one — identical to the
 * CLI's `~/.atlcli/templates/` global vs. sync-dir space templates.
 *
 * The `siteOrigin` component means two Atlassian sites that happen to share a
 * space key (staging and prod both using `DOCSY`) never collide, mirroring the
 * `${site}|${key}` pattern the panel's space-info session cache already uses.
 *
 * ### Migration runs in two phases
 *
 * IndexedDB auto-commits a `versionchange` transaction as soon as control
 * returns to the event loop with no request pending on it. A single `await` in
 * `onupgradeneeded` — and `sha256Hex` is exactly that, it wraps
 * `crypto.subtle.digest` — therefore lets the transaction go inactive mid-await
 * and turns the follow-up `objectStore.put()` into a `TransactionInactiveError`.
 * So:
 *
 *  1. {@link upgradeSync} — strictly synchronous work inside `onupgradeneeded`
 *     (request callbacks are fine; they *keep* the transaction alive, an
 *     `await` does not). Legacy rows are rewritten as library entries carrying
 *     `sha256: null` and a {@link MIGRATION_PENDING} marker.
 *  2. {@link runMigrationBackfill} — a normal `readwrite` transaction opened
 *     *after* the upgrade committed, which hashes the bytes and clears the
 *     marker. Resumable by construction: a panel closed mid-backfill leaves
 *     pending rows that the next open finds through the `migrationPending`
 *     index and finishes. A partially-migrated record is never presented as
 *     migrated — {@link listTemplates} consumers filter it out.
 *
 * ### Why the pending marker is `1` and not `true`
 *
 * IndexedDB valid keys are number / string / Date / ArrayBuffer / Array.
 * A boolean is **not** a valid key, and an index whose key path evaluates to an
 * invalid key silently skips the record — an index on `migrationPending: true`
 * would always be empty, and the resumability guarantee above would quietly not
 * exist. The marker is therefore the indexable number {@link MIGRATION_PENDING}.
 *
 * ### Invariant carried over from v1
 *
 * No data leaves IndexedDB and **scan verdicts are never persisted** — a scan
 * is a pure function of {@link StoredTemplateRecord.bytes} and is re-derived on
 * read, so a classification change can never leave a stale verdict behind. The
 * migration builds fresh records and therefore drops any `scan` field a v1 row
 * may still carry.
 */
const DB_NAME = "atlcli-docx";
const DB_VERSION = 2;
const STORE = "templates";
const PREFS_STORE = "template-prefs";

/** The v1 single-slot key, retired by the v1 → v2 migration. */
export const LEGACY_CURRENT_KEY = "current";

/**
 * Indexable "phase 2 has not finished for this row" marker. A number, not a
 * boolean — see the module docstring.
 */
export const MIGRATION_PENDING = 1;

/**
 * Site origin used when no Atlassian session is resolvable at migration time
 * (the panel can be opened on a non-Atlassian tab, and the upgrade handler
 * cannot await a tab query). Records stored under it are treated as
 * **site-agnostic** by `utils/templates/library.ts`: they are listed for every
 * site so a template that predates v2 never disappears from the user's library
 * just because the migration happened to run on the wrong tab. Re-uploading (or
 * assigning to a space) mints a record under the real origin.
 */
export const UNKNOWN_SITE_ORIGIN = "unknown-site";

/** Engines a stored template can target (mirrors `TemplateLibraryEntry`). */
export type TemplateEngine = "docx" | "typst";

/** Scope buckets `resolveTemplate` arbitrates between. */
export type TemplateScope = "global" | "space";

/**
 * One persisted template — a single physical upload.
 *
 * Deliberately stores only what cannot be recomputed. The placeholder scan used
 * to live here too ("captured at upload time"), which made it a **derived value
 * that drifts from the logic that produced it**: closing gap G1 reclassified
 * `$scroll.pageowner.fullName` as supported, but every already-uploaded template
 * kept serving the old verdict from IndexedDB — and the export, which always
 * re-scans the bytes, would then disagree with what the panel had promised.
 * The scan is a pure function of {@link bytes}, so it is derived on read instead.
 */
export interface StoredTemplateRecord {
  /** IDB primary key: `<siteOrigin>|<engine>|<templateId>|<scope>[|<spaceKey>]`. */
  recordKey: string;
  /** Logical id `resolveTemplate` matches on — shared by a global entry and its space override. */
  templateId: string;
  /** Atlassian site this entry belongs to, or {@link UNKNOWN_SITE_ORIGIN}. */
  siteOrigin: string;
  /** Human-facing label for pickers. */
  displayName: string;
  /** Which engine the template targets. */
  engine: TemplateEngine;
  /** `"global"` (whole site) or `"space"` (one Confluence space). */
  scope: TemplateScope;
  /** Required when `scope === "space"`. */
  spaceKey?: string;
  /** Original uploaded filename (drives `$scroll.template.name`). */
  name: string;
  /** The raw `.docx` bytes — the single source of truth for the scan. */
  bytes: ArrayBuffer;
  /** Upload timestamp (ms epoch; drives `$scroll.template.modificationdate`). */
  uploadedAt: number;
  /** Lowercase hex SHA-256 of {@link bytes}; `null` only while migration phase 2 is pending. */
  sha256: string | null;
  /** Byte length of {@link bytes}; cross-checked on load. */
  size: number;
  /** Present (as {@link MIGRATION_PENDING}) only while phase 2 has not completed this row. */
  migrationPending?: typeof MIGRATION_PENDING;
}

/** A settings value as produced by the manifest-driven settings form (007 / B10). */
export type TemplateSettingsValue = string | number | boolean | null;

/**
 * Per-site/engine/space preferences: which template is active, and the settings
 * values entered for each template. Keyed by
 * `<siteOrigin>|<engine>|<spaceKey>` — the same `siteOrigin` prefix the template
 * records use, so two sites sharing a space key keep independent selections.
 */
export interface TemplatePrefsRecord {
  /** IDB primary key: `<siteOrigin>|<engine>|<spaceKey>` (empty last segment when space-agnostic). */
  recordKey: string;
  siteOrigin: string;
  engine: TemplateEngine;
  spaceKey?: string;
  /** The **logical** `templateId` of the active selection (never a `recordKey`). */
  activeTemplateId?: string;
  /** Settings-form values, nested per logical `templateId`. */
  settingsByTemplateId?: Record<string, Record<string, TemplateSettingsValue>>;
  updatedAt: number;
}

/** The v1 record shape, as still found on disk before the migration runs. */
interface LegacyTemplateRecord {
  id?: string;
  name?: string;
  bytes?: ArrayBuffer;
  uploadedAt?: number;
}

/** Options accepted by every store entry point. */
export interface TemplateStoreOptions {
  /**
   * Ambient session origin (e.g. `https://x.atlassian.net`), used **only** when
   * the v1 → v2 upgrade actually runs. Falls back to {@link UNKNOWN_SITE_ORIGIN}.
   */
  siteOrigin?: string;
  /**
   * Skip migration phase 2. Exists so a test can observe the state the
   * synchronous upgrade phase left behind (and so it can simulate a panel
   * closed mid-backfill); production callers never set it.
   */
  skipBackfill?: boolean;
}

export function normalizeSiteOrigin(siteOrigin?: string): string {
  const trimmed = siteOrigin?.trim();
  if (!trimmed) return UNKNOWN_SITE_ORIGIN;
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * Build the IDB primary key for a template record. Global entries get four
 * segments, space-scoped entries a fifth — so a global entry and its space
 * override of the *same* `templateId` are two distinct rows that coexist.
 */
export function buildRecordKey(parts: {
  siteOrigin: string;
  engine: TemplateEngine;
  templateId: string;
  scope: TemplateScope;
  spaceKey?: string;
}): string {
  const base = `${normalizeSiteOrigin(parts.siteOrigin)}|${parts.engine}|${parts.templateId}|${parts.scope}`;
  return parts.scope === "space" ? `${base}|${parts.spaceKey ?? ""}` : base;
}

/** Build the `template-prefs` primary key: `<siteOrigin>|<engine>|<spaceKey>`. */
export function buildPrefsKey(parts: {
  siteOrigin: string;
  engine: TemplateEngine;
  spaceKey?: string;
}): string {
  return `${normalizeSiteOrigin(parts.siteOrigin)}|${parts.engine}|${parts.spaceKey ?? ""}`;
}

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const f = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error("IndexedDB is not available in this environment.");
  return f;
}

function createTemplatesStore(db: IDBDatabase): IDBObjectStore {
  const store = db.createObjectStore(STORE, { keyPath: "recordKey" });
  ensureIndexes(store);
  return store;
}

function ensureIndexes(store: IDBObjectStore): void {
  for (const name of ["engine", "scope", "spaceKey", "migrationPending"] as const) {
    if (!store.indexNames.contains(name)) store.createIndex(name, name);
  }
}

/**
 * Rewrite one v1 row as a v2 library entry with a placeholder hash. Synchronous
 * on purpose: it runs inside the version-change transaction, where an `await`
 * would let the transaction commit out from under the following `put()`.
 */
function toPendingRecord(
  legacy: LegacyTemplateRecord,
  siteOrigin: string
): StoredTemplateRecord | null {
  const bytes = legacy.bytes;
  if (!bytes || typeof bytes.byteLength !== "number") return null;
  const templateId = crypto.randomUUID();
  const name = legacy.name ?? "template.docx";
  return {
    // v1 only ever stored DOCX templates, so `engine: "docx"` is safe.
    recordKey: buildRecordKey({ siteOrigin, engine: "docx", templateId, scope: "global" }),
    templateId,
    siteOrigin,
    displayName: name,
    engine: "docx",
    scope: "global",
    name,
    bytes,
    uploadedAt: typeof legacy.uploadedAt === "number" ? legacy.uploadedAt : Date.now(),
    sha256: null,
    size: bytes.byteLength,
    migrationPending: MIGRATION_PENDING,
  };
}

/**
 * Migration phase 1 — **strictly synchronous**. Any `await` added here would
 * commit the version-change transaction mid-flight and turn the follow-up
 * writes into `TransactionInactiveError`s. Request callbacks (`onsuccess`) are
 * allowed and used: a pending request keeps the transaction active.
 */
function upgradeSync(db: IDBDatabase, upgradeTx: IDBTransaction, siteOrigin: string): void {
  if (!db.objectStoreNames.contains(PREFS_STORE)) {
    db.createObjectStore(PREFS_STORE, { keyPath: "recordKey" });
  }

  if (!db.objectStoreNames.contains(STORE)) {
    createTemplatesStore(db);
    return;
  }

  const existing = upgradeTx.objectStore(STORE);
  if (existing.keyPath === "recordKey") {
    // Already the v2 shape (fresh install at v2, or a re-run) — nothing to move.
    ensureIndexes(existing);
    return;
  }

  // v1: `keyPath: "id"`. A key path cannot be altered in place, so the store is
  // read out, dropped and recreated. Reading through a request callback (not an
  // await) is what keeps the version-change transaction alive across the hop.
  const readAll = existing.getAll();
  readAll.onsuccess = () => {
    const legacy = (readAll.result ?? []) as LegacyTemplateRecord[];
    db.deleteObjectStore(STORE); // takes the legacy "current" key with it
    const store = createTemplatesStore(db);
    for (const row of legacy) {
      const migrated = toPendingRecord(row, siteOrigin);
      if (migrated) store.put(migrated);
    }
  };
}

function openRaw(idb: IDBFactory, siteOrigin: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const upgradeTx = req.transaction;
      if (!upgradeTx) {
        reject(new Error("IndexedDB upgrade started without a version-change transaction."));
        return;
      }
      try {
        upgradeSync(req.result, upgradeTx, siteOrigin);
      } catch (error) {
        reject(error);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () =>
      reject(new Error("IndexedDB upgrade is blocked by another open connection."));
  });
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result: unknown;
    let req: IDBRequest | void;
    try {
      req = run(t.objectStore(storeName));
    } catch (error) {
      try {
        t.abort();
      } catch {
        /* already aborted */
      }
      reject(error);
      return;
    }
    // Capture the request result, but only resolve on transaction COMMIT
    // (`oncomplete`). Resolving on the request's `onsuccess` reports success
    // for writes that are later rolled back by a commit-time abort.
    if (req) {
      const request = req;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    }
    t.oncomplete = () => resolve(result as T);
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Migration phase 2 — hash the rows phase 1 left pending, outside any
 * version-change transaction. Idempotent and resumable: it finds its work
 * through the `migrationPending` index, so an interrupted run simply leaves
 * rows for the next open to finish.
 */
export async function runMigrationBackfill(db: IDBDatabase): Promise<number> {
  const pending = await tx<StoredTemplateRecord[] | undefined>(db, STORE, "readonly", (s) =>
    s.index("migrationPending").getAll(MIGRATION_PENDING)
  );
  if (!pending || pending.length === 0) return 0;

  const completed: StoredTemplateRecord[] = [];
  for (const row of pending) {
    const sha256 = await sha256Hex(new Uint8Array(row.bytes));
    const { migrationPending: _pending, ...rest } = row;
    completed.push({ ...rest, sha256, size: row.bytes.byteLength });
  }

  await tx(db, STORE, "readwrite", (s) => {
    let last: IDBRequest | undefined;
    for (const row of completed) last = s.put(row);
    return last;
  });
  return completed.length;
}

/**
 * Open (and, on first v2 open, upgrade + backfill) the template database.
 *
 * The returned connection is the caller's to close.
 */
export async function openTemplateDb(
  factory?: IDBFactory,
  options: TemplateStoreOptions = {}
): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  const db = await openRaw(idb, normalizeSiteOrigin(options.siteOrigin));
  if (options.skipBackfill) return db;
  try {
    await runMigrationBackfill(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Insert or replace a template record (upload / replace action). */
export async function putTemplate(
  template: StoredTemplateRecord,
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<void> {
  const db = await openTemplateDb(factory, options);
  try {
    await tx(db, STORE, "readwrite", (s) => s.put(template));
  } finally {
    db.close();
  }
}

/** Read one template record by its IDB primary key. */
export async function getTemplate(
  recordKey: string,
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<StoredTemplateRecord | undefined> {
  const db = await openTemplateDb(factory, options);
  try {
    return await tx<StoredTemplateRecord | undefined>(db, STORE, "readonly", (s) =>
      s.get(recordKey)
    );
  } finally {
    db.close();
  }
}

/** List every stored template record (all sites, all engines, all scopes). */
export async function listTemplates(
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<StoredTemplateRecord[]> {
  const db = await openTemplateDb(factory, options);
  try {
    return (
      (await tx<StoredTemplateRecord[] | undefined>(db, STORE, "readonly", (s) => s.getAll())) ?? []
    );
  } finally {
    db.close();
  }
}

/** Delete one template record (delete action / removing a space override). */
export async function deleteTemplate(
  recordKey: string,
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<void> {
  const db = await openTemplateDb(factory, options);
  try {
    await tx(db, STORE, "readwrite", (s) => s.delete(recordKey));
  } finally {
    db.close();
  }
}

/** Read the preferences record (active selection + settings values) for a key. */
export async function getTemplatePrefs(
  recordKey: string,
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<TemplatePrefsRecord | undefined> {
  const db = await openTemplateDb(factory, options);
  try {
    return await tx<TemplatePrefsRecord | undefined>(db, PREFS_STORE, "readonly", (s) =>
      s.get(recordKey)
    );
  } finally {
    db.close();
  }
}

/** Insert or replace a preferences record. */
export async function putTemplatePrefs(
  prefs: TemplatePrefsRecord,
  factory?: IDBFactory,
  options?: TemplateStoreOptions
): Promise<void> {
  const db = await openTemplateDb(factory, options);
  try {
    await tx(db, PREFS_STORE, "readwrite", (s) => s.put(prefs));
  } finally {
    db.close();
  }
}
