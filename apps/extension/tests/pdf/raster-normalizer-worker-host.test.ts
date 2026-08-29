import { describe, expect, it } from "bun:test";
import {
  encodePng,
  normalizeRasterAssetV1,
  type RasterNormalizeRequestV1,
} from "@atlcli/export-media";
import {
  PdfRasterNormalizerRetryableErrorV1,
  type PdfRasterNormalizerLeaseFactoryV1,
} from "@atlcli/export-wiring/jobs";
import {
  createImageBitmapRasterNormalizerLeaseFactoryV1,
  createPureTsRasterNormalizerLeaseFactoryV1,
  type ImageBitmapRasterNormalizerReceiptV1,
  type PureTsRasterNormalizerReceiptV1,
  type RasterNormalizerWorkerLikeV1,
} from "../../utils/pdf/raster-normalizer-worker-host.js";
import {
  IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
  IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
  PURE_TS_RASTER_NORMALIZER_BACKEND_V1,
  PURE_TS_RASTER_NORMALIZER_REVISION_V1,
  RASTER_NORMALIZER_WORKER_SCHEMA_V1,
  type RasterNormalizerWorkerRequestV1,
  type RasterNormalizerWorkerResponseV1,
} from "../../utils/pdf/raster-normalizer-protocol.js";

function rasterRequest(size = 32): RasterNormalizeRequestV1 {
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < pixels.byteLength; index += 4) {
    pixels[index] = (index / 4) % 251;
    pixels[index + 1] = 90;
    pixels[index + 2] = 180;
    pixels[index + 3] = 0xff;
  }
  return {
    bytes: encodePng(pixels, size, size, false),
    mediaType: "image/png",
    renderEnvelopeWidthPt: 6,
    ppi: 96,
  };
}

class FakeRasterWorker implements RasterNormalizerWorkerLikeV1 {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<{
    message: RasterNormalizerWorkerRequestV1;
    transfer: Transferable[];
  }> = [];
  terminated = false;
  autoNormalize = false;
  initError: "capability-unavailable" | undefined;
  normalizeError: "native-path-failed" | undefined;

