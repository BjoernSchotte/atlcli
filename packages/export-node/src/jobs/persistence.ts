import { join } from "node:path";
import type { SpoolWriteLimitsV1 } from "@atlcli/export-jobs";
import { exportJobStateDir } from "./paths.js";
import { FileExportArtifactStore } from "./file-artifact-store.js";
import { FileExportJobStore, type FileExportQuarantinedRecordV1 } from "./file-job-store.js";
import { FileExportLock } from "./file-lock.js";
import { FileExportSpoolStore } from "./file-spool-store.js";
import { createFileDocxReadyToRenderStore, createFilePdfReadyToRenderStore, createFileDocxExportResultStore, createFilePdfExportResultStore } from "./executor-stores.js";
import { createFileDocxRenderReservationPort, createFilePdfRenderReservationPort } from "./render-reservation.js";

export interface FileExportJobPersistenceOptionsV1 {
  rootDir?: string;
  now?: () => number;
  lockTtlMs?: number;
  maxArtifactBytes?: number;
  maxTotalArtifactBytes?: number;
  spoolLimits?: SpoolWriteLimitsV1;
  /** Override the default stderr warning emitted when unreadable journal records are quarantined. */
  onQuarantine?: (records: readonly FileExportQuarantinedRecordV1[]) => void;
}

function warnQuarantined(records: readonly FileExportQuarantinedRecordV1[]): void {
  const plural = records.length === 1 ? "" : "s";
  process.stderr.write(
    `warn: quarantined ${records.length} export job record${plural} written by another atlcli version ` +
    `(${records[0]!.reason}); the record${plural} stay${records.length === 1 ? "s" : ""} in the journal and new exports continue.\n`,
  );
}

export interface FileExportJobPersistenceV1 {
  rootDir: string;
  jobs: FileExportJobStore;
  spool: FileExportSpoolStore;
  artifacts: FileExportArtifactStore;
  /** Shared by DOCX and PDF; acquiring it serializes their heavy peaks. */
  heavyRenderLock: FileExportLock;
  spoolLimits: SpoolWriteLimitsV1;
  pdfReadyToRender: ReturnType<typeof createFilePdfReadyToRenderStore>;
  docxReadyToRender: ReturnType<typeof createFileDocxReadyToRenderStore>;
  pdfResults: ReturnType<typeof createFilePdfExportResultStore>;
  docxResults: ReturnType<typeof createFileDocxExportResultStore>;
  pdfRenderReservations: ReturnType<typeof createFilePdfRenderReservationPort>;
  docxRenderReservations: ReturnType<typeof createFileDocxRenderReservationPort>;
}

export function createFileExportJobPersistence(
  options: FileExportJobPersistenceOptionsV1 = {},
): FileExportJobPersistenceV1 {
  const rootDir = options.rootDir ?? exportJobStateDir();
  const artifacts = new FileExportArtifactStore(rootDir, {
    now: options.now,
    lockTtlMs: options.lockTtlMs,
    maxArtifactBytes: options.maxArtifactBytes,
    maxTotalBytes: options.maxTotalArtifactBytes,
  });
  const spool = new FileExportSpoolStore(rootDir, { now: options.now, lockTtlMs: options.lockTtlMs });
  const jobs = new FileExportJobStore(rootDir, { now: options.now, lockTtlMs: options.lockTtlMs, artifactFinalizer: artifacts, onQuarantine: options.onQuarantine ?? warnQuarantined });
  const heavyRenderLock = new FileExportLock(join(rootDir, "locks", "heavy-render.lock"), { ttlMs: Math.max(options.lockTtlMs ?? 30_000, 120_000), now: options.now });
  const spoolLimits = options.spoolLimits ?? { maxObjectBytes: 256 * 1024 * 1024, maxJobBytes: 2 * 1024 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 };
  const stores = { jobs, spool, rootDir, spoolLimits, now: options.now };
  return { rootDir, jobs, spool, artifacts, heavyRenderLock, spoolLimits,
    pdfReadyToRender: createFilePdfReadyToRenderStore(stores), docxReadyToRender: createFileDocxReadyToRenderStore(stores),
    pdfResults: createFilePdfExportResultStore(stores), docxResults: createFileDocxExportResultStore(stores),
    pdfRenderReservations: createFilePdfRenderReservationPort(heavyRenderLock), docxRenderReservations: createFileDocxRenderReservationPort(heavyRenderLock) };
}
