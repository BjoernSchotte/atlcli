import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type {
  DocxExportJobRequestV1,
  ExportJobSnapshotV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import {
  createExtensionDurableJobsStore,
  type DurableJobsPort,
} from "../../utils/jobs/store.js";

globalThis.IDBKeyRange = IDBKeyRange;

const DOCX = "123e4567-e89b-42d3-a456-426614174000";
const PDF = "223e4567-e89b-42d3-a456-426614174000";
const WAITING = "323e4567-e89b-42d3-a456-426614174000";
const SHA_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function docxRequest(id: string): DocxExportJobRequestV1 {
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
    authRef: "session:https://site.atlassian.net",
    displayName: `DOCX ${id}`,
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "site:template",
      sha256: "0".repeat(64),
      name: "Site template",
      uploadedAt: 1,
    },
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
    authRef: "session:https://site.atlassian.net",
    displayName: `PDF ${id}`,
    createdAt: 2,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true, exportedAt: 2 },
  };
}

function unavailableLegacy(): DurableJobsPort {
  return {
    list: async () => [],
    cancel: async () => undefined,
    retry: async () => undefined,
    rerun: async () => undefined,
    resume: async () => false,
    acknowledge: async () => undefined,
    dismiss: async () => undefined,
    download: async () => false,
  };
}

async function* abc(): AsyncIterable<Uint8Array> {
  yield Uint8Array.from([97, 98, 99]);
}

async function succeed(
  catalog: IndexedDbExportJobCatalog,
  bytes: IndexedDbExportByteStore,
  request: PdfExportJobRequestV1,
  finishedAt = 20,
): Promise<ExportJobSnapshotV1> {
  await catalog.create({ request });
  const claimed = (await catalog.claimNext({
    ids: [request.id],
    ownerId: "runner",
    now: 10,
    leaseDurationMs: 100,
  }))!;
  const staged = await bytes.stage(request.id, claimed.leaseEpoch, {
    mediaType: "application/pdf",
    filename: "result.pdf",
    byteLength: 3,
    sha256: SHA_ABC,
    bytes: abc(),
  });
  return catalog.finalizeArtifact({
    id: request.id,
    expectedRevision: claimed.revision,
    leaseEpoch: claimed.leaseEpoch,
    stagedArtifact: staged,
    finishedAt,
  });
}

