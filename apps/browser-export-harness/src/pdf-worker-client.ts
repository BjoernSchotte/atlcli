import type {
  PdfCompileContext,
  PdfCompilePort,
  PdfCompileResult,
  PdfSourceBundle,
} from "@atlcli/pdf/browser";
import {
  isPdfWorkerResponse,
  type PdfWorkerRequest,
} from "./pdf-worker-protocol.js";

export interface HarnessWorkerLike {
  postMessage(message: PdfWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

interface QueueItem {
  requestId: number;
  bundle: PdfSourceBundle;
  signal?: AbortSignal;
  resolve: (result: PdfCompileResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

function abortError(): Error {
  const error = new Error("PDF compilation was cancelled.");
  error.name = "AbortError";
  return error;
}

function copiedBundle(bundle: PdfSourceBundle): {
  bundle: PdfSourceBundle;
  transfer: Transferable[];
} {
  const transfer: Transferable[] = [];
  const assets = bundle.assets.map((asset) => {
    const bytes = new Uint8Array(asset.bytes.byteLength);
    bytes.set(asset.bytes);
    transfer.push(bytes.buffer);
    return { ...asset, bytes };
  });
  return {
    bundle: {
      ...bundle,
      assets,
      sourceMap: bundle.sourceMap.map((entry) => ({ ...entry })),
      notes: bundle.notes.map((note) => ({ ...note })),
    },
    transfer,
  };
}

/** Direct, in-memory module-Worker compile port; no IndexedDB or host messages. */
export class HarnessPdfWorkerClient implements PdfCompilePort {
  private readonly queue: QueueItem[] = [];
  private worker: HarnessWorkerLike | null = null;
  private active: QueueItem | null = null;
  private nextRequestId = 1;
  private createdWorkers = 0;

  constructor(
    private readonly createWorker: () => HarnessWorkerLike = () =>
      new Worker(new URL("./pdf-worker.ts", import.meta.url), {
        type: "module",
        name: "atlcli-browser-harness-pdf",
      }),
  ) {}

  get workerGeneration(): number {
    return this.createdWorkers;
  }

  compile(bundle: PdfSourceBundle, context: PdfCompileContext = {}): Promise<PdfCompileResult> {
    if (context.signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        requestId: this.nextRequestId++,
        bundle,
        signal: context.signal,
        resolve,
        reject,
        abort: () => this.abortItem(item),
      };
      context.signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
      this.pump();
    });
  }

  dispose(): void {
    this.destroyWorker();
    const error = abortError();
    this.finish(this.active, error);
    this.active = null;
    for (const item of this.queue.splice(0)) this.finish(item, error);
  }

  private getWorker(): HarnessWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.createdWorkers += 1;
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.handleWorkerError(event.message || "PDF Worker failed.");
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    if (item.signal?.aborted) {
      this.finish(item, abortError());
      this.pump();
      return;
    }
    this.active = item;
    const payload = copiedBundle(item.bundle);
    this.getWorker().postMessage(
      { kind: "compile", requestId: item.requestId, bundle: payload.bundle },
      payload.transfer,
    );
  }

  private handleMessage(value: unknown): void {
    if (!isPdfWorkerResponse(value) || value.requestId !== this.active?.requestId) return;
    const item = this.active;
    this.active = null;
    if (value.ok) this.finish(item, undefined, value.result);
    else this.finish(item, new Error(value.error));
    this.pump();
  }

  private handleWorkerError(message: string): void {
    const item = this.active;
    this.active = null;
    this.destroyWorker();
    this.finish(item, new Error(message));
    this.pump();
  }

  private abortItem(item: QueueItem): void {
    if (this.active === item) {
      this.active = null;
      this.destroyWorker();
      this.finish(item, abortError());
      this.pump();
      return;
    }
    const index = this.queue.indexOf(item);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.finish(item, abortError());
    }
  }

  private finish(item: QueueItem | null, error?: unknown, result?: PdfCompileResult): void {
    if (!item) return;
    item.signal?.removeEventListener("abort", item.abort);
    if (error !== undefined) item.reject(error);
    else item.resolve(result!);
  }

  private destroyWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }
}
