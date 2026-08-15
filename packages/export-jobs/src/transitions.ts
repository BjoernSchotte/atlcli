import type { ExportJobErrorV1 } from "./error.js";
import type { ExportJobFinalizeV1 } from "./store-contracts.js";
import type { ExportJobStatsV1 } from "./statistics.js";
import type {
  ExportJobProgressV1,
  ExportJobSnapshotV1,
  ExportJobState,
} from "./snapshot.js";
import {
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  FULL_REPORT_RETENTION_MS_V1,
} from "./lifecycle-retention.js";

export type ExportJobTransitionConflictCode =
  | "revision-conflict"
  | "invalid-transition"
  | "terminal-immutable"
  | "lease-required"
  | "lease-mismatch"
  | "lease-expired"
  | "lease-not-expired"
  | "invalid-lease"
  | "invalid-progress"
  | "invalid-stats"
  | "progress-regression"
  | "invalid-metadata";

/** A closed, host-neutral conflict returned by pure lifecycle decisions. */
export class ExportJobTransitionConflict extends Error {
  readonly code: ExportJobTransitionConflictCode;

  constructor(code: ExportJobTransitionConflictCode, message: string) {
    super(message);
    this.name = "ExportJobTransitionConflict";
    this.code = code;
  }
}

export interface ExportJobStateTransitionV1 {
  expectedRevision: number;
  to: ExportJobState;
  at: number;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
  /** Required for executor-owned transitions from a leased state. */
  leaseEpoch?: number;
  waiting?: ExportJobSnapshotV1["waiting"];
  checkpointRef?: string;
  error?: ExportJobErrorV1;
}

export interface ExportJobClaimInputV1 {
  expectedRevision: number;
  ownerId: string;
  now: number;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
  leaseDurationMs: number;
}

export interface ExportJobHeartbeatInputV1 {
  expectedRevision: number;
  ownerId: string;
  leaseEpoch: number;
  now: number;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
  leaseDurationMs: number;
}

export interface ExportJobProgressInputV1 {
  expectedRevision: number;
  leaseEpoch: number;
  progress: ExportJobProgressV1;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
}

export interface ExportJobCheckpointInputV1 {
  expectedRevision: number;
  leaseEpoch: number;
  at: number;
  checkpointRef: string;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
}

export interface ExportJobStatsInputV1 {
  expectedRevision: number;
  leaseEpoch: number;
  at: number;
  stats: ExportJobStatsV1;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
}

export interface ExportJobLeaseReclaimInputV1 {
  expectedRevision: number;
  now: number;
  /** Adapter-owned transaction time; callers outside a store may omit it. */
  observedAt?: number;
}

export interface ExportJobTerminalMetadataInputV1 {
  expectedRevision: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  dismissedAt?: number;
}

export interface ExportJobRetentionInputV1 {
  expectedRevision: number;
  at: number;
  releaseArtifact: boolean;
  releaseReport: boolean;
}

const TERMINAL_STATES: ReadonlySet<ExportJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const DIRECT_TRANSITIONS: Readonly<Record<ExportJobState, ReadonlySet<ExportJobState>>> = {
  queued: new Set(["cancelled", "interrupted"]),
  running: new Set(["waiting", "cancelling", "failed", "interrupted"]),
  waiting: new Set(["cancelled"]),
  cancelling: new Set(["cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

function conflict(code: ExportJobTransitionConflictCode, message: string): never {
  throw new ExportJobTransitionConflict(code, message);
}

function assertRevision(snapshot: ExportJobSnapshotV1, expectedRevision: number): void {
  if (snapshot.revision !== expectedRevision) {
    conflict(
      "revision-conflict",
      `Expected job revision ${expectedRevision}, found ${snapshot.revision}.`,
    );
  }
}

function assertPositiveDuration(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    conflict("invalid-lease", "Lease duration must be a positive finite number.");
  }
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    conflict("invalid-metadata", `${label} must be a non-negative finite timestamp.`);
  }
}

function leaseExpiry(now: number, duration: number): number {
  assertFiniteTime(now, "Lease time");
  assertPositiveDuration(duration);
  const expiresAt = now + duration;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    conflict("invalid-lease", "Lease expiry must be finite and later than its start.");
  }
  return expiresAt;
}

