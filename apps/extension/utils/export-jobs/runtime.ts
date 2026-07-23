import {
  bindExportJobArtifacts,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobRequestV1,
  type ExportJobSnapshotV1,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import { IndexedDbExportJobCatalog } from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";

export interface ExtensionExportExecutionRuntime {
  context: ExportJobExecutionContext;
  snapshot(): Promise<ExportJobSnapshotV1>;
  requestCancellation(at?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateExtensionExportExecutionContextOptionsV1 {
  claimed: ExportJobSnapshotV1;
  catalog: IndexedDbExportJobCatalog;
  bytes: IndexedDbExportByteStore;
  spoolLimits: SpoolWriteLimitsV1;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  cancelPollMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

/** Browser execution context with the same lease/cancellation contract as the CLI runtime. */
export function createExtensionExportExecutionContext(
  options: CreateExtensionExportExecutionContextOptionsV1,
): ExtensionExportExecutionRuntime {
  const now = options.now ?? Date.now;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const cancelPollMs = options.cancelPollMs ?? 250;
  const abort = new AbortController();
  let current = structuredClone(options.claimed);
  let stopped = false;
  let tail = Promise.resolve();
  let backgroundError: unknown;
  if (current.state !== "running" || !current.lease || current.leaseEpoch !== current.lease.epoch) {
    throw new Error("Extension execution requires a claimed running job.");
  }

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (backgroundError) throw backgroundError;
      return await operation();
    } finally {
      release();
    }
  };
  const refresh = async (): Promise<ExportJobSnapshotV1> => {
    const latest = await options.catalog.get(current.id);
    if (!latest) throw new Error("Claimed extension export disappeared.");
    current = latest;
    if (latest.state === "cancelling") {
      abort.abort(new DOMException("Export job cancellation was requested.", "AbortError"));
    } else if (
      latest.state !== "running"
      || latest.leaseEpoch !== options.claimed.leaseEpoch
      || latest.lease?.ownerId !== options.claimed.lease?.ownerId
    ) {
      abort.abort(new Error("Extension export lease was lost."));
    }
    return latest;
  };
  const tick = async (): Promise<void> => serialize(async () => {
    const latest = await refresh();
    if (abort.signal.aborted || latest.state !== "running") return;
    current = await options.catalog.compareAndSet({
      kind: "heartbeat",
      id: latest.id,
      expectedRevision: latest.revision,
      ownerId: latest.lease!.ownerId,
      leaseEpoch: latest.leaseEpoch,
      now: now(),
      leaseDurationMs,
    });
  });
  const heartbeatTimer = setInterval(() => {
    void tick().catch((error) => { backgroundError = error; abort.abort(error); });
  }, heartbeatIntervalMs);
  const cancelTimer = setInterval(() => {
    void serialize(refresh).catch((error) => { backgroundError = error; abort.abort(error); });
  }, cancelPollMs);

  const requestCancellation = async (at = now()): Promise<void> => serialize(async () => {
    const latest = await options.catalog.get(current.id);
    if (!latest) return;
    current = latest;
    if (latest.state === "running") {
      current = await options.catalog.compareAndSet({
        kind: "transition",
        id: latest.id,
        expectedRevision: latest.revision,
        to: "cancelling",
        at,
      });
    }
    abort.abort(new DOMException("Export job cancellation was requested.", "AbortError"));
  });
  const onExternalAbort = (): void => {
    void requestCancellation().catch((error) => { backgroundError = error; abort.abort(error); });
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();

  const context: ExportJobExecutionContext = {
    jobId: current.id,
    leaseEpoch: current.leaseEpoch,
    signal: abort.signal,
    spool: bindExportJobSpool(options.bytes, current.id, current.leaseEpoch, options.spoolLimits),
    artifacts: bindExportJobArtifacts(options.bytes, current.id, current.leaseEpoch),
    updateProgress(progress) {
      return serialize(async () => {
        const latest = await refresh();
        abort.signal.throwIfAborted();
        current = await options.catalog.compareAndSet({
          kind: "progress",
          id: latest.id,
          expectedRevision: latest.revision,
          leaseEpoch: latest.leaseEpoch,
          progress,
        });
      });
    },
    appendEvent(event) {
      return serialize(async () => {
        const latest = await refresh();
        abort.signal.throwIfAborted();
        const prior = await options.catalog.readEvents(latest.id, { limit: 1_000 });
        const seq = (prior.events.at(-1)?.seq ?? 0) + 1;
        await options.catalog.appendEvent(latest.id, {
          expectedRevision: latest.revision,
          leaseEpoch: latest.leaseEpoch,
          event: { ...event, seq } as typeof event,
        });
      });
    },
    checkpoint(checkpointRef) {
      return serialize(async () => {
        const latest = await refresh();
        abort.signal.throwIfAborted();
        current = await options.catalog.compareAndSet({
          kind: "checkpoint",
          id: latest.id,
          expectedRevision: latest.revision,
          leaseEpoch: latest.leaseEpoch,
          at: now(),
          checkpointRef,
        });
      });
    },
  };

  return {
    context,
    snapshot: () => serialize(async () => structuredClone(await refresh())),
    requestCancellation,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(cancelTimer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      await tail;
    },
  };
}

export interface RunClaimedExtensionExportJobOptionsV1
  extends Omit<CreateExtensionExportExecutionContextOptionsV1, "claimed"> {
  claimed: ExportJobSnapshotV1;
  executor: ExportJobExecutor<ExportJobRequestV1>;
}

/** Execute and fence-finalize one claimed extension job; no panel lifetime participates. */
export async function runClaimedExtensionExportJob(
  options: RunClaimedExtensionExportJobOptionsV1,
): Promise<ExportJobSnapshotV1> {
  const runtime = createExtensionExportExecutionContext(options);
  const now = options.now ?? Date.now;
  try {
    const request = await options.catalog.getRequest(options.claimed.requestRef);
    if (!request) throw new Error("Claimed extension export request was not found.");
    if (request.format !== options.executor.format) {
      throw new Error("Extension executor format does not match the claimed request.");
    }
    const result: ExportJobExecutionResultV1 = await options.executor.execute(request, runtime.context);
    const current = await runtime.snapshot();
    return options.catalog.finalizeArtifact({
      id: current.id,
      expectedRevision: current.revision,
      leaseEpoch: current.leaseEpoch,
      stagedArtifact: result.stagedArtifact,
      reportRef: result.reportRef,
      reportSummary: result.reportSummary,
      finishedAt: now(),
    });
  } catch (error) {
    const current = await options.catalog.get(options.claimed.id);
    if (!current) throw error;
    if (current.state === "cancelling") {
      return options.catalog.compareAndSet({
        kind: "transition",
        id: current.id,
        expectedRevision: current.revision,
        leaseEpoch: current.leaseEpoch,
        to: "cancelled",
        at: now(),
      });
    }
    if (current.state === "running") {
      return options.catalog.compareAndSet({
        kind: "transition",
        id: current.id,
        expectedRevision: current.revision,
        leaseEpoch: current.leaseEpoch,
        to: "failed",
        at: now(),
        error: {
          code: "executor.failed",
          message: error instanceof Error ? error.message : String(error),
          category: "unknown",
          retryable: false,
          ...(current.stage ? { stage: current.stage } : {}),
          occurredAt: now(),
        },
      });
    }
    throw error;
  } finally {
    await runtime.stop();
  }
}
