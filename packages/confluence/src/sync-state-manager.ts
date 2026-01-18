/**
 * Sync State Manager - Bridge between CLI and sync-db adapter.
 *
 * Provides a higher-level interface for the CLI commands that:
 * - Handles adapter lifecycle (init, close)
 * - Auto-migrates from state.json if needed
 * - Converts between PageState ↔ PageRecord formats
 * - Maintains compatibility with existing CLI patterns
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import type {
  SyncDbAdapter,
  PageRecord,
  AttachmentRecord,
  LinkRecord,
  UserRecord,
  ContributorRecord,
  PageFilter,
} from "./sync-db/types.js";
import { createSyncDb, type CreateSyncDbOptions } from "./sync-db/index.js";
import type { AtlcliState, PageState, AttachmentState, SyncState } from "./atlcli-dir.js";

/**
 * Manager for sync state using the sync-db adapter.
 *
 * Usage:
 * ```typescript
 * const manager = new SyncStateManager(atlcliDir);
 * await manager.init();
 *
 * // Use the manager
 * const page = await manager.getPage(pageId);
 * await manager.updatePage(pageId, { ... });
 *
 * // Close when done
 * await manager.close();
 * ```
 */
export class SyncStateManager {
  private adapter: SyncDbAdapter | null = null;
  private atlcliDir: string;
  private options: CreateSyncDbOptions;

  constructor(atlcliDir: string, options: CreateSyncDbOptions = {}) {
    this.atlcliDir = atlcliDir;
    this.options = options;
  }

  /**
   * Initialize the manager and adapter.
   * Auto-migrates from state.json if present.
   */
  async init(): Promise<void> {
    if (this.adapter) {
      return; // Already initialized
    }

    const atlcliPath = join(this.atlcliDir, ".atlcli");
    this.adapter = await createSyncDb(atlcliPath, {
      autoMigrate: true,
      ...this.options,
    });
  }

