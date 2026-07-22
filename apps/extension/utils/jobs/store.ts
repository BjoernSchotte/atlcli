/**
 * The durable-jobs port (spec 010 T5.6).
 *
 * What the Jobs UI is written against: a list of export jobs for **this site**,
 * plus the four things a user can do with one — show/download the result, cancel
 * a running one, dismiss a finished one. Everything underneath is the durable
 * records in the common `atlcli-export-jobs` catalog plus the transitional
 * `atlcli-pdf` store; nothing here holds state of its own, which makes
 * re-attachment after a panel close (or a service-worker restart) a plain read.
 *
 * ## Bytes never cross `sendMessage`
 *
 * The only legacy message this port sends is `{ kind: "pdf:cancel", jobId }`.
 * Artifact bytes travel exclusively through IndexedDB and are read only by the
 * UI host when a user explicitly downloads a completed result.
 *
 * ## Copy honesty
 *
 * A job listed here survives page navigation, closing the panel and a
 * service-worker restart. It does **not** survive closing the browser: there is
 * no server side to this, and the UI must never suggest otherwise
 * (`jobs.durabilityNote`).
 */
import type { PdfJobKind } from "../messages.js";
import type { ExportJobState } from "@atlcli/export-jobs";
import {
  cancelPdfJob,
  deletePdfJob,
  getPdfJob,
  listPdfJobMeta,
  markPdfJobConsumed,
  type PdfJobProgress,
  type PdfJobStatus,
  type StoredPdfJobMeta,
} from "../pdf/job-store.js";
import { isPdfJobInFlight, siteOriginFromSourceIdentity } from "./model.js";
import { listExtensionExportActivity, type ExtensionExportActivityRowV1 } from "../export-jobs/activity.js";
import { IndexedDbExportJobCatalog } from "../export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../export-jobs/chunk-store.js";

/** One row of the Jobs list. */
export interface DurableJob {
  /** Stable action route. Common and legacy ids may otherwise collide. */
  id: string;
  jobId?: string;
  source?: "common" | "legacy-pdf";
  format?: "pdf" | "docx";
  status: PdfJobStatus;
  kind: PdfJobKind;
  /** Site the job belongs to, or `null` when its identity carried no URL. */
  siteOrigin: string | null;
  title: string | null;
  filename: string | null;
  scopeLabel: string | null;
  progress: PdfJobProgress | null;
  createdAt: number;
  bytes: number;
  error: string | null;
  /** True while a compiler still owns it. */
  running: boolean;
  /** True when a result is stored and nobody has collected it yet. */
  collectable: boolean;
}

