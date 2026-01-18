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

### Phase 1: Analytics & Engagement

| Field | API Endpoint | Expand | Notes |
|-------|--------------|--------|-------|
| View count | `/analytics/content/{id}/views` | - | Total all-time views |
| Distinct viewers | `/analytics/content/{id}/viewers` | - | Unique user count |
| **Requires**: `Granular:read:analytics.content:confluence` scope (Premium+ plans) |

**Use cases:**
- Identify popular vs neglected content
- Prioritize migration/cleanup efforts
- Stakeholder analysis

### Phase 2: Audit & Compliance

| Field | API Endpoint | Expand | Notes |
|-------|--------------|--------|-------|
| Restrictions | `/content/{id}?expand=restrictions` | `restrictions` | Read/edit permissions |
| Version message | `/content/{id}/version` | `version.message` | Change descriptions |
| Minor edit flag | `/content/{id}` | `version.minorEdit` | Filter trivial changes |
| Content status | `/content/{id}` | `status` | current/draft/archived |

**Use cases:**
- Permission audit reports
- Change tracking and audit trail
- Draft detection
- Compliance reporting

### Phase 3: Content Properties (Custom Metadata)

| Field | API Endpoint | Notes |
|-------|--------------|-------|
| Get property | `GET /content/{id}/property/{key}` | Arbitrary JSON |
| Set property | `POST /content/{id}/property` | Max 32KB per property |
| List properties | `GET /content/{id}/property` | All custom metadata |

**Use cases:**
- Store embeddings for semantic search
- Custom classification tags
- Workflow state tracking
- Integration metadata (sync status, external IDs)

### Phase 4: Structured Content Analysis

| Field | API Endpoint | Expand | Notes |
|-------|--------------|--------|-------|
| ADF body | `/content/{id}` | `body.atlas_doc_format` | JSON structure |
| Task lists | Parse from body | - | `<ac:task-list>` elements |
| Outgoing links | Parse from body | - | `<ac:link>` elements |
| Mentions | Parse from body | - | `<ri:user>` elements |
| Macros | Parse from body | - | `<ac:structured-macro>` |

**Use cases:**
- Task completion tracking
- Knowledge graph (link relationships)
- Mention analysis
- Macro inventory

## Feature Implementations

### 1. Content Health Audit

```
atlcli audit wiki --health [dir]
```

Metrics:
- **Freshness score**: Days since last modified
- **Orphan status**: Missing/broken ancestor chain
- **View/edit ratio**: Popular but unmaintained detection
- **Contributor count**: Bus factor analysis
- **Task completion**: Open vs completed tasks

### 2. Permission Audit

```
atlcli audit wiki --permissions [dir]
```

Report:
- Pages with custom restrictions
- Restriction inheritance gaps
- User/group access matrix
- Public vs restricted content ratio

### 3. Knowledge Graph Export

```
atlcli wiki graph [dir] --format dot|json
```

Nodes: Pages, users, spaces
Edges: Parent-child, links, mentions, attachments

### 4. AI/Embedding Support

```
atlcli wiki embed [dir] --provider openai|local
```

- Generate embeddings from page content
- Store in content properties (or local DB)
- Enable semantic search: `atlcli wiki search --semantic "query"`

## API Considerations

### Rate Limits
- Analytics endpoints: separate rate limit pool
- Batch requests where possible
- Cache aggressively (views don't change frequently)

### Permissions
- Analytics requires Premium/Enterprise
- Restrictions visible only if user has admin access
- Content properties readable by anyone with page access

### Not Available via API
- Backlinks/incoming links (must compute from all pages)
- Word count (must calculate)
- Reading time (must calculate)
- Inherited permissions (only direct restrictions visible)

## Data Model Extensions

### PageMetadata (new type)

```typescript
interface PageMetadata {
  // Analytics (Premium+)
  viewCount?: number;
  distinctViewers?: number;

  // Audit
  restrictions?: {
    read: { users: string[]; groups: string[] };
    edit: { users: string[]; groups: string[] };
  };
  status: 'current' | 'draft' | 'archived';

  // Version details
  versionMessage?: string;
  isMinorEdit?: boolean;

  // Computed
  taskCount?: { total: number; completed: number };
  outgoingLinks?: string[]; // page IDs
  mentions?: string[]; // account IDs
  macros?: string[]; // macro names used
}
```

### Database Schema (sync.db)

```sql
-- Page metadata cache
ALTER TABLE pages ADD COLUMN view_count INTEGER;
ALTER TABLE pages ADD COLUMN distinct_viewers INTEGER;
ALTER TABLE pages ADD COLUMN has_restrictions BOOLEAN DEFAULT FALSE;
ALTER TABLE pages ADD COLUMN status TEXT DEFAULT 'current';

-- Link graph
CREATE TABLE page_links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  link_type TEXT NOT NULL, -- 'page', 'attachment', 'external'
  PRIMARY KEY (source_id, target_id, link_type)
);

-- Mentions
CREATE TABLE page_mentions (
  page_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (page_id, account_id)
);

-- Custom properties cache
CREATE TABLE page_properties (
  page_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL, -- JSON
  PRIMARY KEY (page_id, key)
);
```

## Implementation Priority

1. **High value, low effort**: Restrictions, version message, minor edit flag
2. **High value, medium effort**: Content parsing (tasks, links, mentions)
3. **High value, high effort**: Analytics integration (requires scope)
4. **Medium value**: Knowledge graph export
5. **Exploratory**: AI/embedding support

## Open Questions

- Should analytics be opt-in (requires additional OAuth scope)?
- Store computed metadata in sync.db or fetch on demand?
- Knowledge graph: local-only or push to external tools (Neo4j, etc.)?
- Embedding storage: content properties (limited to 32KB) or local vector DB?
