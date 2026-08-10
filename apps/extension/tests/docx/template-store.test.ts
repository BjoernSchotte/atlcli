/**
 * Template store round-trip against a REAL in-memory IndexedDB
 * (`fake-indexeddb`) — spec-complete transactions/cursors, not a stub. Each test
 * gets a fresh factory for isolation.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  buildPrefsKey,
  buildRecordKey,
  deleteTemplate,
  getTemplate,
  getTemplatePrefs,
  listTemplates,
  putTemplate,
  putTemplatePrefs,
  type StoredTemplateRecord,
} from "../../utils/docx/template-store.js";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { scanTemplate } from "@atlcli/docx/scan";

const SITE = "https://tenant-a.atlassian.net";

let factory: IDBFactory;

beforeEach(() => {
  // Fresh database per test.
  factory = new IDBFactory();
});

function makeStored(
  name: string,
  overrides: Partial<StoredTemplateRecord> = {}
): StoredTemplateRecord {
  const bytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const templateId = overrides.templateId ?? "tpl-1";
  const scope = overrides.scope ?? "global";
  return {
    recordKey: buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId,
      scope,
      spaceKey: overrides.spaceKey,
    }),
    templateId,
    siteOrigin: SITE,
    displayName: name,
    engine: "docx",
    scope,
    name,
    bytes: buffer,
    uploadedAt: Date.now(),
    sha256: "0".repeat(64),
    size: buffer.byteLength,
    ...overrides,
  };
}

describe("template store (fake-indexeddb)", () => {
  it("persists a template and reads it back across reopen", async () => {
    const stored = makeStored("mayflower.docx");
    await putTemplate(stored, factory);

    const back = await getTemplate(stored.recordKey, factory);
    expect(back).toBeDefined();
    expect(back!.name).toBe("mayflower.docx");
    // The scan is NOT persisted — it is re-derived from the bytes on read, so a
    // classification change can never leave a stale verdict in the store.
    expect(back as unknown as { scan?: unknown }).not.toHaveProperty("scan");
    // Bytes survive the round-trip and re-unzip, which is what the scan needs.
    const reBytes = new Uint8Array(back!.bytes);
    expect(reBytes.byteLength).toBe(new Uint8Array(stored.bytes).byteLength);
    const rescan = scanTemplate(reBytes);
    expect(rescan.hasContentPlaceholder).toBe(true);
    expect(rescan.supported.map((h) => h.base)).toContain("$scroll.title");
  });

  it("replaces an existing template under the same recordKey", async () => {
    const key = buildRecordKey({
      siteOrigin: SITE,
      engine: "docx",
      templateId: "tpl-1",
      scope: "global",
    });
    await putTemplate(makeStored("old.docx"), factory);
    await putTemplate(makeStored("new.docx"), factory);
    const back = await getTemplate(key, factory);
    expect(back!.name).toBe("new.docx");
    const all = await listTemplates(factory);
    expect(all.length).toBe(1);
  });

  it("keeps a global entry and its space override as two rows (the recordKey split)", async () => {
    // The whole point of `keyPath: "recordKey"`: with `keyPath: "id"` the second
    // put would have REPLACED the first, because both carry the same logical
    // templateId — and "space beats global" could never be exercised.
    const global = makeStored("handbook.docx", { templateId: "shared" });
    const override = makeStored("handbook.docx", {
      templateId: "shared",
      scope: "space",
      spaceKey: "DOCSY",
    });
    expect(override.recordKey).not.toBe(global.recordKey);

    await putTemplate(global, factory);
    await putTemplate(override, factory);

    const all = await listTemplates(factory);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.templateId)).toEqual(["shared", "shared"]);
    expect(all.map((r) => r.scope).sort()).toEqual(["global", "space"]);
  });

  it("deletes a template", async () => {
    const stored = makeStored("gone.docx");
    await putTemplate(stored, factory);
    await deleteTemplate(stored.recordKey, factory);
    expect(await getTemplate(stored.recordKey, factory)).toBeUndefined();
    expect(await listTemplates(factory)).toHaveLength(0);
  });

  it("returns undefined for a missing template", async () => {
    expect(await getTemplate("nope", factory)).toBeUndefined();
  });

  it("round-trips a template-prefs record (active selection + settings values)", async () => {
    const recordKey = buildPrefsKey({ siteOrigin: SITE, engine: "docx", spaceKey: "DOCSY" });
    expect(recordKey).toBe(`${SITE}|docx|DOCSY`);
    await putTemplatePrefs(
      {
        recordKey,
        siteOrigin: SITE,
        engine: "docx",
        spaceKey: "DOCSY",
        activeTemplateId: "tpl-1",
        settingsByTemplateId: { "tpl-1": { watermark: "DRAFT", cover: true, margin: 2 } },
        updatedAt: 1,
      },
      factory
    );

    const back = await getTemplatePrefs(recordKey, factory);
    expect(back!.activeTemplateId).toBe("tpl-1");
    expect(back!.settingsByTemplateId!["tpl-1"]).toEqual({
      watermark: "DRAFT",
      cover: true,
      margin: 2,
    });
  });

  it("rejects when the transaction aborts at commit time, not resolving on request success (#13)", async () => {
    // Wrap the factory so that every write transaction aborts right AFTER its
    // request succeeds. With the old code (resolve on request.onsuccess) this
    // resolved despite the rollback; the fix waits for `oncomplete` and rejects
    // on `onabort`.
    const stored = makeStored("doomed.docx");
    const aborting = commitAbortFactory(factory);
    await expect(putTemplate(stored, aborting)).rejects.toBeDefined();
    // Nothing was committed.
    expect(await getTemplate(stored.recordKey, factory)).toBeUndefined();
  });
});

/** An IDBFactory wrapper whose write transactions abort after the put succeeds. */
function commitAbortFactory(real: IDBFactory): IDBFactory {
  const open: IDBFactory["open"] = (name, version) => {
    const req = real.open(name as string, version as number | undefined);
    req.addEventListener("success", () => {
      const db = req.result;
      const origTransaction = db.transaction.bind(db);
      (db as unknown as { transaction: IDBDatabase["transaction"] }).transaction = ((
        ...args: Parameters<IDBDatabase["transaction"]>
      ) => {
        const t = origTransaction(...args);
        if (t.mode === "readwrite") {
          const origObjectStore = t.objectStore.bind(t);
          (t as unknown as { objectStore: IDBTransaction["objectStore"] }).objectStore = ((
            storeName: string
          ) => {
            const store = origObjectStore(storeName);
            const origPut = store.put.bind(store);
            (store as unknown as { put: IDBObjectStore["put"] }).put = ((
              ...putArgs: Parameters<IDBObjectStore["put"]>
            ) => {
              const putReq = origPut(...putArgs);
              // Abort the moment the write succeeds → commit-time rollback.
              putReq.addEventListener("success", () => t.abort());
              return putReq;
            }) as IDBObjectStore["put"];
            return store;
          }) as IDBTransaction["objectStore"];
        }
        return t;
      }) as IDBDatabase["transaction"];
    });
    return req;
  };
  return {
    open,
    deleteDatabase: real.deleteDatabase.bind(real),
    cmp: real.cmp.bind(real),
  } as IDBFactory;
}
