import {
  parsePdfExportJobRequestV1,
  parseExportReportSummaryV1,
  type ExportJobExecutionContext,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobResultTelemetryV1,
  type ExportReportSummaryV1,
  type PendingArtifactV1,
  type PdfExportJobRequestV1,
  type ResourceEstimateV1,
} from "@atlcli/export-jobs";
import {
  preparePdfExport,
  renderPreparedPdfExport,
  type PdfCompilePort,
  type PdfExportReport,
  type PdfBytesHandle,
  type PreparePdfExportEnv,
  type PreparedPdfExportV1,
  type RunPdfExportInput,
} from "@atlcli/pdf";
import { resolveCodeThemeId } from "@atlcli/code-highlight/registry";
import {
  buildProductiveExportTelemetryV1,
} from "./productive-telemetry.js";

export type PdfExportJobEngineInputV1 = Omit<
  RunPdfExportInput,
  "signal" | "onPhase" | "onProgress"
>;

/** Lightweight durable checkpoint metadata; compiler-bundle bytes remain opaque. */
export interface PdfReadyToRenderCheckpointV1 {
  schema: "atlcli.pdf-ready-to-render/1";
  ref: string;
  jobId: string;
  requestId: string;
  requestKey: string;
  preparedRef: string;
  preparedByteLength: number;
  preparedSha256: string;
  estimate: ResourceEstimateV1;
  /** Productive source-page count for final statistics; absent only on legacy checkpoints. */
  sourcePageCount?: number;
  /** Atomically advanced before starting Typst. One fresh restart means at most two. */
  renderAttempts: number;
}

export interface PdfPreparedPayloadBindingV1 {
  byteLength: number;
  sha256: string;
}

export interface PdfReadyToRenderStoreV1 {
  load(input: {
    jobId: string;
    request: PdfExportJobRequestV1;
    signal: AbortSignal;
  }): Promise<PdfReadyToRenderCheckpointV1 | undefined>;
  commit(input: {
    jobId: string;
    leaseEpoch: number;
    request: PdfExportJobRequestV1;
    prepared: PreparedPdfExportV1;
    binding: PdfPreparedPayloadBindingV1;
    estimate: ResourceEstimateV1;
    sourcePageCount?: number;
    signal: AbortSignal;
  }): Promise<PdfReadyToRenderCheckpointV1>;
  /** Materialize the compiler bundle only while the caller holds a heavy reservation. */
  materialize(input: {
    checkpoint: PdfReadyToRenderCheckpointV1;
    jobId: string;
    leaseEpoch: number;
    signal: AbortSignal;
  }): Promise<PreparedPdfExportV1>;
  /** Must fence on job/epoch and atomically return the incremented attempt count. */
  beginRenderAttempt(input: {
    checkpoint: PdfReadyToRenderCheckpointV1;
    jobId: string;
    leaseEpoch: number;
    signal: AbortSignal;
  }): Promise<PdfReadyToRenderCheckpointV1>;
}

export interface PdfRenderReservationV1 {
  /**
   * Ensure the live reservation covers these component-wise absolute floors.
   * Each component is monotonically max(previous, supplied), so a smaller
   * later actual value never lowers its floor. Repeating values is idempotent;
   * growth is atomic or fails closed.
   */
  reconcile(input: {
    preparedBytes?: number;
    outputBytes?: number;
    signal: AbortSignal;
  }): Promise<void>;
  release(): void | Promise<void>;
}

export interface PdfRenderReservationPortV1 {
  acquire(input: {
    jobId: string;
    leaseEpoch: number;
    estimate: ResourceEstimateV1;
    signal: AbortSignal;
  }): Promise<PdfRenderReservationV1>;
}

export interface PdfExportResultRecoveryKeyV1 {
  schema: "atlcli.pdf-result-key/1";
  /** Deterministic digest of the immutable job, request, and checkpoint identity. */
  ref: string;
  jobId: string;
  requestId: string;
  requestKey: string;
  requestSha256: string;
  checkpointRef: string;
  preparedByteLength: number;
  preparedSha256: string;
  estimate: ResourceEstimateV1;
}

export interface PdfExportResultIntentV1 {
  schema: "atlcli.pdf-result-intent/1";
  key: PdfExportResultRecoveryKeyV1;
  artifact: {
    mediaType: "application/pdf";
    filename: string;
    byteLength: number;
    sha256: string;
  };
  /** Deterministic from `key.ref`; never allocated by a mutable global counter. */
  reportRef: string;
  reportSha256: string;
  reportSummary: ExportReportSummaryV1;
  /** Added productively in PR-I; absent only on legacy persisted result intents. */
  telemetry?: ExportJobResultTelemetryV1;
}

