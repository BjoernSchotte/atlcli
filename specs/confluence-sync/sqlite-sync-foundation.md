# SQLite Sync Foundation Specification

## Overview

Replace `state.json` with a database-backed storage layer using an adapter pattern. SQLite is the default, with PostgreSQL planned for power users. This foundation enables the wiki audit feature and future AI capabilities.

## Goals

1. **Replace state.json** - Move all sync metadata to SQLite for better query performance
2. **Adapter pattern** - Abstract storage to allow multiple backends (SQLite, PostgreSQL, JSON fallback)
3. **Enable audit features** - Link graph, orphan detection, stale content queries
4. **Vector embeddings support** - Optional sqlite-vec for SQLite, pgvector for PostgreSQL
5. **Zero-config default** - SQLite "just works" with no setup required

## Architecture

### Adapter Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     Command Layer                           │
│         (docs.ts, sync.ts, audit.ts, page.ts)              │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   SyncDbAdapter Interface                   │
│    getPage(), upsertPage(), listPages(), setPageLinks()    │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │   SQLite    │ │ PostgreSQL  │ │    JSON     │
   │   Adapter   │ │   Adapter   │ │   Adapter   │
   │  (default)  │ │  (future)   │ │ (fallback)  │
   └─────────────┘ └─────────────┘ └─────────────┘
         │               │               │
         ▼               ▼               ▼
   .atlcli/sync.db  PostgreSQL DB  .atlcli/state.json
```

### Why This Pattern

| Benefit | Description |
|---------|-------------|
| **Testability** | Mock adapter for unit tests without real DB |
| **Flexibility** | Swap backends without changing command code |
| **Migration path** | JSON adapter reads existing state.json during migration |
| **Debugging** | JSON adapter for human-readable state inspection |
| **Scalability** | PostgreSQL for teams/large spaces when needed |

### Command Integration

**Primary commands** (always use adapter when `.atlcli/` exists):
- `wiki docs init/pull/push/sync/status/diff/resolve/check/add`

**Smart detection for page commands:**

When `wiki page get/update/delete` operates on a page:
1. Check if `.atlcli/sync.db` exists in current directory tree
2. If yes, check if the page ID is already tracked in sync.db
3. If tracked → **auto-update** sync.db to keep it consistent
4. If not tracked → no sync.db update (unless `--track` flag is used)

```
┌─────────────────────────────────────────────────────────────┐
│                   wiki page update 12345                    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  .atlcli/ exists?     │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │ yes                   │ no
              ▼                       ▼
    ┌─────────────────────┐    ┌─────────────────────┐
    │ Page in sync.db?    │    │ Stateless API call  │
    └─────────┬───────────┘    │ (no DB interaction) │
              │                └─────────────────────┘
    ┌─────────┴─────────┐
    │ yes               │ no
    ▼                   ▼
┌───────────────┐  ┌───────────────────────┐
│ Auto-update   │  │ --track flag present? │
│ sync.db       │  └───────────┬───────────┘
└───────────────┘              │
                     ┌─────────┴─────────┐
                     │ yes               │ no
                     ▼                   ▼
               ┌───────────────┐  ┌───────────────────┐
               │ Add to        │  │ Stateless API call│
               │ sync.db       │  └───────────────────┘
               └───────────────┘
