import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type {
  PdfExportJobRequestV1,
  ResourceEstimateV1,
} from "@atlcli/export-jobs";
import type {
  PdfExportResultIntentV1,
  PdfExportResultRecoveryKeyV1,
} from "@atlcli/export-wiring/jobs";
import { createPdfExportJobExecutor } from "@atlcli/export-wiring/jobs";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfExportReport, PreparedPdfExportV1 } from "@atlcli/pdf/browser";
import {
  IndexedDbExportJobCatalog,
  recoverAndClaimExtensionExportJob,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createExtensionPdfExportResultStore,
  createExtensionPdfReadyToRenderStore,
  readExtensionPdfExportReport,
} from "../../utils/export-jobs/executor-store.js";
import {
  createExtensionExportExecutionContext,
  runClaimedExtensionExportJob,
} from "../../utils/export-jobs/runtime.js";
import { IncrementalSha256 } from "../../utils/export-jobs/sha256.js";

globalThis.IDBKeyRange = IDBKeyRange;

const limits = {
  maxObjectBytes: 16 * 1024 * 1024,
  maxJobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

function request(id: string): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id: "42", version: 7 },
      scope: { kind: "page" },
    },
    authRef: "session:https://site.atlassian.net",
    displayName: "Guide",
    requestedFilename: "Guide.pdf",
    createdAt: 10,
    priority: "interactive",
    output: { policy: "collect" },
    template: { kind: "builtin", id: "builtin", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true },
  };
}

function prepared(): PreparedPdfExportV1 {
  return {
    schema: "atlcli.prepared-pdf-export/1",
    bundle: {
      main: "#set page(width: 10cm)",
      template: "#let render(body) = body",
      assets: [{
        path: "assets/logo.png",
        bytes: Uint8Array.from([137, 80, 78, 71]),
        mediaType: "image/png",
      }],
      sourceMap: [],
      notes: [],
    },
    filename: "Guide.pdf",
    profile: "tagged",
    codeTheme: "github-light",
    language: "en",
    sourceNotes: [],
    bundleNotes: [],
    counts: { images: 1, diagrams: 0, skipped: 0 },
    complete: true,
    startedAt: 10,
    prepareMs: 5,
  };
}

const estimate: ResourceEstimateV1 = {
  heapBytes: 1024,
  spoolBytes: 2048,
  outputBytes: 4096,
  rasterPixels: 0,
  confidence: "estimated",
};

function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ancestors.has(value)) throw new Error("cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(bytes: Uint8Array): string {
  const hasher = new IncrementalSha256();
  hasher.update(bytes);
  return hasher.digestHex();
}

function report(): PdfExportReport {
  return {
    filename: "Guide.pdf",
    profile: "tagged",
    codeTheme: "github-light",
    compilerVersion: "test",
    embeddedImages: 1,
    renderedDiagrams: 0,
    skippedAssets: 0,
    notes: [],
    sourceNotes: [],
    complete: true,
    compilerDiagnostics: [],
    timings: { prepareMs: 5, compileMs: 7, emitMs: 2, totalMs: 14 },
  };
}

function resultKey(jobId: string, checkpointRef: string): PdfExportResultRecoveryKeyV1 {
  return {
    schema: "atlcli.pdf-result-key/1",
    ref: `pdf-result:${jobId}`,
    jobId,
    requestId: jobId,
    requestKey: `idem:${jobId}`,
    requestSha256: "1".repeat(64),
    checkpointRef,
    preparedByteLength: 100,
    preparedSha256: "2".repeat(64),
    estimate,
  };
}

