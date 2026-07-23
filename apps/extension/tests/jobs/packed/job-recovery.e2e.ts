import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");
const JOB_A = "123e4567-e89b-42d3-a456-426614174000";
const JOB_B = "223e4567-e89b-42d3-a456-426614174000";
const JOB_C = "323e4567-e89b-42d3-a456-426614174000";
const LEGACY = "423e4567-e89b-42d3-a456-426614174000";

let context: BrowserContext;
let extensionId: string;
let suiteRoot: string;
let baseExtensionDir: string;
let page: Page;

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
  });
});

test.afterAll(async () => {
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

async function seedJob(id: string, state: "queued" | "running"): Promise<void> {
  await page.evaluate(async ({ jobId, jobState }) => {
    const request = {
      schema: "atlcli.export-job-request/1",
      id: jobId,
      idempotencyKey: `idem:${jobId}`,
      format: "docx",
      renderer: "docx-typescript",
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "space-key", spaceKey: "DOCS" },
        scope: { kind: "space" },
      },
      authRef: "profile:default",
      displayName: jobId,
      createdAt: 1,
      priority: "interactive",
      output: { policy: "collect" },
      template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
      options: { embedImages: true, resolveMacros: true },
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
      format: "docx",
      renderer: "docx-typescript",
      summary: { displayName: jobId, sourceLabel: "DOCS", siteOrigin: "https://site.atlassian.net", scopeKind: "space" },
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
  }, { jobId: id, jobState: state });
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

test("a blocked upgrade timeout cannot commit later after the blocker closes", async () => {
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
  await seedJob(JOB_A, "queued");
  const responses = await Promise.all([sendWake([JOB_A]), sendWake([JOB_A])]);
  expect(responses.filter((response) => response.claimedJobId === JOB_A)).toHaveLength(1);
  expect(await readJob(JOB_A)).toMatchObject({
    snapshot: { state: "running", leaseEpoch: 1, attempt: 1, recoveryCount: 0 },
  });
});

test("a real service-worker restart reconstructs expired checkpointed work", async () => {
  await ensureCatalog();
  await seedJob(JOB_B, "queued");
  await expect(sendWake([JOB_B])).resolves.toMatchObject({ claimedJobId: JOB_B });
  const initiallyClaimed = await readJob(JOB_B);
  expect(initiallyClaimed.snapshot).toMatchObject({ state: "running", leaseEpoch: 1, attempt: 1 });
  const originalOwner = initiallyClaimed.snapshot.lease?.ownerId;
  expect(originalOwner).toMatch(/^offscreen:/);
  await checkpointAndExpire(JOB_B);

  const session = await context.newCDPSession(page);
  const worker = (await getTargets(session)).find(
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(worker).toBeDefined();
  await session.send("Target.closeTarget", { targetId: worker!.targetId });
  await waitForTargetGone(session, worker!.targetId);

  const response = await sendWake([JOB_B]);
  expect(response.claimedJobId).toBe(JOB_B);
  const replacement = await waitForRestartedTarget(
    session,
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(replacement.url.startsWith(`chrome-extension://${extensionId}/`)).toBe(true);
  expect(await readJob(JOB_B)).toMatchObject({
    snapshot: {
      state: "running",
      leaseEpoch: 2,
      attempt: 2,
      recoveryCount: 1,
      lease: { ownerId: originalOwner },
    },
  });
});

test("a real offscreen-document restart reconstructs expired checkpointed work", async () => {
  await ensureCatalog();
  await seedJob(JOB_C, "queued");
  await expect(sendWake([JOB_C])).resolves.toMatchObject({ claimedJobId: JOB_C });
  const initiallyClaimed = await readJob(JOB_C);
  const originalOwner = initiallyClaimed.snapshot.lease?.ownerId;
  expect(originalOwner).toMatch(/^offscreen:/);
  await checkpointAndExpire(JOB_C);

  const session = await context.newCDPSession(page);
  const offscreen = (await getTargets(session)).find(
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  expect(offscreen).toBeDefined();
  await session.send("Target.closeTarget", { targetId: offscreen!.targetId });
  await waitForTargetGone(session, offscreen!.targetId);

  const response = await sendWake([JOB_C]);
  expect(response.claimedJobId).toBe(JOB_C);
  const replacement = await waitForRestartedTarget(
    session,
    (target) => target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  expect(replacement.url).toBe(`chrome-extension://${extensionId}/offscreen.html`);
  const recovered = await readJob(JOB_C);
  expect(recovered).toMatchObject({
    snapshot: { state: "running", leaseEpoch: 2, attempt: 2, recoveryCount: 1 },
  });
  expect(recovered.snapshot.lease?.ownerId).toMatch(/^offscreen:/);
  expect(recovered.snapshot.lease?.ownerId).not.toBe(originalOwner);
});

test("a private legacy compiler bridge produces one outer Activity row", async () => {
  await ensureCatalog();
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
