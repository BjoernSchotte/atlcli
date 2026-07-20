/**
 * v1 → v2 migration of the `atlcli-docx` template store (spec 010 T5.2).
 *
 * Every test starts from a **real v1 database shape** — opened at version 1
 * with `keyPath: "id"` and a literal `"current"` record, exactly what a panel
 * that predates the library wrote — against `fake-indexeddb`, a spec-complete
 * in-memory IndexedDB (real version-change transactions, real index key-path
 * evaluation), never a stub.
 *
 * The crux under test is the two-phase split. IndexedDB auto-commits a
 * `versionchange` transaction the moment control returns to the event loop with
 * no pending request on it, so a single `await crypto.subtle.digest(...)` inside
 * `onupgradeneeded` would let it go inactive and turn the following `put()` into
 * a `TransactionInactiveError`. Phase 1 must therefore stay synchronous, and
 * phase 2 (hashing) must run in a normal transaction afterwards — resumably, so
 * a panel closed mid-backfill leaves no half-migrated record behind.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import {
  listTemplates,
  MIGRATION_PENDING,
  openTemplateDb,
  runMigrationBackfill,
  UNKNOWN_SITE_ORIGIN,
  type StoredTemplateRecord,
} from "../../utils/docx/template-store.js";

const DB_NAME = "atlcli-docx";
const SITE = "https://mayflower.atlassian.net";

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function docxBytes(): { bytes: Uint8Array; buffer: ArrayBuffer } {
  const bytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
  return {
    bytes,
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create the genuine v1 schema (`atlcli-docx` v1, store `templates`,
 * `keyPath: "id"`) and optionally seed the single `"current"` slot.
 */
function seedV1(seed?: { name: string; buffer: ArrayBuffer; uploadedAt: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("templates", { keyPath: "id" });
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

/** Read every row of a store on an already-open connection. */
function readAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).getAll();
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve((req.result ?? []) as T[]);
    t.onerror = () => reject(t.error);
  });
}

/**
 * Drop comments so prose about `await` (of which this store has plenty, since
 * the whole design is about avoiding it) never trips the source guard below.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * Extract a top-level `function <name>(...) { ... }` body by brace matching.
 * Returns the whole declaration (signature included) so an `async` keyword is
 * visible to the caller's assertions.
 */
function functionBody(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) return undefined;
  const open = source.indexOf("{", start);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}

/** Read rows through the `migrationPending` index — the resumability path. */
function readPending(db: IDBDatabase): Promise<StoredTemplateRecord[]> {
  return new Promise((resolve, reject) => {
    const t = db.transaction("templates", "readonly");
    const req = t.objectStore("templates").index("migrationPending").getAll(MIGRATION_PENDING);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve((req.result ?? []) as StoredTemplateRecord[]);
    t.onerror = () => reject(t.error);
  });
}

