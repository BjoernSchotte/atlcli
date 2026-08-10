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
import { findPhase1AsyncViolations } from "./phase1-sync-guard.js";
import { openLegacyV1Connection, seedLegacyV1 } from "./seed-v1.js";

const DB_NAME = "atlcli-docx";
const SITE = "https://tenant-a.atlassian.net";

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

/** Seed the genuine v1 schema (see `seed-v1.ts`) against this test's factory. */
function seedV1(seed?: { name: string; buffer: ArrayBuffer; uploadedAt: number }): Promise<void> {
  return seedLegacyV1(factory, seed);
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

/** The real store source the phase-1 guard runs against. */
function storeSource(): string {
  return readFileSync(new URL("../../utils/docx/template-store.ts", import.meta.url), "utf8");
}

/**
 * Apply one sabotage to the source, asserting the anchor exists first: a
 * mutation test whose anchor silently stopped matching would "pass" while
 * testing nothing — the exact failure mode that let the old guard ship.
 */
function mutate(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) {
    throw new Error(`mutation anchor not found in template-store.ts: ${anchor}`);
  }
  return source.replace(anchor, replacement);
}

/**
 * Write one row through an **already-open** connection, so the transaction is
 * created synchronously at the call site. `putTemplate` cannot be used where
 * ordering matters: it opens its own connection first, and that async hop is
 * enough for a concurrent backfill's write to slip in ahead of it.
 */
