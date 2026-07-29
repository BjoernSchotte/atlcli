import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "@atlcli/core";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { prepareDocxExport } from "@atlcli/docx/browser-entry";
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
import type { DocxReadyToRenderStoreV1 } from "@atlcli/export-wiring/jobs";
import {
  createExtensionDocxReadyToRenderStore,
  readExtensionDocxExportReport,
} from "../../utils/export-jobs/docx-executor-store.js";
import { BrowserRenderReservationPoolV1 } from "../../utils/export-jobs/render-reservation.js";
import {
  createExtensionExportExecutionContext,
  runClaimedExtensionExportJob,
} from "../../utils/export-jobs/runtime.js";

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
    const deferredMedia = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    prepared.packagingMode = "stream";
    prepared.renderState!.mediaParts = [{
      path: "word/media/deferred.png",
      byteLength: deferredMedia.byteLength,
      sha256: await sha256Hex(deferredMedia),
      bytes: deferredMedia,
    }];
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
    expect(materialized.renderState?.mediaParts).toEqual([{
      path: "word/media/deferred.png",
      byteLength: deferredMedia.byteLength,
      sha256: await sha256Hex(deferredMedia),
      sourceRef: "1",
    }]);
    const recoveredMedia: number[] = [];
    for await (const chunk of ready.readMedia({
      checkpoint,
      sourceRef: materialized.renderState!.mediaParts![0]!.sourceRef!,
      jobId: request.id,
      leaseEpoch: recovered!.leaseEpoch,
      signal: new AbortController().signal,
    })) {
      recoveredMedia.push(...chunk);
    }
    expect(recoveredMedia).toEqual([...deferredMedia]);
    await expect(ready.beginRenderAttempt({
      checkpoint,
      jobId: request.id,
      leaseEpoch: first.leaseEpoch,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("recovers ready-to-render work with byte-identical output and report parity", async () => {
    const factory = new IDBFactory();
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      date: new Date("2026-07-23T00:00:00.000Z"),
    });
    const templateSha256 = await sha256Hex(templateBytes);
    const makeRequest = (id: string): DocxExportJobRequestV1 => ({
      schema: "atlcli.export-job-request/1",
      id,
      idempotencyKey: `idem:${id}`,
      format: "docx",
      renderer: "docx-typescript",
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "page" },
      },
      authRef: "session:https://site.atlassian.net",
      displayName: "Parity guide",
      requestedFilename: "Parity guide.docx",
      createdAt: Date.parse("2026-07-23T00:00:00.000Z"),
      priority: "interactive",
      output: { policy: "collect" },
      template: {
        recordKey: "template:parity",
        sha256: templateSha256,
        name: "parity.docx",
        uploadedAt: Date.parse("2026-07-20T00:00:00.000Z"),
      },
      options: {
        embedImages: true,
        resolveMacros: false,
        updateFields: "auto",
      },
    });
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
      maxArtifactBytes: EXTENSION_DOCX_MAX_OUTPUT_BYTES_V1,
      maxJobBytes: EXTENSION_DOCX_SPOOL_LIMITS_V1.maxJobBytes,
      maxTotalBytes: EXTENSION_DOCX_SPOOL_LIMITS_V1.maxTotalBytes,
    });
    const ready = createExtensionDocxReadyToRenderStore({
      factory,
      now: () => now,
      bytes,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });
    const resolvedJobs: string[] = [];
    const executorOptions = {
      bytes,
      renderPool: new BrowserRenderReservationPoolV1(),
      now: () => now,
      storageOptions: { factory },
      resolveInput: async (request: DocxExportJobRequestV1) => {
        resolvedJobs.push(request.id);
        return {
          details: {
            id: "42",
            title: "Parity guide",
            version: 7,
            spaceKey: "DOCS",
            storage: "<p>Durable parity body.</p>",
          },
          template: {
            name: "parity.docx",
            modificationDate: new Date(request.template.uploadedAt!),
          },
          exportDate: new Date(request.createdAt),
        };
      },
      templates: {
        async resolve(input: {
          recordKey: string;
          expectedSha256: string;
        }) {
          expect(input).toMatchObject({
            recordKey: "template:parity",
            expectedSha256: templateSha256,
          });
          return {
            recordKey: input.recordKey,
            bytes: templateBytes.slice(),
          };
        },
      },
      readyToRender: ready,
    } as const;

    const controlRequest = makeRequest("docx-control");
    await catalog.create({ request: controlRequest });
    const controlClaim = await catalog.claimNext({
      ownerId: "offscreen:control",
      now,
      leaseDurationMs: 10,
      ids: [controlRequest.id],
    });
    if (!controlClaim) throw new Error("Expected control DOCX claim.");
    const control = await runClaimedExtensionExportJob({
      claimed: controlClaim,
      catalog,
      bytes,
      executor: createProductiveExtensionDocxExecutor(executorOptions),
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });

    const recoveryRequest = makeRequest("docx-recovery");
    await catalog.create({ request: recoveryRequest });
    const firstClaim = await catalog.claimNext({
      ownerId: "offscreen:first",
      now,
      leaseDurationMs: 10,
      ids: [recoveryRequest.id],
    });
    if (!firstClaim) throw new Error("Expected recovery DOCX claim.");
    const crashReady: DocxReadyToRenderStoreV1 = {
      ...ready,
      async beginRenderAttempt() {
        throw new Error("injected offscreen owner loss after ready-to-render");
      },
    };
    const firstRuntime = createExtensionExportExecutionContext({
      claimed: firstClaim,
      catalog,
      bytes,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      leaseDurationMs: 10,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });
    await expect(
      createProductiveExtensionDocxExecutor({
        ...executorOptions,
        readyToRender: crashReady,
      }).execute(recoveryRequest, firstRuntime.context),
    ).rejects.toThrow("injected offscreen owner loss");
    expect(await firstRuntime.snapshot()).toMatchObject({
      state: "running",
      stage: "render",
      checkpointRef: expect.stringContaining("extension-ready:docx:"),
    });
    await firstRuntime.stop();

    now += 11;
    const recoveredClaim = await recoverAndClaimExtensionExportJob(catalog, {
      ownerId: "offscreen:replacement",
      now,
      leaseDurationMs: 10,
      ids: [recoveryRequest.id],
    });
    if (!recoveredClaim) throw new Error("Expected recovered DOCX claim.");
    const recovered = await runClaimedExtensionExportJob({
      claimed: recoveredClaim,
      catalog,
      bytes,
      executor: createProductiveExtensionDocxExecutor(executorOptions),
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });

    expect(recovered).toMatchObject({
      state: "succeeded",
      attempt: 2,
      recoveryCount: 1,
      leaseEpoch: 2,
    });
    expect(resolvedJobs).toEqual([controlRequest.id, recoveryRequest.id]);
    expect({
      sha256: recovered.artifact?.sha256,
      byteLength: recovered.artifact?.byteLength,
      reportSummary: recovered.reportSummary,
    }).toEqual({
      sha256: control.artifact?.sha256,
      byteLength: control.artifact?.byteLength,
      reportSummary: control.reportSummary,
    });

    const controlReport = await readExtensionDocxExportReport(control.reportRef!, {
      factory,
      bytes,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });
    const recoveredReport = await readExtensionDocxExportReport(recovered.reportRef!, {
      factory,
      bytes,
      spoolLimits: EXTENSION_DOCX_SPOOL_LIMITS_V1,
    });
    if (!controlReport || !recoveredReport) {
      throw new Error("Expected both retained DOCX parity reports.");
    }
    const stableReport = (report: typeof controlReport) => {
      const {
        durationMs: _duration,
        timings: _timings,
        notes,
        ...stable
      } = report;
      return {
        ...stable,
        // The engine deliberately reports wall-clock timing both structurally
        // and as a human note. Recovery parity compares the semantic report.
        notes: notes.filter((note) => note.code !== "perf-timing"),
      };
    };
    const controlCanonical = stableReport(controlReport);
    const recoveredCanonical = stableReport(recoveredReport);
    expect(recoveredCanonical).toEqual(controlCanonical);
  });
});
