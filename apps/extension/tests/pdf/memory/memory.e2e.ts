import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryWorkerPhase } from "./protocol.js";

const OUTPUT_DIR = fileURLToPath(
  new URL("../../../.output/chrome-memory-mv3", import.meta.url)
);
const MIB = 1024 * 1024;

interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize: number;
  backingStorageSize: number;
}

interface HeapDelta {
  usedMiB: number;
  embedderMiB: number;
  backingMiB: number;
}

interface NetworkProbeRequest {
  url: string;
  range: string | null;
  status: number | null;
  contentRange: string | null;
  encodedBytes: number | null;
}

function mib(bytes: number): number {
  return Number((bytes / MIB).toFixed(2));
}

function delta(before: HeapUsage, after: HeapUsage): HeapDelta {
  return {
    usedMiB: mib(after.usedSize - before.usedSize),
    embedderMiB: mib(after.embedderHeapUsedSize - before.embedderHeapUsedSize),
    backingMiB: mib(after.backingStorageSize - before.backingStorageSize),
  };
}

function absolute(sample: HeapUsage): HeapDelta {
  return {
    usedMiB: mib(sample.usedSize),
    embedderMiB: mib(sample.embedderHeapUsedSize),
    backingMiB: mib(sample.backingStorageSize),
  };
}

async function pageHeap(session: CDPSession): Promise<HeapUsage> {
  await session.send("HeapProfiler.collectGarbage");
  return session.send("Runtime.getHeapUsage") as Promise<HeapUsage>;
}

class ChildTargetSession {
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  constructor(
    private readonly root: CDPSession,
    readonly sessionId: string,
    private readonly onEvent?: (method: string, params: Record<string, unknown>) => void
  ) {
    root.on("Target.receivedMessageFromTarget", this.onMessage);
  }

  private readonly onMessage = (event: { sessionId: string; message: string }): void => {
    if (event.sessionId !== this.sessionId) return;
    const message = JSON.parse(event.message) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.method) {
      this.onEvent?.(message.method, message.params ?? {});
      return;
    }
    if (message.id === undefined) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "Worker CDP error."));
    else waiter.resolve(message.result);
  };

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    void this.root
      .send("Target.sendMessageToTarget", {
        sessionId: this.sessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .catch((error) => {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(error);
      });
    return response;
  }

  async heap(): Promise<HeapUsage> {
    await this.send("HeapProfiler.collectGarbage");
    return this.send<HeapUsage>("Runtime.getHeapUsage");
  }

  async close(): Promise<void> {
    this.root.off("Target.receivedMessageFromTarget", this.onMessage);
    await this.root.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => undefined);
  }
}

async function capturePdfjsWorkerNetwork<T>(
  root: CDPSession,
  action: () => Promise<T>
): Promise<{
  result: T;
  requests: NetworkProbeRequest[];
  workerHeap?: HeapUsage;
}> {
  const requests = new Map<string, NetworkProbeRequest>();
  const sessions: ChildTargetSession[] = [];
  let pdfjsSession: ChildTargetSession | undefined;
  const setups: Promise<void>[] = [];
  const onAttached = (event: {
    sessionId: string;
    targetInfo: { type: string; title: string; url: string };
  }): void => {
    if (event.targetInfo.type !== "worker") return;
    const isPdfjs =
      event.targetInfo.title.includes("pdfjs-worker-bootstrap") ||
      event.targetInfo.url.includes("pdfjs-worker-bootstrap");
    let session: ChildTargetSession;
    session = new ChildTargetSession(root, event.sessionId, (method, params) => {
      if (!isPdfjs) return;
      if (method === "Network.requestWillBeSent") {
        const requestId = String(params.requestId);
        const request = params.request as {
          url: string;
          headers?: Record<string, string>;
        };
        if (request.url.startsWith("blob:")) {
          requests.set(requestId, {
            url: request.url,
            range: request.headers?.Range ?? request.headers?.range ?? null,
            status: null,
            contentRange: null,
            encodedBytes: null,
          });
        }
      } else if (method === "Network.responseReceived") {
        const captured = requests.get(String(params.requestId));
        if (!captured) return;
        const response = params.response as {
          status: number;
          headers?: Record<string, string>;
        };
        captured.status = response.status;
        captured.contentRange =
          response.headers?.["Content-Range"] ?? response.headers?.["content-range"] ?? null;
      } else if (method === "Network.loadingFinished") {
        const captured = requests.get(String(params.requestId));
        if (captured) captured.encodedBytes = Number(params.encodedDataLength);
      }
    });
    sessions.push(session);
    if (isPdfjs) pdfjsSession = session;
    setups.push(
      (async () => {
        if (isPdfjs) await session.send("Network.enable");
        await session.send("Runtime.runIfWaitingForDebugger");
      })()
    );
  };

  root.on("Target.attachedToTarget", onAttached);
  await root.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  try {
    const result = await action();
    await Promise.all(setups);
    const workerHeap = await pdfjsSession?.heap();
    return { result, requests: [...requests.values()], workerHeap };
  } finally {
    await root.send("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
    root.off("Target.attachedToTarget", onAttached);
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }
}

async function attachCompilerWorker(root: CDPSession): Promise<ChildTargetSession> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { targetInfos } = (await root.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    };
    const target = targetInfos.find(
      (candidate) =>
        candidate.type === "worker" &&
        (candidate.title.includes("atlcli-memory-offscreen") || candidate.url.includes("worker-"))
    );
    if (target) {
      const { sessionId } = (await root.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      })) as { sessionId: string };
      return new ChildTargetSession(root, sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The Chrome memory compiler worker target did not appear.");
}

