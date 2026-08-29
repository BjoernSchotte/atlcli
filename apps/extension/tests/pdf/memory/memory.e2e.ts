import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWorkerMemoryAttribution } from "./attribution.js";
import type {
  MemoryProbeApi,
  MemoryWorkerPhase,
  RasterNormalizerPhase,
  RasterNormalizerState,
  RasterNormalizerVariant,
} from "./protocol.js";

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

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot take the median of no samples.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function ratio(candidate: number, reference: number): number {
  if (reference <= 0) throw new Error(`Ratchet reference must be positive, received ${reference}.`);
  return Number((candidate / reference).toFixed(3));
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

async function attachRasterNormalizerWorker(root: CDPSession): Promise<ChildTargetSession> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { targetInfos } = (await root.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    };
    const target = targetInfos.find(
      (candidate) =>
        candidate.type === "worker" &&
        (candidate.title.includes("atlcli-memory-normalizer") ||
          candidate.title.includes("atlcli-memory-productive-raster-normalizer") ||
          candidate.url.includes("normalizer-worker") ||
          candidate.url.includes("raster-normalizer")),
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
  throw new Error("The Chrome raster-normalizer worker target did not appear.");
}

async function rasterNormalizerWorkerExists(root: CDPSession): Promise<boolean> {
  const { targetInfos } = (await root.send("Target.getTargets")) as {
    targetInfos: Array<{ type: string; title: string; url: string }>;
  };
  return targetInfos.some(
    (candidate) =>
      candidate.type === "worker" &&
      (candidate.title.includes("atlcli-memory-normalizer") ||
        candidate.title.includes("atlcli-memory-productive-raster-normalizer") ||
        candidate.url.includes("normalizer-worker") ||
        candidate.url.includes("raster-normalizer")),
  );
}

interface ProcessTreeRss {
  rssMiB: number;
  processCount: number;
}

/** Whole Chromium process-tree RSS, including native ImageBitmap/VideoFrame allocations. */
function chromeProcessTreeRss(profileDir: string): ProcessTreeRss {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
  });
  const rows = output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4] ?? "",
    }));
  const processIds = new Set(
    rows.filter((row) => row.command.includes(profileDir)).map((row) => row.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!processIds.has(row.pid) && processIds.has(row.ppid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }
  if (processIds.size === 0) {
    throw new Error(`Could not locate Chromium processes for profile ${profileDir}.`);
  }
  const rssKiB = rows.reduce(
    (total, row) => total + (processIds.has(row.pid) ? row.rssKiB : 0),
    0,
  );
  return { rssMiB: Number((rssKiB / 1024).toFixed(2)), processCount: processIds.size };
}

async function waitForPhase(
  page: Page,
  phase: MemoryWorkerPhase,
  timeoutMs = 90_000
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.atlcliMemoryProbe.phase()), { timeout: timeoutMs })
    .toBe(phase);
}

interface Harness {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  browserVersion: { product: string; revision: string; userAgent: string; jsVersion: string };
  profileDir: string;
}

async function openHarness(): Promise<Harness> {
  const profileDir = mkdtempSync(join(tmpdir(), "atlcli-chrome-memory-profile-"));
  const executablePath = process.env.ATLCLI_MEMORY_EXECUTABLE_PATH;
  const channel = process.env.ATLCLI_MEMORY_BROWSER_CHANNEL === "chrome"
    ? "chrome"
    : "chromium";
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(executablePath ? { executablePath } : { channel }),
    headless: process.env.ATLCLI_MEMORY_HEADED !== "1",
    args: [
      `--disable-extensions-except=${OUTPUT_DIR}`,
      `--load-extension=${OUTPUT_DIR}`,
      "--enable-precise-memory-info",
    ],
  });
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent("serviceworker", {
    timeout: process.env.ATLCLI_MEMORY_HEADED === "1" ? 180_000 : 30_000,
  });
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(page.getByTestId("memory-state")).toHaveText("ready");
  const cdp = await context.newCDPSession(page);
  const browserVersion = (await cdp.send("Browser.getVersion")) as Harness["browserVersion"];
  return { context, page, cdp, browserVersion, profileDir };
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  await harness.context.close().catch(() => undefined);
  rmSync(harness.profileDir, { recursive: true, force: true });
}

function workerDetail(
  page: Page,
  phase: Exclude<MemoryWorkerPhase, "error">
): Promise<Record<string, number> | null> {
  return page.evaluate((value) => window.atlcliMemoryProbe.workerDetail(value), phase);
}

