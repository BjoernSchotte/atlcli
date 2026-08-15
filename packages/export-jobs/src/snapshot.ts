import type { ExportArtifactV1 } from "./artifact.js";
import type { ExportJobErrorV1 } from "./error.js";
import type { ExportFormat } from "./source.js";
import type { ExportJobStatsV1, ExportReportSummaryV1 } from "./statistics.js";

/** Durable lifecycle states in contract version 1. */
export type ExportJobState =
  | "queued"
  | "running"
  | "waiting"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Cross-engine pipeline stages in contract version 1. */
export type ExportJobStage =
  | "discover"
  | "fetch"
  | "compose"
  | "resolve"
  | "assets"
  | "render"
  | "validate"
  | "commit";

/** Latest bounded progress projection. */
export interface ExportJobProgressV1 {
  stage: ExportJobStage;
  done: number;
  total: number | null;
  detail?: string;
  updatedAt: number;
}

/** Fenced execution ownership recorded with a claimed job. */
export interface ExportJobLeaseV1 {
  ownerId: string;
  epoch: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/** Immutable direct predecessor relation for Retry and Run again. */
export interface ExportJobDerivationV1 {
  jobId: string;
  relation: "retry" | "rerun";
  /** Stable per user action so acknowledgement retries resolve to the same derived job. */
  actionKey: string;
}

/** Durable, bounded activity snapshot for one export. */
export interface ExportJobSnapshotV1 {
  schema: "atlcli.export-job/1";
  id: string;
  revision: number;
  requestRef: string;
  format: ExportFormat;
  renderer: "docx-typescript" | "pdf-typst";
  summary: {
    displayName: string;
    sourceLabel: string;
    siteOrigin: string;
    profileLabel?: string;
    scopeKind: string;
  };
  queue: { priority: "interactive" | "retry"; enqueuedAt: number; groupKey: string };
  state: ExportJobState;
  stage?: ExportJobStage;
  progress?: ExportJobProgressV1;
  waiting?: { reason: "queue" | "backoff" | "auth" | "quota" | "host"; until?: number };
  attempt: number;
  recoveryCount: number;
  /** Last allocated fencing epoch, retained even while no lease is active. */
  leaseEpoch: number;
  /**
   * Present only while work is actively leased. A `running` to `waiting`
   * transition atomically clears this field; `waiting` snapshots never retain
   * a lease.
   */
  lease?: ExportJobLeaseV1;
  cancelRequestedAt?: number;
  checkpointRef?: string;
  artifact?: ExportArtifactV1;
  /** Set once the delivered/dismissed artifact bytes were released by retention. */
  artifactReleasedAt?: number;
  reportRef?: string;
  /** Set once the full report and bounded event protocol were released. */
  reportReleasedAt?: number;
  reportSummary?: ExportReportSummaryV1;
  stats: ExportJobStatsV1;
  error?: ExportJobErrorV1;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  dismissedAt?: number;
  derivedFrom?: ExportJobDerivationV1;
}