function putRaw(db: IDBDatabase, record: StoredTemplateRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction("templates", "readwrite");
    t.objectStore("templates").put(record);
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error);
    t.onerror = () => reject(t.error);
  });
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

  it("never lets a slow backfill roll a newer upload back to the migrated bytes", async () => {
    // THE DATA-LOSS RACE, reproduced.
    //
    // Hashing needs an await, so phase 2 necessarily holds a stale snapshot by
    // the time it writes. Two panels are open; both find row K pending and both
    // start hashing it. Panel A finishes, the user REPLACES that template with a
    // new upload — and panel B then writes its pre-replacement snapshot back.
    //
    // The rollback is completely silent: the old bytes and the old hash B
    // carries agree with each other, so `getBytes`' integrity check accepts the
    // resurrected template and the user simply finds an old file in their
    // export. Nothing surfaces an error, ever.
    const { buffer: oldBuffer } = docxBytes();
    await seedV1({ name: "handbook.docx", buffer: oldBuffer, uploadedAt: 1 });

    const panelA = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    const panelB = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    try {
      const [pending] = await readPending(panelB);
      expect(pending.sha256).toBeNull();

      const replacement = buildDocx({ body: para("a completely different template") });
      const newBuffer = replacement.buffer.slice(
        replacement.byteOffset,
        replacement.byteOffset + replacement.byteLength
      ) as ArrayBuffer;
      expect(new Uint8Array(newBuffer)).not.toEqual(new Uint8Array(oldBuffer));

      const { migrationPending: _cleared, ...completedRow } = pending;
      const replacement_row: StoredTemplateRecord = {
        ...completedRow,
        bytes: newBuffer,
        size: newBuffer.byteLength,
        sha256: await sha256Of(new Uint8Array(newBuffer)),
      };

      // The interleaving is deterministic, not a sleep: IndexedDB runs
      // overlapping transactions in creation order. B's READ transaction is
      // created synchronously inside `runMigrationBackfill`, so it goes first;
      // the replacement transaction is created synchronously on the next line,
      // so it goes second; B's WRITE transaction is only created after its
      // `await sha256Hex(...)` resolves, so it necessarily goes last.
      const stale = runMigrationBackfill(panelB);
      await putRaw(panelA, replacement_row);

      // B must notice the row is no longer the one it hashed and skip it.
      expect(await stale).toBe(0);

      const [row] = await readAll<StoredTemplateRecord>(panelA, "templates");
      expect(new Uint8Array(row.bytes)).toEqual(new Uint8Array(newBuffer));
      expect(row.sha256).toBe(await sha256Of(new Uint8Array(newBuffer)));
      expect(row.size).toBe(newBuffer.byteLength);
      expect(row.migrationPending).toBeUndefined();
    } finally {
      panelA.close();
      panelB.close();
    }
  });

  it("lets two concurrent backfills of an untouched row converge without corrupting it", async () => {
    // The compare-and-swap must not break the ordinary two-panel case: exactly
    // one run completes the row, the other finds the work already done, and the
    // stored bytes and hash are correct either way.
    const { bytes, buffer } = docxBytes();
    await seedV1({ name: "handbook.docx", buffer, uploadedAt: 3 });

    const panelA = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    const panelB = await openTemplateDb(factory, { siteOrigin: SITE, skipBackfill: true });
    try {
      const counts = await Promise.all([
        runMigrationBackfill(panelA),
        runMigrationBackfill(panelB),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);

      const rows = await readAll<StoredTemplateRecord>(panelA, "templates");
      expect(rows).toHaveLength(1);
      expect(rows[0].sha256).toBe(await sha256Of(bytes));
      expect(new Uint8Array(rows[0].bytes)).toEqual(new Uint8Array(bytes));
      expect(rows[0].migrationPending).toBeUndefined();
    } finally {
      panelA.close();
      panelB.close();
    }
  });

  it("waits out a blocked upgrade instead of failing it (and finishes the migration)", async () => {
    // A blocked open request is QUEUED, not failed — it proceeds by itself the
    // moment the older connection closes. Rejecting on `blocked` reported a
    // failure for an upgrade that then went on to succeed, skipped phase 2 for
    // it, and leaked the connection that eventually opened (which in turn
    // blocks the NEXT upgrade).
    const { bytes, buffer } = docxBytes();
    await seedV1({ name: "blocked.docx", buffer, uploadedAt: 17 });

    // A second panel still holding the v1 connection open.
    const otherPanel = await openLegacyV1Connection(factory);
    const opening = openTemplateDb(factory, { siteOrigin: SITE });

    // Let the open request reach `blocked`, then let the other panel go.
    await new Promise((r) => setTimeout(r, 20));
    otherPanel.close();

    const db = await opening;
    try {
      expect(db.version).toBe(2);
      const rows = await readAll<StoredTemplateRecord>(db, "templates");
      expect(rows).toHaveLength(1);
      // Phase 2 ran: the row a rejected open would have left half-migrated.
      expect(rows[0].sha256).toBe(await sha256Of(bytes));
      expect(rows[0].migrationPending).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("closes its own connection when another tab needs a newer version", async () => {
    // MDN's multi-tab requirement: without an `onversionchange` handler our
    // connection blocks every future upgrade indefinitely.
    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        const req = factory.open(DB_NAME, 3);
        req.onupgradeneeded = () => {
          /* schema irrelevant — only whether we get here at all matters */
        };
        req.onblocked = () => resolve("blocked");
        req.onsuccess = () => {
          req.result.close();
          resolve("opened");
        };
        req.onerror = () => reject(req.error);
      });
      expect(outcome).toBe("opened");
    } finally {
      db.close();
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
    // WHY THIS IS A SOURCE-LEVEL CHECK, not a behavioural one: see the module
    // docstring of `phase1-sync-guard.ts`. `fake-indexeddb` does not model the
    // auto-commit that makes an awaiting upgrade handler fatal in Chrome, so no
    // behavioural test can catch this regression — only the source can.
    const { violations, reached } = findPhase1AsyncViolations(storeSource());

    expect(violations).toEqual([]);
    // The walk must actually have gone somewhere. Without this, a guard that
    // resolved nothing would report a clean bill of health forever.
    expect(reached).toContain("upgradeSync");
    expect(reached).toContain("createTemplatesStore");
    expect(reached).toContain("ensureIndexes");
    expect(reached).toContain("toPendingRecord");
    expect(reached).toContain("buildRecordKey");
    expect(reached).toContain("normalizeSiteOrigin");
    // Reached transitively through `buildRecordKey` → `joinKeySegments`, i.e.
    // via helpers no hard-coded name list mentions.
    expect(reached).toContain("joinKeySegments");
    expect(reached).toContain("encodeKeySegment");
  });

  describe("the phase-1 guard itself (mutation tests)", () => {
    // The previous guard matched six hard-coded top-level `function` names with
    // a hand-rolled brace matcher, so every route below walked straight past
    // it while it reported success. A guard nobody has watched fail is not a
    // guard, so each evasion route gets sabotaged source and must be caught.

    it("catches an awaiting `const` arrow helper called from phase 1", () => {
      const sabotaged = mutate(
        mutate(
          storeSource(),
          "function upgradeSync(db: IDBDatabase, upgradeTx: IDBTransaction, siteOrigin: string): void {",
          "const sneakyArrow = async (value: string): Promise<string> => {\n" +
            "  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));\n" +
            "  return value;\n" +
            "};\n\n" +
            "function upgradeSync(db: IDBDatabase, upgradeTx: IDBTransaction, siteOrigin: string): void {"
        ),
        "  if (!db.objectStoreNames.contains(PREFS_STORE)) {",
        "  void sneakyArrow(siteOrigin);\n  if (!db.objectStoreNames.contains(PREFS_STORE)) {"
      );

      const { violations, reached } = findPhase1AsyncViolations(sabotaged);
      expect(reached).toContain("sneakyArrow");
      expect(violations.join("\n")).toMatch(/sneakyArrow (awaits|contains an async function)/);
    });

    it("catches an imported helper called from phase 1", () => {
      const sabotaged = mutate(
        mutate(
          storeSource(),
          "const DB_NAME = ",
          'import { sha256Hex as importedHash } from "@atlcli/core";\n\nconst DB_NAME = '
        ),
        "  const templateId = crypto.randomUUID();",
        "  const templateId = crypto.randomUUID();\n  void importedHash(new Uint8Array(bytes));"
      );

      const { violations } = findPhase1AsyncViolations(sabotaged);
      expect(violations.join("\n")).toMatch(/calls imported `importedHash\(\)`/);
    });

    it("catches an awaiting function whose name is on no list", () => {
      const sabotaged = mutate(
        mutate(
          storeSource(),
          "function ensureIndexes(store: IDBObjectStore): void {",
          "async function nameNobodyListed(store: IDBObjectStore): Promise<void> {\n" +
            "  await crypto.subtle.digest('SHA-256', new Uint8Array(1));\n" +
            "  store.createIndex('x', 'x');\n" +
            "}\n\n" +
            "function ensureIndexes(store: IDBObjectStore): void {"
        ),
        '  for (const name of ["engine", "scope", "spaceKey", "migrationPending"] as const) {',
        '  void nameNobodyListed(store);\n  for (const name of ["engine", "scope", "spaceKey", "migrationPending"] as const) {'
      );

      const { violations, reached } = findPhase1AsyncViolations(sabotaged);
      expect(reached).toContain("nameNobodyListed");
      expect(violations.join("\n")).toMatch(/nameNobodyListed (awaits|contains an async function)/);
    });

    it("catches an await hidden behind a `}` inside a string literal", () => {
      // The old brace matcher stopped at the first unbalanced `}` it saw, even
      // inside a string, and so scanned only a truncated prefix of the body.
      const sabotaged = mutate(
        storeSource(),
        "  const existing = upgradeTx.objectStore(STORE);",
        '  const brace = "}";\n' +
          "  void brace;\n" +
          "  const existing = upgradeTx.objectStore(STORE);"
      ).replace(
        "    const legacy = (readAll.result ?? []) as LegacyTemplateRecord[];",
        "    const legacy = (readAll.result ?? []) as LegacyTemplateRecord[];\n" +
          "    void crypto.subtle.digest('SHA-256', new Uint8Array(1)).then(() => undefined);"
      );

      const { violations } = findPhase1AsyncViolations(sabotaged);
      expect(violations.join("\n")).toMatch(/chains a promise via \.then\(\)|unrecognised method/);
    });

    it("fails loudly when the entry point disappears instead of reporting success", () => {
      const sabotaged = storeSource().replace(/req\.onupgradeneeded/g, "req.onUpgradeRenamed");
      const { violations } = findPhase1AsyncViolations(sabotaged);
      expect(violations.join("\n")).toMatch(/entry point/);
    });

    it("does not fire on the unmodified source (no false positive)", () => {
      expect(findPhase1AsyncViolations(storeSource()).violations).toEqual([]);
    });
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