function attributionSample(
  phase: string,
  heap: HeapUsage,
  detail: Record<string, number> | null
): { phase: string; heap: HeapUsage; wasmMemoryBytes?: number } {
  const wasmMemoryBytes = detail?.wasmMemoryBytes;
  return {
    phase,
    heap,
    ...(typeof wasmMemoryBytes === "number" ? { wasmMemoryBytes } : {}),
  };
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
  let harness: Harness | undefined;
  let workerSession: ChildTargetSession | undefined;
  try {
    harness = await openHarness();
    const { page, cdp, browserVersion } = harness;

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
    const warmDetail = await workerDetail(page, "warm");

    await page.evaluate(() => window.atlcliMemoryProbe.startCompile());
    await waitForPhase(page, "bundle-received");
    const workerBundle = await workerSession.heap();
    const bundleDetail = await workerDetail(page, "bundle-received");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "vfs-ready");
    const workerVfs = await workerSession.heap();
    const vfsDetail = await workerDetail(page, "vfs-ready");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "compiled-held");
    const workerCompiled = await workerSession.heap();
    const compiledDetail = await workerDetail(page, "compiled-held");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "complete");
    const workerComplete = await workerSession.heap();
    const completeDetail = await workerDetail(page, "complete");

    const workerAttribution = computeWorkerMemoryAttribution([
      attributionSample("warm", workerWarm, warmDetail),
      attributionSample("bundle-received", workerBundle, bundleDetail),
      attributionSample("vfs-ready", workerVfs, vfsDetail),
      attributionSample("compiled-held", workerCompiled, compiledDetail),
      attributionSample("complete", workerComplete, completeDetail),
    ]);

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
      schema: "atlcli.chrome-memory/v2",
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
      workerAttribution,
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
    // Host-versus-WASM attribution (specs/issue-118 Phase 0 gate input): the
    // WASM linear memory must be observable, its growth monotonic, and the
    // peak-phase split must be a valid share. The basis is detected and
    // reported, never asserted, so a runtime that stops counting WASM memory
    // in backing storage changes the report instead of silently lying.
    expect(report.workerAttribution.basis).not.toBe("wasm-unavailable");
    expect(report.workerAttribution.wasmHighWaterMiB).toBeGreaterThan(0);
    expect(report.workerAttribution.wasmMonotonicGrowth).toBe(true);
    expect(report.workerAttribution.peak.wasmShare).toBeGreaterThan(0);
    expect(report.workerAttribution.peak.hostShare).toBeGreaterThanOrEqual(0);
    expect(report.workerAttribution.peak.hostShare + report.workerAttribution.peak.wasmShare)
      .toBeCloseTo(1, 2);
    expect(report.indexedDb.arrayGet.backingMiB).toBeGreaterThan(8);
    expect(report.indexedDb.blobGet.usedMiB).toBeLessThan(1);
    expect(report.pdfjsBlob.directRangeStatus).toBe(206);
    expect(report.pdfjsBlob.directRangeBytes).toBe(65_536);
    expect(report.pdfjsBlob.workerHeap).not.toBeNull();
    await page.evaluate(() => window.atlcliMemoryProbe.cleanup());
    await cdp.detach();
  } finally {
    await workerSession?.close().catch(() => undefined);
    await closeHarness(harness);
  }
});

interface ProfileCycleResult {
  fixture: Awaited<ReturnType<MemoryProbeApi["prepareCorpusFixture"]>>;
  attribution: ReturnType<typeof computeWorkerMemoryAttribution>;
  pdfBytes: number;
}

/** One full image-heavy cycle (prepare → store → compile) under a profile. */
async function runImageHeavyCycle(profile: "original" | "standard"): Promise<ProfileCycleResult> {
  let harness: Harness | undefined;
  let workerSession: ChildTargetSession | undefined;
  try {
    harness = await openHarness();
    const { page, cdp } = harness;
    const fixture = await page.evaluate(
      (value) => window.atlcliMemoryProbe.prepareCorpusFixture(value),
      profile,
    );
    expect(fixture.notes === 0 || profile === "standard").toBe(true);
    await page.evaluate(() => window.atlcliMemoryProbe.storePreparedJob());
    await page.evaluate(() => window.atlcliMemoryProbe.startWorker());
    await waitForPhase(page, "warm", 300_000);
    workerSession = await attachCompilerWorker(cdp);
    const samples: Array<Parameters<typeof computeWorkerMemoryAttribution>[0][number]> = [];
    const capture = async (phase: Exclude<MemoryWorkerPhase, "error">): Promise<void> => {
      samples.push(attributionSample(phase, await workerSession!.heap(), await workerDetail(page, phase)));
    };
    await capture("warm");
    await page.evaluate(() => window.atlcliMemoryProbe.startCompile());
    await waitForPhase(page, "bundle-received", 300_000);
    await capture("bundle-received");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "vfs-ready", 300_000);
    await capture("vfs-ready");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "compiled-held", 1_200_000);
    await capture("compiled-held");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "complete", 600_000);
    await capture("complete");
    const compiled = await page.evaluate(() => window.atlcliMemoryProbe.readCompiledResult());
    await page.evaluate(() => window.atlcliMemoryProbe.cleanup());
    await harness.cdp.detach();
    return {
      fixture,
      attribution: computeWorkerMemoryAttribution(samples),
      pdfBytes: compiled.byteLength,
    };
  } finally {
    await workerSession?.close().catch(() => undefined);
    await closeHarness(harness);
  }
}

const NORMALIZER_PROBE_PHASES = new Set<RasterNormalizerPhase>([
  "source-held",
  "decoded-held",
  "target-held",
  "encoded-held",
]);

interface RasterNormalizerVariantResult {
  variant: RasterNormalizerVariant;
  runtime: Harness["browserVersion"];
  input: Awaited<ReturnType<MemoryProbeApi["loadRasterNormalizerCorpus"]>>;
  output: Awaited<ReturnType<MemoryProbeApi["readRasterNormalizerResult"]>>;
  support: RasterNormalizerState["detail"];
  normalizer: {
    executionContext: "panel-main-current" | "disposable-worker";
    baselineProcessRssMiB: number;
    readyProcessRssMiB: number;
    peakProcessRssMiB: number;
    peakDeltaMiB: number;
    beforeTerminateProcessRssMiB: number;
    afterTerminateProcessRssMiB: number;
    releasedFromPeakMiB: number;
    panelBaseline: HeapDelta;
    panelAfterTerminate: HeapDelta;
    workerReady: HeapDelta | null;
    workerComplete: HeapDelta | null;
    workerPhasePeakMiB: number | null;
    phaseSamples: Array<{
      phase: RasterNormalizerPhase;
      detail: RasterNormalizerState["detail"];
      processRssMiB: number;
      worker: HeapDelta;
      workerFromReady: HeapDelta;
    }>;
    workerTargetReleased: boolean;
    productiveReceipt: Awaited<
      ReturnType<MemoryProbeApi["terminateRasterNormalizer"]>
    >;
  };
  compiler: {
    attribution: ReturnType<typeof computeWorkerMemoryAttribution>;
    processRssPeakMiB: number;
    pdfBytes: number;
    pdfSha256: string;
    tagged: boolean;
  };
}

