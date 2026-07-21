/**
 * One budget, two tenants (spec 010 T5.6).
 *
 * The preview cache (T5.3) and retained background jobs (T5.6) draw on the same
 * `PDF_STORE_MAX_BYTES`. Left to themselves they would each enforce their own
 * ceiling and the loser would simply be whoever wrote second. This file drives
 * the real preview database and the real job store — both `fake-indexeddb`, no
 * stubs — against a store that is genuinely close to the limit, and asserts the
 * asymmetry that makes the policy worth having: **a preview is expendable, a
 * finished export nobody has collected is not.**
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  PDF_STORE_MAX_BYTES,
  getPdfJobMeta,
  openPdfJobDb,
  putPdfJob,
  setSharedBudgetTenants,
} from "../../utils/pdf/job-store.js";
import { putPreview } from "../../utils/pdf/preview-cache.js";
import { PREVIEW_CACHE_BUDGET_ID, previewCacheTenant } from "../../utils/jobs/preview-tenant.js";

globalThis.IDBKeyRange = IDBKeyRange;

const FINISHED = "423e4567-e89b-42d3-a456-426614174000";
const INCOMING = "523e4567-e89b-42d3-a456-426614174000";
const PREVIEW_BYTES = 65_536;

let factory: IDBFactory;
let restoreTenants: (() => void) | null = null;

beforeEach(() => {
  factory = new IDBFactory();
  restoreTenants = setSharedBudgetTenants(previewCacheTenant(factory));
});

afterEach(() => {
  restoreTenants?.();
  restoreTenants = null;
});

function bundle(size = 4_096): PdfSourceBundle {
  return {
    main: "= Job",
    template: "template",
    assets: [{ path: "assets/a.png", mediaType: "image/png", bytes: new Uint8Array(size) }],
    sourceMap: [],
    notes: [],
  };
}

/**
 * Seed a finished, uncollected export occupying `bytes`.
 *
 * Written straight into the meta store rather than by compiling 128 MiB of real
 * document — which is only possible *because* the quota is computed from meta
 * records (the T5.6 byte-handling split). The record is fresh, so nothing about
 * this fixture is expired.
 */
async function seedFinishedExport(bytes: number): Promise<void> {
  const db = await openPdfJobDb(factory);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["jobs"], "readwrite");
    tx.objectStore("jobs").add({
      id: FINISHED,
      sourceIdentity: "https://site.atlassian.net/big|1|1",
      createdAt: Date.now(),
      status: "complete",
      kind: "export",
      inputBytes: 0,
      outputBytes: bytes,
      consumed: false,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function seedPreview(): Promise<void> {
  await putPreview(
    {
      sourceIdentity: "https://site.atlassian.net/preview|1|1",
      settingsHash: "s",
      treeVersionHash: "t",
      pdf: new Uint8Array(PREVIEW_BYTES),
      filename: "preview.pdf",
      truncated: false,
      includedChapters: 1,
      totalChapters: 1,
    },
    factory
  );
}

describe("the shared store budget", () => {
  it("sees the preview cache as an occupant of the same budget", async () => {
    await seedPreview();
    const inventory = await previewCacheTenant(factory).inventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.id).toBe(PREVIEW_CACHE_BUDGET_ID);
    expect(inventory[0]!.tenant).toBe("preview-cache");
    expect(inventory[0]!.bytes).toBeGreaterThanOrEqual(PREVIEW_BYTES);
  });

  it("evicts the preview cache — and not the finished export — to admit a new job", async () => {
    await seedPreview();
    // Leaves room for the preview and 1 KiB, so the incoming 4 KiB job is over.
    await seedFinishedExport(PDF_STORE_MAX_BYTES - PREVIEW_BYTES - 1_024);

    await expect(
      putPdfJob(
        { id: INCOMING, sourceIdentity: "https://site.atlassian.net/new|1|1", bundle: bundle() },
        factory
      )
    ).resolves.toBeDefined();

    // The cache is gone…
    expect(await previewCacheTenant(factory).inventory()).toEqual([]);
    // …and the export the user is waiting to download is untouched.
    const finished = await getPdfJobMeta(FINISHED, factory);
    expect(finished?.status).toBe("complete");
    expect(finished?.outputBytes).toBe(PDF_STORE_MAX_BYTES - PREVIEW_BYTES - 1_024);
  });

  it("refuses a new job rather than dropping a finished export", async () => {
    await seedFinishedExport(PDF_STORE_MAX_BYTES - 1_024);

    await expect(
      putPdfJob(
        { id: INCOMING, sourceIdentity: "https://site.atlassian.net/new|1|1", bundle: bundle() },
        factory
      )
    ).rejects.toThrow("total quota");

    const finished = await getPdfJobMeta(FINISHED, factory);
    expect(finished?.outputBytes).toBe(PDF_STORE_MAX_BYTES - 1_024);
  });

  it("does drop a finished export once the user has collected it", async () => {
    await seedFinishedExport(PDF_STORE_MAX_BYTES - 1_024);
    const db = await openPdfJobDb(factory);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["jobs"], "readwrite");
      const read = tx.objectStore("jobs").get(FINISHED);
      read.onsuccess = () => {
        tx.objectStore("jobs").put({ ...(read.result as object), consumed: true });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await expect(
      putPdfJob(
        { id: INCOMING, sourceIdentity: "https://site.atlassian.net/new|1|1", bundle: bundle() },
        factory
      )
    ).resolves.toBeDefined();
    expect(await getPdfJobMeta(FINISHED, factory)).toBeUndefined();
  });
});
