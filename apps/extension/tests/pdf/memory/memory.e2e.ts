import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWorkerMemoryAttribution } from "./attribution.js";
import type { MemoryProbeApi, MemoryWorkerPhase } from "./protocol.js";

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
  const context = await chromium.launchPersistentContext(profileDir, {
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