async function runRasterNormalizerVariant(
  variant: RasterNormalizerVariant,
): Promise<RasterNormalizerVariantResult> {
  let harness: Harness | undefined;
  let normalizerSession: ChildTargetSession | undefined;
  let compilerSession: ChildTargetSession | undefined;
  let stopRssSampler = false;
  let rssSampler: Promise<void> | undefined;
  try {
    harness = await openHarness();
    const { page, cdp, profileDir, browserVersion } = harness;
    const input = await page.evaluate(() => window.atlcliMemoryProbe.loadRasterNormalizerCorpus());
    const panelBaseline = await pageHeap(cdp);
    const baselineRss = chromeProcessTreeRss(profileDir);

    const readyState = await page.evaluate((value) =>
      window.atlcliMemoryProbe.startRasterNormalizerWorker(value), variant);
    if (
      variant !== "pure-ts"
      && variant !== "pure-worker"
      && variant !== "image-bitmap-worker"
    ) {
      normalizerSession = await attachRasterNormalizerWorker(cdp);
    }
    let workerReady = normalizerSession ? await normalizerSession.heap() : undefined;
    const readyRss = chromeProcessTreeRss(profileDir);

    const normalizerRssSamples: number[] = [readyRss.rssMiB];
    stopRssSampler = false;
    rssSampler = (async () => {
      while (!stopRssSampler) {
        normalizerRssSamples.push(chromeProcessTreeRss(profileDir).rssMiB);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    await page.evaluate(() => window.atlcliMemoryProbe.startRasterNormalizerPrepare());
    if (variant === "pure-worker" || variant === "image-bitmap-worker") {
      normalizerSession = await attachRasterNormalizerWorker(cdp);
      workerReady = await normalizerSession.heap();
    }
    const sampledSequences = new Set<number>();
    const phaseSamples: RasterNormalizerVariantResult["normalizer"]["phaseSamples"] = [];
    while (true) {
      const state = await page.evaluate(() => window.atlcliMemoryProbe.rasterNormalizerState());
      if (state.phase === "error") throw new Error(state.error ?? `${variant} normalization failed.`);
      if (
        normalizerSession &&
        NORMALIZER_PROBE_PHASES.has(state.phase) &&
        !sampledSequences.has(state.sequence)
      ) {
        sampledSequences.add(state.sequence);
        const workerHeap = await normalizerSession.heap();
        const processRss = chromeProcessTreeRss(profileDir).rssMiB;
        normalizerRssSamples.push(processRss);
        phaseSamples.push({
          phase: state.phase,
          detail: state.detail,
          processRssMiB: processRss,
          worker: absolute(workerHeap),
          workerFromReady: delta(workerReady!, workerHeap),
        });
        await page.evaluate(() => window.atlcliMemoryProbe.continueRasterNormalizer());
      }
      if (state.done) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stopRssSampler = true;
    await rssSampler;
    rssSampler = undefined;

    const output = await page.evaluate(() => window.atlcliMemoryProbe.readRasterNormalizerResult());
    const workerComplete = normalizerSession ? await normalizerSession.heap() : undefined;
    const beforeTerminateRss = chromeProcessTreeRss(profileDir);
    normalizerRssSamples.push(beforeTerminateRss.rssMiB);
    await normalizerSession?.close();
    normalizerSession = undefined;
    const productiveReceipt = await page.evaluate(() =>
      window.atlcliMemoryProbe.terminateRasterNormalizer());
    await expect.poll(() => rasterNormalizerWorkerExists(cdp), { timeout: 10_000 }).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const panelAfterTerminate = await pageHeap(cdp);
    const afterTerminateRss = chromeProcessTreeRss(profileDir);
    const peakProcessRssMiB = Math.max(...normalizerRssSamples);

    await page.evaluate(() => window.atlcliMemoryProbe.storePreparedJob());
    await pageHeap(cdp);
    await page.evaluate(() => window.atlcliMemoryProbe.startWorker());
    await waitForPhase(page, "warm", 300_000);
    compilerSession = await attachCompilerWorker(cdp);
    const compilerSamples: Array<Parameters<typeof computeWorkerMemoryAttribution>[0][number]> = [];
    const compilerRssSamples: number[] = [];
    const captureCompiler = async (
      phase: Exclude<MemoryWorkerPhase, "error">,
    ): Promise<void> => {
      compilerSamples.push(
        attributionSample(
          phase,
          await compilerSession!.heap(),
          await workerDetail(page, phase),
        ),
      );
      compilerRssSamples.push(chromeProcessTreeRss(profileDir).rssMiB);
    };
    await captureCompiler("warm");
    await page.evaluate(() => window.atlcliMemoryProbe.startCompile());
    await waitForPhase(page, "bundle-received", 300_000);
    await captureCompiler("bundle-received");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "vfs-ready", 300_000);
    await captureCompiler("vfs-ready");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "compiled-held", 1_200_000);
    await captureCompiler("compiled-held");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "complete", 600_000);
    await captureCompiler("complete");
    const compiled = await page.evaluate(() => window.atlcliMemoryProbe.readCompiledResult());
    const validation = await page.evaluate(() => window.atlcliMemoryProbe.validateResult());
    const attribution = computeWorkerMemoryAttribution(compilerSamples);

    const result: RasterNormalizerVariantResult = {
      variant,
      runtime: browserVersion,
      input,
      output,
      support: readyState.detail,
      normalizer: {
        executionContext: variant === "pure-ts" ? "panel-main-current" : "disposable-worker",
        baselineProcessRssMiB: baselineRss.rssMiB,
        readyProcessRssMiB: readyRss.rssMiB,
        peakProcessRssMiB,
        peakDeltaMiB: Number((peakProcessRssMiB - baselineRss.rssMiB).toFixed(2)),
        beforeTerminateProcessRssMiB: beforeTerminateRss.rssMiB,
        afterTerminateProcessRssMiB: afterTerminateRss.rssMiB,
        releasedFromPeakMiB: Number((peakProcessRssMiB - afterTerminateRss.rssMiB).toFixed(2)),
        panelBaseline: absolute(panelBaseline),
        panelAfterTerminate: absolute(panelAfterTerminate),
        workerReady: workerReady ? absolute(workerReady) : null,
        workerComplete: workerComplete ? absolute(workerComplete) : null,
        workerPhasePeakMiB:
          phaseSamples.length > 0
            ? Math.max(...phaseSamples.map((sample) =>
                sample.worker.usedMiB + sample.worker.embedderMiB + sample.worker.backingMiB))
            : null,
        phaseSamples,
        workerTargetReleased: !(await rasterNormalizerWorkerExists(cdp)),
        productiveReceipt,
      },
      compiler: {
        attribution,
        processRssPeakMiB: Math.max(...compilerRssSamples),
        pdfBytes: compiled.byteLength,
        pdfSha256: compiled.sha256,
        tagged: validation.tagged,
      },
    };
    await page.evaluate(() => window.atlcliMemoryProbe.cleanup());
    await cdp.detach();
    return result;
  } finally {
    stopRssSampler = true;
    await rssSampler?.catch(() => undefined);
    await normalizerSession?.close().catch(() => undefined);
    await compilerSession?.close().catch(() => undefined);
    await closeHarness(harness);
  }
}

test("ratchets the productive pure raster worker against panel-main", async () => {
  test.setTimeout(3_600_000);
  const runCount = Number(process.env.ATLCLI_PRODUCTIVE_RASTER_RUNS ?? "2");
  if (!Number.isSafeInteger(runCount) || runCount < 2 || runCount > 5) {
    throw new Error("ATLCLI_PRODUCTIVE_RASTER_RUNS must be an integer in [2, 5].");
  }

  const results: RasterNormalizerVariantResult[] = [];
  for (let iteration = 0; iteration < runCount; iteration += 1) {
    for (const variant of ["pure-ts", "pure-worker"] as const) {
      const result = await runRasterNormalizerVariant(variant);
      results.push(result);
      console.log(
        `ATLCLI_PRODUCTIVE_RASTER_VARIANT_RESULT\n${JSON.stringify({ iteration: iteration + 1, ...result }, null, 2)}`,
      );
    }
  }

  const panel = results.filter((result) => result.variant === "pure-ts");
  const worker = results.filter((result) => result.variant === "pure-worker");
  const panelPrepareMedianMs = median(panel.map((result) => result.output.prepareMs));
  const workerPrepareMedianMs = median(worker.map((result) => result.output.prepareMs));
  const panelNormalizerPeakMedianMiB = median(
    panel.map((result) => result.normalizer.peakDeltaMiB),
  );
  const workerNormalizerPeakMedianMiB = median(
    worker.map((result) => result.normalizer.peakDeltaMiB),
  );
  const panelWholeChromePeakMedianMiB = median(panel.map((result) =>
    Math.max(result.normalizer.peakProcessRssMiB, result.compiler.processRssPeakMiB)
  ));
  const workerWholeChromePeakMedianMiB = median(worker.map((result) =>
    Math.max(result.normalizer.peakProcessRssMiB, result.compiler.processRssPeakMiB)
  ));
  const workerCleanupResidualMedianMiB = median(worker.map((result) =>
    Number((
      result.normalizer.afterTerminateProcessRssMiB -
      result.normalizer.baselineProcessRssMiB
    ).toFixed(2))
  ));
  const report = {
    schema: "atlcli.chrome-productive-raster-normalizer-ratchet/v1",
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch },
    runCount,
    runtime: results[0]?.runtime,
    corpus: {
      scale: results[0]?.input.scale,
      manifestSha256: results[0]?.input.manifestSha256,
      sourceAssetBytes: results[0]?.input.sourceAssetBytes,
      placements: results[0]?.input.placements,
    },
    medians: {
      panelPrepareMs: Number(panelPrepareMedianMs.toFixed(2)),
      workerPrepareMs: Number(workerPrepareMedianMs.toFixed(2)),
      prepareRatio: ratio(workerPrepareMedianMs, panelPrepareMedianMs),
      panelNormalizerPeakDeltaMiB: Number(panelNormalizerPeakMedianMiB.toFixed(2)),
      workerNormalizerPeakDeltaMiB: Number(workerNormalizerPeakMedianMiB.toFixed(2)),
      normalizerPeakRatio: ratio(
        workerNormalizerPeakMedianMiB,
        panelNormalizerPeakMedianMiB,
      ),
      panelWholeChromePeakMiB: Number(panelWholeChromePeakMedianMiB.toFixed(2)),
      workerWholeChromePeakMiB: Number(workerWholeChromePeakMedianMiB.toFixed(2)),
      wholeChromePeakRatio: ratio(
        workerWholeChromePeakMedianMiB,
        panelWholeChromePeakMedianMiB,
      ),
      workerCleanupResidualMiB: Number(workerCleanupResidualMedianMiB.toFixed(2)),
      workerHeartbeatP95Ms: median(worker.map((result) =>
        result.normalizer.productiveReceipt?.heartbeatP95Ms ?? Number.POSITIVE_INFINITY
      )),
    },
    results,
  };
  console.log(
    `ATLCLI_PRODUCTIVE_RASTER_NORMALIZER_RATCHET_RESULT\n${JSON.stringify(report, null, 2)}`,
  );

  expect(panel).toHaveLength(runCount);
  expect(worker).toHaveLength(runCount);
  expect(new Set(results.map((result) => result.input.manifestSha256)).size).toBe(1);
  expect(new Set(results.map((result) => result.output.outputAssetSha256)).size).toBe(1);
  expect(new Set(results.map((result) => result.compiler.pdfSha256)).size).toBe(1);
  expect(new Set(results.map((result) => result.output.bundleBytes)).size).toBe(1);
  for (const result of results) {
    expect(result.output.manifestSha256).toBe(result.input.manifestSha256);
    expect(result.output.normalizedCalls).toBeGreaterThan(0);
    expect(result.compiler.tagged).toBe(true);
    expect(result.normalizer.workerTargetReleased).toBe(true);
  }
  for (const result of panel) {
    expect(result.normalizer.productiveReceipt).toBeNull();
  }
  for (const result of worker) {
    expect(result.normalizer.productiveReceipt).toMatchObject({
      schema: "atlcli.extension-raster-normalizer-receipt/1",
      backend: "pure-ts",
      jobId: "memory-productive-pure-worker",
      leaseEpoch: 1,
      workerStarted: true,
      requests: result.output.normalizedCalls + result.output.keptCalls,
      normalized: result.output.normalizedCalls,
      kept: result.output.keptCalls,
      outcome: "released",
    });
    expect(result.normalizer.productiveReceipt?.heartbeatSamples).toBeGreaterThan(0);
    expect(result.normalizer.productiveReceipt?.heartbeatP95Ms).not.toBeNull();
    expect(result.normalizer.productiveReceipt!.heartbeatP95Ms!).toBeLessThan(50);
    expect(result.normalizer.productiveReceipt!.cacheHits).toBeGreaterThan(0);
  }
  expect(ratio(workerPrepareMedianMs, panelPrepareMedianMs)).toBeLessThanOrEqual(1.15);
  expect(ratio(
    workerNormalizerPeakMedianMiB,
    panelNormalizerPeakMedianMiB,
  )).toBeLessThanOrEqual(0.95);
  expect(ratio(
    workerWholeChromePeakMedianMiB,
    panelWholeChromePeakMedianMiB,
  )).toBeLessThanOrEqual(1.15);
  expect(workerCleanupResidualMedianMiB).toBeLessThanOrEqual(32);
});

