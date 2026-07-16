/**
 * Template store round-trip against a REAL in-memory IndexedDB
 * (`fake-indexeddb`) — spec-complete transactions/cursors, not a stub. Each test
 * gets a fresh factory for isolation.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  putTemplate,
  type StoredTemplate,
} from "../../utils/docx/template-store.js";
import { buildDocx, para } from "./fixtures.js";
import { scanTemplate } from "../../utils/docx/scan.js";

let factory: IDBFactory;

beforeEach(() => {
  // Fresh database per test.
  factory = new IDBFactory();
});

function makeStored(id: string, name: string): StoredTemplate {
  const bytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
  return {
    id,
    name,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    uploadedAt: Date.now(),
  };
}

describe("template store (fake-indexeddb)", () => {
  it("persists a template and reads it back across reopen", async () => {
    const stored = makeStored("current", "mayflower.docx");
    await putTemplate(stored, factory);

    const back = await getTemplate("current", factory);
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

  it("replaces an existing template in the same slot", async () => {
    await putTemplate(makeStored("current", "old.docx"), factory);
    await putTemplate(makeStored("current", "new.docx"), factory);
    const back = await getTemplate("current", factory);
    expect(back!.name).toBe("new.docx");
    const all = await listTemplates(factory);
    expect(all.length).toBe(1);
  });

  it("deletes a template", async () => {
    await putTemplate(makeStored("current", "gone.docx"), factory);
    await deleteTemplate("current", factory);
    expect(await getTemplate("current", factory)).toBeUndefined();
    expect(await listTemplates(factory)).toHaveLength(0);
  });

  it("returns undefined for a missing template", async () => {
    expect(await getTemplate("nope", factory)).toBeUndefined();
  });

  it("rejects when the transaction aborts at commit time, not resolving on request success (#13)", async () => {
    // Wrap the factory so that every write transaction aborts right AFTER its
    // request succeeds. With the old code (resolve on request.onsuccess) this
    // resolved despite the rollback; the fix waits for `oncomplete` and rejects
    // on `onabort`.
    const aborting = commitAbortFactory(factory);
    await expect(putTemplate(makeStored("current", "doomed.docx"), aborting)).rejects.toBeDefined();
    // Nothing was committed.
    expect(await getTemplate("current", factory)).toBeUndefined();
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
