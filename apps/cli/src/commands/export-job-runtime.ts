import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExportJobExecutor,
  ExportJobDerivationV1,
  ExportJobRequestV1,
  ExportJobSnapshotV1,
} from "@atlcli/export-jobs";
import {
  createFileExportJobPersistence,
  deliverFileExportArtifact,
  readFileExportReport,
  reconcileStaleExportJobs,
  runClaimedFileExportJob,
  type FileExportJobPersistenceV1,
} from "@atlcli/export-node";
import {
  createPdfExportJobExecutor,
  createTypescriptDocxExportJobExecutor,
  type CreatePdfExportJobExecutorOptionsV1,
  type CreateTypescriptDocxExportJobExecutorOptionsV1,
} from "@atlcli/export-wiring/jobs";
import {
  watchExportJobV1,
  type ExportJobMonitorModeV1,
  type ExportJobMonitorWriterV1,
} from "./export-job-monitor.js";

export interface OrdinaryExportJobRuntimeResultV1 {
  snapshot: ExportJobSnapshotV1;
  /** Full engine report loaded only after its durable result ref was finalized. */
  report?: unknown;
}

export interface OrdinaryExportProjectionV1<T> {
  schema: "atlcli.cli-export-projection/1";
  jobId: string;
  format: "docx" | "pdf";
  value: T;
}

export interface RunOrdinaryExportJobOptionsV1<Request extends ExportJobRequestV1> {
  /** Must still describe the unresolved source; no Confluence read may precede this call. */
  request: Request;
  /** Required when the request row was derived by Retry/Run again. */
  derivedFrom?: ExportJobDerivationV1;
  executor: ExportJobExecutor<Request>;
  persistence?: FileExportJobPersistenceV1;
  ownerId?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  /** Test/host hook invoked after the durable create and before reconciliation or any claim. */
  onDurableCreate?: (snapshot: ExportJobSnapshotV1) => void | Promise<void>;
  /** Optional report-ref adapter. The file host defaults to its durable JSON report path. */
  loadReport?: (ref: string) => Promise<unknown>;
  /** Resolve directory-style targets after the executor has named the artifact. */
  deliveryTarget?: (snapshot: ExportJobSnapshotV1) => string;
  /** CLI activity projection; execution remains correct when no monitor is attached. */
  monitor?: { mode: ExportJobMonitorModeV1; writer: ExportJobMonitorWriterV1 };
}

type PdfCliExecutorOptionsV1 = Omit<
  CreatePdfExportJobExecutorOptionsV1,
  "readyToRender" | "renderReservations" | "results"
>;
type DocxCliExecutorOptionsV1 = Omit<
  CreateTypescriptDocxExportJobExecutorOptionsV1,
  "readyToRender" | "renderReservations" | "results"
>;

/** Bind the host-neutral PR-C executor to the one real Node persistence set. */
export function createOrdinaryPdfExecutorV1(
  persistence: FileExportJobPersistenceV1,
  options: PdfCliExecutorOptionsV1,
) {
  return createPdfExportJobExecutor({
    ...options,
    readyToRender: persistence.pdfReadyToRender,
    renderReservations: persistence.pdfRenderReservations,
    results: persistence.pdfResults,
  });
}

/** Bind the host-neutral PR-D executor to the same Node persistence/heavy lock. */
export function createOrdinaryDocxExecutorV1(
  persistence: FileExportJobPersistenceV1,
  options: DocxCliExecutorOptionsV1,
) {
  return createTypescriptDocxExportJobExecutor({
    ...options,
    readyToRender: persistence.docxReadyToRender,
    renderReservations: persistence.docxRenderReservations,
    results: persistence.docxResults,
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function projectionPath(persistence: FileExportJobPersistenceV1, jobId: string): string {
  const key = createHash("sha256").update(jobId).digest("hex");
  return join(persistence.rootDir, "cli-projections", `${key}.json`);
}

/**
 * Persist the small CLI-facing report projection before the executor creates
 * its ready-to-render checkpoint. Page bodies and credentials must never be
 * placed here; those remain in the protected executor/spool stores.
 */
export async function writeOrdinaryExportProjectionV1<T>(
  persistence: FileExportJobPersistenceV1,
  projection: OrdinaryExportProjectionV1<T>,
): Promise<void> {
  const directory = join(persistence.rootDir, "cli-projections");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = projectionPath(persistence, projection.jobId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(projection)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Read and minimally authenticate a CLI report projection after restart. */
export async function readOrdinaryExportProjectionV1<T>(
  persistence: FileExportJobPersistenceV1,
  jobId: string,
  format: "docx" | "pdf",
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(projectionPath(persistence, jobId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as { schema?: unknown }).schema !== "atlcli.cli-export-projection/1" ||
    (parsed as { jobId?: unknown }).jobId !== jobId ||
    (parsed as { format?: unknown }).format !== format ||
    !("value" in parsed)
  ) {
    throw new Error(`Invalid CLI export projection for job ${jobId}.`);
  }
  return (parsed as OrdinaryExportProjectionV1<T>).value;
}

function isTerminal(snapshot: ExportJobSnapshotV1): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.state);
}

async function targetMatchesArtifact(
  path: string,
  artifact: NonNullable<ExportJobSnapshotV1["artifact"]>,
): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(path); } catch { return false; }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.byteLength) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex") === artifact.sha256.toLowerCase();
}

