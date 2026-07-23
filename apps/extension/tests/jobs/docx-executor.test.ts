import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "@atlcli/core";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { prepareDocxExport } from "@atlcli/docx/browser";
import type {
  DocxExportJobRequestV1,
  ExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  IndexedDbExportJobCatalog,
  recoverAndClaimExtensionExportJob,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createProductiveExtensionDocxExecutor,
  estimateExtensionDocxRenderV1,
  EXTENSION_DOCX_MAX_OUTPUT_BYTES_V1,
  EXTENSION_DOCX_SPOOL_LIMITS_V1,
} from "../../utils/export-jobs/docx-executor.js";
import {
  createExtensionDocxReadyToRenderStore,
  readExtensionDocxExportReport,
} from "../../utils/export-jobs/docx-executor-store.js";
import { BrowserRenderReservationPoolV1 } from "../../utils/export-jobs/render-reservation.js";
import { runClaimedExtensionExportJob } from "../../utils/export-jobs/runtime.js";

globalThis.IDBKeyRange = IDBKeyRange;

describe("productive extension DOCX executor", () => {
  it("runs the TypeScript engine through retained IDB checkpoint, report, and artifact stores", async () => {
    const factory = new IDBFactory();
    const clock = Date.parse("2026-07-23T00:00:00.000Z");
    const now = () => clock;
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.template.name") + para("$scroll.content"),
      date: new Date("2026-07-23T00:00:00.000Z"),
    });
    const templateSha256 = await sha256Hex(templateBytes);
    const request: DocxExportJobRequestV1 = {
      schema: "atlcli.export-job-request/1",
      id: "outer-docx",
      idempotencyKey: "idem:outer-docx",
      format: "docx",
      renderer: "docx-typescript",
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "page" },
      },
      authRef: "session:https://site.atlassian.net",
      displayName: "Durable guide",
      requestedFilename: "Durable guide.docx",
      createdAt: clock,
      priority: "interactive",
      output: { policy: "collect" },
      template: {
        recordKey: "template:mayflower",
        sha256: templateSha256,
        name: "mayflower.docx",
        uploadedAt: Date.parse("2026-07-20T00:00:00.000Z"),
      },
      options: {
        embedImages: true,
        resolveMacros: false,
        updateFields: "auto",
      },
    };
    const catalog = new IndexedDbExportJobCatalog({ factory, now });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now,
      maxArtifactBytes: EXTENSION_DOCX_MAX_OUTPUT_BYTES_V1,
      maxJobBytes: EXTENSION_DOCX_SPOOL_LIMITS_V1.maxJobBytes,
      maxTotalBytes: EXTENSION_DOCX_SPOOL_LIMITS_V1.maxTotalBytes,
    });
    await catalog.create({ request });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:test",
      now: now(),
      leaseDurationMs: 10_000,
    });
    if (!claimed) throw new Error("Expected a claimed DOCX job.");
    let templateResolutions = 0;
    const executor = createProductiveExtensionDocxExecutor({
      bytes,
      renderPool: new BrowserRenderReservationPoolV1(),
      now,
      storageOptions: { factory },
      resolveInput: async () => ({
        details: {
          id: "42",
          title: "Durable guide",
          version: 7,
          spaceKey: "DOCS",
          storage: "<p>Hello from the background DOCX executor.</p>",
        },
        template: {
          name: "mayflower.docx",
          modificationDate: new Date(request.template.uploadedAt!),
        },
        exportDate: new Date(request.createdAt),
      }),
      templates: {
        async resolve(input) {
          templateResolutions += 1;
          expect(input).toMatchObject({
            recordKey: request.template.recordKey,
            expectedSha256: request.template.sha256,
          });
          return { recordKey: input.recordKey, bytes: templateBytes.slice() };
        },
      },
    });

    const succeeded = await runClaimedExtensionExportJob({
      claimed,
      catalog,
      bytes,
      executor,
      now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });

    expect(succeeded).toMatchObject({
      id: "outer-docx",
      format: "docx",
      state: "succeeded",
      stage: "commit",
      artifact: {
        filename: "Durable guide.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      reportSummary: { completeness: "complete" },
    });
    expect(templateResolutions).toBe(1);
    const output: number[] = [];
    for await (const chunk of bytes.read(succeeded.artifact!.ref)) output.push(...chunk);
    expect(output.slice(0, 2)).toEqual([80, 75]);
    expect((await readExtensionDocxExportReport(succeeded.reportRef!, {
      factory,
      bytes,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    }))?.filename).toBe("Durable guide.docx");
  });

  it("uses the exact conservative browser admission envelope", () => {
    const estimate = estimateExtensionDocxRenderV1(
      {
        details: { id: "1", title: "x", storage: "<p>x</p>" },
        template: { name: "x.docx", modificationDate: new Date(0) },
      },
      {} as ExportJobRequestV1 & { format: "docx" },
    );
    expect(estimate).toEqual({
      heapBytes: 512 * 1024 * 1024,
      spoolBytes: 128 * 1024 * 1024,
      outputBytes: 64 * 1024 * 1024,
      rasterPixels: 32 * 1024 * 1024,
      confidence: "unknown",
    });
  });

  it("materializes ready-to-render DOCX state after offscreen owner loss", async () => {
    const factory = new IDBFactory();
    let now = 100;
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      date: new Date("2026-07-23T00:00:00.000Z"),
    });
    const templateSha256 = await sha256Hex(templateBytes);
    const request: DocxExportJobRequestV1 = {
      schema: "atlcli.export-job-request/1",
      id: "recover-docx",
      idempotencyKey: "idem:recover-docx",
      format: "docx",
      renderer: "docx-typescript",
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42" },
        scope: { kind: "page" },
      },
      authRef: "session:https://site.atlassian.net",
      displayName: "Recovery guide",
      createdAt: now,
      priority: "interactive",
      output: { policy: "collect" },
      template: {
        recordKey: "template:recovery",
        sha256: templateSha256,
        name: "recovery.docx",
      },
      options: { embedImages: true, resolveMacros: false },
    };
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    await catalog.create({ request });
    const first = await catalog.claimNext({
      ownerId: "offscreen:first",
      now,
      leaseDurationMs: 10,
    });
    if (!first) throw new Error("Expected first DOCX claim.");
    const prepared = await prepareDocxExport({
      details: {
        id: "42",
        title: "Recovery guide",
        storage: "<p>Durable body</p>",
      },
      template: { name: "recovery.docx", modificationDate: new Date(0) },
      templateBytes,
    });
    const ready = createExtensionDocxReadyToRenderStore({
      factory,
      now: () => now,
      bytes,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });
    const checkpoint = await ready.commit({
      jobId: first.id,
      leaseEpoch: first.leaseEpoch,
      request,
      prepared,
      binding: {
        byteLength: prepared.renderState!.archiveBytes.byteLength,
        sha256: "a".repeat(64),
      },
      template: {
        recordKey: request.template.recordKey,
        byteLength: templateBytes.byteLength,
        sha256: templateSha256,
      },
      estimate: {
        heapBytes: 4 * 1024 * 1024,
        spoolBytes: 4 * 1024 * 1024,
        outputBytes: 4 * 1024 * 1024,
        rasterPixels: 0,
        confidence: "estimated",
      },
      signal: new AbortController().signal,
    });

    now = 111;
    const recovered = await recoverAndClaimExtensionExportJob(catalog, {
      ownerId: "offscreen:second",
      now,
      leaseDurationMs: 10,
    });
    expect(recovered).toMatchObject({
      id: request.id,
      leaseEpoch: 2,
      attempt: 2,
      recoveryCount: 1,
    });
    const loaded = await ready.load({
      jobId: request.id,
      request,
      signal: new AbortController().signal,
    });
    expect(loaded).toEqual(checkpoint);
    const materialized = await ready.materialize({
      checkpoint: loaded!,
      jobId: request.id,
      leaseEpoch: recovered!.leaseEpoch,
      signal: new AbortController().signal,
    });
    expect(materialized.renderState?.bodyXml).toBe(prepared.renderState?.bodyXml);
    expect(materialized.renderState?.archiveBytes).toEqual(
      prepared.renderState?.archiveBytes,
    );
    await expect(ready.beginRenderAttempt({
      checkpoint,
      jobId: request.id,
      leaseEpoch: first.leaseEpoch,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "revision-conflict" });
  });
});
