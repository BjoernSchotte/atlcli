import { IndexedDbExportByteStore } from "../../../utils/export-jobs/chunk-store.js";
import {
  EXTENSION_EXPORT_BYTE_CHUNKS_STORE,
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  openExtensionExportDb,
  IndexedDbExportJobCatalog,
} from "../../../utils/export-jobs/catalog.js";
import { BrowserRenderReservationPoolV1 } from "../../../utils/export-jobs/render-reservation.js";
import { createExtensionExportQueueRunner } from "../../../utils/export-jobs/queue-runner.js";
import { readExtensionPdfExportReport } from "../../../utils/export-jobs/executor-store.js";
import { readExtensionDocxExportReport } from "../../../utils/export-jobs/docx-executor-store.js";
import { submitExtensionDocxExport } from "../../../utils/export-jobs/docx-submit.js";
import { submitExtensionPdfExport } from "../../../utils/export-jobs/pdf-submit.js";
import { idbTemplateLibrary } from "../../../utils/templates/library.js";
import { chromeDurableJobsStore } from "../../../utils/jobs/store.js";
import { deletePdfJob } from "../../../utils/pdf/job-store.js";

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
  async removeBridge(legacyJobId: string, outerJobId: string, outerLeaseEpoch: number): Promise<void> {
    await new IndexedDbExportJobCatalog().deleteLegacyBridge(
      outerJobId,
      outerLeaseEpoch,
      legacyJobId,
    );
    await deletePdfJob(legacyJobId);
  },
  async activityKeys(): Promise<string[]> {
    return (await chromeDurableJobsStore().list()).map((row) => row.id);
  },
  async retainedPdf(
    artifactRef: string,
    reportRef: string,
  ): Promise<{ prefix: string; byteLength: number; filename?: string; complete?: boolean }> {
    const stored: number[] = [];
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      stored.push(...chunk);
    }
    const report = await readExtensionPdfExportReport(reportRef);
    return {
      prefix: new TextDecoder().decode(Uint8Array.from(stored.slice(0, 5))),
      byteLength: stored.length,
      ...(report ? { filename: report.filename, complete: report.complete } : {}),
    };
  },
  async retainedDocx(
    artifactRef: string,
    reportRef: string,
  ): Promise<{
    prefix: number[];
    byteLength: number;
    filename?: string;
    complete?: boolean;
    renderedDiagrams?: number;
  }> {
    const stored: number[] = [];
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      stored.push(...chunk);
    }
    const report = await readExtensionDocxExportReport(reportRef);
    return {
      prefix: stored.slice(0, 2),
      byteLength: stored.length,
      ...(report
        ? {
            filename: report.filename,
            complete: report.complete,
            renderedDiagrams: report.renderedDiagrams,
          }
        : {}),
    };
  },
  async submitPdf(id: string): Promise<string> {
    const catalog = new IndexedDbExportJobCatalog();
    const submitted = await submitExtensionPdfExport({
      pageUrl: `https://site.atlassian.net/wiki/spaces/DOCS/pages/${id}/Packed`,
      page: {
        details: {
          id,
          title: `Packed page ${id}`,
          version: 1,
          spaceKey: "DOCS",
          storage: "<p>Panel-owned source must not be retained</p>",
        },
        markdown: "Panel-owned source must not be retained",
        wordCount: 6,
        attachments: [],
      },
    }, {
      catalog,
      requestId: id,
      wake: async (jobIds) => {
        const response = await chrome.runtime.sendMessage({
          kind: "jobs:wake",
          jobIds,
        }) as { kind?: string; claimedJobId?: string; error?: string } | undefined;
        return response?.kind === "jobs:wake-result"
          ? {
              ...(response.claimedJobId
                ? { claimedJobId: response.claimedJobId }
                : {}),
              ...(response.error ? { error: response.error } : {}),
            }
          : { error: "No background queue response." };
      },
    });
    return submitted.snapshot.id;
  },
  async submitDocx(id: string, templateValues: number[]): Promise<string> {
    const templateBytes = Uint8Array.from(templateValues);
    const library = idbTemplateLibrary({
      siteOrigin: "https://site.atlassian.net",
    });
    const entry = await library.add({
      name: "packed-template.docx",
      displayName: "Packed template",
      bytes: templateBytes.slice().buffer,
      templateId: `packed-${id}`,
    });
    const catalog = new IndexedDbExportJobCatalog();
    const submitted = await submitExtensionDocxExport({
      pageUrl: `https://site.atlassian.net/wiki/spaces/DOCS/pages/${id}/Packed`,
      page: {
        details: {
          id,
          title: `Packed DOCX ${id}`,
          version: 1,
          spaceKey: "DOCS",
          storage: "<p>Panel-owned source must not be retained</p>",
        },
        markdown: "Panel-owned source must not be retained",
        wordCount: 6,
        attachments: [],
      },
      template: {
        name: entry.fileName,
        uploadedAt: Date.parse(entry.uploadedAt),
        bytes: templateBytes.slice().buffer,
        recordKey: entry.recordKey,
        sha256: entry.sha256,
      },
      resolveMacros: false,
    }, {
      catalog,
      requestId: id,
      wake: async (jobIds) => {
        const response = await chrome.runtime.sendMessage({
          kind: "jobs:wake",
          jobIds,
        }) as { kind?: string; claimedJobId?: string; error?: string } | undefined;
        return response?.kind === "jobs:wake-result"
          ? {
              ...(response.claimedJobId
                ? { claimedJobId: response.claimedJobId }
                : {}),
              ...(response.error ? { error: response.error } : {}),
            }
          : { error: "No background queue response." };
      },
    });
    return submitted.snapshot.id;
  },
  async renderReservations(): Promise<{
    secondWaited: boolean;
    activeAfterHandoff: number;
    activeAfterRelease: number;
  }> {
    const pool = new BrowserRenderReservationPoolV1({
      inFlightBytes: 100,
      persistedSpoolBytes: 100,
      outputBytes: 100,
      rasterBytes: 100,
      heavySlots: 1,
    });
    const estimate = {
      heapBytes: 20,
      spoolBytes: 10,
      outputBytes: 10,
      rasterPixels: 5,
      confidence: "estimated" as const,
    };
    const first = await pool.pdf.acquire({
      jobId: "packed-pdf",
      leaseEpoch: 1,
      estimate,
      signal: new AbortController().signal,
    });
    let secondEntered = false;
    const second = pool.docx.acquire({
      jobId: "packed-docx",
      leaseEpoch: 1,
      estimate,
      signal: new AbortController().signal,
    }).then((reservation) => {
      secondEntered = true;
      return reservation;
    });
    await Promise.resolve();
    const secondWaited = !secondEntered;
    first.release();
    const handedOff = await second;
    const activeAfterHandoff = pool.snapshot.activeReservations;
    handedOff.release();
    return {
      secondWaited,
      activeAfterHandoff,
      activeAfterRelease: pool.snapshot.activeReservations,
    };
  },
  async queuePump(): Promise<{
    firstClaim: string | undefined;
    duplicateClaim: string | undefined;
    entered: string[];
  }> {
    const catalog = new IndexedDbExportJobCatalog();
    const bytes = new IndexedDbExportByteStore();
    const ids = [
      "523e4567-e89b-42d3-a456-426614174000",
      "623e4567-e89b-42d3-a456-426614174000",
    ];
    for (const [index, id] of ids.entries()) {
      await catalog.create({
        request: {
          schema: "atlcli.export-job-request/1",
          id,
          idempotencyKey: `packed-pump:${id}`,
          format: "pdf",
          renderer: "pdf-typst",
          source: {
            kind: "confluence",
            siteOrigin: "https://site.atlassian.net",
            locator: { kind: "page-id", id: "42" },
            scope: { kind: "page" },
          },
          authRef: "session:https://site.atlassian.net",
          displayName: id,
          requestedFilename: `${id}.pdf`,
          createdAt: index + 1,
          priority: "interactive",
          output: { policy: "collect" },
          template: { id: "builtin.editorial-indigo", manifestVersion: "1.0.0" },
          settings: {},
          options: { resolveMacros: true },
        },
      });
    }
    const entered: string[] = [];
    let releaseFirst!: () => void;
    const runner = createExtensionExportQueueRunner({
      catalog,
      bytes,
      ownerId: "offscreen:packed-pump",
      execute: async (claimed) => {
        entered.push(claimed.id);
        if (claimed.id === ids[0]) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
    });
    const firstClaim = await runner.wake();
    const duplicateClaim = await runner.wake(ids);
    releaseFirst();
    const deadline = Date.now() + 1_000;
    while (!entered.includes(ids[1]!)) {
      if (Date.now() >= deadline) throw new Error("Packed queue did not pump its second job.");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return { firstClaim, duplicateClaim, entered };
  },
};

(globalThis as unknown as { exportJobStoreProbe: typeof probe }).exportJobStoreProbe = probe;
