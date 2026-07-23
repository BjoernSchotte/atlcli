import { describe, expect, it } from "bun:test";
import type { TreeSource } from "@atlcli/confluence";
import {
  runPdfExport,
  type PdfCompilePort,
  type PdfExportReport,
  type PdfOutputSink,
} from "@atlcli/pdf";
import type {
  ExportJobExecutionContext,
  PdfExportJobRequestV1,
  PendingArtifactV1,
  ResourceEstimateV1,
  StagedArtifactV1,
} from "@atlcli/export-jobs";
import {
  createConfluencePdfResolveInputV1,
} from "./confluence-job-resolve-input.js";
import {
  createPdfExportJobExecutor,
  PdfRenderRestartLimitError,
  type CreatePdfExportJobExecutorOptionsV1,
  type PdfExportResultIntentV1,
  type PdfExportResultRecoveryKeyV1,
  type PdfReadyToRenderCheckpointV1,
  type PdfReadyToRenderStoreV1,
} from "./pdf-job-executor.js";

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /Type/Catalog /Lang (en) /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n",
);
const estimate: ResourceEstimateV1 = {
  heapBytes: 1_000,
  spoolBytes: 2_000,
  outputBytes: 3_000,
  rasterPixels: 0,
  confidence: "estimated",
};

function request(): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "request-1",
    idempotencyKey: "action-1",
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "page-id", id: "123" },
      scope: { kind: "page" },
    },
    authRef: "session:default",
    displayName: "Test page",
    requestedFilename: "test.pdf",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true, profile: "tagged" },
  };
}

function engineInput() {
  return {
    input: {
      blocks: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Hello" }] }],
      sourceNotes: [{ level: "info" as const, code: "browser-harness" as const, message: "source" }],
      metadata: {
        title: "Test page",
        language: "en",
        exportedAt: new Date("2026-07-22T00:00:00.000Z"),
      },
      filename: "test.pdf",
      profile: "tagged" as const,
    },
    env: { assets: { resolve: async () => { throw new Error("no assets"); } } },
  };
}

class MemoryReadyStore implements PdfReadyToRenderStoreV1 {
  record?: PdfReadyToRenderCheckpointV1;
  prepared?: Parameters<PdfReadyToRenderStoreV1["commit"]>[0]["prepared"];
  commits = 0;
  attempts = 0;
  readonly order: string[];

  constructor(order: string[] = []) {
    this.order = order;
  }

  async load(): Promise<PdfReadyToRenderCheckpointV1 | undefined> {
    return this.record;
  }

  async commit(input: Parameters<PdfReadyToRenderStoreV1["commit"]>[0]) {
    this.commits += 1;
    this.order.push("ready-commit");
    this.prepared = structuredClone(input.prepared);
    this.record = {
      schema: "atlcli.pdf-ready-to-render/1",
      ref: "render/job-1/manifest.json",
      jobId: input.jobId,
      requestId: input.request.id,
      requestKey: input.request.idempotencyKey,
      preparedRef: "render/job-1/prepared.json",
      preparedByteLength: input.binding.byteLength,
      preparedSha256: input.binding.sha256,
      estimate: input.estimate,
      renderAttempts: 0,
    };
    return this.record;
  }

  async materialize() {
    this.order.push("materialize");
    if (!this.prepared) throw new Error("prepared PDF missing");
    return structuredClone(this.prepared);
  }

  async beginRenderAttempt(input: Parameters<PdfReadyToRenderStoreV1["beginRenderAttempt"]>[0]) {
    this.attempts += 1;
    this.order.push(`attempt-${this.attempts}`);
    this.record = { ...input.checkpoint, renderAttempts: input.checkpoint.renderAttempts + 1 };
    return this.record;
  }
}

