import {
  bindExportJobArtifacts,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type ExportJobErrorV1,
  type ExportJobEventDraftV1,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobRequestV1,
  type ExportJobSnapshotV1,
  type ExportJobStore,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import { FileExportArtifactStore } from "./file-artifact-store.js";
import { FileExportJobStore } from "./file-job-store.js";
import { FileExportSpoolStore } from "./file-spool-store.js";

export interface FileExportExecutionRuntime {
  context: ExportJobExecutionContext;
  snapshot(): Promise<ExportJobSnapshotV1>;
  requestCancellation(at?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateFileExportExecutionContextOptionsV1 {
  claimed: ExportJobSnapshotV1;
  jobs: FileExportJobStore;
  spool: FileExportSpoolStore;
  artifacts: FileExportArtifactStore;
  spoolLimits: SpoolWriteLimitsV1;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  cancelPollMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

/** Build one revision-serialized, heartbeat-owning context for an already claimed job. */
export function createFileExportExecutionContext(options: CreateFileExportExecutionContextOptionsV1): FileExportExecutionRuntime {
  const now = options.now ?? Date.now; const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000; const cancelPollMs = options.cancelPollMs ?? 250;
  const abort = new AbortController(); let current = structuredClone(options.claimed); let stopped = false; let tail = Promise.resolve(); let backgroundError: unknown;
  if (current.state !== "running" || !current.lease || current.leaseEpoch !== current.lease.epoch) throw new Error("Execution context requires a claimed running job.");
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail; let release!: () => void; tail = new Promise<void>((resolve) => { release = resolve; }); await previous;
    try { if (backgroundError) throw backgroundError; return await operation(); } finally { release(); }
  };
  const refresh = async (): Promise<ExportJobSnapshotV1> => {
    const latest = await options.jobs.get(current.id); if (!latest) throw new Error("Claimed job disappeared."); current = latest;
    if (latest.state === "cancelling") abort.abort(new DOMException("Export job cancellation was requested.", "AbortError"));
    else if (latest.state !== "running" || latest.leaseEpoch !== options.claimed.leaseEpoch || latest.lease?.ownerId !== options.claimed.lease?.ownerId) abort.abort(new Error("Export job lease was lost."));
    return latest;
  };
  const tick = async (): Promise<void> => serialize(async () => {
    const latest = await refresh(); if (abort.signal.aborted || latest.state !== "running") return;
    current = await options.jobs.compareAndSet({ kind: "heartbeat", id: latest.id, expectedRevision: latest.revision, ownerId: latest.lease!.ownerId, leaseEpoch: latest.leaseEpoch, now: now(), leaseDurationMs });
  });
  const heartbeatTimer = setInterval(() => { void tick().catch((error) => { backgroundError = error; abort.abort(error); }); }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const cancelTimer = setInterval(() => { void serialize(refresh).catch((error) => { backgroundError = error; abort.abort(error); }); }, cancelPollMs);
  cancelTimer.unref?.();

  const requestCancellation = async (at = now()): Promise<void> => serialize(async () => {
    const latest = await options.jobs.get(current.id); if (!latest) return;
    current = latest;
    if (latest.state === "running") current = await options.jobs.compareAndSet({ kind: "transition", id: latest.id, expectedRevision: latest.revision, to: "cancelling", at });
    abort.abort(new DOMException("Export job cancellation was requested.", "AbortError"));
  });
  const appendEvent = async (
    snapshot: ExportJobSnapshotV1,
    event: Parameters<ExportJobExecutionContext["appendEvent"]>[0],
  ): Promise<void> => {
    const prior = await options.jobs.readEvents(snapshot.id, { limit: 1_000 });
    const seq = (prior.events.at(-1)?.seq ?? 0) + 1;
    await options.jobs.appendEvent(snapshot.id, {
      expectedRevision: snapshot.revision,
      leaseEpoch: snapshot.leaseEpoch,
      event: { ...event, seq },
    });
  };
  const onExternalAbort = (): void => { void requestCancellation().catch((error) => { backgroundError = error; abort.abort(error); }); };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) {
    abort.abort(options.signal.reason ?? new DOMException("Export job cancellation was requested.", "AbortError"));
    void requestCancellation().catch((error) => { backgroundError = error; abort.abort(error); });
  }

  const context: ExportJobExecutionContext = {
    jobId: current.id, leaseEpoch: current.leaseEpoch,
    ...(current.checkpointRef ? { checkpointRef: current.checkpointRef } : {}),
    signal: abort.signal,
    spool: bindExportJobSpool(options.spool, current.id, current.leaseEpoch, options.spoolLimits),
    readSpool(ref, readOptions) {
      if (ref.jobId !== current.id || ref.leaseEpoch > current.leaseEpoch) {
        throw new Error("Recovery spool ref is outside the claimed job or lease history.");
      }
      return options.spool.read(ref, readOptions);
    },
    artifacts: bindExportJobArtifacts(options.artifacts, current.id, current.leaseEpoch),
    updateProgress(progress) { return serialize(async () => {
      const latest = await refresh(); abort.signal.throwIfAborted();
      const previousStage = latest.stage;
      // The executor captures progress before this serialized host write runs.
      // A claim, checkpoint, or heartbeat queued ahead of it may have advanced
      // the lease clock meanwhile. Normalize against durable state without
      // reading the host clock again: injected clocks must not gain observable
      // calls merely because a progress write was serialized.
      const persistedProgress = {
        ...progress,
        updatedAt: Math.max(
          progress.updatedAt,
          latest.lease?.acquiredAt ?? progress.updatedAt,
          latest.lease?.heartbeatAt ?? progress.updatedAt,
          latest.progress?.updatedAt ?? progress.updatedAt,
        ),
      };
      current = await options.jobs.compareAndSet({ kind: "progress", id: latest.id, expectedRevision: latest.revision, leaseEpoch: latest.leaseEpoch, progress: persistedProgress });
      if (previousStage !== persistedProgress.stage) {
        await appendEvent(current, { kind: "stage", at: persistedProgress.updatedAt, stage: persistedProgress.stage });
      }
      await appendEvent(current, { kind: "progress", at: persistedProgress.updatedAt, progress: persistedProgress });
    }); },
    updateStats(stats) { return serialize(async () => {
      const latest = await refresh(); abort.signal.throwIfAborted();
      current = await options.jobs.compareAndSet({
        kind: "stats",
        id: latest.id,
        expectedRevision: latest.revision,
        leaseEpoch: latest.leaseEpoch,
        at: now(),
        stats,
      });
    }); },
    appendEvent(event) { return serialize(async () => {
      const latest = await refresh(); abort.signal.throwIfAborted();
      await appendEvent(latest, event);
    }); },
    checkpoint(ref) { return serialize(async () => {
      const latest = await refresh(); abort.signal.throwIfAborted();
      current = await options.jobs.compareAndSet({ kind: "checkpoint", id: latest.id, expectedRevision: latest.revision, leaseEpoch: latest.leaseEpoch, at: now(), checkpointRef: ref });
      context.checkpointRef = ref;
    }); },
  };
  return {
    context,
    snapshot: () => serialize(async () => structuredClone(await refresh())),
    requestCancellation,
    async stop() { if (stopped) return; stopped = true; clearInterval(heartbeatTimer); clearInterval(cancelTimer); options.signal?.removeEventListener("abort", onExternalAbort); await tail; },
  };
}

export interface RunClaimedFileExportJobOptionsV1 extends Omit<CreateFileExportExecutionContextOptionsV1, "claimed"> {
  claimed: ExportJobSnapshotV1;
  executor: ExportJobExecutor<ExportJobRequestV1>;
}

function durableExecutorFailure(
  error: unknown,
  stage: ExportJobSnapshotV1["stage"],
  occurredAt: number,
): ExportJobErrorV1 {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "confluence-source-resolution-failed" &&
    "sourceFailureKind" in error
  ) {
    const sourceFailureKind = error.sourceFailureKind;
    if (
      sourceFailureKind === "authentication" ||
      sourceFailureKind === "not-found" ||
      sourceFailureKind === "unknown"
    ) {
      return {
        code: error.code,
        message:
          error instanceof Error
            ? error.message
            : "The Confluence export source could not be resolved.",
        category: sourceFailureKind === "authentication" ? "auth" : "source",
        retryable: sourceFailureKind === "unknown",
        ...(stage ? { stage } : {}),
        occurredAt,
      };
    }
  }
  return {
    code: "executor.failed",
    message: error instanceof Error ? error.message : String(error),
    category: "unknown",
    retryable: false,
    ...(stage ? { stage } : {}),
    occurredAt,
  };
}

async function appendCommittedEvent(
  jobs: FileExportJobStore,
  snapshot: ExportJobSnapshotV1,
  event: ExportJobEventDraftV1,
): Promise<void> {
  const prior = await jobs.readEvents(snapshot.id, { limit: 1_000 });
  await jobs.appendEvent(snapshot.id, {
    expectedRevision: snapshot.revision,
    leaseEpoch: snapshot.leaseEpoch,
    event: { ...event, seq: (prior.events.at(-1)?.seq ?? 0) + 1 },
  });
}

/** Execute and fence-finalize exactly one claimed job. Errors become durable terminal state. */
export async function runClaimedFileExportJob(options: RunClaimedFileExportJobOptionsV1): Promise<ExportJobSnapshotV1> {
  const runtime = createFileExportExecutionContext(options); const now = options.now ?? Date.now;
  try {
    const request = await options.jobs.getRequest(options.claimed.requestRef); if (!request) throw new Error("Claimed job request was not found.");
    if (request.format !== options.executor.format) throw new Error("Executor format does not match the claimed request.");
    const result: ExportJobExecutionResultV1 = await options.executor.execute(request, runtime.context);
    const current = await runtime.snapshot();
    const finishedAt = now();
    const finalized = await options.jobs.finalizeArtifact({ id: current.id, expectedRevision: current.revision, leaseEpoch: current.leaseEpoch, stagedArtifact: result.stagedArtifact, reportRef: result.reportRef, reportSummary: result.reportSummary, finishedAt });
    await appendCommittedEvent(options.jobs, finalized, { kind: "state", at: finishedAt, from: "running", to: "succeeded" });
    await appendCommittedEvent(options.jobs, finalized, { kind: "artifact", at: finishedAt, artifact: finalized.artifact! });
    return finalized;
  } catch (error) {
    const current = await options.jobs.get(options.claimed.id); if (!current) throw error;
    if (current.state === "succeeded" || current.state === "failed" || current.state === "cancelled" || current.state === "interrupted") return current;
    if (current.state === "cancelling") {
      const at = now();
      const cancelled = await options.jobs.compareAndSet({ kind: "transition", id: current.id, expectedRevision: current.revision, leaseEpoch: current.leaseEpoch, to: "cancelled", at });
      await appendCommittedEvent(options.jobs, cancelled, { kind: "state", at, from: "cancelling", to: "cancelled" });
      return cancelled;
    }
    if (current.state === "running") {
      const at = now();
      const durableError = durableExecutorFailure(error, current.stage, at);
      const failed = await options.jobs.compareAndSet({ kind: "transition", id: current.id, expectedRevision: current.revision, leaseEpoch: current.leaseEpoch, to: "failed", at, error: durableError });
      await appendCommittedEvent(options.jobs, failed, { kind: "state", at, from: "running", to: "failed" });
      await appendCommittedEvent(options.jobs, failed, { kind: "issue", at, level: "error", code: durableError.code });
      return failed;
    }
    throw error;
  } finally { await runtime.stop(); }
}
