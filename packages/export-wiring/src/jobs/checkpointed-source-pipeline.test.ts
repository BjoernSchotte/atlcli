import { describe, expect, it } from "bun:test";
import {
  runCheckpointedOrderedSourcePipeline,
  type OrderedSourceEntryV1,
  type OrderedSourcePortV1,
} from "./checkpointed-source-pipeline.js";

type Entry = OrderedSourceEntryV1<string, number>;
const identity = { jobId: "job-1", requestKey: "request-sha256" } as const;

function source(values: readonly string[], observedAfter: Array<number | undefined> = []): OrderedSourcePortV1<string, number> {
  return {
    async discover(after, { limit, signal }) {
      if (signal.aborted) throw signal.reason;
      observedAfter.push(after);
      const start = after ?? 0;
      const entries: Entry[] = values.slice(start, start + limit).map((value, offset) => ({
        key: `entry-${start + offset}`,
        value,
        cursorAfter: start + offset + 1,
      }));
      return { entries, done: start + entries.length >= values.length };
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

describe("runCheckpointedOrderedSourcePipeline", () => {
  it("processes concurrently but commits and checkpoints in discovery order", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const committed: number[] = [];
    const saved: number[] = [];
    const published: string[] = [];

    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c"]),
      concurrency: 3,
      maxResultSlots: 3,
      maxBufferedEntries: 3,
      async process(value, { ordinal }) {
        started.push(ordinal);
        await gates[ordinal]!.promise;
        return value.toUpperCase();
      },
      async commitCheckpoint(item, checkpoint) {
        committed.push(item.ordinal);
        expect(item.result).toBe(item.source.toUpperCase());
        saved.push(checkpoint.nextCommitOrdinal);
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
      async publishCheckpointRef(ref) {
        published.push(ref);
      },
    });

    await waitUntil(() => started.length === 3);
    gates[2]!.resolve();
    gates[1]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(committed).toEqual([]);
    gates[0]!.resolve();

    const result = await run;
    expect(committed).toEqual([0, 1, 2]);
    expect(saved).toEqual([1, 2, 3]);
    expect(published).toEqual(["checkpoint:1", "checkpoint:2", "checkpoint:3"]);
    expect(result).toEqual({
      committedCount: 3,
      latestCheckpoint: {
        checkpoint: {
          version: 1,
          ...identity,
          generation: 3,
          sourceCursor: 3,
          nextCommitOrdinal: 3,
          committedCount: 3,
        },
        ref: "checkpoint:3",
      },
    });
  });

  it("backpressures processing when expensive result slots are blocked", async () => {
    const first = deferred();
    const started: number[] = [];
    const committed: number[] = [];

    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c", "d", "e"]),
      concurrency: 2,
      maxResultSlots: 2,
      maxBufferedEntries: 5,
      async process(value, { ordinal }) {
        started.push(ordinal);
        if (ordinal === 0) await first.promise;
        return value;
      },
      async commitCheckpoint(item, checkpoint) {
        committed.push(item.ordinal);
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
    });

    await waitUntil(() => started.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    expect(committed).toEqual([]);

    first.resolve();
    await run;
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(committed).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps a lazy 500-page preorder run inside the configured issue window", async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let highestStarted = -1;
    let maxActive = 0;
    let active = 0;
    let discovered = 0;
    const committed: number[] = [];
    const pageSource: OrderedSourcePortV1<number, number> = {
      async discover(after, { limit, signal }) {
        if (signal.aborted) throw signal.reason;
        const start = after ?? 0;
        const end = Math.min(500, start + limit);
        discovered = Math.max(discovered, end);
        return {
          entries: Array.from({ length: end - start }, (_, offset) => ({
            key: `page-${start + offset}`,
            value: start + offset,
            cursorAfter: start + offset + 1,
          })),
          done: end === 500,
        };
      },
    };

    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: pageSource,
      concurrency: 4,
      maxResultSlots: 8,
      maxBufferedEntries: 8,
      async process(value, { ordinal }) {
        highestStarted = Math.max(highestStarted, ordinal);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (ordinal < gates.length) await gates[ordinal]!.promise;
          return value;
        } finally {
          active -= 1;
        }
      },
      async commitCheckpoint(item, checkpoint) {
        committed.push(item.ordinal);
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
    });

    await waitUntil(() => highestStarted === 3);
    expect(maxActive).toBe(4);
    gates[1]!.resolve();
    gates[2]!.resolve();
    gates[3]!.resolve();
    await waitUntil(() => highestStarted === 7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ highestStarted, discovered, maxActive }).toEqual({
      highestStarted: 7,
      discovered: 8,
      maxActive: 4,
    });

    gates[0]!.resolve();
    const result = await run;
    expect(result.committedCount).toBe(500);
    expect(committed).toHaveLength(500);
    expect(committed[0]).toBe(0);
    expect(committed[499]).toBe(499);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("keeps running slots addressable while earlier slots are removed", async () => {
    const second = deferred();
    const committed: number[] = [];
    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c"]),
      concurrency: 2,
      maxResultSlots: 2,
      maxBufferedEntries: 3,
      async process(value, { ordinal }) {
        if (ordinal === 1) await second.promise;
        return value.toUpperCase();
      },
      async commitCheckpoint(item, checkpoint) {
        committed.push(item.ordinal);
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
    });

    await waitUntil(() => committed.length === 1);
    second.resolve();
    const result = await run;
    expect(committed).toEqual([0, 1, 2]);
    expect(result.committedCount).toBe(3);
  });

  it("does not advance the next commit slot before its atomic checkpoint resolves", async () => {
    const firstCommit = deferred();
    const commitCalls: number[] = [];
    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c"]),
      concurrency: 3,
      maxResultSlots: 3,
      maxBufferedEntries: 3,
      async process(value) {
        return value;
      },
      async commitCheckpoint(item, checkpoint) {
        commitCalls.push(item.ordinal);
        expect(checkpoint.nextCommitOrdinal).toBe(item.ordinal + 1);
        if (item.ordinal === 0) await firstCommit.promise;
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
    });

    await waitUntil(() => commitCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commitCalls).toEqual([0]);
    firstCommit.resolve();
    await run;
    expect(commitCalls).toEqual([0, 1, 2]);
  });

  it("resumes from the durable cursor without rediscovering committed entries", async () => {
    const observedAfter: Array<number | undefined> = [];
    const committed: number[] = [];

    const result = await runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c", "d"], observedAfter),
      concurrency: 1,
      maxResultSlots: 1,
      maxBufferedEntries: 2,
      resume: {
        checkpoint: {
          version: 1,
          ...identity,
          generation: 2,
          sourceCursor: 2,
          nextCommitOrdinal: 2,
          committedCount: 2,
        },
        ref: "checkpoint:2",
      },
      async process(value) {
        return value;
      },
      async commitCheckpoint(item, checkpoint) {
        committed.push(item.ordinal);
        return `checkpoint:${checkpoint.nextCommitOrdinal}`;
      },
    });

    expect(observedAfter[0]).toBe(2);
    expect(committed).toEqual([2, 3]);
    expect(result.committedCount).toBe(4);
    expect(result.latestCheckpoint?.checkpoint.sourceCursor).toBe(4);
  });

  it("rejects a checkpoint loaded for another request before discovery starts", async () => {
    let discovered = false;
    await expect(runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: {
        async discover() {
          discovered = true;
          return { entries: [], done: true };
        },
      },
      concurrency: 1,
      maxResultSlots: 1,
      maxBufferedEntries: 1,
      resume: {
        checkpoint: {
          version: 1,
          jobId: identity.jobId,
          requestKey: "different-request",
          generation: 1,
          sourceCursor: 1,
          nextCommitOrdinal: 1,
          committedCount: 1,
        },
        ref: "checkpoint:foreign",
      },
      async process(value) { return value; },
      async commitCheckpoint() { return "checkpoint:never"; },
    })).rejects.toThrow("does not match");
    expect(discovered).toBe(false);
  });

  it("aborts sibling work, drains it, and never commits after a processing failure", async () => {
    const boom = new Error("page fetch failed");
    const aborted: number[] = [];
    const committed: number[] = [];

    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a", "b", "c"]),
      concurrency: 3,
      maxResultSlots: 3,
      maxBufferedEntries: 3,
      async process(_value, { ordinal, signal }) {
        if (ordinal === 1) throw boom;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(ordinal);
            reject(signal.reason);
          }, { once: true });
        });
        return ordinal;
      },
      async commitCheckpoint(item) {
        committed.push(item.ordinal);
        return "checkpoint:never";
      },
    });

    await expect(run).rejects.toBe(boom);
    expect(aborted.sort()).toEqual([0, 2]);
    expect(committed).toEqual([]);
  });

  it("honors caller cancellation during processing", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by user");
    const run = runCheckpointedOrderedSourcePipeline({
      ...identity,
      source: source(["a"]),
      concurrency: 1,
      maxResultSlots: 1,
      maxBufferedEntries: 1,
      signal: controller.signal,
      async process(_value, { signal }) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "never";
      },
      async commitCheckpoint() {
        return "checkpoint:never";
      },
    });

    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
  });

  it("rejects sources that violate the discovery bound or make no progress", async () => {
    const common = {
      ...identity,
      concurrency: 1,
      maxResultSlots: 1,
      maxBufferedEntries: 1,
      async process(value: string) { return value; },
      async commitCheckpoint() { return "checkpoint:x"; },
    };

    await expect(runCheckpointedOrderedSourcePipeline({
      ...common,
      source: {
        async discover() {
          return {
            entries: [
              { key: "a", value: "a", cursorAfter: 1 },
              { key: "b", value: "b", cursorAfter: 2 },
            ],
            done: true,
          };
        },
      },
    })).rejects.toThrow("for limit 1");

    await expect(runCheckpointedOrderedSourcePipeline({
      ...common,
      source: { async discover() { return { entries: [], done: false }; } },
    })).rejects.toThrow("made no progress");
  });
});
