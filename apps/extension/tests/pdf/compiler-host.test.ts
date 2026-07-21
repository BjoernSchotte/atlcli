import { describe, expect, it } from "bun:test";
import {
  ChromeWorkerCompilerHost,
  PDF_COMPILE_BASE_TIMEOUT_MS,
  PDF_COMPILE_MAX_TIMEOUT_MS,
  PDF_COMPILE_PER_PAGE_TIMEOUT_MS,
  PREVIEW_SUPERSEDED_ERROR,
  isPreviewSupersededError,
  type PdfWorkerLike,
} from "../../utils/pdf/compiler-host.js";
import type { PdfWorkerRequest, PdfWorkerResponse } from "../../utils/pdf/worker-protocol.js";

class FakeWorker implements PdfWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: PdfWorkerRequest[] = [];
  terminated = false;
  postMessage(message: PdfWorkerRequest): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  reply(response: PdfWorkerResponse): void { this.onmessage?.({ data: response } as MessageEvent); }
}

/** A host over a pool of fake workers, so `workers.length` is the creation count. */
function hostWithWorkers(
  options: Partial<ConstructorParameters<typeof ChromeWorkerCompilerHost>[0]> = {}
): { host: ChromeWorkerCompilerHost; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const host = new ChromeWorkerCompilerHost({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    cancelJob: async () => undefined,
    failJob: async () => undefined,
    ...options,
  });
  return { host, workers };
}

const postedIds = (worker: FakeWorker | undefined): string[] =>
  (worker?.posted ?? []).map((message) => message.jobId);

describe("ChromeWorkerCompilerHost", () => {
  it("runs jobs FIFO on one worker", async () => {
    const worker = new FakeWorker();
    const host = new ChromeWorkerCompilerHost({ createWorker: () => worker, timeoutMs: 1_000 });
    const first = host.compile("a");
    const second = host.compile("b");
    expect(worker.posted).toEqual([{ kind: "pdf-worker:compile", jobId: "a" }]);
    worker.reply({ kind: "pdf-worker:complete", jobId: "a", ok: true });
    expect(await first).toEqual({ kind: "pdf-worker:complete", jobId: "a", ok: true });
    expect(worker.posted[1]).toEqual({ kind: "pdf-worker:compile", jobId: "b" });
    worker.reply({ kind: "pdf-worker:complete", jobId: "b", ok: true });
    expect(await second).toEqual({ kind: "pdf-worker:complete", jobId: "b", ok: true });
  });

  it("terminates a timed-out worker and uses a fresh worker for the next job", async () => {
    const workers: FakeWorker[] = [];
    let timeout: (() => void) | undefined;
    const failed: string[] = [];
    const host = new ChromeWorkerCompilerHost({
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      schedule: (fn) => { timeout = fn; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clear: () => undefined,
      failJob: async (jobId) => { failed.push(jobId); },
    });
    const first = host.compile("slow");
    timeout?.();
    expect((await first).ok).toBe(false);
    expect(workers[0]!.terminated).toBe(true);
    expect(failed).toEqual(["slow"]);
    const second = host.compile("next");
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: "pdf-worker:complete", jobId: "next", ok: true });
    expect((await second).ok).toBe(true);
  });

  it("cancels active and queued jobs without running stale work", async () => {
    const workers: FakeWorker[] = [];
    const cancelled: string[] = [];
    const host = new ChromeWorkerCompilerHost({
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      cancelJob: async (jobId) => { cancelled.push(jobId); },
    });
    const first = host.compile("active");
    const second = host.compile("queued");
    expect(await host.cancel("queued")).toBe(true);
    expect((await second).ok).toBe(false);
    expect(await host.cancel("active")).toBe(true);
    expect((await first).ok).toBe(false);
    expect(workers[0]!.terminated).toBe(true);
    expect(cancelled).toEqual(["queued", "active"]);
  });

  it("recovers with a fresh worker after a fatal job between two successful jobs", async () => {
    const workers: FakeWorker[] = [];
    const host = new ChromeWorkerCompilerHost({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });

    const first = host.compile("first");
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "first", ok: true });
    expect((await first).ok).toBe(true);

    const failed = host.compile("failed");
    workers[0]!.reply({
      kind: "pdf-worker:complete",
      jobId: "failed",
      ok: false,
      error: "compiler crashed",
      fatal: true,
    });
    expect((await failed).ok).toBe(false);
    expect(workers[0]!.terminated).toBe(true);

    const last = host.compile("last");
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: "pdf-worker:complete", jobId: "last", ok: true });
    expect((await last).ok).toBe(true);
  });

  it("detaches a terminated worker so late events cannot fail the next job", async () => {
    const workers: FakeWorker[] = [];
    const host = new ChromeWorkerCompilerHost({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      cancelJob: async () => undefined,
    });
    const cancelled = host.compile("cancelled");
    await host.cancel("cancelled");
    expect((await cancelled).ok).toBe(false);

    const next = host.compile("next");
    expect(workers[0]!.onerror).toBeNull();
    expect(workers[0]!.onmessage).toBeNull();
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "cancelled", ok: true });
    expect(host.activeCount).toBe(1);
    workers[1]!.reply({ kind: "pdf-worker:complete", jobId: "next", ok: true });
    expect((await next).ok).toBe(true);
  });
});

