import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  createEmptyExportJobStatsV1,
  type DocxExportJobRequestV1,
  ExportJobExecutor,
  ExportJobRequestV1,
  ExportJobStage,
} from "@atlcli/export-jobs";
import { ConfluenceSourceResolutionError } from "@atlcli/export-wiring/jobs";
import {
  IndexedDbExportJobCatalog,
  recoverAndClaimExtensionExportJob,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createExtensionExportExecutionContext,
  runClaimedExtensionExportJob,
} from "../../utils/export-jobs/runtime.js";
import { createExtensionPdfJobRequest } from "../../utils/export-jobs/pdf-request.js";
import type { PdfExportRequest } from "../../utils/ports/export.js";

globalThis.IDBKeyRange = IDBKeyRange;

function request(): PdfExportRequest {
  return {
    pageUrl: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42/Guide",
    page: {
      details: { id: "42", title: "Guide", version: 7, spaceKey: "DOCS", storage: "<p>ignored</p>" },
      markdown: "ignored",
      wordCount: 1,
      attachments: [],
    },
  };
}

function durableDocxRequest(id: string): DocxExportJobRequestV1 {
  return {
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
    displayName: "Guide",
    requestedFilename: "Guide.docx",
    createdAt: 10,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "template:guide",
      sha256: "a".repeat(64),
      name: "guide.docx",
      uploadedAt: 1,
    },
    options: { embedImages: true, resolveMacros: true },
  };
}