```

This ensures:
- Tracked pages stay consistent when modified via `wiki page` commands
- Untracked pages don't pollute sync.db unless explicitly requested
- No surprising behavior - users opt-in to tracking new pages

### Confluence API Version Strategy

The codebase uses a **hybrid approach** with both v1 and v2 Confluence REST APIs:

| API Version | Endpoint Pattern | Used For | Body Format |
|-------------|------------------|----------|-------------|
| **v1** | `/wiki/rest/api/content/*` | Pages, attachments, search, history | XHTML storage |
| **v2** | `/wiki/api/v2/*` | Comments, footer comments | Atlas Doc Format (ADF) |

**Why hybrid?**
- v1 API is mature, well-documented, and handles all page operations
- v2 API has different response structures and is still evolving
- Migration to v2 would require significant refactoring with minimal benefit
- v2 is used for newer features (comments) where v1 support is limited

**Storage format:** This spec assumes **XHTML storage format** from v1 API for all link extraction and content processing. The `extractLinksFromStorage()` function parses XHTML, not ADF.

**Future consideration:** If Atlassian deprecates v1, a migration path to v2/ADF would be needed. The adapter pattern isolates this - only the Confluence client and link extractor would need changes.

---

## Adapter Interface

### Core Interface

```typescript
// packages/confluence/src/sync-db/types.ts

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
  getExternalLinks(pageId?: string): Promise<LinkRecord[]>;  // All external URLs, optionally filtered by page

  // Users (for audit/author tracking)
  getUser(userId: string): Promise<UserRecord | null>;
  upsertUser(user: UserRecord): Promise<void>;
  listUsers(): Promise<UserRecord[]>;

  // Labels
  setPageLabels(pageId: string, labels: string[]): Promise<void>;
  getPageLabels(pageId: string): Promise<string[]>;
  getPagesWithLabel(label: string): Promise<PageRecord[]>;
  listAllLabels(): Promise<string[]>;

  // Contributors (page edit history)
  setPageContributors(pageId: string, contributors: ContributorRecord[]): Promise<void>;
  getPageContributors(pageId: string): Promise<ContributorRecord[]>;
  getTopContributors(limit?: number): Promise<Array<{ userId: string; pageCount: number; totalContributions: number }>>;

  // Content properties (key-value metadata from Confluence apps/macros)
  setContentProperties(pageId: string, properties: ContentPropertyRecord[]): Promise<void>;
  getContentProperties(pageId: string): Promise<ContentPropertyRecord[]>;
  getContentProperty(pageId: string, key: string): Promise<ContentPropertyRecord | null>;
  deleteContentProperties(pageId: string): Promise<void>;

  // Remote accessibility tracking
  // Note: 404 can mean deleted OR permission denied - we can't distinguish
  markAsInaccessible(pageId: string, reason: InaccessibleReason): Promise<void>;
  getInaccessiblePages(): Promise<PageRecord[]>;
  markAsAccessible(pageId: string): Promise<void>;  // Clear inaccessible state

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
  readonly adapterType: 'sqlite' | 'postgres' | 'json';
  readonly version: number;

  // Vector operations (optional - only if adapter supports)
  readonly supportsVectors: boolean;

  // Embeddings (available if supportsVectors is true)
  storeEmbedding?(pageId: string, embedding: Float32Array, model: string): Promise<void>;
  findSimilar?(embedding: Float32Array, limit: number, threshold?: number): Promise<SimilarityResult[]>;
  deleteEmbedding?(pageId: string): Promise<void>;
  hasEmbedding?(pageId: string): Promise<boolean>;
}
```

### Record Types

```typescript
export interface PageRecord {
  pageId: string;
  path: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string;      // ISO timestamp
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: SyncState;
  parentId: string | null;
  ancestors: string[];       // Array of ancestor page IDs
  hasAttachments: boolean;

  // Author and timestamps from Confluence
  createdBy: string | null;       // User ID who created page
  createdAt: string;              // Confluence creation date
  lastModifiedBy: string | null;  // User ID who last modified
  lastModified: string | null;    // Confluence last modified date

  // Content metadata from Confluence
  contentStatus: ContentStatus;   // Confluence page status
  versionCount: number;           // Total version count (edit history)
  wordCount: number | null;       // Extracted from content
  isRestricted: boolean;          // Has view/edit restrictions

  // Sync tracking
  syncCreatedAt: string;          // When first synced to local
  syncUpdatedAt: string;          // When last synced

  // Remote accessibility tracking
  // Note: 404 from Confluence API can mean deleted OR permission denied (security practice)
  // We cannot distinguish - only track that access was lost
  remoteInaccessibleAt: string | null;     // When we lost access (NULL = accessible)
  remoteInaccessibleReason: InaccessibleReason | null;
}

// Why a page became inaccessible (based on HTTP status, not definitive)
export type InaccessibleReason =
  | 'not_found'    // HTTP 404 - Could be deleted, trashed, OR permissions changed
  | 'forbidden'    // HTTP 403 - Explicit permission denial
  | 'unknown';     // Other error

// Confluence page status - all states from API
export type ContentStatus =
  | 'current'     // Published, visible page
  | 'draft'       // Unpublished draft
  | 'trashed'     // In trash, can be restored
  | 'archived'    // Archived (Cloud feature)
  | 'historical'; // Previous version (shouldn't be stored, but handle gracefully)

export type SyncState =
  | 'synced'
  | 'local-modified'
  | 'remote-modified'
  | 'conflict'
  | 'untracked';

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

export interface LinkRecord {
  id?: number;               // Auto-generated
  sourcePageId: string;
  targetPageId: string | null;  // null if broken/external
  targetPath: string | null;    // Original path for broken links
  linkType: 'internal' | 'external' | 'attachment' | 'anchor';
  linkText: string | null;
  lineNumber: number | null;
  isBroken: boolean;
  createdAt: string;
}

export interface UserRecord {
  userId: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean | null;  // null = unknown (never checked or check failed)
  lastCheckedAt: string | null;  // null if never checked
}

export interface LabelRecord {
  pageId: string;
  label: string;
}

export interface ContributorRecord {
  pageId: string;
  userId: string;
  contributionCount: number;
  lastContributedAt: string | null;
}

export interface ContentPropertyRecord {
  pageId: string;
  key: string;
  valueJson: unknown;              // Parsed JSON value
  version: number;
  lastSyncedAt: string;
}

export interface PageFilter {
  spaceKey?: string;
  syncState?: SyncState | SyncState[];
  parentId?: string;
  hasAttachments?: boolean;
  modifiedBefore?: string;   // ISO timestamp - for stale detection
  modifiedAfter?: string;
  createdBefore?: string;    // ISO timestamp
  createdAfter?: string;
  pathPrefix?: string;       // For subtree queries
  contentStatus?: ContentStatus | ContentStatus[];
  isRestricted?: boolean;
  includeInaccessible?: boolean;  // Include pages marked as inaccessible (default: false)
  createdBy?: string;        // User ID filter
  lastModifiedBy?: string;   // User ID filter
  hasLabel?: string;         // Filter by label
  minVersionCount?: number;  // Pages with at least N versions
  minWordCount?: number;     // Pages with at least N words
  maxWordCount?: number;     // Pages with at most N words
  limit?: number;
  offset?: number;
}

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

export interface SimilarityResult {
  pageId: string;
  distance: number;      // Lower is more similar (L2 distance)
  similarity: number;    // Higher is more similar (cosine similarity)
}

export interface EmbeddingRecord {
  pageId: string;
  embedding: Float32Array;
  model: string;         // e.g., "text-embedding-3-small"
  dimensions: number;
  createdAt: string;
  updatedAt: string;
}
```

---

## SQLite Schema

```sql
-- packages/confluence/src/sync-db/schema.sql

-- Schema versioning for migrations
CREATE TABLE IF NOT EXISTS schema_info (
    version INTEGER PRIMARY KEY,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pages table (replaces state.json pages + pathIndex)
CREATE TABLE IF NOT EXISTS pages (
    page_id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    space_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT NOT NULL,
    local_hash TEXT NOT NULL,
    remote_hash TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    sync_state TEXT NOT NULL DEFAULT 'synced'
        CHECK(sync_state IN ('synced','local-modified','remote-modified','conflict','untracked')),
    parent_id TEXT,
    ancestors TEXT NOT NULL DEFAULT '[]',  -- JSON array
    has_attachments INTEGER NOT NULL DEFAULT 0,

    -- Author and timestamps from Confluence
    created_by TEXT,                  -- User ID who created page
    created_at TEXT,                  -- Confluence creation timestamp
    last_modified_by TEXT,            -- User ID who last modified
    last_modified TEXT,               -- Confluence last modified timestamp

    -- Content metadata from Confluence
    content_status TEXT DEFAULT 'current'
        CHECK(content_status IN ('current','draft','trashed','archived','historical')),
    version_count INTEGER DEFAULT 1,  -- Total versions (edit history depth)
    word_count INTEGER,               -- Word count of content
    is_restricted INTEGER NOT NULL DEFAULT 0,  -- Has view/edit restrictions

    -- Sync tracking
    sync_created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- Remote accessibility tracking
    -- Note: Confluence API returns 404 for BOTH deleted pages AND permission denied (security practice)
    -- We cannot definitively distinguish - only track that access was lost
    remote_inaccessible_at TEXT,      -- When we lost access (NULL = accessible)
    remote_inaccessible_reason TEXT   -- 'not_found' | 'forbidden' | 'unknown'
        CHECK(remote_inaccessible_reason IN ('not_found','forbidden','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
CREATE INDEX IF NOT EXISTS idx_pages_space_key ON pages(space_key);
CREATE INDEX IF NOT EXISTS idx_pages_parent_id ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_sync_state ON pages(sync_state);
CREATE INDEX IF NOT EXISTS idx_pages_last_modified ON pages(last_modified);
CREATE INDEX IF NOT EXISTS idx_pages_created_by ON pages(created_by);
CREATE INDEX IF NOT EXISTS idx_pages_content_status ON pages(content_status);
CREATE INDEX IF NOT EXISTS idx_pages_is_restricted ON pages(is_restricted);
CREATE INDEX IF NOT EXISTS idx_pages_inaccessible ON pages(remote_inaccessible_at) WHERE remote_inaccessible_at IS NOT NULL;

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    local_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    local_hash TEXT NOT NULL,
    remote_hash TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    last_synced_at TEXT NOT NULL,
    sync_state TEXT NOT NULL DEFAULT 'synced'
        CHECK(sync_state IN ('synced','local-modified','remote-modified','conflict','untracked')),
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_page_id ON attachments(page_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sync_state ON attachments(sync_state);

-- Links table (for graph/audit features)
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_page_id TEXT NOT NULL,
    target_page_id TEXT,
    target_path TEXT,
    link_type TEXT NOT NULL DEFAULT 'internal'
        CHECK(link_type IN ('internal','external','attachment','anchor')),
    link_text TEXT,
    line_number INTEGER,
    is_broken INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_page_id) REFERENCES pages(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_page_id);
CREATE INDEX IF NOT EXISTS idx_links_broken ON links(is_broken) WHERE is_broken = 1;

-- Users table (for audit/author tracking)
-- is_active: 1 = active, 0 = inactive, NULL = unknown (never checked)
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    email TEXT,
    is_active INTEGER,           -- NULL = unknown, 1 = active, 0 = inactive
    last_checked_at TEXT         -- NULL if never checked via API
);

CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_last_checked ON users(last_checked_at);

-- Labels table (page labels/tags from Confluence)
CREATE TABLE IF NOT EXISTS labels (
    page_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (page_id, label),
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_labels_label ON labels(label);

-- Contributors table (page edit history - who edited what)
CREATE TABLE IF NOT EXISTS contributors (
    page_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    contribution_count INTEGER NOT NULL DEFAULT 1,
    last_contributed_at TEXT,
    PRIMARY KEY (page_id, user_id),
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors(user_id);
CREATE INDEX IF NOT EXISTS idx_contributors_count ON contributors(contribution_count DESC);

-- Content properties table (key-value metadata from Confluence apps/macros)
CREATE TABLE IF NOT EXISTS content_properties (
    page_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,           -- JSON blob (Confluence stores as JSON)
    version INTEGER NOT NULL DEFAULT 1, -- Property version for conflict detection
    last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, key),
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_properties_key ON content_properties(key);

-- Sync metadata (replaces top-level state.json fields)
CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Triggers for sync_updated_at
CREATE TRIGGER IF NOT EXISTS pages_sync_updated_at
    AFTER UPDATE ON pages
    FOR EACH ROW
BEGIN
    UPDATE pages SET sync_updated_at = datetime('now') WHERE page_id = NEW.page_id;
END;
```

### Key Queries

```sql
-- Find orphaned pages (no incoming internal links, not a child of another page)
SELECT p.*
FROM pages p
WHERE p.page_id NOT IN (
    SELECT DISTINCT target_page_id
    FROM links
    WHERE target_page_id IS NOT NULL
    AND link_type = 'internal'
)
AND p.parent_id IS NULL;

-- Find stale pages (not modified in X months)
SELECT p.*,
       ROUND((JULIANDAY('now') - JULIANDAY(p.last_modified)) / 30.44) as months_stale
FROM pages p
WHERE p.last_modified IS NOT NULL
AND JULIANDAY('now') - JULIANDAY(p.last_modified) > ?;  -- threshold in days

-- Find broken internal links
SELECT l.*, p.title as source_title, p.path as source_path
FROM links l
JOIN pages p ON l.source_page_id = p.page_id
WHERE l.is_broken = 1 AND l.link_type = 'internal';

-- Get all external links (for inventory, HTTP validation is separate Phase 6 feature)
SELECT l.*, p.title as source_title, p.path as source_path
FROM links l
JOIN pages p ON l.source_page_id = p.page_id
WHERE l.link_type = 'external'
ORDER BY p.path, l.line_number;

-- Get external links for a specific page
SELECT l.*
FROM links l
WHERE l.source_page_id = ? AND l.link_type = 'external'
ORDER BY l.line_number;

-- Find pages with deactivated creators
SELECT p.*, u.display_name as creator_name
FROM pages p
JOIN users u ON p.created_by = u.user_id
WHERE u.is_active = 0;

-- Get page with all related data
SELECT p.*,
       (SELECT COUNT(*) FROM attachments a WHERE a.page_id = p.page_id) as attachment_count,
       (SELECT COUNT(*) FROM links l WHERE l.source_page_id = p.page_id) as outgoing_link_count
FROM pages p
WHERE p.page_id = ?;

-- Find pages with specific label
SELECT p.*
FROM pages p
JOIN labels l ON p.page_id = l.page_id
WHERE l.label = ?;

-- Find pages lacking a required label (e.g., 'reviewed')
SELECT p.*
FROM pages p
WHERE p.page_id NOT IN (
    SELECT page_id FROM labels WHERE label = 'reviewed'
);

-- Get all labels with usage counts
SELECT label, COUNT(*) as page_count
FROM labels
GROUP BY label
ORDER BY page_count DESC;

-- Find pages with restricted access
SELECT p.*, u.display_name as owner_name
FROM pages p
LEFT JOIN users u ON p.created_by = u.user_id
WHERE p.is_restricted = 1;

-- Find draft or archived pages
SELECT p.*
FROM pages p
WHERE p.content_status IN ('draft', 'archived');

-- Find pages with many versions (heavily edited)
SELECT p.*, p.version_count
FROM pages p
WHERE p.version_count > ?
ORDER BY p.version_count DESC;

-- Find top contributors across all pages
SELECT u.user_id, u.display_name,
       COUNT(DISTINCT c.page_id) as pages_contributed,
       SUM(c.contribution_count) as total_edits
FROM users u
JOIN contributors c ON u.user_id = c.user_id
GROUP BY u.user_id
ORDER BY total_edits DESC
LIMIT ?;

-- Find pages where original author is inactive (verified)
SELECT p.*, u.display_name as creator_name
FROM pages p
JOIN users u ON p.created_by = u.user_id
WHERE u.is_active = 0;  -- Only verified inactive, not unknown (NULL)

-- Find pages where author status is unknown (never checked)
SELECT p.*, u.display_name as creator_name
FROM pages p
JOIN users u ON p.created_by = u.user_id
WHERE u.is_active IS NULL;

-- Comprehensive stale audit query (combines multiple signals)
-- Note: is_active can be 1 (active), 0 (inactive), or NULL (unknown)
SELECT
    p.*,
    u_creator.display_name as creator_name,
    u_creator.is_active as creator_active,      -- 1, 0, or NULL
    u_modifier.display_name as modifier_name,
    u_modifier.is_active as modifier_active,    -- 1, 0, or NULL
    ROUND((JULIANDAY('now') - JULIANDAY(p.last_modified)) / 30.44) as months_stale,
    (SELECT COUNT(*) FROM labels WHERE page_id = p.page_id) as label_count,
    (SELECT COUNT(*) FROM links WHERE target_page_id = p.page_id) as incoming_links
FROM pages p
LEFT JOIN users u_creator ON p.created_by = u_creator.user_id
LEFT JOIN users u_modifier ON p.last_modified_by = u_modifier.user_id
WHERE
    JULIANDAY('now') - JULIANDAY(p.last_modified) > ?  -- stale threshold in days
    OR u_creator.is_active = 0   -- Verified inactive creator
    OR u_modifier.is_active = 0  -- Verified inactive modifier
ORDER BY months_stale DESC;
```

---

## Configuration

### Global Config Schema

```typescript
// In ~/.atlcli/config.json
interface AtlcliConfig {
  // ... existing fields ...

  storage?: {
    adapter: 'sqlite' | 'postgres' | 'json';

    // SQLite options (optional, has sensible defaults)
    sqlite?: {
      enableVectors?: boolean;      // Load sqlite-vec extension
      customSqlitePath?: string;    // macOS: path to Homebrew SQLite
    };

    // PostgreSQL options (required if adapter = 'postgres')
    postgres?: {
      connectionString: string;  // postgresql://user:pass@host:5432/dbname
      schema?: string;           // Default: 'atlcli'
      ssl?: boolean | object;    // SSL configuration
      poolSize?: number;         // Connection pool size (default: 5)
    };

    // JSON options (for debugging/legacy)
    json?: {
      // No options needed - uses .atlcli/state.json
    };
  };

  // AI and embeddings configuration
  ai?: {
    embeddings?: {
      provider: 'openai' | 'anthropic' | 'ollama' | 'voyageai' | 'local';
      model: string;              // Model identifier (provider-specific)
      dimensions?: number;        // Override dimensions (some models allow this)
      batchSize?: number;         // Pages per batch (default: 10)

      // Provider-specific options
      openai?: {
        apiKey?: string;          // Or use OPENAI_API_KEY env var
        baseUrl?: string;         // For Azure OpenAI or proxies
      };

      anthropic?: {
        apiKey?: string;          // Or use ANTHROPIC_API_KEY env var
      };

      ollama?: {
        baseUrl?: string;         // Default: http://localhost:11434
        model?: string;           // e.g., "nomic-embed-text", "mxbai-embed-large"
      };

      voyageai?: {
        apiKey?: string;          // Or use VOYAGEAI_API_KEY env var
        model?: string;           // e.g., "voyage-3", "voyage-code-3"
      };

      local?: {
        modelPath?: string;       // Path to local ONNX model
      };
    };

    // BYOK (Bring Your Own Key) for LLM features
    llm?: {
      provider: 'openai' | 'anthropic' | 'ollama';
      model: string;
      // ... similar provider-specific options
    };
  };

  // Sync behavior configuration
  sync?: {
    // User status cache TTL in days (default: 7)
    // Users are re-checked via API when cache expires
    // Note: Audit commands use cached status and show "as of" date
    userStatusTtlDays?: number;

    // Skip user status checks entirely during pull (default: false)
    // Equivalent to always using --skip-user-check flag
    skipUserStatusCheck?: boolean;

    // Run quick audit summary after pull if audit feature is available (default: false)
    // Only triggers if `flag.audit` is enabled (audit may be a separate plugin)
    // Shows: orphan count, broken link count, stale page warnings
    postPullAuditSummary?: boolean;
  };
}
```

### Default Behavior

```typescript
function getStorageAdapter(config: AtlcliConfig): 'sqlite' | 'postgres' | 'json' {
  // Explicit configuration takes precedence
  if (config.storage?.adapter) {
    return config.storage.adapter;
  }

  // Default to SQLite
  return 'sqlite';
}
```

### Example Configurations

```json
// Default (SQLite) - no config needed
{}

// Explicit SQLite
{
  "storage": {
    "adapter": "sqlite"
  }
}

// SQLite with vector support (Linux/Windows)
{
  "storage": {
    "adapter": "sqlite",
    "sqlite": {
      "enableVectors": true
    }
  },
  "ai": {
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small"
    }
  }
}

// SQLite with vectors on macOS (requires Homebrew SQLite)
{
  "storage": {
    "adapter": "sqlite",
    "sqlite": {
      "enableVectors": true,
      "customSqlitePath": "/opt/homebrew/Cellar/sqlite/3.45.0/lib/libsqlite3.dylib"
    }
  },
  "ai": {
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small"
    }
  }
}

// PostgreSQL for teams with AI features
{
  "storage": {
    "adapter": "postgres",
    "postgres": {
      "connectionString": "postgresql://atlcli:secret@db.example.com:5432/atlcli",
      "ssl": true
    }
  },
  "ai": {
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-large",
      "dimensions": 3072
    }
  }
}

// Local embeddings with Ollama (privacy-focused)
{
  "ai": {
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text",
      "ollama": {
        "baseUrl": "http://localhost:11434"
      }
    }
  }
}

// JSON for debugging
{
  "storage": {
    "adapter": "json"
  }
}

// Custom sync settings (user status TTL, skip checks)
{
  "sync": {
    "userStatusTtlDays": 14,       // Re-check users every 14 days instead of 7
    "skipUserStatusCheck": false   // Set true to never check user status
  }
}

// Post-pull audit summary (requires audit feature/plugin)
{
  "sync": {
    "postPullAuditSummary": true   // Show audit warnings after each pull
  }
}
// Output after pull:
//   [PULL] Pulled 18 pages
//   [AUDIT] 2 orphaned pages, 1 broken link (user status as of 3 days ago)
//          Run 'atlcli audit wiki --all' for details
```

### Embeddings Model Management

**One model per sync.db** - Embeddings from different models cannot be meaningfully compared. Each sync.db stores embeddings from a single model.

**Model mismatch detection:**

When AI commands run, they check if the configured model matches stored embeddings:

```typescript
async function validateEmbeddingsModel(adapter: SyncDbAdapter, config: AiConfig): Promise<void> {
  const storedModel = await adapter.getMeta('embeddings_model');
  const configModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  if (storedModel && storedModel !== configModel) {
    console.warn(`
Warning: Configured model (${configModel}) differs from stored embeddings (${storedModel}).
Similarity search may return poor results.

Options:
  1. Change config back to: ${storedModel}
  2. Rebuild embeddings: atlcli ai rebuild-embeddings
    `);
  }
}
```

**Rebuilding embeddings:**

```bash
# Rebuild all embeddings with current configured model
atlcli ai rebuild-embeddings

# Rebuild with specific model (overrides config)
atlcli ai rebuild-embeddings --model text-embedding-3-large

# Rebuild only pages modified since last embedding
atlcli ai rebuild-embeddings --incremental

# Show current embedding status
atlcli ai embedding-status
# Output:
#   Model: openai/text-embedding-3-small
#   Dimensions: 1536
#   Pages embedded: 142/156
#   Last updated: 2024-01-15 10:30:00
```

**Common embedding models:**

| Provider | Model | Dimensions | Notes |
|----------|-------|------------|-------|
| OpenAI | text-embedding-3-small | 1536 | Good balance of cost/quality |
| OpenAI | text-embedding-3-large | 3072 | Higher quality, 2x dimensions |
| Anthropic | (TBD) | - | Anthropic embeddings API |
| Ollama | nomic-embed-text | 768 | Local, privacy-focused |
| Ollama | mxbai-embed-large | 1024 | Higher quality local option |
| VoyageAI | voyage-3 | 1024 | Optimized for retrieval |
| VoyageAI | voyage-code-3 | 1024 | Optimized for code |

---

## Migration Strategy

### Auto-Migration from state.json

When a sync operation runs and detects `state.json` but no `sync.db`:

1. **Detect**: Check for `.atlcli/state.json` existence
2. **Backup**: Copy `state.json` to `state.json.bak`
3. **Migrate**: Create `sync.db`, import all data from `state.json`
4. **Verify**: Run integrity checks on migrated data
5. **Cleanup**: Keep `state.json.bak` for safety (user can delete manually)

```typescript
// packages/confluence/src/sync-db/migrate.ts

export async function migrateFromJson(
  atlcliDir: string,
  targetAdapter: SyncDbAdapter
): Promise<MigrationResult> {
  const stateJsonPath = join(atlcliDir, 'state.json');
  const backupPath = join(atlcliDir, 'state.json.bak');

  // Check if migration needed
  if (!existsSync(stateJsonPath)) {
    return { migrated: false, reason: 'no-state-json' };
  }

  // Read existing state
  const stateJson = JSON.parse(await readFile(stateJsonPath, 'utf-8'));

  // Backup
  await copyFile(stateJsonPath, backupPath);

  // Convert and import
  const exportData = convertStateJsonToExport(stateJson);
  await targetAdapter.importFromJson(exportData);

  // Verify
  const pageCount = await targetAdapter.countPages();
  if (pageCount !== Object.keys(stateJson.pages || {}).length) {
    throw new Error('Migration verification failed: page count mismatch');
  }

  // Remove original (keep backup)
  await unlink(stateJsonPath);

  return {
    migrated: true,
    pagesCount: pageCount,
    backupPath
  };
}

function convertStateJsonToExport(state: LegacyState): SyncDbExport {
  const pages: PageRecord[] = [];
  const attachments: AttachmentRecord[] = [];

  for (const [pageId, pageState] of Object.entries(state.pages || {})) {
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
      syncState: pageState.syncState,
      parentId: pageState.parentId ?? null,
      ancestors: pageState.ancestors || [],
      hasAttachments: pageState.hasAttachments ?? false,

      // New fields - set to null/defaults during migration
      // Will be populated with real data on next pull
      createdBy: null,
      createdAt: pageState.lastSyncedAt,  // Best guess
      lastModifiedBy: null,
      lastModified: pageState.lastSyncedAt,  // Best guess
      contentStatus: 'current',
      versionCount: pageState.version || 1,
      wordCount: null,
      isRestricted: false,
      syncCreatedAt: pageState.lastSyncedAt,
      syncUpdatedAt: pageState.lastSyncedAt,
      remoteInaccessibleAt: null,     // Assume accessible during migration
      remoteInaccessibleReason: null,
    });

    // Migrate attachments
    for (const [attachmentId, attState] of Object.entries(pageState.attachments || {})) {
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
        syncState: attState.syncState,
      });
    }
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    adapter: 'json',
    meta: {
      lastSync: state.lastSync || '',
      schemaVersion: String(state.schemaVersion || 1),
    },
    pages,
    attachments,
    links: [],             // Will be populated on next pull
    users: [],             // Will be populated on next pull
    labels: [],            // Will be populated on next pull
    contributors: [],      // Will be populated on next pull
    contentProperties: [], // Will be populated on next pull
  };
}
```

---

## Implementation Plan

### Phase 0: Adapter Infrastructure + SQLite

**Files to create:**

| File | Purpose |
|------|---------|
| `packages/confluence/src/sync-db/types.ts` | Interface + record types |
| `packages/confluence/src/sync-db/sqlite-adapter.ts` | SQLite implementation |
| `packages/confluence/src/sync-db/json-adapter.ts` | JSON fallback |
| `packages/confluence/src/sync-db/migrations.ts` | Schema migrations (embedded) |
| `packages/confluence/src/sync-db/migrate-state-json.ts` | state.json → SQLite migration |
| `packages/confluence/src/sync-db/index.ts` | Factory + exports |
| `packages/confluence/src/sync-db/sqlite-adapter.test.ts` | Tests |
| `packages/confluence/src/sync-db/json-adapter.test.ts` | Tests |

**Files to modify:**

| File | Changes |
|------|---------|
| `packages/confluence/src/atlcli-dir.ts` | Replace state helpers with adapter |
| `packages/confluence/src/index.ts` | Export sync-db module |
| `packages/core/src/config.ts` | Add storage config schema |
| `apps/cli/src/commands/docs.ts` | Use adapter |
| `apps/cli/src/commands/sync.ts` | Use adapter |

### Phase 1: Link Graph Population

**Key principle**: Extract links from Confluence storage format, not converted markdown.

Confluence's storage format (XHTML/ADF) contains authoritative link data with page IDs already resolved:

```xml
<!-- Confluence XHTML storage format -->
<ac:link>
  <ri:page ri:content-id="12345678" ri:content-title="Other Page" ri:space-key="DOCS"/>
  <ac:plain-text-link-body>Click here</ac:plain-text-link-body>
</ac:link>
```

After markdown conversion, this becomes `[Click here](./other-page.md)` - losing the page ID and requiring error-prone path resolution.

**Two link extractors needed:**

| Extractor | Used When | Input | Output |
|-----------|-----------|-------|--------|
| `extractLinksFromStorage()` | During pull (remote → local) | Confluence XHTML/ADF | Links with page IDs directly |
| `extractLinksFromMarkdown()` | Local change detection | Markdown file | Links requiring path → ID resolution |

**During `wiki docs pull`:**

```
Confluence API Response (includes storage format)
    ↓
extractLinksFromStorage(page.body.storage.value)
    ↓ (page IDs, space keys, attachment IDs directly available)
adapter.setPageLinks(pageId, links)
    ↓
convertToMarkdown() (for local file, separate step)
```

**During local change detection (`wiki docs status`, `wiki docs push`):**

```
Local markdown file
    ↓
extractLinksFromMarkdown(markdown)
    ↓
Resolve paths to page IDs using adapter.getPageByPath()
    ↓
Compare with stored links to detect changes
```

**Files to create:**

| File | Purpose |
|------|---------|
| `packages/confluence/src/link-extractor-storage.ts` | Extract links from Confluence XHTML/ADF |
| `packages/confluence/src/link-extractor-markdown.ts` | Extract links from local markdown |

**Why not just use markdown?**

- Confluence storage has page IDs already (no resolution needed)
- No risk of conversion errors losing or mangling links
- Cross-space links have explicit space keys
- Attachment links have proper IDs and versions
- Consistent with other metadata (title, author, etc.) coming from API directly

**Link graph maintenance:**

| Scenario | Solution |
|----------|----------|
| Links stale from Confluence changes | Run `wiki docs pull` - re-extracts links from remote storage format |
| Links stale from local file edits | Run `wiki docs status --links` - re-analyzes local markdown |
| Link extraction logic was fixed | Run `wiki docs pull` to re-extract with fixed logic |
| Need full rebuild from local | Use `--rebuild-graph` flag (audit command) |

**Key decision**: No separate `--refresh-links` command. If remote links are stale, `pull` already handles it by extracting links from Confluence storage format during the pull process. This keeps the workflow simple: `pull` refreshes everything from remote, including links.

The `--rebuild-graph` flag (in audit command) is only needed when:
1. Local markdown was edited outside of sync workflow
2. Link extraction from markdown logic changed
3. Database was corrupted or manually edited

### Phase 2: Users and Contributors

**Users table population:**

During pull, extract user IDs from page metadata:
- `createdBy` - page creator
- `lastModifiedBy` - last editor

**User status checking (Option B: check new users during pull):**

```
Pull completes
    ↓
Collect all user IDs encountered during pull
    ↓
Filter to users not in cache OR cache expired (TTL)
    ↓
Batch check via Confluence User API
    ↓
Store in users table with lastCheckedAt timestamp
```

**Three-state `isActive`:**
```typescript
isActive: boolean | null;  // null = never checked (unknown)
```

| Value | Meaning |
|-------|---------|
| `true` | User is active (verified via API) |
| `false` | User is inactive/deactivated (verified via API) |
| `null` | Unknown - never checked or check failed |

**TTL-based caching:**

User status is cached with configurable TTL (default: 7 days). Users are only re-checked when:
- Not in cache at all (new user)
- Cache expired (`lastCheckedAt` older than TTL)
- Explicit `--refresh-users` flag

**Cache staleness visibility:**

Commands consuming user data should indicate cache freshness:
```
# Status output shows cache age
User status: 3 users checked (as of 2 days ago)

# Audit output shows when user data may be stale
[AUDIT] 2 pages with inactive authors (user status as of 5 days ago)
        Run with --refresh-users for fresh data
```

The `lastCheckedAt` field in users table enables this. Commands can query:
```sql
SELECT MIN(last_checked_at) as oldest_check FROM users WHERE last_checked_at IS NOT NULL
```

**CLI flags:**

```bash
# Normal pull - checks new/expired users (default)
atlcli wiki docs pull

# Fast pull - skip all user status checks
atlcli wiki docs pull --skip-user-check

# Force refresh - re-check ALL users regardless of TTL
atlcli wiki docs pull --refresh-users
```

**Contributors table - default behavior:**

By default, the contributors table is populated with only two entries per page:
1. Creator (from `history.createdBy`)
2. Last modifier (from `history.lastUpdated.by`)

This requires **zero additional API calls** since this data is already in the page response.

**Full contributor history - opt-in:**

For complete contributor data, users can run:
```bash
atlcli wiki docs pull --fetch-contributors
```

This fetches full version history (`/content/{id}/version`) and extracts all unique contributors. **Warning:** This requires N API calls per page where N = version count.

**Post-pull audit integration:**

When `sync.postPullAuditSummary` is enabled AND the audit feature is available (via `flag.audit`), pull shows a quick summary:

```
[PULL] Pulled 18 pages, 3 modified
[AUDIT] 2 orphaned pages, 1 broken link (user status as of 2 days ago)
        Run 'atlcli audit wiki --all' for details
```

Implementation approach:
1. After pull completes, check if audit feature is available (dynamic import or flag check)
2. If available, run quick queries: `getOrphanedPages().length`, `getBrokenLinks().length`
3. Show summary line with counts and cache age
4. This is lightweight - no threshold calculations, just counts

This allows the sync workflow to benefit from audit insights without hard-coupling to the audit feature, which may be a separate plugin/repo.

### Phase 3: Audit Feature

- See `spec/internal/wiki-audit-stale.md` for full audit specification
- Audit commands use adapter queries directly

### Phase 4: Vector Embeddings Support (AI Features)

Vector embeddings enable semantic search and AI features like `atlcli ai ask`.

#### Research Findings

| Technology | Status | Notes |
|------------|--------|-------|
| **sqlite-vec** | Recommended for SQLite | Pure C, no dependencies, SIMD-accelerated (AVX/NEON), Mozilla Builders project |
| **pgvector** | Recommended for PostgreSQL | Mature, production-ready, widely used |
| **Bun SQLite extensions** | Supported with caveats | `db.loadExtension()` works, but macOS requires workaround |

#### Platform Considerations

**Linux/Windows**: Extensions load normally via `db.loadExtension("sqlite-vec")`

**macOS Issue**: Apple's bundled SQLite **disables extension loading**. Workaround required:
```typescript
// macOS only - requires Homebrew SQLite installation
import { Database } from "bun:sqlite";

// Point to vanilla SQLite before creating any Database instances
Database.setCustomSQLite("/opt/homebrew/Cellar/sqlite/<version>/libsqlite3.dylib");

const db = new Database("sync.db");
db.loadExtension("sqlite-vec");
```

#### Hybrid Approach

Both SQLite and PostgreSQL can support vectors, with different tradeoffs:

| Backend | Vector Extension | Best For | Platform Issues |
|---------|------------------|----------|-----------------|
| SQLite + sqlite-vec | Optional, opt-in | Quick local experiments, small-medium spaces | macOS needs Homebrew SQLite |
| PostgreSQL + pgvector | Built-in | Power users, teams, production AI | Requires PostgreSQL server |

#### Configuration

```json
{
  "storage": {
    "adapter": "sqlite",
    "sqlite": {
      "enableVectors": true,        // Opt-in, loads sqlite-vec extension
      "customSqlitePath": "/opt/homebrew/Cellar/sqlite/3.45.0/lib/libsqlite3.dylib"  // macOS only
    }
  }
}

// Or with PostgreSQL (vectors always available)
{
  "storage": {
    "adapter": "postgres",
    "postgres": {
      "connectionString": "postgresql://user:pass@host:5432/atlcli"
    }
  }
}
```

#### SQLite Vector Schema (when enableVectors: true)

```sql
-- Embeddings table using sqlite-vec virtual table
CREATE VIRTUAL TABLE embeddings USING vec0(
    page_id TEXT PRIMARY KEY,
    embedding FLOAT[1536],  -- Dimension depends on model
    +model TEXT,
    +created_at TEXT,
    +updated_at TEXT
);

-- Or standard table with BLOB storage (fallback)
CREATE TABLE embeddings (
    page_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,        -- Float32Array serialized
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
);
```

#### Implementation Phases

- **Phase 4a**: Add `supportsVectors` flag to adapter interface
- **Phase 4b**: Implement sqlite-vec support in SqliteAdapter (opt-in via config)
- **Phase 4c**: Implement pgvector support in PostgresAdapter
- **Phase 4d**: AI commands (`atlcli ai ask`, `atlcli ai explain`) use adapter's vector methods

### Phase 5: PostgreSQL Adapter

- Create `packages/confluence/src/sync-db/postgres-adapter.ts`
- Same interface as SQLite, different backend
- Built-in pgvector support (no extension loading complexity)
- Connection pooling via `pg-pool`
- SSL/TLS configuration for secure connections

---

## File Structure

```
packages/confluence/src/sync-db/
├── types.ts              # SyncDbAdapter interface, record types
├── index.ts              # createSyncDb() factory, exports
├── sqlite-adapter.ts     # SQLite implementation
├── json-adapter.ts       # JSON/state.json fallback
├── migrate.ts            # state.json → SQLite migration
├── schema.sql            # SQLite schema (embedded in sqlite-adapter)
├── sqlite-adapter.test.ts
└── json-adapter.test.ts
```

---

## Compatibility

### Backwards Compatibility

- **Existing state.json**: Auto-migrated to SQLite on first operation
- **JSON adapter**: Available via config for debugging or edge cases
- **Function signatures**: `readState/writeState` wrappers maintained during transition

### Breaking Changes

- `.atlcli/state.json` replaced by `.atlcli/sync.db`
- Old CLI versions won't understand new format
- Mitigation: JSON adapter allows reverting if needed

### Version Support

| atlcli Version | state.json | sync.db | Migration |
|----------------|------------|---------|-----------|
| < 0.11.0 | Read/Write | N/A | N/A |
| >= 0.11.0 | Read-only (migrate) | Read/Write | Auto |

---

## Testing Strategy

### Unit Tests

```typescript
// Test both adapters with same test suite
describe.each([
  ['sqlite', () => new SqliteAdapter(':memory:')],
  ['json', () => new JsonAdapter(tempDir)],
])('%s adapter', (name, createAdapter) => {
  let adapter: SyncDbAdapter;

  beforeEach(async () => {
    adapter = createAdapter();
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  test('upsert and get page', async () => {
    const page: PageRecord = { /* ... */ };
    await adapter.upsertPage(page);
    const retrieved = await adapter.getPage(page.pageId);
    expect(retrieved).toEqual(page);
  });

  test('list pages with filter', async () => {
    // Insert multiple pages
    // Filter by syncState, spaceKey, etc.
  });

  test('orphan detection', async () => {
    // Insert pages with/without incoming links
    // Verify getOrphanedPages() returns correct set
  });

  // ... more tests
});
```

### Integration Tests

```bash
# E2E test with real Confluence
cd /tmp/test-sqlite
bun run --cwd ~/code/atlcli/apps/cli src/index.ts wiki docs init --space DOCSY
bun run --cwd ~/code/atlcli/apps/cli src/index.ts wiki pull

