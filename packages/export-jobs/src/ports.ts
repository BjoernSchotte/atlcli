import type {
  ExportJobExecutionResultV1,
  PendingArtifactV1,
  StagedArtifactV1,
} from "./artifact.js";
import type { ExportJobEventV1 } from "./event.js";
import type { ExportJobRequestV1 } from "./request.js";
import type { ExportFormat } from "./source.js";
import type { ExportJobProgressV1, ExportJobSnapshotV1 } from "./snapshot.js";
import type {
  ExportJobClaimV1,
  ExportJobCreateV1,
  ExportJobDeleteQueryV1,
  ExportJobDeleteResultV1,
  ExportJobEventAppendV1,
  ExportJobFinalizeV1,
  ExportJobQueryV1,
  ExportJobUpdateV1,
} from "./store-contracts.js";
import type { SpoolObjectV1, SpoolRefV1, SpoolWriteLimitsV1 } from "./spool.js";

/** Host-owned durable metadata and event store. */
export interface ExportJobStore {
  create(input: ExportJobCreateV1): Promise<ExportJobSnapshotV1>;
  get(id: string): Promise<ExportJobSnapshotV1 | undefined>;
  getRequest(requestRef: string): Promise<ExportJobRequestV1 | undefined>;
  list(query?: ExportJobQueryV1): Promise<ExportJobSnapshotV1[]>;
  compareAndSet(update: ExportJobUpdateV1): Promise<ExportJobSnapshotV1>;
  claimNext(claim: ExportJobClaimV1): Promise<ExportJobSnapshotV1 | undefined>;
  appendEvent(id: string, input: ExportJobEventAppendV1): Promise<void>;
  finalizeArtifact(finalize: ExportJobFinalizeV1): Promise<ExportJobSnapshotV1>;
  acknowledge(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1>;
  dismiss(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1>;
  /**
   * Record successful delivery without deleting history. `deliveredAt` and, if
   * still unread, `acknowledgedAt` are set once; later delivery calls cannot
   * rewrite either timestamp or the terminal execution result.
   */
  deliver(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1>;
  /** Succeeded jobs without `deliveredAt` or `dismissedAt` are never eligible. */
  deleteTerminal(query: ExportJobDeleteQueryV1): Promise<ExportJobDeleteResultV1>;
}

/** Host-owned chunked byte storage for source and checkpoint payloads. */
export interface ExportSpoolStore {
  put(
    ref: SpoolRefV1,
    source: AsyncIterable<Uint8Array>,
    limits: SpoolWriteLimitsV1,
  ): Promise<SpoolObjectV1>;
  read(ref: SpoolRefV1, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  stat(ref: SpoolRefV1): Promise<SpoolObjectV1 | undefined>;
  /** Delete only one executor epoch; stale cleanup cannot erase newer work. */
  deleteNamespace(jobId: string, leaseEpoch: number): Promise<void>;
}

/** Executor-visible spool surface with job identity and epoch bound by the host. */
export interface ExportJobSpool {
  put(
    ref: Omit<SpoolRefV1, "jobId" | "leaseEpoch">,
    source: AsyncIterable<Uint8Array>,
    limits: SpoolWriteLimitsV1,
  ): Promise<SpoolObjectV1>;
  read(
    ref: Omit<SpoolRefV1, "jobId" | "leaseEpoch">,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
  stat(ref: Omit<SpoolRefV1, "jobId" | "leaseEpoch">): Promise<SpoolObjectV1 | undefined>;
}

/** Host-owned staged and finalized artifact byte storage. */
export interface ExportArtifactStore {
  stage(
    jobId: string,
    leaseEpoch: number,
    artifact: PendingArtifactV1,
  ): Promise<StagedArtifactV1>;
  getStaged(jobId: string, leaseEpoch: number): Promise<StagedArtifactV1 | undefined>;
  read(ref: string): AsyncIterable<Uint8Array>;
  deleteStaged(ref: string): Promise<void>;
}

/** Executor-visible artifact surface with job identity and epoch bound by the host. */
export interface ExportJobArtifacts {
  stage(artifact: PendingArtifactV1): Promise<StagedArtifactV1>;
  getStaged(): Promise<StagedArtifactV1 | undefined>;
}

/** Host-neutral services made available to one claimed executor. */
export interface ExportJobExecutionContext {
  jobId: string;
  leaseEpoch: number;
  signal: AbortSignal;
  spool: ExportJobSpool;
  artifacts: ExportJobArtifacts;
  updateProgress(progress: ExportJobProgressV1): Promise<void>;
  appendEvent(event: ExportJobEventV1): Promise<void>;
  checkpoint(ref: string): Promise<void>;
}

/** Separate DOCX/PDF executors implement this structural interface. */
export interface ExportJobExecutor<Request> {
  readonly format: ExportFormat;
  execute(
    request: Request,
    context: ExportJobExecutionContext,
  ): Promise<ExportJobExecutionResultV1>;
}