  /**
   * Close the adapter connection.
   */
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
      this.adapter = null;
    }
  }

  /**
   * Get the underlying adapter (for advanced operations).
   */
  getAdapter(): SyncDbAdapter {
    if (!this.adapter) {
      throw new Error("SyncStateManager not initialized. Call init() first.");
    }
    return this.adapter;
  }

  // ============ Page Operations ============

  /**
   * Get a page by ID.
   */
  async getPage(pageId: string): Promise<PageRecord | null> {
    return this.getAdapter().getPage(pageId);
  }

  /**
   * Get a page by its local file path.
   */
  async getPageByPath(path: string): Promise<PageRecord | null> {
    return this.getAdapter().getPageByPath(path);
  }

  /**
   * List all pages matching optional filters.
   */
  async listPages(filter?: PageFilter): Promise<PageRecord[]> {
    return this.getAdapter().listPages(filter);
  }

  /**
   * Update or insert a page.
   */
  async upsertPage(page: PageRecord): Promise<void> {
    return this.getAdapter().upsertPage(page);
  }

  /**
   * Update specific fields of a page.
   */
  async updatePage(pageId: string, updates: Partial<PageRecord>): Promise<void> {
    const existing = await this.getPage(pageId);
    if (!existing) {
      throw new Error(`Page ${pageId} not found`);
    }
    await this.upsertPage({ ...existing, ...updates });
  }

  /**
   * Delete a page.
   */
  async deletePage(pageId: string): Promise<void> {
    return this.getAdapter().deletePage(pageId);
  }

  /**
   * Get all page paths as a Set (for checking existing paths).
   */
  async getExistingPaths(): Promise<Set<string>> {
    const pages = await this.listPages();
    return new Set(pages.map((p) => p.path));
  }

  // ============ Attachment Operations ============

  /**
   * Get an attachment by ID.
   */
  async getAttachment(attachmentId: string): Promise<AttachmentRecord | null> {
    return this.getAdapter().getAttachment(attachmentId);
  }

  /**
   * List attachments for a page.
   */
  async listAttachments(pageId: string): Promise<AttachmentRecord[]> {
    return this.getAdapter().getAttachmentsByPage(pageId);
  }

  /**
   * Update or insert an attachment.
   */
  async upsertAttachment(attachment: AttachmentRecord): Promise<void> {
    return this.getAdapter().upsertAttachment(attachment);
  }

  /**
   * Delete an attachment.
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    return this.getAdapter().deleteAttachment(attachmentId);
  }

  // ============ Link Operations ============

  /**
   * Set all links for a page (replaces existing).
   */
  async setPageLinks(pageId: string, links: LinkRecord[]): Promise<void> {
    return this.getAdapter().setPageLinks(pageId, links);
  }

  /**
   * Get outgoing links from a page.
   */
  async getOutgoingLinks(pageId: string): Promise<LinkRecord[]> {
    return this.getAdapter().getOutgoingLinks(pageId);
  }

  /**
   * Get incoming links to a page.
   */
  async getIncomingLinks(pageId: string): Promise<LinkRecord[]> {
    return this.getAdapter().getIncomingLinks(pageId);
  }

  // ============ User Operations ============

  /**
   * Get a user by ID.
   */
  async getUser(userId: string): Promise<UserRecord | null> {
    return this.getAdapter().getUser(userId);
  }

  /**
   * Update or insert a user.
   */
  async upsertUser(user: UserRecord): Promise<void> {
    return this.getAdapter().upsertUser(user);
  }

  /**
   * List all users.
   */
  async listUsers(): Promise<UserRecord[]> {
    return this.getAdapter().listUsers();
  }

  // ============ Contributor Operations ============

  /**
   * Set contributors for a page.
   */
  async setPageContributors(pageId: string, contributors: ContributorRecord[]): Promise<void> {
    return this.getAdapter().setPageContributors(pageId, contributors);
  }

  /**
   * Get contributors for a page.
   */
  async getPageContributors(pageId: string): Promise<ContributorRecord[]> {
    return this.getAdapter().getPageContributors(pageId);
  }

  // ============ Metadata Operations ============

  /**
   * Get last sync timestamp.
   */
  async getLastSync(): Promise<string | null> {
    return this.getAdapter().getMeta("lastSync");
  }

  /**
   * Set last sync timestamp.
   */
  async setLastSync(timestamp: string): Promise<void> {
    return this.getAdapter().setMeta("lastSync", timestamp);
  }

  /**
   * Get a metadata value.
   */
  async getMeta(key: string): Promise<string | null> {
    return this.getAdapter().getMeta(key);
  }

  /**
   * Set a metadata value.
   */
  async setMeta(key: string, value: string): Promise<void> {
    return this.getAdapter().setMeta(key, value);
  }

  // ============ Transaction Support ============

  /**
   * Execute operations in a transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.getAdapter().transaction(fn);
  }

  // ============ Compatibility Helpers ============

  /**
   * Convert PageRecord to legacy PageState format.
   * Used for compatibility with existing code.
   */
  static pageRecordToState(record: PageRecord): PageState {
    return {
      path: record.path,
      title: record.title,
      spaceKey: record.spaceKey,
      version: record.version,
      lastSyncedAt: record.lastSyncedAt,
      localHash: record.localHash,
      remoteHash: record.remoteHash,
      baseHash: record.baseHash,
      syncState: record.syncState,
      parentId: record.parentId,
      ancestors: record.ancestors,
      hasAttachments: record.hasAttachments,
      attachments: {}, // Attachments loaded separately
    };
  }

  /**
   * Convert PageState to PageRecord format.
   * Used for compatibility with existing code.
   */
  static pageStateToRecord(
    pageId: string,
    state: PageState,
    existingRecord?: PageRecord | null
  ): PageRecord {
    const now = new Date().toISOString();
    return {
      pageId,
      path: state.path,
      title: state.title,
      spaceKey: state.spaceKey,
      version: state.version,
      lastSyncedAt: state.lastSyncedAt,
      localHash: state.localHash,
      remoteHash: state.remoteHash,
      baseHash: state.baseHash,
      syncState: state.syncState,
      parentId: state.parentId ?? null,
      ancestors: state.ancestors || [],
      hasAttachments: state.hasAttachments ?? false,
      // Preserve existing metadata or use defaults
      createdBy: existingRecord?.createdBy ?? null,
      createdAt: existingRecord?.createdAt ?? now,
      lastModifiedBy: existingRecord?.lastModifiedBy ?? null,
      lastModified: existingRecord?.lastModified ?? null,
      contentStatus: existingRecord?.contentStatus ?? "current",
      versionCount: existingRecord?.versionCount ?? state.version,
      wordCount: existingRecord?.wordCount ?? null,
      isRestricted: existingRecord?.isRestricted ?? false,
      syncCreatedAt: existingRecord?.syncCreatedAt ?? now,
      syncUpdatedAt: now,
      remoteInaccessibleAt: existingRecord?.remoteInaccessibleAt ?? null,
      remoteInaccessibleReason: existingRecord?.remoteInaccessibleReason ?? null,
    };
  }

  /**
   * Load state in legacy AtlcliState format.
   * Used for gradual migration - allows existing code to work unchanged.
   */
  async loadLegacyState(): Promise<AtlcliState> {
    const pages = await this.listPages();
    const lastSync = await this.getLastSync();

    const state: AtlcliState = {
      schemaVersion: 1,
      lastSync,
      pages: {},
      pathIndex: {},
    };

    for (const page of pages) {
      state.pages[page.pageId] = SyncStateManager.pageRecordToState(page);
      state.pathIndex[page.path] = page.pageId;

      // Load attachments
      const attachments = await this.listAttachments(page.pageId);
      for (const att of attachments) {
        state.pages[page.pageId].attachments = state.pages[page.pageId].attachments || {};
        state.pages[page.pageId].attachments![att.attachmentId] = {
          attachmentId: att.attachmentId,
          filename: att.filename,
          localPath: att.localPath,
          mediaType: att.mediaType,
          fileSize: att.fileSize,
          version: att.version,
          localHash: att.localHash,
          remoteHash: att.remoteHash,
          baseHash: att.baseHash,
          lastSyncedAt: att.lastSyncedAt,
          syncState: att.syncState,
        };
      }
    }

    return state;
  }

  /**
   * Save state from legacy AtlcliState format.
   * Used for gradual migration.
   */
  async saveLegacyState(state: AtlcliState): Promise<void> {
    // Update lastSync
    if (state.lastSync) {
      await this.setLastSync(state.lastSync);
    }

    // Get existing pages to detect deletions
    const existingPages = await this.listPages();
    const existingPageIds = new Set(existingPages.map((p) => p.pageId));
    const newPageIds = new Set(Object.keys(state.pages));

    // Delete removed pages
    for (const pageId of existingPageIds) {
      if (!newPageIds.has(pageId)) {
        await this.deletePage(pageId);
      }
    }

    // Upsert pages
    for (const [pageId, pageState] of Object.entries(state.pages)) {
      const existing = await this.getPage(pageId);
      const record = SyncStateManager.pageStateToRecord(pageId, pageState, existing);
      await this.upsertPage(record);

      // Handle attachments
      const existingAttachments = await this.listAttachments(pageId);
      const existingAttIds = new Set(existingAttachments.map((a) => a.attachmentId));
      const newAttIds = new Set(Object.keys(pageState.attachments || {}));

      // Delete removed attachments
      for (const attId of existingAttIds) {
        if (!newAttIds.has(attId)) {
          await this.deleteAttachment(attId);
        }
      }

      // Upsert attachments
      for (const [attId, attState] of Object.entries(pageState.attachments || {})) {
        const attRecord: AttachmentRecord = {
          attachmentId: attId,
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
          syncState: attState.syncState,
        };
        await this.upsertAttachment(attRecord);
      }
    }
  }
}

/**
 * Create a SyncStateManager for a directory.
 * Convenience function that handles initialization.
 */
export async function createSyncStateManager(
  atlcliDir: string,
  options: CreateSyncDbOptions = {}
): Promise<SyncStateManager> {
  const manager = new SyncStateManager(atlcliDir, options);
  await manager.init();
  return manager;
}
