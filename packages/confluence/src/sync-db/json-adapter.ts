/**
 * JSON implementation of the SyncDbAdapter interface.
 *
 * Provides a fallback adapter that stores all data in a single JSON file.
 * Useful for debugging, testing, and environments where SQLite is not available.
 *
 * Note: This adapter is NOT performance-optimized and should only be used
 * for small datasets or debugging purposes.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  type JsonAdapterConfig,
} from "./types.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

/**
 * Internal storage format for JSON adapter.
 */
interface JsonStorage {
  version: number;
  meta: Record<string, string>;
  pages: Record<string, PageRecord>;
  attachments: Record<string, AttachmentRecord>;
  links: LinkRecord[];
  users: Record<string, UserRecord>;
  labels: LabelRecord[];
  contributors: ContributorRecord[];
  contentProperties: ContentPropertyRecord[];
}

const DEFAULT_STORAGE: JsonStorage = {
  version: CURRENT_SCHEMA_VERSION,
  meta: {},
  pages: {},
  attachments: {},
  links: [],
  users: {},
  labels: [],
  contributors: [],
  contentProperties: [],
};

/**
 * JSON adapter for sync database.
 */
export class JsonAdapter implements SyncDbAdapter {
  private readonly config: JsonAdapterConfig;
  private readonly filePath: string;
  private storage: JsonStorage = { ...DEFAULT_STORAGE };
  private dirty = false;

  readonly adapterType: AdapterType = "json";
  readonly version = CURRENT_SCHEMA_VERSION;
  readonly supportsVectors = false;

  constructor(config: JsonAdapterConfig) {
    this.config = config;
    this.filePath = join(config.atlcliDir, "sync-state.json");
  }

  /**
   * Initialize the adapter by loading existing data.
   */
  async init(): Promise<void> {
    // Reset to empty state
    this.storage = {
      version: CURRENT_SCHEMA_VERSION,
      meta: {},
      pages: {},
      attachments: {},
      links: [],
      users: {},
      labels: [],
      contributors: [],
      contentProperties: [],
    };
    this.dirty = false;

    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Load existing data
    if (existsSync(this.filePath)) {
      try {
        const content = await readFile(this.filePath, "utf-8");
        this.storage = JSON.parse(content) as JsonStorage;
      } catch {
        // If file is corrupted, start fresh
        this.storage = { ...DEFAULT_STORAGE };
      }
    }
  }

  /**
   * Close the adapter by saving any pending changes.
   */
  async close(): Promise<void> {
    if (this.dirty) {
      await this.save();
    }
  }

