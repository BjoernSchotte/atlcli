import {
  parseDocxExportJobRequestV1,
  parseExportReportSummaryV1,
  type DocxExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobResultTelemetryV1,
  type ExportReportSummaryV1,
  type PendingArtifactV1,
  type ResourceEstimateV1,
} from "@atlcli/export-jobs";
import {
  prepareDocxExport,
  renderPreparedDocxExport,
  type AssetFetcher,
  type ExportInput,
  type ExportReport,
  type PreparedDocxExportV1,
  type SvgRasterizer,
} from "@atlcli/docx";
import type { ExportProgressCallback } from "@atlcli/confluence";
import {
  buildProductiveExportTelemetryV1,
} from "./productive-telemetry.js";

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export type TypescriptDocxExportJobEngineInputV1 = Omit<
  ExportInput,
  "templateBytes" | "signal" | "onProgress"
>;

export type TypescriptDocxExportJobResolvedInputV1 =
  TypescriptDocxExportJobEngineInputV1 & {
    jobTelemetry?: { sourcePageCount: number };
  };

export interface DocxPinnedTemplateV1 {
  recordKey: string;
  bytes: Uint8Array;
}

export interface DocxPinnedTemplatePortV1 {
  resolve(input: {
    jobId: string;
    recordKey: string;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<DocxPinnedTemplateV1>;
}

export interface DocxTemplateBindingV1 {
  recordKey: string;
  byteLength: number;
  sha256: string;
}

export interface DocxPreparedPayloadBindingV1 {
  byteLength: number;
  sha256: string;
}

export interface DocxReadyToRenderCheckpointV1 {
  schema: "atlcli.docx-ready-to-render/1";
  ref: string;
  jobId: string;
  requestId: string;
  requestKey: string;
  preparedRef: string;
  preparedByteLength: number;
  preparedSha256: string;
  template: DocxTemplateBindingV1;
  estimate: ResourceEstimateV1;
  /** Productive source-page count for final statistics; absent only on legacy checkpoints. */
  sourcePageCount?: number;
  renderAttempts: number;
}

export interface DocxReadyToRenderStoreV1 {
  load(input: {
    jobId: string;
    request: DocxExportJobRequestV1;
    signal: AbortSignal;
  }): Promise<DocxReadyToRenderCheckpointV1 | undefined>;
  commit(input: {
    jobId: string;
    leaseEpoch: number;
    request: DocxExportJobRequestV1;
    prepared: PreparedDocxExportV1;
    binding: DocxPreparedPayloadBindingV1;
    template: DocxTemplateBindingV1;
    estimate: ResourceEstimateV1;
    sourcePageCount?: number;
    signal: AbortSignal;
  }): Promise<DocxReadyToRenderCheckpointV1>;
  materialize(input: {
    checkpoint: DocxReadyToRenderCheckpointV1;
    jobId: string;
    leaseEpoch: number;
    signal: AbortSignal;
  }): Promise<PreparedDocxExportV1>;
  beginRenderAttempt(input: {
    checkpoint: DocxReadyToRenderCheckpointV1;
    jobId: string;
    leaseEpoch: number;
    signal: AbortSignal;
  }): Promise<DocxReadyToRenderCheckpointV1>;
}

export interface DocxRenderReservationV1 {
  /**
   * Grow component-wise absolute reservation floors. Repeated or smaller
   * values are idempotent; growth must be atomic and fail closed when the host
   * cannot admit it.
   */
  reconcile(input: {
    templateBytes?: number;
    preparedBytes?: number;
    assetBytes?: number;
    outputBytes?: number;
    rasterPixels?: number;
    signal: AbortSignal;
  }): Promise<void>;
  release(): void | Promise<void>;
}

export interface DocxRenderReservationPortV1 {
  acquire(input: {
    jobId: string;
    leaseEpoch: number;
    estimate: ResourceEstimateV1;
    signal: AbortSignal;
  }): Promise<DocxRenderReservationV1>;
}

export interface DocxExportResultRecoveryKeyV1 {
  schema: "atlcli.docx-result-key/1";
  ref: string;
  jobId: string;
  requestId: string;
  requestKey: string;
  requestSha256: string;
  checkpointRef: string;
  preparedByteLength: number;
  preparedSha256: string;
  template: DocxTemplateBindingV1;
  estimate: ResourceEstimateV1;
}

export interface DocxExportResultIntentV1 {
  schema: "atlcli.docx-result-intent/1";
  key: DocxExportResultRecoveryKeyV1;
  artifact: {
    mediaType: typeof DOCX_MEDIA_TYPE;
    filename: string;
    byteLength: number;
    sha256: string;
  };
  reportRef: string;
  reportSha256: string;
  reportSummary: ExportReportSummaryV1;
  /** Added productively in PR-I; absent only on legacy persisted result intents. */
  telemetry?: ExportJobResultTelemetryV1;
}

export interface DocxRecoveredExportResultV1 {
  intent: DocxExportResultIntentV1;
  result: ExportJobExecutionResultV1;
}

/**
 * Crash-recoverable transaction for one validated DOCX plus its full report.
 * `prepare` durably journals the immutable intent/report before `stage` consumes
 * the artifact stream. `recover` is O(1): it may return only metadata bound to
 * the supplied key and must never read/copy artifact or report payload bytes.
 * `stage` must consume the borrowed stream before resolving and retain neither
 * the stream nor any yielded chunk afterwards.
 */
export interface DocxExportResultStoreV1 {
  recover(
    key: DocxExportResultRecoveryKeyV1,
    context: ExportJobExecutionContext,
  ): Promise<DocxRecoveredExportResultV1 | undefined>;
  prepare(
    input: { intent: DocxExportResultIntentV1; report: ExportReport },
    context: ExportJobExecutionContext,
  ): Promise<DocxExportResultIntentV1>;
  stage(
    input: { intent: DocxExportResultIntentV1; artifact: PendingArtifactV1 },
    context: ExportJobExecutionContext,
  ): Promise<ExportJobExecutionResultV1>;
}

export interface CreateTypescriptDocxExportJobExecutorOptionsV1 {
  resolveInput(
    request: DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
  ): Promise<TypescriptDocxExportJobResolvedInputV1>;
  estimateRender(
    input: TypescriptDocxExportJobEngineInputV1,
    request: DocxExportJobRequestV1,
  ): ResourceEstimateV1;
  templates: DocxPinnedTemplatePortV1;
  readyToRender: DocxReadyToRenderStoreV1;
  renderReservations: DocxRenderReservationPortV1;
  results: DocxExportResultStoreV1;
  now?: () => number;
}

export class DocxRenderRestartLimitError extends Error {
  constructor() {
    super("DOCX render already used its one automatic restart from ready-to-render.");
    this.name = "DocxRenderRestartLimitError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("DOCX export job was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function nonNegativeSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative safe integer.`);
  }
}

function nonNegativeFinite(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative finite number.`);
  }
}

function validateEstimate(estimate: ResourceEstimateV1): void {
  nonNegativeSafeInteger(estimate.heapBytes, "estimate.heapBytes");
  nonNegativeSafeInteger(estimate.spoolBytes, "estimate.spoolBytes");
  nonNegativeSafeInteger(estimate.outputBytes, "estimate.outputBytes");
  nonNegativeSafeInteger(estimate.rasterPixels, "estimate.rasterPixels");
  if (!(["measured", "estimated", "unknown"] as const).includes(estimate.confidence)) {
    throw new RangeError("estimate.confidence is invalid.");
  }
}

function sameEstimate(left: ResourceEstimateV1, right: ResourceEstimateV1): boolean {
  return (
    left.heapBytes === right.heapBytes &&
    left.spoolBytes === right.spoolBytes &&
    left.outputBytes === right.outputBytes &&
    left.rasterPixels === right.rasterPixels &&
    left.confidence === right.confidence
  );
}

function sameTemplate(left: DocxTemplateBindingV1, right: DocxTemplateBindingV1): boolean {
  return (
    left.recordKey === right.recordKey &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}

function validateTemplateBinding(
  binding: DocxTemplateBindingV1,
  request: DocxExportJobRequestV1,
): void {
  if (binding.recordKey !== request.template.recordKey) {
    throw new Error("DOCX template record key does not match the pinned request.");
  }
  if (!Number.isSafeInteger(binding.byteLength) || binding.byteLength <= 0) {
    throw new Error("DOCX template byte length must be positive.");
  }
  if (!/^[a-f0-9]{64}$/.test(binding.sha256)) {
    throw new Error("DOCX template SHA-256 is invalid.");
  }
  if (binding.sha256 !== request.template.sha256.toLowerCase()) {
    throw new Error("DOCX template bytes do not match the pinned SHA-256.");
  }
}

function validateCheckpoint(
  checkpoint: DocxReadyToRenderCheckpointV1,
  request: DocxExportJobRequestV1,
  context: ExportJobExecutionContext,
): void {
  if (checkpoint.schema !== "atlcli.docx-ready-to-render/1") {
    throw new Error("Unsupported DOCX ready-to-render checkpoint schema.");
  }
  if (
    checkpoint.jobId !== context.jobId ||
    checkpoint.requestId !== request.id ||
    checkpoint.requestKey !== request.idempotencyKey
  ) {
    throw new Error("DOCX checkpoint identity does not match this job request.");
  }
  if (checkpoint.ref.trim().length === 0 || checkpoint.preparedRef.trim().length === 0) {
    throw new Error("DOCX checkpoint refs must not be empty.");
  }
  if (!Number.isSafeInteger(checkpoint.preparedByteLength) || checkpoint.preparedByteLength <= 0) {
    throw new Error("DOCX prepared byte length must be positive.");
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.preparedSha256)) {
    throw new Error("DOCX prepared SHA-256 is invalid.");
  }
  nonNegativeSafeInteger(checkpoint.renderAttempts, "checkpoint.renderAttempts");
  if (checkpoint.sourcePageCount !== undefined) {
    nonNegativeSafeInteger(checkpoint.sourcePageCount, "checkpoint.sourcePageCount");
  }
  validateTemplateBinding(checkpoint.template, request);
  validateEstimate(checkpoint.estimate);
}

function sameCheckpointExceptAttempts(
  left: DocxReadyToRenderCheckpointV1,
  right: DocxReadyToRenderCheckpointV1,
): boolean {
  return (
    left.schema === right.schema &&
    left.ref === right.ref &&
    left.jobId === right.jobId &&
    left.requestId === right.requestId &&
    left.requestKey === right.requestKey &&
    left.preparedRef === right.preparedRef &&
    left.preparedByteLength === right.preparedByteLength &&
    left.preparedSha256 === right.preparedSha256 &&
    left.sourcePageCount === right.sourcePageCount &&
    sameTemplate(left.template, right.template) &&
    sameEstimate(left.estimate, right.estimate)
  );
}

async function sha256Hex(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (signal) throwIfAborted(signal);
  const source =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  if (signal) throwIfAborted(signal);
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function exactOwnedBytes(bytes: Uint8Array): Uint8Array {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes;
  }
  return bytes.slice();
}

function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("DOCX checkpoint metadata contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) throw new Error("DOCX checkpoint metadata contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("DOCX checkpoint metadata must contain only plain data objects.");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function fingerprintPreparedDocxExport(
  prepared: PreparedDocxExportV1,
  estimate: ResourceEstimateV1,
  template: DocxTemplateBindingV1,
  signal: AbortSignal,
): Promise<DocxPreparedPayloadBindingV1> {
  throwIfAborted(signal);
  validateEstimate(estimate);
  if (prepared.schema !== "atlcli.prepared-docx-export/1" || !prepared.renderState) {
    throw new Error("Unsupported or already-consumed prepared DOCX export.");
  }
  if (
    prepared.filename.trim().length === 0 ||
    typeof prepared.complete !== "boolean" ||
    !["auto", "always", "never"].includes(prepared.updateFields)
  ) {
    throw new Error("Prepared DOCX metadata is invalid.");
  }
  for (const [path, value] of Object.entries({
    resolvedCount: prepared.resolvedCount,
    embeddedImages: prepared.embeddedImages,
    renderedDiagrams: prepared.renderedDiagrams,
  })) {
    nonNegativeSafeInteger(value, `prepared.${path}`);
  }
  nonNegativeFinite(prepared.startedAt, "prepared.startedAt");
  for (const [name, value] of Object.entries(prepared.timings)) {
    nonNegativeFinite(value, `prepared.timings.${name}`);
  }

  const encoder = new TextEncoder();
  const archive = prepared.renderState.archiveBytes;
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0) {
    throw new Error("Prepared DOCX archive bytes are invalid.");
  }
  const archiveSha256 = await sha256Hex(archive, signal);
  const bodyBytes = encoder.encode(prepared.renderState.bodyXml);
  const bodySha256 = await sha256Hex(bodyBytes, signal);
  let byteLength = archive.byteLength + bodyBytes.byteLength;
  const includeKeys = new Set<string>();
  const includes = [];
  for (const [index, entry] of prepared.renderState.includes.entries()) {
    throwIfAborted(signal);
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].trim().length === 0 ||
      typeof entry[1] !== "string" ||
      includeKeys.has(entry[0])
    ) {
      throw new Error(`Prepared DOCX include ${index} is invalid or duplicated.`);
    }
    includeKeys.add(entry[0]);
    const xmlBytes = encoder.encode(entry[1]);
    byteLength += encoder.encode(entry[0]).byteLength + xmlBytes.byteLength;
    includes.push({ key: entry[0], byteLength: xmlBytes.byteLength, sha256: await sha256Hex(xmlBytes, signal) });
  }

  const { renderState: _renderState, ...metadata } = prepared;
  const descriptor = canonical({
    metadata,
    estimate,
    template,
    renderState: {
      archive: { byteLength: archive.byteLength, sha256: archiveSha256 },
      body: { byteLength: bodyBytes.byteLength, sha256: bodySha256 },
      includes,
    },
  });
  const descriptorBytes = encoder.encode(descriptor);
  byteLength += descriptorBytes.byteLength;
  return { byteLength, sha256: await sha256Hex(descriptorBytes, signal) };
}

