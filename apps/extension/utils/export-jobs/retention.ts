import {
  planExportJobLifecycleRetentionV1,
  type ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import {
  IndexedDbExportJobCatalog,
} from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";

const PAGE_SIZE = 500;
const TERMINAL_STATES: ExportJobSnapshotV1["state"][] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export interface ExtensionExportRetentionSweepOptionsV1 {
  catalog?: IndexedDbExportJobCatalog;
  bytes?: IndexedDbExportByteStore;
  now?: () => number;
}

export interface ExtensionExportRetentionSweepResultV1 {
  payloadReleases: number;
  historyDeleted: number;
  tombstonesReconciled: number;
}

async function listCompleteTerminalHistory(
  catalog: IndexedDbExportJobCatalog,
): Promise<ExportJobSnapshotV1[]> {
  const result: ExportJobSnapshotV1[] = [];
  let cursorBefore: { createdAt: number; id: string } | undefined;
  while (true) {
    const page = await catalog.list({
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

async function reconcilePendingTombstones(
  catalog: IndexedDbExportJobCatalog,
  bytes: IndexedDbExportByteStore,
  now: number,
): Promise<number> {
  let reconciled = 0;
  while (true) {
    const pending = await catalog.listTombstones({
      cleanupPending: true,
      limit: PAGE_SIZE,
    });
    if (pending.length === 0) return reconciled;
    for (const tombstone of pending) {
      // One central IndexedDB byte store implements both spool and artifacts.
      // A single job cleanup closes the namespace and removes both classes.
      await bytes.cleanupJob(tombstone.jobId);
      await catalog.markTombstoneCleanupComplete(
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
 * Apply common artifact/report/history retention in the persistent extension
 * host. Every payload release is one IDB transaction in the catalog; complete
 * record cleanup is authorized by durable tombstones and resumed after restart.
 */
export async function sweepExtensionExportJobRetention(
  options: ExtensionExportRetentionSweepOptionsV1 = {},
): Promise<ExtensionExportRetentionSweepResultV1> {
  const catalog = options.catalog ?? new IndexedDbExportJobCatalog();
  const bytes = options.bytes ?? new IndexedDbExportByteStore();
  const now = (options.now ?? Date.now)();
  let tombstonesReconciled = await reconcilePendingTombstones(
    catalog,
    bytes,
    now,
  );

  const initial = await listCompleteTerminalHistory(catalog);
  const initialPlan = planExportJobLifecycleRetentionV1(initial, now);
  let payloadReleases = 0;
  for (const release of initialPlan.releases) {
    try {
      await catalog.compareAndSet({
        kind: "retention",
        at: now,
        ...release,
      });
      payloadReleases += 1;
    } catch (error) {
      // A concurrent presentation update/sweep won the CAS. Re-read below;
      // never use the projected release as authority for deletion.
      if (!isRevisionConflict(error)) throw error;
    }
  }

  const refreshed = await listCompleteTerminalHistory(catalog);
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
    const ids = deleteJobIds.slice(offset, offset + PAGE_SIZE);
    const deleted = await catalog.deleteTerminal({
      ids,
      finishedBefore: Number.MAX_SAFE_INTEGER,
      limit: PAGE_SIZE,
    });
    historyDeleted += deleted.deletedJobIds.length;
  }

  tombstonesReconciled += await reconcilePendingTombstones(
    catalog,
    bytes,
    now,
  );
  return { payloadReleases, historyDeleted, tombstonesReconciled };
}