# Verify SQLite created
ls -la .atlcli/
# Should show: sync.db (not state.json)

# Inspect database
sqlite3 .atlcli/sync.db ".tables"
sqlite3 .atlcli/sync.db "SELECT COUNT(*) FROM pages"
sqlite3 .atlcli/sync.db "SELECT COUNT(*) FROM links"

# Test all sync operations
bun run --cwd ~/code/atlcli/apps/cli src/index.ts wiki docs status
bun run --cwd ~/code/atlcli/apps/cli src/index.ts wiki docs push
bun run --cwd ~/code/atlcli/apps/cli src/index.ts wiki docs diff
```

---

## Performance Considerations

### SQLite Optimizations

- **WAL mode**: Enabled by default for better concurrent read/write
- **Indexes**: On frequently queried columns (path, sync_state, parent_id)
- **Prepared statements**: Reuse for repeated queries
- **Batch operations**: Transaction wrapping for bulk updates

### Expected Performance

| Operation | state.json | SQLite | Improvement |
|-----------|------------|--------|-------------|
| Get page by ID | O(1) | O(1) | Same |
| Get page by path | O(1) | O(1) | Same |
| Find by sync_state | O(n) | O(log n) | Better |
| Find orphans | N/A | O(n) query | New capability |
| Count pages | O(n) | O(1) | Better |
| Large space (1000+ pages) | Slow JSON parse | Fast queries | Much better |

---

## Security Considerations

- **SQLite file permissions**: Inherits directory permissions
- **PostgreSQL credentials**: Stored in config, not in repo
- **No sensitive data in links table**: Only structural information
- **Export function**: Can expose all sync data - document clearly

---

## Schema Migrations

### Strategy: Embedded Migrations

Migrations are defined as typed objects in code, executed sequentially by version number.

```typescript
// packages/confluence/src/sync-db/migrations.ts

