import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  EXTENSION_EXPORT_BYTE_CHUNKS_STORE,
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  openExtensionExportDb,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { IncrementalSha256 } from "../../utils/export-jobs/sha256.js";

globalThis.IDBKeyRange = IDBKeyRange;

let factory: IDBFactory;
let serial = 0;

beforeEach(() => {
  factory = new IDBFactory();
  serial = 0;
});

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function readAll(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of source) result.push(...chunk);
  return result;
}

const ref = { jobId: "job-1", leaseEpoch: 1, namespace: "pages", key: "page-1" };
const limits = { maxObjectBytes: 16, maxJobBytes: 32, maxTotalBytes: 64 };

describe("IndexedDbExportByteStore", () => {
  it("hashes incrementally and persists exact-owned chunks for typed-array subviews", async () => {
    const backing = new Uint8Array(1024 * 1024);
    backing.set([97, 98, 99], 100);
    const view = backing.subarray(100, 103);
    const store = new IndexedDbExportByteStore({
      factory,
      chunkBytes: 2,
      now: () => 10,
      randomUUID: () => `id-${++serial}`,
    });
    const metadata = await store.put(ref, chunks(view), limits);
    expect(metadata).toMatchObject({ byteLength: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(await readAll(store.read(ref))).toEqual([97, 98, 99]);

    const db = await openExtensionExportDb({ factory });
    const tx = db.transaction(EXTENSION_EXPORT_BYTE_CHUNKS_STORE, "readonly");
    const rows = await new Promise<Array<{ bytes: Uint8Array }>>((resolve, reject) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(rows.map((row) => row.bytes.buffer.byteLength)).toEqual([2, 1]);
  });

  it("rejects conflicting bytes when a committed spool ref is reused", async () => {
    const store = new IndexedDbExportByteStore({
      factory,
      chunkBytes: 2,
      now: () => 10,
      randomUUID: () => `id-${++serial}`,
    });
    await store.put(ref, chunks(Uint8Array.from([1])), limits);
    let pulled = false;

    await expect(store.put(ref, (async function* () {
      pulled = true;
      yield Uint8Array.from([2]);
    })(), limits)).rejects.toMatchObject({ code: "ownership-mismatch" });

    expect(pulled).toBe(true);
    expect(await readAll(store.read(ref))).toEqual([1]);
  });

  it("leaves no visible object or chunks after quota failure", async () => {
    const store = new IndexedDbExportByteStore({ factory, chunkBytes: 2, randomUUID: () => `id-${++serial}` });
    await expect(store.put(ref, chunks(Uint8Array.from([1, 2, 3])), {
      maxObjectBytes: 2,
      maxJobBytes: 2,
      maxTotalBytes: 2,
    })).rejects.toMatchObject({ code: "object-limit" });
    expect(await store.stat(ref)).toBeUndefined();

    const db = await openExtensionExportDb({ factory });
    const tx = db.transaction([EXTENSION_EXPORT_BYTE_OBJECTS_STORE, EXTENSION_EXPORT_BYTE_CHUNKS_STORE], "readonly");
    const objects = await new Promise<unknown[]>((resolve) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
    });
    const storedChunks = await new Promise<unknown[]>((resolve) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    expect(objects).toEqual([]);
    expect(storedChunks).toEqual([]);
  });

  it("stages one deterministic artifact and keeps it unreadable until finalization", async () => {
    const store = new IndexedDbExportByteStore({ factory, chunkBytes: 1, now: () => 20, randomUUID: () => `id-${++serial}` });
    const staged = await store.stage("job-1", 1, {
      mediaType: "application/pdf",
      filename: "export.pdf",
      byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: chunks(Uint8Array.from([97, 98]), Uint8Array.from([99])),
    });
    expect(staged.ref).toBe("artifact:5:job-1:1");
    expect(await store.getStaged("job-1", 1)).toEqual(staged);
    await expect(readAll(store.read(staged.ref))).rejects.toMatchObject({ code: "not-committed" });

    const replay = await store.stage("job-1", 1, {
      mediaType: "application/pdf",
      filename: "export.pdf",
      byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: chunks(Uint8Array.from([97]), Uint8Array.from([98, 99])),
    });
    expect(replay).toEqual(staged);

    const db = await openExtensionExportDb({ factory });
    const tx = db.transaction(EXTENSION_EXPORT_BYTE_OBJECTS_STORE, "readonly");
    const count = await new Promise<number>((resolve, reject) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).index("jobEpoch").count(["job-1", 1]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(count).toBe(1);
  });

  it("durably closes abandoned epochs and tombstoned jobs against late writers", async () => {
    const store = new IndexedDbExportByteStore({ factory, chunkBytes: 1, now: () => 20, randomUUID: () => `id-${++serial}` });
    const epochOne = { ...ref, key: "epoch-one" };
    const epochTwo = { ...ref, leaseEpoch: 2, key: "epoch-two" };
    await store.put(epochOne, chunks(Uint8Array.from([1])), limits);
    await store.put(epochTwo, chunks(Uint8Array.from([2])), limits);

    expect(await store.listNamespaceRefs("job-1", 1)).toEqual([epochOne]);
    expect(await store.deleteNamespace("job-1", 1)).toEqual({ objectsDeleted: 1, bytesDeleted: 1 });
    expect(await store.stat(epochOne)).toBeUndefined();
    expect(await store.stat(epochTwo)).toBeDefined();
    await expect(store.put(epochOne, chunks(Uint8Array.from([3])), limits)).rejects.toMatchObject({ code: "ownership-mismatch" });

    const preserved = { ...ref, leaseEpoch: 3, key: "checkpoint" };
    await store.put(preserved, chunks(Uint8Array.from([5])), limits);
    await store.deleteNamespace("job-1", 3, { preserve: [preserved] });
    expect(await store.stat(preserved)).toBeDefined();
    await expect(store.put(preserved, chunks(Uint8Array.from([5])), limits)).rejects.toMatchObject({ code: "ownership-mismatch" });

    await store.deleteStagedEpoch("artifact-job", 1);
    await expect(store.stage("artifact-job", 1, {
      mediaType: "application/pdf",
      filename: "late.pdf",
      byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: chunks(Uint8Array.from([97, 98, 99])),
    })).rejects.toMatchObject({ code: "ownership-mismatch" });

    await store.cleanupJob("closed-job");
    await expect(store.put(
      { jobId: "closed-job", leaseEpoch: 9, namespace: "pages", key: "late" },
      chunks(Uint8Array.from([4])),
      limits,
    )).rejects.toMatchObject({ code: "ownership-mismatch" });
  });

  it("deletes chunks through a key cursor without materializing stored byte values", async () => {
    const store = new IndexedDbExportByteStore({ factory, chunkBytes: 1, randomUUID: () => `id-${++serial}` });
    await store.put(ref, chunks(Uint8Array.from([1, 2, 3, 4])), limits);

    const db = await openExtensionExportDb({ factory });
    const index = db.transaction(EXTENSION_EXPORT_BYTE_CHUNKS_STORE, "readonly")
      .objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE)
      .index("objectId");
    const prototype = Object.getPrototypeOf(index) as { getAll: IDBIndex["getAll"] };
    const original = prototype.getAll;
    prototype.getAll = () => {
      throw new Error("chunk byte values must not be materialized during cleanup");
    };
    db.close();
    try {
      expect(await store.cleanupJob(ref.jobId)).toEqual({ objectsDeleted: 1, bytesDeleted: 4 });
    } finally {
      prototype.getAll = original;
    }
  });
});

describe("IncrementalSha256", () => {
  it("matches the SHA-256 known vector across chunk boundaries", () => {
    const sha = new IncrementalSha256();
    sha.update(Uint8Array.from([97]));
    sha.update(Uint8Array.from([98, 99]));
    expect(sha.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