function sameReportSummary(
  left: ExportReportSummaryV1 | undefined,
  right: ExportReportSummaryV1,
): boolean {
  return left !== undefined && canonical(left) === canonical(right);
}

function reportSummary(report: ExportReport): ExportReportSummaryV1 {
  const issues = { info: 0, warning: 0, error: 0 };
  const codes = new Map<string, number>();
  for (const note of report.notes) {
    issues[note.level] += 1;
    codes.set(note.code, (codes.get(note.code) ?? 0) + 1);
  }
  return {
    issues,
    topCodes: [...codes]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, 20),
    completeness: report.complete ? "complete" : "partial",
  };
}

async function buildResultRecoveryKey(
  request: DocxExportJobRequestV1,
  checkpoint: DocxReadyToRenderCheckpointV1,
  context: ExportJobExecutionContext,
): Promise<DocxExportResultRecoveryKeyV1> {
  const encoder = new TextEncoder();
  const requestSha256 = await sha256Hex(encoder.encode(canonical(request)), context.signal);
  const identity = {
    schema: "atlcli.docx-result-key/1",
    jobId: context.jobId,
    requestId: request.id,
    requestKey: request.idempotencyKey,
    requestSha256,
    checkpointRef: checkpoint.ref,
    preparedByteLength: checkpoint.preparedByteLength,
    preparedSha256: checkpoint.preparedSha256,
    template: checkpoint.template,
    estimate: checkpoint.estimate,
  } as const;
  const digest = await sha256Hex(encoder.encode(canonical(identity)), context.signal);
  return { ...identity, ref: `docx-result:${digest}` };
}

