/**
 * Sync Database Adapter module.
 *
 * Provides an abstract storage layer for sync operations with multiple backends:
 * - SQLite (default): Zero-config, high-performance, portable
 * - JSON (fallback): For debugging and environments without SQLite
 * - PostgreSQL (future): For teams and large-scale deployments
 *
 * Usage:
 *
 * ```typescript
 * import { createSyncDb, needsMigration, migrateFromStateJson } from '@atlcli/confluence';
 *
 * // Create adapter (auto-detects and migrates from state.json)
 * const adapter = await createSyncDb(atlcliDir);
 *
 * // Use adapter
 * const page = await adapter.getPage(pageId);
 * await adapter.upsertPage(page);
 *
 * // Close when done
 * await adapter.close();
 * ```
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SyncDbAdapter, SyncDbAdapterConfig, AdapterType } from "./types.js";
import { SqliteAdapter } from "./sqlite-adapter.js";
import { JsonAdapter } from "./json-adapter.js";
import {
  needsMigration,
  hasLegacyStateJson,
  migrateFromStateJson,
  type MigrationResult,
} from "./migrate-state-json.js";

// Re-export types (excluding SyncState which is already exported from atlcli-dir)
export {
  type InaccessibleReason,
  type ContentStatus,
  // SyncState is imported from atlcli-dir in types.ts, don't re-export to avoid conflict
  type AdapterType,
  type PageRecord,
  type AttachmentRecord,
  type LinkRecord,
  type UserRecord,
  type LabelRecord,
  type ContributorRecord,
  type ContentPropertyRecord,
  type PageFilter,
  type SyncDbExport,
  type SimilarityResult,
  type EmbeddingRecord,
  type SyncDbAdapter,
  type SqliteAdapterConfig,
  type PostgresAdapterConfig,
  type JsonAdapterConfig,
  type SyncDbAdapterConfig,
  type PageRecordUpdate,
  type AttachmentRecordUpdate,
  createPageRecord,
  createAttachmentRecord,
} from "./types.js";
export { SqliteAdapter } from "./sqlite-adapter.js";
export { JsonAdapter } from "./json-adapter.js";
export {
  needsMigration,
  hasLegacyStateJson,
  migrateFromStateJson,
  restoreFromBackup,
  removeBackup,
  convertLegacyStateToExport,
  type MigrationResult,
} from "./migrate-state-json.js";
export {
  CURRENT_SCHEMA_VERSION,
  getCurrentSchemaVersion,
  runMigrations,
  type Migration,
} from "./migrations.js";

/**
 * Options for creating a sync database adapter.
 */
export interface CreateSyncDbOptions {
  /**
   * Adapter type to use. Defaults to 'sqlite'.
   */
  adapter?: AdapterType;

  /**
   * Automatically migrate from state.json if present. Defaults to true.
   */
  autoMigrate?: boolean;

  /**
   * Enable WAL mode for SQLite (better concurrent access). Defaults to true.
   */
  walMode?: boolean;

  /**
   * Enable vector support via sqlite-vec. Defaults to false.
   */
  enableVectors?: boolean;

  /**
   * Custom SQLite library path (macOS only, for sqlite-vec support).
   */
  customSqlitePath?: string;
}

/**
 * Create a sync database adapter for the given .atlcli directory.
 *
 * By default:
 * - Uses SQLite adapter
 * - Auto-migrates from state.json if present
 * - Enables WAL mode for better concurrent access
 *
 * @param atlcliDir Path to .atlcli directory (e.g., '/path/to/project/.atlcli')
 * @param options Optional configuration
 * @returns Initialized adapter ready for use
 *
 * @example
 * ```typescript
 * const adapter = await createSyncDb('/path/to/project/.atlcli');
 * const pages = await adapter.listPages();
 * await adapter.close();
 * ```
 */
export async function createSyncDb(
  atlcliDir: string,
  options: CreateSyncDbOptions = {}
): Promise<SyncDbAdapter> {
  const {
    adapter: adapterType = "sqlite",
    autoMigrate = true,
    walMode = true,
    enableVectors = false,
    customSqlitePath,
  } = options;

  let adapter: SyncDbAdapter;

  switch (adapterType) {
    case "sqlite": {
      const dbPath = join(atlcliDir, "sync.db");
      adapter = new SqliteAdapter({
        dbPath,
        walMode,
        enableVectors,
        customSqlitePath,
      });
      break;
    }
    case "json": {
      adapter = new JsonAdapter({ atlcliDir });
      break;
    }
    case "postgres": {
      throw new Error("PostgreSQL adapter is not yet implemented");
    }
    default:
      throw new Error(`Unknown adapter type: ${adapterType}`);
  }

  // Check for migration BEFORE initializing (which creates sync.db)
  // This must be done before init() because init() creates the sync.db file
  const shouldMigrate =
    autoMigrate && adapterType === "sqlite" && needsMigration(atlcliDir);

  // Initialize adapter (creates sync.db if sqlite)
  await adapter.init();

  // Now migrate if needed (sync.db now exists but is empty)
  if (shouldMigrate) {
    const result = await migrateFromStateJson(atlcliDir, adapter);
    if (!result.migrated && result.reason !== "no-state-json") {
      console.warn(
        `Warning: Failed to migrate from state.json: ${result.reason}. ${result.error || ""}`
      );
    }
  }

  return adapter;
}

/**
 * Create a sync database adapter from explicit configuration.
 *
 * Use this when you need full control over adapter configuration.
 *
 * @param config Adapter configuration
 * @returns Initialized adapter ready for use
 *
 * @example
 * ```typescript
 * const adapter = await createSyncDbFromConfig({
 *   type: 'sqlite',
 *   config: { dbPath: '/tmp/test.db', walMode: true }
 * });
 * ```
 */
export async function createSyncDbFromConfig(
  config: SyncDbAdapterConfig
): Promise<SyncDbAdapter> {
  let adapter: SyncDbAdapter;

  switch (config.type) {
    case "sqlite":
      adapter = new SqliteAdapter(config.config);
      break;
    case "json":
      adapter = new JsonAdapter(config.config);
      break;
    case "postgres":
      throw new Error("PostgreSQL adapter is not yet implemented");
    default:
      throw new Error(`Unknown adapter type: ${(config as any).type}`);
  }

  await adapter.init();
  return adapter;
}

/**
 * Check if a .atlcli directory has a sync database.
 */
export function hasSyncDb(atlcliDir: string): boolean {
  return (
    existsSync(join(atlcliDir, "sync.db")) ||
    existsSync(join(atlcliDir, "sync-state.json"))
  );
}

/**
 * Get the storage type being used in a .atlcli directory.
 */
export function getStorageType(
  atlcliDir: string
): "sqlite" | "json" | "legacy" | "none" {
  if (existsSync(join(atlcliDir, "sync.db"))) {
    return "sqlite";
  }
  if (existsSync(join(atlcliDir, "sync-state.json"))) {
    return "json";
  }
  if (existsSync(join(atlcliDir, "state.json"))) {
    return "legacy";
  }
  return "none";
}
