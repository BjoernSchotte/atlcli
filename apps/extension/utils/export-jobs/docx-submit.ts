import type {
  DocxExportJobRequestV1,
  ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import type { DocxExportRequest } from "../ports/export.js";
import {
  IndexedDbExportJobCatalog,
} from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import {
  createExtensionDocxJobRequest,
  type CreateExtensionDocxJobRequestOptions,
} from "./docx-request.js";
import {
  EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
  extensionDocxTemplateSpoolRef,
} from "./docx-template.js";

export interface SubmitExtensionDocxExportDeps
  extends CreateExtensionDocxJobRequestOptions {
  catalog: Pick<IndexedDbExportJobCatalog, "create" | "get" | "compareAndSet">;
  bytes: Pick<IndexedDbExportByteStore, "put" | "cleanupJob">;
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
  const requestId =
    deps.requestId ?? (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const request = await createExtensionDocxJobRequest(input, {
    ...deps,
    requestId,
  });
  const pinned = await deps.bytes.put(
    extensionDocxTemplateSpoolRef(requestId),
    (async function* () {
      yield new Uint8Array(input.template.bytes);
    })(),
    EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
    { signal: input.signal },
  );
  if (pinned.sha256 !== request.template.sha256) {
    await deps.bytes.cleanupJob(requestId).catch(() => undefined);
    throw new Error("Pinned DOCX template storage changed the template digest.");
  }
  let snapshot: ExportJobSnapshotV1;
  try {
    snapshot = await deps.catalog.create({ request });
  } catch (error) {
    await deps.bytes.cleanupJob(requestId).catch(() => undefined);
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
        return { error: "Background DOCX queue returned no result." };
      }
      return response.error === undefined
        ? { ...(response.claimedJobId ? { claimedJobId: response.claimedJobId } : {}) }
        : { error: response.error };
    },
  };
}
