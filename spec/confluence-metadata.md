# Confluence Metadata Enhancement Spec

## Overview

Expand metadata fetched from Confluence Cloud REST API to enable audit, knowledge graph, and AI features.

## Currently Fetched

| Field | Source | Used In |
|-------|--------|---------|
| id, title, version | `/content/{id}` | All operations |
| spaceKey, parentId, ancestors | `expand=space,ancestors` | Hierarchy |
| createdBy, modifiedBy | `expand=history` | Attribution |
| created, modified timestamps | `expand=history.lastUpdated` | Freshness |
| labels | `expand=metadata.labels` | Categorization |
| editor version | `expand=metadata.properties.editor` | Audit |

## Proposed Additions

### Phase 0: Body Parsing Infrastructure

Before implementing content analysis features, establish parsing infrastructure.

**Storage Format (XML) vs ADF (JSON):**
- **Storage format**: XML-based, contains `<ac:task-list>`, `<ac:link>`, `<ac:structured-macro>`
- **ADF (Atlas Doc Format)**: JSON structure, modern editor format

**Recommendation**: Use Storage format for parsing - it's the canonical format and contains all macro information.

**Parser implementation:**

```typescript
interface ParsedContent {
  tasks: Array<{ id: string; status: 'complete' | 'incomplete'; text: string }>;
  links: Array<{ targetId?: string; targetUrl?: string; type: 'page' | 'attachment' | 'external' }>;
  mentions: Array<{ accountId: string }>;
  macros: Array<{ name: string; parameters: Record<string, string> }>;
}

function parseStorageFormat(storage: string): ParsedContent {
  // Use fast XML parser (fast-xml-parser or similar)
  // Handle malformed content gracefully
  // Return empty arrays on parse failure, don't throw
}
```

**When to parse:**
- On-demand (not during pull) to avoid slowing sync
- Cache results in sync.db
- Invalidate cache when page version changes

### Phase 1: Audit & Compliance (Low Effort)

These fields can be fetched with existing expand parameters.

| Field | Expand Parameter | Notes |
|-------|------------------|-------|
| Version message | `version.message` | Change descriptions |
| Minor edit flag | `version.minorEdit` | Filter trivial changes |
| Content status | `status` | current/draft/archived/trashed |

**Add to `getPageDetails()` expand:**
```typescript
expand: "version,version.message,status,..."
```

**Update ConfluencePageDetails type:**
```typescript
interface ConfluencePageDetails {
  // existing fields...
  versionMessage?: string;
  isMinorEdit?: boolean;
  status: 'current' | 'draft' | 'archived' | 'trashed';
}
```

### Phase 2: Restrictions

**API Verification Required:**
- [ ] Verify `expand=restrictions` response format
- [ ] Check if admin access is required
- [ ] Test with read-only and edit restrictions

**Actual API response structure** (needs verification):
```typescript
interface ContentRestrictions {
  read?: {
    operation: 'read';
    restrictions: {
      user?: { results: Array<{ accountId: string; displayName: string }> };
      group?: { results: Array<{ name: string; id: string }> };
    };
  };
  update?: {
    operation: 'update';
    restrictions: {
      user?: { results: Array<{ accountId: string; displayName: string }> };
      group?: { results: Array<{ name: string; id: string }> };
    };
  };
}
```

**Simplified storage:**
```typescript
interface PageRestrictions {
  hasReadRestrictions: boolean;
  hasEditRestrictions: boolean;
  readUserCount: number;
  readGroupCount: number;
  editUserCount: number;
  editGroupCount: number;
}
```

### Phase 3: Analytics & Engagement

**API Verification Required:**
- [ ] Verify `/wiki/rest/api/analytics/content/{id}/views` endpoint exists
- [ ] Verify `/wiki/rest/api/analytics/content/{id}/viewers` endpoint exists
- [ ] Check required OAuth scope: `read:analytics.content:confluence`
- [ ] Confirm Premium/Enterprise requirement

**Fallback if unavailable:**
- Analytics features gracefully degrade
- Show "Analytics unavailable (requires Premium)" message
- Don't fail operations, just omit analytics data

**Caching strategy:**
- View counts don't change rapidly
- Cache for 24 hours in sync.db
- Add `analytics_updated_at` timestamp column

### Phase 4: Content Properties (Custom Metadata)