test("ratchets the productive ImageBitmap worker against pure-worker", async ({}, testInfo) => {
  test.setTimeout(3_600_000);
  const runCount = Number(process.env.ATLCLI_PRODUCTIVE_RASTER_RUNS ?? "2");
  const assertTiming = process.env.ATLCLI_PRODUCTIVE_RASTER_ASSERT_TIMING !== "0";
  if (!Number.isSafeInteger(runCount) || runCount < 2 || runCount > 5) {
    throw new Error("ATLCLI_PRODUCTIVE_RASTER_RUNS must be an integer in [2, 5].");
  }

  const results: RasterNormalizerVariantResult[] = [];
  for (let iteration = 0; iteration < runCount; iteration += 1) {
    for (const variant of ["pure-worker", "image-bitmap-worker"] as const) {
      const result = await runRasterNormalizerVariant(variant);
      results.push(result);
      console.log(
        `ATLCLI_PRODUCTIVE_IMAGE_BITMAP_VARIANT_RESULT\n${JSON.stringify({ iteration: iteration + 1, ...result }, null, 2)}`,
      );
    }
  }

  const pure = results.filter((result) => result.variant === "pure-worker");
  const imageBitmap = results.filter((result) => result.variant === "image-bitmap-worker");
  const prepareMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) => result.output.prepareMs));
  const normalizerPeakMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) => result.normalizer.peakDeltaMiB));
  const cleanupResidualMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) => Number((
      result.normalizer.afterTerminateProcessRssMiB
      - result.normalizer.baselineProcessRssMiB
    ).toFixed(2))));
  const typstPeakMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) => result.compiler.attribution.peak.totalMiB));
  const wholeChromePeakMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) =>
      Math.max(result.normalizer.peakProcessRssMiB, result.compiler.processRssPeakMiB)
    ));
  const assetBytesMedian = (lane: RasterNormalizerVariantResult[]): number =>
    median(lane.map((result) => result.output.assetBytes));

  const purePrepareMedianMs = prepareMedian(pure);
  const imagePrepareMedianMs = prepareMedian(imageBitmap);
  const pureNormalizerPeakMedianMiB = normalizerPeakMedian(pure);
  const imageNormalizerPeakMedianMiB = normalizerPeakMedian(imageBitmap);
  const imageCleanupResidualMedianMiB = cleanupResidualMedian(imageBitmap);
  const pureTypstPeakMedianMiB = typstPeakMedian(pure);
  const imageTypstPeakMedianMiB = typstPeakMedian(imageBitmap);
  const pureWholeChromePeakMedianMiB = wholeChromePeakMedian(pure);
  const imageWholeChromePeakMedianMiB = wholeChromePeakMedian(imageBitmap);
  const pureAssetBytesMedian = assetBytesMedian(pure);
  const imageAssetBytesMedian = assetBytesMedian(imageBitmap);
  const report = {
    schema: "atlcli.chrome-productive-image-bitmap-ratchet/v1",
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch },
    runCount,
    assertTiming,
    runtime: results[0]?.runtime,
    corpus: {
      scale: results[0]?.input.scale,
      manifestSha256: results[0]?.input.manifestSha256,
      sourceAssetBytes: results[0]?.input.sourceAssetBytes,
      placements: results[0]?.input.placements,
    },
    medians: {
      purePrepareMs: Number(purePrepareMedianMs.toFixed(2)),
      imageBitmapPrepareMs: Number(imagePrepareMedianMs.toFixed(2)),
      prepareRatio: ratio(imagePrepareMedianMs, purePrepareMedianMs),
      pureNormalizerPeakDeltaMiB: Number(pureNormalizerPeakMedianMiB.toFixed(2)),
      imageBitmapNormalizerPeakDeltaMiB: Number(imageNormalizerPeakMedianMiB.toFixed(2)),
      normalizerPeakRatio: ratio(imageNormalizerPeakMedianMiB, pureNormalizerPeakMedianMiB),
      imageBitmapCleanupResidualMiB: Number(imageCleanupResidualMedianMiB.toFixed(2)),
      pureTypstPeakMiB: Number(pureTypstPeakMedianMiB.toFixed(2)),
      imageBitmapTypstPeakMiB: Number(imageTypstPeakMedianMiB.toFixed(2)),
      typstPeakRatio: ratio(imageTypstPeakMedianMiB, pureTypstPeakMedianMiB),
      pureWholeChromePeakMiB: Number(pureWholeChromePeakMedianMiB.toFixed(2)),
      imageBitmapWholeChromePeakMiB: Number(imageWholeChromePeakMedianMiB.toFixed(2)),
      wholeChromePeakRatio: ratio(
        imageWholeChromePeakMedianMiB,
        pureWholeChromePeakMedianMiB,
      ),
      assetBytesRatio: ratio(imageAssetBytesMedian, pureAssetBytesMedian),
      imageBitmapHeartbeatP95Ms: median(imageBitmap.map((result) =>
        result.normalizer.productiveReceipt?.heartbeatP95Ms ?? Number.POSITIVE_INFINITY
      )),
    },
    results,
  };
  console.log(
    `ATLCLI_PRODUCTIVE_IMAGE_BITMAP_RATCHET_RESULT\n${JSON.stringify(report, null, 2)}`,
  );
  const reportPath = testInfo.outputPath("productive-image-bitmap-ratchet.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("productive-image-bitmap-ratchet", {
    path: reportPath,
    contentType: "application/json",
  });

  expect(pure).toHaveLength(runCount);
  expect(imageBitmap).toHaveLength(runCount);
  expect(new Set(results.map((result) => result.input.manifestSha256)).size).toBe(1);
  expect(new Set(pure.map((result) => result.output.outputAssetSha256)).size).toBe(1);
  expect(new Set(imageBitmap.map((result) => result.output.outputAssetSha256)).size).toBe(1);
  expect(new Set(pure.map((result) => result.compiler.pdfSha256)).size).toBe(1);
  expect(new Set(imageBitmap.map((result) => result.compiler.pdfSha256)).size).toBe(1);
  expect(new Set(results.map((result) => result.output.images)).size).toBe(1);
  for (const result of results) {
    expect(result.output.manifestSha256).toBe(result.input.manifestSha256);
    expect(result.output.normalizedCalls).toBeGreaterThan(0);
    expect(result.compiler.tagged).toBe(true);
    expect(result.normalizer.workerTargetReleased).toBe(true);
  }
  for (const result of imageBitmap) {
    expect(result.normalizer.productiveReceipt).toMatchObject({
      schema: "atlcli.extension-raster-normalizer-receipt/1",
      backend: "image-bitmap",
      revision: "image-bitmap-v1",
      workerStarted: true,
      requests: result.output.normalizedCalls + result.output.keptCalls,
      normalized: result.output.normalizedCalls,
      kept: result.output.keptCalls,
      outcome: "released",
    });
    expect(result.normalizer.productiveReceipt?.heartbeatSamples).toBeGreaterThan(0);
    expect(result.normalizer.productiveReceipt?.heartbeatP95Ms).not.toBeNull();
    if (assertTiming) {
      expect(result.normalizer.productiveReceipt!.heartbeatP95Ms!).toBeLessThan(50);
    }
    expect(result.normalizer.productiveReceipt!.cacheHits).toBeGreaterThan(0);
  }
  if (assertTiming) {
    expect(ratio(imagePrepareMedianMs, purePrepareMedianMs)).toBeLessThanOrEqual(0.60);
  }
  expect(ratio(
    imageNormalizerPeakMedianMiB,
    pureNormalizerPeakMedianMiB,
  )).toBeLessThanOrEqual(1.15);
  expect(imageCleanupResidualMedianMiB).toBeLessThanOrEqual(32);
  expect(ratio(imageTypstPeakMedianMiB, pureTypstPeakMedianMiB)).toBeLessThanOrEqual(1.10);
  expect(ratio(
    imageWholeChromePeakMedianMiB,
    pureWholeChromePeakMedianMiB,
  )).toBeLessThanOrEqual(1.10);
  expect(ratio(imageAssetBytesMedian, pureAssetBytesMedian)).toBeLessThanOrEqual(1.10);
});

