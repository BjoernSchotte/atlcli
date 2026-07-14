/**
 * IndexedDB template store (spec 004 Task 3 / PLAN §2.4).
 *
 * Persists the uploaded `.docx` template so it survives panel reloads. Uses the
 * native IndexedDB API directly (no wrapper dep) so it runs unchanged in the MV3
 * panel and — crucially — under `fake-indexeddb` in tests, which is a
 * spec-complete in-memory IndexedDB (real transactions/cursors), not a stub. The
 * store is exercised end-to-end in tests: put → reopen → get → replace → delete.
 *
 * The `IDBFactory` is injectable (defaults to `globalThis.indexedDB`) so a test
 * can pass a fresh `fake-indexeddb` factory for isolation without touching
 * globals. Template bytes are stored as `ArrayBuffer` (universally structured-
 * cloneable) rather than `Blob`.
 */
import type { ScanResult } from "./scan.js";

const DB_NAME = "atlcli-docx";
const DB_VERSION = 1;
const STORE = "templates";

/** A persisted template record. */
export interface StoredTemplate {
  /** Stable id. The panel uses a single `"current"` slot (one-at-a-time). */
  id: string;
  /** Original uploaded filename (drives `$scroll.template.name`). */
  name: string;
  /** The raw `.docx` bytes. */
  bytes: ArrayBuffer;
  /** Upload timestamp (ms epoch; drives `$scroll.template.modificationdate`). */
  uploadedAt: number;
  /** Placeholder scan captured at upload time. */
  scan: ScanResult;
}

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const f = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error("IndexedDB is not available in this environment.");
  return f;
}

/** Open (and upgrade) the template database. */
export function openTemplateDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
}

/** Insert or replace a template (upload / replace action). */
export async function putTemplate(
  template: StoredTemplate,
  factory?: IDBFactory
): Promise<void> {
  const db = await openTemplateDb(factory);
  try {
    await tx(db, "readwrite", (s) => s.put(template));
  } finally {
    db.close();
  }
}

/** Read a template by id (defaults to the single `"current"` slot). */
export async function getTemplate(
  id = "current",
  factory?: IDBFactory
): Promise<StoredTemplate | undefined> {
  const db = await openTemplateDb(factory);
  try {
    return (await tx(db, "readonly", (s) => s.get(id))) as StoredTemplate | undefined;
  } finally {
    db.close();
  }
}

/** List all stored templates. */
export async function listTemplates(factory?: IDBFactory): Promise<StoredTemplate[]> {
  const db = await openTemplateDb(factory);
  try {
    return ((await tx(db, "readonly", (s) => s.getAll())) as StoredTemplate[]) ?? [];
  } finally {
    db.close();
  }
}

/** Delete a template (delete action). */
export async function deleteTemplate(id = "current", factory?: IDBFactory): Promise<void> {
  const db = await openTemplateDb(factory);
  try {
    await tx(db, "readwrite", (s) => s.delete(id));
  } finally {
    db.close();
  }
}
