import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, para } from "@atlcli/docx/fixtures";

const EXTENSION_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");
const JOB_A = "123e4567-e89b-42d3-a456-426614174000";
const JOB_B = "223e4567-e89b-42d3-a456-426614174000";
const JOB_C = "323e4567-e89b-42d3-a456-426614174000";
const LEGACY = "423e4567-e89b-42d3-a456-426614174000";
const JOB_D = "723e4567-e89b-42d3-a456-426614174000";
const JOB_E = "823e4567-e89b-42d3-a456-426614174000";
const JOB_F = "923e4567-e89b-42d3-a456-426614174000";
const JOB_G = "a23e4567-e89b-42d3-a456-426614174000";
const JOB_H = "b23e4567-e89b-42d3-a456-426614174000";

let context: BrowserContext;
let extensionId: string;
let suiteRoot: string;
let baseExtensionDir: string;
let page: Page;
let packedOffscreen: ChildTargetSession | undefined;

class ChildTargetSession {
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  constructor(
    private readonly root: CDPSession,
    readonly sessionId: string,
  ) {
    root.on("Target.receivedMessageFromTarget", this.onMessage);
  }

  private readonly onMessage = (event: { sessionId: string; message: string }): void => {
    if (event.sessionId !== this.sessionId) return;
    const message = JSON.parse(event.message) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "Target CDP error."));
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
    void this.root.send("Target.sendMessageToTarget", {
      sessionId: this.sessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch((error) => {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      waiter?.reject(error);
    });
    return response;
  }

  async close(): Promise<void> {
    this.root.off("Target.receivedMessageFromTarget", this.onMessage);
    await this.root.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => undefined);
    await this.root.detach().catch(() => undefined);
  }
}

async function installOffscreenFetchStub(
  holdPageIds: string[] = [],
  storageByPageId: Record<string, string> = {},
): Promise<void> {
  await packedOffscreen?.close();
  const root = await context.newCDPSession(page);
  const target = (await getTargets(root)).find(
    (entry) => entry.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  if (!target) throw new Error("Packed offscreen target was not found.");
  const attached = await root.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  }) as { sessionId: string };
  packedOffscreen = new ChildTargetSession(root, attached.sessionId);
  const expression = `(() => {
    const held = new Set(${JSON.stringify(holdPageIds)});
    const storageByPageId = ${JSON.stringify(storageByPageId)};
    const releases = Object.create(null);
    globalThis.__atlcliPackedFetchReleases = releases;
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const match = url.pathname.match(/\\/rest\\/api\\/content\\/([^/]+)/);
      if (!match) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      const pageId = decodeURIComponent(match[1]);
      if (held.has(pageId)) {
        await new Promise((resolve) => { releases[pageId] = resolve; });
      }
      return new Response(JSON.stringify({
        id: pageId,
        type: "page",
        title: "Packed page " + pageId,
        body: { storage: { value: storageByPageId[pageId] || "<p>Hello from packed Chromium</p>" } },
        version: { number: 1, when: "2026-07-23T00:00:00.000Z" },
        space: { key: "DOCS" },
        ancestors: [],
        metadata: { labels: { results: [] }, properties: {} },
        history: { createdDate: "2026-07-23T00:00:00.000Z" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return true;
  })()`;
  const result = await packedOffscreen.send<{
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails || result.result?.value !== true) {
    throw new Error(`Could not install packed offscreen fetch stub: ${JSON.stringify(result)}`);
  }
}

async function releaseOffscreenFetch(pageId: string): Promise<void> {
  if (!packedOffscreen) throw new Error("Packed offscreen target is not attached.");
  await packedOffscreen.send("Runtime.evaluate", {
    expression: `globalThis.__atlcliPackedFetchReleases?.[${JSON.stringify(pageId)}]?.()`,
    returnByValue: true,
  });
}

test.beforeAll(async () => {
  suiteRoot = mkdtempSync(join(tmpdir(), "atlcli-export-jobs-extension-"));
  baseExtensionDir = join(suiteRoot, "base-extension");
  mkdirSync(baseExtensionDir, { recursive: true });
  cpSync(OUTPUT_DIR, baseExtensionDir, { recursive: true });
  const probeSource = fileURLToPath(new URL("job-store-probe.ts", import.meta.url));
  const probeBuild = spawnSync("bun", [
    "build",
    probeSource,
    "--target=browser",
    "--conditions=development",
    "--conditions=browser",
    "--outfile",
    join(baseExtensionDir, "job-store-probe.js"),
  ], { cwd: EXTENSION_ROOT, encoding: "utf8" });
  if (probeBuild.status !== 0) throw new Error(`Packed job probe build failed: ${probeBuild.stderr}`);
  writeFileSync(
    join(baseExtensionDir, "job-probe.html"),
    "<!doctype html><meta charset=utf-8><title>Export job probe</title><script type=module src=job-store-probe.js></script>",
  );
  const userDataDir = join(suiteRoot, "profile");
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${baseExtensionDir}`, `--load-extension=${baseExtensionDir}`],
  });
  let serviceWorker = context.serviceWorkers()[0];
  serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
  extensionId = new URL(serviceWorker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/job-probe.html`);
  await page.waitForFunction(() => "exportJobStoreProbe" in globalThis);
});

