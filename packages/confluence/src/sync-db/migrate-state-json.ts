/**
 * Migration from legacy state.json to SQLite sync database.
 *
 * This module handles automatic detection and migration of existing state.json
 * files to the new SQLite-based storage.
 */

import { existsSync } from "node:fs";
import { readFile, copyFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  SyncDbAdapter,
  PageRecord,
  AttachmentRecord,
  SyncDbExport,
} from "./types.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

/**
 * Legacy state.json structures (from atlcli-dir.ts)
 */
interface LegacyAttachmentState {
  attachmentId: string;
  filename: string;
  localPath: string;
  mediaType: string;
  fileSize: number;
  version: number;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  lastSyncedAt: string;
  syncState: string;
}

interface LegacyPageState {
  path: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: string;
  parentId: string | null;
  ancestors: string[];
  attachments?: Record<string, LegacyAttachmentState>;
  hasAttachments?: boolean;
}

interface LegacyState {
  schemaVersion: number;
  lastSync: string | null;
  pages: Record<string, LegacyPageState>;
  pathIndex: Record<string, string>;
}

/**
 * Result of migration operation.
 */
export interface MigrationResult {
  migrated: boolean;
  reason?:
    | "no-state-json"
    | "already-migrated"
    | "backup-failed"
    | "migration-failed";
  pagesCount?: number;
  attachmentsCount?: number;
  backupPath?: string;
  error?: string;
}

/**
 * Check if migration is needed.
 */
export function needsMigration(atlcliDir: string): boolean {
  const stateJsonPath = join(atlcliDir, "state.json");
  const syncDbPath = join(atlcliDir, "sync.db");

  // Migration needed if state.json exists and sync.db does not
  return existsSync(stateJsonPath) && !existsSync(syncDbPath);
}

/**
 * Check if state.json exists (for any migration-related checks).
 */
export function hasLegacyStateJson(atlcliDir: string): boolean {
  return existsSync(join(atlcliDir, "state.json"));
}

/**
 * Migrate from state.json to SQLite.
 *
 * Steps:
 * 1. Check if migration is needed
 * 2. Backup state.json to state.json.bak
 * 3. Convert legacy data to new format
 * 4. Import into target adapter
 * 5. Verify migration
 * 6. Remove original state.json (keep backup)
 */
export async function migrateFromStateJson(
  atlcliDir: string,
  targetAdapter: SyncDbAdapter
): Promise<MigrationResult> {
  const stateJsonPath = join(atlcliDir, "state.json");
  const backupPath = join(atlcliDir, "state.json.bak");

  // Check if state.json exists
  if (!existsSync(stateJsonPath)) {
    return { migrated: false, reason: "no-state-json" };
  }

  // Note: We don't check for sync.db existence here because:
  // 1. The caller (createSyncDb) checks needsMigration() BEFORE initializing the adapter
  // 2. The adapter is initialized (creating sync.db) before this function is called
  // 3. If this function is called, the caller has already determined migration is needed

  try {
    // Read existing state
    const content = await readFile(stateJsonPath, "utf-8");
    const legacyState = JSON.parse(content) as LegacyState;

    // Backup original
    try {
      await copyFile(stateJsonPath, backupPath);
    } catch (backupError) {
      return {
        migrated: false,
        reason: "backup-failed",
        error: String(backupError),
      };
    }

    // Convert to new format
    const exportData = convertLegacyStateToExport(legacyState);

    // Import into target adapter
    await targetAdapter.importFromJson(exportData);

    // Set migration metadata
    await targetAdapter.setMeta("migrated_from", "state.json");
    await targetAdapter.setMeta("migration_date", new Date().toISOString());
    if (legacyState.lastSync) {
      await targetAdapter.setMeta("last_sync", legacyState.lastSync);
    }

    // Verify migration
    const pageCount = await targetAdapter.countPages();
    const expectedPageCount = Object.keys(legacyState.pages).length;

    if (pageCount !== expectedPageCount) {
      // Rollback: restore backup
      await copyFile(backupPath, stateJsonPath);
      return {
        migrated: false,
        reason: "migration-failed",
        error: `Page count mismatch: expected ${expectedPageCount}, got ${pageCount}`,
      };
    }

    // Count attachments
    let attachmentsCount = 0;
    for (const page of Object.values(legacyState.pages)) {
      if (page.attachments) {
        attachmentsCount += Object.keys(page.attachments).length;
      }
    }

    // Remove original (keep backup)
    await unlink(stateJsonPath);

    return {
      migrated: true,
      pagesCount: pageCount,
      attachmentsCount,
      backupPath,
    };
  } catch (error) {
    // Attempt to restore backup if it exists
    if (existsSync(backupPath) && !existsSync(stateJsonPath)) {
      try {
        await copyFile(backupPath, stateJsonPath);
      } catch {
        // Best effort restoration
      }
    }

    return {
      migrated: false,
      reason: "migration-failed",
      error: String(error),
    };
  }
}

