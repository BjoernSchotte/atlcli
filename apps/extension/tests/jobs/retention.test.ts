import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  FULL_REPORT_RETENTION_MS_V1,
  type DocxExportJobRequestV1,
  type SpoolRefV1,
} from "@atlcli/export-jobs";
import {
  EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
  IndexedDbExportJobCatalog,
  openExtensionExportDb,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { sweepExtensionExportJobRetention } from "../../utils/export-jobs/retention.js";

globalThis.IDBKeyRange = IDBKeyRange;

const LIMITS = {
  maxObjectBytes: 1024,
  maxJobBytes: 4096,
  maxTotalBytes: 16_384,
};
const ARTIFACT_HASH =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}

function request(id: string, createdAt = 1): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id },
      scope: { kind: "page" },
    },
    authRef: "extension-session:https://site.atlassian.net",
    displayName: `Export ${id}`,
    createdAt,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "default",
      sha256: "0".repeat(64),
      name: "Default",
    },
    options: { embedImages: true, resolveMacros: true },
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function putExecutorResult(
  factoryValue: IDBFactory,
  value: {
    key: string;
    jobId: string;
    reportRef: string;
    reportSpoolRef: SpoolRefV1;
  },
): Promise<void> {
  const db = await openExtensionExportDb({ factory: factoryValue });
  try {
    const transaction = db.transaction(
      EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
      "readwrite",
    );
    transaction.objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE).put({
      ...value,
      leaseEpoch: 1,
      intent: {},
      updatedAt: 10,
    });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

async function executorResultCount(factoryValue: IDBFactory): Promise<number> {
  const db = await openExtensionExportDb({ factory: factoryValue });
  try {
    const transaction = db.transaction(
      EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE,
      "readonly",
    );
    const request = transaction
      .objectStore(EXTENSION_EXPORT_EXECUTOR_RESULTS_STORE)
      .count();
    const count = await new Promise<number>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await transactionDone(transaction);
    return count;
  } finally {
    db.close();
  }
}

async function seedRetainedJob(
  id: string,
): Promise<{
  catalog: IndexedDbExportJobCatalog;
  bytesStore: IndexedDbExportByteStore;
  artifactRef: string;
  reportSpoolRef: SpoolRefV1;
  requestPinRef: SpoolRefV1;
}> {
  const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
  const bytesStore = new IndexedDbExportByteStore({
    factory,
    now: () => 10,
    randomUUID: (() => {
      let sequence = 0;
      return () => `${id}-${++sequence}`;
    })(),
  });
  await catalog.create({ request: request(id) });
  const claimed = (await catalog.claimNext({
    ownerId: "runner",
    now: 10,
    leaseDurationMs: 100,
    ids: [id],
  }))!;
  const requestPinRef = {
    jobId: id,
    leaseEpoch: 0,
    namespace: "request-assets",
    key: "docx-template",
  };
  await bytesStore.put(requestPinRef, bytes("template"), LIMITS);
  const reportSpoolRef = {
    jobId: id,
    leaseEpoch: claimed.leaseEpoch,
    namespace: "ready-docx",
    key: "report",
  };
  await bytesStore.put(reportSpoolRef, bytes("report"), LIMITS);
  const staged = await bytesStore.stage(id, claimed.leaseEpoch, {
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: `${id}.docx`,
    byteLength: 3,
    sha256: ARTIFACT_HASH,
    bytes: bytes("abc"),
  });
  const reportRef = `report:${id}`;
  await putExecutorResult(factory, {
    key: `result:${id}`,
    jobId: id,
    reportRef,
    reportSpoolRef,
  });
  const succeeded = await catalog.finalizeArtifact({
    id,
    expectedRevision: claimed.revision,
    leaseEpoch: claimed.leaseEpoch,
    stagedArtifact: staged,
    reportRef,
    reportSummary: {
      issues: { info: 1, warning: 2, error: 0 },
      topCodes: [{ code: "image-skipped", count: 2 }],
      completeness: "partial",
    },
    finishedAt: 10,
  });
  await catalog.appendEvent(id, {
    expectedRevision: succeeded.revision,
    leaseEpoch: succeeded.leaseEpoch,
    event: {
      kind: "artifact",
      seq: 1,
      at: 10,
      artifact: succeeded.artifact!,
    },
  });
  await catalog.deliver(id, succeeded.revision, 20);
  return {
    catalog,
    bytesStore,
    artifactRef: staged.ref,
    reportSpoolRef,
    requestPinRef,
  };
}

describe("extension export lifecycle retention", () => {
  it("atomically releases exact artifact/report/events but preserves summary and request pins", async () => {
    const seeded = await seedRetainedJob("job");
    const foreignRef = {
      jobId: "foreign",
      leaseEpoch: 0,
      namespace: "request-assets",
      key: "docx-template",
    };
    await seeded.bytesStore.put(foreignRef, bytes("foreign"), LIMITS);
    const at = Math.max(
      20 + DELIVERED_ARTIFACT_RETENTION_MS_V1,
      10 + FULL_REPORT_RETENTION_MS_V1,
    );
    const before = (await seeded.catalog.get("job"))!;

    const released = await seeded.catalog.compareAndSet({
      kind: "retention",
      id: "job",
      expectedRevision: before.revision,
      at,
      releaseArtifact: true,
      releaseReport: true,
    });

    expect(released).toMatchObject({
      artifactReleasedAt: at,
      reportReleasedAt: at,
      reportSummary: before.reportSummary,
    });
    expect(released.artifact).toBeUndefined();
    expect(released.reportRef).toBeUndefined();
    await expect(
      Array.fromAsync(seeded.bytesStore.read(seeded.artifactRef)),
    ).rejects.toMatchObject({ code: "not-committed" });
    expect(await seeded.bytesStore.stat(seeded.reportSpoolRef)).toBeUndefined();
    expect(await seeded.catalog.readEvents("job")).toMatchObject({ events: [] });
    expect(await executorResultCount(factory)).toBe(0);
    expect(await seeded.bytesStore.stat(seeded.requestPinRef)).toBeDefined();
    expect(await seeded.bytesStore.stat(foreignRef)).toBeDefined();

    await expect(
      seeded.bytesStore.put(
        {
          jobId: "job",
          leaseEpoch: 1,
          namespace: "late-writer",
          key: "payload",
        },
        bytes("late"),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
  });

  it("rolls byte deletion, events, result metadata, fence, and snapshot back together", async () => {
    const seeded = await seedRetainedJob("atomic");
    const before = (await seeded.catalog.get("atomic"))!;
    const at = 10 + FULL_REPORT_RETENTION_MS_V1;
    const failing = new IndexedDbExportJobCatalog({
      factory,
      now: () => at,
      afterRetentionByteDelete: () => {
        throw new Error("abort retention transaction");
      },
    });

    await expect(failing.compareAndSet({
      kind: "retention",
      id: "atomic",
      expectedRevision: before.revision,
      at,
      releaseArtifact: true,
      releaseReport: true,
    })).rejects.toThrow("abort retention");

    expect(await seeded.catalog.get("atomic")).toEqual(before);
    expect(await seeded.bytesStore.stat(seeded.reportSpoolRef)).toBeDefined();
    expect(await seeded.catalog.readEvents("atomic")).toMatchObject({
      events: [{ kind: "artifact" }],
    });
    expect(await executorResultCount(factory)).toBe(1);
    expect(await Array.fromAsync(seeded.bytesStore.read(seeded.artifactRef)))
      .toHaveLength(1);
    await expect(
      seeded.bytesStore.put(
        {
          jobId: "atomic",
          leaseEpoch: 2,
          namespace: "post-abort",
          key: "still-open",
        },
        bytes("open"),
        LIMITS,
      ),
    ).resolves.toBeDefined();
  });

  it("resumes tombstone byte cleanup after a simulated worker restart", async () => {
    const seeded = await seedRetainedJob("restart");
    const current = (await seeded.catalog.get("restart"))!;
    const at = 10 + FULL_REPORT_RETENTION_MS_V1;
    await seeded.catalog.compareAndSet({
      kind: "retention",
      id: "restart",
      expectedRevision: current.revision,
      at,
      releaseArtifact: true,
      releaseReport: true,
    });
    const deleted = await seeded.catalog.deleteTerminal({
      ids: ["restart"],
      finishedBefore: at + 1,
    });
    expect(deleted.deletedJobIds).toEqual(["restart"]);
    expect(await seeded.catalog.listTombstones({ cleanupPending: true }))
      .toHaveLength(1);
    expect(await seeded.bytesStore.stat(seeded.requestPinRef)).toBeDefined();

    const restartedCatalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => at,
    });
    const restartedBytes = new IndexedDbExportByteStore({
      factory,
      now: () => at,
    });
    const result = await sweepExtensionExportJobRetention({
      catalog: restartedCatalog,
      bytes: restartedBytes,
      now: () => at,
    });
    expect(result.tombstonesReconciled).toBe(1);
    expect(await restartedBytes.stat(seeded.requestPinRef)).toBeUndefined();
    expect(await restartedCatalog.listTombstones({ cleanupPending: true }))
      .toEqual([]);
    expect(await restartedCatalog.getTombstone("restart")).toMatchObject({
      cleanupCompletedAt: at,
    });
  });

  it("serializes two concurrent sweeps without double-releasing payloads", async () => {
    const seeded = await seedRetainedJob("concurrent");
    const at = 10 + FULL_REPORT_RETENTION_MS_V1;
    const sweeps = await Promise.all([
      sweepExtensionExportJobRetention({
        catalog: seeded.catalog,
        bytes: seeded.bytesStore,
        now: () => at,
      }),
      sweepExtensionExportJobRetention({
        catalog: new IndexedDbExportJobCatalog({ factory, now: () => at }),
        bytes: new IndexedDbExportByteStore({ factory, now: () => at }),
        now: () => at,
      }),
    ]);
    expect(sweeps.reduce((sum, value) => sum + value.payloadReleases, 0)).toBe(1);
    expect(await seeded.catalog.get("concurrent")).toMatchObject({
      artifactReleasedAt: at,
      reportReleasedAt: at,
    });
    expect(await executorResultCount(factory)).toBe(0);
  });
});