function validateRecoveryKey(
  actual: DocxExportResultRecoveryKeyV1,
  expected: DocxExportResultRecoveryKeyV1,
): void {
  validateEstimate(actual.estimate);
  if (
    actual.schema !== "atlcli.docx-result-key/1" ||
    !/^docx-result:[a-f0-9]{64}$/.test(actual.ref) ||
    !/^[a-f0-9]{64}$/.test(actual.requestSha256) ||
    canonical(actual) !== canonical(expected)
  ) {
    throw new Error("DOCX result recovery key does not match this request and checkpoint.");
  }
}

function validateResultIntent(
  intent: DocxExportResultIntentV1,
  expectedKey: DocxExportResultRecoveryKeyV1,
  expected?: {
    artifact: PendingArtifactV1;
    reportSha256: string;
    reportSummary: ExportReportSummaryV1;
    telemetry: ExportJobResultTelemetryV1;
  },
): void {
  if (intent.schema !== "atlcli.docx-result-intent/1") {
    throw new Error("Unsupported DOCX result intent schema.");
  }
  validateRecoveryKey(intent.key, expectedKey);
  parseExportReportSummaryV1(intent.reportSummary);
  if (
    intent.artifact.mediaType !== DOCX_MEDIA_TYPE ||
    intent.artifact.filename.trim().length === 0 ||
    !Number.isSafeInteger(intent.artifact.byteLength) ||
    intent.artifact.byteLength <= 0 ||
    !/^[a-f0-9]{64}$/.test(intent.artifact.sha256) ||
    intent.reportRef !== `${expectedKey.ref}:report` ||
    !/^[a-f0-9]{64}$/.test(intent.reportSha256)
  ) {
    throw new Error("DOCX result intent contains invalid artifact or report metadata.");
  }
  if (
    expected &&
    (intent.artifact.filename !== expected.artifact.filename ||
      intent.artifact.byteLength !== expected.artifact.byteLength ||
      intent.artifact.sha256 !== expected.artifact.sha256 ||
      intent.reportSha256 !== expected.reportSha256 ||
      !sameReportSummary(intent.reportSummary, expected.reportSummary) ||
      canonical(intent.telemetry) !== canonical(expected.telemetry))
  ) {
    throw new Error("DOCX result intent does not match the validated artifact and report.");
  }
}

