/**
 * Durable background jobs, against a real store (spec 010 T5.6).
 *
 * No HTTP is mocked and no IndexedDB behaviour is faked: `fake-indexeddb` is a
 * real implementation of the API, which is what makes "the record survived a
 * service-worker restart" a claim this file can actually make. What *is*
 * simulated is the restart itself — the in-memory state of the router is thrown
 * away and rebuilt while the records are left exactly as they were, which is
 * precisely what Chrome does to an MV3 worker.
 *
 * The two defects under test:
 *
 *   (a) is covered by `tests/pdf/section-navigation.test.tsx` (UI-side);
 *   (b) is covered here at the integration level and in
 *       `tests/jobs/idle-gate.test.ts` at the unit level.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  cancelPdfJob,
  claimPdfJob,
  completePdfJob,
  countInFlightPdfJobs,
  deletePdfJob,
  getPdfJob,
  getPdfJobMeta,
  listPdfJobMeta,
  markPdfJobConsumed,
  putPdfJob,
  sweepPdfJobs,
} from "../../utils/pdf/job-store.js";
import { extensionPdfCompilePort } from "../../utils/pdf/compile-port.js";
import { createDurableIdleGate } from "../../utils/jobs/idle-gate.js";
import { createOffscreenActivityTracker } from "../../utils/pdf/offscreen-activity.js";
import { watchPdfJob } from "../../utils/jobs/watch.js";
import { PDF_JOB_TIMED_OUT_ERROR } from "../../utils/jobs/model.js";

globalThis.IDBKeyRange = IDBKeyRange;

let factory: IDBFactory;

const JOB_A = "123e4567-e89b-42d3-a456-426614174000";
const JOB_B = "223e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  factory = new IDBFactory();
});

function bundle(size = 4_096): PdfSourceBundle {
  return {
    main: "= Job",
    template: "template",
    assets: [{ path: "assets/a.png", mediaType: "image/png", bytes: new Uint8Array(size) }],
    sourceMap: [],
    notes: [],
  };
}

/**
 * The service worker's in-memory state, and nothing else.
 *
 * `restart()` throws it away and builds a fresh one — the counter back at zero,
 * no knowledge of any job — while the records stay untouched. That is the whole
 * fixture: everything a real restart destroys, and nothing it does not.
 */
function createWorkerState(timer: { events: string[]; stop(): void; reset(): void }) {
  const gate = createDurableIdleGate({
    timer,
    countInFlight: () => countInFlightPdfJobs(factory),
    schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => undefined,
  });
  return { gate, activity: createOffscreenActivityTracker(gate) };
}

function recordingTimer(): { events: string[]; stop(): void; reset(): void } {
  const events: string[] = [];
  return { events, stop: () => events.push("stop"), reset: () => events.push("reset") };
}

/** Poll a real condition rather than guessing at a delay. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a job survives the service worker that started it", () => {
  it("is still findable, and still finishes, after the in-memory state is rebuilt", async () => {
    const timer = recordingTimer();
    let worker = createWorkerState(timer);

    await putPdfJob({ id: JOB_A, sourceIdentity: "https://site.atlassian.net/x|1|1", bundle: bundle() }, factory);
    worker.activity.begin();
    await claimPdfJob(JOB_A, factory);

    // --- the service worker is terminated mid-compile ------------------------
    worker = createWorkerState(timer);
    expect(worker.activity.inFlight).toBe(0);
    // The record, however, remembers.
    expect(await countInFlightPdfJobs(factory)).toBe(1);
    expect((await getPdfJobMeta(JOB_A, factory))?.status).toBe("compiling");

    // The offscreen worker, which was never terminated, finishes the compile.
    await completePdfJob(
      JOB_A,
      { pdf: new Uint8Array([1, 2, 3]), diagnostics: [], compilerVersion: "test" },
      factory
    );

    // A panel that opens now finds the result without any reconnection.
    const found = await getPdfJob(JOB_A, factory, { bundle: false, pdf: true });
    expect(found?.status).toBe("complete");
    expect(found?.pdf?.byteLength).toBe(3);
  });

  /**
   * Defect (b), end to end.
   *
   * Job A is compiling when the worker dies. The restarted worker runs job B to
   * completion; B's `end()` takes the *volatile* counter to zero and asks for
   * the idle timer. It must not get it, because A is still compiling.
   */
  it("does not arm the offscreen idle timer while a pre-restart compile is still running", async () => {
    const timer = recordingTimer();
    let worker = createWorkerState(timer);

    await putPdfJob({ id: JOB_A, sourceIdentity: "https://site.atlassian.net/a|1|1", bundle: bundle() }, factory);
    worker.activity.begin();
    await claimPdfJob(JOB_A, factory);

    worker = createWorkerState(timer); // ← restart: counter back to zero

    await putPdfJob({ id: JOB_B, sourceIdentity: "https://site.atlassian.net/b|1|1", bundle: bundle() }, factory);
    worker.activity.begin();
    await claimPdfJob(JOB_B, factory);
    await completePdfJob(
      JOB_B,
      { pdf: new Uint8Array([9]), diagnostics: [], compilerVersion: "test" },
      factory
    );
    worker.activity.end();
    await worker.gate.settled();

    expect(worker.activity.inFlight).toBe(0);
    expect(timer.events).not.toContain("reset");
    expect((await getPdfJobMeta(JOB_A, factory))?.status).toBe("compiling");

    // Once A also finishes, the document is allowed to close again.
    await completePdfJob(
      JOB_A,
      { pdf: new Uint8Array([7]), diagnostics: [], compilerVersion: "test" },
      factory
    );
    worker.gate.reset();
    await worker.gate.settled();
    expect(timer.events).toContain("reset");
  });
});