  /**
   * Save storage to disk.
   */
  private async save(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.storage, null, 2) + "\n");
    this.dirty = false;
  }

  /**
   * Mark storage as dirty (needs save).
   */
  private markDirty(): void {
    this.dirty = true;
  }

  // ============ Pages ============

  async getPage(pageId: string): Promise<PageRecord | null> {
    return this.storage.pages[pageId] ?? null;
  }

  async getPageByPath(path: string): Promise<PageRecord | null> {
    for (const page of Object.values(this.storage.pages)) {
      if (page.path === path) {
        return page;
      }
    }
    return null;
  }

  async upsertPage(page: PageRecord): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.storage.pages[page.pageId];

    this.storage.pages[page.pageId] = {
      ...page,
      syncUpdatedAt: now,
      syncCreatedAt: existing?.syncCreatedAt ?? page.syncCreatedAt ?? now,
    };
    this.markDirty();
  }

  async deletePage(pageId: string): Promise<void> {
    delete this.storage.pages[pageId];

    // Also delete related data
    delete this.storage.attachments[pageId];
    this.storage.links = this.storage.links.filter(
      (l) => l.sourcePageId !== pageId && l.targetPageId !== pageId
    );
    this.storage.labels = this.storage.labels.filter((l) => l.pageId !== pageId);
    this.storage.contributors = this.storage.contributors.filter(
      (c) => c.pageId !== pageId
    );
    this.storage.contentProperties = this.storage.contentProperties.filter(
      (p) => p.pageId !== pageId
    );

    this.markDirty();
  }

  async listPages(filter?: PageFilter): Promise<PageRecord[]> {
    let pages = Object.values(this.storage.pages);

    // Apply filters
    if (!filter?.includeInaccessible) {
      pages = pages.filter((p) => !p.remoteInaccessibleAt);
    }

    if (filter?.spaceKey) {
      pages = pages.filter((p) => p.spaceKey === filter.spaceKey);
    }

    if (filter?.syncState) {
      const states = Array.isArray(filter.syncState)
        ? filter.syncState
        : [filter.syncState];
      pages = pages.filter((p) => states.includes(p.syncState));
    }

    if (filter?.parentId !== undefined) {
      pages = pages.filter((p) => p.parentId === filter.parentId);
    }

    if (filter?.hasAttachments !== undefined) {
      pages = pages.filter((p) => p.hasAttachments === filter.hasAttachments);
    }

    if (filter?.modifiedBefore) {
      pages = pages.filter(
        (p) => p.lastModified && p.lastModified < filter.modifiedBefore!
      );
    }

    if (filter?.modifiedAfter) {
      pages = pages.filter(
        (p) => p.lastModified && p.lastModified > filter.modifiedAfter!
      );
    }

    if (filter?.createdBefore) {
      pages = pages.filter((p) => p.createdAt < filter.createdBefore!);
    }

    if (filter?.createdAfter) {
      pages = pages.filter((p) => p.createdAt > filter.createdAfter!);
    }

    if (filter?.pathPrefix) {
      pages = pages.filter((p) => p.path.startsWith(filter.pathPrefix!));
    }

    if (filter?.contentStatus) {
      const statuses = Array.isArray(filter.contentStatus)
        ? filter.contentStatus
        : [filter.contentStatus];
      pages = pages.filter((p) => statuses.includes(p.contentStatus));
    }

    if (filter?.isRestricted !== undefined) {
      pages = pages.filter((p) => p.isRestricted === filter.isRestricted);
    }

    if (filter?.createdBy) {
      pages = pages.filter((p) => p.createdBy === filter.createdBy);
    }

    if (filter?.lastModifiedBy) {
      pages = pages.filter((p) => p.lastModifiedBy === filter.lastModifiedBy);
    }

    if (filter?.hasLabel) {
      const pagesWithLabel = new Set(
        this.storage.labels
          .filter((l) => l.label === filter.hasLabel)
          .map((l) => l.pageId)
      );
      pages = pages.filter((p) => pagesWithLabel.has(p.pageId));
    }

    if (filter?.minVersionCount) {
      pages = pages.filter((p) => p.versionCount >= filter.minVersionCount!);
    }

    if (filter?.minWordCount) {
      pages = pages.filter(
        (p) => p.wordCount !== null && p.wordCount >= filter.minWordCount!
      );
    }

    if (filter?.maxWordCount) {
      pages = pages.filter(
        (p) => p.wordCount !== null && p.wordCount <= filter.maxWordCount!
      );
    }

    // Apply pagination
    if (filter?.offset) {
      pages = pages.slice(filter.offset);
    }

    if (filter?.limit) {
      pages = pages.slice(0, filter.limit);
    }

    return pages;
  }

  async countPages(filter?: PageFilter): Promise<number> {
    const pages = await this.listPages(filter);
    return pages.length;
  }

  // ============ Attachments ============

  async getAttachment(attachmentId: string): Promise<AttachmentRecord | null> {
    return this.storage.attachments[attachmentId] ?? null;
  }

  async getAttachmentsByPage(pageId: string): Promise<AttachmentRecord[]> {
    return Object.values(this.storage.attachments).filter(
      (a) => a.pageId === pageId
    );
  }

  async upsertAttachment(attachment: AttachmentRecord): Promise<void> {
    this.storage.attachments[attachment.attachmentId] = attachment;
    this.markDirty();
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    delete this.storage.attachments[attachmentId];
    this.markDirty();
  }

  async deleteAttachmentsByPage(pageId: string): Promise<void> {
    for (const [id, attachment] of Object.entries(this.storage.attachments)) {
      if (attachment.pageId === pageId) {
        delete this.storage.attachments[id];
      }
    }
    this.markDirty();
  }

  // ============ Links ============

  async setPageLinks(pageId: string, links: LinkRecord[]): Promise<void> {
    // Remove existing links for this page
    this.storage.links = this.storage.links.filter(
      (l) => l.sourcePageId !== pageId
    );

    // Add new links
    const now = new Date().toISOString();
    for (const link of links) {
      this.storage.links.push({
        ...link,
        createdAt: link.createdAt || now,
      });
    }

    this.markDirty();
  }

  async getOutgoingLinks(pageId: string): Promise<LinkRecord[]> {
    return this.storage.links.filter((l) => l.sourcePageId === pageId);
  }

  async getIncomingLinks(pageId: string): Promise<LinkRecord[]> {
    return this.storage.links.filter((l) => l.targetPageId === pageId);
  }

  async getOrphanedPages(): Promise<PageRecord[]> {
    const pagesWithIncomingLinks = new Set(
      this.storage.links
        .filter((l) => l.targetPageId && l.linkType === "internal")
        .map((l) => l.targetPageId!)
    );

    return Object.values(this.storage.pages).filter(
      (p) =>
        !pagesWithIncomingLinks.has(p.pageId) &&
        !p.parentId &&
        !p.remoteInaccessibleAt
    );
  }

  async getBrokenLinks(): Promise<LinkRecord[]> {
    return this.storage.links.filter((l) => l.isBroken);
  }

  // ============ Users ============

  async getUser(userId: string): Promise<UserRecord | null> {
    return this.storage.users[userId] ?? null;
  }

  async upsertUser(user: UserRecord): Promise<void> {
    this.storage.users[user.userId] = user;
    this.markDirty();
  }

  async listUsers(): Promise<UserRecord[]> {
    return Object.values(this.storage.users);
  }

  // ============ Labels ============

  async setPageLabels(pageId: string, labels: string[]): Promise<void> {
    // Remove existing labels for this page
    this.storage.labels = this.storage.labels.filter((l) => l.pageId !== pageId);

    // Add new labels
    for (const label of labels) {
      this.storage.labels.push({ pageId, label });
    }

    this.markDirty();
  }

  async getPageLabels(pageId: string): Promise<string[]> {
    return this.storage.labels
      .filter((l) => l.pageId === pageId)
      .map((l) => l.label);
  }

  async getPagesWithLabel(label: string): Promise<PageRecord[]> {
    const pageIds = new Set(
      this.storage.labels.filter((l) => l.label === label).map((l) => l.pageId)
    );
    return Object.values(this.storage.pages).filter(
      (p) => pageIds.has(p.pageId) && !p.remoteInaccessibleAt
    );
  }

  async listAllLabels(): Promise<string[]> {
    return [...new Set(this.storage.labels.map((l) => l.label))].sort();
  }

  // ============ Contributors ============

  async setPageContributors(
    pageId: string,
    contributors: ContributorRecord[]
  ): Promise<void> {
    // Remove existing contributors for this page
    this.storage.contributors = this.storage.contributors.filter(
      (c) => c.pageId !== pageId
    );

    // Add new contributors
    this.storage.contributors.push(...contributors);
    this.markDirty();
  }

  async getPageContributors(pageId: string): Promise<ContributorRecord[]> {
    return this.storage.contributors.filter((c) => c.pageId === pageId);
  }

  async getTopContributors(
    limit = 10
  ): Promise<Array<{ userId: string; pageCount: number; totalContributions: number }>> {
    const userStats = new Map<string, { pages: Set<string>; total: number }>();

    for (const contributor of this.storage.contributors) {
      const existing = userStats.get(contributor.userId) || {
        pages: new Set(),
        total: 0,
      };
      existing.pages.add(contributor.pageId);
      existing.total += contributor.contributionCount;
      userStats.set(contributor.userId, existing);
    }

    return [...userStats.entries()]
      .map(([userId, stats]) => ({
        userId,
        pageCount: stats.pages.size,
        totalContributions: stats.total,
      }))
      .sort((a, b) => b.totalContributions - a.totalContributions)
      .slice(0, limit);
  }

  // ============ Content Properties ============

  async setContentProperties(
    pageId: string,
    properties: ContentPropertyRecord[]
  ): Promise<void> {
    // Remove existing properties for this page
    this.storage.contentProperties = this.storage.contentProperties.filter(
      (p) => p.pageId !== pageId
    );

    // Add new properties
    this.storage.contentProperties.push(...properties);
    this.markDirty();
  }

  async getContentProperties(pageId: string): Promise<ContentPropertyRecord[]> {
    return this.storage.contentProperties.filter((p) => p.pageId === pageId);
  }

  async getContentProperty(
    pageId: string,
    key: string
  ): Promise<ContentPropertyRecord | null> {
    return (
      this.storage.contentProperties.find(
        (p) => p.pageId === pageId && p.key === key
      ) ?? null
    );
  }

  async deleteContentProperties(pageId: string): Promise<void> {
    this.storage.contentProperties = this.storage.contentProperties.filter(
      (p) => p.pageId !== pageId
    );
    this.markDirty();
  }

  // ============ Remote Accessibility ============

  async markAsInaccessible(
    pageId: string,
    reason: InaccessibleReason
  ): Promise<void> {
    const page = this.storage.pages[pageId];
    if (page) {
      page.remoteInaccessibleAt = new Date().toISOString();
      page.remoteInaccessibleReason = reason;
      this.markDirty();
    }
  }

  async getInaccessiblePages(): Promise<PageRecord[]> {
    return Object.values(this.storage.pages).filter(
      (p) => p.remoteInaccessibleAt !== null
    );
  }

  async markAsAccessible(pageId: string): Promise<void> {
    const page = this.storage.pages[pageId];
    if (page) {
      page.remoteInaccessibleAt = null;
      page.remoteInaccessibleReason = null;
      this.markDirty();
    }
  }

  // ============ Metadata ============

  async getMeta(key: string): Promise<string | null> {
    return this.storage.meta[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.storage.meta[key] = value;
    this.markDirty();
  }

  async deleteMeta(key: string): Promise<void> {
    delete this.storage.meta[key];
    this.markDirty();
  }

  // ============ Transactions ============

  async transaction<T>(fn: (adapter: SyncDbAdapter) => Promise<T>): Promise<T> {
    // JSON adapter doesn't support true transactions
    // We just execute and save on success
    const result = await fn(this);
    await this.save();
    return result;
  }

  // ============ Export/Import ============

  async exportToJson(): Promise<SyncDbExport> {
    return {
      version: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      adapter: "json",
      meta: { ...this.storage.meta },
      pages: Object.values(this.storage.pages),
      attachments: Object.values(this.storage.attachments),
      links: [...this.storage.links],
      users: Object.values(this.storage.users),
      labels: [...this.storage.labels],
      contributors: [...this.storage.contributors],
      contentProperties: [...this.storage.contentProperties],
    };
  }

  async importFromJson(data: SyncDbExport): Promise<void> {
    // Reset storage
    this.storage = {
      version: data.version,
      meta: { ...data.meta },
      pages: {},
      attachments: {},
      links: [...data.links],
      users: {},
      labels: [...data.labels],
      contributors: [...data.contributors],
      contentProperties: [...data.contentProperties],
    };

    // Convert arrays to records
    for (const page of data.pages) {
      this.storage.pages[page.pageId] = page;
    }

    for (const attachment of data.attachments) {
      this.storage.attachments[attachment.attachmentId] = attachment;
    }

    for (const user of data.users) {
      this.storage.users[user.userId] = user;
    }

    await this.save();
  }
}
