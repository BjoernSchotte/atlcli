import type {
  DocxRenderReservationPortV1,
  DocxRenderReservationV1,
  PdfRenderReservationPortV1,
  PdfRenderReservationV1,
} from "@atlcli/export-wiring/jobs";
import { FileExportLock, type FileExportLockLease } from "./file-lock.js";

function assertAmounts(input: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(input)) {
    if (name === "signal") continue;
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

async function acquire(lock: FileExportLock, signal: AbortSignal, label: string): Promise<{ lease: FileExportLockLease; stop: () => Promise<void> }> {
  const lease = await lock.acquire({ signal, label }); let failure: unknown; let stopped = false;
  const interval = Math.max(1_000, Math.floor((lease.expiresAt - Date.now()) / 3));
  const timer = setInterval(() => { void lease.refresh().catch((error) => { failure = error; }); }, interval); timer.unref?.();
  return { lease, async stop() { if (stopped) return; stopped = true; clearInterval(timer); if (failure) throw failure; await lease.release(); } };
}

/** One physical lock is shared by both factories, preventing DOCX/PDF peak overlap. */
export function createFilePdfRenderReservationPort(lock: FileExportLock): PdfRenderReservationPortV1 {
  return { async acquire(input): Promise<PdfRenderReservationV1> {
    input.signal.throwIfAborted(); const held = await acquire(lock, input.signal, `pdf:${input.jobId}:${input.leaseEpoch}`);
    return { async reconcile(values) { values.signal.throwIfAborted(); assertAmounts(values); await held.lease.assertOwned(); }, release: held.stop };
  } };
}

export function createFileDocxRenderReservationPort(lock: FileExportLock): DocxRenderReservationPortV1 {
  return { async acquire(input): Promise<DocxRenderReservationV1> {
    input.signal.throwIfAborted(); const held = await acquire(lock, input.signal, `docx:${input.jobId}:${input.leaseEpoch}`);
    return { async reconcile(values) { values.signal.throwIfAborted(); assertAmounts(values); await held.lease.assertOwned(); }, release: held.stop };
  } };
}