describe("the panel resolves from the record when the message channel dies", () => {
  /**
   * The shape of an MV3 worker teardown: the panel's `sendMessage` promise for
   * the compile is simply never answered, because the worker that was going to
   * answer it no longer exists. The offscreen document, which was not
   * terminated, finishes the compile and writes the result — and that write is
   * what the panel must be able to see.
   */
  it("returns the compiled result even though the compile message is never answered", async () => {
    const port = extensionPdfCompilePort({
      sourceIdentity: "https://site.atlassian.net/a|1|1",
      makeJobId: () => JOB_A,
      deps: {
        cleanupJobs: async () => 0,
        createJob: (input) => putPdfJob(input, factory),
        getJob: (id, _factory, options) => getPdfJob(id, factory, options),
        deleteJob: (id) => deletePdfJob(id, factory),
        consumeJob: (id) => markPdfJobConsumed(id, factory),
        // The service worker died holding this request.
        sendMessage: () => new Promise(() => undefined),
        watchJob: (jobId, options) =>
          watchPdfJob(jobId, {
            ...options,
            pollMs: 5,
            getMeta: (id) => getPdfJobMeta(id, factory),
          }),
      },
    });

    const compiling = port.compile(bundle());
    // The offscreen worker, oblivious to the restart, does its job.
    await waitFor(async () => (await getPdfJobMeta(JOB_A, factory)) !== undefined);
    await claimPdfJob(JOB_A, factory);
    await completePdfJob(
      JOB_A,
      { pdf: new Uint8Array([4, 2]), diagnostics: [], compilerVersion: "test" },
      factory
    );

    const result = await compiling;
    expect(result.pdf?.byteLength).toBe(2);
    expect(result.compilerVersion).toBe("test");
    // Consumed by the panel that was watching → the record is spent and gone.
    expect(await getPdfJobMeta(JOB_A, factory)).toBeUndefined();
  });

  it("reports a failure written by the worker, with no message ever coming back", async () => {
    const port = extensionPdfCompilePort({
      sourceIdentity: "https://site.atlassian.net/a|1|1",
      makeJobId: () => JOB_A,
      deps: {
        cleanupJobs: async () => 0,
        createJob: (input) => putPdfJob(input, factory),
        getJob: (id, _factory, options) => getPdfJob(id, factory, options),
        deleteJob: (id) => deletePdfJob(id, factory),
        consumeJob: (id) => markPdfJobConsumed(id, factory),
        sendMessage: () => new Promise(() => undefined),
        watchJob: (jobId, options) =>
          watchPdfJob(jobId, {
            ...options,
            pollMs: 5,
            getMeta: (id) => getPdfJobMeta(id, factory),
          }),
      },
    });

    const compiling = port.compile(bundle());
    await waitFor(async () => (await getPdfJobMeta(JOB_A, factory)) !== undefined);
    await claimPdfJob(JOB_A, factory);
    const { failPdfJob } = await import("../../utils/pdf/job-store.js");
    await failPdfJob(JOB_A, "Typst said no", [], factory);

    await expect(compiling).rejects.toThrow("Typst said no");
    // Not consumed → the panel leaves the record for the Jobs screen.
    expect((await getPdfJobMeta(JOB_A, factory))?.status).toBe("failed");
  });
});

