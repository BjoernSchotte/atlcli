import {
  exportDocx,
  prepareDocxExport,
  renderPreparedDocxExport,
  type ExportInput,
  type SvgRasterizer,
} from "@atlcli/docx/browser";
import { canvasSvgRasterizer } from "@atlcli/docx/browser-runtime";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  PendingArtifactV1,
  StagedArtifactV1,
} from "@atlcli/export-jobs";
import {
  createTypescriptDocxExportJobExecutor,
  type DocxExportResultIntentV1,
  type DocxReadyToRenderCheckpointV1,
  type DocxReadyToRenderStoreV1,
} from "@atlcli/export-wiring/jobs";
import {
  DOCX_DETAILS,
  DOCX_TEMPLATE_BYTES,
} from "./fixture.js";
import { assertDocxJobParity } from "./docx-job-parity.js";
import { sha256Hex } from "./digest.js";

const EXPORT_DATE = new Date("2026-07-17T08:00:00.000Z");

function engineInput(rasterizer: SvgRasterizer): ExportInput {
  return {
    details: structuredClone(DOCX_DETAILS),
    templateBytes: DOCX_TEMPLATE_BYTES.slice(),
    template: {
      name: "browser-harness-template.docx",
      modificationDate: new Date(EXPORT_DATE),
    },
    exportDate: new Date(EXPORT_DATE),
    embedImages: true,
    updateFields: "auto",
    rasterizer,
  };
}

export interface DocxJobParityCaseOptions {
  createRasterizer?: () => SvgRasterizer;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    const owned = chunk.slice();
    chunks.push(owned);
    length += owned.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function jobRequest(): Promise<DocxExportJobRequestV1> {
  return {
    schema: "atlcli.export-job-request/1",
    id: "browser-docx-parity-job",
    idempotencyKey: "browser-docx-parity-request-v1",
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "page-id", id: "42", version: 1 },
      scope: { kind: "page" },
    },
    authRef: "browser-harness",
    displayName: "DOCX job parity",
    requestedFilename: "Browser Harness DOCX.docx",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "template:browser-docx-parity",
      sha256: await sha256Hex(DOCX_TEMPLATE_BYTES),
      name: "browser-harness-template.docx",
    },
    options: {
      embedImages: true,
      resolveMacros: false,
      updateFields: "auto",
    },
  };
}

async function jobRun(request: DocxExportJobRequestV1, rasterizer: SvgRasterizer) {
  let checkpoint: DocxReadyToRenderCheckpointV1 | undefined;
  let prepared: Parameters<DocxReadyToRenderStoreV1["commit"]>[0]["prepared"] | undefined;
  let stagedBytes: Uint8Array | undefined;
  let stagedReport: Awaited<ReturnType<typeof exportDocx>>["report"] | undefined;
  let stagedArtifact: StagedArtifactV1 | undefined;
  let resultIntent: DocxExportResultIntentV1 | undefined;
  let checkpointRef = "";
  let reservationReleased = false;
  let templateResolutions = 0;
  let time = 0;
  const now = () => time++;

  const executor = createTypescriptDocxExportJobExecutor({
    async resolveInput() {
      const { templateBytes: _templateBytes, ...input } = engineInput(rasterizer);
      return input;
    },
    estimateRender() {
      return {
        heapBytes: 8 * 1024 * 1024,
        spoolBytes: 0,
        outputBytes: 8 * 1024 * 1024,
        rasterPixels: 8 * 1024 * 1024,
        confidence: "estimated",
      };
    },
    templates: {
      async resolve(input) {
        templateResolutions += 1;
        if (
          input.recordKey !== request.template.recordKey ||
          input.expectedSha256 !== request.template.sha256
        ) {
          throw new Error("DOCX parity template resolver received the wrong pinned identity.");
        }
        return { recordKey: input.recordKey, bytes: DOCX_TEMPLATE_BYTES.slice() };
      },
    },
    readyToRender: {
      async load() {
        return checkpoint;
      },
      async commit(input) {
        prepared = structuredClone(input.prepared);
        checkpoint = {
          schema: "atlcli.docx-ready-to-render/1",
          ref: `ready:${input.jobId}:${input.leaseEpoch}`,
          jobId: input.jobId,
          requestId: input.request.id,
          requestKey: input.request.idempotencyKey,
          preparedRef: `prepared:${input.jobId}:${input.leaseEpoch}`,
          preparedByteLength: input.binding.byteLength,
          preparedSha256: input.binding.sha256,
          template: structuredClone(input.template),
          estimate: structuredClone(input.estimate),
          renderAttempts: 0,
        };
        return checkpoint;
      },
      async materialize() {
        if (!prepared) throw new Error("DOCX parity prepared state is missing.");
        return structuredClone(prepared);
      },
      async beginRenderAttempt(input) {
        checkpoint = { ...input.checkpoint, renderAttempts: input.checkpoint.renderAttempts + 1 };
        return checkpoint;
      },
    },
    renderReservations: {
      async acquire() {
        return {
          async reconcile() {},
          release: () => { reservationReleased = true; },
        };
      },
    },
    results: {
      async recover() {
        return undefined;
      },
      async prepare(input) {
        resultIntent = structuredClone(input.intent);
        stagedReport = structuredClone(input.report);
        return structuredClone(input.intent);
      },
      async stage(input, context) {
        if (!resultIntent || resultIntent.key.ref !== input.intent.key.ref) {
          throw new Error("DOCX parity result intent is missing or mismatched.");
        }
        stagedArtifact = await context.artifacts.stage(input.artifact, {
          signal: context.signal,
        });
        return {
          stagedArtifact,
          reportRef: resultIntent.reportRef,
          reportSummary: structuredClone(resultIntent.reportSummary),
        };
      },
    },
    now,
  });

  const context: ExportJobExecutionContext = {
    jobId: request.id,
    leaseEpoch: 1,
    signal: new AbortController().signal,
    spool: {
      async put(): Promise<never> {
        throw new Error("DOCX parity executor unexpectedly wrote source spool bytes.");
      },
      async *read(): AsyncIterable<Uint8Array> {
        throw new Error("DOCX parity executor unexpectedly read source spool bytes.");
      },
      async stat() {
        return undefined;
      },
    },
    artifacts: {
      async stage(artifact: PendingArtifactV1): Promise<StagedArtifactV1> {
        stagedBytes = await collect(artifact.bytes);
        if (stagedBytes.byteLength !== artifact.byteLength) {
          throw new Error("DOCX job staged artifact length does not match its metadata.");
        }
        if (await sha256Hex(stagedBytes) !== artifact.sha256) {
          throw new Error("DOCX job staged artifact digest does not match its metadata.");
        }
        stagedArtifact = {
          ref: "artifact:browser-docx-parity-job:1",
          mediaType: artifact.mediaType,
          filename: artifact.filename,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          jobId: request.id,
          leaseEpoch: 1,
          stagedAt: now(),
        };
        return stagedArtifact;
      },
      async getStaged() {
        return stagedArtifact;
      },
    },
    async updateProgress() {},
    async appendEvent() {},
    async checkpoint(ref) {
      checkpointRef = ref;
    },
  };

  const result = await executor.execute(request, context);
  if (!stagedBytes || !stagedReport || !checkpoint || !stagedArtifact) {
    throw new Error("DOCX job executor did not stage its artifact, report, and checkpoint.");
  }
  if (result.stagedArtifact.ref !== stagedArtifact.ref) {
    throw new Error("DOCX job result did not reference the staged artifact.");
  }
  if (!resultIntent || result.reportRef !== resultIntent.reportRef) {
    throw new Error("DOCX job result did not reference the staged report.");
  }
  return {
    bytes: stagedBytes,
    report: stagedReport,
    checkpointRef,
    renderAttempts: checkpoint.renderAttempts,
    reservationReleased,
    templateResolutions,
  };
}

