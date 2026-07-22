/**
 * Host-neutral, bounded source pipeline for background exports.
 *
 * Discovery deliberately returns lightweight references. Expensive page/body
 * work happens in bounded result slots, and results become visible strictly in
 * discovery order. This seam does not know about Confluence, DOCX, PDF, or a
 * physical checkpoint backend.
 */

/** One lightweight source reference and the exact cursor after that entry. */
export interface OrderedSourceEntryV1<Value, Cursor> {
  /** Stable idempotency key. A resumed commit may present the same key again. */
  key: string;
  value: Value;
  cursorAfter: Cursor;
}

/** A bounded discovery response. `entries` must not exceed the requested limit. */
export interface OrderedSourceDiscoveryV1<Value, Cursor> {
  entries: readonly OrderedSourceEntryV1<Value, Cursor>[];
  /** True when no entry exists after this batch. */
  done: boolean;
}

/** Port that incrementally discovers ordered, lightweight source references. */
export interface OrderedSourcePortV1<Value, Cursor> {
  discover(
    after: Cursor | undefined,
    context: { limit: number; signal: AbortSignal },
  ): Promise<OrderedSourceDiscoveryV1<Value, Cursor>>;
}

/** Durable resume state published only after its ordered item was committed. */
export interface OrderedSourceCheckpointV1<Cursor> {
  version: 1;
  /** Stable job and canonical request/config identity validated on recovery. */
  jobId: string;
  requestKey: string;
  /** Monotonic committed checkpoint generation. */
  generation: number;
  /** Cursor immediately after the last committed entry. */
  sourceCursor: Cursor;
  /** Exact preorder slot whose result must commit next after recovery. */
  nextCommitOrdinal: number;
  committedCount: number;
}

/** A processed result presented to the ordered, replay-safe commit callback. */
export interface OrderedSourceCommitV1<Value, Result> {
  ordinal: number;
  key: string;
  source: Value;
  result: Result;
}

/** A checkpoint plus the host-owned opaque reference returned for it. */
export interface PersistedOrderedSourceCheckpointV1<Cursor> {
  /**
   * Host-loaded, validated payload. On lease recovery the host reads the old
   * epoch through its recovery authority before constructing this value; the
   * pipeline never dereferences an old-epoch ref through the current executor's
   * bound spool.
   */
  checkpoint: OrderedSourceCheckpointV1<Cursor>;
  /** Provenance/notification handle only; it is never opened by this pipeline. */
  ref: string;
}

export interface CheckpointedOrderedSourcePipelineOptionsV1<Value, Cursor, Result> {
  jobId: string;
  requestKey: string;
  source: OrderedSourcePortV1<Value, Cursor>;
  /** Maximum number of concurrent calls to `process`. */
  concurrency: number;
  /**
   * Maximum number of expensive slots, including processing and ready results.
   * Reserving the slot before work starts strictly bounds ready-but-blocked data.
   */
  maxResultSlots: number;
  /** Maximum lightweight discovered entries, including result slots. */
  maxBufferedEntries: number;
  signal?: AbortSignal;
  resume?: PersistedOrderedSourceCheckpointV1<Cursor>;
  process(
    source: Value,
    context: { ordinal: number; key: string; signal: AbortSignal },
  ): Promise<Result>;
  /**
   * Atomically make one ordered result and its resume checkpoint durable,
   * returning the checkpoint's opaque host-owned reference. The operation must
   * be idempotent by `item.key`: publishing the ref on the job is deliberately
   * a separate fenced metadata update and can be retried after executor loss.
   */
  commitCheckpoint(
    item: OrderedSourceCommitV1<Value, Result>,
    checkpoint: OrderedSourceCheckpointV1<Cursor>,
    context: { signal: AbortSignal },
  ): Promise<string>;
  /**
   * Fence and publish the durable ref on the active job lease. The host may map
   * this directly to `ExportJobExecutionContext.checkpoint(ref)`.
   */
  publishCheckpointRef?(ref: string, context: { signal: AbortSignal }): Promise<void>;
}

export interface CheckpointedOrderedSourcePipelineResultV1<Cursor> {
  committedCount: number;
  latestCheckpoint?: PersistedOrderedSourceCheckpointV1<Cursor>;
}

type QueuedSlot<Value, Cursor> = {
  state: "queued";
  ordinal: number;
  entry: OrderedSourceEntryV1<Value, Cursor>;
};