describe("a worker that never reports back", () => {
  it("ends the job failed at its deadline instead of leaving it compiling forever", async () => {
    await putPdfJob(
      {
        id: JOB_A,
        sourceIdentity: "https://site.atlassian.net/a|1|1",
        bundle: bundle(),
        deadlineAt: Date.now() - 1,
      },
      factory
    );
    await claimPdfJob(JOB_A, factory);

    const actions = await sweepPdfJobs({}, factory);
    expect(actions).toEqual([{ id: JOB_A, action: "fail", error: PDF_JOB_TIMED_OUT_ERROR }]);

    const meta = await getPdfJobMeta(JOB_A, factory);
    expect(meta?.status).toBe("failed");
    expect(meta?.error).toBe(PDF_JOB_TIMED_OUT_ERROR);
    // Failing also released the bundle — a dead job holds no bytes.
    expect(meta?.inputBytes).toBe(0);
    expect((await getPdfJob(JOB_A, factory))?.bundle).toBeUndefined();
  });

  it("is reached by the watcher too, so the panel is told rather than hanging", async () => {
    await putPdfJob({ id: JOB_A, sourceIdentity: "https://site.atlassian.net/a|1|1", bundle: bundle() }, factory);
    await claimPdfJob(JOB_A, factory);

    const watch = watchPdfJob(JOB_A, {
      deadlineAt: Date.now() - 1,
      pollMs: 1,
      getMeta: (id) => getPdfJobMeta(id, factory),
      fail: async (id, error) => {
        const { failPdfJob } = await import("../../utils/pdf/job-store.js");
        return failPdfJob(id, error, [], factory);
      },
    });
    const terminal = await watch.promise;
    expect(terminal?.status).toBe("failed");
    expect(terminal?.error).toBe(PDF_JOB_TIMED_OUT_ERROR);
  });
});

describe("closing the panel mid-export leaves no orphan bundle", () => {
  it("releases the source bundle at every terminal state", async () => {
    // Completed: the result is kept for the user, the 64 MiB of source is not.
    await putPdfJob({ id: JOB_A, sourceIdentity: "https://site.atlassian.net/a|1|1", bundle: bundle(16_384) }, factory);
    await claimPdfJob(JOB_A, factory);
    await completePdfJob(
      JOB_A,
      { pdf: new Uint8Array([1]), diagnostics: [], compilerVersion: "test" },
      factory
    );
    const completed = await getPdfJob(JOB_A, factory);
    expect(completed?.bundle).toBeUndefined();
    expect(completed?.inputBytes).toBe(0);
    expect(completed?.pdf?.byteLength).toBe(1);

    // Cancelled: neither source nor result survives.
    await putPdfJob({ id: JOB_B, sourceIdentity: "https://site.atlassian.net/b|1|1", bundle: bundle(16_384) }, factory);
    await claimPdfJob(JOB_B, factory);
    await cancelPdfJob(JOB_B, factory);
    const cancelled = await getPdfJob(JOB_B, factory);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.bundle).toBeUndefined();
    expect(cancelled!.inputBytes + cancelled!.outputBytes).toBe(0);

    // Nothing anywhere in the store is still holding a bundle.
    const all = await listPdfJobMeta(factory);
    expect(all.every((meta) => meta.inputBytes === 0)).toBe(true);
  });

  it("removes a cancelled preview entirely — nobody re-attaches to one", async () => {
    await putPdfJob(
      { id: JOB_A, sourceIdentity: "https://site.atlassian.net/a|1|1", bundle: bundle(), kind: "preview" },
      factory
    );
    await cancelPdfJob(JOB_A, factory);
    expect(await getPdfJobMeta(JOB_A, factory)).toBeUndefined();
  });

  it("keeps a consumed record only until the sweep runs", async () => {
    await putPdfJob({ id: JOB_A, sourceIdentity: "https://site.atlassian.net/a|1|1", bundle: bundle() }, factory);
    await claimPdfJob(JOB_A, factory);
    await completePdfJob(
      JOB_A,
      { pdf: new Uint8Array([1]), diagnostics: [], compilerVersion: "test" },
      factory
    );
    await markPdfJobConsumed(JOB_A, factory);
    expect(await sweepPdfJobs({}, factory)).toEqual([
      { id: JOB_A, action: "delete", reason: "consumed" },
    ]);
    expect(await getPdfJobMeta(JOB_A, factory)).toBeUndefined();
  });
});