describe("extension export execution runtime", () => {
  it("publishes checkpoint refs and reads their owned spool bytes after lease recovery", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    const durable = createExtensionPdfJobRequest(request(), {
      requestId: "job-source-recovery",
      now: () => now,
    });
    await catalog.create({ request: durable });
    const firstClaim = await catalog.claimNext({
      ids: [durable.id],
      ownerId: "offscreen:first-source-owner",
      now,
      leaseDurationMs: 100,
    });
    if (!firstClaim) throw new Error("Expected the source recovery job to be claimed.");
    const limits = {
      maxObjectBytes: 1024,
      maxJobBytes: 4096,
      maxTotalBytes: 8192,
    };
    const first = createExtensionExportExecutionContext({
      claimed: firstClaim,
      catalog,
      bytes,
      spoolLimits: limits,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
    });
    const object = await first.context.spool.put(
      { namespace: "source-pages", key: "page-0" },
      (async function* () { yield new TextEncoder().encode("normalized page"); })(),
    );
    await first.context.checkpoint("source-checkpoint:page-0");
    expect(first.context.checkpointRef).toBe("source-checkpoint:page-0");
    await first.stop();

    now = 111;
    const secondClaim = await recoverAndClaimExtensionExportJob(catalog, {
      ids: [durable.id],
      ownerId: "offscreen:second-source-owner",
      now,
      leaseDurationMs: 100,
    });
    if (!secondClaim) throw new Error("Expected the expired source job to be reclaimed.");
    expect(secondClaim).toMatchObject({
      leaseEpoch: 2,
      checkpointRef: "source-checkpoint:page-0",
    });
    const second = createExtensionExportExecutionContext({
      claimed: secondClaim,
      catalog,
      bytes,
      spoolLimits: limits,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
    });
    const recovered: number[] = [];
    for await (const chunk of second.context.readSpool!(object.ref)) {
      recovered.push(...chunk);
    }
    expect(new TextDecoder().decode(Uint8Array.from(recovered)))
      .toBe("normalized page");
    await second.stop();
  });

  it("executes and atomically finalizes a claimed job without a panel owner", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    const durable = createExtensionPdfJobRequest(request(), { requestId: "job-runtime", now: () => now });
    const queued = await catalog.create({ request: durable });
    expect(queued.checkpointRef).toBe(queued.requestRef);
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:test",
      now,
      leaseDurationMs: 30_000,
      ids: [queued.id],
    });
    if (!claimed) throw new Error("Expected the test job to be claimed.");

    const executor: ExportJobExecutor<ExportJobRequestV1> = {
      format: "pdf",
      async execute(_input, context) {
        await context.updateProgress({ stage: "render", done: 0, total: 1, updatedAt: 20 });
        await context.updateStats({
          ...createEmptyExportJobStatsV1(),
          pages: { discovered: 1, fetched: 1, composed: 1, skipped: 0 },
        });
        const artifact = await context.artifacts.stage({
          mediaType: "application/pdf",
          filename: "Guide.pdf",
          byteLength: 3,
          sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
          bytes: (async function* () { yield Uint8Array.from([1, 2, 3]); })(),
        });
        now = 30;
        const beforeHeartbeat = await catalog.get(context.jobId);
        if (!beforeHeartbeat) throw new Error("Expected the running extension job.");
        await catalog.compareAndSet({
          kind: "heartbeat",
          id: beforeHeartbeat.id,
          expectedRevision: beforeHeartbeat.revision,
          ownerId: "offscreen:test",
          leaseEpoch: beforeHeartbeat.leaseEpoch,
          now,
          leaseDurationMs: 30_000,
        });
        // The executor captured this before the heartbeat was durably written.
        await context.updateProgress({ stage: "commit", done: 1, total: 1, updatedAt: 20 });
        return {
          stagedArtifact: artifact,
          reportRef: "report:job-runtime",
          reportSummary: {
            issues: { info: 0, warning: 0, error: 0 },
            topCodes: [],
            completeness: "complete",
          },
        };
      },
    };

    now = 20;
    const finished = await runClaimedExtensionExportJob({
      claimed,
      catalog,
      bytes,
      executor,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: {
        maxObjectBytes: 16 * 1024 * 1024,
        maxJobBytes: 256 * 1024 * 1024,
        maxTotalBytes: 512 * 1024 * 1024,
      },
    });

    expect(finished).toMatchObject({
      id: "job-runtime",
      state: "succeeded",
      reportRef: "report:job-runtime",
      artifact: { filename: "Guide.pdf", byteLength: 3 },
      stats: {
        pages: { discovered: 1, fetched: 1, composed: 1, skipped: 0 },
        metricSupport: {
          "storage.spoolPeakBytes": "unavailable",
          "memory.heapPeakBytes": "unavailable",
          "memory.rendererPeakBytes": "unavailable",
        },
      },
    });
    expect(finished.progress).toMatchObject({
      stage: "commit",
      done: 1,
      total: 1,
      updatedAt: 30,
    });
    expect((await catalog.readEvents(finished.id)).events).toEqual([
      { kind: "stage", seq: 1, at: 20, stage: "render" },
      {
        kind: "progress",
        seq: 2,
        at: 20,
        progress: { stage: "render", done: 0, total: 1, updatedAt: 20 },
      },
      { kind: "stage", seq: 3, at: 30, stage: "commit" },
      {
        kind: "progress",
        seq: 4,
        at: 30,
        progress: { stage: "commit", done: 1, total: 1, updatedAt: 30 },
      },
      { kind: "state", seq: 5, at: 30, from: "running", to: "succeeded" },
      {
        kind: "artifact",
        seq: 6,
        at: 30,
        artifact: finished.artifact!,
      },
    ]);
    expect(await bytes.getStaged(finished.id, finished.leaseEpoch)).toBeUndefined();
    const collected: number[] = [];
    for await (const chunk of bytes.read(finished.artifact!.ref)) collected.push(...chunk);
    expect(collected).toEqual([1, 2, 3]);
  });

  it("turns executor failures into a durable retry decision", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => 10 });
    const durable = createExtensionPdfJobRequest(request(), { requestId: "job-failure", now: () => 10 });
    await catalog.create({ request: durable });
    const claimed = await catalog.claimNext({ ownerId: "offscreen:test", now: 10, leaseDurationMs: 30_000 });
    if (!claimed) throw new Error("Expected the test job to be claimed.");

    const failed = await runClaimedExtensionExportJob({
      claimed,
      catalog,
      bytes,
      executor: { format: "pdf", execute: async () => { throw new Error("render exploded"); } },
      now: () => 20,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: { maxObjectBytes: 1024, maxJobBytes: 2048, maxTotalBytes: 4096 },
    });

    expect(failed).toMatchObject({
      state: "failed",
      checkpointRef: "request:job-failure",
      error: { code: "executor.failed", message: "render exploded" },
    });
    expect((await catalog.readEvents(failed.id)).events).toMatchObject([
      { kind: "state", from: "running", to: "failed" },
      { kind: "issue", level: "error", code: "executor.failed" },
    ]);
  });

  it("pauses a sanitized expired-session source failure at a replay-safe auth checkpoint", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    const durable = createExtensionPdfJobRequest(request(), {
      requestId: "job-auth-wait",
      now: () => now,
    });
    await catalog.create({ request: durable });
    const claimed = await catalog.claimNext({
      ids: [durable.id],
      ownerId: "offscreen:first-session",
      now,
      leaseDurationMs: 30_000,
    });
    if (!claimed) throw new Error("Expected the auth test job to be claimed.");

    now = 20;
    const waiting = await runClaimedExtensionExportJob({
      claimed,
      catalog,
      bytes,
      executor: {
        format: "pdf",
        execute: async () => {
          throw new ConfluenceSourceResolutionError("authentication");
        },
      },
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: {
        maxObjectBytes: 1024,
        maxJobBytes: 2048,
        maxTotalBytes: 4096,
      },
    });

    expect(waiting).toMatchObject({
      id: durable.id,
      state: "waiting",
      waiting: { reason: "auth" },
      checkpointRef: waiting.requestRef,
      leaseEpoch: 1,
      attempt: 1,
      error: {
        code: "auth.session-expired",
        category: "auth",
        retryable: true,
        occurredAt: 20,
      },
    });
    expect(waiting.lease).toBeUndefined();
    expect(waiting.finishedAt).toBeUndefined();
    expect((await catalog.readEvents(waiting.id)).events).toMatchObject([
      { kind: "state", from: "running", to: "waiting" },
      { kind: "issue", level: "error", code: "auth.session-expired" },
    ]);

    expect(
      await catalog.claimNext({
        ids: [durable.id],
        ownerId: "offscreen:automatic",
        now: 21,
        leaseDurationMs: 30_000,
      }),
    ).toBeUndefined();

    const resumed = await catalog.claimNext({
      ids: [durable.id],
      resumeWaitingIds: [durable.id],
      ownerId: "offscreen:after-sign-in",
      now: 22,
      leaseDurationMs: 30_000,
    });
    expect(resumed).toMatchObject({
      state: "running",
      leaseEpoch: 2,
      attempt: 2,
      checkpointRef: waiting.requestRef,
    });
  });

  it("durably cancels DOCX execution from every observable pipeline stage", async () => {
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
      const factory = new IDBFactory();
      let now = 100 + index;
      const catalog = new IndexedDbExportJobCatalog({
        factory,
        now: () => now,
      });
      const bytes = new IndexedDbExportByteStore({
        factory,
        now: () => now,
      });
      const durable = durableDocxRequest(`docx-cancel-${stage}`);
      await catalog.create({ request: durable });
      const claimed = await catalog.claimNext({
        ownerId: "offscreen:docx-cancel",
        now,
        leaseDurationMs: 30_000,
      });
      if (!claimed) throw new Error(`Expected DOCX claim for ${stage}.`);

      const controller = new AbortController();
      let executorObservedAbort = false;
      const executor: ExportJobExecutor<ExportJobRequestV1> = {
        format: "docx",
        async execute(_input, context): Promise<never> {
          await context.updateProgress({
            stage,
            done: index,
            total: stages.length,
            detail: `cancel at ${stage}`,
            updatedAt: now,
          });
          controller.abort(
            new DOMException(`Cancelled during ${stage}.`, "AbortError"),
          );
          await new Promise<never>((_resolve, reject) => {
            const observe = (): void => {
              executorObservedAbort = true;
              reject(context.signal.reason);
            };
            if (context.signal.aborted) observe();
            else context.signal.addEventListener("abort", observe, { once: true });
          });
          throw new Error("Unreachable after DOCX cancellation.");
        },
      };

      now += 1;
      const cancelled = await runClaimedExtensionExportJob({
        claimed,
        catalog,
        bytes,
        executor,
        signal: controller.signal,
        now: () => now,
        heartbeatIntervalMs: 60_000,
        cancelPollMs: 60_000,
        spoolLimits: {
          maxObjectBytes: 1024,
          maxJobBytes: 2048,
          maxTotalBytes: 4096,
        },
      });

      expect(executorObservedAbort).toBe(true);
      expect(cancelled).toMatchObject({
        id: durable.id,
        format: "docx",
        state: "cancelled",
        stage,
        progress: {
          stage,
          done: index,
          total: stages.length,
          detail: `cancel at ${stage}`,
        },
      });
      expect((await catalog.readEvents(cancelled.id)).events.at(-1)).toMatchObject({
        kind: "state",
        from: "cancelling",
        to: "cancelled",
      });
      expect(await bytes.getStaged(cancelled.id, cancelled.leaseEpoch)).toBeUndefined();
    }
  });
});