export interface PdfRecoveredExportResultV1 {
  intent: PdfExportResultIntentV1;
  result: ExportJobExecutionResultV1;
}

/**
 * Crash-recoverable staging boundary for one validated PDF plus its report.
 *
 * `prepare` must durably journal the immutable request/checkpoint/result intent
 * and report before artifact bytes are staged. `stage` may then publish bytes
 * and atomically mark that exact intent complete. If the caller loses the
 * return after artifact publication, `recover` finishes from durable metadata.
 * Recovery is strictly O(1): it must not read, copy, or restage artifact/report
 * payload bytes, and it may only return metadata bound to the supplied key.
 * `stage` must consume the borrowed `artifact.bytes` stream before resolving
 * and must not retain the stream or any of its chunks afterwards.
 */
export interface PdfExportResultStoreV1 {
  recover(
    key: PdfExportResultRecoveryKeyV1,
    context: ExportJobExecutionContext,
  ): Promise<PdfRecoveredExportResultV1 | undefined>;
  prepare(
    input: { intent: PdfExportResultIntentV1; report: PdfExportReport },
    context: ExportJobExecutionContext,
  ): Promise<PdfExportResultIntentV1>;
  stage(
    input: { intent: PdfExportResultIntentV1; artifact: PendingArtifactV1 },
    context: ExportJobExecutionContext,
  ): Promise<ExportJobExecutionResultV1>;
}

export interface CreatePdfExportJobExecutorOptionsV1 {
  resolveInput(
    request: PdfExportJobRequestV1,
    context: ExportJobExecutionContext,
  ): Promise<{
    input: PdfExportJobEngineInputV1;
    env: Omit<PreparePdfExportEnv, "now">;
    telemetry?: { sourcePageCount: number };
  }>;
  readyToRender: PdfReadyToRenderStoreV1;
  /**
   * Conservative admission estimate computed before VFS materialization.
   * `outputBytes` is a hard upper bound for the final PDF artifact, not a hint.
   */
  estimateRender(
    input: PdfExportJobEngineInputV1,
    request: PdfExportJobRequestV1,
  ): ResourceEstimateV1;
  compiler: PdfCompilePort;
  renderReservations: PdfRenderReservationPortV1;
  results: PdfExportResultStoreV1;
  now?: () => number;
}

export class PdfRenderRestartLimitError extends Error {
  constructor() {
    super("PDF render already used its one automatic restart from ready-to-render.");
    this.name = "PdfRenderRestartLimitError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("PDF export job was cancelled.", "AbortError");
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

function sameCheckpointExceptAttempts(
  left: PdfReadyToRenderCheckpointV1,
  right: PdfReadyToRenderCheckpointV1,
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
    sameEstimate(left.estimate, right.estimate)
  );
}

function validateCheckpoint(
  checkpoint: PdfReadyToRenderCheckpointV1,
  request: PdfExportJobRequestV1,
  context: ExportJobExecutionContext,
): void {
  if (checkpoint.schema !== "atlcli.pdf-ready-to-render/1") {
    throw new Error("Unsupported PDF ready-to-render checkpoint schema.");
  }
  if (
    checkpoint.jobId !== context.jobId ||
    checkpoint.requestId !== request.id ||
    checkpoint.requestKey !== request.idempotencyKey
  ) {
    throw new Error("PDF ready-to-render checkpoint identity does not match this job request.");
  }
  if (checkpoint.ref.trim().length === 0) throw new Error("PDF checkpoint ref must not be empty.");
  if (checkpoint.preparedRef.trim().length === 0) {
    throw new Error("PDF prepared bundle ref must not be empty.");
  }
  nonNegativeSafeInteger(checkpoint.preparedByteLength, "checkpoint.preparedByteLength");
  if (checkpoint.preparedByteLength === 0) {
    throw new Error("PDF prepared bundle byte length must be positive.");
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.preparedSha256)) {
    throw new Error("PDF prepared bundle SHA-256 is invalid.");
  }
  nonNegativeSafeInteger(checkpoint.renderAttempts, "checkpoint.renderAttempts");
  if (checkpoint.sourcePageCount !== undefined) {
    nonNegativeSafeInteger(checkpoint.sourcePageCount, "checkpoint.sourcePageCount");
  }
  validateEstimate(checkpoint.estimate);
}

