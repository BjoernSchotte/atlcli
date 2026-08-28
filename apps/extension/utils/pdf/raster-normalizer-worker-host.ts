import {
  planRasterNormalizationV1,
  type RasterNormalizerPortV1,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "@atlcli/export-media";
import type {
  PdfRasterNormalizerLeaseFactoryV1,
  PdfRasterNormalizerLeaseV1,
} from "@atlcli/export-wiring/jobs";
import {
  parseRasterNormalizerWorkerResponseV1,
  PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
  PURE_TS_RASTER_NORMALIZER_REVISION_V1,
  RASTER_NORMALIZER_WORKER_SCHEMA_V1,
  type RasterNormalizerWorkerRequestV1,
} from "./raster-normalizer-protocol.js";

export interface RasterNormalizerWorkerLikeV1 {
  postMessage(message: RasterNormalizerWorkerRequestV1, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface PureTsRasterNormalizerReceiptV1 {
  schema: "atlcli.extension-raster-normalizer-receipt/1";
  backend: typeof PURE_TS_RASTER_NORMALIZER_BACKEND_V1;
  revision: typeof PURE_TS_RASTER_NORMALIZER_REVISION_V1;
  jobId: string;
  leaseEpoch: number;
  workerStarted: boolean;
  requests: number;
  normalized: number;
  kept: number;
  heartbeatSamples: number;
  heartbeatP95Ms: number | null;
  heartbeatMaxMs: number | null;
  outcome: "released" | "aborted" | "worker-error" | "timeout";
}

export interface PureTsRasterNormalizerLeaseFactoryOptionsV1 {
  createWorker(): RasterNormalizerWorkerLikeV1;
  operationTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  scheduleTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
  scheduleHeartbeat?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearHeartbeat?: (id: ReturnType<typeof setInterval>) => void;
  onReceipt?: (receipt: PureTsRasterNormalizerReceiptV1) => void;
}

interface ResolvedPureTsRasterNormalizerOptionsV1 {
  createWorker(): RasterNormalizerWorkerLikeV1;
  operationTimeoutMs: number;
  heartbeatIntervalMs: number;
  now(): number;
  scheduleTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  scheduleHeartbeat(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearHeartbeat(id: ReturnType<typeof setInterval>): void;
  onReceipt?: (receipt: PureTsRasterNormalizerReceiptV1) => void;
}

interface ActiveRequest {
  id: number;
  resolve: (value: RasterNormalizeResultV1) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10;
const MAX_HEARTBEAT_SAMPLES = 8_192;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Raster normalization was cancelled.", "AbortError");
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function boundedError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return new Error((message.trim() || fallback).slice(0, 512));
}

class DisposablePureTsRasterNormalizerV1 implements RasterNormalizerPortV1 {
  readonly #jobId: string;
  readonly #leaseEpoch: number;
  readonly #signal: AbortSignal;
  readonly #options: ResolvedPureTsRasterNormalizerOptionsV1;

  #worker: RasterNormalizerWorkerLikeV1 | undefined;
  #ready: Promise<void> | undefined;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: unknown) => void) | undefined;
  #active: ActiveRequest | undefined;
  #operationTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #heartbeatExpectedAt = 0;
  #heartbeatSamples: number[] = [];
  #tail: Promise<void> = Promise.resolve();
  #pendingRejects = new Set<(error: unknown) => void>();
  #nextId = 0;
  #workerStarted = false;
  #requests = 0;
  #normalized = 0;
  #kept = 0;
  #closed = false;
  #released = false;
  #outcome: PureTsRasterNormalizerReceiptV1["outcome"] = "released";

  readonly #abort = (): void => {
    if (this.#closed) return;
    this.#outcome = "aborted";
    this.#close(abortReason(this.#signal));
  };

  constructor(input: {
    jobId: string;
    leaseEpoch: number;
    signal: AbortSignal;
    options: ResolvedPureTsRasterNormalizerOptionsV1;
  }) {
    this.#jobId = input.jobId;
    this.#leaseEpoch = input.leaseEpoch;
    this.#signal = input.signal;
    this.#options = input.options;
    this.#signal.addEventListener("abort", this.#abort, { once: true });
  }

  normalize(request: RasterNormalizeRequestV1): Promise<RasterNormalizeResultV1> {
    this.#throwIfUnavailable();
    const planned = planRasterNormalizationV1(request);
    this.#requests += 1;
    if (planned.kind === "kept") {
      this.#kept += 1;
      return Promise.resolve(planned);
    }

    const result = new Promise<RasterNormalizeResultV1>((resolve, reject) => {
      this.#pendingRejects.add(reject);
      const run = this.#tail.then(() => this.#run(request));
      this.#tail = run.then(
        () => undefined,
        () => undefined,
      );
      run.then(resolve, reject).finally(() => this.#pendingRejects.delete(reject));
    });
    return result;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#signal.removeEventListener("abort", this.#abort);
    if (!this.#closed) this.#close(new Error("Raster normalizer lease was released."));
    const heartbeatP95Ms = percentile95(this.#heartbeatSamples);
    const receipt: PureTsRasterNormalizerReceiptV1 = Object.freeze({
      schema: "atlcli.extension-raster-normalizer-receipt/1",
      backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
      revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
      jobId: this.#jobId,
      leaseEpoch: this.#leaseEpoch,
      workerStarted: this.#workerStarted,
      requests: this.#requests,
      normalized: this.#normalized,
      kept: this.#kept,
      heartbeatSamples: this.#heartbeatSamples.length,
      heartbeatP95Ms,
      heartbeatMaxMs: this.#heartbeatSamples.length > 0
        ? Math.max(...this.#heartbeatSamples)
        : null,
      outcome: this.#outcome,
    });
    try {
      this.#options.onReceipt?.(receipt);
    } catch {
      // Diagnostics are body-free and best-effort; they cannot break export cleanup.
    }
    await Promise.resolve();
  }

  async #run(request: RasterNormalizeRequestV1): Promise<RasterNormalizeResultV1> {
    this.#throwIfUnavailable();
    await this.#ensureReady();
    this.#throwIfUnavailable();
    const worker = this.#worker;
    if (!worker) throw new Error("Raster normalizer worker is unavailable.");
    const id = ++this.#nextId;
    const bytes = request.bytes.slice();
    const response = new Promise<RasterNormalizeResultV1>((resolve, reject) => {
      this.#active = { id, resolve, reject };
      this.#startHeartbeat();
      this.#armTimeout(`Raster normalization ${id}`);
    });
    try {
      worker.postMessage(
        {
          schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
          kind: "normalize",
          id,
          request: { ...request, bytes },
        },
        [bytes.buffer],
      );
    } catch (error) {
      this.#fatal(error, "Raster normalizer worker request failed.");
    }
    return response;
  }

  #ensureReady(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#throwIfUnavailable();
    let worker: RasterNormalizerWorkerLikeV1;
    try {
      worker = this.#options.createWorker();
    } catch (error) {
      this.#fatal(error, "Raster normalizer worker could not be created.");
      return Promise.reject(boundedError(error, "Raster normalizer worker could not be created."));
    }
    this.#worker = worker;
    this.#workerStarted = true;
    worker.onmessage = (event) => this.#handleMessage(event.data);
    worker.onerror = (event) => {
      this.#fatal(event.message, "Raster normalizer worker failed.");
    };
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#armTimeout("Raster normalizer worker initialization");
    try {
      worker.postMessage({
        schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
        kind: "init",
        backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
        revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
      });
    } catch (error) {
      this.#fatal(error, "Raster normalizer worker initialization failed.");
    }
    return this.#ready;
  }

  #handleMessage(value: unknown): void {
    let response: ReturnType<typeof parseRasterNormalizerWorkerResponseV1>;
    try {
      response = parseRasterNormalizerWorkerResponseV1(value);
    } catch (error) {
      this.#fatal(error, "Raster normalizer worker returned an invalid response.");
      return;
    }

    if (response.kind === "ready") {
      if (!this.#readyResolve || this.#active) {
        this.#fatal("Unexpected ready response.", "Raster normalizer worker protocol failed.");
        return;
      }
      this.#clearOperationTimer();
      const resolve = this.#readyResolve;
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
      resolve();
      return;
    }

    const active = this.#active;
    if (!active || response.id !== active.id) {
      this.#fatal("Stale, duplicate, or unknown response ID.", "Raster normalizer worker protocol failed.");
      return;
    }
    this.#active = undefined;
    this.#clearOperationTimer();
    this.#stopHeartbeat();

    if (response.kind === "result") {
      if (response.result.kind === "normalized") this.#normalized += 1;
      else this.#kept += 1;
      active.resolve(response.result);
      return;
    }

    const error = response.code === "cancelled"
      ? new DOMException(response.message, "AbortError")
      : new Error(response.message);
    active.reject(error);
    if (response.fatal) this.#fatal(error, "Raster normalizer worker failed.");
  }

  #armTimeout(label: string): void {
    this.#clearOperationTimer();
    this.#operationTimer = this.#options.scheduleTimeout(() => {
      this.#outcome = "timeout";
      this.#fatal(
        `${label} timed out after ${this.#options.operationTimeoutMs} ms.`,
        "Raster normalizer worker timed out.",
      );
    }, this.#options.operationTimeoutMs);
  }

  #clearOperationTimer(): void {
    if (this.#operationTimer !== undefined) {
      this.#options.clearTimeout(this.#operationTimer);
      this.#operationTimer = undefined;
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatExpectedAt = this.#options.now() + this.#options.heartbeatIntervalMs;
    this.#heartbeatTimer = this.#options.scheduleHeartbeat(() => {
      const observedAt = this.#options.now();
      const delay = Math.max(0, observedAt - this.#heartbeatExpectedAt);
      if (this.#heartbeatSamples.length >= MAX_HEARTBEAT_SAMPLES) {
        this.#heartbeatSamples.shift();
      }
      this.#heartbeatSamples.push(delay);
      this.#heartbeatExpectedAt = observedAt + this.#options.heartbeatIntervalMs;
    }, this.#options.heartbeatIntervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      this.#options.clearHeartbeat(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #fatal(error: unknown, fallback: string): void {
    if (this.#outcome === "released") this.#outcome = "worker-error";
    this.#close(boundedError(error, fallback));
  }

  #close(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearOperationTimer();
    this.#stopHeartbeat();
    const worker = this.#worker;
    if (worker) {
      if (this.#active) {
        try {
          worker.postMessage({
            schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
            kind: "cancel",
            id: this.#active.id,
          });
        } catch {
          // Termination below is the actual synchronous cancellation boundary.
        }
      }
      try {
        worker.postMessage({
          schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
          kind: "shutdown",
        });
      } catch {
        // A failed worker may already reject messages; termination still follows.
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      this.#worker = undefined;
    }
    this.#readyReject?.(error);
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    this.#active?.reject(error);
    this.#active = undefined;
    for (const reject of this.#pendingRejects) reject(error);
    this.#pendingRejects.clear();
  }

  #throwIfUnavailable(): void {
    if (this.#signal.aborted) throw abortReason(this.#signal);
    if (this.#closed) throw new Error("Raster normalizer lease is closed.");
  }
}

export function createPureTsRasterNormalizerLeaseFactoryV1(
  input: PureTsRasterNormalizerLeaseFactoryOptionsV1,
): PdfRasterNormalizerLeaseFactoryV1 {
  const operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000) {
    throw new RangeError("Raster normalizer operation timeout must be at least 1000 ms.");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RangeError("Raster normalizer heartbeat interval must be a positive integer.");
  }
  const options: ResolvedPureTsRasterNormalizerOptionsV1 = {
    createWorker: input.createWorker,
    operationTimeoutMs,
    heartbeatIntervalMs,
    now: input.now ?? (() => performance.now()),
    scheduleTimeout: input.scheduleTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: input.clearTimeout ?? ((id) => clearTimeout(id)),
    scheduleHeartbeat: input.scheduleHeartbeat ?? ((fn, ms) => setInterval(fn, ms)),
    clearHeartbeat: input.clearHeartbeat ?? ((id) => clearInterval(id)),
    ...(input.onReceipt ? { onReceipt: input.onReceipt } : {}),
  };
  return {
    async acquire({ jobId, leaseEpoch, signal }): Promise<PdfRasterNormalizerLeaseV1> {
      if (signal.aborted) throw abortReason(signal);
      const normalizer = new DisposablePureTsRasterNormalizerV1({
        jobId,
        leaseEpoch,
        signal,
        options,
      });
      return {
        rasterNormalizer: normalizer,
        evidence: {
          schema: "atlcli.pdf-raster-normalizer-evidence/1",
          backend: PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
          revision: PURE_TS_RASTER_NORMALIZER_REVISION_V1,
        },
        release: () => normalizer.release(),
      };
    },
  };
}
