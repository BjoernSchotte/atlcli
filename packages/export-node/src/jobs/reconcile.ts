import { cleanupAbandonedExportAttempt, type ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import { FileExportArtifactStore } from "./file-artifact-store.js";
import { FileExportJobStore } from "./file-job-store.js";
import { FileExportSpoolStore } from "./file-spool-store.js";

export interface ReconcileStaleExportJobsResultV1 {
  finalizationsRecovered: number;
  /** One message per prepared finalization that could not be finished; these never abort the reconcile. */
  finalizationFailures: string[];
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
  // One unfinishable intent must not block the other intents, the lease
  // reclaim below, or the export that triggered this reconcile.
  const finalizationFailures: string[] = [];
  const finalizationsRecovered = await jobs.reconcilePreparedArtifactFinalizations((error, intent) => {
    finalizationFailures.push(`${intent.finalize.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (finalizationFailures.length > 0) {
    process.stderr.write(`warn: could not finish ${finalizationFailures.length} prepared export finalization(s) (${finalizationFailures[0]}); new exports continue.\n`);
  }
  const active = await jobs.list({ states: ["running", "cancelling"], includeDismissed: true, limit: 500 });
  const result: ReconcileStaleExportJobsResultV1 = { finalizationsRecovered, finalizationFailures, requeued: [], interrupted: [], cancelled: [] };
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
    // An earlier start already closed this epoch and removed its staged
    // output: skip the two locks, fsyncs and directory scans per historical job.
    if (
      await stores.spool.isNamespaceClosed(job.id, job.leaseEpoch) &&
      await stores.artifacts.isEpochSettled(job.id, job.leaseEpoch)
    ) continue;
    const preserveSpoolRefs = await stores.spool.listNamespaceRefs(job.id, job.leaseEpoch);
    await cleanupAbandonedExportAttempt(stores, job.id, job.leaseEpoch, { preserveSpoolRefs });
  }
  return result;
}
