/**
 * SQLite implementation of the SyncDbAdapter interface.
 *
 * Uses Bun's built-in SQLite support for zero-dependency, high-performance storage.
 */

import { Database, Statement } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  type SyncDbAdapter,
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
  type InaccessibleReason,
  type SqliteAdapterConfig,
} from "./types.js";
import { runMigrations, getCurrentSchemaVersion, CURRENT_SCHEMA_VERSION } from "./migrations.js";

/**
 * SQLite adapter for sync database.
 */
export class SqliteAdapter implements SyncDbAdapter {
  private db: Database | null = null;
  private readonly config: SqliteAdapterConfig;
  private statements: Map<string, Statement> = new Map();

  readonly adapterType: AdapterType = "sqlite";
  readonly supportsVectors: boolean = false;

  get version(): number {
    return this.db ? getCurrentSchemaVersion(this.db) : 0;
  }

  constructor(config: SqliteAdapterConfig) {
    this.config = config;
  }

  /**
   * Initialize the database connection and run migrations.
   */
  async init(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.config.dbPath);
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(this.config.dbPath, { create: true });

    // Enable WAL mode for better concurrent access
    if (this.config.walMode !== false) {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }

    // Enable foreign keys
    this.db.exec("PRAGMA foreign_keys = ON;");

    // Run migrations
    runMigrations(this.db);