async function publishTelemetry(
  context: ExportJobExecutionContext,
  telemetry: ExportJobResultTelemetryV1,
): Promise<void> {
  await context.updateStats(telemetry.stats);
  for (const issue of telemetry.issues) await context.appendEvent(issue);
}

function validateExecutionResult(
  result: ExportJobExecutionResultV1,
  context: ExportJobExecutionContext,
  intent: DocxExportResultIntentV1,
): ExportJobExecutionResultV1 {
  const artifact = result.stagedArtifact;
  parseExportReportSummaryV1(result.reportSummary);
  if (
    artifact.jobId !== context.jobId ||
    artifact.leaseEpoch !== context.leaseEpoch ||
    artifact.mediaType !== DOCX_MEDIA_TYPE ||
    artifact.filename !== intent.artifact.filename ||
    artifact.byteLength !== intent.artifact.byteLength ||
    artifact.sha256 !== intent.artifact.sha256 ||
    result.reportRef !== intent.reportRef ||
    !sameReportSummary(result.reportSummary, intent.reportSummary)
  ) {
    throw new Error("DOCX result store returned invalid, unfenced, or mismatched metadata.");
  }
  return result;
}

function progress(
  context: ExportJobExecutionContext,
  now: () => number,
  stage: "fetch" | "compose" | "assets" | "render" | "validate" | "commit",
  done: number,
  total: number | null,
  detail: string,
): Promise<void> {
  return context.updateProgress({ stage, done, total, detail, updatedAt: now() });
}