function progress(
  context: ExportJobExecutionContext,
  now: () => number,
  stage: "fetch" | "compose" | "render" | "validate" | "commit",
  done: number,
  total: number,
  detail: string,
): Promise<void> {
  return context.updateProgress({ stage, done, total, detail, updatedAt: now() });
}

class CapturePdfOutputSink {
  #captured?: { filename: string; handle: PdfBytesHandle };

  async emit(
    filename: string,
    handle: PdfBytesHandle,
    context?: { signal?: AbortSignal },
  ): Promise<void> {
    if (context?.signal) throwIfAborted(context.signal);
    if (this.#captured) throw new Error("PDF engine emitted more than one artifact.");
    this.#captured = { filename, handle };
  }

  take(): { filename: string; handle: PdfBytesHandle } {
    if (!this.#captured) throw new Error("PDF engine completed without emitting an artifact.");
    const captured = this.#captured;
    this.#captured = undefined;
    return captured;
  }
}

async function sha256Hex(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (signal) throwIfAborted(signal);
  // WebCrypto snapshots its input synchronously and digesting a typed-array
  // VIEW hashes exactly the view's range, so the old non-buffer-exact
  // `slice()` copy was avoidable (issue #118 Phase 0.5). Only a
  // SharedArrayBuffer-backed view (which WebCrypto rejects) still copies.
  const source: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  if (signal) throwIfAborted(signal);
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Prepared PDF metadata contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) throw new Error("Prepared PDF metadata contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Prepared PDF metadata must contain only plain data objects.");
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

async function fingerprintPreparedPdfExport(
  prepared: PreparedPdfExportV1,
  estimate: ResourceEstimateV1,
  signal: AbortSignal,
): Promise<PdfPreparedPayloadBindingV1> {
  throwIfAborted(signal);
  validateEstimate(estimate);
  if (prepared.schema !== "atlcli.prepared-pdf-export/1" || !prepared.bundle) {
    throw new Error("Unsupported or already-consumed prepared PDF export.");
  }
  if (
    prepared.filename.trim().length === 0 ||
    (prepared.profile !== "tagged" && prepared.profile !== "pdf-ua-1") ||
    typeof prepared.complete !== "boolean"
  ) {
    throw new Error("Prepared PDF export metadata is invalid.");
  }
  for (const [name, value] of Object.entries(prepared.counts)) {
    nonNegativeSafeInteger(value, `prepared.counts.${name}`);
  }
  nonNegativeFinite(prepared.startedAt, "prepared.startedAt");
  nonNegativeFinite(prepared.prepareMs, "prepared.prepareMs");

  const encoder = new TextEncoder();
  const mainBytes = encoder.encode(prepared.bundle.main);
  const templateBytes = encoder.encode(prepared.bundle.template);
  const assets = [];
  let byteLength = mainBytes.byteLength + templateBytes.byteLength;
  for (const asset of prepared.bundle.assets) {
    throwIfAborted(signal);
    if (!(asset.bytes instanceof Uint8Array) || asset.path.trim().length === 0) {
      throw new Error("Prepared PDF bundle contains an invalid asset.");
    }
    throwIfAborted(signal);
    byteLength += asset.bytes.byteLength;
    assets.push({
      path: asset.path,
      mediaType: asset.mediaType,
      byteLength: asset.bytes.byteLength,
      sha256: await sha256Hex(asset.bytes, signal),
    });
  }
  throwIfAborted(signal);
  const descriptor = canonical({
    schema: prepared.schema,
    filename: prepared.filename,
    profile: prepared.profile,
    language: prepared.language,
    sourceNotes: prepared.sourceNotes,
    bundleNotes: prepared.bundleNotes,
    counts: prepared.counts,
    complete: prepared.complete,
    estimate,
    startedAt: prepared.startedAt,
    prepareMs: prepared.prepareMs,
    bundle: {
      main: { byteLength: mainBytes.byteLength, sha256: await sha256Hex(mainBytes, signal) },
      template: {
        byteLength: templateBytes.byteLength,
        sha256: await sha256Hex(templateBytes, signal),
      },
      assets,
      sourceMap: prepared.bundle.sourceMap,
      notes: prepared.bundle.notes,
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

async function buildResultRecoveryKey(
  request: PdfExportJobRequestV1,
  checkpoint: PdfReadyToRenderCheckpointV1,
  context: ExportJobExecutionContext,
): Promise<PdfExportResultRecoveryKeyV1> {
  const encoder = new TextEncoder();
  const requestSha256 = await sha256Hex(encoder.encode(canonical(request)), context.signal);
  const identity = {
    schema: "atlcli.pdf-result-key/1",
    jobId: context.jobId,
    requestId: request.id,
    requestKey: request.idempotencyKey,
    requestSha256,
    checkpointRef: checkpoint.ref,
    preparedByteLength: checkpoint.preparedByteLength,
    preparedSha256: checkpoint.preparedSha256,
    estimate: checkpoint.estimate,
  } as const;
  const digest = await sha256Hex(encoder.encode(canonical(identity)), context.signal);
  return { ...identity, ref: `pdf-result:${digest}` };
}

function validateRecoveryKey(
  actual: PdfExportResultRecoveryKeyV1,
  expected: PdfExportResultRecoveryKeyV1,
): void {
  validateEstimate(actual.estimate);
  nonNegativeSafeInteger(actual.preparedByteLength, "resultKey.preparedByteLength");
  if (
    actual.schema !== "atlcli.pdf-result-key/1" ||
    !/^pdf-result:[a-f0-9]{64}$/.test(actual.ref) ||
    !/^[a-f0-9]{64}$/.test(actual.requestSha256) ||
    !/^[a-f0-9]{64}$/.test(actual.preparedSha256) ||
    canonical(actual) !== canonical(expected)
  ) {
    throw new Error("PDF result recovery key does not match this request and checkpoint.");
  }
}

function validateResultIntent(
  intent: PdfExportResultIntentV1,
  expectedKey: PdfExportResultRecoveryKeyV1,
  expected?: {
    artifact: PendingArtifactV1;
    reportSha256: string;
    reportSummary: ExportReportSummaryV1;
    telemetry: ExportJobResultTelemetryV1;
  },
): void {
  if (intent.schema !== "atlcli.pdf-result-intent/1") {
    throw new Error("Unsupported PDF result intent schema.");
  }
  validateRecoveryKey(intent.key, expectedKey);
  parseExportReportSummaryV1(intent.reportSummary);
  if (
    intent.artifact.mediaType !== "application/pdf" ||
    intent.artifact.filename.trim().length === 0 ||
    !Number.isSafeInteger(intent.artifact.byteLength) ||
    intent.artifact.byteLength <= 0 ||
    !/^[a-f0-9]{64}$/.test(intent.artifact.sha256) ||
    intent.reportRef !== `${expectedKey.ref}:report` ||
    !/^[a-f0-9]{64}$/.test(intent.reportSha256)
  ) {
    throw new Error("PDF result intent contains invalid artifact or report metadata.");
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
    throw new Error("PDF result intent does not match the validated artifact and report.");
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
  intent: PdfExportResultIntentV1,
): ExportJobExecutionResultV1 {
  const artifact = result.stagedArtifact;
  parseExportReportSummaryV1(result.reportSummary);
  if (
    artifact.jobId !== context.jobId ||
    artifact.leaseEpoch !== context.leaseEpoch ||
    artifact.mediaType !== "application/pdf" ||
    artifact.filename.trim().length === 0 ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof result.reportRef !== "string" ||
    result.reportRef.trim().length === 0 ||
    result.reportRef !== intent.reportRef
  ) {
    throw new Error("PDF result store returned invalid or unfenced staged metadata.");
  }
  if (
    artifact.mediaType !== intent.artifact.mediaType ||
    artifact.filename !== intent.artifact.filename ||
    artifact.byteLength !== intent.artifact.byteLength ||
    artifact.sha256 !== intent.artifact.sha256 ||
    !sameReportSummary(result.reportSummary, intent.reportSummary)
  ) {
    throw new Error("PDF result store returned metadata that does not match its durable intent.");
  }
  return result;
}

function reportSummary(report: PdfExportReport): ExportReportSummaryV1 {
  const counts = { info: 0, warning: 0, error: 0 };
  const codes = new Map<string, number>();
  for (const note of report.notes) {
    counts[note.level] += 1;
    codes.set(note.code, (codes.get(note.code) ?? 0) + 1);
  }
  for (const diagnostic of report.compilerDiagnostics ?? []) {
    counts[diagnostic.severity] += 1;
    const code = `pdf-compiler-${diagnostic.severity}`;
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  return {
    issues: counts,
    topCodes: [...codes]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, 20),
    completeness: report.complete ? "complete" : "partial",
  };
}

async function prepareResolvedPdfExport(
  resolved: { input: PdfExportJobEngineInputV1; env: Omit<PreparePdfExportEnv, "now"> },
  request: PdfExportJobRequestV1,
  signal: AbortSignal,
  now: () => number,
): Promise<PreparedPdfExportV1> {
  return preparePdfExport(
    {
      ...resolved.input,
      codeTheme: resolveCodeThemeId(request.options.codeTheme),
      signal,
    },
    { ...resolved.env, now },
  );
}

/** Create the host-neutral Typst executor for one already claimed outer export job. */
export function createPdfExportJobExecutor(
  options: CreatePdfExportJobExecutorOptionsV1,
): ExportJobExecutor<PdfExportJobRequestV1> {
  const now = options.now ?? Date.now;
  return {
    format: "pdf",
    async execute(
      request: PdfExportJobRequestV1,
      context: ExportJobExecutionContext,
    ): Promise<ExportJobExecutionResultV1> {
      request = parsePdfExportJobRequestV1(request);
      throwIfAborted(context.signal);

      let checkpoint = await options.readyToRender.load({
        jobId: context.jobId,
        request,
        signal: context.signal,
      });
      throwIfAborted(context.signal);

      let resolved:
        | {
            input: PdfExportJobEngineInputV1;
            env: Omit<PreparePdfExportEnv, "now">;
            telemetry?: { sourcePageCount: number };
          }
        | undefined;
      let estimate: ResourceEstimateV1;
      let resultKey: PdfExportResultRecoveryKeyV1 | undefined;
      let sourcePageCount = checkpoint?.sourcePageCount ?? 1;
      if (checkpoint) {
        validateCheckpoint(checkpoint, request, context);
        // Commit and publication are separate fenced writes. Recovery must heal
        // a crash after the payload commit but before the job row saw its ref.
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
        await progress(context, now, "fetch", 0, 1, "Resolving PDF source input");
        resolved = await options.resolveInput(request, context);
        throwIfAborted(context.signal);
        sourcePageCount = resolved.telemetry?.sourcePageCount ?? 1;
        nonNegativeSafeInteger(sourcePageCount, "telemetry.sourcePageCount");
        estimate = options.estimateRender(resolved.input, request);
        validateEstimate(estimate);
      }
      if (checkpoint?.renderAttempts !== undefined && checkpoint.renderAttempts >= 2) {
        throw new PdfRenderRestartLimitError();
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
          let newlyPrepared: PreparedPdfExportV1;
          try {
            newlyPrepared = await prepareResolvedPdfExport(
              resolved!,
              request,
              context.signal,
              now,
            );
          } finally {
            // The source graph may dwarf the compiler bundle. Drop the final
            // executor-owned reference immediately after preparation settles.
            resolved = undefined;
          }
          throwIfAborted(context.signal);
          const fingerprint = await fingerprintPreparedPdfExport(newlyPrepared, estimate, context.signal);
          await reservation.reconcile({
            preparedBytes: fingerprint.byteLength,
            signal: context.signal,
          });
          checkpoint = await options.readyToRender.commit({
            jobId: context.jobId,
            leaseEpoch: context.leaseEpoch,
            request,
            prepared: newlyPrepared,
            binding: fingerprint,
            estimate,
            sourcePageCount,
            signal: context.signal,
          });
          validateCheckpoint(checkpoint, request, context);
          if (
            !sameEstimate(checkpoint.estimate, estimate) ||
            checkpoint.preparedByteLength !== fingerprint.byteLength ||
            checkpoint.preparedSha256 !== fingerprint.sha256
          ) {
            throw new Error("PDF checkpoint store changed the prepared payload binding or estimate.");
          }
          if (checkpoint.renderAttempts !== 0) {
            throw new Error("A newly committed PDF checkpoint must have zero render attempts.");
          }
          await context.checkpoint(checkpoint.ref);
          resultKey = await buildResultRecoveryKey(request, checkpoint, context);
          await progress(context, now, "compose", 1, 1, "PDF render input is durable");
        }

        // The durable binding is known before materialization, so grow/reconcile
        // the fresh attempt's reservation before loading the complete VFS into
        // memory. A rejected admission must not allocate the payload or consume
        // one of the two render attempts.
        await reservation.reconcile({
          preparedBytes: checkpoint.preparedByteLength,
          outputBytes: checkpoint.estimate.outputBytes,
          signal: context.signal,
        });

        // Materialization is part of the non-resumable render attempt: an OOM or
        // worker loss here consumes one of the two permitted attempts.
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
          throw new Error("PDF render-attempt update was not an atomic single increment.");
        }

        let prepared: PreparedPdfExportV1 | undefined = await options.readyToRender.materialize({
          checkpoint,
          jobId: context.jobId,
          leaseEpoch: context.leaseEpoch,
          signal: context.signal,
        });
        throwIfAborted(context.signal);
        const materializedFingerprint = await fingerprintPreparedPdfExport(
          prepared,
          checkpoint.estimate,
          context.signal,
        );
        if (
          materializedFingerprint.byteLength !== checkpoint.preparedByteLength ||
          materializedFingerprint.sha256 !== checkpoint.preparedSha256
        ) {
          throw new Error("Materialized PDF render state does not match its durable checkpoint.");
        }
        await progress(context, now, "render", 0, 1, `Rendering PDF (attempt ${checkpoint.renderAttempts}/2)`);
        const capture = new CapturePdfOutputSink();
        let report: PdfExportReport;
        try {
          report = await renderPreparedPdfExport(
            prepared,
            { signal: context.signal },
            { compiler: options.compiler, output: capture, now },
          );
        } finally {
          // Do not retain the complete VFS bundle while hashing/staging output bytes.
          prepared = undefined;
        }
        const emitted = capture.take();
        try {
          throwIfAborted(context.signal);
          await progress(context, now, "validate", 1, 1, "PDF output validated");

          const bytes = await emitted.handle.asUint8Array();
          throwIfAborted(context.signal);
          if (bytes.byteLength > checkpoint.estimate.outputBytes) {
            throw new Error(
              `PDF output exceeds its hard estimate (${bytes.byteLength} > ${checkpoint.estimate.outputBytes}).`,
            );
          }
          await reservation.reconcile({ outputBytes: bytes.byteLength, signal: context.signal });
          const sha256 = await sha256Hex(bytes, context.signal);
          throwIfAborted(context.signal);
          await progress(context, now, "commit", 0, 1, "Staging PDF artifact and report");
          const artifact: PendingArtifactV1 = {
            mediaType: "application/pdf",
            filename: emitted.filename,
            byteLength: bytes.byteLength,
            sha256,
            bytes: (async function* (): AsyncIterable<Uint8Array> {
              // Borrowed from PdfBytesHandle until `results.stage` resolves.
              yield bytes;
            })(),
          };
          const summary = reportSummary(report);
          parseExportReportSummaryV1(summary);
          const telemetry = buildProductiveExportTelemetryV1(
            {
              pageCount: checkpoint.sourcePageCount ?? 1,
              preparedBytes: checkpoint.preparedByteLength,
              outputBytes: artifact.byteLength,
              renderAttempts: checkpoint.renderAttempts,
              embeddedAssets: report.embeddedImages,
              skippedAssets: report.skippedAssets,
              renderedDiagrams: report.renderedDiagrams,
              reportSummary: summary,
              notes: report.notes,
              compilerIssues: (report.compilerDiagnostics ?? []).map((diagnostic) => ({
                severity: diagnostic.severity,
                code: `pdf-compiler-${diagnostic.severity}`,
              })),
              durationsMs: {
                compose: Math.round(report.timings.prepareMs),
                render: Math.round(report.timings.compileMs),
                commit: Math.round(report.timings.emitMs),
              },
            },
            now(),
          );
          const reportSha256 = await sha256Hex(
            new TextEncoder().encode(canonical(report)),
            context.signal,
          );
          if (!resultKey) throw new Error("PDF result key was not derived from its checkpoint.");
          const intent: PdfExportResultIntentV1 = {
            schema: "atlcli.pdf-result-intent/1",
            key: resultKey,
            artifact: {
              mediaType: "application/pdf",
              filename: artifact.filename,
              byteLength: artifact.byteLength,
              sha256: artifact.sha256,
            },
            reportRef: `${resultKey.ref}:report`,
            reportSha256,
            reportSummary: summary,
            telemetry,
          };
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
          await progress(context, now, "commit", 1, 1, "PDF artifact and report staged");
          return validateExecutionResult(result, context, preparedIntent);
        } finally {
          emitted.handle.release();
        }
      } finally {
        await reservation.release();
      }
    },
  };
}
