/**
 * The side panel's observer of one durable export job, shared by both formats.
 *
 * `run()` submits once and then only watches the catalog: the executor lives
 * in the offscreen document and owns the work. Losing the panel destroys this
 * promise but cannot cancel anything.
 */
import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import type { PdfBytesHandle } from "@atlcli/pdf/browser";
import { isExportJobsChanged } from "../messages.js";
import type { ExportPhase, PdfExportRequest } from "../ports/export.js";
import { collectArtifactHandleV1 } from "./artifact-delivery.js";
import {
  ExtensionExportCatalogError,
  type IndexedDbExportJobCatalog,
} from "./catalog.js";
import type { IndexedDbExportByteStore } from "./chunk-store.js";

export type ExportRunLabel = "PDF" | "DOCX";

/** Catalog read cadence while the job is queued or running. */
export const EXPORT_RUN_POLL_MS = 200;
/**
 * Cadence while the job is parked in `waiting` (sign-in, rate limit): nothing
 * progresses until it is woken, and a wake or settlement announces itself.
 */
export const EXPORT_RUN_WAITING_POLL_MS = 1_000;

type ObservedRequest = Pick<PdfExportRequest, "signal" | "onPhase" | "onProgress">;

export interface ObserveSubmittedExportDepsV1<Request, Report> {
  submit(request: Request): Promise<{ snapshot: ExportJobSnapshotV1 }>;
  catalog: Pick<
    IndexedDbExportJobCatalog,
    "get" | "compareAndSet" | "deliver"
  >;
  bytes: Pick<IndexedDbExportByteStore, "read">;
  readReport(ref: string): Promise<Report | undefined>;
  emit(input: {
    filename: string;
    bytes: PdfBytesHandle;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Push hint that a job changed; ends the current wait early. */
  onChanged?(listener: (jobId: string) => void): () => void;
}

/** Subscribe to the `jobs:changed` broadcast of the queue and the service worker. */
export function chromeExportJobsChanged(listener: (jobId: string) => void): () => void {
  const onMessage = (message: unknown): undefined => {
    if (isExportJobsChanged(message)) listener(message.jobId);
    return undefined;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}

const TERMINAL: ReadonlySet<ExportJobSnapshotV1["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const);

function isTerminal(state: ExportJobSnapshotV1["state"]): boolean {
  return TERMINAL.has(state);
}

function abortReason(label: ExportRunLabel, signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException(`${label} export was cancelled.`, "AbortError");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      reject(signal!.reason);
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
  label: ExportRunLabel,
  jobId: string,
  deps: Pick<ObserveSubmittedExportDepsV1<never, never>, "catalog" | "now">,
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
  throw new Error(`${label} cancellation could not win a concurrent job transition.`);
}

function collectArtifact(
  label: ExportRunLabel,
  snapshot: ExportJobSnapshotV1,
  bytes: Pick<IndexedDbExportByteStore, "read">,
  signal?: AbortSignal,
): Promise<PdfBytesHandle> {
  if (!snapshot.artifact) throw new Error(`Succeeded ${label} job has no retained artifact.`);
  // Blob-backed handle instead of one panel-heap Uint8Array (issue #118
  // Phase 0.5): the anchor download reuses the SAME Blob, so the artifact
  // never materializes in the panel heap at all.
  return collectArtifactHandleV1(bytes.read(snapshot.artifact.ref, { signal }), {
    mediaType: snapshot.artifact.mediaType,
    expectedByteLength: snapshot.artifact.byteLength,
    ...(signal ? { signal } : {}),
  });
}

async function markDelivered(
  snapshot: ExportJobSnapshotV1,
  deps: Pick<ObserveSubmittedExportDepsV1<never, never>, "catalog" | "now">,
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

function terminalFailure(label: ExportRunLabel, snapshot: ExportJobSnapshotV1): Error {
  if (snapshot.state === "cancelled") {
    return new DOMException(`${label} export was cancelled.`, "AbortError");
  }
  return new Error(
    snapshot.error?.message
      ?? `${label} export ended as ${snapshot.state}.`,
  );
}

/** Submit once, then observe the durable outer job until it settles. */
export async function observeSubmittedExport<Request extends ObservedRequest, Report>(
  label: ExportRunLabel,
  request: Request,
  deps: ObserveSubmittedExportDepsV1<Request, Report>,
): Promise<Report> {
  request.signal?.throwIfAborted();
  const submitted = await deps.submit(request);
  const jobId = submitted.snapshot.id;
  const sleep = deps.sleep ?? defaultSleep;
  // Set while the loop is waiting; a change hint for this job ends the wait.
  let wake: (() => void) | undefined;
  const stopListening = deps.onChanged?.((changed) => {
    if (changed === jobId) wake?.();
  });
  let cancellation: Promise<void> | undefined;
  let lastPhase: ExportPhase | undefined;
  let lastProgressRevision = -1;
  const cancel = (): void => {
    cancellation ??= requestCancellation(label, jobId, deps);
  };
  request.signal?.addEventListener("abort", cancel, { once: true });

  try {
    while (true) {
      if (request.signal?.aborted) {
        cancel();
        await cancellation;
        throw abortReason(label, request.signal);
      }
      const snapshot = await deps.catalog.get(jobId);
      if (!snapshot) throw new Error(`Submitted ${label} job disappeared from Activity.`);

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
        const hint = new AbortController();
        wake = () => hint.abort();
        try {
          await sleep(
            deps.pollIntervalMs ?? (snapshot.state === "waiting"
              ? EXPORT_RUN_WAITING_POLL_MS
              : EXPORT_RUN_POLL_MS),
            request.signal
              ? AbortSignal.any([request.signal, hint.signal])
              : hint.signal,
          );
        } catch (error) {
          if (!request.signal?.aborted && !hint.signal.aborted) throw error;
        } finally {
          wake = undefined;
        }
        continue;
      }

      if (snapshot.state !== "succeeded") throw terminalFailure(label, snapshot);
      if (!snapshot.artifact || !snapshot.reportRef) {
        throw new Error(`Succeeded ${label} job is missing its retained result refs.`);
      }
      const report = await deps.readReport(snapshot.reportRef);
      if (!report) throw new Error(`Retained ${label} report is unavailable.`);
      request.onPhase?.("downloading");
      const artifact = await collectArtifact(label, snapshot, deps.bytes, request.signal);
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
    stopListening?.();
    request.signal?.removeEventListener("abort", cancel);
    await cancellation;
  }
}
