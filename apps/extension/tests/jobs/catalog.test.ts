import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type {
  DocxExportJobRequestV1,
  ExportJobStage,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  EXTENSION_EXPORT_DB_NAME,
  EXTENSION_EXPORT_DB_VERSION,
  EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE,
  EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
  IndexedDbExportJobCatalog,
  openExtensionExportDb,
  recoverAndClaimExtensionExportJob,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { createExtensionQueueFoundation } from "../../utils/export-jobs/recovery.js";

globalThis.IDBKeyRange = IDBKeyRange;

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function request(id: string): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
    },
    authRef: "profile:default",
    displayName: `Export ${id}`,
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
    options: { embedImages: true, resolveMacros: true },
  };
}

function pdfRequest(id: string): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id: "42" },
      scope: { kind: "page" },
    },
    authRef: "extension-session:https://site.atlassian.net",
    displayName: `Export ${id}`,
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true, exportedAt: 1 },
  };
}

function rawOpen(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(EXTENSION_EXPORT_DB_NAME, version);
    open.onupgradeneeded = () => upgrade?.(open.result);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function* bytes(...chunks: number[][]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Uint8Array.from(chunk);
}

describe("IndexedDbExportJobCatalog", () => {
  it("creates request and snapshot atomically", async () => {
    const failed = new IndexedDbExportJobCatalog({
      factory,
      afterRequestWrite: () => {
        throw new Error("injected transaction abort");
      },
    });
    await expect(failed.create({ request: request("job-1") })).rejects.toThrow("injected");

    const reopened = new IndexedDbExportJobCatalog({ factory });
    expect(await reopened.get("job-1")).toBeUndefined();
    expect(await reopened.getRequest("request:job-1")).toBeUndefined();
    await expect(reopened.create({ request: request("job-1") })).resolves.toMatchObject({
      id: "job-1",
      state: "queued",
      revision: 0,
    });
  });

  it("serializes duplicate wakeups so exactly one lease wins", async () => {
    const first = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const second = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    await first.create({ request: request("job-1") });

    const claims = await Promise.all([
      first.claimNext({ ownerId: "runner-a", now: 10, leaseDurationMs: 100 }),
      second.claimNext({ ownerId: "runner-b", now: 10, leaseDurationMs: 100 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await first.get("job-1"))?.leaseEpoch).toBe(1);
    expect((await first.get("job-1"))?.attempt).toBe(1);
  });

  it("observes the lease clock after asynchronous catalog entry", async () => {
    let now = 10;
    const store = new IndexedDbExportJobCatalog({ factory, now: () => now });
    await store.create({ request: request("job-1") });

    const pending = store.claimNext({ ownerId: "runner", now, leaseDurationMs: 10 });
    now = 100;
    const claimed = await pending;

    expect(claimed?.lease).toMatchObject({ acquiredAt: 100, heartbeatAt: 100, expiresAt: 110 });
  });

  it("binds one legacy compiler idempotently to the active outer lease", async () => {
    let now = 10;
    const store = new IndexedDbExportJobCatalog({ factory, now: () => now });
    await store.create({ request: request("job-1") });
    const claimed = (await store.claimNext({ ownerId: "runner-a", now, leaseDurationMs: 100 }))!;
    const bridge = {
      legacyJobId: "legacy-a",
      outerJobId: claimed.id,
      outerLeaseEpoch: claimed.leaseEpoch,
      hidden: true as const,
      createdAt: now,
    };

    await store.putLegacyBridge(bridge);
    await store.putLegacyBridge({ ...bridge, createdAt: now + 1 });
    expect(await store.listLegacyBridges()).toEqual([bridge]);

    await expect(store.putLegacyBridge({
      ...bridge,
      legacyJobId: "legacy-b",
    })).rejects.toMatchObject({ code: "legacy-bridge-conflict" });

    now = 111;
    await expect(store.putLegacyBridge(bridge)).rejects.toMatchObject({
      code: "legacy-bridge-conflict",
    });
    await expect(store.deleteLegacyBridge(
      bridge.outerJobId,
      bridge.outerLeaseEpoch,
      bridge.legacyJobId,
    )).rejects.toMatchObject({ code: "legacy-bridge-conflict" });
    expect(await store.listLegacyBridges()).toEqual([bridge]);
  });

  it("reconstructs checkpointed work after owner loss and fences the old epoch", async () => {
    let now = 10;
    const store = new IndexedDbExportJobCatalog({ factory, now: () => now });
    await store.create({ request: request("job-1") });
    const first = (await store.claimNext({ ownerId: "runner-a", now, leaseDurationMs: 10 }))!;
    const checkpointed = await store.compareAndSet({
      kind: "checkpoint",
      id: first.id,
      expectedRevision: first.revision,
      leaseEpoch: first.leaseEpoch,
      at: now,
      checkpointRef: "checkpoint:job-1:1",
    });

    now = 21;
    const recovered = await recoverAndClaimExtensionExportJob(store, {
      now,
      ownerId: "runner-b",
      leaseDurationMs: 10,
    });
    expect(recovered).toMatchObject({ id: "job-1", state: "running", leaseEpoch: 2, recoveryCount: 1 });
    await expect(store.compareAndSet({
      kind: "progress",
      id: first.id,
      expectedRevision: checkpointed.revision,
      leaseEpoch: first.leaseEpoch,
      progress: { stage: "fetch", done: 1, total: 1, updatedAt: now },
    })).rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("recovers durable PDF work from every pipeline stage after executor loss", async () => {
    const stages: ExportJobStage[] = [
      "discover",
      "fetch",
      "compose",
      "resolve",
      "assets",
      "render",
      "validate",
      "commit",
    ];

    for (const [index, stage] of stages.entries()) {
      const stageFactory = new IDBFactory();
      let now = 100 + index;
      const store = new IndexedDbExportJobCatalog({
        factory: stageFactory,
        now: () => now,
      });
      const durableRequest = pdfRequest(`pdf-${stage}`);
      await store.create({ request: durableRequest });
      const first = (await store.claimNext({
        ownerId: "offscreen-a",
        now,
        leaseDurationMs: 10,
      }))!;
      const progressed = await store.compareAndSet({
        kind: "progress",
        id: first.id,
        expectedRevision: first.revision,
        leaseEpoch: first.leaseEpoch,
        progress: {
          stage,
          done: index,
          total: stages.length,
          detail: `checkpoint at ${stage}`,
          updatedAt: now,
        },
      });
      const checkpointRef = `checkpoint:${first.id}:${stage}`;
      const checkpointed = await store.compareAndSet({
        kind: "checkpoint",
        id: first.id,
        expectedRevision: progressed.revision,
        leaseEpoch: first.leaseEpoch,
        at: now,
        checkpointRef,
      });
      expect(checkpointed).toMatchObject({
        stage,
        progress: {
          stage,
          done: index,
          total: stages.length,
          detail: `checkpoint at ${stage}`,
        },
        checkpointRef,
      });

      now += 11;
      const recovered = await recoverAndClaimExtensionExportJob(store, {
        now,
        ownerId: "offscreen-b",
        leaseDurationMs: 10,
      });

      expect(recovered).toMatchObject({
        id: first.id,
        format: "pdf",
        state: "running",
        attempt: 2,
        recoveryCount: 1,
        leaseEpoch: 2,
        checkpointRef,
      });
      expect(recovered?.stage).toBeUndefined();
      expect(recovered?.progress).toBeUndefined();
      expect(await store.getRequest(recovered!.requestRef)).toEqual(durableRequest);
      await expect(store.compareAndSet({
        kind: "heartbeat",
        id: first.id,
        expectedRevision: checkpointed.revision,
        ownerId: "offscreen-a",
        leaseEpoch: first.leaseEpoch,
        now,
        leaseDurationMs: 10,
      })).rejects.toMatchObject({ code: "revision-conflict" });
    }
  });

  it("replays from the durable request when the owner dies immediately after claim", async () => {
    let now = 10;
    const store = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const queued = await store.create({ request: request("job-request-checkpoint") });
    expect(queued.checkpointRef).toBe(queued.requestRef);
    await store.claimNext({ ownerId: "runner-a", now, leaseDurationMs: 10 });

    now = 21;
    const recovered = await recoverAndClaimExtensionExportJob(store, {
      now,
      ownerId: "runner-b",
      leaseDurationMs: 10,
    });

    expect(recovered).toMatchObject({
      id: "job-request-checkpoint",
      state: "running",
      leaseEpoch: 2,
      recoveryCount: 1,
      checkpointRef: "request:job-request-checkpoint",
    });
  });

  it("commits job metadata and its staged IDB artifact atomically", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const artifacts = new IndexedDbExportByteStore({ factory, now: () => 10, randomUUID: () => "artifact-id" });
    await catalog.create({ request: request("job-1") });
    const claimed = (await catalog.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 100 }))!;
    const staged = await artifacts.stage("job-1", claimed.leaseEpoch, {
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "export.docx",
      byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: bytes([97], [98, 99]),
    });
    const succeeded = await catalog.finalizeArtifact({
      id: "job-1",
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      stagedArtifact: staged,
      finishedAt: 10,
    });
    expect(succeeded).toMatchObject({ state: "succeeded", artifact: { ref: staged.ref } });
    expect(await artifacts.getStaged("job-1", claimed.leaseEpoch)).toBeUndefined();
    await expect(artifacts.stage("job-1", claimed.leaseEpoch, {
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "export.docx",
      byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: bytes([97, 98, 99]),
    })).rejects.toMatchObject({ code: "ownership-mismatch" });
    await artifacts.deleteStaged(staged.ref);
    const delivered: number[] = [];
    for await (const chunk of artifacts.read(staged.ref)) delivered.push(...chunk);
    expect(delivered).toEqual([97, 98, 99]);
  });

  it("upgrades the complete v2 byte schema to executor metadata stores without data loss", async () => {
    const old = await rawOpen(2, (db) => {
      const jobs = db.createObjectStore("jobs", { keyPath: "id" });
      jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
      jobs.createIndex("derivationKey", "derivationKey", { unique: true });
      db.createObjectStore("requests", { keyPath: "ref" });
      const events = db.createObjectStore("events", { keyPath: ["jobId", "seq"] });
      events.createIndex("jobId", "jobId", { unique: false });
      db.createObjectStore("tombstones", { keyPath: "jobId" });
      db.createObjectStore("cursors", { keyPath: "key" });
      const bridges = db.createObjectStore("legacy-bridges", { keyPath: ["outerJobId", "outerLeaseEpoch"] });
      bridges.createIndex("legacyJobId", "legacyJobId", { unique: true });
      bridges.createIndex("outerJobId", "outerJobId", { unique: false });
      const objects = db.createObjectStore("byte-objects", { keyPath: "id" });
      objects.createIndex("jobId", "jobId", { unique: false });
      objects.createIndex("jobEpoch", ["jobId", "leaseEpoch"], { unique: false });
      objects.createIndex("spoolRef", ["jobId", "leaseEpoch", "namespace", "key"], { unique: true });
      objects.createIndex("artifactRef", "ref", { unique: true });
      const chunks = db.createObjectStore("byte-chunks", { keyPath: ["objectId", "index"] });
      chunks.createIndex("objectId", "objectId", { unique: false });
    });
    const seed = old.transaction(["byte-objects", "byte-chunks"], "readwrite");
    seed.objectStore("byte-objects").put({
      id: "v2-object",
      kind: "spool",
      state: "committed",
      jobId: "v2-job",
      leaseEpoch: 1,
      namespace: "ready-pdf",
      key: "manifest",
      byteLength: 1,
      chunkCount: 1,
      sha256: "0".repeat(64),
      createdAt: 1,
      committedAt: 1,
    });
    seed.objectStore("byte-chunks").put({
      objectId: "v2-object",
      index: 0,
      bytes: Uint8Array.from([7]),
    });
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve();
      seed.onerror = () => reject(seed.error);
      seed.onabort = () => reject(seed.error);
    });
    old.close();

    const upgraded = await openExtensionExportDb({ factory });
    expect(upgraded.version).toBe(EXTENSION_EXPORT_DB_VERSION);
    expect([...upgraded.objectStoreNames]).toContain(EXTENSION_EXPORT_EXECUTOR_CHECKPOINTS_STORE);
    expect([...upgraded.objectStoreNames]).toContain(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE);
    const read = upgraded.transaction(["byte-objects", "byte-chunks"], "readonly");
    expect(await new Promise<number>((resolve, reject) => {
      const operation = read.objectStore("byte-objects").get("v2-object");
      operation.onsuccess = () => resolve(operation.result?.byteLength);
      operation.onerror = () => reject(operation.error);
    })).toBe(1);
    expect(await new Promise<number[]>((resolve, reject) => {
      const operation = read.objectStore("byte-chunks").get(["v2-object", 0]);
      operation.onsuccess = () => resolve([...operation.result.bytes]);
      operation.onerror = () => reject(operation.error);
    })).toEqual([7]);
    upgraded.close();
  });

  it("waits for a blocked v1 connection and upgrades without losing supported stores", async () => {
    const old = await rawOpen(1, (db) => {
      const jobs = db.createObjectStore("jobs", { keyPath: "id" });
      jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
      jobs.createIndex("derivationKey", "derivationKey", { unique: true });
      db.createObjectStore("requests", { keyPath: "ref" });
    });
    let blocked = 0;
    const opening = openExtensionExportDb({
      factory,
      blockedTimeoutMs: 500,
      onBlocked: () => {
        blocked += 1;
        old.close();
      },
    });
    const upgraded = await opening;
    expect(blocked).toBe(1);
    expect([...upgraded.objectStoreNames]).toContain("byte-chunks");
    expect([...upgraded.objectStoreNames]).toContain("legacy-bridges");
    upgraded.close();
  });

  it("returns a controlled error and aborts a late upgrade when opening stays blocked", async () => {
    const old = await rawOpen(1, (db) => {
      const jobs = db.createObjectStore("jobs", { keyPath: "id" });
      jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
      jobs.createIndex("derivationKey", "derivationKey", { unique: true });
      db.createObjectStore("requests", { keyPath: "ref" });
    });
    await expect(openExtensionExportDb({ factory, blockedTimeoutMs: 5 })).rejects.toMatchObject({ code: "blocked" });
    old.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stillV1 = await rawOpen(1);
    expect([...stillV1.objectStoreNames]).toEqual(["jobs", "requests"]);
    stillV1.close();
  });

  it("retries queue startup after a blocked database upgrade", async () => {
    const old = await rawOpen(1, (db) => {
      const jobs = db.createObjectStore("jobs", { keyPath: "id" });
      jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
      jobs.createIndex("derivationKey", "derivationKey", { unique: true });
      db.createObjectStore("requests", { keyPath: "ref" });
    });
    const queue = createExtensionQueueFoundation({ factory, blockedTimeoutMs: 5 });

    await expect(queue.startup()).rejects.toMatchObject({ code: "blocked" });
    old.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(queue.startup()).resolves.toBeUndefined();
  });
});