interface Migration {
  version: number;
  description: string;
  up: string;      // SQL to apply migration
  down?: string;   // SQL to rollback (optional, for development)
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: `
      CREATE TABLE schema_info (...);
      CREATE TABLE pages (...);
      CREATE TABLE attachments (...);
      CREATE TABLE links (...);
      CREATE TABLE users (...);
      CREATE TABLE labels (...);
      CREATE TABLE contributors (...);
      CREATE TABLE content_properties (...);
      CREATE TABLE sync_meta (...);
    `,
  },
  {
    version: 2,
    description: "Add embeddings table",
    up: `
      CREATE TABLE embeddings (...);
    `,
    down: `DROP TABLE embeddings;`
  },
  // Future migrations added here
];
```

### Migration Execution

```typescript
async function runMigrations(db: Database): Promise<void> {
  // Get current version
  const currentVersion = await getCurrentSchemaVersion(db);

  // Find pending migrations
  const pending = migrations.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    return; // Already up to date
  }

  // Run in transaction for atomicity
  db.transaction(() => {
    for (const migration of pending) {
      console.log(`Applying migration ${migration.version}: ${migration.description}`);
      db.exec(migration.up);

      // Record migration
      db.prepare(`
        INSERT INTO schema_info (version, migrated_at)
        VALUES (?, datetime('now'))
      `).run(migration.version);
    }
  })();
}

