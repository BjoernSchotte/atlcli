/**
 * The panel's `PdfCompilePort` over the durable job store (spec 010 T5.1/T5.6).
 *
 * ## The record is the truth, the message is an optimization
 *
 * This port used to hold one `await chrome.runtime.sendMessage(...)` open for
 * the whole compile and treat its resolution as the outcome. MV3 may terminate
 * the service worker mid-request, which drops that promise with no response —
 * and the panel then hangs even though the offscreen worker kept compiling and
 * kept writing the job record. So the compile is now awaited **both** ways: the
 * message for the fast path, {@link watchPdfJob} on the durable record for the
 * truth, whichever arrives first. A job whose worker never reports back ends
 * `failed` at its deadline rather than sitting at `compiling` forever.
 *
 * ## Cleanup ownership
 *
 * `finally` used to `deletePdfJob` unconditionally — in the *panel*, i.e. in
 * exactly the context a background export is defined by not having. The rule now:
 *
 *   - **consumed → delete.** The panel has the bytes; the record is spent.
 *   - **preview → delete.** A preview is panel-owned by definition; nobody
 *     re-attaches to one, and leaving debounced churn behind would fill the
 *     shared budget.
 *   - **anything else → leave it.** Either the job is still running (the Jobs
 *     screen re-attaches to it) or it is terminal, in which case
 *     `completePdfJob`/`failPdfJob`/`cancelPdfJob` already released its source
 *     bundle from the side that outlives this panel.
 */
import type { PdfCompilePort, PdfCompileResult, PdfSourceBundle } from "@atlcli/pdf/browser";
import type { ExtRequest, ExtResponse, PdfJobKind } from "../messages.js";
import { siteOriginFromSourceIdentity } from "../jobs/model.js";
import { watchPdfJob, type WatchPdfJobOptions } from "../jobs/watch.js";
import {
  PDF_COMPILE_BASE_TIMEOUT_MS,
  PDF_COMPILE_MAX_TIMEOUT_MS,
  PDF_COMPILE_PER_PAGE_TIMEOUT_MS,
} from "./compiler-host.js";
import {
  cleanupPdfJobs,
  createPdfJobId,
  deletePdfJob,
  getPdfJob,
  markPdfJobConsumed,
  putPdfJob,
} from "./job-store.js";

type PdfJobRequest = Extract<ExtRequest, { kind: "pdf:compile" | "pdf:cancel" }>;
type PdfJobResponse = Extract<ExtResponse, { kind: "pdf:compile-result" | "pdf:cancel-result" }>;

export interface ExtensionPdfCompilePortDeps {
  cleanupJobs: typeof cleanupPdfJobs;
  createJob: typeof putPdfJob;
  getJob: typeof getPdfJob;
  deleteJob: typeof deletePdfJob;
  consumeJob: typeof markPdfJobConsumed;
  sendMessage: (message: PdfJobRequest) => Promise<PdfJobResponse | undefined>;
  /** Watch the durable record to a terminal state. Injectable for tests. */
  watchJob: (jobId: string, options: WatchPdfJobOptions) => ReturnType<typeof watchPdfJob>;
  now: () => number;
}

export interface ExtensionPdfCompilePortOptions {
  sourceIdentity: string;
  /**
   * Scheduling class of the compiles this port issues (spec 010 T5.3).
   * Defaults to `"export"`: a caller that has not thought about scheduling gets
   * the behaviour that never yields to anything else.
   */
  kind?: PdfJobKind;
  /**
   * Metadata the Jobs list renders. All optional — the site origin falls back to
   * the one encoded in `sourceIdentity`, which is where every caller's page URL
   * already is, so a background job is attributable to a site without any
   * caller having to be changed first.
   */
  siteOrigin?: string;
  title?: string;
  filename?: string;
  scopeLabel?: string;
  makeJobId?: () => string;
  /**
   * The durable record now exists under this id.
   *
   * The seam a progress producer needs: per-page ticks are produced by the tree
   * walk in `run-export.ts`, which has no way to name the job otherwise, and
   * `updatePdfJobProgress(jobId, …)` is what puts "Page 37/210" on the Jobs
   * screen for a job whose panel has gone away.
   */
  onJobCreated?: (jobId: string) => void;
  onQueued?: () => void;
  onCompiling?: () => void;
  deps?: Partial<ExtensionPdfCompilePortDeps>;
}

/**
 * Estimated **source** pages in a bundle, for the compile-timeout budget.
 *
 * The composed document separates chapters with `pageBreak` blocks
 * (`composeChapters`), so `1 + pageBreaks` is the number of source pages the
 * caller asked for. It is deliberately *not* the compiled PDF page count: that
 * exists only after `validatePdfOutput`, long after the timeout has to be
 * chosen. Reading it from the source map costs nothing — the port already holds
 * the bundle — which is why the estimate lives here rather than being threaded
 * down from every caller.
 */
export function estimateSourcePages(bundle: PdfSourceBundle): number {
  let breaks = 0;
  for (const entry of bundle.sourceMap) {
    if (entry.blockType === "pageBreak") breaks += 1;
  }
  return breaks + 1;
}