/**
 * Exercise the exact engine boundary the background executor persists.
 *
 * This first leg is intentionally independent of host storage: the direct run
 * and the explicit prepare/materialize/render run own separate template bytes,
 * rasterizer instances and result bytes. The job-store adapter below replaces
 * the explicit staged leg once `createTypescriptDocxExportJobExecutor` is
 * available, while retaining this as the engine-boundary regression proof.
 */
export async function runDocxPreparedParityCase(
  options: DocxJobParityCaseOptions = {},
) {
  const createRasterizer = options.createRasterizer ??
    (() => canvasSvgRasterizer({ document }));

  const directRasterizer = createRasterizer();
  const direct = await exportDocx(engineInput(directRasterizer));

  const stagedRasterizer = createRasterizer();
  const prepared = await prepareDocxExport(engineInput(stagedRasterizer));
  const durableClone = structuredClone(prepared);
  const staged = await renderPreparedDocxExport(durableClone);
  if (durableClone.renderState !== undefined) {
    throw new Error("DOCX prepared render state was not consumed by the staged attempt.");
  }
  if (direct.bytes.buffer === staged.bytes.buffer) {
    throw new Error("DOCX direct and staged paths aliased the same output buffer.");
  }

  return {
    ...assertDocxJobParity(direct, staged),
    usedPreparedStages: true,
    usedIndependentRasterizers: directRasterizer !== stagedRasterizer,
    ownedIndependentBytes: true,
  };
}

/** Run the production DOCX job executor against the real browser engine and ports. */
export async function runDocxJobParityCase(options: DocxJobParityCaseOptions = {}) {
  const createRasterizer = options.createRasterizer ??
    (() => canvasSvgRasterizer({ document }));
  const directRasterizer = createRasterizer();
  const direct = await exportDocx(engineInput(directRasterizer));
  const jobRasterizer = createRasterizer();
  const job = await jobRun(await jobRequest(), jobRasterizer);
  if (direct.bytes.buffer === job.bytes.buffer) {
    throw new Error("DOCX direct and job paths aliased the same output buffer.");
  }
  const parity = assertDocxJobParity(direct, job);
  if (!job.checkpointRef.startsWith("ready:")) {
    throw new Error("DOCX job did not publish its ready-to-render checkpoint.");
  }
  if (job.renderAttempts !== 1) {
    throw new Error(`DOCX job used ${job.renderAttempts} render attempts instead of one.`);
  }
  if (!job.reservationReleased) {
    throw new Error("DOCX job did not release its heavy render reservation.");
  }
  if (job.templateResolutions !== 1) {
    throw new Error(`DOCX job resolved its pinned template ${job.templateResolutions} times.`);
  }
  return {
    ...parity,
    usedRealExecutor: true,
    usedIndependentRasterizers: directRasterizer !== jobRasterizer,
    ownedIndependentBytes: true,
    renderAttempts: job.renderAttempts,
    reservationReleased: job.reservationReleased,
    templateResolutions: job.templateResolutions,
  };
}