| Operation | API Endpoint | Notes |
|-----------|--------------|-------|
| Get property | `GET /content/{id}/property/{key}` | Returns JSON |
| Set property | `POST /content/{id}/property` | Max 32KB per property |
| List properties | `GET /content/{id}/property` | All custom properties |

**Use cases:**
- Custom classification tags
- Workflow state tracking
- Integration metadata (sync status, external IDs)

**NOT for embeddings** - 32KB limit is too restrictive. Use local storage instead.

### Phase 5: Structured Content Analysis

Parse storage format to extract:

| Element | XML Pattern | Extracted Data |
|---------|-------------|----------------|
| Tasks | `<ac:task-list>`, `<ac:task>` | id, status, body text |
| Page links | `<ac:link><ri:page ri:content-id="..."/>` | target page ID |
| External links | `<a href="...">` | URL |
| Mentions | `<ac:link><ri:user ri:account-id="..."/>` | account ID |
| Macros | `<ac:structured-macro ac:name="...">` | name, parameters |

**Performance consideration:**
- Don't parse during pull (too slow)
- Parse on-demand for audit/graph commands
- Cache parsed results in sync.db

## Feature Implementations

### 1. Content Health Audit

```
atlcli audit wiki --health [dir]
```

Metrics:
- **Freshness score**: Days since last modified
- **Orphan status**: Missing/broken ancestor chain
- **View/edit ratio**: Popular but unmaintained detection (requires analytics)
- **Contributor count**: Bus factor analysis
- **Task completion**: Open vs completed tasks (requires parsing)

### 2. Permission Audit

```
atlcli audit wiki --permissions [dir]
```

Report:
- Pages with custom restrictions
- Restriction summary (user/group counts)
- Public vs restricted content ratio

**Note**: Cannot show full user/group details without admin access or fetching each restriction separately.

### 3. Knowledge Graph Export

```
atlcli wiki docs graph [dir] --format dot|json
```

Nodes: Pages, users (optional), spaces
Edges: Parent-child, links, mentions (optional), attachments

**Considerations:**
- Cross-space links: Include if accessible, mark as external if not
- Deleted pages: Exclude from graph, note broken links
- Large graphs: Offer filtering by subtree or depth

### 4. AI/Embedding Support

```
atlcli wiki docs embed [dir] --provider openai|ollama
```

**Storage: Local vector database** (not Confluence content properties)

Options:
- `sqlite-vss` - SQLite extension for vector search
- `vectra` - Pure JS vector DB
- Local file with HNSW index

**Chunking strategy:**
- Split pages by headings or fixed token count
- Store chunk metadata (page ID, position, heading)
- Typical chunk: 500-1000 tokens

**Incremental updates:**
- Track content hash per page
- Re-embed only changed pages
- Delete embeddings for removed pages

```
atlcli wiki docs search --semantic "how do I configure authentication"
```

## Data Model Extensions

### Extended ConfluencePageDetails

```typescript
interface ConfluencePageDetails {
  // Existing fields...
  id: string;
  title: string;
  version: number;
  // ...

  // Phase 1 additions
  versionMessage?: string;
  isMinorEdit?: boolean;
  status: 'current' | 'draft' | 'archived' | 'trashed';

  // Phase 2 additions (optional, requires extra API call)
  restrictions?: PageRestrictions;

  // Phase 3 additions (optional, requires Premium + extra API call)
  analytics?: {
    viewCount: number;
    distinctViewers: number;
    fetchedAt: string;
  };
}

interface PageRestrictions {
  hasReadRestrictions: boolean;
  hasEditRestrictions: boolean;
  readUserCount: number;
  readGroupCount: number;
  editUserCount: number;
  editGroupCount: number;
}
```

### Database Schema (sync.db)

Use migrations or conditional column addition:

