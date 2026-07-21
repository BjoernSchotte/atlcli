/**
 * Preview byte cache (spec 010 T5.3).
 *
 * Holds the bytes of the **most recent successful preview** so that (a) the
 * large-preview tab page renders the same document the side panel already
 * compiled, without a second compile, and (b) clicking Download on an unchanged
 * request emits exactly the bytes the user just looked at.
 *
 * ## The key, and the defect it closes
 *
 * ```
 * key = sourceIdentity · settingsHash · treeVersionHash
 * ```
 *
 * `sourceIdentity` (`pageUrl|id|version` extended by `exportScopeIdentity`)
 * discriminates *which document* and *which scope/filter*. `settingsHash`
 * discriminates the resolved template settings, so a tweak that has not yet
 * triggered a recompile can never serve the old bytes as "what you previewed".
 *
 * `treeVersionHash` is the part the PLAN did not have. Wave 1 found that
 * `sourceIdentity` carries **only the root page's version**: a child page
 * edited between two tree exports produces different bytes under an identical
 * identity. A panel-lifetime cache survives that (bodies are refetched every
 * run), but this cache persists in IndexedDB *and* feeds Download — omitting
 * the per-node versions would ship stale bytes labelled "what you previewed".
 * So every node's `id:version` goes into the hash. For `scope: page` that
 * degenerates to the single root version, which is exactly right.
 *
 * ## Truncated entries are viewer-only
 *
 * A tree/space preview is a **prefix of the document, not the document**.
 * {@link getReusableExportBytes} therefore refuses to hand a truncated entry to
 * Download — silently downloading it would ship a cut-off PDF that looks
 * complete. {@link getPreviewEntry} (the viewer's read) returns it happily.
 *
 * ## Footprint
 *
 * The cache is **single-slot**: writing an entry replaces whatever was there.
 * Preview churn therefore cannot grow the IndexedDB footprint — the worst case
 * is one document, capped at {@link PREVIEW_CACHE_MAX_BYTES} (the same per-job
 * ceiling the job store uses), and entries expire on the same 24 h horizon as
 * jobs. The compile itself still creates and deletes an ordinary job record in
 * `atlcli-pdf` under the existing lifecycle; this store holds only the result
 * the user is currently looking at.
 *
 * It is a **separate database** (`atlcli-pdf-preview`) rather than a fourth
 * store in `atlcli-pdf`: adding a store there means bumping that database's
 * version, and its schema is owned by the durable-job work (T5.6). A separate
 * database keeps the two lifecycles — "transient job, deleted in `finally`" and
 * "one cached result, replaced on write" — from having to share a migration.
 */
import { pdfBytesFromUint8Array, type PdfBytesHandle } from "@atlcli/pdf/browser";
import { PDF_JOB_MAX_AGE_MS, PDF_JOB_MAX_BYTES } from "./job-store.js";

const DB_NAME = "atlcli-pdf-preview";
const DB_VERSION = 1;
const STORE = "previews";
/** Single-slot: one row, always this key. */
const SLOT_KEY = "current";

/** A cached preview may never be larger than one job's worth of bytes. */
export const PREVIEW_CACHE_MAX_BYTES = PDF_JOB_MAX_BYTES;
/** Same expiry horizon as a job record. */
export const PREVIEW_CACHE_MAX_AGE_MS = PDF_JOB_MAX_AGE_MS;

/** Everything that must agree for cached bytes to still describe the request. */
export interface PreviewCacheKeyParts {
  /** `pageUrl|id|version` extended with `exportScopeIdentity(scope, labels)`. */
  sourceIdentity: string;
  /** Hash of the resolved settings — see {@link hashPreviewSettings}. */
  settingsHash: string;
  /** Hash of every node's `id:version` — see {@link hashTreeVersions}. */
  treeVersionHash: string;
}

export interface PreviewCacheEntry extends PreviewCacheKeyParts {
  key: string;
  /**
   * `true` when the bytes are a *prefix* of the document (tree/space budget).
   * Download must refuse these; the viewer may show them.
   */
  truncated: boolean;
  includedChapters: number;
  totalChapters: number;
  filename: string;
  byteLength: number;
  createdAt: number;
}

interface StoredPreviewRow extends PreviewCacheEntry {
  id: typeof SLOT_KEY;
  pdf: Uint8Array;
}

/** A cache entry plus a handle over its bytes. */
export interface PreviewCacheHit {
  entry: PreviewCacheEntry;
  bytes: PdfBytesHandle;
}

// ---------------------------------------------------------------------------
// Key composition (pure)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON with sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two settings objects that are
 * equal but were built in a different order would hash differently and cause a
 * spurious recompile — or, worse, make the key look "different enough" while
 * describing identical bytes.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 hex of a string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of the resolved template settings (order-independent). */
export function hashPreviewSettings(settings: unknown): Promise<string> {
  return sha256Hex(stableStringify(settings ?? null));
}

/**
 * Hash of the resolved tree's per-node versions.
 *
 * Sorted by id so the walk order cannot change the hash, and a node with no
 * known version hashes as `-` rather than being dropped — an unknown version is
 * a *different* fact from "version 3", and treating it as absent would make two
 * genuinely different trees collide.
 */
export function hashTreeVersions(
  nodes: readonly { id: string; version: number | null }[]
): Promise<string> {
  const canonical = nodes
    .map((node) => `${node.id}:${node.version ?? "-"}`)
    .sort()
    .join("|");
  return sha256Hex(canonical);
}

