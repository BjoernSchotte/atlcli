import { describe, expect, it } from "bun:test";
import { ChromeWorkerCompilerHost, type PdfWorkerLike } from "../../utils/pdf/compiler-host.js";
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
    expect(workers[0].terminated).toBe(true);
    expect(failed).toEqual(["slow"]);
    const second = host.compile("next");
    expect(workers).toHaveLength(2);
    workers[1].reply({ kind: "pdf-worker:complete", jobId: "next", ok: true });
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
    expect(workers[0].terminated).toBe(true);
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