function executionContext(options: {
  signal?: AbortSignal;
  leaseEpoch?: number;
  order?: string[];
} = {}): { context: ExportJobExecutionContext; artifactBytes: () => Uint8Array | undefined } {
  let artifact: Uint8Array | undefined;
  const order = options.order ?? [];
  const signal = options.signal ?? new AbortController().signal;
  const context: ExportJobExecutionContext = {
    jobId: "job-1",
    leaseEpoch: options.leaseEpoch ?? 1,
    signal,
    spool: {
      async put() { throw new Error("unused"); },
      async *read() { throw new Error("unused"); },
      async stat() { return undefined; },
    },
    artifacts: {
      async stage(pending: PendingArtifactV1): Promise<StagedArtifactV1> {
        order.push("artifact-stage");
        const chunks: Uint8Array[] = [];
        for await (const chunk of pending.bytes) chunks.push(chunk.slice());
        artifact = chunks.length === 1 ? chunks[0] : undefined;
        return {
          ref: "staged:job-1",
          mediaType: pending.mediaType,
          filename: pending.filename,
          byteLength: pending.byteLength,
          sha256: pending.sha256,
          jobId: "job-1",
          leaseEpoch: options.leaseEpoch ?? 1,
          stagedAt: 10,
        };
      },
      async getStaged() { return undefined; },
    },
    async updateProgress() {},
    async appendEvent() {},
    async checkpoint(ref) {
      expect(ref).toBe("render/job-1/manifest.json");
      order.push("checkpoint-publish");
    },
  };
  return { context, artifactBytes: () => artifact };
}

