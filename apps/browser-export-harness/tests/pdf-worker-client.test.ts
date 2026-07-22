import { describe, expect, it } from "bun:test";
import type { PdfCompileResult, PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  HarnessPdfWorkerClient,
  type HarnessWorkerLike,
} from "../src/pdf-worker-client.js";
import type { PdfWorkerRequest, PdfWorkerResponse } from "../src/pdf-worker-protocol.js";

const RESULT: PdfCompileResult = {
  pdf: new Uint8Array([37, 80, 68, 70]),
  diagnostics: [],
  compilerVersion: "fixture",
};

function bundle(withAsset = false): PdfSourceBundle {
  return {
    main: "main",
    template: "template",
    sourceMap: [],
    notes: [],
    assets: withAsset
      ? [{ path: "asset.png", bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }]
      : [],
  };
}

class FakeWorker implements HarnessWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  messages: PdfWorkerRequest[] = [];

  constructor(private readonly automatic = true) {}

  postMessage(message: PdfWorkerRequest): void {
    this.messages.push(message);
    if (this.automatic) queueMicrotask(() => this.respond(message.requestId));
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(requestId: number): void {
    const response: PdfWorkerResponse = { kind: "result", requestId, ok: true, result: RESULT };
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

describe("HarnessPdfWorkerClient", () => {
  it("reuses one warm Worker for sequential compilations", async () => {
    const workers: FakeWorker[] = [];
    const client = new HarnessPdfWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    expect((await client.compile(bundle())).compilerVersion).toBe("fixture");
    expect((await client.compile(bundle())).compilerVersion).toBe("fixture");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.messages).toHaveLength(2);
  });

  it("copies transferable asset views instead of neutering caller input", async () => {
    const worker = new FakeWorker();
    const client = new HarnessPdfWorkerClient(() => worker);
    const input = bundle(true);
    const originalBuffer = input.assets[0]!.bytes.buffer;
    await client.compile(input);
    expect(input.assets[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(worker.messages[0]!.bundle.assets[0]!.bytes.buffer).not.toBe(originalBuffer);
  });

  it("terminates a successfully warmed Worker when disposed", async () => {
    const worker = new FakeWorker();
    const client = new HarnessPdfWorkerClient(() => worker);

    await client.compile(bundle());
    expect(worker.terminated).toBe(false);

    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("terminates an active Worker on abort and recreates it for the next request", async () => {
    const workers: FakeWorker[] = [];
    const client = new HarnessPdfWorkerClient(() => {
      const worker = new FakeWorker(workers.length > 0);
      workers.push(worker);
      return worker;
    });
    const controller = new AbortController();
    const pending = client.compile(bundle(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
    await client.compile(bundle());
    expect(workers).toHaveLength(2);
  });

  it("removes an aborted queued request without emitting a Worker message", async () => {
    const worker = new FakeWorker(false);
    const client = new HarnessPdfWorkerClient(() => worker);
    const first = client.compile(bundle());
    const controller = new AbortController();
    const queued = client.compile(bundle(), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages).toHaveLength(1);
    worker.respond(worker.messages[0]!.requestId);
    await first;
  });
});