test.beforeEach(async () => {
  await packedOffscreen?.close();
  packedOffscreen = undefined;
  await page.evaluate(async () => {
    async function deleteDatabase(name: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`IndexedDB cleanup for ${name} was blocked.`));
      });
    }
    await deleteDatabase("atlcli-export-jobs");
    await deleteDatabase("atlcli-pdf");
    await deleteDatabase("atlcli-docx");
  });
  await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: { resetBadge(initialize?: boolean): Promise<void> };
    }).exportJobStoreProbe;
    await probe.resetBadge(false);
  });
});

test.afterAll(async () => {
  await packedOffscreen?.close();
  await context?.close();
  rmSync(suiteRoot, { recursive: true, force: true });
});

async function sendWake(ids?: string[]): Promise<{ kind: string; claimedJobId?: string }> {
  return page.evaluate(async (jobIds) => {
    const chromeApi = (globalThis as unknown as { chrome: { runtime: { sendMessage(value: unknown): Promise<unknown> } } }).chrome;
    return chromeApi.runtime.sendMessage({ kind: "jobs:wake", ...(jobIds ? { jobIds } : {}) }) as Promise<{ kind: string; claimedJobId?: string }>;
  }, ids);
}

async function ensureCatalog(): Promise<void> {
  await expect(sendWake()).resolves.toEqual({ kind: "jobs:wake-result" });
}

interface PackedBadgeSnapshot {
  text: string;
  color: number[];
  state?: {
    initialized?: boolean;
    pulseSequence?: number;
    seenTransitions?: string[];
  };
  pulseEnabled: boolean;
}

interface PackedBadgeScenario {
  activeIds: string[];
  failedId: string;
  succeededId: string;
}

async function readBadge(): Promise<PackedBadgeSnapshot> {
  return page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        badgeSnapshot(): Promise<PackedBadgeSnapshot>;
      };
    }).exportJobStoreProbe;
    return probe.badgeSnapshot();
  });
}

async function seedBadgeScenario(): Promise<PackedBadgeScenario> {
  return page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        seedBadgeScenario(): Promise<PackedBadgeScenario>;
      };
    }).exportJobStoreProbe;
    return probe.seedBadgeScenario();
  });
}

async function initializeBadge(): Promise<void> {
  await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: { resetBadge(initialize?: boolean): Promise<void> };
    }).exportJobStoreProbe;
    await probe.resetBadge(true);
  });
  await expect.poll(async () => {
    const snapshot = await readBadge();
    return {
      text: snapshot.text,
      initialized: snapshot.state?.initialized,
      pulseSequence: snapshot.state?.pulseSequence,
    };
  }).toEqual({
    text: "",
    initialized: true,
    pulseSequence: 0,
  });
}

async function submitPackedDocx(
  jobId: string,
  templateBytes: Uint8Array,
  sourcePageId = jobId,
): Promise<string> {
  return page.evaluate(async ({ id, sourceId, template }) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        submitDocx(
          jobId: string,
          templateValues: number[],
          sourcePageId?: string,
        ): Promise<string>;
      };
    }).exportJobStoreProbe;
    return probe.submitDocx(id, template, sourceId);
  }, {
    id: jobId,
    sourceId: sourcePageId,
    template: [...templateBytes],
  });
}

