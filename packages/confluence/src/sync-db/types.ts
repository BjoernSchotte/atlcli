/**
 * Sync Database Adapter types and interfaces.
 *
 * This module defines the abstract storage layer for sync operations,
 * allowing multiple backends (SQLite, PostgreSQL, JSON).
 */

// ============ Enums and Type Literals ============

/**
 * Why a page became inaccessible (based on HTTP status, not definitive).
 * Note: Confluence API returns 404 for both deleted pages AND permission denied.
 */
export type InaccessibleReason =
  | "not_found" // HTTP 404 - Could be deleted, trashed, OR permissions changed
  | "forbidden" // HTTP 403 - Explicit permission denial
  | "unknown"; // Other error

/**
 * Confluence page status - all states from API.
 */
export type ContentStatus =
  | "current" // Published, visible page
  | "draft" // Unpublished draft
  | "trashed" // In trash, can be restored
  | "archived" // Archived (Cloud feature)
  | "historical"; // Previous version (shouldn't be stored, but handle gracefully)

/**
 * Content type - distinguishes pages from folders.
 * Folders are Confluence Cloud feature (Sept 2024) - containers with no content.
 */
export type ContentType =
  | "page" // Regular Confluence page with content body
  | "folder"; // Confluence Cloud folder (container only, no content)

// Import SyncState from atlcli-dir to avoid duplication
// Re-export for convenience
import type { SyncState as BaseSyncState } from "../atlcli-dir.js";
export type SyncState = BaseSyncState;

/**
 * Supported adapter types.
 */
export type AdapterType = "sqlite" | "postgres" | "json";

// ============ Record Types ============

/**
 * Page record stored in the database.
 */
export interface PageRecord {
  pageId: string;
  path: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string; // ISO timestamp
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: SyncState;
  parentId: string | null;
  ancestors: string[]; // Array of ancestor page/folder IDs
  hasAttachments: boolean;
  contentType: ContentType; // 'page' or 'folder'

  // Author and timestamps from Confluence
  createdBy: string | null; // User ID who created page
  createdAt: string; // Confluence creation date
  lastModifiedBy: string | null; // User ID who last modified
  lastModified: string | null; // Confluence last modified date

  // Content metadata from Confluence
  contentStatus: ContentStatus; // Confluence page status
  versionCount: number; // Total version count (edit history)
  wordCount: number | null; // Extracted from content
  isRestricted: boolean; // Has view/edit restrictions

  // Sync tracking
  syncCreatedAt: string; // When first synced to local
  syncUpdatedAt: string; // When last synced

  // Remote accessibility tracking
  // Note: 404 from Confluence API can mean deleted OR permission denied (security practice)
  // We cannot distinguish - only track that access was lost
  remoteInaccessibleAt: string | null; // When we lost access (NULL = accessible)
  remoteInaccessibleReason: InaccessibleReason | null;
}

/**
 * Attachment record stored in the database.
 */
export interface AttachmentRecord {
  attachmentId: string;
  pageId: string;
  filename: string;
  localPath: string;
  mediaType: string;
  fileSize: number;
  version: number;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  lastSyncedAt: string;
  syncState: SyncState;
}

/**
 * Link record for graph/audit features.
 */
export interface LinkRecord {
  id?: number; // Auto-generated
  sourcePageId: string;
  targetPageId: string | null; // null if broken/external
  targetPath: string | null; // Original path for broken links
  linkType: "internal" | "external" | "attachment" | "anchor";
  linkText: string | null;
  lineNumber: number | null;
  isBroken: boolean;
  createdAt: string;
}

/**
 * User record for audit/author tracking.
 */
export interface UserRecord {
  userId: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean | null; // null = unknown (never checked or check failed)
  lastCheckedAt: string | null; // null if never checked
}

/**
 * Label record for page labels/tags.
 */
export interface LabelRecord {
  pageId: string;
  label: string;
}

/**
 * Contributor record for page edit history.
 */
export interface ContributorRecord {
  pageId: string;
  userId: string;
  contributionCount: number;
  lastContributedAt: string | null;
}

/**
 * Content property record for key-value metadata from Confluence apps/macros.
 */
export interface ContentPropertyRecord {
  pageId: string;
  key: string;
  valueJson: unknown; // Parsed JSON value
  version: number;
  lastSyncedAt: string;
}

/**
 * Filter options for listing pages.
 */
