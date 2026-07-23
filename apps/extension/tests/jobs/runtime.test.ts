import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { ExportJobExecutor, ExportJobRequestV1 } from "@atlcli/export-jobs";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { runClaimedExtensionExportJob } from "../../utils/export-jobs/runtime.js";
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

describe("extension export execution runtime", () => {
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
        const artifact = await context.artifacts.stage({
          mediaType: "application/pdf",
          filename: "Guide.pdf",
          byteLength: 3,
          sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
          bytes: (async function* () { yield Uint8Array.from([1, 2, 3]); })(),
        });
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
    });
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
  });
});
