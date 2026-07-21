import type { PdfCompilePort, PdfCompileResult, PdfSourceBundle } from "@atlcli/pdf/browser";
import type { ExtRequest, ExtResponse, PdfJobKind } from "../messages.js";
import {
  cleanupPdfJobs,
  createPdfJobId,
  deletePdfJob,
  getPdfJob,
  putPdfJob,
} from "./job-store.js";

type PdfJobRequest = Extract<ExtRequest, { kind: "pdf:compile" | "pdf:cancel" }>;
type PdfJobResponse = Extract<ExtResponse, { kind: "pdf:compile-result" | "pdf:cancel-result" }>;

export interface ExtensionPdfCompilePortDeps {
  cleanupJobs: typeof cleanupPdfJobs;
  createJob: typeof putPdfJob;
  getJob: typeof getPdfJob;
  deleteJob: typeof deletePdfJob;
  sendMessage: (message: PdfJobRequest) => Promise<PdfJobResponse | undefined>;
}

export interface ExtensionPdfCompilePortOptions {
  sourceIdentity: string;
  /**
   * Scheduling class of the compiles this port issues (spec 010 T5.3).
   * Defaults to `"export"`: a caller that has not thought about scheduling gets
   * the behaviour that never yields to anything else.
   */
  kind?: PdfJobKind;
  makeJobId?: () => string;
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

const defaultDeps: ExtensionPdfCompilePortDeps = {
  cleanupJobs: cleanupPdfJobs,
  createJob: putPdfJob,
  getJob: getPdfJob,
  deleteJob: deletePdfJob,
  sendMessage: (message) => chrome.runtime.sendMessage(message),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

export function extensionPdfCompilePort(options: ExtensionPdfCompilePortOptions): PdfCompilePort {
  const deps = { ...defaultDeps, ...options.deps };
  return {
    async compile(bundle: PdfSourceBundle, context = {}): Promise<PdfCompileResult> {
      const jobId = (options.makeJobId ?? createPdfJobId)();
      let stored = false;
      let cancelSent = false;
      const cancel = (): void => {
        if (cancelSent) return;
        cancelSent = true;
        void deps.sendMessage({ kind: "pdf:cancel", jobId }).catch(() => undefined);
      };
      context.signal?.addEventListener("abort", cancel, { once: true });

      try {
        await deps.cleanupJobs().catch(() => 0);
        throwIfAborted(context.signal);
        await deps.createJob({ id: jobId, sourceIdentity: options.sourceIdentity, bundle });
        stored = true;
        throwIfAborted(context.signal);
        options.onQueued?.();
        options.onCompiling?.();
        const response = await deps.sendMessage({
          kind: "pdf:compile",
          jobId,
          job: options.kind ?? "export",
          pages: estimateSourcePages(bundle),
        });
        throwIfAborted(context.signal);
        if (!response || response.kind !== "pdf:compile-result" || response.jobId !== jobId) {
          throw new Error("PDF compiler returned no correlated response.");
        }
        const job = await deps.getJob(jobId);
        throwIfAborted(context.signal);
        if (response.ok) {
          if (!job || job.status !== "complete" || !job.pdf) {
            throw new Error(job?.error ?? "PDF compiler completed without a stored result.");
          }
          return {
            pdf: job.pdf,
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
          };
        }
        if (job?.status === "failed" && (job.diagnostics?.length ?? 0) > 0) {
          return {
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
          };
        }
        throw new Error(job?.error ?? response.error ?? "PDF compilation failed.");
      } finally {
        context.signal?.removeEventListener("abort", cancel);
        if (stored) await deps.deleteJob(jobId).catch(() => undefined);
      }
    },
  };
}
