import { IndexedDbExportByteStore } from "../../../utils/export-jobs/chunk-store.js";
import {
  EXTENSION_EXPORT_BYTE_CHUNKS_STORE,
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  openExtensionExportDb,
  IndexedDbExportJobCatalog,
} from "../../../utils/export-jobs/catalog.js";
import { chromeDurableJobsStore } from "../../../utils/jobs/store.js";

async function* bytes(size: number, failAfterFirst = false): AsyncIterable<Uint8Array> {
  const first = new Uint8Array(Math.min(size, 1024));
  first.fill(7);
  yield first;
  if (failAfterFirst) throw new Error("injected source abort");
  let remaining = size - first.byteLength;
  while (remaining > 0) {
    const chunk = new Uint8Array(Math.min(remaining, 1024));
    chunk.fill(7);
    yield chunk;
    remaining -= chunk.byteLength;
  }
}

async function counts(): Promise<{ objects: number; chunks: number }> {
  const db = await openExtensionExportDb();
  try {
    const tx = db.transaction([EXTENSION_EXPORT_BYTE_OBJECTS_STORE, EXTENSION_EXPORT_BYTE_CHUNKS_STORE], "readonly");
    const objects = await new Promise<number>((resolve, reject) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const chunks = await new Promise<number>((resolve, reject) => {
      const request = tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { objects, chunks };
  } finally {
    db.close();
  }
}

const probe = {
  async write(id: string, size: number, failAfterFirst = false, totalLimit = size + 1): Promise<string> {
    const store = new IndexedDbExportByteStore({ chunkBytes: 1024 });
    const result = await store.put(
      { jobId: id, leaseEpoch: 1, namespace: "packed", key: "payload" },
      bytes(size, failAfterFirst),
      { maxObjectBytes: size + 1, maxJobBytes: size + 1, maxTotalBytes: totalLimit },
    );
    return result.sha256;
  },
  counts,
  async cleanup(id: string): Promise<void> {
    await new IndexedDbExportByteStore().cleanupJob(id);
  },
  async abortTransaction(id: string): Promise<{
    aborted: boolean;
    counts: { objects: number; chunks: number };
  }> {
    const db = await openExtensionExportDb();
    let aborted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [EXTENSION_EXPORT_BYTE_OBJECTS_STORE, EXTENSION_EXPORT_BYTE_CHUNKS_STORE],
          "readwrite",
        );
        tx.onabort = () => {
          aborted = true;
          resolve();
        };
        tx.onerror = () => {
          // The explicit abort is the expected terminal event; suppress the
          // request-level bubbling and let onabort settle the probe.
        };
        tx.oncomplete = () => reject(new Error("The injected IndexedDB transaction unexpectedly committed."));

        const objectId = `native-abort:${id}`;
        const addObject = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).add({
          id: objectId,
          kind: "spool",
          state: "writing",
          jobId: id,
          leaseEpoch: 1,
          namespace: "packed",
          key: "native-abort",
          byteLength: 3,
          chunkCount: 1,
          createdAt: Date.now(),
        });
        addObject.onerror = () => reject(addObject.error);
        addObject.onsuccess = () => {
          const addChunk = tx.objectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE).add({
            objectId,
            index: 0,
            bytes: Uint8Array.from([1, 2, 3]),
          });
          addChunk.onerror = () => reject(addChunk.error);
          addChunk.onsuccess = () => tx.abort();
        };
      });
    } finally {
      db.close();
    }
    return { aborted, counts: await counts() };
  },
  async bridge(legacyJobId: string, outerJobId: string, outerLeaseEpoch: number): Promise<void> {
    await new IndexedDbExportJobCatalog().putLegacyBridge({
      legacyJobId,
      outerJobId,
      outerLeaseEpoch,
      hidden: true,
      createdAt: Date.now(),
    });
  },
  async activityKeys(): Promise<string[]> {
    return (await chromeDurableJobsStore().list()).map((row) => row.id);
  },
};

(globalThis as unknown as { exportJobStoreProbe: typeof probe }).exportJobStoreProbe = probe;