/**
 * The job-kind scheduling contract (spec 010 T5.3).
 *
 * All three properties exist for the same reason: `destroyWorker()` drops the
 * memoized Typst compiler in `workers/pdf-compiler.ts`, so anything that
 * terminates the worker makes the *next* compile pay a cold wasm+font init.
 * Preview churn must therefore never reach that path.
 */
describe("ChromeWorkerCompilerHost — preview/export scheduling", () => {
  it("creates exactly ONE worker across a rapid preview → preview → export sequence", async () => {
    const { host, workers } = hostWithWorkers();

    const first = host.compile("p1", { kind: "preview" });
    const second = host.compile("p2", { kind: "preview" });
    const exported = host.compile("e1", { kind: "export" });

    // p1 is in flight; finishing it must hand the slot to the export, not to
    // the newer preview.
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p1", ok: true });
    const stale = await first;
    expect(stale.ok).toBe(false);
    expect(isPreviewSupersededError(new Error((stale as { error: string }).error))).toBe(true);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "e1", ok: true });
    expect((await exported).ok).toBe(true);

    // The newest preview still runs afterwards — it is what the user asked to
    // see, and the worker is warm.
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p2", ok: true });
    expect((await second).ok).toBe(true);

    // The whole point: no cold restart anywhere in that sequence.
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(postedIds(workers[0])).toEqual(["p1", "e1", "p2"]);
  });

  it("lets an export queued behind an in-flight preview jump ahead of a queued preview", async () => {
    const { host, workers } = hostWithWorkers();

    const active = host.compile("p-active", { kind: "preview" });
    const queuedPreview = host.compile("p-queued", { kind: "preview" });
    const queuedExport = host.compile("e-queued", { kind: "export" });

    expect(postedIds(workers[0])).toEqual(["p-active"]);
    expect(host.pending.queued).toEqual(["preview", "export"]);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p-active", ok: true });
    await active;

    // The export runs next even though the preview was enqueued first.
    expect(postedIds(workers[0])).toEqual(["p-active", "e-queued"]);
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "e-queued", ok: true });
    expect((await queuedExport).ok).toBe(true);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p-queued", ok: true });
    expect((await queuedPreview).ok).toBe(true);
  });

  it("never sends a superseded queued preview to the worker", async () => {
    const { host, workers } = hostWithWorkers();

    const active = host.compile("p1", { kind: "preview" });
    const superseded = host.compile("p2", { kind: "preview" });
    const latest = host.compile("p3", { kind: "preview" });

    // p2 is dropped the moment p3 arrives — before it could ever be compiled,
    // and without leaving its caller waiting for the queue to drain.
    const stale = await superseded;
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toBe(PREVIEW_SUPERSEDED_ERROR);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p1", ok: true });
    await active;

    expect(postedIds(workers[0])).toEqual(["p1", "p3"]);
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p3", ok: true });
    expect((await latest).ok).toBe(true);
    expect(workers).toHaveLength(1);
  });

  it("reports an in-flight preview as superseded once it completes, keeping the worker", async () => {
    const { host, workers } = hostWithWorkers();

    const first = host.compile("p1", { kind: "preview" });
    const second = host.compile("p2", { kind: "preview" });

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p1", ok: true });
    const stale = await first;
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toBe(PREVIEW_SUPERSEDED_ERROR);
    expect(workers[0]!.terminated).toBe(false);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p2", ok: true });
    expect((await second).ok).toBe(true);
  });

  it("cancelling an active preview does NOT terminate the worker", async () => {
    const cancelled: string[] = [];
    const { host, workers } = hostWithWorkers({
      cancelJob: async (jobId) => { cancelled.push(jobId); },
    });

    const preview = host.compile("p1", { kind: "preview" });
    expect(await host.cancel("p1")).toBe(true);
    expect(workers[0]!.terminated).toBe(false);
    // No job-store cancellation either: the compile is still running and will
    // write its result; the caller simply discards it.
    expect(cancelled).toEqual([]);

    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p1", ok: true });
    expect((await preview).ok).toBe(false);
  });

  it("cancelling an active EXPORT still terminates the worker (user-initiated abort)", async () => {
    const cancelled: string[] = [];
    const { host, workers } = hostWithWorkers({
      cancelJob: async (jobId) => { cancelled.push(jobId); },
    });
    const exported = host.compile("e1", { kind: "export" });
    expect(await host.cancel("e1")).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    expect(cancelled).toEqual(["e1"]);
    expect((await exported).ok).toBe(false);
  });

  it("defaults an untagged compile to `export` so it is never superseded", async () => {
    const { host, workers } = hostWithWorkers();
    const untagged = host.compile("legacy");
    const preview = host.compile("p1", { kind: "preview" });
    // A later preview must not invalidate a job that never opted in.
    expect(host.pending.active).toBe("export");
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "legacy", ok: true });
    expect((await untagged).ok).toBe(true);
    expect(host.pending.active).toBe("preview");
    workers[0]!.reply({ kind: "pdf-worker:complete", jobId: "p1", ok: true });
    expect((await preview).ok).toBe(true);
  });
});