async function seedJob(
  id: string,
  state: "queued" | "running",
  options: { sourcePageId?: string; displayName?: string } = {},
): Promise<void> {
  await page.evaluate(async ({ jobId, jobState, sourcePageId, displayName }) => {
    const request = {
      schema: "atlcli.export-job-request/1",
      id: jobId,
      idempotencyKey: `idem:${jobId}`,
      format: "pdf",
      renderer: "pdf-typst",
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: sourcePageId, version: 1 },
        scope: { kind: "page" },
      },
      authRef: "session:https://site.atlassian.net",
      displayName,
      requestedFilename: `${displayName}.pdf`,
      createdAt: 1,
      priority: "interactive",
      output: { policy: "collect" },
      template: { id: "builtin.editorial-indigo", manifestVersion: "1.0.0" },
      settings: {},
      options: { resolveMacros: true, exportedAt: 1 },
    };
    const emptyStats = {
      pages: { discovered: 0, fetched: 0, composed: 0, skipped: 0 },
      assets: { discovered: 0, fetched: 0, embedded: 0, skipped: 0, deduplicated: 0, logicalBytes: 0, physicalBytes: 0 },
      diagrams: { discovered: 0, rendered: 0, rasterized: 0, failed: 0 },
      macros: { discovered: 0, rendered: 0, approximated: 0, unresolved: 0 },
      retries: { total: 0, rateLimited: 0, network: 0, worker: 0 },
      storage: { spoolBytes: 0, spoolPeakBytes: null, outputBytes: 0 },
      memory: { heapPeakBytes: null, rendererPeakBytes: null },
      metricSupport: {}, durationsMs: {}, warnings: 0, errors: 0,
    };
    const running = jobState === "running";
    const snapshot = {
      schema: "atlcli.export-job/1",
      id: jobId,
      revision: running ? 2 : 0,
      requestRef: `request:${jobId}`,
      format: "pdf",
      renderer: "pdf-typst",
      summary: { displayName, sourceLabel: sourcePageId, siteOrigin: "https://site.atlassian.net", scopeKind: "page" },
      queue: { priority: "interactive", enqueuedAt: 1, groupKey: "https://site.atlassian.net" },
      state: jobState,
      attempt: running ? 1 : 0,
      recoveryCount: 0,
      leaseEpoch: running ? 1 : 0,
      ...(running ? {
        startedAt: 1,
        checkpointRef: `checkpoint:${jobId}:1`,
        lease: { ownerId: "dead-offscreen", epoch: 1, acquiredAt: 1, heartbeatAt: 1, expiresAt: 2 },
      } : {}),
      stats: emptyStats,
      createdAt: 1,
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["jobs", "requests"], "readwrite");
      tx.objectStore("requests").add({ ref: `request:${jobId}`, request });
      tx.objectStore("jobs").add({
        id: jobId,
        idempotencyKey: `idem:${jobId}`,
        authRef: "profile:default",
        snapshot,
        nextEventSeq: 1,
        transitions: {},
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, {
    jobId: id,
    jobState: state,
    sourcePageId: options.sourcePageId ?? id,
    displayName: options.displayName ?? id,
  });
}

interface PackedJobRow {
  snapshot: {
    state: string;
    revision: number;
    leaseEpoch: number;
    attempt: number;
    recoveryCount: number;
    checkpointRef?: string;
    lease?: { ownerId: string; epoch: number; expiresAt: number };
    error?: { code: string; message: string; stage?: string };
    artifact?: { ref: string; filename: string; byteLength: number; sha256: string };
    reportRef?: string;
    reportSummary?: { completeness: string };
    deliveredAt?: number;
  };
}

async function readJob(id: string): Promise<PackedJobRow> {
  return page.evaluate(async (jobId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("jobs", "readonly").objectStore("jobs").get(jobId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result as PackedJobRow;
  }, id);
}

async function waitForJobState(id: string, state: string, timeout = 30_000): Promise<PackedJobRow> {
  let row!: PackedJobRow;
  await expect.poll(async () => {
    row = await readJob(id);
    if (row.snapshot.state === "failed" && state !== "failed") {
      throw new Error(`Packed job ${id} failed: ${JSON.stringify(row.snapshot.error)}`);
    }
    return row.snapshot.state;
  }, { timeout }).toBe(state);
  return row;
}

async function checkpointAndExpire(id: string): Promise<PackedJobRow> {
  await page.evaluate(async (jobId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs", 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      const store = tx.objectStore("jobs");
      const read = store.get(jobId);
      read.onsuccess = () => {
        const row = read.result as PackedJobRow & Record<string, unknown>;
        if (!row?.snapshot.lease) {
          tx.abort();
          return;
        }
        store.put({
          ...row,
          snapshot: {
            ...row.snapshot,
            revision: row.snapshot.revision + 1,
            checkpointRef: `checkpoint:${jobId}:${row.snapshot.leaseEpoch}`,
            lease: { ...row.snapshot.lease, expiresAt: 1 },
          },
        });
      };
      read.onerror = () => reject(read.error);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(`Job ${jobId} had no active lease.`));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, id);
  return readJob(id);
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

async function getTargets(session: CDPSession): Promise<TargetInfo[]> {
  const result = await session.send("Target.getTargets") as { targetInfos: TargetInfo[] };
  return result.targetInfos;
}

async function waitForTargetGone(session: CDPSession, targetId: string): Promise<void> {
  await expect.poll(
    async () => (await getTargets(session)).some((target) => target.targetId === targetId),
    { timeout: 10_000 },
  ).toBe(false);
}

async function waitForRestartedTarget(
  session: CDPSession,
  matches: (target: TargetInfo) => boolean,
): Promise<TargetInfo> {
  let restarted: TargetInfo | undefined;
  await expect.poll(async () => {
    restarted = (await getTargets(session)).find(matches);
    return restarted?.targetId;
  }, { timeout: 10_000 }).not.toBeUndefined();
  return restarted!;
}

test("upgrades after a real blocked connection is released", async () => {
  const startedAt = Date.now();
  await page.evaluate(async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs", 1);
      open.onupgradeneeded = () => {
        const jobs = open.result.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
        jobs.createIndex("derivationKey", "derivationKey", { unique: true });
        open.result.createObjectStore("requests", { keyPath: "ref" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    (globalThis as unknown as { oldExportDb: IDBDatabase }).oldExportDb = old;
    setTimeout(() => old.close(), 100);
  });
  await expect(sendWake()).resolves.toEqual({ kind: "jobs:wake-result" });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
  const stores = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open("atlcli-export-jobs", 3);
      open.onsuccess = () => resolve(open.result);
    });
    const result = [...db.objectStoreNames];
    db.close();
    return result;
  });
  expect(stores).toContain("byte-chunks");
  expect(stores).toContain("legacy-bridges");
  expect(stores).toContain("executor-checkpoints");
  expect(stores).toContain("executor-results");
});

test("parallel blocked upgrade opens time out and cannot commit after the blocker closes", async () => {
  await page.evaluate(async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs", 1);
      open.onupgradeneeded = () => {
        const jobs = open.result.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
        jobs.createIndex("derivationKey", "derivationKey", { unique: true });
        open.result.createObjectStore("requests", { keyPath: "ref" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    (globalThis as unknown as { oldExportDb: IDBDatabase }).oldExportDb = old;
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: { resetBadge(initialize?: boolean): Promise<void> };
    }).exportJobStoreProbe;
    // Badge projection and queue wake now contend for the same intentionally
    // blocked upgrade. Both opens need an independent bounded failure.
    await probe.resetBadge(true);
  });

  const startedAt = Date.now();
  await expect(sendWake()).resolves.toEqual({
    kind: "jobs:wake-result",
    error: "The export catalog upgrade is blocked by an older extension context.",
  });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_750);

  const afterLateClose = await page.evaluate(async () => {
    (globalThis as unknown as { oldExportDb: IDBDatabase }).oldExportDb.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
      const open = indexedDB.open("atlcli-export-jobs");
      open.onsuccess = () => {
        const result = { version: open.result.version, stores: [...open.result.objectStoreNames] };
        open.result.close();
        resolve(result);
      };
      open.onerror = () => reject(open.error);
    });
  });
  expect(afterLateClose).toEqual({ version: 1, stores: ["jobs", "requests"] });
});