```sql
-- Migration 001: Add metadata columns
-- Check if columns exist before adding (SQLite doesn't support IF NOT EXISTS for columns)

-- For new installations, these are part of initial schema
-- For existing installations, run migration

-- Phase 1: Basic metadata
ALTER TABLE pages ADD COLUMN version_message TEXT;
ALTER TABLE pages ADD COLUMN is_minor_edit INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN status TEXT DEFAULT 'current';

-- Phase 2: Restrictions (summary only)
ALTER TABLE pages ADD COLUMN has_read_restrictions INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN has_edit_restrictions INTEGER DEFAULT 0;

-- Phase 3: Analytics cache
ALTER TABLE pages ADD COLUMN view_count INTEGER;
ALTER TABLE pages ADD COLUMN distinct_viewers INTEGER;
ALTER TABLE pages ADD COLUMN analytics_updated_at TEXT;

-- Phase 5: Parsed content cache
CREATE TABLE IF NOT EXISTS page_tasks (
  page_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'complete' or 'incomplete'
  body TEXT,
  PRIMARY KEY (page_id, task_id),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Allow duplicate links
  page_id TEXT NOT NULL,
  target_type TEXT NOT NULL,  -- 'page', 'attachment', 'external'
  target_id TEXT,             -- For page/attachment links
  target_url TEXT,            -- For external links
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_links_page ON page_links(page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_id);

CREATE TABLE IF NOT EXISTS page_mentions (
  page_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (page_id, account_id),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  macro_name TEXT NOT NULL,
  parameters TEXT,  -- JSON
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_macros_page ON page_macros(page_id);
CREATE INDEX IF NOT EXISTS idx_page_macros_name ON page_macros(macro_name);

-- Parsed content cache metadata
ALTER TABLE pages ADD COLUMN content_parsed_at TEXT;
ALTER TABLE pages ADD COLUMN content_parsed_version INTEGER;
```

### Embedding Storage (separate from sync.db)

```sql
-- embeddings.db (separate file, can be large)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  heading TEXT,
  token_count INTEGER,
  content_hash TEXT NOT NULL,
  UNIQUE(page_id, chunk_index)
);

CREATE TABLE embeddings (
  chunk_id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL,  -- Float32 array
  model TEXT NOT NULL,      -- e.g., 'text-embedding-3-small'
  dimensions INTEGER NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_page ON chunks(page_id);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);
```

## API Considerations

### Rate Limits
- Analytics endpoints: May have separate rate limit pool
- Restrictions: One call per page (batch where possible)
- Content properties: Standard rate limits

### Permissions
- Analytics: Requires Premium/Enterprise + OAuth scope
- Restrictions: May require admin access for full details
- Content properties: Readable by anyone with page access

### Not Available via API
- **Backlinks/incoming links**: Must compute from all pages (O(n) parsing)
- **Word count**: Must calculate from body
- **Reading time**: Must calculate (word count / 200 wpm)
- **Inherited permissions**: Only direct restrictions visible

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Analytics API unavailable | Skip analytics, log info message |
| Restrictions API fails | Set `hasRestrictions: null` (unknown) |
| Content parsing fails | Log warning, return empty ParsedContent |
| Premium feature on Free tier | Graceful degradation, show upgrade hint |

## Implementation Priority

| Priority | Feature | Effort | Dependencies |
|----------|---------|--------|--------------|
| 1 | Version message, minor edit, status | 2h | None |
| 2 | Body parsing infrastructure | 4h | None |
| 3 | Restrictions (summary) | 3h | API verification |
| 4 | Content analysis (tasks, links) | 4h | Body parsing |
| 5 | Knowledge graph export | 6h | Content analysis |
| 6 | Analytics integration | 4h | API verification, Premium |
| 7 | Embedding support | 8h | Body parsing |

## Verification Checklist

Before implementation:
- [ ] Verify `expand=restrictions` response format with real API call
- [ ] Verify analytics endpoint paths and response format
- [ ] Confirm OAuth scope required for analytics
- [ ] Test storage format parsing with real page content
- [ ] Benchmark parsing performance on large pages
- [ ] Test SQLite migration on existing sync.db files

## Resolved Questions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Analytics opt-in? | Yes, default off | Requires Premium + extra scope |
| Metadata storage? | sync.db for metadata, separate for embeddings | Keeps sync.db small |
| Knowledge graph target? | Local export (dot/json) | External tools can import |
| Embedding storage? | Local sqlite-vss or vectra | 32KB property limit too small |
| Body parsing format? | Storage (XML) | Contains all macro information |
| When to parse? | On-demand, cached | Don't slow down pull |

## Open Questions

1. Should backlinks be computed during pull or on-demand? (expensive for large spaces)
2. Knowledge graph: include users as nodes or just page relationships?
3. Embedding chunking: by heading, fixed tokens, or semantic boundaries?