export interface PageFilter {
  spaceKey?: string;
  syncState?: SyncState | SyncState[];
  parentId?: string;
  hasAttachments?: boolean;
  modifiedBefore?: string; // ISO timestamp - for stale detection
  modifiedAfter?: string;
  createdBefore?: string; // ISO timestamp
  createdAfter?: string;
  pathPrefix?: string; // For subtree queries
  contentStatus?: ContentStatus | ContentStatus[];
  contentType?: ContentType | ContentType[]; // Filter by page/folder
  isRestricted?: boolean;
  includeInaccessible?: boolean; // Include pages marked as inaccessible (default: false)
  createdBy?: string; // User ID filter
  lastModifiedBy?: string; // User ID filter
  hasLabel?: string; // Filter by label
  minVersionCount?: number; // Pages with at least N versions
  minWordCount?: number; // Pages with at least N words
  maxWordCount?: number; // Pages with at most N words
  limit?: number;
  offset?: number;
}

/**
 * Export format for debugging/portability.
 */
export interface SyncDbExport {
  version: number;
  exportedAt: string;
  adapter: string;
  meta: Record<string, string>;
  pages: PageRecord[];
  attachments: AttachmentRecord[];
  links: LinkRecord[];
  users: UserRecord[];
  labels: LabelRecord[];
  contributors: ContributorRecord[];
  contentProperties: ContentPropertyRecord[];
}

/**
 * Similarity search result for vector operations.
 */
export interface SimilarityResult {
  pageId: string;
  distance: number; // Lower is more similar (L2 distance)
  similarity: number; // Higher is more similar (cosine similarity)
}

/**
 * Embedding record for vector storage.
 */
export interface EmbeddingRecord {
  pageId: string;
  embedding: Float32Array;
  model: string; // e.g., "text-embedding-3-small"
  dimensions: number;
  createdAt: string;
  updatedAt: string;
}

// ============ Adapter Interface ============

/**
 * Abstract storage adapter interface.
 * Implementations: SQLite, PostgreSQL, JSON
 */
export interface SyncDbAdapter {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Pages
  getPage(pageId: string): Promise<PageRecord | null>;
  getPageByPath(path: string): Promise<PageRecord | null>;
  upsertPage(page: PageRecord): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  listPages(filter?: PageFilter): Promise<PageRecord[]>;
  countPages(filter?: PageFilter): Promise<number>;

  // Attachments
  getAttachment(attachmentId: string): Promise<AttachmentRecord | null>;
  getAttachmentsByPage(pageId: string): Promise<AttachmentRecord[]>;
  upsertAttachment(attachment: AttachmentRecord): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
  deleteAttachmentsByPage(pageId: string): Promise<void>;

  // Links (for audit/graph features)
  setPageLinks(pageId: string, links: LinkRecord[]): Promise<void>;
  getOutgoingLinks(pageId: string): Promise<LinkRecord[]>;
  getIncomingLinks(pageId: string): Promise<LinkRecord[]>;
  getOrphanedPages(): Promise<PageRecord[]>;
  getBrokenLinks(): Promise<LinkRecord[]>;
  getExternalLinks(pageId?: string): Promise<LinkRecord[]>; // All external URLs, optionally filtered by page

  // Users (for audit/author tracking)
  getUser(userId: string): Promise<UserRecord | null>;
  upsertUser(user: UserRecord): Promise<void>;
  listUsers(): Promise<UserRecord[]>;
  getOldestUserCheck(): Promise<string | null>; // Oldest lastCheckedAt for cache age display

  // Labels
  setPageLabels(pageId: string, labels: string[]): Promise<void>;
  getPageLabels(pageId: string): Promise<string[]>;
  getPagesWithLabel(label: string): Promise<PageRecord[]>;
  listAllLabels(): Promise<string[]>;

  // Contributors (page edit history)
  setPageContributors(
    pageId: string,
    contributors: ContributorRecord[]
  ): Promise<void>;
  getPageContributors(pageId: string): Promise<ContributorRecord[]>;
  getTopContributors(
    limit?: number
  ): Promise<Array<{ userId: string; pageCount: number; totalContributions: number }>>;

  // Content properties (key-value metadata from Confluence apps/macros)
  setContentProperties(
    pageId: string,
    properties: ContentPropertyRecord[]
  ): Promise<void>;
  getContentProperties(pageId: string): Promise<ContentPropertyRecord[]>;
  getContentProperty(
    pageId: string,
    key: string
  ): Promise<ContentPropertyRecord | null>;
  deleteContentProperties(pageId: string): Promise<void>;

  // Remote accessibility tracking
  // Note: 404 can mean deleted OR permission denied - we can't distinguish
  markAsInaccessible(
    pageId: string,
    reason: InaccessibleReason
  ): Promise<void>;
  getInaccessiblePages(): Promise<PageRecord[]>;
  markAsAccessible(pageId: string): Promise<void>; // Clear inaccessible state

  // Metadata
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;

  // Transactions
  transaction<T>(fn: (adapter: SyncDbAdapter) => Promise<T>): Promise<T>;

