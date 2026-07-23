import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  PDF_JOB_MAX_BYTES,
  PDF_STORE_MAX_BYTES,
  cancelPdfJob,
  claimPdfJob,
  cleanupPdfJobs,
  completePdfJob,
  createPdfJobId,
  deletePdfJob,
  getPdfJob,
  getPdfJobMeta,
  putPdfJob,
  openPdfJobDb,
} from "../../utils/pdf/job-store.js";

globalThis.IDBKeyRange = IDBKeyRange;

let factory: IDBFactory;
const id = "123e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  factory = new IDBFactory();
});

function bundle(size = 4): PdfSourceBundle {
  return {
    main: "= Job",
    template: "template",
    assets: [{ path: "assets/a.png", mediaType: "image/png", bytes: new Uint8Array(size) }],
    sourceMap: [],
    notes: [],
  };
}

/**
 * Open the raw database and record which object stores each transaction names.
 *
 * This is how the "no payload read" guarantees below are asserted: a store that
 * is not in a transaction's scope cannot be read by it, so proving the payload
 * stores are absent from a transaction proves no payload was materialized —
 * stronger than counting bytes, and not dependent on a GC.
 */
async function spyOnTransactions(): Promise<{ scopes: string[][]; restore: () => void }> {
  const scopes: string[][] = [];
  const db = await openPdfJobDb(factory);
  const proto = Object.getPrototypeOf(db) as IDBDatabase;
  const original = proto.transaction;
  proto.transaction = function patched(
    this: IDBDatabase,
    names: string | string[],
    ...rest: unknown[]
  ) {
    scopes.push(typeof names === "string" ? [names] : [...names]);
    return (original as (...args: unknown[]) => IDBTransaction).call(this, names, ...rest);
  } as typeof proto.transaction;
  db.close();
  return { scopes, restore: () => { proto.transaction = original; } };
}

async function spyOnBundleReads(): Promise<{ count: () => number; restore: () => void }> {
  let reads = 0;
  const db = await openPdfJobDb(factory);
  const store = db.transaction("bundles", "readonly").objectStore("bundles");
  const proto = Object.getPrototypeOf(store) as IDBObjectStore;
  const original = proto.get;
  proto.get = function patched(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    if (this.name === "bundles") reads += 1;
    return original.call(this, query);
  };
  db.close();
  return { count: () => reads, restore: () => { proto.get = original; } };
}

