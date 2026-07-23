import type {
  ExportJobSnapshotV1,
  PdfExportJobRequestV1,
  PdfExportLogoV1,
  SpoolRefV1,
} from "@atlcli/export-jobs";
import type { PdfExportRequest } from "../ports/export.js";
import { IndexedDbExportJobCatalog } from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import { createExtensionPdfJobRequest, type CreateExtensionPdfJobRequestOptions } from "./pdf-request.js";

export interface SubmitExtensionPdfExportDeps extends CreateExtensionPdfJobRequestOptions {
  catalog: Pick<IndexedDbExportJobCatalog, "create" | "get" | "compareAndSet">;
  bytes?: Pick<IndexedDbExportByteStore, "put" | "cleanupJob">;
  wake(jobIds: string[]): Promise<{ claimedJobId?: string; error?: string }>;
}

export interface SubmittedExtensionPdfExportV1 {
  request: PdfExportJobRequestV1;
  snapshot: ExportJobSnapshotV1;
  /** Doorbell delivery may fail; the durable queued job remains authoritative. */
  wakeWarning?: string;
}

export const EXTENSION_PDF_LOGO_LIMITS_V1 = Object.freeze({
  maxObjectBytes: 5 * 1024 * 1024,
  maxJobBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

export function extensionPdfLogoSpoolRef(jobId: string): SpoolRefV1 {
  return { jobId, leaseEpoch: 0, namespace: "request-assets", key: "pdf-logo" };
}

export function extensionPdfLogoAssetRef(jobId: string): string {
  return `extension-spool:${encodeURIComponent(jobId)}:0:request-assets:pdf-logo`;
}

async function pinLogo(
  jobId: string,
  input: PdfExportRequest,
  bytes: SubmitExtensionPdfExportDeps["bytes"],
): Promise<PdfExportLogoV1 | undefined> {
  const logo = input.settings?.logo;
  if (!logo) return undefined;
  if (!bytes) throw new Error("Background PDF logo storage is unavailable.");
  if (typeof logo.alt !== "string" || logo.alt.trim() === "") {
    throw new Error("Background PDF logos require non-empty alternative text.");
  }
  const stored = await bytes.put(
    extensionPdfLogoSpoolRef(jobId),
    (async function* () { yield logo.bytes; })(),
    EXTENSION_PDF_LOGO_LIMITS_V1,
    { signal: input.signal },
  );
  return {
    assetRef: extensionPdfLogoAssetRef(jobId),
    sha256: stored.sha256,
    byteLength: stored.byteLength,
    mediaType: logo.mediaType,
    alt: logo.alt,
  };
}

/** Persist first, then ring the offscreen doorbell. No source read can precede create(). */
export async function submitExtensionPdfExport(
  input: PdfExportRequest,
  deps: SubmitExtensionPdfExportDeps,
): Promise<SubmittedExtensionPdfExportV1> {
  input.signal?.throwIfAborted();
  const requestId = deps.requestId ?? (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const pinnedLogo = await pinLogo(requestId, input, deps.bytes);
  const request = createExtensionPdfJobRequest(input, { ...deps, requestId, pinnedLogo });
  let snapshot: ExportJobSnapshotV1;
  try {
    snapshot = await deps.catalog.create({ request });
  } catch (error) {
    if (pinnedLogo) await deps.bytes?.cleanupJob(requestId).catch(() => undefined);
    throw error;
  }
  if (input.signal?.aborted) {
    const current = await deps.catalog.get(snapshot.id);
    if (current && (current.state === "queued" || current.state === "waiting")) {
      await deps.catalog.compareAndSet({
        kind: "transition",
        id: current.id,
        expectedRevision: current.revision,
        to: "cancelled",
        at: (deps.now ?? Date.now)(),
      });
    }
    throw input.signal.reason ?? new DOMException("PDF export was cancelled.", "AbortError");
  }
  const wake = await deps.wake([snapshot.id]);
  return {
    request,
    snapshot,
    ...(wake.error === undefined ? {} : { wakeWarning: wake.error }),
  };
}

export function chromePdfExportSubmissionDeps(): SubmitExtensionPdfExportDeps {
  const catalog = new IndexedDbExportJobCatalog();
  const bytes = new IndexedDbExportByteStore();
  return {
    catalog,
    bytes,
    wake: async (jobIds) => {
      const response = await chrome.runtime.sendMessage({ kind: "jobs:wake", jobIds }) as {
        kind?: string;
        claimedJobId?: string;
        error?: string;
      } | undefined;
      if (response?.kind !== "jobs:wake-result") {
        return { error: "Background PDF queue returned no result." };
      }
      return response.error === undefined
        ? { ...(response.claimedJobId ? { claimedJobId: response.claimedJobId } : {}) }
        : { error: response.error };
    },
  };
}
