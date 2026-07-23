import { describe, expect, it } from "bun:test";
import type { ConfluencePageDetails } from "@atlcli/confluence";
import { buildDocx, para, pngFixtureBytes, readPart } from "@atlcli/docx/fixtures";
import type { ExportReport, PreparedDocxExportV1 } from "@atlcli/docx";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  ExportJobEventDraftV1,
  ExportJobStatsV1,
  PendingArtifactV1,
  ResourceEstimateV1,
  StagedArtifactV1,
} from "@atlcli/export-jobs";
import {
  createTypescriptDocxExportJobExecutor,
  DocxRenderRestartLimitError,
  type CreateTypescriptDocxExportJobExecutorOptionsV1,
  type DocxExportResultIntentV1,
  type DocxExportResultRecoveryKeyV1,
  type DocxReadyToRenderCheckpointV1,
  type DocxReadyToRenderStoreV1,
} from "./typescript-docx-job-executor.js";

const MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const estimate: ResourceEstimateV1 = {
  heapBytes: 4_000_000,
  spoolBytes: 4_000_000,
  outputBytes: 4_000_000,
  rasterPixels: 1_000_000,
  confidence: "estimated",
};
const details: ConfluencePageDetails = {
  id: "123",
  title: "DOCX job",
  url: "https://example.atlassian.net/wiki/pages/123",
  spaceKey: "DOC",
  storage: "<p>Hello from the job.</p>",
};
const templateBytes = buildDocx({
  body: para("$scroll.title") + para("$scroll.template.name") + para("$scroll.content"),
  date: new Date("2026-07-22T00:00:00.000Z"),
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function request(overrides: Partial<DocxExportJobRequestV1> = {}): Promise<DocxExportJobRequestV1> {
  return {
    schema: "atlcli.export-job-request/1",
    id: "request-1",
    idempotencyKey: "action-1",
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "page-id", id: "123" },
      scope: { kind: "page" },
    },
    authRef: "session:default",
    displayName: "DOCX job",
    createdAt: Date.parse("2026-07-22T00:00:00.000Z"),
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "templates/docx/pinned",
      sha256: await sha256Hex(templateBytes),
      name: "pinned.docx",
    },
    options: { embedImages: true, resolveMacros: true },
    ...overrides,
  };
}

class MemoryReadyStore implements DocxReadyToRenderStoreV1 {
  record?: DocxReadyToRenderCheckpointV1;
  prepared?: PreparedDocxExportV1;
  commits = 0;
  attempts = 0;
  materializations = 0;
  failMaterializeOnce = false;
  mutateMaterialized?: (prepared: PreparedDocxExportV1) => void;
  readonly order: string[];

  constructor(order: string[] = []) {
    this.order = order;
  }

  async load(): Promise<DocxReadyToRenderCheckpointV1 | undefined> {
    return this.record;
  }

  async commit(input: Parameters<DocxReadyToRenderStoreV1["commit"]>[0]) {
    this.order.push("ready-commit");
    this.commits += 1;
    this.prepared = structuredClone(input.prepared);
    this.record = {
      schema: "atlcli.docx-ready-to-render/1",
      ref: "render/job-1/manifest.json",
      jobId: input.jobId,
      requestId: input.request.id,
      requestKey: input.request.idempotencyKey,
      preparedRef: "render/job-1/prepared.json",
      preparedByteLength: input.binding.byteLength,
      preparedSha256: input.binding.sha256,
      template: input.template,
      estimate: input.estimate,
      sourcePageCount: input.sourcePageCount,
      renderAttempts: 0,
    };
    return this.record;
  }

  async materialize(): Promise<PreparedDocxExportV1> {
    this.order.push("materialize");
    this.materializations += 1;
    if (this.failMaterializeOnce) {
      this.failMaterializeOnce = false;
      throw new Error("worker lost while materializing");
    }
    if (!this.prepared) throw new Error("missing prepared DOCX");
    const prepared = structuredClone(this.prepared);
    this.mutateMaterialized?.(prepared);
    return prepared;
  }

  async beginRenderAttempt(input: Parameters<DocxReadyToRenderStoreV1["beginRenderAttempt"]>[0]) {
    this.attempts += 1;
    this.order.push(`attempt-${this.attempts}`);
    this.record = { ...input.checkpoint, renderAttempts: input.checkpoint.renderAttempts + 1 };
    return this.record;
  }
}

