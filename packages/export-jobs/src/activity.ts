import type { ExportFormat } from "./source.js";
import type {
  ExportJobSnapshotV1,
  ExportJobState,
} from "./snapshot.js";
import { orderExportQueue } from "./policy.js";
import { isExportJobTerminal } from "./transitions.js";

export interface ExportActivityActionsV1 {
  cancel: boolean;
  retry: boolean;
  rerun: boolean;
  resume: boolean;
  download: boolean;
  acknowledge: boolean;
  dismiss: boolean;
  detail: boolean;
}

/**
 * Monitor-owned queue information. Generic browser hosts default to an
 * estimated position because host/resource availability may change after the
 * snapshot; a host may opt into `exact` only when it can fence that claim.
 */
export type ExportActivityQueueProjectionV1 =
  | { kind: "estimated" | "exact"; position: number }
  | {
      kind: "waiting";
      reason: NonNullable<ExportJobSnapshotV1["waiting"]>["reason"];
      until?: number;
    };

/** Browser-safe, format-neutral Activity row projected from one durable job. */
export interface ExportActivityRowV1 {
  key: `common:${string}`;
  source: "common";
  id: string;
  format: ExportFormat;
  state: ExportJobState;
  stage?: ExportJobSnapshotV1["stage"];
  displayName: string;
  sourceLabel: string;
  siteOrigin: string;
  profileLabel?: string;
  scopeKind: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  waiting?: ExportJobSnapshotV1["waiting"];
  progress?: ExportJobSnapshotV1["progress"];
  queue?: ExportJobSnapshotV1["queue"];
  queueProjection?: ExportActivityQueueProjectionV1;
  attempt: number;
  recoveryCount: number;
  stats: ExportJobSnapshotV1["stats"];
  reportSummary?: ExportJobSnapshotV1["reportSummary"];
  reportRef?: string;
  artifact?: ExportJobSnapshotV1["artifact"];
  derivedFrom?: ExportJobSnapshotV1["derivedFrom"];
  bytes: number;
  error?: ExportJobSnapshotV1["error"];
  unread: boolean;
  actions: ExportActivityActionsV1;
}

export interface ExportActivityProjectionOptionsV1 {
  /** Estimated unless the host can guarantee that its monitor view is fenced. */
  queuePositionKind?: "estimated" | "exact";
  /** Dismissed history stays hidden by default without being deleted. */
  includeDismissed?: boolean;
  siteOrigin?: string;
  formats?: readonly ExportFormat[];
  states?: readonly ExportJobState[];
  createdAfter?: number;
}

/**
 * Project a single snapshot. Queue positions need the full queue and are added
 * by `projectExportActivityV1`; waiting reasons are intrinsic to the snapshot.
 */
export function projectExportActivityRowV1(
  snapshot: ExportJobSnapshotV1,
): ExportActivityRowV1 {
  const terminal = isExportJobTerminal(snapshot.state);
  return {
    key: `common:${snapshot.id}`,
    source: "common",
    id: snapshot.id,
    format: snapshot.format,
    state: snapshot.state,
    ...(snapshot.stage ? { stage: snapshot.stage } : {}),
    displayName: snapshot.summary.displayName,
    sourceLabel: snapshot.summary.sourceLabel,
    siteOrigin: snapshot.summary.siteOrigin,
    ...(snapshot.summary.profileLabel
      ? { profileLabel: snapshot.summary.profileLabel }
      : {}),
    scopeKind: snapshot.summary.scopeKind,
    createdAt: snapshot.createdAt,
    ...(snapshot.startedAt === undefined
      ? {}
      : { startedAt: snapshot.startedAt }),
    ...(snapshot.finishedAt === undefined
      ? {}
      : { finishedAt: snapshot.finishedAt }),
    ...(snapshot.deliveredAt === undefined
      ? {}
      : { deliveredAt: snapshot.deliveredAt }),
    ...(snapshot.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: snapshot.acknowledgedAt }),
    ...(snapshot.waiting ? { waiting: snapshot.waiting } : {}),
    ...(snapshot.progress ? { progress: snapshot.progress } : {}),
    queue: snapshot.queue,
    ...(snapshot.state === "waiting" && snapshot.waiting
      ? {
          queueProjection: {
            kind: "waiting" as const,
            reason: snapshot.waiting.reason,
            ...(snapshot.waiting.until === undefined
              ? {}
              : { until: snapshot.waiting.until }),
          },
        }
      : {}),
    attempt: snapshot.attempt,
    recoveryCount: snapshot.recoveryCount,
    stats: snapshot.stats,
    ...(snapshot.reportSummary
      ? { reportSummary: snapshot.reportSummary }
      : {}),
    ...(snapshot.reportRef ? { reportRef: snapshot.reportRef } : {}),
    ...(snapshot.artifact ? { artifact: snapshot.artifact } : {}),
    ...(snapshot.derivedFrom ? { derivedFrom: snapshot.derivedFrom } : {}),
    bytes:
      snapshot.artifact?.byteLength ?? snapshot.stats.storage.outputBytes,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    unread: terminal && snapshot.acknowledgedAt === undefined,
    actions: {
      cancel: ["queued", "running", "waiting", "cancelling"].includes(
        snapshot.state,
      ),
      retry: ["failed", "interrupted", "cancelled"].includes(snapshot.state),
      rerun: snapshot.state === "succeeded",
      resume:
        snapshot.state === "waiting" &&
        snapshot.waiting?.reason === "auth",
      download:
        snapshot.state === "succeeded" && snapshot.artifact !== undefined,
      acknowledge: terminal && snapshot.acknowledgedAt === undefined,
      dismiss: terminal,
      detail: terminal,
    },
  };
}