/** The cache key. Injective in all three parts (they are fixed-width hashes plus a delimiter-escaped identity). */
export function previewCacheKey(parts: PreviewCacheKeyParts): string {
  return `${encodeURIComponent(parts.sourceIdentity)}·${parts.settingsHash}·${parts.treeVersionHash}`;
}

/** True when a cached entry describes exactly this request. */
export function matchesRequest(entry: PreviewCacheEntry, parts: PreviewCacheKeyParts): boolean {
  return (
    entry.sourceIdentity === parts.sourceIdentity &&
    entry.settingsHash === parts.settingsHash &&
    entry.treeVersionHash === parts.treeVersionHash
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const value = factory ?? globalThis.indexedDB;
  if (!value) throw new Error("IndexedDB is unavailable for the PDF preview cache.");
  return value;
}

export function openPreviewCacheDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open the PDF preview cache."));
  });
}

async function withDb<T>(factory: IDBFactory | undefined, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openPreviewCacheDb(factory);
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void, fail: (reason?: unknown) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([STORE], mode);
    let value: T;
    let hasValue = false;
    try {
      run(
        tx.objectStore(STORE),
        (result) => {
          value = result;
          hasValue = true;
        },
        reject
      );
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      if (!hasValue) reject(new Error("Preview cache transaction completed without a result."));
      else resolve(value!);
    };
    tx.onabort = () => reject(tx.error ?? new Error("Preview cache transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("Preview cache transaction failed."));
  });
}

export interface PutPreviewInput extends PreviewCacheKeyParts {
  pdf: Uint8Array;
  filename: string;
  truncated: boolean;
  includedChapters: number;
  totalChapters: number;
  createdAt?: number;
}

/** Replace the cached preview. Rejects a document larger than one job's budget. */
export async function putPreview(
  input: PutPreviewInput,
  factory?: IDBFactory
): Promise<PreviewCacheEntry> {
  if (input.pdf.byteLength > PREVIEW_CACHE_MAX_BYTES) {
    throw new Error(`Preview exceeds the ${PREVIEW_CACHE_MAX_BYTES} byte cache limit.`);
  }
  const entry: PreviewCacheEntry = {
    key: previewCacheKey(input),
    sourceIdentity: input.sourceIdentity,
    settingsHash: input.settingsHash,
    treeVersionHash: input.treeVersionHash,
    truncated: input.truncated,
    includedChapters: input.includedChapters,
    totalChapters: input.totalChapters,
    filename: input.filename,
    byteLength: input.pdf.byteLength,
    createdAt: input.createdAt ?? Date.now(),
  };
  const row: StoredPreviewRow = { ...entry, id: SLOT_KEY, pdf: input.pdf };
  return withDb(factory, (db) =>
    transact<PreviewCacheEntry>(db, "readwrite", (store, done, fail) => {
      const request = store.put(row);
      request.onsuccess = () => done(entry);
      request.onerror = () => fail(request.error ?? new Error("Failed to cache the PDF preview."));
    })
  );
}

async function readRow(
  factory: IDBFactory | undefined,
  now: number
): Promise<StoredPreviewRow | undefined> {
  const row = await withDb(factory, (db) =>
    transact<StoredPreviewRow | undefined>(db, "readonly", (store, done, fail) => {
      const request = store.get(SLOT_KEY);
      request.onsuccess = () => done(request.result as StoredPreviewRow | undefined);
      request.onerror = () => fail(request.error);
    })
  );
  if (!row) return undefined;
  if (now - row.createdAt > PREVIEW_CACHE_MAX_AGE_MS) {
    await clearPreview(factory).catch(() => undefined);
    return undefined;
  }
  return row;
}

/**
 * The cached preview for this request, truncated or not — the **viewer's**
 * read. Returns nothing when the key does not match exactly.
 */
export async function getPreviewEntry(
  parts: PreviewCacheKeyParts,
  options: { now?: number; factory?: IDBFactory } = {}
): Promise<PreviewCacheHit | undefined> {
  const row = await readRow(options.factory, options.now ?? Date.now());
  if (!row || !matchesRequest(row, parts)) return undefined;
  const { pdf, id: _id, ...entry } = row;
  void _id;
  return { entry, bytes: pdfBytesFromUint8Array(pdf) };
}

/**
 * Bytes **Download** may reuse.
 *
 * Refuses a `truncated` entry on purpose: those bytes are a prefix of the
 * document, and emitting them as the export would hand the user a cut-off PDF
 * that looks complete. The caller falls through to a full compile.
 */
export async function getReusableExportBytes(
  parts: PreviewCacheKeyParts,
  options: { now?: number; factory?: IDBFactory } = {}
): Promise<PreviewCacheHit | undefined> {
  const hit = await getPreviewEntry(parts, options);
  if (!hit || hit.entry.truncated) return undefined;
  return hit;
}

/** Drop the cached preview (panel teardown, or an explicit invalidation). */
export async function clearPreview(factory?: IDBFactory): Promise<void> {
  await withDb(factory, (db) =>
    transact<undefined>(db, "readwrite", (store, done, fail) => {
      const request = store.delete(SLOT_KEY);
      request.onsuccess = () => done(undefined);
      request.onerror = () => fail(request.error);
    })
  );
}
