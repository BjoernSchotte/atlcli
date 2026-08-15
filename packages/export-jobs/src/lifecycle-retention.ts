import type { ExportJobSnapshotV1 } from "./snapshot.js";

/** Minimum retention after the last delivery/dismissal before artifact bytes may be released. */
export const DELIVERED_ARTIFACT_RETENTION_MS_V1 = 24 * 60 * 60 * 1_000;
/** Full report and bounded operational events remain available for seven days. */
export const FULL_REPORT_RETENTION_MS_V1 = 7 * 24 * 60 * 60 * 1_000;
/** Compact activity rows and report summaries remain available for at most thirty days. */
export const COMPACT_HISTORY_RETENTION_MS_V1 = 30 * 24 * 60 * 60 * 1_000;
/** Compact activity history retains at most the newest one hundred terminal jobs. */
export const COMPACT_HISTORY_MAX_JOBS_V1 = 100;

const TERMINAL = new Set<ExportJobSnapshotV1["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface ExportJobRetentionReleaseV1 {
  id: string;
  expectedRevision: number;
  releaseArtifact: boolean;
  releaseReport: boolean;
}

export interface ExportJobLifecycleRetentionPlanV1 {
  releases: ExportJobRetentionReleaseV1[];
  deleteJobIds: string[];
}

function ageReached(now: number, timestamp: number, horizonMs: number): boolean {
  return timestamp <= now && now - timestamp >= horizonMs;
}

/**
 * Plan independent payload release and compact-history deletion.
 *
 * The supplied snapshots must represent the complete retained terminal history
 * for the host. The function sorts them itself, so host iteration order cannot
 * change which one hundred rows are protected.
 */
export function planExportJobLifecycleRetentionV1(
  snapshots: readonly ExportJobSnapshotV1[],
  now: number,
): ExportJobLifecycleRetentionPlanV1 {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Retention time must be a non-negative safe integer.");
  }

  const terminal = snapshots
    .filter((snapshot) => TERMINAL.has(snapshot.state))
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  const releases: ExportJobRetentionReleaseV1[] = [];
  const deleteJobIds: string[] = [];

  terminal.forEach((snapshot, index) => {
    const finishedAt = snapshot.finishedAt;
    if (finishedAt === undefined) return;

    const lastArtifactUseAt = Math.max(
      finishedAt,
      snapshot.deliveredAt ?? Number.NEGATIVE_INFINITY,
      snapshot.dismissedAt ?? Number.NEGATIVE_INFINITY,
    );
    const releaseArtifact =
      snapshot.state === "succeeded" &&
      snapshot.artifact !== undefined &&
      (snapshot.deliveredAt !== undefined || snapshot.dismissedAt !== undefined) &&
      ageReached(now, lastArtifactUseAt, DELIVERED_ARTIFACT_RETENTION_MS_V1);
    const releaseReport =
      snapshot.reportReleasedAt === undefined &&
      ageReached(now, finishedAt, FULL_REPORT_RETENTION_MS_V1);

    if (releaseArtifact || releaseReport) {
      releases.push({
        id: snapshot.id,
        expectedRevision: snapshot.revision,
        releaseArtifact,
        releaseReport,
      });
    }

    const outsideCountWindow = index >= COMPACT_HISTORY_MAX_JOBS_V1;
    const outsideTimeWindow = ageReached(now, snapshot.createdAt, COMPACT_HISTORY_RETENTION_MS_V1);
    const historyExpired = outsideCountWindow || outsideTimeWindow;
    const artifactWillBeReleased =
      snapshot.state !== "succeeded" ||
      snapshot.artifactReleasedAt !== undefined ||
      releaseArtifact;
    const reportWillBeReleased = snapshot.reportReleasedAt !== undefined || releaseReport;
    const terminalDeletionAllowed =
      snapshot.state !== "succeeded" ||
      snapshot.deliveredAt !== undefined ||
      snapshot.dismissedAt !== undefined;

    if (
      historyExpired &&
      artifactWillBeReleased &&
      reportWillBeReleased &&
      terminalDeletionAllowed
    ) {
      deleteJobIds.push(snapshot.id);
    }
  });

  return { releases, deleteJobIds };
}
