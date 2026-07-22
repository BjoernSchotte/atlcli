/**
 * Create the genuine **v1** shape of the `atlcli-docx` database — version 1,
 * store `templates`, `keyPath: "id"`, a literal `"current"` record — exactly
 * what a panel that predates the template library wrote.
 *
 * Shared by the migration tests and the library-adapter tests, because a test
 * that seeds the v2 store directly (with `add()` or a hand-built record) does
 * **not** exercise the migration and cannot claim to test migrated rows: the
 * `unknown-site` sentinel, in particular, only ever comes into existence
 * through a v1 → v2 upgrade that ran without a resolvable session origin.
 */
import type { IDBFactory } from "fake-indexeddb";

const DB_NAME = "atlcli-docx";

export interface LegacySeed {
  name: string;
  buffer: ArrayBuffer;
  uploadedAt: number;
  /** A verdict a pre-v2 panel may still have persisted; must be dropped. */
  scan?: unknown;
}

/** Create the v1 schema and optionally seed its single `"current"` slot. */
export function seedLegacyV1(factory: IDBFactory, seed?: LegacySeed): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("templates")) {
        req.result.createObjectStore("templates", { keyPath: "id" });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!seed) {
        db.close();
        resolve();
        return;
      }
      const t = db.transaction("templates", "readwrite");
      t.objectStore("templates").put({
        id: "current",
        name: seed.name,
        bytes: seed.buffer,
        uploadedAt: seed.uploadedAt,
        ...(seed.scan === undefined ? {} : { scan: seed.scan }),
      });
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    };
  });
}

/**
 * Open the v1 database and **keep the connection open** — the caller closes it.
 * Used to reproduce a second panel holding the old version open while another
 * one tries to upgrade, which makes the upgrade `blocked`.
 */
export function openLegacyV1Connection(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("templates")) {
        req.result.createObjectStore("templates", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