async function getCurrentSchemaVersion(db: Database): Promise<number> {
  try {
    const result = db.prepare(`
      SELECT MAX(version) as version FROM schema_info
    `).get() as { version: number | null };
    return result?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}
```

### Migration Rules

1. **Additive preferred**: Add columns/tables rather than modify existing
2. **Non-breaking**: Existing data must remain valid after migration
3. **Atomic**: Each migration runs in a transaction
4. **Idempotent checks**: Use `IF NOT EXISTS` for safety
5. **No data loss**: Never drop columns with data without explicit user action

### Handling Breaking Changes

For rare breaking changes (e.g., column rename with data):

```typescript
{
  version: 5,
  description: "Rename author_id to created_by",
  up: `
    -- SQLite doesn't support RENAME COLUMN in older versions
    -- Create new table, copy data, swap
    CREATE TABLE pages_new (..., created_by TEXT, ...);
    INSERT INTO pages_new SELECT ..., author_id as created_by, ... FROM pages;
    DROP TABLE pages;
    ALTER TABLE pages_new RENAME TO pages;
  `,
}
```

### Version Compatibility

| atlcli Version | Schema Version | Notes |
|----------------|----------------|-------|
| 0.11.0 | 1 | Initial SQLite release |
| 0.12.0 | 2 | Add embeddings table |
| 0.13.0 | 3 | Add content_properties |

---

## Related Specifications

- `spec/wiki-audit-stale.md` - Audit feature built on this foundation
- `spec/internal/confluence-ai-landscape-research.md` - AI features requiring embeddings

---

## Open Questions

1. ~~**Schema migrations**: How to handle future schema changes?~~
   - ✅ Resolved: See "Schema Migrations" section - embedded migrations in code

2. **Concurrent access**: Multiple CLI instances accessing same DB?
   - SQLite WAL mode handles this; PostgreSQL has proper locking

3. **DB size limits**: Very large spaces with many pages?
   - SQLite handles millions of rows; PostgreSQL for extreme cases

4. **Backup strategy**: How to backup sync.db?
   - Export to JSON via `adapter.exportToJson()`, or standard SQLite backup tools

5. **Content property filtering**: Should we only sync specific property keys?
   - Current: Sync all properties
   - Alternative: Config option to filter by key prefix (e.g., `atlcli.*`)

6. ~~**Trashed page handling**: How to handle pages moved to trash?~~
   - ✅ Resolved: See note below about inaccessible pages

7. **Inaccessible page ambiguity**: Confluence API returns 404 for both deleted pages AND permission denied (security practice). We cannot distinguish between:
   - Page was deleted/trashed
   - Page permissions were changed (user lost access)
   - Page moved to restricted space

   Current approach: Track as `remote_inaccessible_at` + `remote_inaccessible_reason` (honest about what we know).

   Future enhancement: Could check space trash via `GET /wiki/rest/api/space/{key}/content/trash` to confirm if truly trashed, but requires extra API calls.

8. **Inaccessible page cleanup**: When should inaccessible pages be removed from sync.db?
   - Current: Keep indefinitely with inaccessible flag
   - Alternative: `atlcli wiki docs cleanup --inaccessible-older-than 30d`
   - Alternative: Prompt user during `wiki docs status` if inaccessible pages exist