function instrumentEngineInput(
  input: TypescriptDocxExportJobEngineInputV1,
  request: DocxExportJobRequestV1,
  reservation: DocxRenderReservationV1,
  signal: AbortSignal,
): TypescriptDocxExportJobEngineInputV1 {
  let assetBytes = 0;
  let rasterPixels = 0;
  const accountBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const owned = exactOwnedBytes(bytes);
    if (!Number.isSafeInteger(assetBytes + owned.byteLength)) {
      throw new RangeError("DOCX asset byte accounting overflowed.");
    }
    assetBytes += owned.byteLength;
    await reservation.reconcile({ assetBytes, signal });
    throwIfAborted(signal);
    return owned;
  };

  let assets: AssetFetcher | undefined;
  if (input.assets) {
    const delegate = input.assets;
    assets = {
      async fetch(ref, context) {
        throwIfAborted(signal);
        const bytes = await delegate.fetch(ref, { ...context, signal });
        throwIfAborted(signal);
        return accountBytes(bytes);
      },
    };
  }

  let rasterizer: SvgRasterizer | undefined;
  if (input.rasterizer) {
    const delegate = input.rasterizer;
    rasterizer = {
      async rasterize(svg, target) {
        throwIfAborted(signal);
        const pixels = target.widthPx * target.heightPx;
        if (!Number.isSafeInteger(pixels) || pixels <= 0 || !Number.isSafeInteger(rasterPixels + pixels)) {
          throw new RangeError("DOCX raster target has an invalid pixel count.");
        }
        rasterPixels += pixels;
        await reservation.reconcile({ rasterPixels, signal });
        throwIfAborted(signal);
        const png = await delegate.rasterize(svg, target, { signal });
        throwIfAborted(signal);
        return accountBytes(png);
      },
    };
  }

  return {
    ...input,
    template: { ...input.template, name: request.template.name },
    exportDate: input.exportDate ?? new Date(request.createdAt),
    embedImages: request.options.embedImages,
    updateFields: request.options.updateFields,
    captionLang: request.options.captionLang,
    macros: request.options.resolveMacros ? input.macros : undefined,
    assets,
    rasterizer,
  };
}

