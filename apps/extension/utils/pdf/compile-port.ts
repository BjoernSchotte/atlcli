import type { PdfCompilePort, PdfCompileResult, PdfSourceBundle } from "@atlcli/pdf/browser";
import type { ExtRequest, ExtResponse } from "../messages.js";
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
  makeJobId?: () => string;
  onQueued?: () => void;
  onCompiling?: () => void;
  deps?: Partial<ExtensionPdfCompilePortDeps>;
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
        const response = await deps.sendMessage({ kind: "pdf:compile", jobId });
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