function executorOptions(input: {
  ready?: MemoryReadyStore;
  compiler?: PdfCompilePort;
  order?: string[];
  reports?: PdfExportReport[];
  resolveCalls?: { count: number };
  resolveInput?: CreatePdfExportJobExecutorOptionsV1["resolveInput"];
  resultStageHook?: () => void;
}) {
  const order = input.order ?? [];
  const ready = input.ready ?? new MemoryReadyStore(order);
  const reports = input.reports ?? [];
  type StoredResult = {
    intent: PdfExportResultIntentV1;
    report: PdfExportReport;
    stagedArtifact?: StagedArtifactV1;
  };
  const storedResults = new Map<string, StoredResult>();
  let latestStoredResult: StoredResult | undefined;
  return {
    ready,
    storedResult: () => latestStoredResult,
    options: {
      async resolveInput(
        request: PdfExportJobRequestV1,
        context: ExportJobExecutionContext,
      ) {
        if (input.resolveCalls) input.resolveCalls.count += 1;
        if (input.resolveInput) return input.resolveInput(request, context);
        return engineInput();
      },
      readyToRender: ready,
      estimateRender: () => estimate,
      compiler: input.compiler ?? {
        async compile() {
          order.push("compile");
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
      renderReservations: {
        async acquire(_reservation: { estimate: ResourceEstimateV1 }) {
          order.push("reservation-acquire");
          return {
            async reconcile(actual: { preparedBytes?: number; outputBytes?: number }) {
              if (actual.preparedBytes !== undefined) order.push(`prepared-${actual.preparedBytes}`);
              if (actual.outputBytes !== undefined) order.push(`output-${actual.outputBytes}`);
            },
            release: () => { order.push("reservation-release"); },
          };
        },
      },
      results: {
        async recover(key: PdfExportResultRecoveryKeyV1, context: ExportJobExecutionContext) {
          const storedResult = storedResults.get(key.ref);
          if (!storedResult?.stagedArtifact) return undefined;
          order.push("result-recover");
          return {
            intent: structuredClone(storedResult.intent),
            result: {
              stagedArtifact: {
                ...storedResult.stagedArtifact,
                jobId: context.jobId,
                leaseEpoch: context.leaseEpoch,
              },
              reportRef: storedResult.intent.reportRef,
              reportSummary: structuredClone(storedResult.intent.reportSummary),
            },
          };
        },
        async prepare(
          prepared: { intent: PdfExportResultIntentV1; report: PdfExportReport },
        ) {
          order.push("result-prepare");
          const record = {
            intent: structuredClone(prepared.intent),
            report: structuredClone(prepared.report),
          };
          storedResults.set(prepared.intent.key.ref, record);
          latestStoredResult = record;
          reports.push(structuredClone(prepared.report));
          return structuredClone(record.intent);
        },
        async stage(
          staged: { intent: PdfExportResultIntentV1; artifact: PendingArtifactV1 },
          context: ExportJobExecutionContext,
        ) {
          order.push("result-stage");
          const storedResult = storedResults.get(staged.intent.key.ref);
          if (!storedResult) throw new Error("result intent missing");
          const stagedArtifact = await context.artifacts.stage(staged.artifact);
          storedResult.stagedArtifact = structuredClone(stagedArtifact);
          input.resultStageHook?.();
          return {
            stagedArtifact,
            reportRef: storedResult.intent.reportRef,
            reportSummary: structuredClone(storedResult.intent.reportSummary),
          };
        },
      },
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    },
  };
}

describe("createPdfExportJobExecutor", () => {
  it("matches direct PDF bytes and canonical report fields through a capture sink", async () => {
    let directBytes: Uint8Array | undefined;
    const directOutput: PdfOutputSink = {
      async emit(_name, handle) { directBytes = (await handle.asUint8Array()).slice(); },
    };
    const direct = await runPdfExport(engineInput().input, {
      ...engineInput().env,
      compiler: {
        compile: async () => ({ pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" }),
      },
      output: directOutput,
      now: (() => { let value = 100; return () => value++; })(),
    });

    const reports: PdfExportReport[] = [];
    const order: string[] = [];
    const fixture = executorOptions({ reports, order });
    const host = executionContext({ order });
    const result = await createPdfExportJobExecutor(fixture.options).execute(request(), host.context);

    const jobBytes = host.artifactBytes();
    expect(jobBytes).toEqual(directBytes);
    expect(jobBytes?.buffer).not.toBe(directBytes?.buffer);
    expect(reports).toHaveLength(1);
    const { timings: _directTimings, ...directCanonical } = direct;
    const { timings: _jobTimings, ...jobCanonical } = reports[0]!;
    expect(jobCanonical).toEqual(directCanonical);
    expect(result).toMatchObject({
      stagedArtifact: { mediaType: "application/pdf", filename: "test.pdf", byteLength: validPdf.byteLength },
      reportSummary: { completeness: "complete", issues: { info: 1, warning: 0, error: 0 } },
    });
    expect(result.reportRef).toMatch(/^pdf-result:[a-f0-9]{64}:report$/);
    expect(result.stagedArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    const preparedReservation = `prepared-${fixture.ready.record!.preparedByteLength}`;
    expect(order[0]).toBe("reservation-acquire");
    expect(order.filter((entry) => entry.startsWith("prepared-"))).toEqual([
      preparedReservation,
      preparedReservation,
    ]);
    expect(order).toEqual([
      "reservation-acquire",
      preparedReservation,
      "ready-commit",
      "checkpoint-publish",
      preparedReservation,
      `output-${estimate.outputBytes}`,
      "attempt-1",
      "materialize",
      "compile",
      `output-${validPdf.byteLength}`,
      "result-prepare",
      "result-stage",
      "artifact-stage",
      "reservation-release",
    ]);
  });

  it("restarts from ready-to-render once without resolving source again", async () => {
    const order: string[] = [];
    const ready = new MemoryReadyStore(order);
    const resolveCalls = { count: 0 };
    let compileCalls = 0;
    const compiler: PdfCompilePort = {
      async compile() {
        compileCalls += 1;
        if (compileCalls === 1) throw new Error("worker lost");
        return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
      },
    };
    const fixture = executorOptions({ ready, compiler, resolveCalls, order });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext({ order }).context),
    ).rejects.toThrow("worker lost");
    expect(ready.record?.renderAttempts).toBe(1);

    order.length = 0;
    const second = await createPdfExportJobExecutor(fixture.options).execute(
      request(),
      executionContext({ leaseEpoch: 2, order }).context,
    );
    expect(second.stagedArtifact.filename).toBe("test.pdf");
    expect({ resolveCalls: resolveCalls.count, commits: ready.commits, compileCalls, attempts: ready.attempts })
      .toEqual({ resolveCalls: 1, commits: 1, compileCalls: 2, attempts: 2 });
    expect(order.indexOf("checkpoint-publish")).toBeLessThan(order.indexOf("reservation-acquire"));

    const recovered = await createPdfExportJobExecutor(fixture.options).execute(
      request(),
      executionContext({ leaseEpoch: 3 }).context,
    );
    expect(recovered.stagedArtifact.leaseEpoch).toBe(3);
    expect(compileCalls).toBe(2);
  });

  it("checkpoints shared ADF resolver state and performs zero source reads on render recovery", async () => {
    const order: string[] = [];
    const ready = new MemoryReadyStore(order);
    let sourceReads = 0;
    const treeSource: TreeSource = {
      async getPage(id) {
        sourceReads += 1;
        return {
          id,
          title: "Root",
          version: 1,
          exportSource: {
            primary: {
              representation: "atlas_doc_format",
              value: JSON.stringify({
                type: "doc",
                version: 1,
                content: [{
                  type: "extension",
                  attrs: { extensionType: "example", extensionKey: "widget" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Visible" }] }],
                }],
              }),
            },
            storageSidecar: "<p>RAW-SIDECAR</p>",
            sourceVersion: 1,
          },
        };
      },
      async getPageVersion() { return { title: "Root", version: 1 }; },
      async getChildren() { return []; },
      async getSpaceHomepageId() { return null; },
    };
    const resolveInput = createConfluencePdfResolveInputV1({
      port: { createTreeSource: () => treeSource },
      build() {
        return {
          input: {
            metadata: { title: "Root", exportedAt: new Date(0) },
            filename: "test.pdf",
          },
          env: { assets: { async resolve() { throw new Error("unused"); } } },
        };
      },
    });
    let compileCalls = 0;
    const fixture = executorOptions({
      ready,
      order,
      resolveInput,
      compiler: {
        async compile() {
          compileCalls += 1;
          if (compileCalls === 1) throw new Error("worker lost");
          return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
        },
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext({ order }).context),
    ).rejects.toThrow("worker lost");
    expect(sourceReads).toBe(1);
    expect(ready.prepared?.sourceNotes.some((note) => note.code === "adf-node-degraded")).toBe(true);
    expect(JSON.stringify(ready.prepared)).not.toContain("RAW-SIDECAR");

    await createPdfExportJobExecutor(fixture.options).execute(
      request(),
      executionContext({ leaseEpoch: 2, order }).context,
    );
    expect(sourceReads).toBe(1);
    expect(ready.commits).toBe(1);
  });

  it("counts materialization loss as a render attempt and stops after one restart", async () => {
    class FailingMaterializeStore extends MemoryReadyStore {
      override async materialize(): Promise<never> {
        this.order.push("materialize");
        throw new Error("materializer lost");
      }
    }
    const ready = new FailingMaterializeStore();
    const resolveCalls = { count: 0 };
    let compileCalls = 0;
    const fixture = executorOptions({
      ready,
      resolveCalls,
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("materializer lost");
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 2 }).context,
      ),
    ).rejects.toThrow("materializer lost");
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 3 }).context,
      ),
    ).rejects.toBeInstanceOf(PdfRenderRestartLimitError);
    expect({ attempts: ready.attempts, compileCalls, resolveCalls: resolveCalls.count }).toEqual({
      attempts: 2,
      compileCalls: 0,
      resolveCalls: 1,
    });
  });

  it("rejects a resumed prepared reservation before materializing or consuming an attempt", async () => {
    class CountingMaterializeStore extends MemoryReadyStore {
      materializeCalls = 0;

      override async materialize() {
        this.materializeCalls += 1;
        return super.materialize();
      }
    }

    const ready = new CountingMaterializeStore();
    let compileCalls = 0;
    const fixture = executorOptions({
      ready,
      compiler: {
        async compile() {
          compileCalls += 1;
          throw new Error("worker lost");
        },
      },
    });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("worker lost");
    expect({ materializeCalls: ready.materializeCalls, attempts: ready.attempts }).toEqual({
      materializeCalls: 1,
      attempts: 1,
    });

    fixture.options.renderReservations = {
      async acquire() {
        return {
          async reconcile(actual) {
            if (actual.preparedBytes !== undefined) throw new Error("prepared budget exhausted");
          },
          release() {},
        };
      },
    };
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 2 }).context,
      ),
    ).rejects.toThrow("prepared budget exhausted");
    expect({ materializeCalls: ready.materializeCalls, attempts: ready.attempts, compileCalls }).toEqual({
      materializeCalls: 1,
      attempts: 1,
      compileCalls: 1,
    });
  });

  it("rejects a swapped materialized payload before compiling", async () => {
    class SwappingStore extends MemoryReadyStore {
      override async materialize() {
        const prepared = await super.materialize();
        return { ...prepared, filename: "foreign.pdf" };
      }
    }
    let compileCalls = 0;
    const fixture = executorOptions({
      ready: new SwappingStore(),
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("does not match its durable checkpoint");
    expect(compileCalls).toBe(0);
  });

  it("rejects mutated prepared asset bytes before compiling", async () => {
    class MutatingAssetStore extends MemoryReadyStore {
      override async materialize() {
        const prepared = await super.materialize();
        const asset = prepared.bundle?.assets[0];
        if (!asset) throw new Error("expected prepared asset");
        asset.bytes[asset.bytes.byteLength - 1] ^= 0xff;
        return prepared;
      }
    }

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    let compileCalls = 0;
    const fixture = executorOptions({
      ready: new MutatingAssetStore(),
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
    });
    (fixture.options as CreatePdfExportJobExecutorOptionsV1).resolveInput = async () => ({
      input: {
        ...engineInput().input,
        blocks: [{
          type: "image" as const,
          alt: "One pixel",
          source: { kind: "attachment" as const, filename: "one.png" },
        }],
      },
      env: {
        assets: {
          async resolve() {
            return { bytes: png.slice(), mediaType: "image/png" };
          },
        },
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("does not match its durable checkpoint");
    expect(compileCalls).toBe(0);
  });

  it("fails closed before compiling when the worst-case output reservation is rejected", async () => {
    let resultStageCalls = 0;
    let compileCalls = 0;
    const fixture = executorOptions({
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
    });
    fixture.options.renderReservations = {
      async acquire() {
        return {
          async reconcile(actual) {
            if (actual.outputBytes !== undefined) throw new Error("output budget exhausted");
          },
          release() {},
        };
      },
    };
    fixture.options.results.stage = async () => {
      resultStageCalls += 1;
      throw new Error("unexpected stage");
    };

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("output budget exhausted");
    expect(resultStageCalls).toBe(0);
    expect(compileCalls).toBe(0);
    expect(fixture.ready.attempts).toBe(0);
  });

  it("treats reservation reconciliation as component-wise monotonic absolute floors", async () => {
    const floors = { preparedBytes: 0, outputBytes: 0 };
    const observations: Array<typeof floors> = [];
    const fixture = executorOptions({});
    fixture.options.renderReservations = {
      async acquire() {
        return {
          async reconcile(actual) {
            floors.preparedBytes = Math.max(floors.preparedBytes, actual.preparedBytes ?? 0);
            floors.outputBytes = Math.max(floors.outputBytes, actual.outputBytes ?? 0);
            observations.push({ ...floors });
          },
          release() {},
        };
      },
    };

    await createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context);

    const preparedBytes = fixture.ready.record!.preparedByteLength;
    expect(observations).toEqual([
      { preparedBytes, outputBytes: 0 },
      { preparedBytes, outputBytes: estimate.outputBytes },
      { preparedBytes, outputBytes: estimate.outputBytes },
    ]);
    expect(validPdf.byteLength).toBeLessThan(estimate.outputBytes);
  });

  it("rejects compiler output larger than the durable hard output cap without staging", async () => {
    let prepareCalls = 0;
    let stageCalls = 0;
    const fixture = executorOptions({});
    fixture.options.estimateRender = () => ({ ...estimate, outputBytes: 1 });
    const originalPrepare = fixture.options.results.prepare;
    const originalStage = fixture.options.results.stage;
    fixture.options.results.prepare = async (...args) => {
      prepareCalls += 1;
      return originalPrepare(...args);
    };
    fixture.options.results.stage = async (...args) => {
      stageCalls += 1;
      return originalStage(...args);
    };

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("exceeds its hard estimate");
    expect({ prepareCalls, stageCalls }).toEqual({ prepareCalls: 0, stageCalls: 0 });
  });

  it("recovers a durably staged result without a second render", async () => {
    const order: string[] = [];
    let compileCalls = 0;
    let loseFirstReturn = true;
    const reports: PdfExportReport[] = [];
    const fixture = executorOptions({
      order,
      reports,
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
      resultStageHook: () => {
        if (loseFirstReturn) {
          loseFirstReturn = false;
          throw new Error("worker lost after durable result stage");
        }
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("worker lost after durable result stage");
    expect(fixture.storedResult()).toBeDefined();

    order.length = 0;
    const recovered = await createPdfExportJobExecutor(fixture.options).execute(
      request(),
      executionContext({ leaseEpoch: 2, order }).context,
    );
    expect(recovered.stagedArtifact.leaseEpoch).toBe(2);
    expect(recovered.reportRef).toMatch(/^pdf-result:[a-f0-9]{64}:report$/);
    expect(compileCalls).toBe(1);
    expect(order).toEqual(["checkpoint-publish", "result-recover"]);
    expect(fixture.ready.attempts).toBe(1);
  });

  it("rejects recovered metadata that is not bound to this request and checkpoint", async () => {
    let loseFirstReturn = true;
    const fixture = executorOptions({
      resultStageHook: () => {
        if (loseFirstReturn) {
          loseFirstReturn = false;
          throw new Error("worker lost after artifact stage");
        }
      },
    });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("worker lost after artifact stage");
    const stored = fixture.storedResult();
    if (!stored?.stagedArtifact) throw new Error("expected staged result fixture");
    fixture.options.results.recover = async (_key, context) => ({
      intent: {
        ...structuredClone(stored.intent),
        key: { ...structuredClone(stored.intent.key), requestId: "foreign-request" },
      },
      result: {
        stagedArtifact: {
          ...stored.stagedArtifact!,
          jobId: context.jobId,
          leaseEpoch: context.leaseEpoch,
        },
        reportRef: stored.intent.reportRef,
        reportSummary: structuredClone(stored.intent.reportSummary),
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 2 }).context,
      ),
    ).rejects.toThrow("recovery key does not match");
  });

  it("rejects malformed recovered report summaries before returning success", async () => {
    let loseFirstReturn = true;
    const fixture = executorOptions({
      resultStageHook: () => {
        if (loseFirstReturn) {
          loseFirstReturn = false;
          throw new Error("worker lost after artifact stage");
        }
      },
    });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("worker lost after artifact stage");
    const stored = fixture.storedResult();
    if (!stored?.stagedArtifact) throw new Error("expected staged result fixture");
    fixture.options.results.recover = async (_key, context) => {
      const malformed = structuredClone(stored.intent);
      malformed.reportSummary.issues.warning = Number.NaN;
      return {
        intent: malformed,
        result: {
          stagedArtifact: {
            ...stored.stagedArtifact!,
            jobId: context.jobId,
            leaseEpoch: context.leaseEpoch,
          },
          reportRef: stored.intent.reportRef,
          reportSummary: malformed.reportSummary,
        },
      };
    };

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 2 }).context,
      ),
    ).rejects.toThrow("reportSummary.issues.warning");
  });

  it("honors cancellation while fingerprinting a materialized asset", async () => {
    const controller = new AbortController();
    class AbortDuringFingerprintStore extends MemoryReadyStore {
      override async materialize() {
        const prepared = await super.materialize();
        const asset = prepared.bundle?.assets[0];
        if (!asset) throw new Error("expected prepared asset");
        const path = asset.path;
        Object.defineProperty(asset, "path", {
          configurable: true,
          enumerable: true,
          get() {
            controller.abort(new DOMException("cancelled during fingerprint", "AbortError"));
            return path;
          },
        });
        return prepared;
      }
    }
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    let compileCalls = 0;
    const fixture = executorOptions({
      ready: new AbortDuringFingerprintStore(),
      compiler: {
        async compile() {
          compileCalls += 1;
          return { pdf: validPdf.slice(), diagnostics: [], compilerVersion: "test" };
        },
      },
    });
    (fixture.options as CreatePdfExportJobExecutorOptionsV1).resolveInput = async () => ({
      input: {
        ...engineInput().input,
        blocks: [{
          type: "image" as const,
          alt: "One pixel",
          source: { kind: "attachment" as const, filename: "one.png" },
        }],
      },
      env: {
        assets: {
          async resolve() {
            return { bytes: png.slice(), mediaType: "image/png" };
          },
        },
      },
    });

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ signal: controller.signal }).context,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(compileCalls).toBe(0);
  });

  it("propagates cancellation during Typst and stages no artifact or report", async () => {
    const controller = new AbortController();
    let released = false;
    let staged = false;
    const fixture = executorOptions({
      compiler: {
        async compile(_bundle, { signal } = {}) {
          controller.abort(new DOMException("cancelled", "AbortError"));
          if (signal?.aborted) throw signal.reason;
          throw new Error("expected abort");
        },
      },
    });
    fixture.options.renderReservations = {
      async acquire() {
        return { reconcile: async () => {}, release: () => { released = true; } };
      },
    };
    fixture.options.results.stage = async () => {
      staged = true;
      throw new Error("unexpected");
    };
    const host = executionContext({ signal: controller.signal });
    const originalStage = host.context.artifacts.stage;
    host.context.artifacts.stage = async (...args) => {
      staged = true;
      return originalStage(...args);
    };

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), host.context),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect({ staged, released }).toEqual({ staged: false, released: true });
  });

  it("rejects a foreign checkpoint before reserving or compiling", async () => {
    const ready = new MemoryReadyStore();
    const prepared = await (await import("@atlcli/pdf")).preparePdfExport(engineInput().input, engineInput().env);
    ready.record = {
      schema: "atlcli.pdf-ready-to-render/1",
      ref: "render/foreign/manifest.json",
      jobId: "foreign",
      requestId: request().id,
      requestKey: request().idempotencyKey,
      preparedRef: "render/foreign/prepared.json",
      preparedByteLength: 1,
      preparedSha256: "0".repeat(64),
      estimate,
      renderAttempts: 0,
    };
    ready.prepared = prepared;
    let compiled = false;
    const fixture = executorOptions({
      ready,
      compiler: { async compile() { compiled = true; throw new Error("unexpected"); } },
    });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("identity does not match");
    expect(compiled).toBe(false);
  });

  it("rejects checkpoint estimate or prepared-ref mutation by the store", async () => {
    class MutatingStore extends MemoryReadyStore {
      mutateOn: "commit" | "attempt" = "commit";

      override async commit(input: Parameters<PdfReadyToRenderStoreV1["commit"]>[0]) {
        const checkpoint = await super.commit(input);
        return this.mutateOn === "commit"
          ? { ...checkpoint, estimate: { ...checkpoint.estimate, outputBytes: checkpoint.estimate.outputBytes + 1 } }
          : checkpoint;
      }

      override async beginRenderAttempt(
        input: Parameters<PdfReadyToRenderStoreV1["beginRenderAttempt"]>[0],
      ) {
        const checkpoint = await super.beginRenderAttempt(input);
        return this.mutateOn === "attempt"
          ? { ...checkpoint, preparedRef: "render/job-1/swapped.json" }
          : checkpoint;
      }
    }

    const ready = new MutatingStore();
    const fixture = executorOptions({ ready });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("changed the prepared payload binding or estimate");

    ready.record = undefined;
    ready.prepared = undefined;
    ready.mutateOn = "attempt";
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("atomic single increment");
  });

  it("binds the durable prepared fingerprint to the resource estimate", async () => {
    let compileCalls = 0;
    const ready = new MemoryReadyStore();
    const fixture = executorOptions({
      ready,
      compiler: {
        async compile() {
          compileCalls += 1;
          throw new Error("worker lost");
        },
      },
    });
    await expect(
      createPdfExportJobExecutor(fixture.options).execute(request(), executionContext().context),
    ).rejects.toThrow("worker lost");
    if (!ready.record) throw new Error("expected durable checkpoint");
    ready.record = {
      ...ready.record,
      estimate: { ...ready.record.estimate, outputBytes: ready.record.estimate.outputBytes + 1 },
    };

    await expect(
      createPdfExportJobExecutor(fixture.options).execute(
        request(),
        executionContext({ leaseEpoch: 2 }).context,
      ),
    ).rejects.toThrow("does not match its durable checkpoint");
    expect(compileCalls).toBe(1);
  });
});
