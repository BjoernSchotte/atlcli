import type {
  DocxExportJobRequestV1,
  ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import type { DocxExportRequest } from "../ports/export.js";
import {
  IndexedDbExportJobCatalog,
} from "./catalog.js";
import {
  createExtensionDocxJobRequest,
  type CreateExtensionDocxJobRequestOptions,
} from "./docx-request.js";

export interface SubmitExtensionDocxExportDeps
  extends CreateExtensionDocxJobRequestOptions {
  catalog: Pick<IndexedDbExportJobCatalog, "create" | "get" | "compareAndSet">;
  wake(jobIds: string[]): Promise<{ claimedJobId?: string; error?: string }>;
}

export interface SubmittedExtensionDocxExportV1 {
  request: DocxExportJobRequestV1;
  snapshot: ExportJobSnapshotV1;
  /** Doorbell delivery may fail; the durable queued job remains authoritative. */
  wakeWarning?: string;
}

/** Persist first, then ring the offscreen doorbell. */
export async function submitExtensionDocxExport(
  input: DocxExportRequest,
  deps: SubmitExtensionDocxExportDeps,
): Promise<SubmittedExtensionDocxExportV1> {
  input.signal?.throwIfAborted();
  const request = await createExtensionDocxJobRequest(input, deps);
  const snapshot = await deps.catalog.create({ request });
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
    throw input.signal.reason ?? new DOMException("DOCX export was cancelled.", "AbortError");
  }
  const wake = await deps.wake([snapshot.id]);
  return {
    request,
    snapshot,
    ...(wake.error === undefined ? {} : { wakeWarning: wake.error }),
  };
}

export function chromeDocxExportSubmissionDeps(): SubmitExtensionDocxExportDeps {
  const catalog = new IndexedDbExportJobCatalog();
  return {
    catalog,
    wake: async (jobIds) => {
      const response = await chrome.runtime.sendMessage({ kind: "jobs:wake", jobIds }) as {
        kind?: string;
        claimedJobId?: string;
        error?: string;
      } | undefined;
      if (response?.kind !== "jobs:wake-result") {
        return { error: "Background DOCX queue returned no result." };
      }
      return response.error === undefined
        ? { ...(response.claimedJobId ? { claimedJobId: response.claimedJobId } : {}) }
        : { error: response.error };
    },
  };
}
