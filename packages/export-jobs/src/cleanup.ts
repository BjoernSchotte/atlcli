import type { ExportArtifactStore, ExportJobStore, ExportSpoolStore } from "./ports.js";
import type { ExportByteCleanupResultV1 } from "./spool.js";
import type { ExportJobTombstoneV1 } from "./store-contracts.js";

export interface ExportOwnedByteStoresV1 {
  spool: ExportSpoolStore;
  artifacts: ExportArtifactStore;
}

export interface ExportOwnedByteCleanupSummaryV1 {
  spool: ExportByteCleanupResultV1;
  artifacts: ExportByteCleanupResultV1;
  objectsDeleted: number;
  bytesDeleted: number;
}

function summary(
  spool: ExportByteCleanupResultV1,
  artifacts: ExportByteCleanupResultV1,
): ExportOwnedByteCleanupSummaryV1 {
  return {
    spool,
    artifacts,
    objectsDeleted: spool.objectsDeleted + artifacts.objectsDeleted,
    bytesDeleted: spool.bytesDeleted + artifacts.bytesDeleted,
  };
}

function assertIdentity(jobId: string, leaseEpoch?: number): void {
  if (jobId.trim().length === 0) throw new Error("Cleanup job id must not be empty.");
  if (
    leaseEpoch !== undefined &&
    (!Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0)
  ) {
    throw new Error("Cleanup lease epoch must be a positive safe integer.");
  }
}

/**
 * Close and remove one abandoned executor epoch. Closing happens inside each
 * adapter's serialized mutation boundary, so a source already being collected
 * cannot publish bytes after cleanup wins.
 */
export async function cleanupAbandonedExportAttempt(
  stores: ExportOwnedByteStoresV1,
  jobId: string,
  leaseEpoch: number,
  options: { preserveSpoolRefs?: readonly import("./spool.js").SpoolRefV1[] } = {},
): Promise<ExportOwnedByteCleanupSummaryV1> {
  assertIdentity(jobId, leaseEpoch);
  const [spool, artifacts] = await Promise.all([
    stores.spool.deleteNamespace(jobId, leaseEpoch, { preserve: options.preserveSpoolRefs }),
    stores.artifacts.deleteStagedEpoch(jobId, leaseEpoch),
  ]);
  return summary(spool, artifacts);
}

/**
 * Tombstone-authorized final cleanup. A tombstoned job id is permanently
 * closed in both byte stores; retries are safe and report zero removals.
 */
export async function cleanupTombstonedExportJob(
  stores: ExportOwnedByteStoresV1,
  tombstone: ExportJobTombstoneV1,
): Promise<ExportOwnedByteCleanupSummaryV1> {
  assertIdentity(tombstone.jobId);
  if (tombstone.ref.trim().length === 0 || !tombstone.ownedRefs.includes(`spool:${tombstone.jobId}`)) {
    throw new Error("Cleanup requires a tombstone carrying the job spool ownership ref.");
  }
  const [spool, artifacts] = await Promise.all([
    stores.spool.cleanupJob(tombstone.jobId),
    stores.artifacts.cleanupJob(tombstone.jobId),
  ]);
  return summary(spool, artifacts);
}

/** Restartable tombstone-first retention coordinator. */
export async function reconcileTombstonedExportJobCleanup(
  jobStore: ExportJobStore,
  stores: ExportOwnedByteStoresV1,
  jobId: string,
  completedAt: number,
): Promise<{
  tombstone: ExportJobTombstoneV1;
  cleanup: ExportOwnedByteCleanupSummaryV1;
}> {
  assertIdentity(jobId);
  if (!Number.isFinite(completedAt)) throw new Error("Cleanup completion time must be finite.");
  const tombstone = await jobStore.getTombstone(jobId);
  if (!tombstone) throw new Error("Deletion tombstone was not found.");
  const cleanup = await cleanupTombstonedExportJob(stores, tombstone);
  const completed = await jobStore.markTombstoneCleanupComplete(
    jobId,
    tombstone.ref,
    completedAt,
  );
  return { tombstone: completed, cleanup };
}