async function markDelivered(
  persistence: FileExportJobPersistenceV1,
  jobId: string,
  at: number,
): Promise<ExportJobSnapshotV1> {
  for (;;) {
    const current = await persistence.jobs.get(jobId);
    if (!current) throw new Error(`Export job disappeared during delivery: ${jobId}`);
    if (current.deliveredAt !== undefined) return current;
    try { return await persistence.jobs.deliver(jobId, current.revision, at); }
    catch (error) {
      const latest = await persistence.jobs.get(jobId);
      if (latest?.deliveredAt !== undefined) return latest;
      if (latest?.revision !== current.revision) continue;
      throw error;
    }
  }
}

async function cancelUnclaimed(
  persistence: FileExportJobPersistenceV1,
  jobId: string,
  now: number,
): Promise<void> {
  const snapshot = await persistence.jobs.get(jobId);
  if (!snapshot || isTerminal(snapshot)) return;
  if (snapshot.state === "queued" || snapshot.state === "waiting") {
    await persistence.jobs.compareAndSet({
      kind: "transition",
      id: snapshot.id,
      expectedRevision: snapshot.revision,
      to: "cancelled",
      at: now,
    });
  }
  // A running owner observes cancellation through its durable polling context.
  // This process must not forge that owner's lease epoch.
  if (snapshot.state === "running") {
    await persistence.jobs.compareAndSet({
      kind: "transition",
      id: snapshot.id,
      expectedRevision: snapshot.revision,
      leaseEpoch: snapshot.leaseEpoch,
      to: "cancelling",
      at: now,
    });
  }
}

/**
 * Queue-backed compatibility shell for the ordinary blocking CLI command.
 *
 * Ordering is the critical contract: the unresolved request is durably created
 * before reconciliation, claim, executor source resolution, or any Confluence
 * API access. The command may execute earlier work of the same format while it
 * waits; atomic claim/fencing guarantees another process cannot double-render.
 */