function activityRank(row: Pick<ExportActivityRowV1, "state" | "unread">): number {
  if (row.state === "running" || row.state === "cancelling") return 0;
  if (row.state === "waiting") return 1;
  if (row.state === "queued") return 2;
  if (!row.unread) return 5;
  if (row.state === "succeeded" && row.unread) return 3;
  if (
    row.state === "failed" ||
    row.state === "interrupted" ||
    row.state === "cancelled"
  ) {
    return 4;
  }
  return 5;
}

/** Shared default Activity ordering, including monitor queue positions. */
export function compareExportActivityRowsV1(
  left: ExportActivityRowV1,
  right: ExportActivityRowV1,
): number {
  const rank = activityRank(left) - activityRank(right);
  if (rank !== 0) return rank;
  if (left.state === "queued" && right.state === "queued") {
    const leftPosition =
      left.queueProjection?.kind === "estimated" ||
      left.queueProjection?.kind === "exact"
        ? left.queueProjection.position
        : Number.MAX_SAFE_INTEGER;
    const rightPosition =
      right.queueProjection?.kind === "estimated" ||
      right.queueProjection?.kind === "exact"
        ? right.queueProjection.position
        : Number.MAX_SAFE_INTEGER;
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
  }
  return (
    right.createdAt - left.createdAt || right.key.localeCompare(left.key)
  );
}

function matchesProjectionOptions(
  snapshot: ExportJobSnapshotV1,
  options: ExportActivityProjectionOptionsV1,
): boolean {
  return (
    (options.includeDismissed === true ||
      snapshot.dismissedAt === undefined) &&
    (options.siteOrigin === undefined ||
      snapshot.summary.siteOrigin === options.siteOrigin) &&
    (options.formats === undefined ||
      options.formats.includes(snapshot.format)) &&
    (options.states === undefined || options.states.includes(snapshot.state)) &&
    (options.createdAfter === undefined ||
      snapshot.createdAt > options.createdAfter)
  );
}

/**
 * Project the complete monitor view from durable snapshots. Queue positions are
 * derived from the same pure admission order used by every host, never from the
 * incidental list/render order.
 */
export function projectExportActivityV1(
  snapshots: readonly ExportJobSnapshotV1[],
  options: ExportActivityProjectionOptionsV1 = {},
): ExportActivityRowV1[] {
  const queuePositions = new Map(
    orderExportQueue(
      snapshots.filter((snapshot) => snapshot.state === "queued"),
    ).map((snapshot, index) => [snapshot.id, index + 1]),
  );
  const visible = snapshots.filter((snapshot) =>
    matchesProjectionOptions(snapshot, options),
  );
  const positionKind = options.queuePositionKind ?? "estimated";

  return visible
    .map((snapshot) => {
      const row = projectExportActivityRowV1(snapshot);
      const position = queuePositions.get(snapshot.id);
      return position === undefined
        ? row
        : {
            ...row,
            queueProjection: { kind: positionKind, position },
          };
    })
    .sort(compareExportActivityRowsV1);
}
