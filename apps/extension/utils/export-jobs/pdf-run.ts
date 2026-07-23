import type {
  ExportJobSnapshotV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import { downloadBytes } from "../download.js";
import type {
  ExportPhase,
  PdfExportRequest,
} from "../ports/export.js";
import {
  ExtensionExportCatalogError,
  IndexedDbExportJobCatalog,
} from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import {
  readExtensionPdfExportReport,
} from "./executor-store.js";
import {
  chromePdfExportSubmissionDeps,
  submitExtensionPdfExport,
  type SubmittedExtensionPdfExportV1,
} from "./pdf-submit.js";

const TERMINAL: ReadonlySet<ExportJobSnapshotV1["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const);

function isTerminal(state: ExportJobSnapshotV1["state"]): boolean {
  return TERMINAL.has(state);
}

export interface RunSubmittedExtensionPdfExportDepsV1 {
  submit(request: PdfExportRequest): Promise<SubmittedExtensionPdfExportV1>;
  catalog: Pick<
    IndexedDbExportJobCatalog,
    "get" | "compareAndSet" | "deliver"
  >;
  bytes: Pick<IndexedDbExportByteStore, "read">;
  readReport(ref: string): Promise<PdfExportReport | undefined>;
  emit(input: {
    filename: string;
    bytes: Uint8Array;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException("PDF export was cancelled.", "AbortError");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      reject(abortReason(signal!));
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function phaseOf(snapshot: ExportJobSnapshotV1): ExportPhase {
  if (snapshot.state === "queued" || snapshot.state === "waiting") return "queued";
  switch (snapshot.stage) {
    case "fetch":
    case "resolve":
    case "assets":
      return "fetching";
    case "render":
      return "compiling";
    case "validate":
    case "commit":
      return "validating";
    case "discover":
    case "compose":
    case undefined:
      return "queued";
  }
}

async function requestCancellation(
  jobId: string,
  deps: Pick<RunSubmittedExtensionPdfExportDepsV1, "catalog" | "now">,
): Promise<void> {
  const now = deps.now ?? Date.now;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await deps.catalog.get(jobId);
    if (
      !current
      || isTerminal(current.state)
      || current.state === "cancelling"
    ) {
      return;
    }
    const to = current.state === "running" ? "cancelling" : "cancelled";
    try {
      await deps.catalog.compareAndSet({
        kind: "transition",
        id: current.id,
        expectedRevision: current.revision,
        to,
        at: now(),
      });
      return;
    } catch (error) {
      if (
        error instanceof ExtensionExportCatalogError
        && error.code === "revision-conflict"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("PDF cancellation could not win a concurrent job transition.");
}

async function collectArtifact(
  snapshot: ExportJobSnapshotV1,
  bytes: Pick<IndexedDbExportByteStore, "read">,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!snapshot.artifact) throw new Error("Succeeded PDF job has no retained artifact.");
  const result = new Uint8Array(snapshot.artifact.byteLength);
  let offset = 0;
  for await (const chunk of bytes.read(snapshot.artifact.ref, { signal })) {
    signal?.throwIfAborted();
    if (offset + chunk.byteLength > result.byteLength) {
      throw new Error("Retained PDF artifact exceeds its committed length.");
    }
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== result.byteLength) {
    throw new Error("Retained PDF artifact is truncated.");
  }
  return result;
}

async function markDelivered(
  snapshot: ExportJobSnapshotV1,
  deps: Pick<RunSubmittedExtensionPdfExportDepsV1, "catalog" | "now">,
): Promise<void> {
  const now = deps.now ?? Date.now;
  try {
    await deps.catalog.deliver(snapshot.id, snapshot.revision, now());
  } catch (error) {
    if (
      error instanceof ExtensionExportCatalogError
      && error.code === "revision-conflict"
    ) {
      const current = await deps.catalog.get(snapshot.id);
      if (current?.deliveredAt !== undefined) return;
    }
    throw error;
  }
}

function terminalFailure(snapshot: ExportJobSnapshotV1): Error {
  if (snapshot.state === "cancelled") {
    return new DOMException("PDF export was cancelled.", "AbortError");
  }
  return new Error(
    snapshot.error?.message
      ?? `PDF export ended as ${snapshot.state}.`,
  );
}

/**
 * Submit once, then observe the durable outer job.
 *
 * This promise is merely an attached observer. Losing the panel destroys the
 * promise but cannot cancel or own any executor work.
 */
export async function runSubmittedExtensionPdfExport(
  request: PdfExportRequest,
  deps: RunSubmittedExtensionPdfExportDepsV1,
): Promise<PdfExportReport> {
  request.signal?.throwIfAborted();
  const submitted = await deps.submit(request);
  const jobId = submitted.snapshot.id;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 200;
  let cancellation: Promise<void> | undefined;
  let lastPhase: ExportPhase | undefined;
  let lastProgressRevision = -1;
  const cancel = (): void => {
    cancellation ??= requestCancellation(jobId, deps);
  };
  request.signal?.addEventListener("abort", cancel, { once: true });

  try {
    while (true) {
      if (request.signal?.aborted) {
        cancel();
        await cancellation;
        throw abortReason(request.signal);
      }
      const snapshot = await deps.catalog.get(jobId);
      if (!snapshot) throw new Error("Submitted PDF job disappeared from Activity.");

      if (!isTerminal(snapshot.state)) {
        const phase = phaseOf(snapshot);
        if (phase !== lastPhase) {
          lastPhase = phase;
          request.onPhase?.(phase);
        }
        if (
          snapshot.progress
          && snapshot.progress.stage === "fetch"
          && snapshot.revision !== lastProgressRevision
        ) {
          lastProgressRevision = snapshot.revision;
          request.onProgress?.({
            fetched: snapshot.progress.done,
            total: snapshot.progress.total ?? 0,
            ...(snapshot.progress.detail
              ? { currentTitle: snapshot.progress.detail }
              : {}),
          });
        }
        try {
          await sleep(pollIntervalMs, request.signal);
        } catch (error) {
          if (!request.signal?.aborted) throw error;
        }
        continue;
      }

      if (snapshot.state !== "succeeded") throw terminalFailure(snapshot);
      if (!snapshot.artifact || !snapshot.reportRef) {
        throw new Error("Succeeded PDF job is missing its retained result refs.");
      }
      const report = await deps.readReport(snapshot.reportRef);
      if (!report) throw new Error("Retained PDF report is unavailable.");
      request.onPhase?.("downloading");
      const artifact = await collectArtifact(snapshot, deps.bytes, request.signal);
      await deps.emit({
        filename: snapshot.artifact.filename,
        bytes: artifact,
        mediaType: snapshot.artifact.mediaType,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      await markDelivered(snapshot, deps);
      return report;
    }
  } finally {
    request.signal?.removeEventListener("abort", cancel);
    await cancellation;
  }
}

export function chromeExtensionPdfRunDeps(): RunSubmittedExtensionPdfExportDepsV1 {
  const submission = chromePdfExportSubmissionDeps();
  const catalog = submission.catalog as IndexedDbExportJobCatalog;
  const bytes = submission.bytes as IndexedDbExportByteStore;
  return {
    submit: (request) => submitExtensionPdfExport(request, submission),
    catalog,
    bytes,
    readReport: (ref) => readExtensionPdfExportReport(ref, { bytes }),
    emit: ({ filename, bytes: output, mediaType, signal }) =>
      downloadBytes({
        name: filename,
        bytes: output,
        mimeType: mediaType,
        ...(signal ? { signal } : {}),
      }),
  };
}