describe("ChromeWorkerCompilerHost — timeout scaling", () => {
  it("scales with source pages from the documented base", () => {
    const { host } = hostWithWorkers();
    expect(host.timeoutForPages(1)).toBe(PDF_COMPILE_BASE_TIMEOUT_MS);
    expect(host.timeoutForPages(3)).toBe(
      PDF_COMPILE_BASE_TIMEOUT_MS + 2 * PDF_COMPILE_PER_PAGE_TIMEOUT_MS
    );
    // A 200-page space export must not be killed as a hang at 60 s.
    expect(host.timeoutForPages(200)).toBeGreaterThan(4 * 60_000);
  });

  it("treats missing/absurd page counts as one page and clamps the ceiling", () => {
    const { host } = hostWithWorkers();
    expect(host.timeoutForPages(0)).toBe(PDF_COMPILE_BASE_TIMEOUT_MS);
    expect(host.timeoutForPages(Number.NaN)).toBe(PDF_COMPILE_BASE_TIMEOUT_MS);
    expect(host.timeoutForPages(10_000_000)).toBe(PDF_COMPILE_MAX_TIMEOUT_MS);
  });

  it("arms the scaled timeout for the job actually being compiled", () => {
    const delays: number[] = [];
    const { host, workers } = hostWithWorkers({
      schedule: (_fn, ms) => {
        delays.push(ms);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => undefined,
    });
    void host.compile("big", { kind: "export", pages: 41 });
    expect(delays).toEqual([PDF_COMPILE_BASE_TIMEOUT_MS + 40 * PDF_COMPILE_PER_PAGE_TIMEOUT_MS]);
    expect(workers).toHaveLength(1);
  });
});