function executionContext(order: string[] = [], signal = new AbortController().signal) {
  let artifactBytes: Uint8Array | undefined;
  const context: ExportJobExecutionContext = {
    jobId: "job-1",
    leaseEpoch: 1,
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
        artifactBytes = chunks.length === 1 ? chunks[0] : undefined;
        return {
          ref: "staged:job-1",
          mediaType: pending.mediaType,
          filename: pending.filename,
          byteLength: pending.byteLength,
          sha256: pending.sha256,
          jobId: "job-1",
          leaseEpoch: 1,
          stagedAt: 10,
        };
      },
      async getStaged() { return undefined; },
    },
    async updateProgress() {},
    async updateStats() {},
    async appendEvent() {},
    async checkpoint() { order.push("checkpoint-publish"); },
  };
  return { context, artifactBytes: () => artifactBytes };
}

function executorOptions(input: {
  order?: string[];
  ready?: MemoryReadyStore;
  estimate?: ResourceEstimateV1;
  templateBytes?: Uint8Array;
  noRecovery?: boolean;
  lostStageReturnOnce?: boolean;
  resolveInput?: CreateTypescriptDocxExportJobExecutorOptionsV1["resolveInput"];
} = {}) {
  const order = input.order ?? [];
  const ready = input.ready ?? new MemoryReadyStore(order);
  let templateResolves = 0;
  let lostStageReturn = input.lostStageReturnOnce ?? false;
  type Stored = { intent: DocxExportResultIntentV1; report: ExportReport; artifact?: StagedArtifactV1 };
  const stored = new Map<string, Stored>();
  const options: CreateTypescriptDocxExportJobExecutorOptionsV1 = {
    async resolveInput(req, context) {
      order.push("resolve-input");
      if (input.resolveInput) return input.resolveInput(req, context);
      return {
        jobTelemetry: { sourcePageCount: 4 },
        details,
        template: { name: "untrusted-name.docx", modificationDate: new Date(0) },
        macros: { registry: {} as never, contextFor: (() => ({})) as never },
      };
    },
    estimateRender: () => input.estimate ?? estimate,
    templates: {
      async resolve() {
        order.push("template-resolve");
        templateResolves += 1;
        return {
          recordKey: "templates/docx/pinned",
          bytes: input.templateBytes ?? templateBytes,
        };
      },
    },
    readyToRender: ready,
    renderReservations: {
      async acquire() {
        order.push("reservation-acquire");
        return {
          async reconcile(actual) {
            if (actual.templateBytes !== undefined) order.push("template-reconcile");
            if (actual.preparedBytes !== undefined) order.push("prepared-reconcile");
            if (actual.assetBytes !== undefined) order.push("asset-reconcile");
            if (actual.outputBytes !== undefined) order.push("output-reconcile");
            if (actual.rasterPixels !== undefined) order.push("raster-reconcile");
          },
          release() { order.push("reservation-release"); },
        };
      },
    },
    results: {
      async recover(key, context) {
        if (input.noRecovery) return undefined;
        const record = stored.get(key.ref);
        if (!record?.artifact) return undefined;
        order.push("result-recover");
        return {
          intent: structuredClone(record.intent),
          result: {
            stagedArtifact: { ...record.artifact, jobId: context.jobId, leaseEpoch: context.leaseEpoch },
            reportRef: record.intent.reportRef,
            reportSummary: structuredClone(record.intent.reportSummary),
          },
        };
      },
      async prepare(value) {
        order.push("result-prepare");
        stored.set(value.intent.key.ref, {
          intent: structuredClone(value.intent),
          report: structuredClone(value.report),
        });
        return structuredClone(value.intent);
      },
      async stage(value, context) {
        order.push("result-stage");
        const artifact = await context.artifacts.stage(value.artifact, { signal: context.signal });
        stored.get(value.intent.key.ref)!.artifact = artifact;
        if (lostStageReturn) {
          lostStageReturn = false;
          throw new Error("lost result after durable stage");
        }
        return {
          stagedArtifact: artifact,
          reportRef: value.intent.reportRef,
          reportSummary: value.intent.reportSummary,
        };
      },
    },
    now: (() => { let tick = 0; return () => tick++; })(),
  };
  return { options, ready, order, templateResolves: () => templateResolves };
}