function assertLeaseEpoch(
  snapshot: ExportJobSnapshotV1,
  leaseEpoch: number | undefined,
  at: number,
  observedAt = at,
): void {
  assertFiniteTime(at, "Lease write time");
  assertFiniteTime(observedAt, "Lease observation time");
  if (!snapshot.lease) {
    conflict("lease-required", "The job has no active lease.");
  }
  if (snapshot.lease.epoch !== snapshot.leaseEpoch) {
    conflict("invalid-lease", "The active lease and persistent fencing epoch disagree.");
  }
  if (leaseEpoch === undefined || leaseEpoch !== snapshot.lease.epoch) {
    conflict("lease-mismatch", "The write does not own the active lease epoch.");
  }
  if (at < snapshot.lease.acquiredAt || at < snapshot.lease.heartbeatAt) {
    conflict("invalid-lease", "A leased write cannot predate its claim or latest heartbeat.");
  }
  if (observedAt >= snapshot.lease.expiresAt) {
    conflict("lease-expired", "An expired lease cannot write job state.");
  }
}

function assertTerminal(snapshot: ExportJobSnapshotV1): void {
  if (!TERMINAL_STATES.has(snapshot.state)) {
    conflict("invalid-metadata", "Terminal metadata can only be written to a terminal job.");
  }
}

function nextRevision(snapshot: ExportJobSnapshotV1): number {
  return snapshot.revision + 1;
}

/** True for terminal states whose execution result is immutable. */
export function isExportJobTerminal(state: ExportJobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Apply a direct state transition.
 *
 * Claims (`queued|waiting -> running`) and lease recovery (`running -> queued`)
 * use their dedicated functions so a caller cannot bypass lease construction or
 * expiry checks with a bare state write.
 */
export function transitionExportJob(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobStateTransitionV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  assertFiniteTime(input.at, "Transition time");
  if (isExportJobTerminal(snapshot.state)) {
    conflict("terminal-immutable", `Terminal job ${snapshot.id} cannot change state.`);
  }
  if (!DIRECT_TRANSITIONS[snapshot.state].has(input.to)) {
    conflict("invalid-transition", `Cannot transition ${snapshot.state} to ${input.to}.`);
  }

  const executorOwned =
    (snapshot.state === "running" && input.to !== "cancelling") ||
    snapshot.state === "cancelling";
  if (executorOwned) assertLeaseEpoch(snapshot, input.leaseEpoch, input.at, input.observedAt);
  else if (input.leaseEpoch !== undefined && snapshot.lease) {
    assertLeaseEpoch(snapshot, input.leaseEpoch, input.at, input.observedAt);
  }

  if ((input.to === "failed" || input.to === "interrupted") && !input.error) {
    conflict("invalid-transition", `${input.to} requires a structured error.`);
  }

  if (input.to === "waiting") {
    if (!input.waiting) {
      conflict("invalid-transition", "A waiting transition requires a named waiting reason.");
    }
    if (!input.checkpointRef || input.checkpointRef.trim().length === 0) {
      conflict("invalid-transition", "A waiting transition requires an atomic checkpoint ref.");
    }
    return {
      ...snapshot,
      revision: nextRevision(snapshot),
      state: "waiting",
      waiting: input.waiting,
      checkpointRef: input.checkpointRef,
      error: input.error,
      lease: undefined,
    };
  }

  if (input.to === "cancelling") {
    return {
      ...snapshot,
      revision: nextRevision(snapshot),
      state: "cancelling",
      cancelRequestedAt: snapshot.cancelRequestedAt ?? input.at,
    };
  }

  const terminal: ExportJobSnapshotV1 = {
    ...snapshot,
    revision: nextRevision(snapshot),
    state: input.to,
    finishedAt: input.at,
    lease: undefined,
    waiting: undefined,
    ...(input.to === "cancelled"
      ? { cancelRequestedAt: snapshot.cancelRequestedAt ?? input.at }
      : {}),
  };
  if (input.error !== undefined) terminal.error = input.error;
  return terminal;
}

/** Atomically claim queued or unleased waiting work and allocate a new epoch. */
export function claimExportJob(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobClaimInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  const observedAt = input.observedAt ?? input.now;
  const expiresAt = leaseExpiry(observedAt, input.leaseDurationMs);
  if (snapshot.state !== "queued" && snapshot.state !== "waiting") {
    if (isExportJobTerminal(snapshot.state)) {
      conflict("terminal-immutable", `Terminal job ${snapshot.id} cannot be claimed.`);
    }
    conflict("invalid-transition", `Cannot claim a ${snapshot.state} job.`);
  }
  if (snapshot.lease) {
    conflict("invalid-lease", "Queued and waiting jobs must not retain a lease.");
  }
  if (input.ownerId.length === 0) {
    conflict("invalid-lease", "Lease owner must not be empty.");
  }

  // `leaseEpoch` persists while a waiting/recovered job is unleased, providing
  // the durable fencing boundary for the next claim. `attempt` is observability
  // metadata and advances independently.
  const epoch = snapshot.leaseEpoch + 1;
  const attempt = snapshot.attempt + 1;
  if (
    !Number.isSafeInteger(snapshot.leaseEpoch) ||
    snapshot.leaseEpoch < 0 ||
    !Number.isSafeInteger(snapshot.attempt) ||
    snapshot.attempt < 0 ||
    !Number.isSafeInteger(epoch) ||
    !Number.isSafeInteger(attempt)
  ) {
    conflict("invalid-lease", "Lease epoch cannot be incremented safely.");
  }
  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    state: "running",
    waiting: undefined,
    error: undefined,
    attempt,
    leaseEpoch: epoch,
    stage: undefined,
    progress: undefined,
    startedAt: snapshot.startedAt ?? observedAt,
    lease: {
      ownerId: input.ownerId,
      epoch,
      acquiredAt: observedAt,
      heartbeatAt: observedAt,
      expiresAt,
    },
  };
}

