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
import {
  EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
  extensionDocxTemplateSpoolRef,
} from "../../../utils/export-jobs/docx-template.js";
import { submitExtensionPdfExport } from "../../../utils/export-jobs/pdf-submit.js";
import { sweepExtensionExportJobRetention } from "../../../utils/export-jobs/retention.js";
import { idbTemplateLibrary } from "../../../utils/templates/library.js";
import {
  chromeDurableJobsStore,
  createExtensionDurableJobsStore,
  type DurableJobsPort,
} from "../../../utils/jobs/store.js";
import { deletePdfJob } from "../../../utils/pdf/job-store.js";
import { unzipDocx } from "@atlcli/docx/browser-entry";
import type {
  DocxExportJobRequestV1,
  ExportJobRequestV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  FULL_REPORT_RETENTION_MS_V1,
} from "@atlcli/export-jobs";

const PACKED_BADGE_STATE_KEY = "export-activity-badge-state-v1";
const PACKED_BADGE_PULSE_KEY = "export-activity-badge-pulse-enabled-v1";
const SHA_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function badgeRequest(
  id: string,
  format: "pdf" | "docx",
  createdAt: number,
): ExportJobRequestV1 {
  const source = {
    kind: "confluence" as const,
    siteOrigin: "https://site.atlassian.net",
    locator: { kind: "page-id" as const, id: `source-${id}`, version: 1 },
    scope: { kind: "page" as const },
  };
  if (format === "docx") {
    return {
      schema: "atlcli.export-job-request/1",
      id,
      idempotencyKey: `packed-badge:${id}`,
      format,
      renderer: "docx-typescript",
      source,
      authRef: "session:https://site.atlassian.net",
      displayName: `Packed DOCX ${id}`,
      requestedFilename: `${id}.docx`,
      createdAt,
      priority: "interactive",
      output: { policy: "collect" },
      template: {
        recordKey: "packed:badge-template",
        sha256: SHA_ABC,
        name: "Packed badge template",
        uploadedAt: 1,
      },
      options: { embedImages: true, resolveMacros: false },
    } satisfies DocxExportJobRequestV1;
  }
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `packed-badge:${id}`,
    format,
    renderer: "pdf-typst",
    source,
    authRef: "session:https://site.atlassian.net",
    displayName: `Packed PDF ${id}`,
    requestedFilename: `${id}.pdf`,
    createdAt,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      kind: "builtin",
      id: "builtin.editorial-indigo",
      manifestVersion: "1.0.0",
    },
    settings: {},
    options: { resolveMacros: false, exportedAt: createdAt },
  } satisfies PdfExportJobRequestV1;
}

function unavailableLegacy(): DurableJobsPort {
  return {
    list: async () => [],
    detail: async () => undefined,
    cancel: async () => undefined,
    retry: async () => undefined,
    rerun: async () => undefined,
    resume: async () => false,
    acknowledge: async () => undefined,
    dismiss: async () => undefined,
    download: async () => false,
    getPreferences: async () => ({ pulseEnabled: true }),
    setPulseEnabled: async () => undefined,
  };
}

