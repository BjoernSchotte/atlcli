import type { StagedArtifactV1 } from "./artifact.js";
import type { ExportJobErrorV1 } from "./error.js";
import type { ExportJobEventV1 } from "./event.js";
import type { ExportJobRequestV1 } from "./request.js";
import type { ExportReportSummaryV1 } from "./statistics.js";
import type { ExportJobStatsV1 } from "./statistics.js";
import type { ExportFormat } from "./source.js";
import type {
  ExportJobSnapshotV1,
  ExportJobDerivationV1,
  ExportJobProgressV1,
  ExportJobStage,
  ExportJobState,
} from "./snapshot.js";

/** Atomic job creation input, including optional Retry/Run-again ancestry. */
export interface ExportJobCreateV1 {
  request: ExportJobRequestV1;
  derivedFrom?: ExportJobDerivationV1;
}

/** Filters for bounded activity/history reads. */
export interface ExportJobQueryV1 {
  formats?: ExportFormat[];
  states?: ExportJobState[];
  stages?: ExportJobStage[];
  includeDismissed?: boolean;
  createdBefore?: number;
  limit?: number;
}

interface ExportJobCasBaseV1 {
  id: string;
  expectedRevision: number;
}

/** A validated lifecycle edge; claim, reclaim, and success use dedicated operations. */
export interface ExportJobTransitionUpdateV1 extends ExportJobCasBaseV1 {
  kind: "transition";
  to: Extract<ExportJobState, "waiting" | "cancelling" | "failed" | "interrupted" | "cancelled">;
  at: number;
  leaseEpoch?: number;
  waiting?: ExportJobSnapshotV1["waiting"];
  checkpointRef?: string;
  error?: ExportJobErrorV1;
}

/** Fenced renewal of the active executor lease. */
export interface ExportJobHeartbeatUpdateV1 extends ExportJobCasBaseV1 {
  kind: "heartbeat";
  ownerId: string;
  leaseEpoch: number;
  now: number;
  leaseDurationMs: number;
}

/** Fenced replacement of the bounded progress projection. */
export interface ExportJobProgressUpdateV1 extends ExportJobCasBaseV1 {
  kind: "progress";
  leaseEpoch: number;
  progress: ExportJobProgressV1;
}

/** Host reconciliation of an expired running/cancelling lease. */
export interface ExportJobReclaimExpiredUpdateV1 extends ExportJobCasBaseV1 {
  kind: "reclaim-expired";
  now: number;
}

/** Fenced attachment of the latest resumable checkpoint reference. */
export interface ExportJobCheckpointUpdateV1 extends ExportJobCasBaseV1 {
  kind: "checkpoint";
  leaseEpoch: number;
  at: number;
  checkpointRef: string;
}

/** Fenced replacement of monotonic counters and bounded measurements. */
export interface ExportJobStatsUpdateV1 extends ExportJobCasBaseV1 {
  kind: "stats";
  leaseEpoch: number;
  at: number;
  stats: ExportJobStatsV1;
}

/**
 * Closed CAS command union. Adapters dispatch to the pure reducers and cannot
 * patch arbitrary snapshot fields.
 */
export type ExportJobUpdateV1 =
  | ExportJobTransitionUpdateV1
  | ExportJobHeartbeatUpdateV1
  | ExportJobProgressUpdateV1
  | ExportJobReclaimExpiredUpdateV1
  | ExportJobCheckpointUpdateV1
  | ExportJobStatsUpdateV1;

/** Revision- and lease-fenced append to the bounded event protocol. */
export interface ExportJobEventAppendV1 {
  expectedRevision: number;
  leaseEpoch?: number;
  event: ExportJobEventV1;
}

/** Atomic claim parameters supplied by a host runner. */
export interface ExportJobClaimV1 {
  ownerId: string;
  now: number;
  leaseDurationMs: number;
  formats?: ExportFormat[];
}

/** Atomic artifact/report finalization request. */
export interface ExportJobFinalizeV1 {
  id: string;
  expectedRevision: number;
  leaseEpoch: number;
  stagedArtifact: StagedArtifactV1;
  reportRef?: string;
  reportSummary?: ExportReportSummaryV1;
  finishedAt: number;
  /** Adapter-owned transaction time; ignored from untrusted executor payloads. */
  observedAt?: number;
}

/** Retention query restricted to already-terminal job records. */
export interface ExportJobDeleteQueryV1 {
  finishedBefore: number;
  states?: Array<Extract<ExportJobState, "succeeded" | "failed" | "cancelled" | "interrupted">>;
  limit?: number;
}

/** Result of writing deletion tombstones for terminal records. */
export interface ExportJobDeleteResultV1 {
  deletedJobIds: string[];
  tombstoneRefs: string[];
}