  postMessage(message: RasterNormalizerWorkerRequestV1, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (message.kind === "init") {
      if (this.initError) {
        this.emit({
          schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
          kind: "error",
          code: this.initError,
          message: "synthetic capability failure",
          fatal: true,
        });
        return;
      }
      this.emit({
        schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
        kind: "ready",
        backend: message.backend,
        revision: message.revision,
      });
      return;
    }
    if (message.kind === "normalize" && this.normalizeError) {
      this.emit({
        schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
        kind: "error",
        id: message.id,
        code: this.normalizeError,
        message: "synthetic native failure",
        fatal: true,
      });
      return;
    }
    if (message.kind === "normalize" && this.autoNormalize) {
      this.respond(message.id, normalizeRasterAssetV1(message.request));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: value } as MessageEvent<unknown>);
  }

  respond(id: number, result = normalizeRasterAssetV1(rasterRequest())): void {
    this.emit({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id,
      result,
    } satisfies RasterNormalizerWorkerResponseV1);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function acquire(
  factory: PdfRasterNormalizerLeaseFactoryV1,
  signal = new AbortController().signal,
) {
  return factory.acquire({
    jobId: "job-neutral",
    leaseEpoch: 2,
    request: {} as never,
    signal,
  });
}

describe("disposable productive pure-TS raster worker host", () => {
  it("returns header-only kept assets without constructing a worker", async () => {
    let workers = 0;
    const receipts: PureTsRasterNormalizerReceiptV1[] = [];
    const factory = createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker() {
        workers += 1;
        return new FakeRasterWorker();
      },
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const lease = await acquire(factory);
    const request = rasterRequest(1);

    await expect(lease.rasterNormalizer.normalize(request)).resolves.toEqual({
      kind: "kept",
      reason: "no-downscale",
    });
    await lease.release();

    expect(workers).toBe(0);
    expect(receipts).toEqual([expect.objectContaining({
      workerStarted: false,
      requests: 1,
      kept: 1,
      normalized: 0,
    })]);
  });

  it("matches the in-process pure output exactly and transfers only a source copy", async () => {
    const worker = new FakeRasterWorker();
    worker.autoNormalize = true;
    const factory = createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
    });
    const lease = await acquire(factory);
    const request = rasterRequest();
    const sourceBefore = request.bytes.slice();
    const expected = normalizeRasterAssetV1(request);

    const result = await lease.rasterNormalizer.normalize(request);

    expect(result).toEqual(expected);
    expect(request.bytes).toEqual(sourceBefore);
    const normalize = worker.posted.find((entry) => entry.message.kind === "normalize");
    expect(normalize?.transfer).toHaveLength(1);
    expect(normalize?.transfer[0]).not.toBe(request.bytes.buffer);
    await lease.release();
    expect(worker.terminated).toBe(true);
  });

  it("memoizes only an explicitly immutable exact source view and target", async () => {
    const worker = new FakeRasterWorker();
    worker.autoNormalize = true;
    const receipts: PureTsRasterNormalizerReceiptV1[] = [];
    const lease = await acquire(createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
      memoizeImmutableSourceViews: true,
      onReceipt: (receipt) => receipts.push(receipt),
    }));
    const request = rasterRequest();

    const [first, second] = await Promise.all([
      lease.rasterNormalizer.normalize(request),
      lease.rasterNormalizer.normalize(request),
    ]);

    expect(first).toEqual(normalizeRasterAssetV1(request));
    expect(second).toBe(first);
    expect(worker.posted.filter(({ message }) => message.kind === "normalize")).toHaveLength(1);
    await lease.release();
    expect(receipts).toEqual([expect.objectContaining({
      requests: 2,
      normalized: 2,
      kept: 0,
      cacheHits: 1,
    })]);
  });

  it("serializes concurrent calls through one worker queue", async () => {
    const worker = new FakeRasterWorker();
    const lease = await acquire(createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
    }));
    const first = lease.rasterNormalizer.normalize(rasterRequest(32));
    const second = lease.rasterNormalizer.normalize(rasterRequest(40));
    await flush();

    const normalizeMessages = () => worker.posted.filter(
      (entry): entry is typeof entry & {
        message: Extract<RasterNormalizerWorkerRequestV1, { kind: "normalize" }>;
      } => entry.message.kind === "normalize",
    );
    expect(normalizeMessages()).toHaveLength(1);
    worker.respond(1, normalizeRasterAssetV1(rasterRequest(32)));
    await first;
    await flush();
    expect(normalizeMessages()).toHaveLength(2);
    expect(normalizeMessages().map(({ message }) => message.id)).toEqual([1, 2]);
    worker.respond(2, normalizeRasterAssetV1(rasterRequest(40)));
    await second;
    await lease.release();
  });

  it("fails closed on a malformed or stale response and settles every pending call", async () => {
    const worker = new FakeRasterWorker();
    const lease = await acquire(createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
    }));
    const first = lease.rasterNormalizer.normalize(rasterRequest());
    const second = lease.rasterNormalizer.normalize(rasterRequest(40));
    await flush();
    worker.emit({
      schema: RASTER_NORMALIZER_WORKER_SCHEMA_V1,
      kind: "result",
      id: 99,
      result: { kind: "kept", reason: "no-downscale" },
    });

    await expect(first).rejects.toThrow(/stale|duplicate|unknown/i);
    await expect(second).rejects.toThrow(/stale|duplicate|unknown|closed/i);
    expect(worker.terminated).toBe(true);
    await lease.release();
    await lease.release();
  });

  it("cancels an in-flight call by terminating the worker and preserves source bytes", async () => {
    const worker = new FakeRasterWorker();
    const controller = new AbortController();
    const receipts: PureTsRasterNormalizerReceiptV1[] = [];
    const lease = await acquire(createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
      onReceipt: (receipt) => receipts.push(receipt),
    }), controller.signal);
    const request = rasterRequest();
    const sourceBefore = request.bytes.slice();
    const pending = lease.rasterNormalizer.normalize(request);
    await flush();
    controller.abort(new DOMException("synthetic cancellation", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.bytes).toEqual(sourceBefore);
    expect(worker.posted.map(({ message }) => message.kind)).toContain("cancel");
    expect(worker.posted.map(({ message }) => message.kind)).toContain("shutdown");
    expect(worker.terminated).toBe(true);
    await lease.release();
    expect(receipts).toEqual([expect.objectContaining({ outcome: "aborted" })]);
  });

  it("records productive host heartbeat delay while the worker owns normalization", async () => {
    const worker = new FakeRasterWorker();
    const receipts: PureTsRasterNormalizerReceiptV1[] = [];
    let heartbeat: (() => void) | undefined;
    let now = 0;
    const lease = await acquire(createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
      heartbeatIntervalMs: 10,
      now: () => now,
      scheduleHeartbeat(fn) {
        heartbeat = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearHeartbeat() {},
      onReceipt: (receipt) => receipts.push(receipt),
    }));
    const pending = lease.rasterNormalizer.normalize(rasterRequest());
    await flush();
    now = 20;
    heartbeat?.();
    now = 31;
    heartbeat?.();
    worker.respond(1, normalizeRasterAssetV1(rasterRequest()));
    await pending;
    await lease.release();

    expect(receipts).toEqual([expect.objectContaining({
      heartbeatSamples: 2,
      heartbeatP95Ms: 10,
      heartbeatMaxMs: 10,
      outcome: "released",
    })]);
  });

  it("times out fatally, then lets a new attempt acquire a fresh worker", async () => {
    const workers: FakeRasterWorker[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const receipts: PureTsRasterNormalizerReceiptV1[] = [];
    const factory = createPureTsRasterNormalizerLeaseFactoryV1({
      createWorker() {
        const worker = new FakeRasterWorker();
        workers.push(worker);
        return worker;
      },
      operationTimeoutMs: 1_000,
      scheduleTimeout(fn) {
        timeoutCallbacks.push(fn);
        return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout() {},
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const firstLease = await acquire(factory);
    const failed = firstLease.rasterNormalizer.normalize(rasterRequest());
    await flush();
    timeoutCallbacks.at(-1)?.();
    await expect(failed).rejects.toThrow("timed out");
    await firstLease.release();

    const secondLease = await acquire(factory);
    const recovered = secondLease.rasterNormalizer.normalize(rasterRequest());
    await flush();
    workers[1]!.respond(1, normalizeRasterAssetV1(rasterRequest()));
    await expect(recovered).resolves.toEqual(normalizeRasterAssetV1(rasterRequest()));
    await secondLease.release();

    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect(receipts.map(({ outcome }) => outcome)).toEqual(["timeout", "released"]);
  });
});

describe("disposable productive ImageBitmap raster worker host", () => {
  it("keeps an ineligible raster without constructing a worker", async () => {
    let workers = 0;
    const receipts: ImageBitmapRasterNormalizerReceiptV1[] = [];
    const lease = await acquire(createImageBitmapRasterNormalizerLeaseFactoryV1({
      createWorker() {
        workers += 1;
        return new FakeRasterWorker();
      },
      onReceipt: (receipt) => receipts.push(receipt),
    }));
    const request = rasterRequest();
    request.bytes = request.bytes.slice();
    request.bytes[24] = 16;

    await expect(lease.rasterNormalizer.normalize(request)).resolves.toEqual({
      kind: "kept",
      reason: "unsupported-raster-shape",
    });
    await lease.release();

    expect(workers).toBe(0);
    expect(receipts).toEqual([expect.objectContaining({
      backend: IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
      revision: IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
      workerStarted: false,
      kept: 1,
    })]);
  });

  it("surfaces capability probe failure as a body-free retry marker", async () => {
    const worker = new FakeRasterWorker();
    worker.initError = "capability-unavailable";
    const request = rasterRequest();
    const sourceBefore = request.bytes.slice();
    const lease = await acquire(createImageBitmapRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
    }));

    const failed = lease.rasterNormalizer.normalize(request);
    await expect(failed).rejects.toBeInstanceOf(PdfRasterNormalizerRetryableErrorV1);
    await expect(failed).rejects.toMatchObject({
      backend: "image-bitmap",
      code: "capability-unavailable",
    });
    expect(request.bytes).toEqual(sourceBefore);
    expect(worker.terminated).toBe(true);
    await lease.release();
  });

  it("surfaces a native operation failure without detaching caller bytes", async () => {
    const worker = new FakeRasterWorker();
    worker.normalizeError = "native-path-failed";
    const request = rasterRequest();
    const sourceBefore = request.bytes.slice();
    const lease = await acquire(createImageBitmapRasterNormalizerLeaseFactoryV1({
      createWorker: () => worker,
    }));

    const failed = lease.rasterNormalizer.normalize(request);
    await expect(failed).rejects.toMatchObject({
      name: "PdfRasterNormalizerRetryableErrorV1",
      backend: "image-bitmap",
      code: "native-path-failed",
    });
    expect(request.bytes).toEqual(sourceBefore);
    const init = worker.posted.find(({ message }) => message.kind === "init");
    expect(init?.message).toMatchObject({
      backend: IMAGE_BITMAP_RASTER_NORMALIZER_BACKEND_V1,
      revision: IMAGE_BITMAP_RASTER_NORMALIZER_REVISION_V1,
    });
    await lease.release();
  });
});