describe("template store v1 → v2 migration", () => {
  it("phase 1 lands a synchronous placeholder record and drops the legacy 'current' key", async () => {
    const { buffer } = docxBytes();
    await seedV1({ name: "mayflower.docx", buffer, uploadedAt: 1_700_000_000_000 });

    // `skipBackfill` freezes the database in exactly the state the synchronous
    // upgrade handler left it — i.e. BEFORE phase 2 ever runs.
    const db = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    try {
      const rows = await readAll<StoredTemplateRecord>(db, "templates");
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(row.recordKey).toBe(`${SITE}|docx|${row.templateId}|global`);
      // A fresh uuid, not the legacy "current" slot name.
      expect(row.templateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(row.templateId).not.toBe("current");
      expect(row.engine).toBe("docx");
      expect(row.scope).toBe("global");
      expect(row.siteOrigin).toBe(SITE);
      expect(row.name).toBe("mayflower.docx");
      expect(row.displayName).toBe("mayflower.docx");
      expect(row.uploadedAt).toBe(1_700_000_000_000);
      // The hash is deliberately absent — computing it needs an await, which
      // would have killed the version-change transaction.
      expect(row.sha256).toBeNull();
      expect(row.size).toBe(buffer.byteLength);
      expect(row.migrationPending).toBe(MIGRATION_PENDING);

      // The legacy key is gone: the store now has a `recordKey` key path, and
      // nothing answers to "current" any more.
      expect(db.transaction("templates").objectStore("templates").keyPath).toBe("recordKey");
      expect(rows.map((r) => (r as unknown as { id?: string }).id)).toEqual([undefined]);

      // The prefs store exists from phase 1 on.
      expect(db.objectStoreNames.contains("template-prefs")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("phase 2 backfills sha256 + size and clears the pending marker", async () => {
    const { bytes, buffer } = docxBytes();
    await seedV1({ name: "mayflower.docx", buffer, uploadedAt: 1_700_000_000_000 });

    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      const rows = await readAll<StoredTemplateRecord>(db, "templates");
      expect(rows).toHaveLength(1);
      expect(rows[0].sha256).toBe(await sha256Of(bytes));
      expect(rows[0].size).toBe(bytes.byteLength);
      expect(rows[0].migrationPending).toBeUndefined();
      // Cleared from the index too, so a later open finds no work.
      expect(await readPending(db)).toHaveLength(0);
      // Bytes survive the migration intact.
      expect(new Uint8Array(rows[0].bytes)).toEqual(new Uint8Array(bytes));
    } finally {
      db.close();
    }
  });

  it("resumes an interrupted backfill: the pending row is found via its index on the next open", async () => {
    const { bytes, buffer } = docxBytes();
    await seedV1({ name: "mayflower.docx", buffer, uploadedAt: 5 });

    // Panel closes between phase 1 and phase 2.
    const interrupted = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    const pendingBefore = await readPending(interrupted);
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].sha256).toBeNull();
    interrupted.close();

    // Next open: schema is already v2 (no upgrade runs), yet the leftover work
    // is still discoverable through the index and gets finished.
    const reopened = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      expect(await readPending(reopened)).toHaveLength(0);
      const rows = await readAll<StoredTemplateRecord>(reopened, "templates");
      expect(rows[0].sha256).toBe(await sha256Of(bytes));
      expect(rows[0].migrationPending).toBeUndefined();
      // The record was never presented half-migrated: templateId and bytes are
      // the same row phase 1 wrote, only completed.
      expect(rows[0].templateId).toBe(pendingBefore[0].templateId);
      expect(rows[0].recordKey).toBe(pendingBefore[0].recordKey);
    } finally {
      reopened.close();
    }
  });

  it("is a no-op on a second open at v2", async () => {
    const { buffer } = docxBytes();
    await seedV1({ name: "mayflower.docx", buffer, uploadedAt: 7 });

    const first = await listTemplates(factory, { siteOrigin: SITE });
    const second = await listTemplates(factory, { siteOrigin: SITE });
    const third = await listTemplates(factory, { siteOrigin: SITE });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    // Same row, same identity — no duplicate uuid minted per open.
    expect(second[0].recordKey).toBe(first[0].recordKey);
    expect(third[0].templateId).toBe(first[0].templateId);
    expect(third[0].sha256).toBe(first[0].sha256);

    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      // A repeat backfill finds nothing left to do.
      expect(await runMigrationBackfill(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("migrates an empty v1 database cleanly", async () => {
    await seedV1();
    const rows = await listTemplates(factory, { siteOrigin: SITE });
    expect(rows).toEqual([]);

    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      expect(db.version).toBe(2);
      expect(db.objectStoreNames.contains("templates")).toBe(true);
      expect(db.objectStoreNames.contains("template-prefs")).toBe(true);
      expect(db.transaction("templates").objectStore("templates").keyPath).toBe("recordKey");
    } finally {
      db.close();
    }
  });

  it("creates the v2 schema from scratch when no v1 database exists", async () => {
    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      expect(db.version).toBe(2);
      const store = db.transaction("templates").objectStore("templates");
      expect(store.keyPath).toBe("recordKey");
      for (const index of ["engine", "scope", "spaceKey", "migrationPending"]) {
        expect(store.indexNames.contains(index)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("falls back to the site-agnostic sentinel when no session origin is resolvable", async () => {
    const { buffer } = docxBytes();
    await seedV1({ name: "orphan.docx", buffer, uploadedAt: 9 });

    const rows = await listTemplates(factory);
    expect(rows[0].siteOrigin).toBe(UNKNOWN_SITE_ORIGIN);
    expect(rows[0].recordKey).toStartWith(`${UNKNOWN_SITE_ORIGIN}|docx|`);
  });

  it("keeps migration phase 1 free of any await — the guard a runtime test cannot give us", () => {
    // WHY THIS IS A SOURCE-LEVEL CHECK, not a behavioural one.
    //
    // In a real browser, an `await` inside `onupgradeneeded` lets the
    // version-change transaction auto-commit mid-await and the follow-up
    // `put()` throws `TransactionInactiveError`. `fake-indexeddb` — verified by
    // probe, not assumed — does NOT model that: an upgrade handler that awaits
    // `crypto.subtle.digest` and then puts succeeds silently under the fake.
    // So no test run against the fake can catch the regression the two-phase
    // split exists to prevent; only the source can. Do not "simplify" this into
    // an assertion about stored records — it would pass while shipping a store
    // that fails on first upgrade in Chrome.
    const source = readFileSync(
      new URL("../../utils/docx/template-store.ts", import.meta.url),
      "utf8"
    );

    // Everything reachable synchronously from `onupgradeneeded`.
    const phase1 = [
      "upgradeSync",
      "createTemplatesStore",
      "ensureIndexes",
      "toPendingRecord",
      "buildRecordKey",
      "normalizeSiteOrigin",
    ];

    for (const name of phase1) {
      const body = functionBody(stripComments(source), name);
      expect(body, `phase-1 function ${name} not found in template-store.ts`).toBeDefined();
      expect(body, `${name} must not be async — it runs inside the version-change transaction`)
        .not.toMatch(/\basync\b/);
      expect(body, `${name} must not await — it runs inside the version-change transaction`)
        .not.toMatch(/\bawait\b/);
      expect(body, `${name} must not chain promises — it runs inside the version-change transaction`)
        .not.toMatch(/\.then\s*\(/);
    }

    // And the handler that calls them is itself synchronous.
    const bare = stripComments(source);
    const handler = bare.slice(bare.indexOf("req.onupgradeneeded"));
    expect(handler.slice(0, handler.indexOf("req.onsuccess"))).not.toMatch(/\b(async|await)\b/);
  });

  it("drops a stale persisted scan while migrating — verdicts stay derived on read", async () => {
    const { buffer } = docxBytes();
    await seedV1({ name: "legacy.docx", buffer, uploadedAt: 13 });
    // A record written before the scan stopped being persisted.
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("templates", "readwrite");
        t.objectStore("templates").put({
          id: "current",
          name: "legacy.docx",
          bytes: buffer,
          uploadedAt: 13,
          scan: { hasContentPlaceholder: false, supported: [], unsupported: [], never: [] },
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
      req.onerror = () => reject(req.error);
    });

    const rows = await listTemplates(factory, { siteOrigin: SITE });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("scan");
  });
});