test("ratchets raster-normalizer paths 1-4 in the real MV3 PDF pipeline", async () => {
  test.setTimeout(3_600_000);
  const allVariants: RasterNormalizerVariant[] = [
    "pure-ts",
    "webcodecs",
    "image-bitmap",
    "pica",
  ];
  const requestedVariant = process.env.ATLCLI_RASTER_VARIANT as
    | RasterNormalizerVariant
    | undefined;
  if (requestedVariant && !allVariants.includes(requestedVariant)) {
    throw new Error(`Unknown ATLCLI_RASTER_VARIANT=${requestedVariant}.`);
  }
  const variants = requestedVariant ? [requestedVariant] : allVariants;
  const results: RasterNormalizerVariantResult[] = [];
  const failures: Array<{ variant: RasterNormalizerVariant; error: string }> = [];
  for (const variant of variants) {
    try {
      const result = await runRasterNormalizerVariant(variant);
      results.push(result);
      console.log(
        `ATLCLI_RASTER_NORMALIZER_VARIANT_RESULT\n${JSON.stringify(result, null, 2)}`,
      );
    } catch (error) {
      failures.push({
        variant,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  }
  const report = {
    schema: "atlcli.chrome-raster-normalizer-ratchet/v1",
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch },
    results,
    failures,
  };
  console.log(`ATLCLI_RASTER_NORMALIZER_RATCHET_RESULT\n${JSON.stringify(report, null, 2)}`);

  // Structural ratchet: unsupported candidates are recorded, but the current
  // lane must stay healthy and every successful candidate must traverse the
  // same ≥100 MiB corpus, produce a tagged PDF, and release its worker target.
  const reference = results.find((result) => result.variant === "pure-ts") ?? results[0];
  expect(reference).toBeDefined();
  if (!requestedVariant) expect(reference!.variant).toBe("pure-ts");
  for (const result of results) {
    expect(result.input.manifestSha256).toBe(reference!.input.manifestSha256);
    expect(result.output.manifestSha256).toBe(result.input.manifestSha256);
    expect(result.output.normalizedCalls).toBeGreaterThan(0);
    expect(result.output.bundleBytes).toBeLessThan(result.input.sourceAssetBytes * 0.75);
    expect(result.compiler.tagged).toBe(true);
    expect(result.compiler.attribution.basis).not.toBe("wasm-unavailable");
    expect(result.normalizer.workerTargetReleased).toBe(true);
    if (result.input.scale === 1) {
      expect(result.input.sourceAssetBytes).toBeGreaterThanOrEqual(100 * MIB);
    }
    if (result.variant !== "pure-ts" && result.variant !== "pure-worker") {
      expect(result.normalizer.phaseSamples).toHaveLength(8);
      expect(new Set(result.normalizer.phaseSamples.map((sample) => sample.detail?.sourceFormat)))
        .toEqual(new Set(["png", "jpeg"]));
    }
  }
  const outputAssetCounts = new Set(results.map((result) => result.output.images));
  const normalizedCallCounts = new Set(results.map((result) => result.output.normalizedCalls));
  expect(outputAssetCounts.size).toBe(1);
  expect(normalizedCallCounts.size).toBe(1);
});

test("measures the standard profile against original on the image-heavy corpus (issue #118 P1)", async () => {
  test.setTimeout(3_600_000);
  const original = await runImageHeavyCycle("original");
  const standard = await runImageHeavyCycle("standard");
  const reduction = 1 - standard.attribution.peak.totalMiB / original.attribution.peak.totalMiB;
  const report = {
    schema: "atlcli.chrome-memory-image-profile/v1",
    measuredAt: new Date().toISOString(),
    corpus: {
      scale: original.fixture.scale,
      manifestSha256: original.fixture.manifestSha256,
    },
    original: {
      bundleMiB: mib(original.fixture.bundleBytes),
      pdfMiB: mib(original.pdfBytes),
      peak: original.attribution.peak,
      wasmHighWaterMiB: original.attribution.wasmHighWaterMiB,
    },
    standard: {
      bundleMiB: mib(standard.fixture.bundleBytes),
      pdfMiB: mib(standard.pdfBytes),
      peak: standard.attribution.peak,
      wasmHighWaterMiB: standard.attribution.wasmHighWaterMiB,
      prepareNotes: standard.fixture.notes,
    },
    peakReduction: Number(reduction.toFixed(4)),
  };
  console.log(`ATLCLI_CHROME_MEMORY_IMAGE_PROFILE_RESULT\n${JSON.stringify(report, null, 2)}`);

  if (original.fixture.scale === 1) {
    // The plan's product bar: 'standard' must cut the image-heavy peak by at
    // least 40% before documentation recommends it for large trees.
    expect(reduction).toBeGreaterThanOrEqual(0.4);
    expect(standard.fixture.bundleBytes).toBeLessThan(original.fixture.bundleBytes * 0.75);
  }
  expect(standard.attribution.basis).not.toBe("wasm-unavailable");
  expect(standard.attribution.wasmMonotonicGrowth).toBe(true);
});

test("records image-heavy corpus host-versus-WASM attribution (issue #118 gate input)", async () => {
  test.setTimeout(1_800_000);
  let harness: Harness | undefined;
  let workerSession: ChildTargetSession | undefined;
  try {
    harness = await openHarness();
    const { page, cdp, browserVersion } = harness;

    const baseline = await pageHeap(cdp);
    const fixture = await page.evaluate(() => window.atlcliMemoryProbe.prepareCorpusFixture());
    expect(fixture.notes).toBe(0);
    expect(fixture.assetBytes).toBeGreaterThanOrEqual(fixture.minAggregateBytes);
    const prepared = await pageHeap(cdp);

    await page.evaluate(() => window.atlcliMemoryProbe.storePreparedJob());
    const stored = await pageHeap(cdp);

    await page.evaluate(() => window.atlcliMemoryProbe.startWorker());
    await waitForPhase(page, "warm", 300_000);
    workerSession = await attachCompilerWorker(cdp);
    const workerWarm = await workerSession.heap();
    const warmDetail = await workerDetail(page, "warm");

    await page.evaluate(() => window.atlcliMemoryProbe.startCompile());
    await waitForPhase(page, "bundle-received", 300_000);
    const workerBundle = await workerSession.heap();
    const bundleDetail = await workerDetail(page, "bundle-received");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "vfs-ready", 300_000);
    const workerVfs = await workerSession.heap();
    const vfsDetail = await workerDetail(page, "vfs-ready");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "compiled-held", 1_200_000);
    const workerCompiled = await workerSession.heap();
    const compiledDetail = await workerDetail(page, "compiled-held");
    await page.evaluate(() => window.atlcliMemoryProbe.continueWorker());
    await waitForPhase(page, "complete", 600_000);
    const workerComplete = await workerSession.heap();
    const completeDetail = await workerDetail(page, "complete");

    const workerAttribution = computeWorkerMemoryAttribution([
      attributionSample("warm", workerWarm, warmDetail),
      attributionSample("bundle-received", workerBundle, bundleDetail),
      attributionSample("vfs-ready", workerVfs, vfsDetail),
      attributionSample("compiled-held", workerCompiled, compiledDetail),
      attributionSample("complete", workerComplete, completeDetail),
    ]);
    const compiled = await page.evaluate(() => window.atlcliMemoryProbe.readCompiledResult());

    // Phase 0.5 delivery A/B: the old array+Blob shape versus the productive
    // chunk-granular Blob handle, each sampled while HELD (pending anchor).
    const beforeArrayDelivery = await pageHeap(cdp);
    await page.evaluate(() => window.atlcliMemoryProbe.deliverArrayShape());
    // Retention self-check at sample time: a bundler that dead-code-eliminates
    // the hold would zero this and silently fake a win.
    expect(
      await page.evaluate(() => window.atlcliMemoryProbe.deliveredState()),
    ).toEqual({ arrayBytes: compiled.byteLength, blobBytes: compiled.byteLength });
    const arrayDeliveryHeld = await pageHeap(cdp);
    await page.evaluate(() => window.atlcliMemoryProbe.releaseDelivery());
    const beforeHandleDelivery = await pageHeap(cdp);
    await page.evaluate(() => window.atlcliMemoryProbe.deliverHandleShape());
    expect(
      await page.evaluate(() => window.atlcliMemoryProbe.deliveredState()),
    ).toEqual({ arrayBytes: 0, blobBytes: compiled.byteLength });
    const handleDeliveryHeld = await pageHeap(cdp);
    await page.evaluate(() => window.atlcliMemoryProbe.releaseDelivery());

    const report = {
      schema: "atlcli.chrome-memory-image-heavy/v1",
      measuredAt: new Date().toISOString(),
      runtime: browserVersion,
      corpus: {
        ...fixture,
        assetMiB: mib(fixture.assetBytes),
        bundleMiB: mib(fixture.bundleBytes),
        pdfBytes: compiled.byteLength,
        pdfMiB: mib(compiled.byteLength),
      },
      panel: {
        prepareFromBaseline: delta(baseline, prepared),
        storedFromBaseline: delta(baseline, stored),
        deliveryArrayShape: delta(beforeArrayDelivery, arrayDeliveryHeld),
        deliveryHandleShape: delta(beforeHandleDelivery, handleDeliveryHeld),
      },
      offscreenWorker: {
        bundleRead: delta(workerWarm, workerBundle),
        vfsLoaded: delta(workerWarm, workerVfs),
        compiledPdfHeld: delta(workerWarm, workerCompiled),
        completed: delta(workerWarm, workerComplete),
      },
      workerAttribution,
    };
    console.log(`ATLCLI_CHROME_MEMORY_IMAGE_HEAVY_RESULT\n${JSON.stringify(report, null, 2)}`);

    // Structural gate-input assertions only: the attribution must be
    // measurable and internally consistent. Whether the host share clears the
    // plan's threshold is a review decision recorded in PLAN.md, not a test.
    expect(report.workerAttribution.basis).not.toBe("wasm-unavailable");
    expect(report.workerAttribution.wasmMonotonicGrowth).toBe(true);
    expect(report.workerAttribution.peak.wasmShare).toBeGreaterThan(0);
    expect(report.workerAttribution.peak.hostShare + report.workerAttribution.peak.wasmShare)
      .toBeCloseTo(1, 2);
    if (fixture.scale === 1) {
      // The measurement only counts if the corpus really exceeded the product
      // caps that the benchmark-only seams unlock.
      expect(fixture.bundleBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(fixture.assetBytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);
      // Phase 0.5 delivery conclusion: the old shape retains roughly the
      // whole artifact in the panel heap; the Blob-handle shape retains no
      // more than chunk-scale bytes.
      expect(report.panel.deliveryArrayShape.backingMiB).toBeGreaterThan(
        report.corpus.pdfMiB * 0.8,
      );
      expect(report.panel.deliveryHandleShape.backingMiB).toBeLessThan(8);
      expect(report.panel.deliveryHandleShape.usedMiB).toBeLessThan(8);
    }
    await page.evaluate(() => window.atlcliMemoryProbe.cleanup());
    await cdp.detach();
  } finally {
    await workerSession?.close().catch(() => undefined);
    await closeHarness(harness);
  }
});
