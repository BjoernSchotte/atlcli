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
      const tx = db.transaction("jobs", "readwrite");
      tx.objectStore("jobs").add({
        id: "423e4567-e89b-42d3-a456-426614174000",
        sourceIdentity: "seed",
        createdAt: 1,
        status: "prepared",
        inputBytes: PDF_STORE_MAX_BYTES,
        bundle: bundle(),
      });
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
    expect((await getPdfJob(id, factory))?.bundle.assets[0]?.bytes.byteLength).toBe(3);
    expect((await getPdfJob(other, factory))?.bundle.assets[0]?.bytes.byteLength).toBe(7);
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
});
