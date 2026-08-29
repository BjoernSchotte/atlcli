import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { ExportJobRequestV1 } from "@atlcli/export-jobs";
import { encodePng, normalizeRasterAssetV1 } from "@atlcli/export-media";
import type { PutPdfJobInput, StoredPdfJob } from "../../utils/pdf/job-store.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createProductiveExtensionPdfExecutor,
  estimateExtensionPdfRenderV1,
  EXTENSION_PDF_MAX_OUTPUT_BYTES_V1,
  EXTENSION_PDF_SPOOL_LIMITS_V1,
} from "../../utils/export-jobs/pdf-executor.js";
import { createExtensionPdfJobRequest } from "../../utils/export-jobs/pdf-request.js";
import { BrowserRenderReservationPoolV1 } from "../../utils/export-jobs/render-reservation.js";
import { runClaimedExtensionExportJob } from "../../utils/export-jobs/runtime.js";
import type { PdfExportRequest } from "../../utils/ports/export.js";

const page = {
  details: {
    id: "123",
    title: "Durable guide",
    version: 7,
    storage: "<p>never persisted in the unresolved request</p>",
  },
  markdown: "never persisted in the unresolved request",
  wordCount: 6,
  attachments: [],
};

function input(): PdfExportRequest {
  return {
    page,
    pageUrl: "https://example.atlassian.net/wiki/spaces/DOC/pages/123",
  };
}

describe("productive extension PDF executor", () => {
  it("runs one outer job through the private compiler bridge and retained stores", async () => {
    const factory = new IDBFactory();
    const now = () => 100;
    const catalog = new IndexedDbExportJobCatalog({ factory, now });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now,
      maxArtifactBytes: EXTENSION_PDF_MAX_OUTPUT_BYTES_V1,
      maxJobBytes: EXTENSION_PDF_SPOOL_LIMITS_V1.maxJobBytes,
      maxTotalBytes: EXTENSION_PDF_SPOOL_LIMITS_V1.maxTotalBytes,
    });
    const request = createExtensionPdfJobRequest({ ...input(), imageProfile: "standard" }, {
      requestId: "outer-pdf",
      now,
    });
    await catalog.create({ request });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:test",
      now: now(),
      leaseDurationMs: 10_000,
    });
    if (!claimed) throw new Error("Expected a claimed PDF job.");

    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [{ type: "text", text: "Background PDF" }],
    }, {
      type: "image",
      source: { kind: "attachment", filename: "neutral.png" },
      alt: "Neutral generated raster",
    }];
    const pixels = new Uint8Array(32 * 32 * 4).fill(0xff);
    const raster = encodePng(pixels, 32, 32, false);
    const pdf = new TextEncoder().encode(
      "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n",
    );
    const privateJobs = new Map<string, StoredPdfJob>();
    const compilerCalls: Array<{ jobId: string; parentJobId?: string; hidden?: boolean }> = [];
    const lifecycle: string[] = [];
    let nextLegacyId = 0;

    const executor = createProductiveExtensionPdfExecutor({
      catalog,
      bytes,
      now,
      renderPool: new BrowserRenderReservationPoolV1(),
      compilerHost: {
        async compile(jobId) {
          lifecycle.push("compile");
          const stored = privateJobs.get(jobId);
          if (!stored) throw new Error("Private compiler row was not created.");
          compilerCalls.push({
            jobId,
            parentJobId: stored.parentJobId,
            hidden: stored.activityVisibility === "private",
          });
          privateJobs.set(jobId, {
            ...stored,
            status: "complete",
            pdf,
            outputBytes: pdf.byteLength,
            compilerVersion: "test-compiler",
          });
          return { kind: "pdf-worker:complete", jobId, ok: true };
        },
        async cancel() {
          return true;
        },
      },
      resolveInput: async () => ({
        input: {
          blocks,
          metadata: {
            title: "Durable guide",
            exportedAt: new Date("2026-07-23T00:00:00Z"),
          },
          filename: "Durable guide.pdf",
          sourceNotes: [],
        },
        env: {
          assets: {
            resolve: async () => ({
              bytes: raster,
              mediaType: "image/png",
              filename: "neutral.png",
            }),
          },
        },
      }),
      rasterNormalizerLeaseFactory: {
        async acquire() {
          lifecycle.push("normalizer-acquire");
          return {
            rasterNormalizer: { normalize: normalizeRasterAssetV1 },
            evidence: {
              schema: "atlcli.pdf-raster-normalizer-evidence/1",
              backend: "pure-ts",
              revision: "pure-ts-v1",
            },
            release() {
              lifecycle.push("normalizer-release");
            },
          };
        },
      },
      storageOptions: { factory },
      privateCompilerDeps: {
        makeJobId: () => `private-${++nextLegacyId}`,
        now,
        async createJob(value: PutPdfJobInput) {
          privateJobs.set(value.id, {
            ...value,
            createdAt: value.createdAt ?? now(),
            status: "prepared",
            inputBytes: 1,
            outputBytes: 0,
          });
        },
        async getJob(id) {
          return privateJobs.get(id);
        },
        async consumeJob() {},
        async deleteJob(id) {
          privateJobs.delete(id);
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
      spoolLimits: EXTENSION_PDF_SPOOL_LIMITS_V1,
    });

    expect(succeeded).toMatchObject({
      id: "outer-pdf",
      state: "succeeded",
      artifact: {
        filename: "Durable guide.pdf",
        byteLength: pdf.byteLength,
      },
      reportSummary: { completeness: "complete" },
    });
    expect(compilerCalls).toEqual([{
      jobId: "private-1",
      parentJobId: "outer-pdf",
      hidden: true,
    }]);
    expect(privateJobs.size).toBe(0);
    expect(lifecycle).toEqual([
      "normalizer-acquire",
      "normalizer-release",
      "compile",
    ]);
    expect(await catalog.list()).toHaveLength(1);
    expect(await catalog.listLegacyBridges()).toEqual([]);

    const artifact: number[] = [];
    for await (const chunk of bytes.read(succeeded.artifact!.ref)) {
      artifact.push(...chunk);
    }
    expect(artifact).toEqual([...pdf]);
  });

  it("uses the exact conservative browser admission envelope", () => {
    const estimate = estimateExtensionPdfRenderV1(
      {
        blocks: [],
        metadata: { title: "x", exportedAt: new Date(0) },
        filename: "x.pdf",
        sourceNotes: [],
      },
      {} as ExportJobRequestV1 & { format: "pdf" },
    );
    expect(estimate).toEqual({
      heapBytes: 512 * 1024 * 1024,
      spoolBytes: 128 * 1024 * 1024,
      outputBytes: 64 * 1024 * 1024,
      rasterPixels: 32 * 1024 * 1024,
      confidence: "unknown",
    });
  });
});