test("two packed-extension wakeups produce exactly one claim", async () => {
  await ensureCatalog();
  await installOffscreenFetchStub([JOB_A]);
  await seedJob(JOB_A, "queued");
  const responses = await Promise.all([sendWake([JOB_A]), sendWake([JOB_A])]);
  expect(responses.filter((response) => response.claimedJobId === JOB_A)).toHaveLength(1);
  expect(await readJob(JOB_A)).toMatchObject({
    snapshot: { state: "running", leaseEpoch: 1, attempt: 1, recoveryCount: 0 },
  });
  await releaseOffscreenFetch(JOB_A);
  const succeeded = await waitForJobState(JOB_A, "succeeded");
  expect(succeeded.snapshot).toMatchObject({
    artifact: { filename: `${JOB_A}.pdf` },
    reportSummary: { completeness: "complete" },
  });
  if (!succeeded.snapshot.artifact || !succeeded.snapshot.reportRef) {
    throw new Error("Packed PDF did not retain both artifact and report refs.");
  }
  const retained = await page.evaluate(async ({ artifactRef, reportRef }) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        retainedPdf(
          artifactRef: string,
          reportRef: string,
        ): Promise<{ prefix: string; byteLength: number; filename?: string; complete?: boolean }>;
      };
    }).exportJobStoreProbe;
    return probe.retainedPdf(artifactRef, reportRef);
  }, {
    artifactRef: succeeded.snapshot.artifact.ref,
    reportRef: succeeded.snapshot.reportRef,
  });
  expect(retained).toMatchObject({
    prefix: "%PDF-",
    byteLength: succeeded.snapshot.artifact.byteLength,
    filename: `${JOB_A}.pdf`,
    complete: true,
  });
});