async function waitForPhase(page: Page, phase: MemoryWorkerPhase): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.atlcliMemoryProbe.phase()), { timeout: 90_000 })
    .toBe(phase);
}

function allocationBytes(profile: unknown): number {
  const root = (profile as { profile?: { head?: unknown } }).profile?.head;
  const walk = (node: unknown): number => {
    if (!node || typeof node !== "object") return 0;
    const value = node as { selfSize?: number; children?: unknown[] };
    return (
      (value.selfSize ?? 0) +
      (value.children ?? []).reduce<number>((sum, child) => sum + walk(child), 0)
    );
  };
  return walk(root);
}

test("records real Chrome/V8 heap peaks for the extension PDF byte path", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "atlcli-chrome-memory-profile-"));
  let context: BrowserContext | undefined;
  let workerSession: ChildTargetSession | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${OUTPUT_DIR}`,
        `--load-extension=${OUTPUT_DIR}`,
        "--enable-precise-memory-info",
      ],
    });
    let serviceWorker = context.serviceWorkers()[0];
    serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(page.getByTestId("memory-state")).toHaveText("ready");
    const cdp = await context.newCDPSession(page);
    const browserVersion = (await cdp.send("Browser.getVersion")) as {
      product: string;
      revision: string;
      userAgent: string;
      jsVersion: string;
    };

    const baseline = await pageHeap(cdp);
    const fixture = await page.evaluate(() => window.atlcliMemoryProbe.prepareFixture());
    expect(fixture.assetBytes).toBeGreaterThan(8 * MIB);
    const prepared = await pageHeap(cdp);

    await page.evaluate(() => window.atlcliMemoryProbe.storePreparedJob());
    const stored = await pageHeap(cdp);
    const beforeMeta = await pageHeap(cdp);
    const meta = await page.evaluate(() => window.atlcliMemoryProbe.readMetaInventory());
    const afterMeta = await pageHeap(cdp);
    expect(meta.jobs).toBe(1);
    expect(meta.inputBytes).toBe(fixture.bundleBytes);
    await page.evaluate(() => window.atlcliMemoryProbe.releaseMetaInventory());

    await page.evaluate(() => window.atlcliMemoryProbe.startWorker());
    await waitForPhase(page, "warm");
    workerSession = await attachCompilerWorker(cdp);
    const workerWarm = await workerSession.heap();

    await page.evaluate(() => window.atlcliMemoryProbe.startCompile());
    await waitForPhase(page, "bundle-received");
    const workerBundle = await workerSession.heap();
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "vfs-ready");
    const workerVfs = await workerSession.heap();
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "compiled-held");
    const workerCompiled = await workerSession.heap();
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "complete");
    const workerComplete = await workerSession.heap();

    const compiled = await page.evaluate(() => window.atlcliMemoryProbe.readCompiledResult());
    expect(compiled.byteLength).toBeGreaterThan(100_000);
    const resultHeld = await pageHeap(cdp);

    const beforeValidate = await pageHeap(cdp);
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32_768 });
    const inspection = await page.evaluate(() => window.atlcliMemoryProbe.validateResult());
    const validationProfile = await cdp.send("HeapProfiler.stopSampling");
    const afterValidate = await pageHeap(cdp);
    expect(inspection.tagged).toBe(true);

    const beforeBlob = await pageHeap(cdp);
    const blob = await page.evaluate(() => window.atlcliMemoryProbe.createDownloadBlob());
    const afterBlob = await pageHeap(cdp);
    expect(blob.blobSize).toBe(blob.byteLength);
    await page.evaluate(() => window.atlcliMemoryProbe.releaseDownloadBlob());

    const beforePdfjs = await pageHeap(cdp);
    const pdfjsNetwork = await capturePdfjsWorkerNetwork(cdp, () =>
      page.evaluate(() => window.atlcliMemoryProbe.probePdfjsBlobLoading())
    );
    const pdfjs = {
      ...pdfjsNetwork.result,
      workerRequests: pdfjsNetwork.requests,
      workerHeap: pdfjsNetwork.workerHeap ? absolute(pdfjsNetwork.workerHeap) : null,
    };
    const afterPdfjs = await pageHeap(cdp);

    const idbBytes = 16 * MIB;
    await page.evaluate(
      ({ bytes }) => window.atlcliMemoryProbe.seedIdbPayload("array", bytes),
      { bytes: idbBytes }
    );
    const beforeIdbArray = await pageHeap(cdp);
    const arrayRead = await page.evaluate(() => window.atlcliMemoryProbe.readIdbPayload("array"));
    const afterIdbArray = await pageHeap(cdp);
    expect(arrayRead).toEqual({ storedType: "Uint8Array", byteLength: idbBytes });
    await page.evaluate(() => window.atlcliMemoryProbe.releaseIdbPayload());

    await page.evaluate(
      ({ bytes }) => window.atlcliMemoryProbe.seedIdbPayload("blob", bytes),
      { bytes: idbBytes }
    );
    const beforeIdbBlob = await pageHeap(cdp);
    const blobRead = await page.evaluate(() => window.atlcliMemoryProbe.readIdbPayload("blob"));
    const afterIdbBlob = await pageHeap(cdp);
    expect(blobRead).toEqual({ storedType: "Blob", byteLength: idbBytes });

    const report = {
      schema: "atlcli.chrome-memory/v1",
      measuredAt: new Date().toISOString(),
      runtime: browserVersion,
      fixture: {
        ...fixture,
        assetMiB: mib(fixture.assetBytes),
        bundleMiB: mib(fixture.bundleBytes),
        pdfBytes: compiled.byteLength,
        pdfMiB: mib(compiled.byteLength),
      },
      panel: {
        prepareFromBaseline: delta(baseline, prepared),
        storedFromBaseline: delta(baseline, stored),
        metadataGetAll: delta(beforeMeta, afterMeta),
        resultReadFromStored: delta(stored, resultHeld),
        validationRetained: delta(beforeValidate, afterValidate),
        validationSampledAllocationsMiB: mib(allocationBytes(validationProfile)),
        downloadBlob: delta(beforeBlob, afterBlob),
        pdfjsOpen: delta(beforePdfjs, afterPdfjs),
      },
      offscreenWorker: {
        bundleRead: delta(workerWarm, workerBundle),
        vfsLoaded: delta(workerWarm, workerVfs),
        compiledPdfHeld: delta(workerWarm, workerCompiled),
        completed: delta(workerWarm, workerComplete),
      },
      indexedDb: {
        bytes: idbBytes,
        arrayGet: delta(beforeIdbArray, afterIdbArray),
        blobGet: delta(beforeIdbBlob, afterIdbBlob),
      },
      pdfjsBlob: pdfjs,
    };
    console.log(`ATLCLI_CHROME_MEMORY_RESULT\n${JSON.stringify(report, null, 2)}`);

    expect(report.panel.metadataGetAll.usedMiB).toBeLessThan(1);
    expect(report.offscreenWorker.vfsLoaded.backingMiB).toBeGreaterThan(0);
    expect(report.indexedDb.arrayGet.backingMiB).toBeGreaterThan(8);
    expect(report.indexedDb.blobGet.usedMiB).toBeLessThan(1);
    expect(report.pdfjsBlob.directRangeStatus).toBe(206);
    expect(report.pdfjsBlob.directRangeBytes).toBe(65_536);
    expect(report.pdfjsBlob.workerHeap).not.toBeNull();
    await page.evaluate(() => window.atlcliMemoryProbe.cleanup());
    await cdp.detach();
  } finally {
    await workerSession?.close().catch(() => undefined);
    await context?.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
});