  // Export/Import (for debugging/portability)
  exportToJson(): Promise<SyncDbExport>;
  importFromJson(data: SyncDbExport): Promise<void>;

  // Adapter info
  readonly adapterType: AdapterType;
  readonly version: number;

  // Vector operations (optional - only if adapter supports)
  readonly supportsVectors: boolean;

  // Embeddings (available if supportsVectors is true)
  storeEmbedding?(
    pageId: string,
    embedding: Float32Array,
    model: string
  ): Promise<void>;
  findSimilar?(
    embedding: Float32Array,
    limit: number,
    threshold?: number
  ): Promise<SimilarityResult[]>;
  deleteEmbedding?(pageId: string): Promise<void>;
  hasEmbedding?(pageId: string): Promise<boolean>;
}

// ============ Configuration Types ============

/**
 * SQLite adapter configuration.
 */
export interface SqliteAdapterConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Enable WAL mode for better concurrent access (default: true) */
  walMode?: boolean;
  /** Enable vector support via sqlite-vec (default: false) */
  enableVectors?: boolean;
  /** Custom SQLite library path (macOS only, for sqlite-vec support) */
  customSqlitePath?: string;
}

/**
 * PostgreSQL adapter configuration.
 */
export interface PostgresAdapterConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Schema name (default: 'atlcli') */
  schema?: string;
  /** Enable SSL */
  ssl?: boolean | object;
  /** Connection pool size (default: 5) */
  poolSize?: number;
}

/**
 * JSON adapter configuration (for debugging/legacy).
 */
export interface JsonAdapterConfig {
  /** Directory containing state.json */
  atlcliDir: string;
}

/**
 * Union of all adapter configurations.
 */
export type SyncDbAdapterConfig =
  | { type: "sqlite"; config: SqliteAdapterConfig }
  | { type: "postgres"; config: PostgresAdapterConfig }
  | { type: "json"; config: JsonAdapterConfig };

// ============ Helper Types ============

/**
 * Partial page record for updates (pageId required, rest optional).
 */
export type PageRecordUpdate = Partial<PageRecord> & { pageId: string };

/**
 * Partial attachment record for updates.
 */
export type AttachmentRecordUpdate = Partial<AttachmentRecord> & {
  attachmentId: string;
};

/**
 * Create a default PageRecord with required fields.
 */
export function createPageRecord(
  partial: Partial<PageRecord> & Pick<PageRecord, "pageId" | "path" | "title" | "spaceKey">
): PageRecord {
  const now = new Date().toISOString();
  return {
    pageId: partial.pageId,
    path: partial.path,
    title: partial.title,
    spaceKey: partial.spaceKey,
    version: partial.version ?? 1,
    lastSyncedAt: partial.lastSyncedAt ?? now,
    localHash: partial.localHash ?? "",
    remoteHash: partial.remoteHash ?? "",
    baseHash: partial.baseHash ?? "",
    syncState: partial.syncState ?? "untracked",
    parentId: partial.parentId ?? null,
    ancestors: partial.ancestors ?? [],
    hasAttachments: partial.hasAttachments ?? false,
    contentType: partial.contentType ?? "page",
    createdBy: partial.createdBy ?? null,
    createdAt: partial.createdAt ?? now,
    lastModifiedBy: partial.lastModifiedBy ?? null,
    lastModified: partial.lastModified ?? null,
    contentStatus: partial.contentStatus ?? "current",
    versionCount: partial.versionCount ?? 1,
    wordCount: partial.wordCount ?? null,
    isRestricted: partial.isRestricted ?? false,
    syncCreatedAt: partial.syncCreatedAt ?? now,
    syncUpdatedAt: partial.syncUpdatedAt ?? now,
    remoteInaccessibleAt: partial.remoteInaccessibleAt ?? null,
    remoteInaccessibleReason: partial.remoteInaccessibleReason ?? null,
  };
}

/**
 * Create a default AttachmentRecord with required fields.
 */
export function createAttachmentRecord(
  partial: Partial<AttachmentRecord> &
    Pick<AttachmentRecord, "attachmentId" | "pageId" | "filename" | "localPath" | "mediaType">
): AttachmentRecord {
  const now = new Date().toISOString();
  return {
    attachmentId: partial.attachmentId,
    pageId: partial.pageId,
    filename: partial.filename,
    localPath: partial.localPath,
    mediaType: partial.mediaType,
    fileSize: partial.fileSize ?? 0,
    version: partial.version ?? 1,
    localHash: partial.localHash ?? "",
    remoteHash: partial.remoteHash ?? "",
    baseHash: partial.baseHash ?? "",
    lastSyncedAt: partial.lastSyncedAt ?? now,
    syncState: partial.syncState ?? "untracked",
  };
}