test("a real service-worker restart does not interrupt an offscreen PDF job", async () => {
  await ensureCatalog();
  await installOffscreenFetchStub([JOB_B]);
  await seedJob(JOB_B, "queued");
  await expect(sendWake([JOB_B])).resolves.toMatchObject({ claimedJobId: JOB_B });
  const initiallyClaimed = await readJob(JOB_B);
  expect(initiallyClaimed.snapshot).toMatchObject({ state: "running", leaseEpoch: 1, attempt: 1 });
  const originalOwner = initiallyClaimed.snapshot.lease?.ownerId;
  expect(originalOwner).toMatch(/^offscreen:/);

  const session = await context.newCDPSession(page);
  const worker = (await getTargets(session)).find(
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(worker).toBeDefined();
  await session.send("Target.closeTarget", { targetId: worker!.targetId });
  await waitForTargetGone(session, worker!.targetId);

  await expect(sendWake([JOB_B])).resolves.toEqual({ kind: "jobs:wake-result" });
  const replacement = await waitForRestartedTarget(
    session,
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(replacement.url.startsWith(`chrome-extension://${extensionId}/`)).toBe(true);
  await releaseOffscreenFetch(JOB_B);
  const succeeded = await waitForJobState(JOB_B, "succeeded");
  expect(succeeded.snapshot).toMatchObject({
    leaseEpoch: 1,
    attempt: 1,
    recoveryCount: 0,
  });
});

test("a real offscreen-document restart reconstructs expired checkpointed work", async () => {
  await ensureCatalog();
  const parity = { sourcePageId: "packed-parity-page", displayName: "Packed parity guide" };
  await installOffscreenFetchStub([parity.sourcePageId]);
  await seedJob(JOB_C, "queued", parity);
  await expect(sendWake([JOB_C])).resolves.toMatchObject({ claimedJobId: JOB_C });
  const initiallyClaimed = await readJob(JOB_C);
  const originalOwner = initiallyClaimed.snapshot.lease?.ownerId;
  expect(originalOwner).toMatch(/^offscreen:/);

  const session = await context.newCDPSession(page);
  const offscreen = (await getTargets(session)).find(
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  expect(offscreen).toBeDefined();
  await session.send("Target.closeTarget", { targetId: offscreen!.targetId });
  await waitForTargetGone(session, offscreen!.targetId);

  // Recreate the offscreen target while the old lease is still live, install
  // the new target's host stub, then expire and reclaim the durable job.
  await expect(sendWake()).resolves.toEqual({ kind: "jobs:wake-result" });
  const replacement = await waitForRestartedTarget(
    session,
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  await installOffscreenFetchStub();
  await checkpointAndExpire(JOB_C);
  const response = await sendWake([JOB_C]);
  expect(response.claimedJobId).toBe(JOB_C);
  expect(replacement.url).toBe(`chrome-extension://${extensionId}/offscreen.html`);
  const recovered = await waitForJobState(JOB_C, "succeeded");
  expect(recovered).toMatchObject({
    snapshot: { state: "succeeded", leaseEpoch: 2, attempt: 2, recoveryCount: 1 },
  });

  await seedJob(JOB_E, "queued", parity);
  await expect(sendWake([JOB_E])).resolves.toMatchObject({ claimedJobId: JOB_E });
  const uninterrupted = await waitForJobState(JOB_E, "succeeded");
  expect(recovered.snapshot.artifact).toBeDefined();
  expect(uninterrupted.snapshot.artifact).toBeDefined();
  expect({
    sha256: recovered.snapshot.artifact!.sha256,
    byteLength: recovered.snapshot.artifact!.byteLength,
    reportSummary: recovered.snapshot.reportSummary,
  }).toEqual({
    sha256: uninterrupted.snapshot.artifact!.sha256,
    byteLength: uninterrupted.snapshot.artifact!.byteLength,
    reportSummary: uninterrupted.snapshot.reportSummary,
  });
});

test("a private legacy compiler bridge produces one outer Activity row", async () => {
  await ensureCatalog();
  await installOffscreenFetchStub([JOB_A]);
  await seedJob(JOB_A, "queued");
  await expect(sendWake([JOB_A])).resolves.toMatchObject({ claimedJobId: JOB_A });
  await page.evaluate(async ({ legacyId, outerId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("atlcli-pdf", 2);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("jobs", { keyPath: "id" });
        open.result.createObjectStore("bundles", { keyPath: "id" });
        open.result.createObjectStore("results", { keyPath: "id" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      tx.objectStore("jobs").add({
        id: legacyId,
        sourceIdentity: "private-compiler",
        createdAt: Date.now(),
        status: "compiling",
        inputBytes: 1024,
        outputBytes: 0,
        kind: "export",
        activityVisibility: "private",
        parentJobId: outerId,
        parentLeaseEpoch: 1,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        bridge(legacyJobId: string, outerJobId: string, outerLeaseEpoch: number): Promise<void>;
        activityKeys(): Promise<string[]>;
      };
    }).exportJobStoreProbe;
    await probe.bridge(legacyId, outerId, 1);
  }, { legacyId: LEGACY, outerId: JOB_A });
  const keys = await page.evaluate(async () => {
    const probe = (globalThis as unknown as { exportJobStoreProbe: { activityKeys(): Promise<string[]> } }).exportJobStoreProbe;
    return probe.activityKeys();
  });
  expect(keys.filter((key) => key === `common:${JOB_A}` || key === `legacy-pdf:${LEGACY}`)).toEqual([
    `common:${JOB_A}`,
  ]);
  await page.evaluate(async ({ legacyId, outerId }) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        removeBridge(
          legacyJobId: string,
          outerJobId: string,
          outerLeaseEpoch: number,
        ): Promise<void>;
      };
    }).exportJobStoreProbe;
    await probe.removeBridge(legacyId, outerId, 1);
  }, { legacyId: LEGACY, outerId: JOB_A });
  await releaseOffscreenFetch(JOB_A);
  await waitForJobState(JOB_A, "succeeded");
});

test("a submitted PDF survives extension-surface navigation, tab change, and close", async () => {
  await ensureCatalog();
  await installOffscreenFetchStub([JOB_D]);
  const submitter = await context.newPage();
  await submitter.goto(`chrome-extension://${extensionId}/job-probe.html`);
  await submitter.waitForFunction(() => "exportJobStoreProbe" in globalThis);
  await submitter.bringToFront();
  await expect(submitter.evaluate(async (jobId) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: { submitPdf(id: string): Promise<string> };
    }).exportJobStoreProbe;
    return probe.submitPdf(jobId);
  }, JOB_D)).resolves.toBe(JOB_D);
  await waitForJobState(JOB_D, "running");

  // The submitting extension surface navigates away, another tab becomes
  // active, and the original surface closes. Only the offscreen owner remains.
  await submitter.goto("about:blank");
  await page.bringToFront();
  await submitter.close();
  await releaseOffscreenFetch(JOB_D);

  const succeeded = await waitForJobState(JOB_D, "succeeded");
  expect(succeeded.snapshot).toMatchObject({
    state: "succeeded",
    artifact: { filename: `Packed page ${JOB_D}.pdf` },
  });
  expect(succeeded.snapshot.deliveredAt).toBeUndefined();
});

