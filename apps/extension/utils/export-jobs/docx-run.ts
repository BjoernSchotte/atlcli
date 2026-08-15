import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import type { ExportReport } from "@atlcli/docx/browser";
import type { PdfBytesHandle } from "@atlcli/pdf/browser";
import { downloadBytes } from "../download.js";
import { collectArtifactHandleV1 } from "./artifact-delivery.js";
import type {
  DocxExportRequest,
  ExportPhase,
} from "../ports/export.js";
import {
  ExtensionExportCatalogError,
  IndexedDbExportJobCatalog,
} from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import { readExtensionDocxExportReport } from "./docx-executor-store.js";
import {
  chromeDocxExportSubmissionDeps,
  submitExtensionDocxExport,
  type SubmittedExtensionDocxExportV1,
} from "./docx-submit.js";

const TERMINAL: ReadonlySet<ExportJobSnapshotV1["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const);

function isTerminal(state: ExportJobSnapshotV1["state"]): boolean {
  return TERMINAL.has(state);
}

export interface RunSubmittedExtensionDocxExportDepsV1 {
  submit(request: DocxExportRequest): Promise<SubmittedExtensionDocxExportV1>;
  catalog: Pick<
    IndexedDbExportJobCatalog,
    "get" | "compareAndSet" | "deliver"
  >;
  bytes: Pick<IndexedDbExportByteStore, "read">;
  readReport(ref: string): Promise<ExportReport | undefined>;
  emit(input: {
    filename: string;
    bytes: PdfBytesHandle;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException("DOCX export was cancelled.", "AbortError");
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
  deps: Pick<RunSubmittedExtensionDocxExportDepsV1, "catalog" | "now">,
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
  throw new Error("DOCX cancellation could not win a concurrent job transition.");
}

function collectArtifact(
  snapshot: ExportJobSnapshotV1,
  bytes: Pick<IndexedDbExportByteStore, "read">,
  signal?: AbortSignal,
): Promise<PdfBytesHandle> {
  if (!snapshot.artifact) throw new Error("Succeeded DOCX job has no retained artifact.");
  // Blob-backed handle instead of one panel-heap Uint8Array (issue #118
  // Phase 0.5); the download anchor reuses the SAME Blob.
  return collectArtifactHandleV1(bytes.read(snapshot.artifact.ref, { signal }), {
    mediaType: snapshot.artifact.mediaType,
    expectedByteLength: snapshot.artifact.byteLength,
    ...(signal ? { signal } : {}),
  });
}

async function markDelivered(
  snapshot: ExportJobSnapshotV1,
  deps: Pick<RunSubmittedExtensionDocxExportDepsV1, "catalog" | "now">,
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
    return new DOMException("DOCX export was cancelled.", "AbortError");
  }
  return new Error(
    snapshot.error?.message
      ?? `DOCX export ended as ${snapshot.state}.`,
  );
}

export async function runSubmittedExtensionDocxExport(
  request: DocxExportRequest,
  deps: RunSubmittedExtensionDocxExportDepsV1,
): Promise<ExportReport> {
  request.signal?.throwIfAborted();
  const submitted = await deps.submit(request);
  const jobId = submitted.snapshot.id;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
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
      if (!snapshot) throw new Error("Submitted DOCX job disappeared from Activity.");

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
        throw new Error("Succeeded DOCX job is missing its retained result refs.");
      }
      const report = await deps.readReport(snapshot.reportRef);
      if (!report) throw new Error("Retained DOCX report is unavailable.");
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

export function chromeExtensionDocxRunDeps():
RunSubmittedExtensionDocxExportDepsV1 {
  const submission = chromeDocxExportSubmissionDeps();
  return {
    submit: (request) => submitExtensionDocxExport(request, submission),
    catalog: submission.catalog as IndexedDbExportJobCatalog,
    bytes: new IndexedDbExportByteStore(),
    readReport: (ref) => readExtensionDocxExportReport(ref),
    emit: async ({ filename, bytes, mediaType, signal }) => {
      await downloadBytes({
        name: filename,
        bytes,
        mimeType: mediaType,
        ...(signal ? { signal } : {}),
      });
    },
  };
}