describe("format-neutral extension Activity operations", () => {
  it("retries DOCX and reruns PDF with replay-safe requests and idempotent action keys", async () => {
    let now = 10;
    let serial = 0;
    const wakes: string[][] = [];
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
    });

    await catalog.create({ request: docxRequest(DOCX) });
    const claimed = (await catalog.claimNext({
      ids: [DOCX],
      ownerId: "runner",
      now,
      leaseDurationMs: 100,
    }))!;
    await catalog.compareAndSet({
      id: DOCX,
      kind: "transition",
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      to: "failed",
      at: 11,
      error: {
        code: "network",
        message: "Synthetic network failure.",
        category: "network",
        retryable: true,
        stage: "fetch",
        occurredAt: 11,
      },
    });
    await succeed(catalog, bytes, pdfRequest(PDF));

    const port = createExtensionDurableJobsStore({
      catalog,
      bytes,
      legacy: unavailableLegacy(),
      listLegacyPdf: async () => [],
      now: () => ++now,
      randomUUID: () => `derived-${++serial}`,
      wake: async (jobIds) => {
        wakes.push(jobIds);
        return {};
      },
      emit: async () => undefined,
    });

    const retry = await port.retry(`common:${DOCX}`, "retry-click-1");
    const duplicateRetry = await port.retry(
      `common:${DOCX}`,
      "retry-click-1",
    );
    const rerun = await port.rerun(`common:${PDF}`, "rerun-click-1");

    expect(retry).toBe("common:derived-1");
    expect(duplicateRetry).toBe(retry);
    expect(rerun).toBe("common:derived-3");
    expect(wakes).toEqual([
      ["derived-1"],
      ["derived-1"],
      ["derived-3"],
    ]);

    const retried = await catalog.get("derived-1");
    const retryRequest = await catalog.getRequest(retried!.requestRef);
    expect(retried?.derivedFrom).toEqual({
      jobId: DOCX,
      relation: "retry",
      actionKey: "retry-click-1",
    });
    expect(retryRequest).toMatchObject({
      id: "derived-1",
      format: "docx",
      priority: "retry",
      template: {
        recordKey: "site:template",
        sha256: "0".repeat(64),
        uploadedAt: 1,
      },
    });

    const rerunSnapshot = await catalog.get("derived-3");
    const rerunRequest = await catalog.getRequest(
      rerunSnapshot!.requestRef,
    );
    expect(rerunSnapshot?.derivedFrom).toEqual({
      jobId: PDF,
      relation: "rerun",
      actionKey: "rerun-click-1",
    });
    expect(rerunRequest).toMatchObject({
      id: "derived-3",
      format: "pdf",
      priority: "interactive",
      template: { id: "default", manifestVersion: "1" },
    });
  });

  it("keeps acknowledge, dismiss, delivery, and repeated download distinct", async () => {
    let now = 30;
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
    });
    await succeed(catalog, bytes, pdfRequest(PDF), 40);
    now = 40;
    const emitted: number[][] = [];
    const port = createExtensionDurableJobsStore({
      catalog,
      bytes,
      legacy: unavailableLegacy(),
      listLegacyPdf: async () => [],
      now: () => ++now,
      emit: async (_filename, value) => {
        emitted.push([...value]);
      },
    });

    expect((await port.list())[0]).toMatchObject({
      key: `common:${PDF}`,
      unread: true,
      actions: { download: true, acknowledge: true, dismiss: true },
    });
    await port.acknowledge(`common:${PDF}`);
    expect((await catalog.get(PDF))?.acknowledgedAt).toBe(41);
    expect((await port.list())[0]?.unread).toBe(false);

    expect(await port.download(`common:${PDF}`)).toBe(true);
    expect(await port.download(`common:${PDF}`)).toBe(true);
    expect(emitted).toEqual([
      [97, 98, 99],
      [97, 98, 99],
    ]);
    expect((await catalog.get(PDF))?.deliveredAt).toBe(42);
    expect((await catalog.get(PDF))?.acknowledgedAt).toBe(41);

    await port.dismiss(`common:${PDF}`);
    expect((await catalog.get(PDF))?.dismissedAt).toBe(44);
    expect(await port.list()).toEqual([]);
    expect((await catalog.get(PDF))?.artifact?.ref).toBeDefined();
  });

  it("resumes only an explicitly selected waiting/auth checkpoint", async () => {
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({ factory });
    await catalog.create({ request: docxRequest(WAITING) });
    const claimed = (await catalog.claimNext({
      ids: [WAITING],
      ownerId: "first",
      now,
      leaseDurationMs: 100,
    }))!;
    await catalog.compareAndSet({
      id: WAITING,
      kind: "transition",
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      to: "waiting",
      waiting: { reason: "auth" },
      checkpointRef: "checkpoint:waiting-auth",
      at: 11,
    });

    expect(
      await catalog.claimNext({
        ids: [WAITING],
        ownerId: "automatic",
        now: 12,
        leaseDurationMs: 100,
      }),
    ).toBeUndefined();

    const port = createExtensionDurableJobsStore({
      catalog,
      bytes,
      legacy: unavailableLegacy(),
      listLegacyPdf: async () => [],
      now: () => ++now,
      wake: async (jobIds, options) => {
        const resumed = await catalog.claimNext({
          ids: jobIds,
          ...(options?.resumeWaiting
            ? { resumeWaitingIds: jobIds }
            : {}),
          ownerId: "after-sign-in",
          now: ++now,
          leaseDurationMs: 100,
        });
        return resumed ? { claimedJobId: resumed.id } : {};
      },
      emit: async () => undefined,
    });

    expect(await port.resume(`common:${WAITING}`)).toBe(true);
    expect(await catalog.get(WAITING)).toMatchObject({
      state: "running",
      leaseEpoch: 2,
      attempt: 2,
      checkpointRef: "checkpoint:waiting-auth",
    });
  });
});