type ProcessingSlot<Value, Cursor> = {
  state: "processing";
  ordinal: number;
  entry: OrderedSourceEntryV1<Value, Cursor>;
  task: Promise<void>;
};

type ReadySlot<Value, Cursor, Result> = {
  state: "ready";
  ordinal: number;
  entry: OrderedSourceEntryV1<Value, Cursor>;
  result: Result;
};

type FailedSlot<Value, Cursor> = {
  state: "failed";
  ordinal: number;
  entry: OrderedSourceEntryV1<Value, Cursor>;
  error: unknown;
};

type Slot<Value, Cursor, Result> =
  | QueuedSlot<Value, Cursor>
  | ProcessingSlot<Value, Cursor>
  | ReadySlot<Value, Cursor, Result>
  | FailedSlot<Value, Cursor>;

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function validateOptions<Value, Cursor, Result>(
  options: CheckpointedOrderedSourcePipelineOptionsV1<Value, Cursor, Result>,
): void {
  positiveInteger(options.concurrency, "concurrency");
  positiveInteger(options.maxResultSlots, "maxResultSlots");
  positiveInteger(options.maxBufferedEntries, "maxBufferedEntries");
  if (options.maxResultSlots < options.concurrency) {
    throw new RangeError("maxResultSlots must be greater than or equal to concurrency.");
  }
  if (options.maxBufferedEntries < options.maxResultSlots) {
    throw new RangeError("maxBufferedEntries must be greater than or equal to maxResultSlots.");
  }
  if (options.jobId.trim().length === 0 || options.requestKey.trim().length === 0) {
    throw new RangeError("jobId and requestKey must not be empty.");
  }
  if (options.resume) {
    const { checkpoint, ref } = options.resume;
    if (checkpoint.version !== 1) throw new RangeError("Unsupported source checkpoint version.");
    if (checkpoint.jobId !== options.jobId || checkpoint.requestKey !== options.requestKey) {
      throw new RangeError("Checkpoint identity does not match this export request.");
    }
    if (!Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1) {
      throw new RangeError("checkpoint.generation must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(checkpoint.nextCommitOrdinal) || checkpoint.nextCommitOrdinal < 0) {
      throw new RangeError("checkpoint.nextCommitOrdinal must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(checkpoint.committedCount) || checkpoint.committedCount < 0) {
      throw new RangeError("checkpoint.committedCount must be a non-negative safe integer.");
    }
    if (checkpoint.nextCommitOrdinal !== checkpoint.committedCount) {
      throw new RangeError("checkpoint.nextCommitOrdinal must equal checkpoint.committedCount.");
    }
    if (ref.trim().length === 0) throw new RangeError("checkpoint ref must not be empty.");
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The export source pipeline was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/**
 * Discover, process, and commit an ordered source with bounded memory.
 *
 * At most `maxBufferedEntries` lightweight references are retained. More
 * importantly, at most `maxResultSlots` expensive processing/ready values exist
 * at once. A slow early entry therefore backpressures later work instead of
 * accumulating an unbounded ready queue.
 */
export async function runCheckpointedOrderedSourcePipeline<Value, Cursor, Result>(
  options: CheckpointedOrderedSourcePipelineOptionsV1<Value, Cursor, Result>,
): Promise<CheckpointedOrderedSourcePipelineResultV1<Cursor>> {
  validateOptions(options);

  const controller = new AbortController();
  let firstFailure: unknown;
  let hasFailure = false;
  let wakeResolver: (() => void) | undefined;
  let wakePending = false;
  const wake = (): void => {
    if (wakeResolver) {
      wakeResolver();
      wakeResolver = undefined;
    } else {
      wakePending = true;
    }
  };
  const waitForWake = (): Promise<void> => {
    if (wakePending) {
      wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      wakeResolver = resolve;
    });
  };

  const abortFromParent = (): void => {
    controller.abort(options.signal ? abortReason(options.signal) : undefined);
    wake();
  };
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const slots: Array<Slot<Value, Cursor, Result>> = [];
  const running = new Set<Promise<void>>();
  let discoveryCursor = options.resume?.checkpoint.sourceCursor;
  let sourceDone = false;
  let nextOrdinal = options.resume?.checkpoint.nextCommitOrdinal ?? 0;
  let committedCount = options.resume?.checkpoint.committedCount ?? 0;
  let latestCheckpoint = options.resume;

  const fail = (error: unknown): void => {
    if (!hasFailure) {
      firstFailure = error;
      hasFailure = true;
    }
    controller.abort(error);
    wake();
  };

  const startQueued = (): void => {
    let processingCount = slots.filter((slot) => slot.state === "processing").length;
    let resultSlotCount = slots.filter(
      (slot) => slot.state === "processing" || slot.state === "ready",
    ).length;

    for (let index = 0; index < slots.length; index += 1) {
      if (processingCount >= options.concurrency || resultSlotCount >= options.maxResultSlots) break;
      const slot = slots[index];
      if (!slot || slot.state !== "queued") continue;

      const processing: ProcessingSlot<Value, Cursor> = {
        state: "processing",
        ordinal: slot.ordinal,
        entry: slot.entry,
        task: Promise.resolve(),
      };
      const task = options
        .process(slot.entry.value, {
          ordinal: slot.ordinal,
          key: slot.entry.key,
          signal: controller.signal,
        })
        .then(
          (result) => {
            const currentIndex = slots.findIndex((candidate) => candidate.ordinal === slot.ordinal);
            if (currentIndex >= 0) slots[currentIndex] = { ...slot, state: "ready", result };
          },
          (error: unknown) => {
            const currentIndex = slots.findIndex((candidate) => candidate.ordinal === slot.ordinal);
            if (currentIndex >= 0) slots[currentIndex] = { ...slot, state: "failed", error };
            fail(error);
          },
        )
        .finally(() => {
          running.delete(task);
          wake();
        });
      processing.task = task;
      slots[index] = processing;
      running.add(task);
      processingCount += 1;
      resultSlotCount += 1;
    }
  };

  try {
    while (true) {
      throwIfAborted(controller.signal);

      while (!sourceDone && slots.length < options.maxBufferedEntries) {
        const limit = options.maxBufferedEntries - slots.length;
        let batch: OrderedSourceDiscoveryV1<Value, Cursor>;
        try {
          batch = await options.source.discover(discoveryCursor, {
            limit,
            signal: controller.signal,
          });
        } catch (error) {
          throw hasFailure ? firstFailure : error;
        }
        throwIfAborted(controller.signal);
        if (batch.entries.length > limit) {
          throw new RangeError(`Source returned ${batch.entries.length} entries for limit ${limit}.`);
        }
        if (batch.entries.length === 0 && !batch.done) {
          throw new Error("Source discovery made no progress before end-of-source.");
        }
        for (const entry of batch.entries) {
          if (entry.key.trim().length === 0) throw new Error("Source entry key must not be empty.");
          slots.push({ state: "queued", ordinal: nextOrdinal, entry });
          nextOrdinal += 1;
          discoveryCursor = entry.cursorAfter;
        }
        sourceDone = batch.done;
        startQueued();
      }

      startQueued();
      const failed = slots.find((slot) => slot.state === "failed");
      if (failed?.state === "failed") throw hasFailure ? firstFailure : failed.error;

      const first = slots[0];
      if (!first) {
        if (sourceDone) {
          return { committedCount, ...(latestCheckpoint ? { latestCheckpoint } : {}) };
        }
        continue;
      }

      if (first.state === "ready") {
        throwIfAborted(controller.signal);
        const checkpoint: OrderedSourceCheckpointV1<Cursor> = {
          version: 1,
          jobId: options.jobId,
          requestKey: options.requestKey,
          generation: (latestCheckpoint?.checkpoint.generation ?? 0) + 1,
          sourceCursor: first.entry.cursorAfter,
          nextCommitOrdinal: first.ordinal + 1,
          committedCount: committedCount + 1,
        };
        const ref = await options.commitCheckpoint(
          {
            ordinal: first.ordinal,
            key: first.entry.key,
            source: first.entry.value,
            result: first.result,
          },
          checkpoint,
          { signal: controller.signal },
        );
        if (ref.trim().length === 0) throw new Error("commitCheckpoint returned an empty ref.");
        await options.publishCheckpointRef?.(ref, { signal: controller.signal });
        committedCount += 1;
        latestCheckpoint = { checkpoint, ref };
        slots.shift();
        continue;
      }

      await waitForWake();
    }
  } catch (error) {
    fail(error);
    await Promise.all([...running]);
    throw hasFailure ? firstFailure : error;
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