async function notifyBadge(jobId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    kind: "jobs:changed",
    jobId,
  }).catch(() => undefined);
}

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
    return (await chromeDurableJobsStore().list()).map((row) => row.key);
  },
  async resetBadge(initialize = true): Promise<void> {
    await chrome.storage.local.remove([
      PACKED_BADGE_STATE_KEY,
      PACKED_BADGE_PULSE_KEY,
    ]);
    await chrome.action.setBadgeText({ text: "" });
    if (initialize) await notifyBadge("packed-reset");
  },
  async badgeSnapshot(): Promise<{
    text: string;
    color: number[];
    state?: {
      initialized?: boolean;
      pulseSequence?: number;
      seenTransitions?: string[];
    };
    pulseEnabled: boolean;
  }> {
    const [text, color, stored] = await Promise.all([
      chrome.action.getBadgeText({}),
      chrome.action.getBadgeBackgroundColor({}),
      chrome.storage.local.get([
        PACKED_BADGE_STATE_KEY,
        PACKED_BADGE_PULSE_KEY,
      ]),
    ]);
    return {
      text,
      color,
      ...(stored[PACKED_BADGE_STATE_KEY]
        ? { state: stored[PACKED_BADGE_STATE_KEY] }
        : {}),
      pulseEnabled: stored[PACKED_BADGE_PULSE_KEY] !== false,
    };
  },
  async seedBadgeScenario(): Promise<{
    activeIds: string[];
    failedId: string;
    succeededId: string;
  }> {
    const createdAt = Date.now() - 1_000;
    const catalog = new IndexedDbExportJobCatalog();
    const byteStore = new IndexedDbExportByteStore();
    const activeIds = Array.from(
      { length: 10 },
      (_, index) => `packed-badge-active-${index}`,
    );
    for (const [index, id] of activeIds.entries()) {
      await catalog.create({
        request: badgeRequest(
          id,
          index % 2 === 0 ? "pdf" : "docx",
          createdAt + index,
        ),
      });
    }

    const failedId = "packed-badge-failed-docx";
    await byteStore.put(
      extensionDocxTemplateSpoolRef(failedId),
      (async function* () { yield Uint8Array.from([97, 98, 99]); })(),
      EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
    );
    await catalog.create({
      request: badgeRequest(failedId, "docx", createdAt + 20),
    });
    const failedStartedAt = Date.now();
    const failedClaim = await catalog.claimNext({
      ids: [failedId],
      ownerId: "packed-badge-failure",
      now: failedStartedAt,
      leaseDurationMs: 10_000,
    });
    if (!failedClaim) throw new Error("Packed failure fixture was not claimed.");
    const failedAt = Date.now();
    await catalog.compareAndSet({
      id: failedId,
      kind: "transition",
      expectedRevision: failedClaim.revision,
      leaseEpoch: failedClaim.leaseEpoch,
      to: "failed",
      at: failedAt,
      error: {
        code: "packed-failure",
        message: "Synthetic packed failure.",
        category: "network",
        retryable: true,
        stage: "fetch",
        occurredAt: failedAt,
      },
    });

    const succeededId = "packed-badge-succeeded-pdf";
    await catalog.create({
      request: badgeRequest(succeededId, "pdf", createdAt + 30),
    });
    const succeededStartedAt = Date.now();
    const succeededClaim = await catalog.claimNext({
      ids: [succeededId],
      ownerId: "packed-badge-success",
      now: succeededStartedAt,
      leaseDurationMs: 10_000,
    });
    if (!succeededClaim) throw new Error("Packed success fixture was not claimed.");
    const staged = await byteStore.stage(
      succeededId,
      succeededClaim.leaseEpoch,
      {
        mediaType: "application/pdf",
        filename: "packed-badge-success.pdf",
        byteLength: 3,
        sha256: SHA_ABC,
        bytes: (async function* () {
          yield Uint8Array.from([97, 98, 99]);
        })(),
      },
    );
    await catalog.finalizeArtifact({
      id: succeededId,
      expectedRevision: succeededClaim.revision,
      leaseEpoch: succeededClaim.leaseEpoch,
      stagedArtifact: staged,
      reportRef: "report:packed-badge-success",
      reportSummary: {
        issues: { info: 0, warning: 0, error: 0 },
        topCodes: [],
        completeness: "complete",
      },
      finishedAt: Math.max(Date.now(), staged.stagedAt),
    });
    await notifyBadge("packed-badge-seeded");
    return { activeIds, failedId, succeededId };
  },
  async cancelBadgeJobs(ids: string[]): Promise<void> {
    const store = chromeDurableJobsStore();
    for (const id of ids) {
      await store.cancel(`common:${id}`);
    }
  },
  async acknowledgeBadgeJob(id: string): Promise<void> {
    await chromeDurableJobsStore().acknowledge(`common:${id}`);
  },
  async setBadgePulseEnabled(enabled: boolean): Promise<void> {
    await chromeDurableJobsStore().setPulseEnabled(enabled);
  },
  async panelPing(): Promise<void> {
    await chrome.runtime.sendMessage({ kind: "ping" });
  },
  async replayBadgeJobs(
    failedId: string,
    succeededId: string,
  ): Promise<{
    retry: {
      route: string;
      format: string;
      template: unknown;
      derivedFrom: unknown;
      pin: unknown;
    };
    rerun: {
      route: string;
      format: string;
      template: unknown;
      derivedFrom: unknown;
    };
    original: {
      failureState?: string;
      successState?: string;
      artifactRef?: string;
      reportRef?: string;
      acknowledgedAt?: number;
    };
  }> {
    const catalog = new IndexedDbExportJobCatalog();
    const byteStore = new IndexedDbExportByteStore();
    let serial = 0;
    const store = createExtensionDurableJobsStore({
      catalog,
      bytes: byteStore,
      legacy: unavailableLegacy(),
      listLegacyPdf: async () => [],
      wake: async () => ({}),
      emit: async () => undefined,
      randomUUID: () => `packed-derived-${++serial}`,
      now: () => Date.now() + serial,
    });
    await store.acknowledge(`common:${succeededId}`);
    const retryRoute = await store.retry(
      `common:${failedId}`,
      "packed-retry-action",
    );
    const rerunRoute = await store.rerun(
      `common:${succeededId}`,
      "packed-rerun-action",
    );
    if (!retryRoute || !rerunRoute) {
      throw new Error("Packed replay actions did not create derived jobs.");
    }
    const retryId = retryRoute.slice("common:".length);
    const rerunId = rerunRoute.slice("common:".length);
    const [retrySnapshot, rerunSnapshot, failure, success] = await Promise.all([
      catalog.get(retryId),
      catalog.get(rerunId),
      catalog.get(failedId),
      catalog.get(succeededId),
    ]);
    if (!retrySnapshot || !rerunSnapshot || !failure || !success) {
      throw new Error("Packed replay snapshots were not retained.");
    }
    const [retryRequest, rerunRequest] = await Promise.all([
      catalog.getRequest(retrySnapshot.requestRef),
      catalog.getRequest(rerunSnapshot.requestRef),
    ]);
    if (!retryRequest || !rerunRequest) {
      throw new Error("Packed replay requests were not retained.");
    }
    return {
      retry: {
        route: retryRoute,
        format: retrySnapshot.format,
        template: retryRequest.template,
        derivedFrom: retrySnapshot.derivedFrom,
        pin: await byteStore.stat(extensionDocxTemplateSpoolRef(retryId)),
      },
      rerun: {
        route: rerunRoute,
        format: rerunSnapshot.format,
        template: rerunRequest.template,
        derivedFrom: rerunSnapshot.derivedFrom,
      },
      original: {
        failureState: failure.state,
        successState: success.state,
        artifactRef: success.artifact?.ref,
        reportRef: success.reportRef,
        acknowledgedAt: success.acknowledgedAt,
      },
    };
  },
  async retainedPdf(
    artifactRef: string,
    reportRef: string,
  ): Promise<{
    prefix: string;
    byteLength: number;
    filename?: string;
    complete?: boolean;
    sourceNotes?: Array<{ code: string; macroName?: string }>;
  }> {
    const stored: number[] = [];
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      for (const byte of chunk) stored.push(byte);
    }
    const report = await readExtensionPdfExportReport(reportRef);
    const sourceNotes = report?.sourceNotes?.map((note) => ({
      code: note.code,
      ...(note.macroName ? { macroName: note.macroName } : {}),
    }));
    return {
      prefix: new TextDecoder().decode(Uint8Array.from(stored.slice(0, 5))),
      byteLength: stored.length,
      ...(report ? {
        filename: report.filename,
        complete: report.complete,
        ...(sourceNotes ? { sourceNotes } : {}),
      } : {}),
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
    highlightCodeBlocks?: number;
    highlightLanguageCount?: number;
    highlightTokenizeMs?: number;
  }> {
    const stored: number[] = [];
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      for (const byte of chunk) stored.push(byte);
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
            highlightCodeBlocks: report.timings.highlightCodeBlocks,
            highlightLanguageCount: report.timings.highlightLanguageCount,
            highlightTokenizeMs: report.timings.highlightTokenizeMs,
          }
        : {}),
    };
  },
  async retainedDocxChartEvidence(
    artifactRef: string,
    reportRef: string,
    titles: string[],
  ): Promise<{
    svgParts: number;
    pngParts: number;
    titlesInDocument: number;
    presentTitles: string[];
    complete?: boolean;
    noteCodes: string[];
  }> {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const zip = unzipDocx(bytes);
    const media = Object.keys(zip.files).filter((path) => path.startsWith("word/media/"));
    const documentXml = zip.file("word/document.xml")?.asText() ?? "";
    const report = await readExtensionDocxExportReport(reportRef);
    return {
      svgParts: media.filter((path) => path.endsWith(".svg")).length,
      pngParts: media.filter((path) => path.endsWith(".png")).length,
      titlesInDocument: titles.filter((title) => documentXml.includes(title)).length,
      presentTitles: titles.filter((title) => documentXml.includes(title)),
      ...(report ? { complete: report.complete } : {}),
      noteCodes: report
        ? [...new Set(report.notes.map((note) => note.code))].sort()
        : [],
    };
  },
  async retainedPdfChartEvidence(
    artifactRef: string,
    reportRef: string,
  ): Promise<{
    prefix: string;
    byteLength: number;
    pageCount?: number;
    complete?: boolean;
    noteCodes: string[];
  }> {
    const prefix: number[] = [];
    let byteLength = 0;
    for await (const chunk of new IndexedDbExportByteStore().read(artifactRef)) {
      for (const byte of chunk) {
        if (prefix.length < 5) prefix.push(byte);
      }
      byteLength += chunk.byteLength;
    }
    const report = await readExtensionPdfExportReport(reportRef);
    return {
      prefix: new TextDecoder().decode(Uint8Array.from(prefix)),
      byteLength,
      ...(report?.pageCount !== undefined ? { pageCount: report.pageCount } : {}),
      ...(report ? { complete: report.complete } : {}),
      noteCodes: report
        ? [...new Set(report.notes.map((note) => note.code))].sort()
        : [],
    };
  },
  async retainCompleted(ids: string[]): Promise<{
    sweep: {
      payloadReleases: number;
      historyDeleted: number;
      tombstonesReconciled: number;
    };
    jobs: Array<{
      id: string;
      format: string;
      artifactReleasedAt?: number;
      reportReleasedAt?: number;
      reportCompleteness?: string;
      artifactReadable: boolean;
      reportReadable: boolean;
      eventCount: number;
      requestTemplatePinned: boolean;
    }>;
  }> {
    const catalog = new IndexedDbExportJobCatalog();
    const byteStore = new IndexedDbExportByteStore();
    const originals: Array<{
      id: string;
      format: "pdf" | "docx";
      artifactRef: string;
      reportRef: string;
      deliveredAt: number;
      finishedAt: number;
    }> = [];
    for (const id of ids) {
      let snapshot = await catalog.get(id);
      if (
        !snapshot ||
        snapshot.state !== "succeeded" ||
        !snapshot.artifact ||
        !snapshot.reportRef ||
        snapshot.finishedAt === undefined
      ) {
        throw new Error(`Packed retention fixture ${id} is not a complete export.`);
      }
      if (snapshot.deliveredAt === undefined) {
        snapshot = await catalog.deliver(
          id,
          snapshot.revision,
          snapshot.finishedAt,
        );
      }
      originals.push({
        id,
        format: snapshot.format,
        artifactRef: snapshot.artifact!.ref,
        reportRef: snapshot.reportRef!,
        deliveredAt: snapshot.deliveredAt!,
        finishedAt: snapshot.finishedAt!,
      });
    }
    const at = Math.max(...originals.flatMap((job) => [
      job.deliveredAt + DELIVERED_ARTIFACT_RETENTION_MS_V1,
      job.finishedAt + FULL_REPORT_RETENTION_MS_V1,
    ]));
    const sweep = await sweepExtensionExportJobRetention({
      catalog,
      bytes: byteStore,
      now: () => at,
    });
    const jobs = await Promise.all(originals.map(async (original) => {
      const snapshot = await catalog.get(original.id);
      if (!snapshot) {
        throw new Error(`Packed retention unexpectedly deleted ${original.id}.`);
      }
      let artifactReadable = true;
      try {
        await Array.fromAsync(byteStore.read(original.artifactRef));
      } catch {
        artifactReadable = false;
      }
      const report = original.format === "pdf"
        ? await readExtensionPdfExportReport(original.reportRef)
        : await readExtensionDocxExportReport(original.reportRef);
      return {
        id: original.id,
        format: original.format,
        ...(snapshot.artifactReleasedAt !== undefined
          ? { artifactReleasedAt: snapshot.artifactReleasedAt }
          : {}),
        ...(snapshot.reportReleasedAt !== undefined
          ? { reportReleasedAt: snapshot.reportReleasedAt }
          : {}),
        ...(snapshot.reportSummary
          ? { reportCompleteness: snapshot.reportSummary.completeness }
          : {}),
        artifactReadable,
        reportReadable: report !== undefined,
        eventCount: (await catalog.readEvents(original.id)).events.length,
        requestTemplatePinned: original.format === "docx" &&
          await byteStore.stat(extensionDocxTemplateSpoolRef(original.id)) !==
            undefined,
      };
    }));
    return { sweep, jobs };
  },
  async submitPdf(
    id: string,
    scopeKind: "page" | "tree" = "page",
    siteOrigin = "https://site.atlassian.net",
    imageProfile: "original" | "standard" | "print" = "original",
  ): Promise<string> {
    const catalog = new IndexedDbExportJobCatalog();
    const submitted = await submitExtensionPdfExport({
      pageUrl: `${siteOrigin}/wiki/spaces/DOCS/pages/${id}/Packed`,
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
      ...(scopeKind === "tree"
        ? {
            scope: {
              kind: "tree" as const,
              rootPageId: id,
              includeRoot: true,
              maxDepth: 1,
            },
          }
        : {}),
      ...(imageProfile === "original" ? {} : { imageProfile }),
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
  async submitDocx(
    id: string,
    templateValues: number[],
    sourcePageId = id,
    createdAt?: number,
  ): Promise<string> {
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
    const bytes = new IndexedDbExportByteStore();
    const submitted = await submitExtensionDocxExport({
      pageUrl: `https://site.atlassian.net/wiki/spaces/DOCS/pages/${sourcePageId}/Packed`,
      page: {
        details: {
          id: sourcePageId,
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
      bytes,
      requestId: id,
      ...(createdAt === undefined ? {} : { now: () => createdAt }),
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
  async resumeJob(id: string): Promise<boolean> {
    return chromeDurableJobsStore().resume(`common:${id}`);
  },
  async rerunJob(
    id: string,
    actionKey: string,
  ): Promise<string | undefined> {
    return chromeDurableJobsStore().rerun(`common:${id}`, actionKey);
  },
  async removeDocxLibraryTemplate(id: string): Promise<boolean> {
    const library = idbTemplateLibrary({
      siteOrigin: "https://site.atlassian.net",
    });
    const entry = (await library.listAll("docx")).find(
      (candidate) => candidate.id === `packed-${id}`,
    );
    if (!entry) return false;
    await library.remove(entry.recordKey);
    return true;
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
          template: {
            kind: "builtin",
            id: "builtin.editorial-indigo",
            manifestVersion: "1.0.0",
          },
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