/** Renew a live lease. Heartbeats at or after expiry fail closed. */
export function heartbeatExportJob(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobHeartbeatInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  assertFiniteTime(input.now, "Heartbeat time");
  const observedAt = input.observedAt ?? input.now;
  const expiresAt = leaseExpiry(observedAt, input.leaseDurationMs);
  if (snapshot.state !== "running" && snapshot.state !== "cancelling") {
    conflict("invalid-transition", `Cannot heartbeat a ${snapshot.state} job.`);
  }
  assertLeaseEpoch(snapshot, input.leaseEpoch, input.now, observedAt);
  if (snapshot.lease!.ownerId !== input.ownerId) {
    conflict("lease-mismatch", "The heartbeat does not own the active lease.");
  }
  if (observedAt < snapshot.lease!.heartbeatAt || expiresAt <= snapshot.lease!.expiresAt) {
    conflict("invalid-lease", "A heartbeat must strictly extend the active lease.");
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    lease: {
      ...snapshot.lease!,
      heartbeatAt: observedAt,
      expiresAt,
    },
  };
}

/** Persist a fenced progress snapshot, enforcing monotonicity within a stage. */
export function updateExportJobProgress(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobProgressInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  if (snapshot.state !== "running") {
    conflict("invalid-transition", `Cannot update progress for a ${snapshot.state} job.`);
  }
  assertLeaseEpoch(
    snapshot,
    input.leaseEpoch,
    input.progress.updatedAt,
    input.observedAt,
  );
  const { progress } = input;
  if (
    !Number.isInteger(progress.done) ||
    progress.done < 0 ||
    (progress.total !== null &&
      (!Number.isInteger(progress.total) || progress.total < progress.done || progress.total < 0))
  ) {
    conflict("invalid-progress", "Progress counters must be non-negative integers with done <= total.");
  }
  if (progress.updatedAt < snapshot.lease!.acquiredAt) {
    conflict("invalid-progress", "Progress cannot predate the active lease.");
  }
  if (snapshot.progress && progress.updatedAt < snapshot.progress.updatedAt) {
    conflict("progress-regression", "Progress time cannot move backwards within one attempt.");
  }
  const stageOrder = [
    "discover",
    "fetch",
    "compose",
    "resolve",
    "assets",
    "render",
    "validate",
    "commit",
  ] as const;
  if (
    snapshot.progress &&
    stageOrder.indexOf(progress.stage) < stageOrder.indexOf(snapshot.progress.stage)
  ) {
    conflict("progress-regression", "Progress stage cannot move backwards within one attempt.");
  }
  if (
    snapshot.progress?.stage === progress.stage &&
    progress.done < snapshot.progress.done
  ) {
    conflict("progress-regression", "Progress cannot decrease within one stage.");
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    stage: progress.stage,
    progress,
  };
}

