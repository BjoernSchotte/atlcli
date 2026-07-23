import { describe, expect, it } from "bun:test";
import type { ConfluencePageDetails, TreeSource } from "@atlcli/confluence";
import { buildDocx, para, pngFixtureBytes, readPart } from "@atlcli/docx/fixtures";
import type { ExportReport, PreparedDocxExportV1 } from "@atlcli/docx";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  PendingArtifactV1,
  ResourceEstimateV1,
  StagedArtifactV1,
} from "@atlcli/export-jobs";
import {
  createConfluenceDocxResolveInputV1,
} from "./confluence-job-resolve-input.js";
import type {
  ConfluenceSourcePlanCheckpointV1,
  ConfluenceSourcePlanStoreV1,
  PersistedConfluenceSourcePlanV1,
} from "./confluence-source-plan-checkpoint.js";
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

function executionContext(
  order: string[] = [],
  signal = new AbortController().signal,
  options: {
    leaseEpoch?: number;
    checkpoint?: (ref: string) => void | Promise<void>;
    progress?: (
      value: Parameters<ExportJobExecutionContext["updateProgress"]>[0],
    ) => void | Promise<void>;
  } = {},
) {
  let artifactBytes: Uint8Array | undefined;
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
        artifactBytes = chunks.length === 1 ? chunks[0] : undefined;
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
    async updateProgress(value) { await options.progress?.(value); },
    async appendEvent() {},
    async checkpoint(ref) {
      if (options.checkpoint) {
        await options.checkpoint(ref);
        return;
      }
      order.push("checkpoint-publish");
    },
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

  it("checkpoints shared ADF resolver state and performs zero source reads on render recovery", async () => {
    const ready = new MemoryReadyStore();
    ready.failMaterializeOnce = true;
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
    const resolveInput = createConfluenceDocxResolveInputV1({
      port: { createTreeSource: () => treeSource },
      build() {
        return {
          input: {
            template: { name: "template.docx", modificationDate: new Date(0) },
          },
        };
      },
    });
    const setup = executorOptions({ ready, noRecovery: true, resolveInput });
    const ctx = executionContext(setup.order);
    const executor = createTypescriptDocxExportJobExecutor(setup.options);

    await expect(executor.execute(await request(), ctx.context)).rejects.toThrow("worker lost");
    expect(sourceReads).toBe(1);
    expect(ready.prepared?.sourceNotes.some((note) => note.code === "adf-node-degraded")).toBe(true);
    expect(JSON.stringify(ready.prepared)).not.toContain("RAW-SIDECAR");

    await executor.execute(await request(), ctx.context);
    expect(sourceReads).toBe(1);
    expect(ready.commits).toBe(1);
  });

  it("recovers a version-pinned source plan before ready-to-render", async () => {
    const order: string[] = [];
    let persisted: PersistedConfluenceSourcePlanV1 | undefined;
    const sourcePlans: ConfluenceSourcePlanStoreV1 = {
      async load() {
        order.push("source-plan-load");
        return persisted ? structuredClone(persisted) : undefined;
      },
      async commit(checkpoint: ConfluenceSourcePlanCheckpointV1) {
        order.push("source-plan-commit");
        persisted = {
          checkpoint: structuredClone(checkpoint),
          ref: "source-plan:job-1",
        };
        return persisted.ref;
      },
    };
    let metadataReads = 0;
    let bodyReads = 0;
    const treeSource: TreeSource = {
      async getPage(id) {
        bodyReads += 1;
        order.push(`body-${bodyReads}`);
        if (bodyReads === 1) throw new Error("worker lost before ready");
        return {
          id,
          title: "Root",
          version: 5,
          exportSource: {
            primary: {
              representation: "atlas_doc_format",
              value: JSON.stringify({
                type: "doc",
                version: 1,
                content: [{
                  type: "paragraph",
                  content: [{ type: "text", text: "Recovered" }],
                }],
              }),
            },
            storageSidecar: "<p>RAW-SIDECAR</p>",
            sourceVersion: 5,
          },
        };
      },
      async getPageVersion() {
        metadataReads += 1;
        order.push("version");
        return { title: "Root", version: 5 };
      },
      async getChildren() {
        metadataReads += 1;
        throw new Error("page scope must not discover children");
      },
      async getSpaceHomepageId() { return null; },
    };
    const resolveInput = createConfluenceDocxResolveInputV1({
      port: { createTreeSource: () => treeSource },
      sourcePlan: { store: sourcePlans, sourcePolicyKey: "adf-primary:v1" },
      build() {
        return {
          input: {
            template: { name: "template.docx", modificationDate: new Date(0) },
          },
        };
      },
    });
    const ready = new MemoryReadyStore(order);
    const setup = executorOptions({ ready, order, resolveInput, noRecovery: true });
    const executor = createTypescriptDocxExportJobExecutor(setup.options);
    const published: string[] = [];
    const checkpoint = async (ref: string): Promise<void> => {
      published.push(ref);
      order.push(ref.startsWith("source-plan:") ? "source-plan-publish" : "ready-publish");
    };

    await expect(
      executor.execute(
        await request(),
        executionContext(order, new AbortController().signal, { checkpoint }).context,
      ),
    ).rejects.toThrow("could not be resolved");
    expect(ready.commits).toBe(0);
    expect(order.indexOf("source-plan-commit")).toBeLessThan(order.indexOf("source-plan-publish"));
    expect(order.indexOf("source-plan-publish")).toBeLessThan(order.indexOf("body-1"));
    expect(JSON.stringify(persisted)).not.toContain("Recovered");
    expect(JSON.stringify(persisted)).not.toContain("RAW-SIDECAR");

    await executor.execute(
      await request(),
      executionContext(order, new AbortController().signal, {
        leaseEpoch: 2,
        checkpoint,
      }).context,
    );

    expect({ metadataReads, bodyReads, readyCommits: ready.commits }).toEqual({
      metadataReads: 1,
      bodyReads: 2,
      readyCommits: 1,
    });
    expect(persisted?.checkpoint.committedLeaseEpoch).toBe(1);
    expect(published.filter((ref) => ref === "source-plan:job-1")).toHaveLength(2);
    expect(published).toContain("render/job-1/manifest.json");
  });

  it("recovers a lost staged-result return in O(1) before reservation/materialization", async () => {
    const setup = executorOptions({ lostStageReturnOnce: true });
    const context = executionContext(setup.order);
    const executor = createTypescriptDocxExportJobExecutor(setup.options);
    await expect(executor.execute(await request(), context.context)).rejects.toThrow("lost result");
    const materializations = setup.ready.materializations;
    const reservations = setup.order.filter((value) => value === "reservation-acquire").length;
    const recovered = await executor.execute(await request(), context.context);
    expect(recovered.stagedArtifact.mediaType).toBe(MEDIA_TYPE);
    expect(setup.ready.materializations).toBe(materializations);
    expect(setup.order.filter((value) => value === "reservation-acquire")).toHaveLength(reservations);
    expect(setup.order).toContain("result-recover");
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
    await createTypescriptDocxExportJobExecutor(setup.options).execute(await request(), context.context);
    expect(assetSignal).toBe(context.context.signal);
    expect(order.indexOf("reservation-acquire")).toBeLessThan(order.indexOf("asset-delegate"));
    expect(order.indexOf("asset-delegate")).toBeLessThan(order.indexOf("asset-reconcile"));
    expect(order.indexOf("asset-reconcile")).toBeLessThan(order.indexOf("ready-commit"));
  });

  it("keeps source-derived asset and output names out of durable progress", async () => {
    const progress: unknown[] = [];
    const setup = executorOptions({
      resolveInput: async () => ({
        details: {
          ...details,
          title: "PRIVATE-PAGE-TITLE",
          storage:
            '<ac:image><ri:attachment ri:filename="PRIVATE-ASSET-NAME.png"/></ac:image>',
        },
        template: {
          name: "PRIVATE-TEMPLATE-NAME.docx",
          modificationDate: new Date(0),
        },
        assets: {
          async fetch() {
            return pngFixtureBytes(2, 2);
          },
        },
      }),
    });
    const ctx = executionContext(
      setup.order,
      new AbortController().signal,
      { progress: (value) => { progress.push(structuredClone(value)); } },
    );

    await createTypescriptDocxExportJobExecutor(setup.options).execute(
      await request({
        displayName: "PRIVATE-DISPLAY-NAME",
        requestedFilename: "PRIVATE-OUTPUT-NAME.docx",
        template: {
          ...(await request()).template,
          name: "PRIVATE-REQUEST-TEMPLATE.docx",
        },
      }),
      ctx.context,
    );

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((value) => {
      const event = value as { stage?: unknown };
      return event.stage === "assets";
    })).toBe(true);
    expect(JSON.stringify(progress)).not.toContain("PRIVATE-");
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
