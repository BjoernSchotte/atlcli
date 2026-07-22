/**
 * The durable-jobs port (spec 010 T5.6).
 *
 * What the Jobs UI is written against: a list of export jobs for **this site**,
 * plus the four things a user can do with one — show/download the result, cancel
 * a running one, dismiss a finished one. Everything underneath is the durable
 * record in `atlcli-pdf`; nothing here holds state of its own, which is what
 * makes re-attachment after a panel close (or a service-worker restart) a plain
 * read rather than a reconnection protocol.
 *
 * ## Bytes never cross `sendMessage`
 *
 * The only message this port sends is `{ kind: "pdf:cancel", jobId }`. PDF bytes
 * travel exclusively through IndexedDB, which is the invariant the whole PDF
 * path is built on (`compile-port.ts`, `background.ts`, `compiler-host.ts`) and
 * which `tests/messages.test.ts` pins.
 *
 * ## Copy honesty
 *
 * A job listed here survives page navigation, closing the panel and a
 * service-worker restart. It does **not** survive closing the browser: there is
 * no server side to this, and the UI must never suggest otherwise
 * (`jobs.durabilityNote`).
 */
import type { PdfJobKind } from "../messages.js";
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

/** One row of the Jobs list. */
export interface DurableJob {
  id: string;
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

/**
 * The Chrome binding: durable records plus the one scalar message.
 *
 * Built lazily by the host seam (`utils/jobs/context.tsx`), never at module
 * scope, so importing this file outside an extension stays free.
 */
export function chromeDurableJobsStore(): DurableJobsPort {
  return createDurableJobsStore({
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
}