/** Attach the latest resumable checkpoint under the active, unexpired lease. */
export function checkpointExportJob(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobCheckpointInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  if (snapshot.state !== "running") {
    conflict("invalid-transition", `Cannot checkpoint a ${snapshot.state} job.`);
  }
  assertLeaseEpoch(snapshot, input.leaseEpoch, input.at, input.observedAt);
  if (input.checkpointRef.trim().length === 0) {
    conflict("invalid-metadata", "Checkpoint reference must not be empty.");
  }
  if (snapshot.progress && input.at < snapshot.progress.updatedAt) {
    conflict("invalid-metadata", "Checkpoint cannot predate the latest progress snapshot.");
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    checkpointRef: input.checkpointRef,
  };
}

function assertMonotonicStats(previous: unknown, next: unknown, path = "stats"): void {
  if (typeof previous === "number") {
    if (typeof next !== "number" || !Number.isFinite(next) || next < previous) {
      conflict("invalid-stats", `${path} must be finite and monotonic.`);
    }
    return;
  }
  if (previous === null) {
    if (next !== null && (typeof next !== "number" || !Number.isFinite(next) || next < 0)) {
      conflict("invalid-stats", `${path} must remain unavailable or become non-negative.`);
    }
    return;
  }
  if (typeof previous === "string") {
    if (typeof next !== "string" || (previous !== "unavailable" && next === "unavailable")) {
      conflict("invalid-stats", `${path} metric support cannot regress.`);
    }
    return;
  }
  if (
    typeof previous === "object" &&
    previous !== null &&
    typeof next === "object" &&
    next !== null
  ) {
    for (const [key, prior] of Object.entries(previous as Record<string, unknown>)) {
      const candidate = (next as Record<string, unknown>)[key];
      if (candidate === undefined) {
        conflict("invalid-stats", `${path}.${key} cannot be removed.`);
      }
      assertMonotonicStats(prior, candidate, `${path}.${key}`);
    }
    for (const [key, candidate] of Object.entries(next as Record<string, unknown>)) {
      if ((previous as Record<string, unknown>)[key] !== undefined) continue;
      if (typeof candidate === "number" && (!Number.isFinite(candidate) || candidate < 0)) {
        conflict("invalid-stats", `${path}.${key} must be a non-negative finite number.`);
      }
    }
    return;
  }
  conflict("invalid-stats", `${path} has an incompatible value.`);
}

/** Replace bounded counters and measurements under the active lease. */
export function updateExportJobStats(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobStatsInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  if (snapshot.state !== "running") {
    conflict("invalid-transition", `Cannot update statistics for a ${snapshot.state} job.`);
  }
  assertLeaseEpoch(snapshot, input.leaseEpoch, input.at, input.observedAt);
  assertMonotonicStats(snapshot.stats, input.stats);
  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    stats: input.stats,
  };
}

