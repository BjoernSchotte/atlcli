import { cancelPdfJob, failPdfJob } from "./job-store.js";
import {
  isPdfWorkerResponse,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from "./worker-protocol.js";

export interface PdfWorkerLike {
  postMessage(message: PdfWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ChromeWorkerCompilerHostOptions {
  createWorker: () => PdfWorkerLike;
  timeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (id: ReturnType<typeof setTimeout>) => void;
  failJob?: (jobId: string, error: string) => Promise<unknown>;
  cancelJob?: (jobId: string) => Promise<unknown>;
}

interface QueueItem {
  jobId: string;
  resolve: (value: PdfWorkerResponse) => void;
}

/**
 * Single-worker FIFO with hard timeout and cancellation — the **Chrome
 * offscreen-document adapter**, not an abstract compiler contract.
 *
 * Renamed from `PdfCompilerHost` in spec 010 Phase 0 to settle a name
 * collision: `forge-export-app/SPIKE.md` uses `PdfCompilerHost` for the
 * abstract `compile(bundle, signal)` seam, while this class is one host's
 * implementation of a job queue around a dedicated `Worker`. Two different
 * things at two different layers must not share a name. The generic name is
 * left free for the seam; the abstract contract this class ultimately serves is
 * already `PdfCompilePort` (`@atlcli/pdf`).
 */
export class ChromeWorkerCompilerHost {
  private readonly queue: QueueItem[] = [];
  private worker: PdfWorkerLike | null = null;
  private active: QueueItem | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly schedule: NonNullable<ChromeWorkerCompilerHostOptions["schedule"]>;
  private readonly clear: NonNullable<ChromeWorkerCompilerHostOptions["clear"]>;

  constructor(private readonly options: ChromeWorkerCompilerHostOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clear = options.clear ?? ((id) => clearTimeout(id));
  }

  compile(jobId: string): Promise<PdfWorkerResponse> {
    return new Promise((resolve) => {
      this.queue.push({ jobId, resolve });
      this.pump();
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    const queued = this.queue.findIndex((item) => item.jobId === jobId);
    if (queued >= 0) {
      const [item] = this.queue.splice(queued, 1);
      await (this.options.cancelJob ?? cancelPdfJob)(jobId).catch(() => undefined);
      item.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error: "PDF export was cancelled.", fatal: false });
      return true;
    }
    if (this.active?.jobId !== jobId) return false;
    const item = this.active;
    await (this.options.cancelJob ?? cancelPdfJob)(jobId).catch(() => undefined);
    this.destroyWorker();
    this.active = null;
    item.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error: "PDF export was cancelled.", fatal: false });
    this.pump();
    return true;
  }

  get activeCount(): number {
    return this.active ? 1 : 0;
  }

  private getWorker(): PdfWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.handleFatal(event.message || "PDF compiler worker failed.");
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.active = item;
    const worker = this.getWorker();
    this.timer = this.schedule(() => this.handleTimeout(item.jobId), this.timeoutMs);
    worker.postMessage({ kind: "pdf-worker:compile", jobId: item.jobId });
  }

  private handleMessage(value: unknown): void {
    if (!isPdfWorkerResponse(value) || !this.active || value.jobId !== this.active.jobId) return;
    const item = this.active;
    this.clearTimer();
    this.active = null;
    if (!value.ok && value.fatal) this.destroyWorker();
    item.resolve(value);
    this.pump();
  }

  private handleTimeout(jobId: string): void {
    if (!this.active || this.active.jobId !== jobId) return;
    const item = this.active;
    this.active = null;
    this.destroyWorker();
    const error = `PDF compilation timed out after ${this.timeoutMs} ms.`;
    void (this.options.failJob ?? failPdfJob)(jobId, error).catch(() => undefined);
    item.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error, fatal: true });
    this.pump();
  }

  private handleFatal(error: string): void {
    if (!this.active) return;
    const item = this.active;
    this.active = null;
    this.destroyWorker();
    void (this.options.failJob ?? failPdfJob)(item.jobId, error).catch(() => undefined);
    item.resolve({ kind: "pdf-worker:complete", jobId: item.jobId, ok: false, error, fatal: true });
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
  }

  private destroyWorker(): void {
    this.clearTimer();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = null;
  }
}