function statusOfCommon(state: ExportJobState): PdfJobStatus {
  switch (state) {
    case "queued":
    case "waiting":
      return "prepared";
    case "running":
    case "cancelling":
      return "compiling";
    case "succeeded":
      return "complete";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function activityRowToDurableJob(row: ExtensionExportActivityRowV1): DurableJob {
  const active = row.state === "queued" || row.state === "waiting" || row.state === "running" || row.state === "cancelling";
  return {
    id: row.key,
    jobId: row.id,
    source: row.source,
    format: row.format,
    status: statusOfCommon(row.state),
    kind: "export",
    siteOrigin: row.siteOrigin,
    title: row.displayName,
    filename: null,
    scopeLabel: row.stage ? `${row.format.toUpperCase()} · ${row.stage}` : row.format.toUpperCase(),
    progress: row.progress && row.progress.total !== null
      ? { done: row.progress.done, total: row.progress.total }
      : null,
    createdAt: row.createdAt,
    bytes: row.bytes,
    error: row.error ?? null,
    running: active,
    collectable: row.collectable,
  };
}

export interface DurableJobsPort {
  /**
   * Jobs for one site, newest first.
   *
   * Previews are excluded: they are panel-owned transients that the user never
   * asked to keep, and listing them would turn a debounced preview loop into a
   * scrolling activity feed.
   */
  list(options?: { siteOrigin?: string | null }): Promise<DurableJob[]>;
  /** Abort a running job (message to the compiler; the record becomes `cancelled`). */
  cancel(id: string): Promise<void>;
  /** Forget a finished job and its bytes. */
  dismiss(id: string): Promise<void>;
  /**
   * Hand the result to the user: emit the download, mark the record consumed and
   * delete it. Resolves `false` when the job has no stored result.
   */
  download(id: string): Promise<boolean>;
}

export interface DurableJobsDeps {
  list: typeof listPdfJobMeta;
  read: typeof getPdfJob;
  cancelJob: typeof cancelPdfJob;
  deleteJob: typeof deletePdfJob;
  consume: typeof markPdfJobConsumed;
  /** Ask the compiler to stop. Best-effort: the record transition is what counts. */
  requestCancel: (jobId: string) => Promise<void>;
  /** Deliver bytes to the user (a download, a save dialog, a Forge attachment…). */
  emit: (filename: string, bytes: Uint8Array) => Promise<void>;
}

/** Map a stored record onto the row the UI renders. */
export function toDurableJob(meta: StoredPdfJobMeta): DurableJob {
  const running = isPdfJobInFlight(meta.status);
  return {
    id: meta.id,
    status: meta.status,
    kind: meta.kind ?? "export",
    siteOrigin: meta.siteOrigin ?? siteOriginFromSourceIdentity(meta.sourceIdentity),
    title: meta.title ?? null,
    filename: meta.filename ?? null,
    scopeLabel: meta.scopeLabel ?? null,
    progress: meta.progress ?? null,
    createdAt: meta.createdAt,
    bytes: meta.inputBytes + meta.outputBytes,
    error: meta.error ?? null,
    running,
    collectable: meta.status === "complete" && meta.outputBytes > 0 && meta.consumed !== true,
  };
}

export function createDurableJobsStore(deps: DurableJobsDeps): DurableJobsPort {
  return {
    async list(options = {}): Promise<DurableJob[]> {
      const wanted = options.siteOrigin ?? null;
      return (await deps.list())
        .filter((meta) => meta.activityVisibility !== "private")
        .map(toDurableJob)
        .filter((job) => job.kind === "export")
        .filter((job) => wanted === null || job.siteOrigin === wanted)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async cancel(id: string): Promise<void> {
      await deps.requestCancel(id).catch(() => undefined);
      // The compiler host cancels the record when it owns the job; doing it here
      // too covers the case where it does not (queued behind a restart), and the
      // transition is idempotent.
      await deps.cancelJob(id).catch(() => undefined);
    },

    async dismiss(id: string): Promise<void> {
      await deps.deleteJob(id);
    },

    async download(id: string): Promise<boolean> {
      const job = await deps.read(id, undefined, { bundle: false, pdf: true });
      if (!job?.pdf || job.status !== "complete") return false;
      await deps.emit(job.filename ?? `${job.title ?? "export"}.pdf`, job.pdf);
      // Consume first, then delete: if the delete is lost to a teardown, the
      // sweep still removes a record flagged as collected, whereas a lost
      // consume would leave the badge counting bytes the user already has.
      await deps.consume(id).catch(() => undefined);
      await deps.deleteJob(id).catch(() => undefined);
      return true;
    },
  };
}

export interface ExtensionDurableJobsDeps {
  catalog: IndexedDbExportJobCatalog;
  bytes: IndexedDbExportByteStore;
  legacy: DurableJobsPort;
  listLegacyPdf?: () => Promise<StoredPdfJobMeta[]>;
  emit: (filename: string, bytes: Uint8Array, mimeType: string) => Promise<void>;
  now?: () => number;
}

function splitActivityRoute(route: string): { source: "common" | "legacy-pdf"; jobId: string } {
  const separator = route.indexOf(":");
  const source = route.slice(0, separator);
  const jobId = route.slice(separator + 1);
  if ((source !== "common" && source !== "legacy-pdf") || separator < 1 || jobId.length === 0) {
    throw new TypeError("Activity action requires a namespaced job id.");
  }
  return { source, jobId };
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Productive Activity port: one projection and routed actions over common plus legacy stores. */
export function createExtensionDurableJobsStore(deps: ExtensionDurableJobsDeps): DurableJobsPort {
  const now = deps.now ?? Date.now;
  return {
    async list(options = {}): Promise<DurableJob[]> {
      const wanted = options.siteOrigin ?? null;
      return (await listExtensionExportActivity({
        listCommon: deps.catalog.list.bind(deps.catalog),
        listLegacyPdf: deps.listLegacyPdf ?? listPdfJobMeta,
        listLegacyBridges: deps.catalog.listLegacyBridges.bind(deps.catalog),
      }))
        .filter((row) => wanted === null || row.siteOrigin === wanted)
        .map(activityRowToDurableJob);
    },

    async cancel(route: string): Promise<void> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.cancel(jobId);
      const current = await deps.catalog.get(jobId);
      if (!current || ["succeeded", "failed", "cancelled", "interrupted", "cancelling"].includes(current.state)) return;
      await deps.catalog.compareAndSet({
        id: jobId,
        kind: "transition",
        expectedRevision: current.revision,
        to: current.state === "running" ? "cancelling" : "cancelled",
        at: now(),
      });
    },

    async dismiss(route: string): Promise<void> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.dismiss(jobId);
      const current = await deps.catalog.get(jobId);
      if (!current) return;
      await deps.catalog.dismiss(jobId, current.revision, now());
    },

    async download(route: string): Promise<boolean> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.download(jobId);
      const current = await deps.catalog.get(jobId);
      if (current?.state !== "succeeded" || !current.artifact || current.deliveredAt !== undefined) return false;
      const bytes = await collectBytes(deps.bytes.read(current.artifact.ref));
      await deps.emit(current.artifact.filename, bytes, current.artifact.mediaType);
      await deps.catalog.deliver(jobId, current.revision, now());
      return true;
    },
  };
}

/**
 * The Chrome binding: durable records plus the one scalar message.
 *
 * Built lazily by the host seam (`utils/jobs/context.tsx`), never at module
 * scope, so importing this file outside an extension stays free.
 */
export function chromeDurableJobsStore(): DurableJobsPort {
  const legacy = createDurableJobsStore({
    list: listPdfJobMeta,
    read: getPdfJob,
    cancelJob: cancelPdfJob,
    deleteJob: deletePdfJob,
    consume: markPdfJobConsumed,
    requestCancel: async (jobId) => {
      await chrome.runtime.sendMessage({ kind: "pdf:cancel", jobId });
    },
    emit: async (filename, bytes) => {
      const { downloadBytes } = await import("../download.js");
      await downloadBytes({ name: filename, bytes, mimeType: "application/pdf" });
    },
  });
  return createExtensionDurableJobsStore({
    catalog: new IndexedDbExportJobCatalog(),
    bytes: new IndexedDbExportByteStore(),
    legacy,
    emit: async (filename, bytes, mimeType) => {
      const { downloadBytes } = await import("../download.js");
      await downloadBytes({ name: filename, bytes, mimeType });
    },
  });
}