describe("extension PDF executor stores", () => {
  it("runs the real host-neutral PDF executor through IDB checkpoint, report, and artifact finalization", async () => {
    const factory = new IDBFactory();
    const now = () => 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now });
    const bytes = new IndexedDbExportByteStore({ factory, now });
    const durableRequest = request("integrated-job");
    await catalog.create({ request: durableRequest });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:integrated",
      now: now(),
      leaseDurationMs: 1_000,
    });
    if (!claimed) throw new Error("Expected integrated claim.");
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [{ type: "text", text: "Hello from the durable executor" }],
    }];
    const validPdf = new TextEncoder().encode(
      "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n",
    );
    const executor = createPdfExportJobExecutor({
      async resolveInput() {
        return {
          input: {
            blocks,
            metadata: { title: "Guide", exportedAt: new Date("2026-07-23T00:00:00Z") },
            filename: "Guide.pdf",
            sourceNotes: [],
          },
          env: { assets: { resolve: async () => { throw new Error("no assets expected"); } } },
        };
      },
      readyToRender: createExtensionPdfReadyToRenderStore({
        factory,
        now,
        bytes,
        spoolLimits: limits,
      }),
      estimateRender: () => ({
        heapBytes: 4 * 1024 * 1024,
        spoolBytes: 4 * 1024 * 1024,
        outputBytes: 4 * 1024 * 1024,
        rasterPixels: 0,
        confidence: "estimated",
      }),
      compiler: {
        compile: async () => ({
          pdf: validPdf,
          diagnostics: [],
          compilerVersion: "test",
        }),
      },
      renderReservations: {
        acquire: async () => ({ reconcile: async () => {}, release: () => {} }),
      },
      results: createExtensionPdfExportResultStore({
        factory,
        now,
        bytes,
        spoolLimits: limits,
      }),
      now,
    });

    const succeeded = await runClaimedExtensionExportJob({
      claimed,
      catalog,
      bytes,
      executor,
      now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: limits,
    });

    expect(succeeded).toMatchObject({
      state: "succeeded",
      stage: "commit",
      artifact: { filename: "Guide.pdf", byteLength: validPdf.byteLength },
      reportSummary: { completeness: "complete" },
    });
    const output: number[] = [];
    for await (const chunk of bytes.read(succeeded.artifact!.ref)) output.push(...chunk);
    expect(output).toEqual([...validPdf]);
    expect((await readExtensionPdfExportReport(succeeded.reportRef!, {
      factory,
      bytes,
      spoolLimits: limits,
    }))?.filename).toBe("Guide.pdf");
  });

  it("materializes a prepared payload after owner loss and fences attempt increments", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    const durableRequest = request("ready-job");
    await catalog.create({ request: durableRequest });
    const first = await catalog.claimNext({
      ownerId: "offscreen:first",
      now,
      leaseDurationMs: 10,
    });
    if (!first) throw new Error("Expected first claim.");
    const ready = createExtensionPdfReadyToRenderStore({
      factory,
      now: () => now,
      bytes,
      spoolLimits: limits,
    });
    const checkpoint = await ready.commit({
      jobId: first.id,
      leaseEpoch: first.leaseEpoch,
      request: durableRequest,
      prepared: prepared(),
      binding: { byteLength: 100, sha256: "2".repeat(64) },
      estimate,
      signal: new AbortController().signal,
    });
    const concurrent = await Promise.allSettled([
      ready.beginRenderAttempt({
        checkpoint,
        jobId: first.id,
        leaseEpoch: first.leaseEpoch,
        signal: new AbortController().signal,
      }),
      ready.beginRenderAttempt({
        checkpoint,
        jobId: first.id,
        leaseEpoch: first.leaseEpoch,
        signal: new AbortController().signal,
      }),
    ]);
    expect(concurrent.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(concurrent.find((entry) => entry.status === "fulfilled")?.value.renderAttempts).toBe(1);
    expect(concurrent.find((entry) => entry.status === "rejected")?.reason).toMatchObject({
      code: "revision-conflict",
    });

    now = 21;
    const recovered = await recoverAndClaimExtensionExportJob(catalog, {
      now,
      ownerId: "offscreen:second",
      leaseDurationMs: 10,
    });
    if (!recovered) throw new Error("Expected recovered claim.");
    const loaded = await ready.load({
      jobId: recovered.id,
      request: durableRequest,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ ref: checkpoint.ref, renderAttempts: 1 });
    await expect(ready.beginRenderAttempt({
      checkpoint: loaded!,
      jobId: first.id,
      leaseEpoch: first.leaseEpoch,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "revision-conflict" });
    const materialized = await ready.materialize({
      checkpoint: loaded!,
      jobId: recovered.id,
      leaseEpoch: recovered.leaseEpoch,
      signal: new AbortController().signal,
    });
    expect(materialized).toEqual(prepared());
    expect(materialized.bundle?.assets[0]?.bytes).toBeInstanceOf(Uint8Array);
    const secondMaterialization = await ready.materialize({
      checkpoint: loaded!,
      jobId: recovered.id,
      leaseEpoch: recovered.leaseEpoch,
      signal: new AbortController().signal,
    });
    materialized.bundle!.assets[0]!.bytes[0] = 1;
    expect(secondMaterialization.bundle!.assets[0]!.bytes[0]).toBe(137);
    const secondAttempt = await ready.beginRenderAttempt({
      checkpoint: loaded!,
      jobId: recovered.id,
      leaseEpoch: recovered.leaseEpoch,
      signal: new AbortController().signal,
    });
    expect(secondAttempt.renderAttempts).toBe(2);
  });

  it("journals report and rebinds a completed staged result across lease epochs in O(1)", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    const durableRequest = request("result-job");
    await catalog.create({ request: durableRequest });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:first",
      now,
      leaseDurationMs: 10,
    });
    if (!claimed) throw new Error("Expected claim.");
    const runtime = createExtensionExportExecutionContext({
      claimed,
      catalog,
      bytes,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: limits,
    });
    const results = createExtensionPdfExportResultStore({
      factory,
      now: () => now,
      bytes,
      spoolLimits: limits,
    });
    const pdfReport = report();
    const key = resultKey(claimed.id, "extension-ready:test");
    const intent: PdfExportResultIntentV1 = {
      schema: "atlcli.pdf-result-intent/1",
      key,
      artifact: {
        mediaType: "application/pdf",
        filename: "Guide.pdf",
        byteLength: 3,
        sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      },
      reportRef: `${key.ref}:report`,
      reportSha256: sha256(new TextEncoder().encode(canonical(pdfReport))),
      reportSummary: {
        issues: { info: 0, warning: 0, error: 0 },
        topCodes: [],
        completeness: "complete",
      },
    };
    await results.prepare({ intent, report: pdfReport }, runtime.context);
    expect(await results.recover(key, runtime.context)).toBeUndefined();
    expect(await results.recover({ ...key, ref: "pdf-result:missing" }, runtime.context)).toBeUndefined();
    const result = await results.stage({
      intent,
      artifact: {
        ...intent.artifact,
        bytes: (async function* () { yield Uint8Array.from([1, 2, 3]); })(),
      },
    }, runtime.context);
    expect(await results.recover(key, runtime.context)).toEqual({ intent, result });
    expect(await readExtensionPdfExportReport(intent.reportRef, {
      factory,
      bytes,
      spoolLimits: limits,
    })).toEqual(pdfReport);
    await runtime.stop();

    now = 21;
    const recovered = await recoverAndClaimExtensionExportJob(catalog, {
      now,
      ownerId: "offscreen:second",
      leaseDurationMs: 10,
    });
    if (!recovered) throw new Error("Expected recovered claim.");
    const secondRuntime = createExtensionExportExecutionContext({
      claimed: recovered,
      catalog,
      bytes,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
      spoolLimits: limits,
    });
    const rebound = await results.recover(key, secondRuntime.context);
    expect(rebound).toMatchObject({
      intent,
      result: {
        stagedArtifact: {
          jobId: recovered.id,
          leaseEpoch: recovered.leaseEpoch,
          filename: "Guide.pdf",
        },
      },
    });
    const succeeded = await catalog.finalizeArtifact({
      id: recovered.id,
      expectedRevision: recovered.revision,
      leaseEpoch: recovered.leaseEpoch,
      stagedArtifact: rebound!.result.stagedArtifact,
      reportRef: rebound!.result.reportRef,
      reportSummary: rebound!.result.reportSummary,
      finishedAt: now,
    });
    expect(succeeded.state).toBe("succeeded");
    expect(await bytes.getStaged(recovered.id, recovered.leaseEpoch)).toBeUndefined();
    const artifactBytes: number[] = [];
    for await (const chunk of bytes.read(succeeded.artifact!.ref)) artifactBytes.push(...chunk);
    expect(artifactBytes).toEqual([1, 2, 3]);
    await secondRuntime.stop();

    now = 22;
    const delivered = await catalog.deliver(succeeded.id, succeeded.revision, now);
    expect(await catalog.deleteTerminal({ finishedBefore: 23, limit: 1 })).toEqual({
      deletedJobIds: [succeeded.id],
      tombstoneRefs: [`tombstone:${succeeded.id}:${delivered.revision}`],
    });
    expect(await readExtensionPdfExportReport(intent.reportRef, {
      factory,
      bytes,
      spoolLimits: limits,
    })).toBeUndefined();
    await bytes.cleanupJob(succeeded.id);
    expect(await bytes.listNamespaceRefs(succeeded.id, claimed.leaseEpoch)).toEqual([]);
  });
});