test("packed Activity and toolbar project mixed PDF/DOCX states durably", async () => {
  await initializeBadge();
  const fixture = await seedBadgeScenario();
  await expect.poll(async () => {
    const snapshot = await readBadge();
    return {
      text: snapshot.text,
      pulseSequence: snapshot.state?.pulseSequence,
    };
  }).toEqual({ text: "9+", pulseSequence: 1 });

  // Four 160 ms color frames are finite. Afterwards the active color remains
  // stable while the one durable pulse checkpoint stays at sequence 1.
  await new Promise((resolve) => setTimeout(resolve, 850));
  const settled = await readBadge();
  expect(settled).toMatchObject({
    text: "9+",
    color: [12, 102, 228, 255],
    state: { pulseSequence: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(await readBadge()).toMatchObject({
    text: "9+",
    color: [12, 102, 228, 255],
    state: { pulseSequence: 1 },
  });

  const activity = await context.newPage();
  await activity.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await activity.getByTestId("nav-activity").click();
  await expect(activity.getByTestId("activity-screen")).toBeVisible();
  await expect(activity.getByTestId("job-row")).toHaveCount(12);
  const activityText = await activity.getByTestId("activity-screen").innerText();
  expect(activityText).toContain("PDF");
  expect(activityText).toContain("DOCX");

  // Opening and reading Activity is not acknowledgement.
  expect(await readBadge()).toMatchObject({
    text: "9+",
    state: { pulseSequence: 1 },
  });
  await page.evaluate(async (ids) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        cancelBadgeJobs(jobIds: string[]): Promise<void>;
      };
    }).exportJobStoreProbe;
    await probe.cancelBadgeJobs(ids);
  }, fixture.activeIds);
  await expect.poll(async () => (await readBadge()).text).toBe("!");

  const failureRow = activity.locator(
    `[data-job-id="common:${fixture.failedId}"]`,
  );
  await failureRow.getByTestId("job-detail-open").click();
  await expect(activity.getByTestId("job-detail")).toBeVisible();
  await expect.poll(async () => (await readBadge()).text).toBe("✓");
  await activity.getByTestId("job-detail-close").click();

  const successRow = activity.locator(
    `[data-job-id="common:${fixture.succeededId}"]`,
  );
  const download = activity.waitForEvent("download");
  await successRow.getByTestId("job-download").click();
  expect((await download).suggestedFilename()).toBe(
    "packed-badge-success.pdf",
  );
  await expect.poll(async () => (await readBadge()).text).toBe("");
  await activity.close();
});

test("packed toolbar pulse preference preserves static truth without animation", async () => {
  await initializeBadge();
  await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        setBadgePulseEnabled(enabled: boolean): Promise<void>;
      };
    }).exportJobStoreProbe;
    await probe.setBadgePulseEnabled(false);
  });
  const fixture = await seedBadgeScenario();
  await expect.poll(async () => {
    const snapshot = await readBadge();
    return {
      text: snapshot.text,
      pulseEnabled: snapshot.pulseEnabled,
      pulseSequence: snapshot.state?.pulseSequence,
    };
  }).toEqual({
    text: "9+",
    pulseEnabled: false,
    pulseSequence: 0,
  });
  await page.evaluate(async (ids) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        cancelBadgeJobs(jobIds: string[]): Promise<void>;
      };
    }).exportJobStoreProbe;
    await probe.cancelBadgeJobs(ids);
  }, fixture.activeIds);
  await expect.poll(async () => {
    const snapshot = await readBadge();
    return {
      text: snapshot.text,
      pulseSequence: snapshot.state?.pulseSequence,
    };
  }).toEqual({ text: "!", pulseSequence: 0 });
});

test("packed Retry and Run again preserve originals and replay retained requests", async () => {
  await initializeBadge();
  const fixture = await seedBadgeScenario();
  const result = await page.evaluate(async ({ failedId, succeededId }) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        replayBadgeJobs(
          failure: string,
          success: string,
        ): Promise<{
          retry: {
            route: string;
            format: string;
            template: unknown;
            derivedFrom: unknown;
          };
          rerun: {
            route: string;
            format: string;
            template: unknown;
            derivedFrom: unknown;
          };
          original: {
            failureState?: string;
            successState?: string;
            artifactRef?: string;
            reportRef?: string;
            acknowledgedAt?: number;
          };
        }>;
      };
    }).exportJobStoreProbe;
    return probe.replayBadgeJobs(failedId, succeededId);
  }, fixture);

  expect(result.retry).toMatchObject({
    route: "common:packed-derived-1",
    format: "docx",
    template: {
      recordKey: "packed:badge-template",
      sha256: "1".repeat(64),
    },
    derivedFrom: {
      jobId: fixture.failedId,
      relation: "retry",
      actionKey: "packed-retry-action",
    },
  });
  expect(result.rerun).toMatchObject({
    route: "common:packed-derived-2",
    format: "pdf",
    template: {
      id: "builtin.editorial-indigo",
      manifestVersion: "1.0.0",
    },
    derivedFrom: {
      jobId: fixture.succeededId,
      relation: "rerun",
      actionKey: "packed-rerun-action",
    },
  });
  expect(result.original).toMatchObject({
    failureState: "failed",
    successState: "succeeded",
    artifactRef: expect.any(String),
    reportRef: "report:packed-badge-success",
    acknowledgedAt: expect.any(Number),
  });
});

