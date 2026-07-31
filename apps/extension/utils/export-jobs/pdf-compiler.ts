import type {
  PdfCompilePort,
  PdfCompileResult,
  PdfSourceBundle,
} from "@atlcli/pdf/browser";
import type { ChromeWorkerCompilerHost } from "../pdf/compiler-host.js";
import { estimateSourcePages, pdfJobDeadlineMs } from "../pdf/compile-port.js";
import {
  createPdfJobId,
  deletePdfJob,
  getPdfJob,
  markPdfJobConsumed,
  putPdfJob,
  type PutPdfJobInput,
  type StoredPdfJob,
} from "../pdf/job-store.js";
import { IndexedDbExportJobCatalog } from "./catalog.js";

interface PrivatePdfCompilerHost {
  compile(
    jobId: string,
    hints?: { kind?: "export" | "preview"; pages?: number },
  ): ReturnType<ChromeWorkerCompilerHost["compile"]>;
  cancel(jobId: string): ReturnType<ChromeWorkerCompilerHost["cancel"]>;
}

export interface OffscreenPrivatePdfCompilePortDeps {
  catalog: Pick<
    IndexedDbExportJobCatalog,
    "putLegacyBridge" | "deleteLegacyBridge"
  >;
  host: PrivatePdfCompilerHost;
  createJob(input: PutPdfJobInput): Promise<unknown>;
  getJob(id: string): Promise<StoredPdfJob | undefined>;
  consumeJob(id: string): Promise<unknown>;
  deleteJob(id: string): Promise<void>;
  makeJobId(): string;
  now(): number;
}

export interface OffscreenPrivatePdfCompilePortOptions {
  outerJobId: string;
  outerLeaseEpoch: number;
  sourceIdentity: string;
  siteOrigin: string;
  title: string;
  filename: string;
  deps: Pick<OffscreenPrivatePdfCompilePortDeps, "catalog" | "host">
    & Partial<Omit<OffscreenPrivatePdfCompilePortDeps, "catalog" | "host">>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("PDF export was cancelled.", "AbortError");
  }
}

/** Private transition-period compiler transport owned by one common outer lease. */
export function createOffscreenPrivatePdfCompilePort(
  options: OffscreenPrivatePdfCompilePortOptions,
): PdfCompilePort {
  const deps: OffscreenPrivatePdfCompilePortDeps = {
    createJob: (input) => putPdfJob(input),
    getJob: (id) => getPdfJob(id, undefined, { bundle: false, pdf: true }),
    consumeJob: markPdfJobConsumed,
    deleteJob: deletePdfJob,
    makeJobId: createPdfJobId,
    now: Date.now,
    ...options.deps,
  };
  return {
    async compile(bundle: PdfSourceBundle, context = {}): Promise<PdfCompileResult> {
      throwIfAborted(context.signal);
      const legacyJobId = deps.makeJobId();
      const pages = estimateSourcePages(bundle);
      let stored = false;
      let bridged = false;
      const cancel = (): void => {
        deps.host.cancel(legacyJobId);
      };
      context.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const createdAt = deps.now();
        await deps.createJob({
          id: legacyJobId,
          sourceIdentity: options.sourceIdentity,
          bundle,
          createdAt,
          kind: "export",
          deadlineAt: createdAt + pdfJobDeadlineMs(pages),
          siteOrigin: options.siteOrigin,
          title: options.title,
          filename: options.filename,
          scopeLabel: `Private compiler for ${options.outerJobId}`,
          activityVisibility: "private",
          parentJobId: options.outerJobId,
          parentLeaseEpoch: options.outerLeaseEpoch,
        });
        stored = true;
        await deps.catalog.putLegacyBridge({
          legacyJobId,
          outerJobId: options.outerJobId,
          outerLeaseEpoch: options.outerLeaseEpoch,
          hidden: true,
          createdAt,
        });
        bridged = true;
        throwIfAborted(context.signal);

        const compiled = await deps.host.compile(legacyJobId, { kind: "export", pages });
        throwIfAborted(context.signal);
        const job = await deps.getJob(legacyJobId);
        if (job?.status === "complete" && job.pdf) {
          return {
            pdf: job.pdf,
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
            ...(job.fontEvidence ? { fontEvidence: job.fontEvidence } : {}),
          };
        }
        if (job?.status === "failed" && (job.diagnostics?.length ?? 0) > 0) {
          return {
            diagnostics: job.diagnostics ?? [],
            compilerVersion: job.compilerVersion ?? "unknown",
          };
        }
        throw new Error(
          job?.error
          ?? (compiled.ok ? undefined : compiled.error)
          ?? "Private PDF compilation failed.",
        );
      } finally {
        context.signal?.removeEventListener("abort", cancel);
        if (stored) {
          await deps.consumeJob(legacyJobId).catch(() => undefined);
          await deps.deleteJob(legacyJobId).catch(() => undefined);
        }
        if (bridged) {
          await deps.catalog.deleteLegacyBridge(
            options.outerJobId,
            options.outerLeaseEpoch,
            legacyJobId,
          ).catch(() => undefined);
        }
      }
    },
  };
}