export async function runOrdinaryExportJobV1<Request extends ExportJobRequestV1>(
  options: RunOrdinaryExportJobOptionsV1<Request>,
): Promise<OrdinaryExportJobRuntimeResultV1> {
  if (options.executor.format !== options.request.format) {
    throw new Error("Ordinary export executor format does not match its request.");
  }
  if (options.request.output.policy !== "path" || !options.request.output.targetRef) {
    throw new Error("Ordinary CLI exports require a durable path output target.");
  }

  const persistence = options.persistence ?? createFileExportJobPersistence();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const ownerId = options.ownerId ?? `cli:${process.pid}:${randomUUID()}`;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("Export job poll interval must be a non-negative finite number.");
  }

  // The first persistent mutation. Nothing below can resolve the source until
  // this succeeds, which is the crash-safety boundary the ordinary command did
  // not have before jobs.
  const created = await persistence.jobs.create({
    request: options.request,
    ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
  });
  await options.onDurableCreate?.(created);

  const monitorAbort = new AbortController();
  let reachedTerminal = false;
  const monitor = options.monitor
    ? watchExportJobV1({
        jobs: persistence.jobs,
        jobId: created.id,
        mode: options.monitor.mode,
        writer: options.monitor.writer,
        pollIntervalMs,
        signal: monitorAbort.signal,
      })
    : undefined;

  const abort = new AbortController();
  let cancellation = Promise.resolve();
  const requestCancellation = (reason: unknown): void => {
    if (abort.signal.aborted) return;
    // Persist cancellation before aborting the executor signal. This ordering
    // prevents a fast AbortError from being classified as `failed` while the
    // durable row still says `running`.
    cancellation = cancellation
      .then(() => cancelUnclaimed(persistence, created.id, now()))
      .finally(() => abort.abort(reason));
  };
  const forwardAbort = (): void => requestCancellation(
    options.signal?.reason ?? new DOMException("Export command was cancelled.", "AbortError"),
  );
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const onProcessSignal = (): void => requestCancellation(
    new DOMException("Export command was cancelled.", "AbortError"),
  );
  process.once("SIGINT", onProcessSignal);
  process.once("SIGTERM", onProcessSignal);

  try {
    await reconcileStaleExportJobs(
      persistence.jobs,
      { spool: persistence.spool, artifacts: persistence.artifacts },
      now(),
    );

    for (;;) {
      if (abort.signal.aborted) {
        await cancelUnclaimed(persistence, created.id, now());
      }

      const current = await persistence.jobs.get(created.id);
      if (!current) throw new Error(`Export job disappeared: ${created.id}`);
      if (isTerminal(current)) {
        let delivered = current;
        if (current.state === "succeeded" && current.deliveredAt === undefined) {
          if (!current.artifact) throw new Error("Succeeded export job has no finalized artifact.");
          const deliveryTarget = options.deliveryTarget?.(current) ??
            (options.request.output.targetKind === "directory"
              ? join(options.request.output.targetRef, current.artifact.filename)
              : options.request.output.targetRef);
          try {
            await deliverFileExportArtifact(
              persistence.artifacts,
              current.artifact,
              deliveryTarget,
              {
                overwriteExisting: options.request.output.overwriteExisting === true,
                ...(abort.signal.aborted ? {} : { signal: abort.signal }),
              },
            );
            delivered = await markDelivered(persistence, current.id, now());
          } catch (error) {
            // Covers both concurrent delivery and a process crash after the
            // atomic file commit but before `jobs.deliver`: only the exact
            // artifact length+digest is accepted as an idempotent prior write.
            if (!(await targetMatchesArtifact(deliveryTarget, current.artifact))) throw error;
            delivered = await markDelivered(persistence, current.id, now());
          }
        }
        const report = delivered.reportRef
          ? options.loadReport
            ? await options.loadReport(delivered.reportRef)
            : await readFileExportReport(persistence.jobs, delivered.reportRef)
          : undefined;
        reachedTerminal = true;
        await monitor;
        return { snapshot: delivered, ...(report !== undefined ? { report } : {}) };
      }

      if (abort.signal.aborted) {
        await sleep(pollIntervalMs);
        continue;
      }

      const claimed = await persistence.jobs.claimNext({
        ownerId,
        now: now(),
        leaseDurationMs,
        ids: [created.id],
        formats: [options.request.format],
        authRefs: [options.request.authRef],
      });
      if (!claimed) {
        await sleep(pollIntervalMs);
        continue;
      }
      const claimedRequest = await persistence.jobs.getRequest(claimed.requestRef);
      if (!claimedRequest) throw new Error(`Claimed export request is missing: ${claimed.requestRef}`);
      await runClaimedFileExportJob({
        claimed,
        jobs: persistence.jobs,
        spool: persistence.spool,
        artifacts: persistence.artifacts,
        spoolLimits: persistence.spoolLimits,
        executor: options.executor as ExportJobExecutor<ExportJobRequestV1>,
        leaseDurationMs,
        // SIGINT belongs to this invocation's job. If this process helps drain
        // an older same-format job first, do not cancel that unrelated owner.
        ...(claimed.id === created.id ? { signal: abort.signal } : {}),
        now,
      });
    }
  } finally {
    if (!reachedTerminal) monitorAbort.abort();
    await monitor?.catch((error) => {
      if (!monitorAbort.signal.aborted) throw error;
    });
    await cancellation;
    options.signal?.removeEventListener("abort", forwardAbort);
    process.removeListener("SIGINT", onProcessSignal);
    process.removeListener("SIGTERM", onProcessSignal);
  }
}