describe("createTypescriptDocxExportJobExecutor", () => {
  it("reserves before resolving template/PizZip and stages one owned DOCX", async () => {
    const setup = executorOptions();
    const context = executionContext(setup.order);
    const stats: ExportJobStatsV1[] = [];
    const events: ExportJobEventDraftV1[] = [];
    context.context.updateStats = async (value) => { stats.push(structuredClone(value)); };
    context.context.appendEvent = async (event) => { events.push(structuredClone(event)); };
    const result = await createTypescriptDocxExportJobExecutor(setup.options).execute(
      await request(),
      context.context,
    );
    expect(setup.order.indexOf("reservation-acquire")).toBeLessThan(setup.order.indexOf("template-resolve"));
    expect(setup.order.indexOf("template-resolve")).toBeLessThan(setup.order.indexOf("ready-commit"));
    expect(setup.order.indexOf("attempt-1")).toBeLessThan(setup.order.indexOf("materialize"));
    expect(result.stagedArtifact.mediaType).toBe(MEDIA_TYPE);
    const bytes = context.artifactBytes();
    expect(bytes).toBeDefined();
    expect(readPart(bytes!, "word/document.xml")).toContain("DOCX job");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      pages: { discovered: 4, fetched: 4, composed: 4, skipped: 0 },
      storage: { outputBytes: result.stagedArtifact.byteLength },
      warnings: result.reportSummary!.issues.warning,
      errors: result.reportSummary!.issues.error,
    });
    expect(events.every((event) => event.kind === "issue")).toBe(true);
    expect(setup.order.at(-1)).toBe("reservation-release");
  });

  it("rejects a pinned template hash mismatch before prepare/checkpoint", async () => {
    const setup = executorOptions({ templateBytes: templateBytes.slice(0, -1) });
    const context = executionContext(setup.order);
    await expect(
      createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context),
    ).rejects.toThrow("pinned SHA-256");
    expect(setup.ready.commits).toBe(0);
    expect(setup.order).not.toContain("ready-commit");
    expect(setup.order.at(-1)).toBe("reservation-release");
  });

  it("binds durable request options instead of trusting resolveInput", async () => {
    const setup = executorOptions({
      resolveInput: async () => ({
        details,
        template: { name: "wrong.docx", modificationDate: new Date(0) },
        embedImages: true,
        updateFields: "always",
        captionLang: "de",
        macros: { registry: {} as never, contextFor: (() => ({})) as never },
      }),
    });
    const req = await request({
      template: { ...(await request()).template, name: "request-name.docx" },
      options: {
        embedImages: false,
        resolveMacros: false,
        updateFields: "never",
        captionLang: "en",
      },
    });
    const context = executionContext(setup.order);
    await createTypescriptDocxExportJobExecutor(setup.options).execute(req, context.context);
    expect(setup.ready.prepared?.updateFields).toBe("never");
    expect(setup.ready.prepared?.baseNotes.some((note) => note.code === "field-refresh-suppressed")).toBe(false);
    expect(readPart(context.artifactBytes()!, "word/document.xml")).toContain("request-name.docx");
    expect(readPart(context.artifactBytes()!, "word/document.xml")).not.toContain("wrong.docx");
  });

  it("counts materialization loss as attempt one and restarts once without resolving source/template", async () => {
    const ready = new MemoryReadyStore();
    ready.failMaterializeOnce = true;
    const setup = executorOptions({ ready, noRecovery: true });
    const context = executionContext(setup.order);
    const executor = createTypescriptDocxExportJobExecutor(setup.options);
    await expect(executor.execute(await request(), context.context)).rejects.toThrow("worker lost");
    expect(ready.attempts).toBe(1);
    await executor.execute(await request(), context.context);
    expect(ready.attempts).toBe(2);
    expect(setup.templateResolves()).toBe(1);
    await expect(executor.execute(await request(), context.context)).rejects.toBeInstanceOf(
      DocxRenderRestartLimitError,
    );
    expect(ready.materializations).toBe(2);
  });

  it("recovers a lost staged-result return in O(1) before reservation/materialization", async () => {
    const setup = executorOptions({ lostStageReturnOnce: true });
    const context = executionContext(setup.order);
    const recoveredStats: ExportJobStatsV1[] = [];
    context.context.updateStats = async (value) => {
      recoveredStats.push(structuredClone(value));
    };
    const executor = createTypescriptDocxExportJobExecutor(setup.options);
    await expect(executor.execute(await request(), context.context)).rejects.toThrow("lost result");
    const materializations = setup.ready.materializations;
    const reservations = setup.order.filter((value) => value === "reservation-acquire").length;
    const recovered = await executor.execute(await request(), context.context);
    expect(recovered.stagedArtifact.mediaType).toBe(MEDIA_TYPE);
    expect(setup.ready.materializations).toBe(materializations);
    expect(setup.order.filter((value) => value === "reservation-acquire")).toHaveLength(reservations);
    expect(setup.order).toContain("result-recover");
    expect(recoveredStats).toHaveLength(1);
    expect(recoveredStats[0]?.pages.composed).toBe(4);
  });

  it("enforces the output estimate as a hard cap before result staging", async () => {
    const setup = executorOptions({ estimate: { ...estimate, outputBytes: 1 } });
    const context = executionContext(setup.order);
    await expect(
      createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context),
    ).rejects.toThrow("hard estimate");
    expect(setup.order).not.toContain("result-prepare");
    expect(setup.order).not.toContain("artifact-stage");
  });

  it("rejects a swapped prepared payload before docxtemplater or result staging", async () => {
    const ready = new MemoryReadyStore();
    ready.mutateMaterialized = (prepared) => {
      prepared.filename = "swapped.docx";
    };
    const setup = executorOptions({ ready });
    const context = executionContext(setup.order);
    await expect(
      createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context),
    ).rejects.toThrow("does not match its durable checkpoint");
    expect(ready.attempts).toBe(1);
    expect(setup.order).not.toContain("result-prepare");
  });

  it("reconciles asset bytes before they can be embedded and forwards cancellation", async () => {
    let assetSignal: AbortSignal | undefined;
    const order: string[] = [];
    const png = pngFixtureBytes(2, 2);
    const backing = new Uint8Array(png.byteLength + 128);
    backing.set(png, 64);
    const setup = executorOptions({
      order,
      resolveInput: async () => ({
        details: {
          ...details,
          storage: '<ac:image><ri:attachment ri:filename="figure.png"/></ac:image>',
        },
        template: { name: "wrong.docx", modificationDate: new Date(0) },
        assets: {
          async fetch(_ref, context) {
            order.push("asset-delegate");
            assetSignal = context?.signal;
            return backing.subarray(64, 64 + png.byteLength);
          },
        },
      }),
    });
    const context = executionContext(order);
    const progressStages: string[] = [];
    context.context.updateProgress = async (progress) => { progressStages.push(progress.stage); };
    await createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context);
    expect(assetSignal).toBe(context.context.signal);
    expect(order.indexOf("reservation-acquire")).toBeLessThan(order.indexOf("asset-delegate"));
    expect(order.indexOf("asset-delegate")).toBeLessThan(order.indexOf("asset-reconcile"));
    expect(order.indexOf("asset-reconcile")).toBeLessThan(order.indexOf("ready-commit"));
    expect(progressStages.indexOf("assets")).toBeGreaterThanOrEqual(0);
    expect(progressStages.slice(progressStages.indexOf("assets") + 1)).not.toContain("compose");
  });

  it("reconciles raster pixels before allocation and passes the AbortSignal to the raster port", async () => {
    let rasterSignal: AbortSignal | undefined;
    const order: string[] = [];
    const setup = executorOptions({
      order,
      resolveInput: async () => ({
        details: {
          ...details,
          storage:
            '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>' +
            '<ac:plain-text-body><![CDATA[graph TD\n A --> B]]></ac:plain-text-body></ac:structured-macro>',
        },
        template: { name: "wrong.docx", modificationDate: new Date(0) },
        rasterizer: {
          async rasterize(_svg, target, context) {
            order.push("raster-delegate");
            rasterSignal = context?.signal;
            return pngFixtureBytes(target.widthPx, target.heightPx);
          },
        },
      }),
    });
    const context = executionContext(order);
    await createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context);
    expect(rasterSignal).toBe(context.context.signal);
    expect(order.indexOf("reservation-acquire")).toBeLessThan(order.indexOf("raster-reconcile"));
    expect(order.indexOf("raster-reconcile")).toBeLessThan(order.indexOf("raster-delegate"));
  });

  it("fails closed on a wrong renderer before any host operation", async () => {
    const setup = executorOptions();
    const context = executionContext(setup.order);
    const bad = { ...(await request()), renderer: "python" } as unknown as DocxExportJobRequestV1;
    await expect(
      createTypescriptDocxExportJobExecutor(setup.options).execute(bad, context.context),
    ).rejects.toThrow("docx-typescript");
    expect(setup.order).toEqual([]);
  });

  it("honors cancellation before template resolution and always releases admission", async () => {
    const controller = new AbortController();
    const setup = executorOptions();
    setup.options.renderReservations.acquire = async () => {
      setup.order.push("reservation-acquire");
      controller.abort(new DOMException("cancelled", "AbortError"));
      return { async reconcile() {}, release() { setup.order.push("reservation-release"); } };
    };
    const context = executionContext(setup.order, controller.signal);
    await expect(
      createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context),
    ).rejects.toThrow("cancelled");
    expect(setup.order).not.toContain("template-resolve");
    expect(setup.order.at(-1)).toBe("reservation-release");
  });
});