/**
 * Convert legacy state.json data to SyncDbExport format.
 */
export function convertLegacyStateToExport(state: LegacyState): SyncDbExport {
  const pages: PageRecord[] = [];
  const attachments: AttachmentRecord[] = [];
  const now = new Date().toISOString();

  for (const [pageId, pageState] of Object.entries(state.pages)) {
    // Convert page
    pages.push({
      pageId,
      path: pageState.path,
      title: pageState.title,
      spaceKey: pageState.spaceKey,
      version: pageState.version,
      lastSyncedAt: pageState.lastSyncedAt,
      localHash: pageState.localHash,
      remoteHash: pageState.remoteHash,
      baseHash: pageState.baseHash,
      syncState: pageState.syncState as PageRecord["syncState"],
      parentId: pageState.parentId ?? null,
      ancestors: pageState.ancestors || [],
      hasAttachments: pageState.hasAttachments ?? false,

      // New fields - set to defaults during migration
      // Will be populated with real data on next pull
      createdBy: null,
      createdAt: pageState.lastSyncedAt, // Best guess
      lastModifiedBy: null,
      lastModified: pageState.lastSyncedAt, // Best guess
      contentStatus: "current",
      versionCount: pageState.version || 1,
      wordCount: null,
      isRestricted: false,
      syncCreatedAt: pageState.lastSyncedAt,
      syncUpdatedAt: now,
      remoteInaccessibleAt: null,
      remoteInaccessibleReason: null,
    });

    // Convert attachments
    if (pageState.attachments) {
      for (const [attachmentId, attState] of Object.entries(
        pageState.attachments
      )) {
        attachments.push({
          attachmentId,
          pageId,
          filename: attState.filename,
          localPath: attState.localPath,
          mediaType: attState.mediaType,
          fileSize: attState.fileSize,
          version: attState.version,
          localHash: attState.localHash,
          remoteHash: attState.remoteHash,
          baseHash: attState.baseHash,
          lastSyncedAt: attState.lastSyncedAt,
          syncState: attState.syncState as AttachmentRecord["syncState"],
        });
      }
    }
  }

  return {
    version: CURRENT_SCHEMA_VERSION,
    exportedAt: now,
    adapter: "legacy-migration",
    meta: {
      lastSync: state.lastSync || "",
      legacySchemaVersion: String(state.schemaVersion || 1),
    },
    pages,
    attachments,
    links: [], // Will be populated on next pull
    users: [], // Will be populated on next pull
    labels: [], // Will be populated on next pull
    contributors: [], // Will be populated on next pull
    contentProperties: [], // Will be populated on next pull
  };
}

/**
 * Restore from backup if migration failed.
 */
export async function restoreFromBackup(atlcliDir: string): Promise<boolean> {
  const stateJsonPath = join(atlcliDir, "state.json");
  const backupPath = join(atlcliDir, "state.json.bak");

  if (!existsSync(backupPath)) {
    return false;
  }

  try {
    await copyFile(backupPath, stateJsonPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove backup after successful migration verification.
 */
export async function removeBackup(atlcliDir: string): Promise<boolean> {
  const backupPath = join(atlcliDir, "state.json.bak");

  if (!existsSync(backupPath)) {
    return false;
  }

  try {
    await unlink(backupPath);
    return true;
  } catch {
    return false;
  }
}