test("a packed offscreen DOCX runs PizZip, docxtemplater, and canvas diagram rasterization", async () => {
  await ensureCatalog();
  const storage =
    '<p>before</p><ac:structured-macro ac:name="code">' +
    '<ac:parameter ac:name="language">mermaid</ac:parameter>' +
    '<ac:plain-text-body><![CDATA[graph TD\n  A --> B]]></ac:plain-text-body>' +
    '</ac:structured-macro>';
  await installOffscreenFetchStub([], { [JOB_F]: storage });
  const templateBytes = buildDocx({
    body: para("$scroll.title") + para("$scroll.content"),
    date: new Date("2026-07-23T00:00:00.000Z"),
  });
  await expect(submitPackedDocx(JOB_F, templateBytes)).resolves.toBe(JOB_F);

  const succeeded = await waitForJobState(JOB_F, "succeeded");
  expect(succeeded.snapshot).toMatchObject({
    state: "succeeded",
    format: "docx",
    artifact: {
      filename: `Packed page ${JOB_F}.docx`,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    reportSummary: { completeness: "complete" },
  });
  if (!succeeded.snapshot.artifact || !succeeded.snapshot.reportRef) {
    throw new Error("Packed DOCX did not retain both artifact and report refs.");
  }
  const retained = await page.evaluate(async ({ artifactRef, reportRef }) => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        retainedDocx(
          artifactRef: string,
          reportRef: string,
        ): Promise<{
          prefix: number[];
          byteLength: number;
          filename?: string;
          complete?: boolean;
          renderedDiagrams?: number;
        }>;
      };
    }).exportJobStoreProbe;
    return probe.retainedDocx(artifactRef, reportRef);
  }, {
    artifactRef: succeeded.snapshot.artifact.ref,
    reportRef: succeeded.snapshot.reportRef,
  });
  expect(retained).toEqual({
    prefix: [80, 75],
    byteLength: succeeded.snapshot.artifact.byteLength,
    filename: `Packed page ${JOB_F}.docx`,
    complete: true,
    renderedDiagrams: 1,
  });
});

test("a packed offscreen DOCX recovery matches an uninterrupted control export", async () => {
  await ensureCatalog();
  const sourcePageId = "packed-docx-parity-page";
  const storage = "<p>Recovery must preserve these exact DOCX bytes.</p>";
  const templateBytes = buildDocx({
    body: para("$scroll.title") + para("$scroll.content"),
    date: new Date("2026-07-23T00:00:00.000Z"),
  });
  await installOffscreenFetchStub([sourcePageId], {
    [sourcePageId]: storage,
  });
  await expect(
    submitPackedDocx(JOB_G, templateBytes, sourcePageId),
  ).resolves.toBe(JOB_G);
  await waitForJobState(JOB_G, "running");

  const session = await context.newCDPSession(page);
  const offscreen = (await getTargets(session)).find(
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  expect(offscreen).toBeDefined();
  await session.send("Target.closeTarget", { targetId: offscreen!.targetId });
  await waitForTargetGone(session, offscreen!.targetId);

  await expect(sendWake()).resolves.toEqual({ kind: "jobs:wake-result" });
  await waitForRestartedTarget(
    session,
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  await installOffscreenFetchStub([], { [sourcePageId]: storage });
  await checkpointAndExpire(JOB_G);
  await expect(sendWake([JOB_G])).resolves.toMatchObject({
    claimedJobId: JOB_G,
  });
  const recovered = await waitForJobState(JOB_G, "succeeded");
  expect(recovered.snapshot).toMatchObject({
    state: "succeeded",
    format: "docx",
    leaseEpoch: 2,
    attempt: 2,
    recoveryCount: 1,
  });

  await expect(
    submitPackedDocx(JOB_H, templateBytes, sourcePageId),
  ).resolves.toBe(JOB_H);
  const uninterrupted = await waitForJobState(JOB_H, "succeeded");
  expect(recovered.snapshot.artifact).toBeDefined();
  expect(uninterrupted.snapshot.artifact).toBeDefined();
  expect({
    sha256: recovered.snapshot.artifact!.sha256,
    byteLength: recovered.snapshot.artifact!.byteLength,
    reportSummary: recovered.snapshot.reportSummary,
  }).toEqual({
    sha256: uninterrupted.snapshot.artifact!.sha256,
    byteLength: uninterrupted.snapshot.artifact!.byteLength,
    reportSummary: uninterrupted.snapshot.reportSummary,
  });
});

test("the packed browser shares one FIFO heavy-render slot across PDF and DOCX", async () => {
  const result = await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        renderReservations(): Promise<{
          secondWaited: boolean;
          activeAfterHandoff: number;
          activeAfterRelease: number;
        }>;
      };
    }).exportJobStoreProbe;
    return probe.renderReservations();
  });
  expect(result).toEqual({
    secondWaited: true,
    activeAfterHandoff: 1,
    activeAfterRelease: 0,
  });
});

