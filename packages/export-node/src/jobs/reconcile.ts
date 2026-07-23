import { cleanupAbandonedExportAttempt, type ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import { FileExportArtifactStore } from "./file-artifact-store.js";
import { FileExportJobStore } from "./file-job-store.js";
import { FileExportSpoolStore } from "./file-spool-store.js";

export interface ReconcileStaleExportJobsResultV1 {
  finalizationsRecovered: number;
  requeued: string[];
  interrupted: string[];
  cancelled: string[];
}

/** Reconcile durable result intents first, then reclaim every expired process lease. */
export async function reconcileStaleExportJobs(
  jobs: FileExportJobStore,
  stores: { spool: FileExportSpoolStore; artifacts: FileExportArtifactStore },
  now = Date.now(),
): Promise<ReconcileStaleExportJobsResultV1> {
  const finalizationsRecovered = await jobs.reconcilePreparedArtifactFinalizations();
  const active = await jobs.list({ states: ["running", "cancelling"], includeDismissed: true, limit: 500 });
  const result: ReconcileStaleExportJobsResultV1 = { finalizationsRecovered, requeued: [], interrupted: [], cancelled: [] };
  for (const job of active) {
    if (!job.lease || job.lease.expiresAt > now) continue;
    let next: ExportJobSnapshotV1;
    try { next = await jobs.compareAndSet({ kind: "reclaim-expired", id: job.id, expectedRevision: job.revision, now }); }
    catch (error) {
      if (["revision-conflict", "lease-not-expired"].includes((error as { code?: string }).code ?? "")) continue;
      throw error;
    }
    if (next.state === "queued") result.requeued.push(next.id);
    else if (next.state === "interrupted") result.interrupted.push(next.id);
    else if (next.state === "cancelled") result.cancelled.push(next.id);
  }
  // A crash after the metadata CAS but before byte cleanup is recovered by this
  // second scan. Preserve committed spool refs (including ready checkpoints),
  // close the stale epoch against late writers, and discard only staged output.
  const inactive = await jobs.list({ includeDismissed: true, limit: 500 });
  for (const job of inactive) {
    if (job.lease || job.leaseEpoch <= 0) continue;
    const preserveSpoolRefs = await stores.spool.listNamespaceRefs(job.id, job.leaseEpoch);
    await cleanupAbandonedExportAttempt(stores, job.id, job.leaseEpoch, { preserveSpoolRefs });
  }
  return result;
}

/** Polling is the correctness path; fs.watch is deliberately not treated as durable truth. */
export async function* watchFileExportJobEvents(
  jobs: FileExportJobStore,
  jobId: string,
  options: { afterSeq?: number; pollMs?: number; signal?: AbortSignal } = {},
): AsyncIterable<import("@atlcli/export-jobs").ExportJobEventV1> {
  let sequence = options.afterSeq ?? 0; const pollMs = options.pollMs ?? 100;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await jobs.readEvents(jobId, { afterSeq: sequence, limit: 500 });
    for (const event of page.events) { sequence = Math.max(sequence, event.seq); yield event; }
    const snapshot = await jobs.get(jobId); if (!snapshot) return;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.state) && page.events.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }
}