describe("PDF job store", () => {
  it("stores, claims and completes a binary job", async () => {
    await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle() }, factory);
    expect((await getPdfJob(id, factory))?.status).toBe("prepared");
    expect((await claimPdfJob(id, factory))?.status).toBe("compiling");
    await completePdfJob(id, {
      pdf: new Uint8Array([37, 80, 68, 70]),
      diagnostics: [],
      compilerVersion: "test",
    }, factory);
    const result = await getPdfJob(id, factory);
    expect(result?.status).toBe("complete");
    expect([...result!.pdf!]).toEqual([37, 80, 68, 70]);
  });

  it("gives a legacy PDF job to exactly one compiler", async () => {
    await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle() }, factory);
    const spy = await spyOnBundleReads();
    let first;
    let second;
    try {
      [first, second] = await Promise.all([
        claimPdfJob(id, factory),
        claimPdfJob(id, factory),
      ]);
    } finally {
      spy.restore();
    }
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter(Boolean)[0]?.status).toBe("compiling");
    expect(spy.count()).toBe(1);
  });

  it("accepts an opaque common parent id for a private compiler record", async () => {
    await putPdfJob({
      id,
      sourceIdentity: "page:1",
      bundle: bundle(),
      activityVisibility: "private",
      parentJobId: "job-1",
      parentLeaseEpoch: 1,
    }, factory);

    expect(await getPdfJobMeta(id, factory)).toMatchObject({
      activityVisibility: "private",
      parentJobId: "job-1",
      parentLeaseEpoch: 1,
    });
  });

  it("does not resurrect a deleted or cancelled job on late completion", async () => {
    await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle() }, factory);
    await claimPdfJob(id, factory);
    await deletePdfJob(id, factory);
    expect(await completePdfJob(id, { pdf: new Uint8Array([1]), diagnostics: [], compilerVersion: "test" }, factory)).toBeUndefined();
    expect(await getPdfJob(id, factory)).toBeUndefined();

    const id2 = "223e4567-e89b-42d3-a456-426614174000";
    await putPdfJob({ id: id2, sourceIdentity: "page:2", bundle: bundle() }, factory);
    await claimPdfJob(id2, factory);
    await cancelPdfJob(id2, factory);
    await completePdfJob(id2, { pdf: new Uint8Array([1]), diagnostics: [], compilerVersion: "test" }, factory);
    expect((await getPdfJob(id2, factory))?.status).toBe("cancelled");
  });

  it("rejects oversized input before writing", async () => {
    await expect(
      putPdfJob({ id, sourceIdentity: "large", bundle: bundle(PDF_JOB_MAX_BYTES + 1) }, factory)
    ).rejects.toThrow("job limit");
    expect(await getPdfJob(id, factory)).toBeUndefined();
  });

  it("enforces the total store quota before accepting another job", async () => {
    const db = await openPdfJobDb(factory);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["jobs", "bundles"], "readwrite");
      tx.objectStore("jobs").add({
        id: "423e4567-e89b-42d3-a456-426614174000",
        sourceIdentity: "seed",
        // FRESH, deliberately. `createdAt: 1` is 1970 — long past
        // `PDF_JOB_MAX_AGE_MS` — and T5.6's eviction policy evicts an expired
        // record rather than rejecting the caller, so the old fixture stopped
        // describing the rule this test is about.
        createdAt: Date.now(),
        status: "prepared",
        inputBytes: PDF_STORE_MAX_BYTES,
        outputBytes: 0,
      });
      tx.objectStore("bundles").add({ id: "423e4567-e89b-42d3-a456-426614174000", bundle: bundle() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await expect(
      putPdfJob({ id, sourceIdentity: "over-total", bundle: bundle() }, factory)
    ).rejects.toThrow("total quota");
  });

  it("keeps source bundles isolated by unguessable job id", async () => {
    const other = "523e4567-e89b-42d3-a456-426614174000";
    await putPdfJob({ id, sourceIdentity: "page:a", bundle: bundle(3) }, factory);
    await putPdfJob({ id: other, sourceIdentity: "page:b", bundle: bundle(7) }, factory);
    expect((await getPdfJob(id, factory))?.bundle?.assets[0]?.bytes.byteLength).toBe(3);
    expect((await getPdfJob(other, factory))?.bundle?.assets[0]?.bytes.byteLength).toBe(7);
  });

  it("cleans stale jobs without touching fresh jobs", async () => {
    const fresh = "323e4567-e89b-42d3-a456-426614174000";
    await putPdfJob({ id, sourceIdentity: "old", bundle: bundle(), createdAt: 100 }, factory);
    await putPdfJob({ id: fresh, sourceIdentity: "fresh", bundle: bundle(), createdAt: 900 }, factory);
    expect(await cleanupPdfJobs({ now: 1_000, maxAgeMs: 500 }, factory)).toBe(1);
    expect(await getPdfJob(id, factory)).toBeUndefined();
    expect(await getPdfJob(fresh, factory)).toBeDefined();
  });

  it("validates generated UUIDs", () => {
    expect(createPdfJobId(() => id)).toBe(id);
    expect(() => createPdfJobId(() => "not-an-id")).toThrow("invalid UUID");
  });

  /**
   * Spec 010, T5.6 — the byte-handling contract of the meta/payload split.
   *
   * Measured defects these replace (`packages/pdf/scripts/bytes-memory.bench.ts`,
   * Bun 1.3.8 / JSC): the `getAll()` quota check cost +64.0 MiB of live heap on
   * an 8-job / 64 MiB store, and a single status transition cost +64.0 MiB on a
   * 32 MiB bundle. Both are +0.0 MiB with the split.
   */
  describe("byte handling (spec 010, T5.6)", () => {
    it("enforces PDF_STORE_MAX_BYTES without opening a payload store", async () => {
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(1024) }, factory);
      const spy = await spyOnTransactions();
      try {
        const other = "523e4567-e89b-42d3-a456-426614174000";
        await putPdfJob({ id: other, sourceIdentity: "page:2", bundle: bundle(1024) }, factory);
      } finally {
        spy.restore();
      }
      // Writing the new bundle needs the bundle store; the point is that the
      // quota is computed from `jobs` in that same transaction and the RESULT
      // store — where every finished PDF lives — is never in scope at all.
      expect(spy.scopes.every((scope) => !scope.includes("results"))).toBe(true);
    });

    it("computes the quota from meta records even when every payload is unreadable", async () => {
      // The strongest form of the guarantee: poison the payload stores so any
      // read of them throws, then exercise the quota paths.
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(2048) }, factory);
      await claimPdfJob(id, factory);

      const db = await openPdfJobDb(factory);
      const proto = Object.getPrototypeOf(db) as IDBDatabase;
      const original = proto.transaction;
      proto.transaction = function patched(
        this: IDBDatabase,
        names: string | string[],
        ...rest: unknown[]
      ) {
        const tx = (original as (...args: unknown[]) => IDBTransaction).call(this, names, ...rest);
        const getStore = tx.objectStore.bind(tx);
        tx.objectStore = ((name: string) => {
          if (name === "bundles") throw new Error("payload store must not be read for a quota check");
          return getStore(name);
        }) as typeof tx.objectStore;
        return tx;
      } as typeof proto.transaction;
      db.close();

      try {
        const completed = await completePdfJob(
          id,
          { pdf: new Uint8Array(64), diagnostics: [], compilerVersion: "test" },
          factory
        );
        expect(completed?.status).toBe("complete");
        expect(completed?.outputBytes).toBe(64);
      } finally {
        proto.transaction = original;
      }
    });

    it("does not rewrite the payload record on a status transition", async () => {
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(4096) }, factory);

      const readBundleRow = async (): Promise<unknown> => {
        const db = await openPdfJobDb(factory);
        try {
          return await new Promise((resolve, reject) => {
            const request = db.transaction("bundles", "readonly").objectStore("bundles").get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      };

      const before = (await readBundleRow()) as { bundle: PdfSourceBundle };
      const beforeBytes = new Uint8Array(before.bundle.assets[0]!.bytes);

      const claimed = await claimPdfJob(id, factory);
      expect(claimed?.status).toBe("compiling");
      expect((await getPdfJobMeta(id, factory))?.status).toBe("compiling");

      const after = (await readBundleRow()) as { bundle: PdfSourceBundle };
      // Byte-identical payload row, changed status row.
      expect(new Uint8Array(after.bundle.assets[0]!.bytes)).toEqual(beforeBytes);
      expect(after.bundle.assets[0]!.path).toBe(before.bundle.assets[0]!.path);
    });

    it("claims without putting the bundle back", async () => {
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(64) }, factory);
      const spy = await spyOnTransactions();
      try {
        await claimPdfJob(id, factory);
      } finally {
        spy.restore();
      }
      // The bundle store is in scope (the compiler needs the bundle READ), but
      // the transaction must be the only one and must not touch `results`.
      expect(spy.scopes).toEqual([["jobs", "bundles"]]);
    });

    it("cancelPdfJob releases the bundle, not only the status", async () => {
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(8192) }, factory);
      await claimPdfJob(id, factory);
      expect((await getPdfJob(id, factory))?.bundle).toBeDefined();

      const cancelled = await cancelPdfJob(id, factory);
      expect(cancelled?.status).toBe("cancelled");
      // The record survives (the re-attach UI must tell "cancelled" from
      // "never existed") but holds no bytes.
      const after = await getPdfJob(id, factory);
      expect(after?.status).toBe("cancelled");
      expect(after?.bundle).toBeUndefined();
      expect(after?.pdf).toBeUndefined();
      expect(after?.inputBytes).toBe(0);
      expect(after?.outputBytes).toBe(0);
    });

    it("frees the released bytes from the store quota immediately", async () => {
      // A cancelled job that still counted against the quota was the reason a
      // panel closed mid-export could wedge the store until the 24 h sweep.
      // The occupancy is seeded through the meta record rather than by
      // allocating 100 MiB of real buffers — which is only possible BECAUSE the
      // quota is now computed from meta records.
      const db = await openPdfJobDb(factory);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["jobs", "bundles"], "readwrite");
        tx.objectStore("jobs").add({
          id,
          sourceIdentity: "seed",
          // Fresh — see the note on the total-quota test: an expired record is
          // evicted rather than refused, which is a different rule from this one.
          createdAt: Date.now(),
          status: "prepared",
          inputBytes: PDF_STORE_MAX_BYTES - 16,
          outputBytes: 0,
        });
        tx.objectStore("bundles").add({ id, bundle: bundle() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();

      const other = "523e4567-e89b-42d3-a456-426614174000";
      await expect(
        putPdfJob({ id: other, sourceIdentity: "page:2", bundle: bundle(1024) }, factory)
      ).rejects.toThrow("total quota");

      await cancelPdfJob(id, factory);
      await expect(
        putPdfJob({ id: other, sourceIdentity: "page:2", bundle: bundle(1024) }, factory)
      ).resolves.toBeDefined();
    });

    it("deleting a job leaves no orphan payload behind", async () => {
      await putPdfJob({ id, sourceIdentity: "page:1", bundle: bundle(512) }, factory);
      await claimPdfJob(id, factory);
      await completePdfJob(id, { pdf: new Uint8Array(128), diagnostics: [], compilerVersion: "t" }, factory);
      await deletePdfJob(id, factory);

      const db = await openPdfJobDb(factory);
      const counts = await new Promise<number[]>((resolve, reject) => {
        const tx = db.transaction(["jobs", "bundles", "results"], "readonly");
        const requests = ["jobs", "bundles", "results"].map((name) => tx.objectStore(name).count());
        tx.oncomplete = () => resolve(requests.map((request) => request.result));
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      expect(counts).toEqual([0, 0, 0]);
    });

    it("expiry sweeps payloads too, not just meta records", async () => {
      await putPdfJob({ id, sourceIdentity: "old", bundle: bundle(256), createdAt: 100 }, factory);
      expect(await cleanupPdfJobs({ now: 1_000, maxAgeMs: 500 }, factory)).toBe(1);

      const db = await openPdfJobDb(factory);
      const bundleCount = await new Promise<number>((resolve, reject) => {
        const request = db.transaction("bundles", "readonly").objectStore("bundles").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      expect(bundleCount).toBe(0);
    });

    it("never runs a second dedupe pass over the bundle it is handed", async () => {
      // Dedupe lives ONLY in preparePdfDocument, which rewrites references to a
      // canonical path as it drops duplicates. A second, independent pass here
      // would drop bytes without rewriting anything and hand the compiler VFS a
      // dangling asset path. So byte-identical assets under DIFFERENT paths must
      // survive verbatim: the store stores, it does not deduplicate.
      const shared = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const duplicated: PdfSourceBundle = {
        main: "= Job",
        template: "template",
        assets: [
          { path: "assets/first.png", mediaType: "image/png", bytes: shared },
          { path: "assets/second.png", mediaType: "image/png", bytes: new Uint8Array(shared) },
          { path: "assets/third.png", mediaType: "image/png", bytes: new Uint8Array(shared) },
        ],
        sourceMap: [],
        notes: [],
      };
      const stored = await putPdfJob({ id, sourceIdentity: "dupes", bundle: duplicated }, factory);
      // Every duplicate counted against the quota — no silent hashing/collapsing.
      expect(stored.inputBytes).toBe(
        new TextEncoder().encode("= Job").byteLength +
          new TextEncoder().encode("template").byteLength +
          shared.byteLength * 3
      );

      const round = await getPdfJob(id, factory);
      expect(round?.bundle?.assets.map((asset) => asset.path)).toEqual([
        "assets/first.png",
        "assets/second.png",
        "assets/third.png",
      ]);
      for (const asset of round!.bundle!.assets) {
        expect(new Uint8Array(asset.bytes)).toEqual(shared);
      }
    });
  });

  /**
   * The measured bytes and the stored bytes must be the same bytes
   * (spec 010 wave-1 review, C1).
   *
   * `putPdfJob` measures on entry but `add()`s after an `await` on the database
   * open, and `PdfSourceBundle` is a plain mutable object. Every test here
   * mutates the caller's bundle INSIDE that window — synchronously after the
   * call, before the returned promise settles — which is exactly what a second
   * tab, a retry path, or a caller reusing its builder can do by accident.
   */
  describe("byte caps cannot be bypassed by mutating the bundle after the call", () => {
    it("stores what it measured when assets are appended mid-write", async () => {
      const live = bundle(1);
      const pending = putPdfJob({ id, sourceIdentity: "mutate", bundle: live }, factory);
      // The window: the DB open has not resolved yet.
      live.assets.push({
        path: "assets/smuggled.png",
        mediaType: "image/png",
        bytes: new Uint8Array(1024),
      });
      const stored = await pending;

      const round = await getPdfJob(id, factory);
      const actualBytes =
        new TextEncoder().encode(round!.bundle!.main).byteLength +
        new TextEncoder().encode(round!.bundle!.template).byteLength +
        round!.bundle!.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
      // The meta record's number IS the payload store's size — not 3 vs 1025.
      expect(stored.inputBytes).toBe(actualBytes);
      expect((await getPdfJobMeta(id, factory))!.inputBytes).toBe(actualBytes);
      expect(round!.bundle!.assets.map((a) => a.path)).toEqual(["assets/a.png"]);
    });

    it("does not let a post-call append walk a bundle past the per-job cap", async () => {
      const live = bundle(64);
      const pending = putPdfJob({ id, sourceIdentity: "oversize", bundle: live }, factory);
      live.assets.push({
        path: "assets/huge.png",
        mediaType: "image/png",
        bytes: new Uint8Array(PDF_JOB_MAX_BYTES + 1),
      });
      await pending;

      const stored = (await getPdfJob(id, factory))!;
      const total = stored.bundle!.assets.reduce((sum, a) => sum + a.bytes.byteLength, 0);
      expect(total).toBeLessThanOrEqual(PDF_JOB_MAX_BYTES);
      expect(stored.inputBytes).toBeLessThanOrEqual(PDF_JOB_MAX_BYTES);
      expect(stored.bundle!.assets).toHaveLength(1);
    });

    it("compiles the source it measured, not a swapped-in one", async () => {
      // Not a size bypass — a CONTENT one. `claimPdfJob` hands the compiler the
      // stored bundle, so a `main` or a `path` swapped after the measurement
      // used to decide what actually got compiled.
      const live = bundle(4);
      const pending = putPdfJob({ id, sourceIdentity: "swap", bundle: live }, factory);
      live.main = "= Something else entirely";
      live.template = "other-template";
      live.assets[0]!.path = "assets/elsewhere.png";
      await pending;

      const claimed = await claimPdfJob(id, factory);
      expect(claimed!.bundle.main).toBe("= Job");
      expect(claimed!.bundle.template).toBe("template");
      expect(claimed!.bundle.assets[0]!.path).toBe("assets/a.png");
    });

    it("returns the snapshot it stored, so the caller cannot mutate it afterwards", async () => {
      const live = bundle(4);
      const stored = await putPdfJob({ id, sourceIdentity: "returned", bundle: live }, factory);
      live.main = "= Mutated after the fact";
      live.assets.push({
        path: "assets/late.png",
        mediaType: "image/png",
        bytes: new Uint8Array(8),
      });
      expect(stored.bundle!.main).toBe("= Job");
      expect(stored.bundle!.assets).toHaveLength(1);
    });
  });
});