/**
 * Reconcile an expired running lease.
 *
 * A safe checkpoint returns to the queue; otherwise executor loss is terminal
 * and explicitly retryable. The next claim allocates a strictly higher epoch
 * from the persisted lease-epoch counter.
 */
export function reclaimExpiredExportJobLease(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobLeaseReclaimInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  const observedAt = input.observedAt ?? input.now;
  assertFiniteTime(observedAt, "Lease reclaim time");
  if (snapshot.state !== "running" && snapshot.state !== "cancelling") {
    conflict("invalid-transition", `Cannot reclaim a lease from a ${snapshot.state} job.`);
  }
  if (!snapshot.lease) conflict("lease-required", "The running job has no active lease.");
  if (snapshot.lease.epoch !== snapshot.leaseEpoch) {
    conflict("invalid-lease", "The active lease and persistent fencing epoch disagree.");
  }
  if (observedAt < snapshot.lease.expiresAt) {
    conflict("lease-not-expired", "The active lease has not expired.");
  }

  if (snapshot.state === "cancelling") {
    return {
      ...snapshot,
      revision: nextRevision(snapshot),
      state: "cancelled",
      lease: undefined,
      waiting: undefined,
      recoveryCount: snapshot.recoveryCount + 1,
      finishedAt: input.now,
      cancelRequestedAt: snapshot.cancelRequestedAt ?? input.now,
    };
  }

  if (snapshot.checkpointRef) {
    return {
      ...snapshot,
      revision: nextRevision(snapshot),
      state: "queued",
      lease: undefined,
      waiting: undefined,
      recoveryCount: snapshot.recoveryCount + 1,
    };
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    state: "interrupted",
    lease: undefined,
    waiting: undefined,
    recoveryCount: snapshot.recoveryCount + 1,
    finishedAt: input.now,
    error: {
      code: "executor.lease_expired",
      message: "The export runner stopped before reaching a recoverable checkpoint.",
      category: "worker",
      retryable: true,
      ...(snapshot.stage === undefined ? {} : { stage: snapshot.stage }),
      occurredAt: input.now,
    },
  };
}

/** Set-once presentation metadata without mutating terminal execution history. */
export function updateExportJobTerminalMetadata(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobTerminalMetadataInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  assertTerminal(snapshot);
  const entries = [
    ["deliveredAt", input.deliveredAt],
    ["acknowledgedAt", input.acknowledgedAt],
    ["dismissedAt", input.dismissedAt],
  ] as const;
  if (entries.every(([, value]) => value === undefined)) {
    conflict("invalid-metadata", "At least one terminal metadata field is required.");
  }
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const current = snapshot[key];
    if (current !== undefined && current !== value) {
      conflict("invalid-metadata", `${key} is immutable once set.`);
    }
    if (!Number.isFinite(value)) {
      conflict("invalid-metadata", `${key} must be a finite timestamp.`);
    }
    if (snapshot.finishedAt === undefined || value < snapshot.finishedAt) {
      conflict("invalid-metadata", `${key} cannot predate terminal completion.`);
    }
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
    ...(input.acknowledgedAt === undefined ? {} : { acknowledgedAt: input.acknowledgedAt }),
    ...(input.dismissedAt === undefined ? {} : { dismissedAt: input.dismissedAt }),
  };
}

/**
 * Clear retained payload refs only after their independent policy horizons.
 *
 * Adapters execute the corresponding physical cleanup in the same durable
 * operation where possible. The release timestamps keep the compact history
 * valid and make repeated cleanup reconciliation explicit.
 */