    // Prepare commonly used statements
    this.prepareStatements();
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    // Finalize all prepared statements
    for (const stmt of this.statements.values()) {
      stmt.finalize();
    }
    this.statements.clear();

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Prepare commonly used SQL statements for better performance.
   */
  private prepareStatements(): void {
    if (!this.db) return;

    // Page queries
    this.statements.set(
      "getPage",
      this.db.prepare("SELECT * FROM pages WHERE page_id = ?")
    );
    this.statements.set(
      "getPageByPath",
      this.db.prepare("SELECT * FROM pages WHERE path = ?")
    );
    this.statements.set(
      "deletePage",
      this.db.prepare("DELETE FROM pages WHERE page_id = ?")
    );
    this.statements.set(
      "countPages",
      this.db.prepare("SELECT COUNT(*) as count FROM pages")
    );

    // Attachment queries
    this.statements.set(
      "getAttachment",
      this.db.prepare("SELECT * FROM attachments WHERE attachment_id = ?")
    );
    this.statements.set(
      "getAttachmentsByPage",
      this.db.prepare("SELECT * FROM attachments WHERE page_id = ?")
    );
    this.statements.set(
      "deleteAttachment",
      this.db.prepare("DELETE FROM attachments WHERE attachment_id = ?")
    );
    this.statements.set(
      "deleteAttachmentsByPage",
      this.db.prepare("DELETE FROM attachments WHERE page_id = ?")
    );

    // Link queries
    this.statements.set(
      "deletePageLinks",
      this.db.prepare("DELETE FROM links WHERE source_page_id = ?")
    );
    this.statements.set(
      "getOutgoingLinks",
      this.db.prepare("SELECT * FROM links WHERE source_page_id = ?")
    );
    this.statements.set(
      "getIncomingLinks",
      this.db.prepare("SELECT * FROM links WHERE target_page_id = ?")
    );

    // User queries
    this.statements.set(
      "getUser",
      this.db.prepare("SELECT * FROM users WHERE user_id = ?")
    );
    this.statements.set(
      "listUsers",
      this.db.prepare("SELECT * FROM users")
    );

    // Label queries
    this.statements.set(
      "deletePageLabels",
      this.db.prepare("DELETE FROM labels WHERE page_id = ?")
    );
    this.statements.set(
      "getPageLabels",
      this.db.prepare("SELECT label FROM labels WHERE page_id = ?")
    );

    // Contributor queries
    this.statements.set(
      "deletePageContributors",
      this.db.prepare("DELETE FROM contributors WHERE page_id = ?")
    );
    this.statements.set(
      "getPageContributors",
      this.db.prepare("SELECT * FROM contributors WHERE page_id = ?")
    );

    // Content property queries
    this.statements.set(
      "deleteContentProperties",
      this.db.prepare("DELETE FROM content_properties WHERE page_id = ?")
    );
    this.statements.set(
      "getContentProperties",
      this.db.prepare("SELECT * FROM content_properties WHERE page_id = ?")
    );
    this.statements.set(
      "getContentProperty",
      this.db.prepare("SELECT * FROM content_properties WHERE page_id = ? AND key = ?")
    );

    // Meta queries
    this.statements.set(
      "getMeta",
      this.db.prepare("SELECT value FROM sync_meta WHERE key = ?")
    );
    this.statements.set(
      "deleteMeta",
      this.db.prepare("DELETE FROM sync_meta WHERE key = ?")
    );
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call init() first.");
    }
    return this.db;
  }

  // ============ Pages ============

  async getPage(pageId: string): Promise<PageRecord | null> {
    const db = this.ensureDb();
    const stmt = this.statements.get("getPage")!;
    const row = stmt.get(pageId) as RawPageRow | null;
    return row ? this.rowToPageRecord(row) : null;
  }

  async getPageByPath(path: string): Promise<PageRecord | null> {
    const db = this.ensureDb();
    const stmt = this.statements.get("getPageByPath")!;
    const row = stmt.get(path) as RawPageRow | null;
    return row ? this.rowToPageRecord(row) : null;
  }

  async upsertPage(page: PageRecord): Promise<void> {
    const db = this.ensureDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO pages (
        page_id, path, title, space_key, version, last_synced_at,
        local_hash, remote_hash, base_hash, sync_state, parent_id,
        ancestors, has_attachments, created_by, created_at, last_modified_by,
        last_modified, content_status, version_count, word_count, is_restricted,
        sync_created_at, sync_updated_at, remote_inaccessible_at, remote_inaccessible_reason
      ) VALUES (
        $pageId, $path, $title, $spaceKey, $version, $lastSyncedAt,
        $localHash, $remoteHash, $baseHash, $syncState, $parentId,
        $ancestors, $hasAttachments, $createdBy, $createdAt, $lastModifiedBy,
        $lastModified, $contentStatus, $versionCount, $wordCount, $isRestricted,
        $syncCreatedAt, $syncUpdatedAt, $remoteInaccessibleAt, $remoteInaccessibleReason
      )
      ON CONFLICT(page_id) DO UPDATE SET
        path = $path,
        title = $title,
        space_key = $spaceKey,
        version = $version,
        last_synced_at = $lastSyncedAt,
        local_hash = $localHash,
        remote_hash = $remoteHash,
        base_hash = $baseHash,
        sync_state = $syncState,
        parent_id = $parentId,
        ancestors = $ancestors,
        has_attachments = $hasAttachments,
        created_by = $createdBy,
        created_at = $createdAt,
        last_modified_by = $lastModifiedBy,
        last_modified = $lastModified,
        content_status = $contentStatus,
        version_count = $versionCount,
        word_count = $wordCount,
        is_restricted = $isRestricted,
        sync_updated_at = $syncUpdatedAt,
        remote_inaccessible_at = $remoteInaccessibleAt,
        remote_inaccessible_reason = $remoteInaccessibleReason
    `).run({
      $pageId: page.pageId,
      $path: page.path,
      $title: page.title,
      $spaceKey: page.spaceKey,
      $version: page.version,
      $lastSyncedAt: page.lastSyncedAt,
      $localHash: page.localHash,
      $remoteHash: page.remoteHash,
      $baseHash: page.baseHash,
      $syncState: page.syncState,
      $parentId: page.parentId,
      $ancestors: JSON.stringify(page.ancestors),
      $hasAttachments: page.hasAttachments ? 1 : 0,
      $createdBy: page.createdBy,
      $createdAt: page.createdAt,
      $lastModifiedBy: page.lastModifiedBy,
      $lastModified: page.lastModified,
      $contentStatus: page.contentStatus,
      $versionCount: page.versionCount,
      $wordCount: page.wordCount,
      $isRestricted: page.isRestricted ? 1 : 0,
      $syncCreatedAt: page.syncCreatedAt,
      $syncUpdatedAt: now,
      $remoteInaccessibleAt: page.remoteInaccessibleAt,
      $remoteInaccessibleReason: page.remoteInaccessibleReason,
    });
  }

  async deletePage(pageId: string): Promise<void> {
    const stmt = this.statements.get("deletePage")!;
    stmt.run(pageId);
  }

  async listPages(filter?: PageFilter): Promise<PageRecord[]> {
    const db = this.ensureDb();
    const { sql, params } = this.buildPageFilterQuery(filter);
    const rows = db.prepare(sql).all(...params) as RawPageRow[];
    return rows.map((row) => this.rowToPageRecord(row));
  }

  async countPages(filter?: PageFilter): Promise<number> {
    const db = this.ensureDb();

    if (!filter || Object.keys(filter).length === 0) {
      const stmt = this.statements.get("countPages")!;
      const row = stmt.get() as { count: number };
      return row.count;
    }

    const { sql, params } = this.buildPageFilterQuery(filter, true);
    const row = db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  private buildPageFilterQuery(
    filter?: PageFilter,
    countOnly = false
  ): { sql: string; params: (string | number | null)[] } {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    // By default, exclude inaccessible pages
    if (!filter?.includeInaccessible) {
      conditions.push("remote_inaccessible_at IS NULL");
    }

    if (filter?.spaceKey) {
      conditions.push("space_key = ?");
      params.push(filter.spaceKey);
    }

    if (filter?.syncState) {
      if (Array.isArray(filter.syncState)) {
        conditions.push(`sync_state IN (${filter.syncState.map(() => "?").join(",")})`);
        params.push(...filter.syncState);
      } else {
        conditions.push("sync_state = ?");
        params.push(filter.syncState);
      }
    }

    if (filter?.parentId !== undefined) {
      if (filter.parentId === null) {
        conditions.push("parent_id IS NULL");
      } else {
        conditions.push("parent_id = ?");
        params.push(filter.parentId);
      }
    }

    if (filter?.hasAttachments !== undefined) {
      conditions.push("has_attachments = ?");
      params.push(filter.hasAttachments ? 1 : 0);
    }

    if (filter?.modifiedBefore) {
      conditions.push("last_modified < ?");
      params.push(filter.modifiedBefore);
    }

    if (filter?.modifiedAfter) {
      conditions.push("last_modified > ?");
      params.push(filter.modifiedAfter);
    }

    if (filter?.createdBefore) {
      conditions.push("created_at < ?");
      params.push(filter.createdBefore);
    }

    if (filter?.createdAfter) {
      conditions.push("created_at > ?");
      params.push(filter.createdAfter);
    }

    if (filter?.pathPrefix) {
      conditions.push("path LIKE ?");
      params.push(`${filter.pathPrefix}%`);
    }

    if (filter?.contentStatus) {
      if (Array.isArray(filter.contentStatus)) {
        conditions.push(
          `content_status IN (${filter.contentStatus.map(() => "?").join(",")})`
        );
        params.push(...filter.contentStatus);
      } else {
        conditions.push("content_status = ?");
        params.push(filter.contentStatus);
      }
    }

    if (filter?.isRestricted !== undefined) {
      conditions.push("is_restricted = ?");
      params.push(filter.isRestricted ? 1 : 0);
    }

    if (filter?.createdBy) {
      conditions.push("created_by = ?");
      params.push(filter.createdBy);
    }

    if (filter?.lastModifiedBy) {
      conditions.push("last_modified_by = ?");
      params.push(filter.lastModifiedBy);
    }

    if (filter?.hasLabel) {
      conditions.push(
        "page_id IN (SELECT page_id FROM labels WHERE label = ?)"
      );
      params.push(filter.hasLabel);
    }

    if (filter?.minVersionCount) {
      conditions.push("version_count >= ?");
      params.push(filter.minVersionCount);
    }

    if (filter?.minWordCount) {
      conditions.push("word_count >= ?");
      params.push(filter.minWordCount);
    }

    if (filter?.maxWordCount) {
      conditions.push("word_count <= ?");
      params.push(filter.maxWordCount);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    if (countOnly) {
      return { sql: `SELECT COUNT(*) as count FROM pages ${where}`, params };
    }

    let sql = `SELECT * FROM pages ${where}`;

    if (filter?.limit) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }

    if (filter?.offset) {
      sql += ` OFFSET ?`;
      params.push(filter.offset);
    }

    return { sql, params };
  }

  // ============ Attachments ============

  async getAttachment(attachmentId: string): Promise<AttachmentRecord | null> {
    const stmt = this.statements.get("getAttachment")!;
    const row = stmt.get(attachmentId) as RawAttachmentRow | null;
    return row ? this.rowToAttachmentRecord(row) : null;
  }

  async getAttachmentsByPage(pageId: string): Promise<AttachmentRecord[]> {
    const stmt = this.statements.get("getAttachmentsByPage")!;
    const rows = stmt.all(pageId) as RawAttachmentRow[];
    return rows.map((row) => this.rowToAttachmentRecord(row));
  }

  async upsertAttachment(attachment: AttachmentRecord): Promise<void> {
    const db = this.ensureDb();

    db.prepare(`
      INSERT INTO attachments (
        attachment_id, page_id, filename, local_path, media_type,
        file_size, version, local_hash, remote_hash, base_hash,
        last_synced_at, sync_state
      ) VALUES (
        $attachmentId, $pageId, $filename, $localPath, $mediaType,
        $fileSize, $version, $localHash, $remoteHash, $baseHash,
        $lastSyncedAt, $syncState
      )
      ON CONFLICT(attachment_id) DO UPDATE SET
        page_id = $pageId,
        filename = $filename,
        local_path = $localPath,
        media_type = $mediaType,
        file_size = $fileSize,
        version = $version,
        local_hash = $localHash,
        remote_hash = $remoteHash,
        base_hash = $baseHash,
        last_synced_at = $lastSyncedAt,
        sync_state = $syncState
    `).run({
      $attachmentId: attachment.attachmentId,
      $pageId: attachment.pageId,
      $filename: attachment.filename,
      $localPath: attachment.localPath,
      $mediaType: attachment.mediaType,
      $fileSize: attachment.fileSize,
      $version: attachment.version,
      $localHash: attachment.localHash,
      $remoteHash: attachment.remoteHash,
      $baseHash: attachment.baseHash,
      $lastSyncedAt: attachment.lastSyncedAt,
      $syncState: attachment.syncState,
    });
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    const stmt = this.statements.get("deleteAttachment")!;
    stmt.run(attachmentId);
  }

  async deleteAttachmentsByPage(pageId: string): Promise<void> {
    const stmt = this.statements.get("deleteAttachmentsByPage")!;
    stmt.run(pageId);
  }

  // ============ Links ============

  async setPageLinks(pageId: string, links: LinkRecord[]): Promise<void> {
    const db = this.ensureDb();

    db.transaction(() => {
      // Delete existing links
      const deleteStmt = this.statements.get("deletePageLinks")!;
      deleteStmt.run(pageId);

      // Insert new links
      const insertStmt = db.prepare(`
        INSERT INTO links (
          source_page_id, target_page_id, target_path, link_type,
          link_text, line_number, is_broken, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const link of links) {
        insertStmt.run(
          link.sourcePageId,
          link.targetPageId,
          link.targetPath,
          link.linkType,
          link.linkText,
          link.lineNumber,
          link.isBroken ? 1 : 0,
          link.createdAt || new Date().toISOString()
        );
      }
    })();
  }

  async getOutgoingLinks(pageId: string): Promise<LinkRecord[]> {
    const stmt = this.statements.get("getOutgoingLinks")!;
    const rows = stmt.all(pageId) as RawLinkRow[];
    return rows.map((row) => this.rowToLinkRecord(row));
  }

  async getIncomingLinks(pageId: string): Promise<LinkRecord[]> {
    const stmt = this.statements.get("getIncomingLinks")!;
    const rows = stmt.all(pageId) as RawLinkRow[];
    return rows.map((row) => this.rowToLinkRecord(row));
  }

  async getOrphanedPages(): Promise<PageRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
        SELECT p.*
        FROM pages p
        WHERE p.page_id NOT IN (
            SELECT DISTINCT target_page_id
            FROM links
            WHERE target_page_id IS NOT NULL
            AND link_type = 'internal'
        )
        AND p.parent_id IS NULL
        AND p.remote_inaccessible_at IS NULL
      `
      )
      .all() as RawPageRow[];
    return rows.map((row) => this.rowToPageRecord(row));
  }

  async getBrokenLinks(): Promise<LinkRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
        SELECT l.*
        FROM links l
        WHERE l.is_broken = 1
      `
      )
      .all() as RawLinkRow[];
    return rows.map((row) => this.rowToLinkRecord(row));
  }

  async getExternalLinks(pageId?: string): Promise<LinkRecord[]> {
    const db = this.ensureDb();
    if (pageId) {
      const rows = db
        .prepare(
          `
          SELECT l.*
          FROM links l
          WHERE l.link_type = 'external' AND l.source_page_id = ?
          ORDER BY l.line_number
        `
        )
        .all(pageId) as RawLinkRow[];
      return rows.map((row) => this.rowToLinkRecord(row));
    } else {
      const rows = db
        .prepare(
          `
          SELECT l.*
          FROM links l
          WHERE l.link_type = 'external'
          ORDER BY l.source_page_id, l.line_number
        `
        )
        .all() as RawLinkRow[];
      return rows.map((row) => this.rowToLinkRecord(row));
    }
  }

  // ============ Users ============

  async getUser(userId: string): Promise<UserRecord | null> {
    const stmt = this.statements.get("getUser")!;
    const row = stmt.get(userId) as RawUserRow | null;
    return row ? this.rowToUserRecord(row) : null;
  }

  async upsertUser(user: UserRecord): Promise<void> {
    const db = this.ensureDb();

    db.prepare(`
      INSERT INTO users (user_id, display_name, email, is_active, last_checked_at)
      VALUES ($userId, $displayName, $email, $isActive, $lastCheckedAt)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = $displayName,
        email = $email,
        is_active = $isActive,
        last_checked_at = $lastCheckedAt
    `).run({
      $userId: user.userId,
      $displayName: user.displayName,
      $email: user.email,
      $isActive: user.isActive === null ? null : user.isActive ? 1 : 0,
      $lastCheckedAt: user.lastCheckedAt,
    });
  }

  async listUsers(): Promise<UserRecord[]> {
    const stmt = this.statements.get("listUsers")!;
    const rows = stmt.all() as RawUserRow[];
    return rows.map((row) => this.rowToUserRecord(row));
  }

  async getOldestUserCheck(): Promise<string | null> {
    const db = this.ensureDb();
    const result = db
      .prepare(
        `SELECT MIN(last_checked_at) as oldest FROM users WHERE last_checked_at IS NOT NULL`
      )
      .get() as { oldest: string | null } | null;
    return result?.oldest ?? null;
  }

  // ============ Labels ============

  async setPageLabels(pageId: string, labels: string[]): Promise<void> {
    const db = this.ensureDb();

    db.transaction(() => {
      // Delete existing labels
      const deleteStmt = this.statements.get("deletePageLabels")!;
      deleteStmt.run(pageId);

      // Insert new labels
      const insertStmt = db.prepare(
        "INSERT INTO labels (page_id, label) VALUES (?, ?)"
      );

      for (const label of labels) {
        insertStmt.run(pageId, label);
      }
    })();
  }

  async getPageLabels(pageId: string): Promise<string[]> {
    const stmt = this.statements.get("getPageLabels")!;
    const rows = stmt.all(pageId) as { label: string }[];
    return rows.map((row) => row.label);
  }

  async getPagesWithLabel(label: string): Promise<PageRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
        SELECT p.*
        FROM pages p
        JOIN labels l ON p.page_id = l.page_id
        WHERE l.label = ?
        AND p.remote_inaccessible_at IS NULL
      `
      )
      .all(label) as RawPageRow[];
    return rows.map((row) => this.rowToPageRecord(row));
  }

  async listAllLabels(): Promise<string[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare("SELECT DISTINCT label FROM labels ORDER BY label")
      .all() as { label: string }[];
    return rows.map((row) => row.label);
  }

  // ============ Contributors ============

  async setPageContributors(
    pageId: string,
    contributors: ContributorRecord[]
  ): Promise<void> {
    const db = this.ensureDb();

    db.transaction(() => {
      // Delete existing contributors
      const deleteStmt = this.statements.get("deletePageContributors")!;
      deleteStmt.run(pageId);

      // Insert new contributors
      const insertStmt = db.prepare(`
        INSERT INTO contributors (page_id, user_id, contribution_count, last_contributed_at)
        VALUES (?, ?, ?, ?)
      `);

      for (const contributor of contributors) {
        insertStmt.run(
          contributor.pageId,
          contributor.userId,
          contributor.contributionCount,
          contributor.lastContributedAt
        );
      }
    })();
  }

  async getPageContributors(pageId: string): Promise<ContributorRecord[]> {
    const stmt = this.statements.get("getPageContributors")!;
    const rows = stmt.all(pageId) as RawContributorRow[];
    return rows.map((row) => this.rowToContributorRecord(row));
  }

  async getTopContributors(
    limit = 10
  ): Promise<Array<{ userId: string; pageCount: number; totalContributions: number }>> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
        SELECT
          user_id,
          COUNT(DISTINCT page_id) as page_count,
          SUM(contribution_count) as total_contributions
        FROM contributors
        GROUP BY user_id
        ORDER BY total_contributions DESC
        LIMIT ?
      `
      )
      .all(limit) as {
        user_id: string;
        page_count: number;
        total_contributions: number;
      }[];

    return rows.map((row) => ({
      userId: row.user_id,
      pageCount: row.page_count,
      totalContributions: row.total_contributions,
    }));
  }

  // ============ Content Properties ============

  async setContentProperties(
    pageId: string,
    properties: ContentPropertyRecord[]
  ): Promise<void> {
    const db = this.ensureDb();

    db.transaction(() => {
      // Delete existing properties
      const deleteStmt = this.statements.get("deleteContentProperties")!;
      deleteStmt.run(pageId);

      // Insert new properties
      const insertStmt = db.prepare(`
        INSERT INTO content_properties (page_id, key, value_json, version, last_synced_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const prop of properties) {
        insertStmt.run(
          prop.pageId,
          prop.key,
          JSON.stringify(prop.valueJson),
          prop.version,
          prop.lastSyncedAt
        );
      }
    })();
  }

  async getContentProperties(pageId: string): Promise<ContentPropertyRecord[]> {
    const stmt = this.statements.get("getContentProperties")!;
    const rows = stmt.all(pageId) as RawContentPropertyRow[];
    return rows.map((row) => this.rowToContentPropertyRecord(row));
  }

  async getContentProperty(
    pageId: string,
    key: string
  ): Promise<ContentPropertyRecord | null> {
    const stmt = this.statements.get("getContentProperty")!;
    const row = stmt.get(pageId, key) as RawContentPropertyRow | null;
    return row ? this.rowToContentPropertyRecord(row) : null;
  }

  async deleteContentProperties(pageId: string): Promise<void> {
    const stmt = this.statements.get("deleteContentProperties")!;
    stmt.run(pageId);
  }

  // ============ Remote Accessibility ============

  async markAsInaccessible(
    pageId: string,
    reason: InaccessibleReason
  ): Promise<void> {
    const db = this.ensureDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE pages
      SET remote_inaccessible_at = ?, remote_inaccessible_reason = ?
      WHERE page_id = ?
    `).run(now, reason, pageId);
  }

  async getInaccessiblePages(): Promise<PageRecord[]> {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        "SELECT * FROM pages WHERE remote_inaccessible_at IS NOT NULL"
      )
      .all() as RawPageRow[];
    return rows.map((row) => this.rowToPageRecord(row));
  }

  async markAsAccessible(pageId: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      UPDATE pages
      SET remote_inaccessible_at = NULL, remote_inaccessible_reason = NULL
      WHERE page_id = ?
    `).run(pageId);
  }

  // ============ Metadata ============

  async getMeta(key: string): Promise<string | null> {
    const stmt = this.statements.get("getMeta")!;
    const row = stmt.get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const db = this.ensureDb();
    db.prepare(`
      INSERT INTO sync_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?
    `).run(key, value, value);
  }

  async deleteMeta(key: string): Promise<void> {
    const stmt = this.statements.get("deleteMeta")!;
    stmt.run(key);
  }

  // ============ Transactions ============

  async transaction<T>(fn: (adapter: SyncDbAdapter) => Promise<T>): Promise<T> {
    const db = this.ensureDb();

    // Use SQLite's transaction mechanism
    // Note: Bun SQLite transactions are synchronous, but our API is async
    // We wrap in try/catch to handle rollback
    let result: T;
    try {
      db.exec("BEGIN TRANSACTION");
      result = await fn(this);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }

  // ============ Export/Import ============

  async exportToJson(): Promise<SyncDbExport> {
    const db = this.ensureDb();

    // Get all data
    const pages = await this.listPages({ includeInaccessible: true });
    const attachments = db
      .prepare("SELECT * FROM attachments")
      .all() as RawAttachmentRow[];
    const links = db.prepare("SELECT * FROM links").all() as RawLinkRow[];
    const users = await this.listUsers();
    const labels = db.prepare("SELECT * FROM labels").all() as RawLabelRow[];
    const contributors = db
      .prepare("SELECT * FROM contributors")
      .all() as RawContributorRow[];
    const contentProperties = db
      .prepare("SELECT * FROM content_properties")
      .all() as RawContentPropertyRow[];
    const metaRows = db
      .prepare("SELECT * FROM sync_meta")
      .all() as { key: string; value: string }[];

    const meta: Record<string, string> = {};
    for (const row of metaRows) {
      meta[row.key] = row.value;
    }

    return {
      version: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      adapter: "sqlite",
      meta,
      pages,
      attachments: attachments.map((row) => this.rowToAttachmentRecord(row)),
      links: links.map((row) => this.rowToLinkRecord(row)),
      users,
      labels: labels.map((row) => ({ pageId: row.page_id, label: row.label })),
      contributors: contributors.map((row) => this.rowToContributorRecord(row)),
      contentProperties: contentProperties.map((row) =>
        this.rowToContentPropertyRecord(row)
      ),
    };
  }

  async importFromJson(data: SyncDbExport): Promise<void> {
    const db = this.ensureDb();

    db.transaction(() => {
      // Clear existing data
      db.exec("DELETE FROM content_properties");
      db.exec("DELETE FROM contributors");
      db.exec("DELETE FROM labels");
      db.exec("DELETE FROM links");
      db.exec("DELETE FROM attachments");
      db.exec("DELETE FROM users");
      db.exec("DELETE FROM pages");
      db.exec("DELETE FROM sync_meta");

      // Import pages
      for (const page of data.pages) {
        this.upsertPage(page);
      }

      // Import attachments
      for (const attachment of data.attachments) {
        this.upsertAttachment(attachment);
      }

      // Import links
      const linksByPage = new Map<string, LinkRecord[]>();
      for (const link of data.links) {
        const existing = linksByPage.get(link.sourcePageId) || [];
        existing.push(link);
        linksByPage.set(link.sourcePageId, existing);
      }
      for (const [pageId, links] of linksByPage) {
        this.setPageLinks(pageId, links);
      }

      // Import users
      for (const user of data.users) {
        this.upsertUser(user);
      }

      // Import labels
      const labelsByPage = new Map<string, string[]>();
      for (const label of data.labels) {
        const existing = labelsByPage.get(label.pageId) || [];
        existing.push(label.label);
        labelsByPage.set(label.pageId, existing);
      }
      for (const [pageId, labels] of labelsByPage) {
        this.setPageLabels(pageId, labels);
      }

      // Import contributors
      const contributorsByPage = new Map<string, ContributorRecord[]>();
      for (const contributor of data.contributors) {
        const existing = contributorsByPage.get(contributor.pageId) || [];
        existing.push(contributor);
        contributorsByPage.set(contributor.pageId, existing);
      }
      for (const [pageId, contributors] of contributorsByPage) {
        this.setPageContributors(pageId, contributors);
      }

      // Import content properties
      const propsByPage = new Map<string, ContentPropertyRecord[]>();
      for (const prop of data.contentProperties) {
        const existing = propsByPage.get(prop.pageId) || [];
        existing.push(prop);
        propsByPage.set(prop.pageId, existing);
      }
      for (const [pageId, props] of propsByPage) {
        this.setContentProperties(pageId, props);
      }

      // Import meta
      for (const [key, value] of Object.entries(data.meta)) {
        this.setMeta(key, value);
      }
    })();
  }

  // ============ Row Conversion Helpers ============

  private rowToPageRecord(row: RawPageRow): PageRecord {
    return {
      pageId: row.page_id,
      path: row.path,
      title: row.title,
      spaceKey: row.space_key,
      version: row.version,
      lastSyncedAt: row.last_synced_at,
      localHash: row.local_hash,
      remoteHash: row.remote_hash,
      baseHash: row.base_hash,
      syncState: row.sync_state as PageRecord["syncState"],
      parentId: row.parent_id,
      ancestors: JSON.parse(row.ancestors || "[]"),
      hasAttachments: !!row.has_attachments,
      createdBy: row.created_by,
      createdAt: row.created_at,
      lastModifiedBy: row.last_modified_by,
      lastModified: row.last_modified,
      contentStatus: row.content_status as PageRecord["contentStatus"],
      versionCount: row.version_count,
      wordCount: row.word_count,
      isRestricted: !!row.is_restricted,
      syncCreatedAt: row.sync_created_at,
      syncUpdatedAt: row.sync_updated_at,
      remoteInaccessibleAt: row.remote_inaccessible_at,
      remoteInaccessibleReason:
        row.remote_inaccessible_reason as PageRecord["remoteInaccessibleReason"],
    };
  }

  private rowToAttachmentRecord(row: RawAttachmentRow): AttachmentRecord {
    return {
      attachmentId: row.attachment_id,
      pageId: row.page_id,
      filename: row.filename,
      localPath: row.local_path,
      mediaType: row.media_type,
      fileSize: row.file_size,
      version: row.version,
      localHash: row.local_hash,
      remoteHash: row.remote_hash,
      baseHash: row.base_hash,
      lastSyncedAt: row.last_synced_at,
      syncState: row.sync_state as AttachmentRecord["syncState"],
    };
  }

  private rowToLinkRecord(row: RawLinkRow): LinkRecord {
    return {
      id: row.id,
      sourcePageId: row.source_page_id,
      targetPageId: row.target_page_id,
      targetPath: row.target_path,
      linkType: row.link_type as LinkRecord["linkType"],
      linkText: row.link_text,
      lineNumber: row.line_number,
      isBroken: !!row.is_broken,
      createdAt: row.created_at,
    };
  }

  private rowToUserRecord(row: RawUserRow): UserRecord {
    return {
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active === null ? null : !!row.is_active,
      lastCheckedAt: row.last_checked_at,
    };
  }

  private rowToContributorRecord(row: RawContributorRow): ContributorRecord {
    return {
      pageId: row.page_id,
      userId: row.user_id,
      contributionCount: row.contribution_count,
      lastContributedAt: row.last_contributed_at,
    };
  }

  private rowToContentPropertyRecord(
    row: RawContentPropertyRow
  ): ContentPropertyRecord {
    return {
      pageId: row.page_id,
      key: row.key,
      valueJson: JSON.parse(row.value_json),
      version: row.version,
      lastSyncedAt: row.last_synced_at,
    };
  }
}

// ============ Raw Row Types (SQLite column names) ============

interface RawPageRow {
  page_id: string;
  path: string;
  title: string;
  space_key: string;
  version: number;
  last_synced_at: string;
  local_hash: string;
  remote_hash: string;
  base_hash: string;
  sync_state: string;
  parent_id: string | null;
  ancestors: string;
  has_attachments: number;
  created_by: string | null;
  created_at: string;
  last_modified_by: string | null;
  last_modified: string | null;
  content_status: string;
  version_count: number;
  word_count: number | null;
  is_restricted: number;
  sync_created_at: string;
  sync_updated_at: string;
  remote_inaccessible_at: string | null;
  remote_inaccessible_reason: string | null;
}

interface RawAttachmentRow {
  attachment_id: string;
  page_id: string;
  filename: string;
  local_path: string;
  media_type: string;
  file_size: number;
  version: number;
  local_hash: string;
  remote_hash: string;
  base_hash: string;
  last_synced_at: string;
  sync_state: string;
}

interface RawLinkRow {
  id: number;
  source_page_id: string;
  target_page_id: string | null;
  target_path: string | null;
  link_type: string;
  link_text: string | null;
  line_number: number | null;
  is_broken: number;
  created_at: string;
}

interface RawUserRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  is_active: number | null;
  last_checked_at: string | null;
}

interface RawLabelRow {
  page_id: string;
  label: string;
}

interface RawContributorRow {
  page_id: string;
  user_id: string;
  contribution_count: number;
  last_contributed_at: string | null;
}

interface RawContentPropertyRow {
  page_id: string;
  key: string;
  value_json: string;
  version: number;
  last_synced_at: string;
}