test("the packed browser queue returns after claim and automatically pumps FIFO", async () => {
  const result = await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        queuePump(): Promise<{
          firstClaim: string | undefined;
          duplicateClaim: string | undefined;
          entered: string[];
        }>;
      };
    }).exportJobStoreProbe;
    return probe.queuePump();
  });
  expect(result).toEqual({
    firstClaim: "523e4567-e89b-42d3-a456-426614174000",
    duplicateClaim: undefined,
    entered: [
      "523e4567-e89b-42d3-a456-426614174000",
      "623e4567-e89b-42d3-a456-426614174000",
    ],
  });
});

test("source aborts and adapter quota limits leave no half object", async () => {
  await ensureCatalog();
  const invoke = (id: string, size: number, fail: boolean, totalLimit?: number) => page.evaluate(
    async ({ jobId, byteLength, failAfterFirst, configuredTotal }) => {
      const probe = (globalThis as unknown as {
        exportJobStoreProbe: {
          write(id: string, size: number, fail: boolean, totalLimit?: number): Promise<string>;
          counts(): Promise<{ objects: number; chunks: number }>;
        };
      }).exportJobStoreProbe;
      try {
        await probe.write(jobId, byteLength, failAfterFirst, configuredTotal);
        return { ok: true, counts: await probe.counts() };
      } catch (error) {
        return {
          ok: false,
          name: error instanceof Error ? error.name : "unknown",
          code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
          message: error instanceof Error ? error.message : String(error),
          counts: await probe.counts(),
        };
      }
    },
    { jobId: id, byteLength: size, failAfterFirst: fail, configuredTotal: totalLimit },
  );

  const aborted = await invoke("abort-job", 2048, true);
  expect(aborted).toMatchObject({ ok: false, counts: { objects: 0, chunks: 0 } });

  const configuredQuota = await invoke("configured-quota-job", 64 * 1024, false, 4 * 1024);
  expect(configuredQuota).toMatchObject({ ok: false, code: "total-limit", counts: { objects: 0, chunks: 0 } });
});

test("a native IndexedDB transaction abort rolls back object and chunk together", async () => {
  await ensureCatalog();
  const result = await page.evaluate(async () => {
    const probe = (globalThis as unknown as {
      exportJobStoreProbe: {
        abortTransaction(id: string): Promise<{ aborted: boolean; counts: { objects: number; chunks: number } }>;
      };
    }).exportJobStoreProbe;
    return probe.abortTransaction("native-abort-job");
  });
  expect(result).toEqual({ aborted: true, counts: { objects: 0, chunks: 0 } });
});

test("capability-probes native extension quota without treating it as a gate", async ({}, testInfo) => {
  await ensureCatalog();
  const invoke = (id: string, size: number) => page.evaluate(
    async ({ jobId, byteLength }) => {
      const probe = (globalThis as unknown as {
        exportJobStoreProbe: {
          write(id: string, size: number, fail: boolean, totalLimit?: number): Promise<string>;
          counts(): Promise<{ objects: number; chunks: number }>;
        };
      }).exportJobStoreProbe;
      try {
        await probe.write(jobId, byteLength, false);
        return { ok: true, counts: await probe.counts() };
      } catch (error) {
        return {
          ok: false,
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
          counts: await probe.counts(),
        };
      }
    },
    { jobId: id, byteLength: size },
  );

  const session = await context.newCDPSession(page);
  try {
    await session.send("Storage.overrideQuotaForOrigin", {
      origin: `chrome-extension://${extensionId}`,
      quotaSize: 4 * 1024,
    });
  } catch (error) {
    testInfo.annotations.push({
      type: "native-extension-quota",
      description: `CDP quota override unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  const nativeQuota = await invoke("native-quota-job", 64 * 1024);
  if (nativeQuota.ok) {
    testInfo.annotations.push({
      type: "native-extension-quota",
      description: "Pinned Chromium accepted the write; extension-origin quota override is not enforceable here.",
    });
    await page.evaluate(async () => {
      const probe = (globalThis as unknown as { exportJobStoreProbe: { cleanup(id: string): Promise<void> } }).exportJobStoreProbe;
      await probe.cleanup("native-quota-job");
    });
  } else {
    testInfo.annotations.push({
      type: "native-extension-quota",
      description: "Pinned Chromium enforced the extension-origin quota override.",
    });
    expect(`${nativeQuota.name} ${nativeQuota.message}`).toMatch(/quota/i);
    expect(nativeQuota.counts).toEqual({ objects: 0, chunks: 0 });
  }
});
