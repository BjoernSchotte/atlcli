import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import {
  IndexedDbExportJobCatalog,
  recoverAndClaimExtensionExportJob,
} from "./catalog.js";

export interface ExtensionExportQueueRunnerOptionsV1 {
  catalog: IndexedDbExportJobCatalog;
  bytes: IndexedDbExportByteStore;
  execute(claimed: ExportJobSnapshotV1): Promise<unknown>;
  ownerId?: string;
  leaseDurationMs?: number;
  now?: () => number;
  onExecutionError?: (error: unknown, jobId: string) => void;
  onSettled?: (jobId: string) => void | Promise<void>;
}

export interface ExtensionExportQueueRunnerV1 {
  startup(): Promise<void>;
  wake(
    jobIds?: string[],
    options?: { resumeWaiting?: boolean },
  ): Promise<string | undefined>;
  activeJobId(): string | undefined;
}

/**
 * Productive offscreen queue pump.
 *
 * `wake` claims at most one job and returns before its executor settles. The
 * active promise remains owned by this offscreen context; its `finally` starts
 * the next durable job, so panel/message lifetime never participates.
 */
export function createExtensionExportQueueRunner(
  options: ExtensionExportQueueRunnerOptionsV1,
): ExtensionExportQueueRunnerV1 {
  const ownerId = options.ownerId ?? `offscreen:${crypto.randomUUID()}`;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const now = options.now ?? Date.now;
  let startup: Promise<void> | undefined;
  let claiming: Promise<string | undefined> | undefined;
  let active: { jobId: string; execution: Promise<void> } | undefined;

  const ensureStartup = (): Promise<void> => {
    startup ??= options.bytes.recoverIncompleteWrites()
      .then(() => undefined)
      .catch((error) => {
        startup = undefined;
        throw error;
      });
    return startup;
  };

  const startExecution = (claimed: ExportJobSnapshotV1): void => {
    const execution = Promise.resolve()
      .then(() => options.execute(claimed))
      .then(() => undefined)
      .catch((error) => {
        options.onExecutionError?.(error, claimed.id);
      })
      .finally(async () => {
        if (active?.execution === execution) active = undefined;
        await options.onSettled?.(claimed.id);
        queueMicrotask(() => {
          void wake().catch((error) => options.onExecutionError?.(error, claimed.id));
        });
      });
    active = { jobId: claimed.id, execution };
  };

  const claimAndStart = async (
    jobIds?: string[],
    wakeOptions?: { resumeWaiting?: boolean },
  ): Promise<string | undefined> => {
    await ensureStartup();
    if (active) return undefined;
    const claimed = await recoverAndClaimExtensionExportJob(options.catalog, {
      now: now(),
      ownerId,
      leaseDurationMs,
      ...(jobIds ? { ids: jobIds } : {}),
      ...(jobIds && wakeOptions?.resumeWaiting
        ? { resumeWaitingIds: jobIds }
        : {}),
    });
    if (!claimed) return undefined;
    startExecution(claimed);
    return claimed.id;
  };

  const wake = (
    jobIds?: string[],
    wakeOptions?: { resumeWaiting?: boolean },
  ): Promise<string | undefined> => {
    if (active || claiming) return Promise.resolve(undefined);
    const operation = claimAndStart(jobIds, wakeOptions);
    claiming = operation;
    const clearClaim = (): void => {
      if (claiming === operation) claiming = undefined;
    };
    void operation.then(clearClaim, clearClaim);
    return operation;
  };

  return {
    startup: ensureStartup,
    wake,
    activeJobId: () => active?.jobId,
  };
}