export function releaseExportJobRetention(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobRetentionInputV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  assertTerminal(snapshot);
  assertFiniteTime(input.at, "Retention time");
  if (!input.releaseArtifact && !input.releaseReport) {
    conflict("invalid-metadata", "Retention must release at least one payload class.");
  }
  if (snapshot.finishedAt === undefined) {
    conflict("invalid-metadata", "Terminal retention requires finishedAt.");
  }

  if (input.releaseArtifact) {
    if (
      snapshot.state !== "succeeded" ||
      snapshot.artifact === undefined ||
      snapshot.artifactReleasedAt !== undefined
    ) {
      conflict("invalid-metadata", "Only an unreleased successful artifact can be released.");
    }
    if (snapshot.deliveredAt === undefined && snapshot.dismissedAt === undefined) {
      conflict("invalid-metadata", "Succeeded-undelivered artifacts are retention-protected.");
    }
    const lastUseAt = Math.max(
      snapshot.finishedAt,
      snapshot.deliveredAt ?? Number.NEGATIVE_INFINITY,
      snapshot.dismissedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (input.at < lastUseAt || input.at - lastUseAt < DELIVERED_ARTIFACT_RETENTION_MS_V1) {
      conflict("invalid-metadata", "The delivered artifact retention horizon has not elapsed.");
    }
  }

  if (input.releaseReport) {
    if (snapshot.reportReleasedAt !== undefined) {
      conflict("invalid-metadata", "The full report and event protocol were already released.");
    }
    if (
      input.at < snapshot.finishedAt ||
      input.at - snapshot.finishedAt < FULL_REPORT_RETENTION_MS_V1
    ) {
      conflict("invalid-metadata", "The full report retention horizon has not elapsed.");
    }
    if (snapshot.reportRef !== undefined && snapshot.reportSummary === undefined) {
      conflict("invalid-metadata", "A retained report needs a compact summary before release.");
    }
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    ...(input.releaseArtifact
      ? { artifact: undefined, artifactReleasedAt: input.at }
      : {}),
    ...(input.releaseReport
      ? { reportRef: undefined, reportReleasedAt: input.at }
      : {}),
  };
}

/** Fenced two-step commit: staged bytes become visible only through this reducer. */
export function finalizeExportJobArtifact(
  snapshot: ExportJobSnapshotV1,
  input: ExportJobFinalizeV1,
): ExportJobSnapshotV1 {
  assertRevision(snapshot, input.expectedRevision);
  if (snapshot.state !== "running") {
    if (isExportJobTerminal(snapshot.state)) {
      conflict("terminal-immutable", `Terminal job ${snapshot.id} cannot be finalized.`);
    }
    conflict("invalid-transition", `Cannot finalize a ${snapshot.state} job.`);
  }
  if (input.id !== snapshot.id || input.stagedArtifact.jobId !== snapshot.id) {
    conflict("invalid-metadata", "The staged artifact belongs to a different job.");
  }
  assertLeaseEpoch(snapshot, input.leaseEpoch, input.finishedAt, input.observedAt);
  if (
    input.stagedArtifact.leaseEpoch !== input.leaseEpoch ||
    input.stagedArtifact.leaseEpoch !== snapshot.leaseEpoch
  ) {
    conflict("lease-mismatch", "The staged artifact belongs to a stale lease epoch.");
  }
  assertFiniteTime(input.stagedArtifact.stagedAt, "Artifact staging time");
  if (input.stagedArtifact.stagedAt > input.finishedAt) {
    conflict("invalid-metadata", "Artifact staging cannot occur after finalization.");
  }
  if (
    !Number.isSafeInteger(input.stagedArtifact.byteLength) ||
    input.stagedArtifact.byteLength < 0
  ) {
    conflict("invalid-metadata", "Artifact byte length must be a non-negative safe integer.");
  }

  return {
    ...snapshot,
    revision: nextRevision(snapshot),
    state: "succeeded",
    stage: "commit",
    lease: undefined,
    waiting: undefined,
    finishedAt: input.finishedAt,
    error: undefined,
    artifact: {
      ref: input.stagedArtifact.ref,
      mediaType: input.stagedArtifact.mediaType,
      filename: input.stagedArtifact.filename,
      byteLength: input.stagedArtifact.byteLength,
      sha256: input.stagedArtifact.sha256,
      committedAt: input.finishedAt,
    },
    ...(input.reportRef === undefined ? {} : { reportRef: input.reportRef }),
    ...(input.reportSummary === undefined ? {} : { reportSummary: input.reportSummary }),
  };
}
