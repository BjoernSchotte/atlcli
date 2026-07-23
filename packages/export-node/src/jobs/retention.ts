import {
  cleanupTombstonedExportJob,
  planExportJobLifecycleRetentionV1,
  type ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import type { FileExportJobPersistenceV1 } from "./persistence.js";

const PAGE_SIZE = 500;
const TERMINAL_STATES: ExportJobSnapshotV1["state"][] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export interface FileExportRetentionSweepResultV1 {
  payloadReleases: number;
  historyDeleted: number;
  tombstonesReconciled: number;
}

async function listCompleteTerminalHistory(
  persistence: FileExportJobPersistenceV1,
): Promise<ExportJobSnapshotV1[]> {
  const result: ExportJobSnapshotV1[] = [];
  let cursorBefore: { createdAt: number; id: string } | undefined;
  while (true) {
    const page = await persistence.jobs.list({
      states: TERMINAL_STATES,
      includeDismissed: true,
      limit: PAGE_SIZE,
      ...(cursorBefore ? { cursorBefore } : {}),
    });
    result.push(...page);
    if (page.length < PAGE_SIZE) return result;
    const last = page.at(-1)!;
    cursorBefore = { createdAt: last.createdAt, id: last.id };
  }
}

async function reconcileReleasedPayloads(
  persistence: FileExportJobPersistenceV1,
  snapshots: readonly ExportJobSnapshotV1[],
): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.artifactReleasedAt !== undefined) {
      await persistence.artifacts.cleanupJob(snapshot.id);
    }
    if (snapshot.reportReleasedAt !== undefined) {
      await persistence.jobs.cleanupReleasedReportPayloads(snapshot.id);
    }
  }
}

async function reconcilePendingTombstones(
  persistence: FileExportJobPersistenceV1,
  now: number,
): Promise<number> {
  let reconciled = 0;
  while (true) {
    const pending = await persistence.jobs.listTombstones({
      cleanupPending: true,
      limit: PAGE_SIZE,
    });
    if (pending.length === 0) return reconciled;
    for (const tombstone of pending) {
      await cleanupTombstonedExportJob(
        {
          spool: persistence.spool,
          artifacts: persistence.artifacts,
        },
        tombstone,
      );
      await persistence.jobs.markTombstoneCleanupComplete(
        tombstone.jobId,
        tombstone.ref,
        now,
      );
      reconciled += 1;
    }
  }
}

function isRevisionConflict(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "revision-conflict";
}

/**
 * Foreground Node/CLI retention pass. The CLI has no detached daemon; every
 * jobs command and ordinary export invokes this same common policy while the
 * process is alive.
 */
export async function sweepFileExportJobRetentionV1(
  persistence: FileExportJobPersistenceV1,
  now: number,
): Promise<FileExportRetentionSweepResultV1> {
  let tombstonesReconciled = await reconcilePendingTombstones(persistence, now);
  const initial = await listCompleteTerminalHistory(persistence);
  await reconcileReleasedPayloads(persistence, initial);
  const plan = planExportJobLifecycleRetentionV1(initial, now);
  let payloadReleases = 0;
  for (const release of plan.releases) {
    try {
      const snapshot = await persistence.jobs.compareAndSet({
        kind: "retention",
        at: now,
        ...release,
      });
      await reconcileReleasedPayloads(persistence, [snapshot]);
      payloadReleases += 1;
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
    }
  }

  const refreshed = await listCompleteTerminalHistory(persistence);
  await reconcileReleasedPayloads(persistence, refreshed);
  const refreshedById = new Map(refreshed.map((job) => [job.id, job]));
  const deleteJobIds = planExportJobLifecycleRetentionV1(
    refreshed,
    now,
  ).deleteJobIds.filter((id) => {
    const job = refreshedById.get(id);
    if (!job || job.reportReleasedAt === undefined) return false;
    return job.state !== "succeeded" ||
      (job.artifactReleasedAt !== undefined &&
        (job.deliveredAt !== undefined || job.dismissedAt !== undefined));
  });
  let historyDeleted = 0;
  for (let offset = 0; offset < deleteJobIds.length; offset += PAGE_SIZE) {
    const deleted = await persistence.jobs.deleteTerminal({
      ids: deleteJobIds.slice(offset, offset + PAGE_SIZE),
      finishedBefore: Number.MAX_SAFE_INTEGER,
      limit: PAGE_SIZE,
    });
    historyDeleted += deleted.deletedJobIds.length;
  }
  tombstonesReconciled += await reconcilePendingTombstones(persistence, now);
  return { payloadReleases, historyDeleted, tombstonesReconciled };
}