function engineProgress(
  context: ExportJobExecutionContext,
  now: () => number,
): { callback: ExportProgressCallback; settled: () => Promise<void> } {
  let pending = Promise.resolve();
  const callback: ExportProgressCallback = (event) => {
    const stage = event.phase === "assets" ? "assets" : "compose";
    pending = pending.then(() =>
      context.updateProgress({
        stage,
        done: event.done,
        total: event.total,
        updatedAt: now(),
      }),
    );
  };
  return { callback, settled: () => pending };
}

/** Create the host-neutral TypeScript DOCX executor for one claimed outer job. */
export function createTypescriptDocxExportJobExecutor(
  options: CreateTypescriptDocxExportJobExecutorOptionsV1,
): ExportJobExecutor<DocxExportJobRequestV1> {
  const now = options.now ?? Date.now;
  return {
    format: "docx",
    async execute(
      untrustedRequest: DocxExportJobRequestV1,
      context: ExportJobExecutionContext,
    ): Promise<ExportJobExecutionResultV1> {
      const request = parseDocxExportJobRequestV1(untrustedRequest);
      throwIfAborted(context.signal);

      let checkpoint = await options.readyToRender.load({
        jobId: context.jobId,
        request,
        signal: context.signal,
      });
      throwIfAborted(context.signal);

      let resolvedInput: TypescriptDocxExportJobEngineInputV1 | undefined;
      let estimate: ResourceEstimateV1;
      let resultKey: DocxExportResultRecoveryKeyV1 | undefined;
      let sourcePageCount = checkpoint?.sourcePageCount ?? 1;
      if (checkpoint) {
        validateCheckpoint(checkpoint, request, context);
        await context.checkpoint(checkpoint.ref);
        estimate = checkpoint.estimate;
        resultKey = await buildResultRecoveryKey(request, checkpoint, context);
        const recovered = await options.results.recover(resultKey, context);
        throwIfAborted(context.signal);
        if (recovered) {
          validateResultIntent(recovered.intent, resultKey);
          const result = validateExecutionResult(recovered.result, context, recovered.intent);
          if (recovered.intent.telemetry) {
            await publishTelemetry(context, recovered.intent.telemetry);
          }
          return result;
        }
      } else {
        await progress(context, now, "fetch", 0, 1, "Resolving DOCX source input");
        const resolved = await options.resolveInput(request, context);
        sourcePageCount = resolved.jobTelemetry?.sourcePageCount ?? 1;
        nonNegativeSafeInteger(sourcePageCount, "telemetry.sourcePageCount");
        const { jobTelemetry: _jobTelemetry, ...engineInput } = resolved;
        resolvedInput = engineInput;
        throwIfAborted(context.signal);
        estimate = options.estimateRender(resolvedInput, request);
        validateEstimate(estimate);
      }

      if (checkpoint && checkpoint.renderAttempts >= 2) {
        throw new DocxRenderRestartLimitError();
      }

      const reservation = await options.renderReservations.acquire({
        jobId: context.jobId,
        leaseEpoch: context.leaseEpoch,
        estimate,
        signal: context.signal,
      });
      try {
        throwIfAborted(context.signal);

        if (!checkpoint) {
          // The heavy reservation deliberately precedes template bytes, PizZip,
          // asset fetch/decode, rasterization, and prepared-archive generation.
          let pinned = await options.templates.resolve({
            jobId: context.jobId,
            recordKey: request.template.recordKey,
            expectedSha256: request.template.sha256.toLowerCase(),
            signal: context.signal,
          });
          throwIfAborted(context.signal);
          if (pinned.recordKey !== request.template.recordKey) {
            throw new Error("DOCX template resolver returned a different record key.");
          }
          let templateBytes: Uint8Array | undefined = exactOwnedBytes(pinned.bytes);
          pinned = { ...pinned, bytes: new Uint8Array() };
          const template: DocxTemplateBindingV1 = {
            recordKey: request.template.recordKey,
            byteLength: templateBytes.byteLength,
            sha256: await sha256Hex(templateBytes, context.signal),
          };
          validateTemplateBinding(template, request);
          await reservation.reconcile({ templateBytes: template.byteLength, signal: context.signal });

          const progressChannel = engineProgress(context, now);
          let prepared: PreparedDocxExportV1 | undefined;
          let prepareFailure: unknown;
          try {
            const engineInput = instrumentEngineInput(
              resolvedInput!,
              request,
              reservation,
              context.signal,
            );
            prepared = await prepareDocxExport({
              ...engineInput,
              templateBytes,
              signal: context.signal,
              onProgress: progressChannel.callback,
            });
          } catch (error) {
            prepareFailure = error;
          } finally {
            resolvedInput = undefined;
            templateBytes = undefined;
            try {
              await progressChannel.settled();
            } catch (progressFailure) {
              if (prepareFailure === undefined) throw progressFailure;
            }
          }
          if (prepareFailure !== undefined) throw prepareFailure;
          if (!prepared) throw new Error("DOCX preparation completed without a payload.");
          throwIfAborted(context.signal);
          const binding = await fingerprintPreparedDocxExport(
            prepared,
            estimate,
            template,
            context.signal,
          );
          await reservation.reconcile({ preparedBytes: binding.byteLength, signal: context.signal });
          checkpoint = await options.readyToRender.commit({
            jobId: context.jobId,
            leaseEpoch: context.leaseEpoch,
            request,
            prepared,
            binding,
            template,
            estimate,
            sourcePageCount,
            signal: context.signal,
          });
          validateCheckpoint(checkpoint, request, context);
          if (
            !sameEstimate(checkpoint.estimate, estimate) ||
            !sameTemplate(checkpoint.template, template) ||
            checkpoint.preparedByteLength !== binding.byteLength ||
            checkpoint.preparedSha256 !== binding.sha256 ||
            checkpoint.renderAttempts !== 0
          ) {
            throw new Error("DOCX checkpoint store changed an immutable prepared binding.");
          }
          await context.checkpoint(checkpoint.ref);
          resultKey = await buildResultRecoveryKey(request, checkpoint, context);
          // Preparation may already have emitted `assets`; never regress the
          // durable stage back to `compose` after the checkpoint is committed.
          await progress(context, now, "render", 0, 1, "DOCX render input is durable");
        }

        await reservation.reconcile({
          templateBytes: checkpoint.template.byteLength,
          preparedBytes: checkpoint.preparedByteLength,
          outputBytes: checkpoint.estimate.outputBytes,
          rasterPixels: checkpoint.estimate.rasterPixels,
          signal: context.signal,
        });

        const previousCheckpoint = checkpoint;
        checkpoint = await options.readyToRender.beginRenderAttempt({
          checkpoint,
          jobId: context.jobId,
          leaseEpoch: context.leaseEpoch,
          signal: context.signal,
        });
        validateCheckpoint(checkpoint, request, context);
        if (
          !sameCheckpointExceptAttempts(checkpoint, previousCheckpoint) ||
          checkpoint.renderAttempts !== previousCheckpoint.renderAttempts + 1 ||
          checkpoint.renderAttempts > 2
        ) {
          throw new Error("DOCX render-attempt update was not an atomic single increment.");
        }

        let prepared: PreparedDocxExportV1 | undefined = await options.readyToRender.materialize({
          checkpoint,
          jobId: context.jobId,
          leaseEpoch: context.leaseEpoch,
          signal: context.signal,
        });
        throwIfAborted(context.signal);
        const materializedBinding = await fingerprintPreparedDocxExport(
          prepared,
          checkpoint.estimate,
          checkpoint.template,
          context.signal,
        );
        if (
          materializedBinding.byteLength !== checkpoint.preparedByteLength ||
          materializedBinding.sha256 !== checkpoint.preparedSha256
        ) {
          throw new Error("Materialized DOCX state does not match its durable checkpoint.");
        }

        await progress(
          context,
          now,
          "render",
          0,
          1,
          `Rendering DOCX (attempt ${checkpoint.renderAttempts}/2)`,
        );
        let outputBytes: Uint8Array | undefined;
        let report: ExportReport;
        try {
          const output = await renderPreparedDocxExport(prepared, { signal: context.signal });
          outputBytes = exactOwnedBytes(output.bytes);
          report = output.report;
        } finally {
          prepared = undefined;
        }
        throwIfAborted(context.signal);
        await progress(context, now, "validate", 0, 1, "Validating DOCX output");
        if (outputBytes.byteLength > checkpoint.estimate.outputBytes) {
          throw new Error(
            `DOCX output exceeds its hard estimate (${outputBytes.byteLength} > ${checkpoint.estimate.outputBytes}).`,
          );
        }
        await reservation.reconcile({ outputBytes: outputBytes.byteLength, signal: context.signal });
        const artifactSha256 = await sha256Hex(outputBytes, context.signal);
        const summary = reportSummary(report);
        parseExportReportSummaryV1(summary);
        const telemetry = buildProductiveExportTelemetryV1(
          {
            pageCount: checkpoint.sourcePageCount ?? 1,
            preparedBytes: checkpoint.preparedByteLength,
            outputBytes: outputBytes.byteLength,
            renderAttempts: checkpoint.renderAttempts,
            embeddedAssets: report.embeddedImages,
            skippedAssets: report.skippedImages,
            renderedDiagrams: report.renderedDiagrams,
            reportSummary: summary,
            notes: report.notes,
            durationsMs: {
              fetch: Math.round(
                report.timings.includeFetchMs + report.timings.imageFetchMs,
              ),
              compose: Math.round(
                Math.max(report.timings.resolveMs, report.timings.bodyMs),
              ),
              assets: Math.round(
                report.timings.logoFetchMs
                  + report.timings.imageFetchMs
                  + report.timings.diagramRenderMs
                  + report.timings.diagramRasterMs,
              ),
              render: Math.round(report.timings.renderMs),
            },
          },
          now(),
        );
        const reportSha256 = await sha256Hex(
          new TextEncoder().encode(canonical(report)),
          context.signal,
        );
        await progress(context, now, "validate", 1, 1, "DOCX output validated");
        await progress(context, now, "commit", 0, 1, "Staging DOCX artifact and report");
        if (!resultKey) throw new Error("DOCX result key was not derived from its checkpoint.");

        const artifact: PendingArtifactV1 = {
          mediaType: DOCX_MEDIA_TYPE,
          filename: report.filename,
          byteLength: outputBytes.byteLength,
          sha256: artifactSha256,
          bytes: (async function* (): AsyncIterable<Uint8Array> {
            // Borrowed until results.stage resolves; the store must consume it.
            yield outputBytes!;
          })(),
        };
        const intent: DocxExportResultIntentV1 = {
          schema: "atlcli.docx-result-intent/1",
          key: resultKey,
          artifact: {
            mediaType: DOCX_MEDIA_TYPE,
            filename: artifact.filename,
            byteLength: artifact.byteLength,
            sha256: artifact.sha256,
          },
          reportRef: `${resultKey.ref}:report`,
          reportSha256,
          reportSummary: summary,
          telemetry,
        };
        try {
          const preparedIntent = await options.results.prepare({ intent, report }, context);
          validateResultIntent(preparedIntent, resultKey, {
            artifact,
            reportSha256,
            reportSummary: summary,
            telemetry,
          });
          const result = await options.results.stage(
            { intent: preparedIntent, artifact },
            context,
          );
          await publishTelemetry(context, telemetry);
          await progress(context, now, "commit", 1, 1, "DOCX artifact and report staged");
          return validateExecutionResult(result, context, preparedIntent);
        } finally {
          outputBytes = undefined;
        }
      } finally {
        await reservation.release();
      }
    },
  };
}
