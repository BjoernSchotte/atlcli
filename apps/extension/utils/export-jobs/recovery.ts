import { IndexedDbExportByteStore, type IndexedDbExportByteStoreOptions } from "./chunk-store.js";
import {
  IndexedDbExportJobCatalog,
  recoverAndClaimExtensionExportJob,
  type ExtensionExportCatalogOptions,
} from "./catalog.js";

export interface ExtensionQueueFoundationOptions
  extends ExtensionExportCatalogOptions,
    IndexedDbExportByteStoreOptions {
  ownerId?: string;
  leaseDurationMs?: number;
}

export interface ExtensionQueueFoundation {
  startup(): Promise<void>;
  wake(jobIds?: string[]): Promise<string | undefined>;
}

/**
 * Offscreen-owned recovery/claim foundation. Engines are deliberately absent
 * until PR-G/PR-H; this slice proves persistence, reconstruction and fencing.
 */
export function createExtensionQueueFoundation(
  options: ExtensionQueueFoundationOptions = {},
): ExtensionQueueFoundation {
  const catalog = new IndexedDbExportJobCatalog(options);
  const bytes = new IndexedDbExportByteStore(options);
  const ownerId = options.ownerId ?? `offscreen:${crypto.randomUUID()}`;
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  let startup: Promise<void> | undefined;
  return {
    startup(): Promise<void> {
      startup ??= bytes.recoverIncompleteWrites()
        .then(() => undefined)
        .catch((error) => {
          // A blocked upgrade or transient IDB failure must not poison this
          // offscreen context forever. The next wake retries startup.
          startup = undefined;
          throw error;
        });
      return startup;
    },
    async wake(jobIds?: string[]): Promise<string | undefined> {
      await this.startup();
      const claimed = await recoverAndClaimExtensionExportJob(catalog, {
        now: (options.now ?? Date.now)(),
        ownerId,
        leaseDurationMs,
        ...(jobIds ? { ids: jobIds } : {}),
      });
      return claimed?.id;
    },
  };
}