/**
 * Grace added to the compiler's own timeout before the record's watchdog fires.
 *
 * The offscreen host already fails a hung compile at `timeoutForPages(pages)`.
 * The record's deadline must sit *after* that, or the watchdog would fail jobs
 * the compiler was about to fail itself with a far better message — and would
 * race a compile that finished a millisecond late.
 */
export const PDF_JOB_DEADLINE_SLACK_MS = 30_000;

/** The record deadline for a job of `pages` source pages. Pure. */
export function pdfJobDeadlineMs(pages: number): number {
  const normalized = Math.max(1, Math.floor(Number.isFinite(pages) ? pages : 1));
  const compileBudget = Math.min(
    PDF_COMPILE_MAX_TIMEOUT_MS,
    PDF_COMPILE_BASE_TIMEOUT_MS + PDF_COMPILE_PER_PAGE_TIMEOUT_MS * (normalized - 1)
  );
  return compileBudget + PDF_JOB_DEADLINE_SLACK_MS;
}

const defaultDeps: ExtensionPdfCompilePortDeps = {
  cleanupJobs: cleanupPdfJobs,
  createJob: putPdfJob,
  getJob: getPdfJob,
  deleteJob: deletePdfJob,
  consumeJob: markPdfJobConsumed,
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  watchJob: watchPdfJob,
  now: () => Date.now(),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

export function extensionPdfCompilePort(options: ExtensionPdfCompilePortOptions): PdfCompilePort {
  const deps = { ...defaultDeps, ...options.deps };
  const kind = options.kind ?? "export";
  return {
    async compile(bundle: PdfSourceBundle, context = {}): Promise<PdfCompileResult> {
      const jobId = (options.makeJobId ?? createPdfJobId)();
      const pages = estimateSourcePages(bundle);
      let stored = false;
      let consumed = false;
      let cancelSent = false;
      const cancel = (): void => {
        if (cancelSent) return;
        cancelSent = true;
        void deps.sendMessage({ kind: "pdf:cancel", jobId }).catch(() => undefined);
      };
      context.signal?.addEventListener("abort", cancel, { once: true });
      let watch: ReturnType<typeof watchPdfJob> | null = null;

      try {
        await deps.cleanupJobs().catch(() => 0);
        throwIfAborted(context.signal);
        const deadlineAt = deps.now() + pdfJobDeadlineMs(pages);
        await deps.createJob({
          id: jobId,
          sourceIdentity: options.sourceIdentity,
          bundle,
          kind,
          deadlineAt,
          siteOrigin:
            options.siteOrigin ?? siteOriginFromSourceIdentity(options.sourceIdentity) ?? undefined,
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.filename === undefined ? {} : { filename: options.filename }),
          ...(options.scopeLabel === undefined ? {} : { scopeLabel: options.scopeLabel }),
        });
        stored = true;
        options.onJobCreated?.(jobId);
        throwIfAborted(context.signal);
        options.onQueued?.();
        options.onCompiling?.();

        // Both paths run. The message answers in the normal case; the record
        // answers when the service worker that carried it did not survive.
        const messaged = deps
          .sendMessage({ kind: "pdf:compile", jobId, job: kind, pages })
          .then((response) => ({ response }))
          .catch(() => ({ response: undefined }));
        watch = deps.watchJob(jobId, { deadlineAt });
        const settled = await Promise.race([
          messaged.then(() => "message" as const),
          watch.promise.then(() => "record" as const),
        ]);
        throwIfAborted(context.signal);

        const response = settled === "message" ? (await messaged).response : undefined;
        let job = await deps.getJob(jobId, undefined, { bundle: false, pdf: true });
        if (job && (job.status === "prepared" || job.status === "compiling")) {
          // The message came back before the record caught up (or came back
          // empty after a worker restart): wait for the record, which is the one
          // that cannot lie about the outcome.
          await watch.promise;
          job = await deps.getJob(jobId, undefined, { bundle: false, pdf: true });
        }
        throwIfAborted(context.signal);

        if (job?.status === "complete" && job.pdf) {
          consumed = true;
          return {
            pdf: job.pdf,
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
          };
        }
        if (job?.status === "failed" && (job.diagnostics?.length ?? 0) > 0) {
          // A diagnostics-only failure IS the result the caller asked for: it is
          // rendered as a report, so the record has been consumed.
          consumed = true;
          return {
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
          };
        }
        if (response && response.kind === "pdf:compile-result" && response.jobId !== jobId) {
          throw new Error("PDF compiler returned no correlated response.");
        }
        throw new Error(
          job?.error ??
            (response && response.kind === "pdf:compile-result" && !response.ok
              ? response.error
              : undefined) ??
            "PDF compilation failed."
        );
      } finally {
        watch?.stop();
        context.signal?.removeEventListener("abort", cancel);
        // Cleanup ownership (see the module comment): the panel deletes only
        // what it consumed, plus its own previews.
        if (stored && (consumed || kind === "preview")) {
          if (consumed) await deps.consumeJob(jobId).catch(() => undefined);
          await deps.deleteJob(jobId).catch(() => undefined);
        }
      }
    },
  };
}
