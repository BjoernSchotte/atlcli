# Confluence TUI Screen Designs

## Overview

Design specifications for Confluence-specific TUI screens in atlcli's interactive mode. These screens integrate with the existing Confluence package functionality including sync, search, spaces, pages, and local file management.

---

## Entry Points

```bash
# Full TUI mode
atlcli tui                          # Main menu -> select Confluence
atlcli wiki tui                     # Direct to Confluence TUI

# Focused views
atlcli wiki tui --space DOCS        # Start in specific space
atlcli wiki tui --dir ./my-docs     # Start in synced directory
atlcli wiki tui --page 623869955    # Start viewing specific page
```

---

## Screen 1: Confluence Home

The landing screen for Confluence mode. Shows user's context at a glance.

### Layout

```
┌─ Confluence ──────────────────────────────────────────────────────────────┐
│  atlcli v2.0.0                            bjoern@mayflowergmbh.atlassian.net │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Recent Pages                                    Favorite Spaces          │
│  ───────────────                                 ────────────────         │
│  > API Documentation            2 hours ago      DOCS  Documentation     │
│    Sprint Retrospective        Yesterday         DEV   Engineering       │
│    Architecture Decision #12   3 days ago        HR    Human Resources   │
│    Meeting Notes 2026-01-13    Last week         PROJ  Project Alpha     │
│    Onboarding Guide            2 weeks ago                               │
│                                                                           │
│  ─────────────────────────────────────────────────────────────────────── │
│                                                                           │
│  Sync Status                                     Quick Actions            │
│  ───────────                                     ─────────────            │
│  ./my-docs                                       [s] Search               │
│  ├── 12 pages synced                             [n] New page             │
│  ├── 2 local changes                             [b] Browse spaces        │
│  └── Last sync: 5 min ago                        [p] Pull changes         │
│                                                  [u] Push changes         │
│  ./api-docs                                                               │
│  ├── 8 pages synced                              [/] Quick search         │
│  └── Synced                                      [?] Help                 │
│                                                  [q] Quit                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
 [1] Recent  [2] Spaces  [3] Sync  [4] Search  [Tab] Focus  [Enter] Select
```

### Data Sources

- **Recent Pages**: CQL `contributor = currentUser() AND type = page ORDER BY lastModified DESC`
- **Favorite Spaces**: User's favorite spaces from Confluence API (or cached local)
- **Sync Status**: Read from each initialized `.atlcli/` directory on the filesystem

### Interactions

| Key | Action |
|-----|--------|
| `j/k` or `Up/Down` | Navigate list |
| `Enter` | Open selected item |
| `s` | Go to Search screen |
| `n` | Create new page (prompts for space/title) |
| `b` | Go to Space Browser |
| `p` | Pull all synced directories |
| `u` | Push all local changes |
| `/` | Quick search (inline input) |
| `Tab` | Cycle between panels |
| `1-4` | Direct panel jump |
| `q` | Quit TUI |

### State Management

```typescript
interface ConfluenceHomeState {
  recentPages: PageChangeInfo[];
  favoriteSpaces: ConfluenceSpace[];
  syncedDirectories: SyncDirectoryStatus[];
  focusedPanel: 'recent' | 'spaces' | 'sync' | 'actions';
  selectedIndex: Record<string, number>;
  isLoading: boolean;
  error: string | null;
}

interface SyncDirectoryStatus {
  path: string;
  spaceKey: string;
  totalPages: number;
  localModified: number;
  remoteModified: number;
  conflicts: number;
  lastSync: string | null;
}
```

---

## Screen 2: Space Browser

Browse all accessible Confluence spaces with details panel.

### Layout

```
┌─ Spaces ─────────────────────────────┬─ Details ──────────────────────────┐
│                                      │                                    │
│  All Spaces (24)                     │  Engineering (DEV)                 │
│  ────────────────                    │  ────────────────────              │
│                                      │                                    │
│    Key     Name                Type  │  Type:      Global                 │
│  ───────────────────────────────────│  Pages:     142                    │
│  > DEV     Engineering        Global │  Created:   2024-03-15             │
│    DOCS    Documentation      Global │  Updated:   2 hours ago            │
│    HR      Human Resources    Global │                                    │
│    PROJ    Project Alpha      Global │  Description:                      │
│    TEAM    Team Handbook      Global │  Central hub for engineering       │
│    ~admin  Admin Personal   Personal │  documentation, ADRs, and          │
│    ARCH    Architecture       Global │  technical specifications.         │
│    API     API Reference      Global │                                    │
│    TEST    Test Space         Global │  ─────────────────────────────     │
│    QA      Quality Assurance  Global │                                    │
│                                      │  Top-Level Pages:                  │
│  ───────────────────────────────────│  ├── Getting Started               │
│  [/] Filter: _______________         │  ├── Architecture                  │
│                                      │  ├── API Documentation             │
│                                      │  ├── Runbooks                      │
│                                      │  └── Meeting Notes                 │
│                                      │                                    │
│                                      │  Actions:                          │
│                                      │  [Enter] Browse  [i] Init sync     │
│                                      │  [o] Open in browser               │
│                                      │                                    │
└──────────────────────────────────────┴────────────────────────────────────┘
 [Esc] Back  [/] Filter  [Enter] Browse space  [i] Initialize sync  [o] Open URL
```

### List Features

- Sortable by: key, name, type, last modified
- Filterable: `/` activates inline filter input
- Personal spaces shown with `~` prefix

### Details Panel Content

- Space metadata (type, page count, dates)
- Description (truncated with expand option)
- Top-level pages (direct children of space root)
- Quick actions contextual to selected space

### Interactions

| Key | Action |
|-----|--------|
| `j/k` | Navigate space list |
| `Enter` | Enter Page Tree View for selected space |
| `/` | Filter spaces (fuzzy search on key+name) |
| `i` | Initialize sync for space (`atlcli docs init`) |
| `o` | Open space in browser |
| `s` | Sort menu (key/name/type/modified) |
| `Esc` | Go back / Clear filter |

---

## Screen 3: Page Tree View (Ranger-Style)

Three-pane hierarchical view inspired by ranger file manager.

### Layout

```
┌─ Parent ──────────────┬─ Current ─────────────────┬─ Preview ────────────────┐
│                       │                           │                          │
│  Engineering (DEV)    │  Architecture             │  # Decision Records      │
│  ├── Getting Started  │  ────────────────         │                          │
│  ├── Architecture    <│  > Decision Records       │  This section contains   │
│  ├── API Docs         │    System Overview        │  all Architecture        │
│  ├── Runbooks         │    Component Design       │  Decision Records (ADRs) │
│  └── Meeting Notes    │    Data Flow              │  for the project.        │
│                       │    Security Model         │                          │
│                       │    Performance Guide      │  ## Recent ADRs          │
│                       │                           │                          │
│                       │  5 children               │  - ADR-001: Use React    │
│                       │  Modified: Today          │  - ADR-002: PostgreSQL   │
│                       │  Labels: architecture     │  - ADR-003: K8s Deploy   │
│                       │                           │                          │
│                       │                           │  *Last updated: Today*   │
│                       │                           │  *Author: Bjoern*        │
│                       │                           │                          │
│                       │                           │                          │
├───────────────────────┴───────────────────────────┴──────────────────────────┤
│ Path: DEV > Architecture > Decision Records                                  │
└──────────────────────────────────────────────────────────────────────────────┘
 [h/l] Navigate  [j/k] Select  [Enter] Drill down  [Space] Toggle expand  [v] View
```

### Three-Pane Navigation

| Pane | Content | Width |
|------|---------|-------|
| Left (Parent) | Siblings of current directory | ~25% |
| Center (Current) | Children of selected item | ~30% |
| Right (Preview) | Rendered content preview | ~45% |

### Visual Indicators

```
Tree symbols:
├── Child page
└── Last child
>   Has children (expandable)
<   Current selection in parent

Status indicators:
[M] Modified locally
[R] Remote changes
[!] Conflict
[*] Unsynced (remote only)
[+] New (local only)
```

### Expand/Collapse Behavior

```
Before expand:
├── Architecture        >
├── API Docs

After expand (Space key):
├── Architecture        ▼
│   ├── Decision Records
│   ├── System Overview
│   └── Component Design
├── API Docs
```

### Interactions

| Key | Action |
|-----|--------|
| `h` / `Left` | Go to parent level |
| `l` / `Right` / `Enter` | Enter selected item |
| `j/k` | Move selection up/down |
| `Space` | Toggle expand/collapse |
| `v` | Open full Page Detail View |
| `e` | Edit page (opens in $EDITOR) |
| `o` | Open in browser |
| `y` | Copy page URL |
| `d` | Download page to local |
| `m` | Move page (shows target picker) |
| `c` | Copy page |
| `D` | Delete page (with confirmation) |
| `/` | Search within current tree |
| `g` | Go to top |
| `G` | Go to bottom |

### State

```typescript
interface PageTreeState {
  spaceKey: string;
  rootPages: PageTreeNode[];
  currentPath: string[]; // Array of page IDs from root to current
  expandedNodes: Set<string>;
  selectedIndex: number;
  previewContent: string | null;
  isLoadingPreview: boolean;
}

interface PageTreeNode {
  id: string;
  title: string;
  hasChildren: boolean;
  children?: PageTreeNode[];
  syncState?: SyncState;
  labels?: string[];
  lastModified?: string;
  version?: number;
}
```

---

## Screen 4: Page Detail View

Full page content view with metadata and actions.

### Layout

```
┌─ API Documentation ──────────────────────────────────────────────────────────┐
│  DEV > Architecture > API Documentation                    v12 | Today 14:32 │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  # API Documentation                                                         │
│                                                                              │
│  This document describes the REST API for the Platform Service.              │
│                                                                              │
│  ## Authentication                                                           │
│                                                                              │
│  All API requests require a Bearer token in the Authorization header:        │
│                                                                              │
│  ```                                                                         │
│  Authorization: Bearer <token>                                               │
│  ```                                                                         │
│                                                                              │
│  ## Endpoints                                                                │
│                                                                              │
│  ### GET /api/users                                                          │
│                                                                              │
│  Returns a list of all users.                                                │
│                                                                              │
│  | Parameter | Type   | Required | Description           |                   │
│  |-----------|--------|----------|-----------------------|                   │
│  | limit     | int    | No       | Max results (default 50) |                │
│  | offset    | int    | No       | Pagination offset     |                   │
│                                                                              │
│  ───────────────────────────────────────────────────────── 40% ─────────────│
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Author: Bjoern Schmidt        Labels: api, documentation, v2                │
│  Created: 2025-11-20           Modified: 2026-01-15 (by Maria)               │
├──────────────────────────────────────────────────────────────────────────────┤
│  Linked Issues: PROJ-123 (Open), PROJ-456 (Done), API-789 (In Progress)      │
└──────────────────────────────────────────────────────────────────────────────┘
 [e] Edit  [s] Sync  [o] Open URL  [c] Comments  [h] History  [l] Labels  [Esc] Back
```

### Markdown Rendering

Content is converted from Confluence storage format to markdown and rendered with:
- Syntax highlighting for code blocks
- Tables with Unicode box drawing
- Proper heading hierarchy
- List formatting (bullets, numbers, checkboxes)
- Links (shown inline or as references)
- Images (shown as `[Image: filename.png]` placeholder)

### Scrolling

```
Scroll indicators:
─────────────────────────────────────────── 40% ───────────────

Progress bar shows position in document.
Percentage updates in real-time while scrolling.
```

### Metadata Panel

Compact footer showing:
- Author and creation date
- Last modifier and modification date
- Labels (clickable to filter)
- Linked Jira issues (if any)

### Linked Jira Issues

Extracted from:
1. `{jira:PROJ-123}` macros in content
2. Confluence page properties (if configured)
3. Jira issue links API

Display format:
```
PROJ-123 (Open)    - Status badge colored by state
PROJ-456 (Done)    - Green for done
API-789 (Progress) - Blue for in progress
```

### Interactions

| Key | Action |
|-----|--------|
| `j/k` or `Scroll` | Scroll content |
| `g` | Go to top |
| `G` | Go to bottom |
| `e` | Edit page (opens $EDITOR) |
| `s` | Sync page (pull or push) |
| `o` | Open in browser |
| `c` | Show comments panel |
| `h` | Show version history |
| `l` | Manage labels |
| `r` | Refresh content |
| `y` | Copy URL to clipboard |
| `/` | Search in page content |
| `Esc` | Go back to tree view |

---

## Screen 5: Search Interface

Full-featured search with CQL support and filters.

### Layout

```
┌─ Search ─────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Query: API authentication guide___________________________________          │
│                                                                              │
│  Filters:                                                                    │
│  Space: [DEV, DOCS]    Type: [page]    Labels: [api]    Modified: [7d]       │
│                                                                              │
│  ────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Results (23 matches)                                     Sort: Relevance ▼  │
│  ─────────────────────                                                       │
│                                                                              │
│  > API Authentication Guide                                    DEV  Today    │
│    ...using OAuth 2.0 for **API authentication**. This guide covers...       │
│                                                                              │
│    REST API Security                                           DOCS 3 days   │
│    ...implementing **authentication** for your **API** endpoints...          │
│                                                                              │
│    Authentication Patterns                                     ARCH 1 week   │
│    ...common **authentication** patterns for microservices **API**...        │
│                                                                              │
│    API Gateway Configuration                                   DEV  2 weeks  │
│    ...configure **authentication** at the gateway level for **API**...       │
│                                                                              │
│    User Management API                                         API  3 weeks  │
│    ...endpoints require Bearer token **authentication**. The **API**...      │
│                                                                              │
│                                                                              │
│  ────────────────────────────────────────────────────────── Page 1 of 5 ────│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
 [Tab] Filters  [Enter] Open  [/] Edit query  [c] CQL mode  [n/p] Next/Prev page
```

### Search Modes

1. **Simple Search** (default)
   - Full-text search across title and content
   - Automatic quoting and escaping

2. **CQL Mode** (toggle with `c`)
   - Raw CQL query input
   - Syntax highlighting for CQL keywords
   - Auto-complete for field names

```
┌─ CQL Search ─────────────────────────────────────────────────────────────────┐
│                                                                              │
│  CQL: type=page AND space IN (DEV, DOCS) AND text ~ "API auth*" AND         │
│       label = "api" AND lastModified >= startOfWeek()                        │
│                                                                              │
│  [Syntax OK]                                            [Tab] for completion │
│                                                                              │
```

### Filter Options

| Filter | Options | CQL Mapping |
|--------|---------|-------------|
| Space | Multi-select dropdown | `space IN (...)` |
| Type | page, blogpost, comment | `type = ...` |
| Labels | Tag input (comma-separated) | `label IN (...)` |
| Modified | Today, 7d, 30d, Custom | `lastModified >= ...` |
| Created | Today, 7d, 30d, Custom | `created >= ...` |
| Creator | User search / "me" | `creator = ...` |
| Ancestor | Page picker | `ancestor = ...` |

### Result Display

Each result shows:
- Title (highlighted matches in bold)
- Excerpt with highlighted matches (from indexed content)
- Space key badge
- Relative time

### Interactions

| Key | Action |
|-----|--------|
| `Tab` | Cycle focus: query -> filters -> results |
| `Enter` | Execute search / Open selected result |
| `/` | Focus query input |
| `c` | Toggle CQL mode |
| `j/k` | Navigate results |
| `n/p` or `Ctrl+n/p` | Next/previous results page |
| `s` | Change sort (relevance, modified, created) |
| `v` | Preview selected result |
| `o` | Open in browser |
| `Esc` | Clear / Go back |

### State

```typescript
interface SearchState {
  mode: 'simple' | 'cql';
  query: string;
  filters: SearchFilters;
  results: ConfluenceSearchResult[];
  pagination: {
    page: number;
    totalPages: number;
    totalResults: number;
  };
  focusedElement: 'query' | 'filters' | 'results';
  selectedResultIndex: number;
  isSearching: boolean;
  error: string | null;
}

interface SearchFilters {
  spaces: string[];
  types: ContentType[];
  labels: string[];
  modifiedSince: DateFilter | null;
  createdSince: DateFilter | null;
  creator: string | null;
  ancestor: string | null;
}
```

---

## Screen 6: Sync Status View

Detailed view of local sync state with conflict resolution.

### Layout

```
┌─ Sync Status: ./my-docs ─────────────────────────────────────────────────────┐
│  Space: DOCS | Last sync: 5 minutes ago | Profile: mayflowergmbh             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Overview                                                                    │
│  ────────                                                                    │
│  Synced:          12 pages                                                   │
│  Local changes:    2 pages                                                   │
│  Remote changes:   1 page                                                    │
│  Conflicts:        1 page                                                    │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Files                                                                       │
│  ─────                                                                       │
│   Status   File                              Local    Remote    Action       │
│  ──────────────────────────────────────────────────────────────────────────│
│  [!] CONF  getting-started.md               v4       v5        [r] Resolve  │
│  [M]       api-docs/authentication.md       v3+      v3        [u] Push     │
│  [M]       api-docs/endpoints.md            v2+      v2        [u] Push     │
│  [R]       guides/onboarding.md             v5       v6        [p] Pull     │
│  [=]       guides/faq.md                    v3       v3        Synced       │
│  [=]       guides/troubleshooting.md        v2       v2        Synced       │
│  [+]       drafts/new-feature.md            -        -         [a] Add      │
│  [*]       old-docs/deprecated.md           -        v1        [d] Download │
│                                                                              │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│  Actions: [P] Pull all  [U] Push all  [S] Sync (bidirectional)  [R] Refresh │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
 [Enter] Action on selected  [P] Pull all  [U] Push all  [d] Diff  [Space] Select
```

### Status Icons

```
[=]  Synced       - Local and remote match
[M]  Modified     - Local changes not pushed (version+ indicates local ahead)
[R]  Remote       - Remote changes not pulled
[!]  Conflict     - Both sides changed
[+]  Untracked    - Local file not synced to Confluence
[*]  Remote only  - Exists in Confluence but not locally
[D]  Deleted      - Marked for deletion
```

### Conflict Resolution UI

When selecting a conflicted file:

```
┌─ Conflict Resolution ────────────────────────────────────────────────────────┐
│                                                                              │
│  File: getting-started.md                                                    │
│  Local version: 4 (modified 2 hours ago)                                     │
│  Remote version: 5 (modified 1 hour ago by Maria)                            │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  ┌─ Local ─────────────────────┐  ┌─ Remote ────────────────────┐           │
│  │                             │  │                              │           │
│  │  ## Getting Started         │  │  ## Getting Started          │           │
│  │                             │  │                              │           │
│  │  Welcome to the platform.   │  │  Welcome to the platform!    │           │
│  │                             │  │  This guide will help you    │           │
│  │  ### Prerequisites          │  │  get started quickly.        │           │
│  │  - Node.js 18+              │  │                              │           │
│  │  - Docker                   │  │  ### Prerequisites           │           │
│  │                             │  │  - Node.js 20+               │           │
│  │                             │  │  - Docker Desktop            │           │
│  │                             │  │                              │           │
│  └─────────────────────────────┘  └──────────────────────────────┘           │
│                                                                              │
│  Resolution:                                                                 │
│  [l] Keep local  [r] Keep remote  [m] Manual merge  [d] View diff            │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Bulk Operations

```
Multi-select mode (Space to toggle):

│  [ ] [M]  api-docs/authentication.md       v3+      v3
│  [x] [M]  api-docs/endpoints.md            v2+      v2
│  [x] [M]  api-docs/overview.md             v1+      v1

Selected: 2 files

Actions: [u] Push selected  [p] Pull selected  [Esc] Clear selection
```

### Interactions

| Key | Action |
|-----|--------|
| `j/k` | Navigate file list |
| `Enter` | Perform suggested action on file |
| `Space` | Toggle selection (multi-select mode) |
| `P` | Pull all remote changes |
| `U` | Push all local changes |
| `S` | Full bidirectional sync |
| `r` | Resolve selected conflict |
| `d` | View diff for selected file |
| `o` | Open file in editor |
| `R` | Refresh status |
| `Esc` | Go back |

### State

```typescript
interface SyncStatusState {
  directory: string;
  config: AtlcliConfig;
  state: AtlcliState;
  files: SyncFileStatus[];
  selectedIndex: number;
  selectedFiles: Set<string>; // For multi-select
  summary: {
    synced: number;
    localModified: number;
    remoteModified: number;
    conflicts: number;
    untracked: number;
    remoteOnly: number;
  };
  isRefreshing: boolean;
  lastRefresh: Date;
}

interface SyncFileStatus {
  path: string;
  pageId: string | null;
  title: string;
  localVersion: number | null;
  remoteVersion: number | null;
  syncState: SyncState;
  lastLocalModified: string | null;
  lastRemoteModified: string | null;
  remoteModifier: string | null;
}
```

---

## Screen 7: Page Editor Integration

Two approaches: embedded preview or external editor with TUI coordination.

### Option A: External Editor Integration

```
┌─ Edit: getting-started.md ───────────────────────────────────────────────────┐
│                                                                              │
│  Opening in your editor: $EDITOR (vim)                                       │
│                                                                              │
│  File: /home/user/docs/getting-started.md                                    │
│  Page: Getting Started (DEV)                                                 │
│  Version: 4                                                                  │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  The editor is running in a separate process.                                │
│                                                                              │
│  When you save and exit:                                                     │
│  - Changes will be detected automatically                                    │
│  - You can push to Confluence from the sync screen                           │
│                                                                              │
│  Watching for changes... (last saved: never)                                 │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  [p] Push now  [d] View diff  [c] Cancel edit  [r] Refresh preview           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Editor workflow:
1. TUI spawns `$EDITOR` with the markdown file
2. TUI waits for editor to exit OR watches file for changes
3. On save, show diff preview
4. Option to push immediately or return to sync view

### Option B: Split-Pane Preview Mode

```
┌─ Editor ─────────────────────────┬─ Preview ─────────────────────────────────┐
│                                  │                                           │
│  # Getting Started               │  Getting Started                          │
│                                  │  ================                         │
│  Welcome to the platform!        │                                           │
│                                  │  Welcome to the platform!                 │
│  ## Prerequisites                │                                           │
│                                  │  Prerequisites                            │
│  - Node.js 20+                   │  ------------                             │
│  - Docker Desktop                │                                           │
│  - Git                           │  - Node.js 20+                            │
│                                  │  - Docker Desktop                         │
│  ## Installation                 │  - Git                                    │
│                                  │                                           │
│  ```bash                         │  Installation                             │
│  npm install -g atlcli           │  ------------                             │
│  ```                             │                                           │
│                                  │  npm install -g atlcli                    │
│  ## Next Steps                   │                                           │
│                                  │  Next Steps                               │
│  1. [Authentication](./auth.md)  │  ----------                               │
│  2. [Configuration](./config.md) │                                           │
│                                  │  1. Authentication                        │
│                                  │  2. Configuration                         │
│                                  │                                           │
├──────────────────────────────────┴───────────────────────────────────────────┤
│ [Ctrl+s] Save  [Ctrl+p] Push  [Ctrl+e] Toggle preview  [Esc] Exit            │
└──────────────────────────────────────────────────────────────────────────────┘
```

This requires a simple built-in editor (line-based editing). Realistically, this is complex to implement well - Option A (external editor) is recommended.

### Recommended Approach

```typescript
async function editPage(pagePath: string): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vim';

  // Spawn editor
  const child = spawn(editor, [pagePath], {
    stdio: 'inherit',
    detached: true,
  });

  // Wait for editor to close
  await new Promise((resolve) => child.on('exit', resolve));

  // Detect if file changed
  const newHash = await computeFileHash(pagePath);
  if (newHash !== originalHash) {
    // Prompt for push
    return showPushPrompt(pagePath);
  }
}
```

---

## Comments View (Overlay Panel)

Accessible from Page Detail View with `c` key.

### Layout

```
┌─ Comments: API Documentation ────────────────────────────────────────────────┐
│                                                                              │
│  Footer Comments (3)                                                         │
│  ──────────────────                                                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Maria Schmidt  ·  2 hours ago  ·  [resolved]                          │ │
│  │                                                                        │ │
│  │  Should we add rate limiting examples to this doc?                     │ │
│  │                                                                        │ │
│  │    └─ Bjoern  ·  1 hour ago                                           │ │
│  │       Good idea! I'll add a section for that.                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  John Doe  ·  Yesterday                                                │ │
│  │                                                                        │ │
│  │  The authentication section is great, but could use more examples      │ │
│  │  for different languages.                                              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  [n] New comment  [r] Reply  [s] Resolve  [j/k] Navigate  [Esc] Close        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Inline Comments Section

```
│  Inline Comments (2)                                                         │
│  ──────────────────                                                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  On: "Bearer token in the Authorization header"                        │ │
│  │                                                                        │ │
│  │  Maria  ·  3 hours ago                                                 │ │
│  │  Should we mention that API keys are also supported?                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
```

---

## History View (Overlay Panel)

Accessible from Page Detail View with `h` key.

### Layout

```
┌─ Version History: API Documentation ─────────────────────────────────────────┐
│                                                                              │
│  Current: v12                                                                │
│                                                                              │
│   Ver   Author              Date                 Message                     │
│  ──────────────────────────────────────────────────────────────────────────│
│  > 12   Maria Schmidt       Today 14:32          Added rate limiting section │
│    11   Bjoern Schmidt      Today 10:15          Fixed typo in auth example │
│    10   Bjoern Schmidt      Yesterday            Added OAuth 2.0 examples   │
│     9   John Doe            3 days ago           Updated endpoints table    │
│     8   Maria Schmidt       1 week ago           Added error codes section  │
│     7   Bjoern Schmidt      2 weeks ago          Initial API documentation  │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Selected: v12                                                               │
│  ─────────────────                                                           │
│  Author: Maria Schmidt                                                       │
│  Date: 2026-01-15 14:32:00                                                   │
│  Message: Added rate limiting section                                        │
│                                                                              │
│  [d] Diff with v11  [v] View this version  [r] Restore  [Esc] Close          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Diff View (sub-view)

```
┌─ Diff: v11 → v12 ────────────────────────────────────────────────────────────┐
│                                                                              │
│  @@ -45,6 +45,20 @@                                                          │
│                                                                              │
│   ### Error Handling                                                         │
│                                                                              │
│   All errors return a standard format:                                       │
│                                                                              │
│  +## Rate Limiting                                                           │
│  +                                                                           │
│  +The API enforces rate limits to ensure fair usage:                         │
│  +                                                                           │
│  +| Tier    | Requests/min | Burst |                                         │
│  +|---------|--------------|-------|                                         │
│  +| Free    | 60           | 10    |                                         │
│  +| Pro     | 600          | 100   |                                         │
│  +| Enterprise | Unlimited | -     |                                         │
│  +                                                                           │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────────────── │
│  +14 lines added  -0 lines removed                                           │
│                                                                              │
│  [n/p] Next/Prev hunk  [Esc] Back to history                                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Help Overlay

Accessible from any screen with `?`.

### Layout

```
┌─ Keyboard Shortcuts ─────────────────────────────────────────────────────────┐
│                                                                              │
│  Global                           Navigation                                 │
│  ──────                           ──────────                                 │
│  ?        Show this help          j/k, ↑/↓   Move up/down                   │
│  q        Quit TUI                h/l, ←/→   Move left/right                │
│  Esc      Go back / Cancel        Enter      Select / Drill down            │
│  Tab      Cycle focus             Space      Toggle / Expand                │
│  1-9      Direct panel jump       g/G        Go to top/bottom               │
│  /        Quick search            Ctrl+d/u   Page down/up                   │
│                                                                              │
│  Page Actions                     Sync Actions                               │
│  ────────────                     ────────────                               │
│  e        Edit in $EDITOR         p/P        Pull changes                   │
│  o        Open in browser         u/U        Push changes                   │
│  y        Copy URL                s/S        Full sync                      │
│  v        View page details       r          Resolve conflict               │
│  c        Show comments           d          View diff                      │
│  h        Show history            R          Refresh status                 │
│  l        Manage labels                                                     │
│                                                                              │
│  Search                           Tree View                                  │
│  ──────                           ─────────                                  │
│  /        Focus search input      Space      Toggle expand                  │
│  c        Toggle CQL mode         m          Move page                      │
│  Enter    Execute search          c          Copy page                      │
│  n/p      Next/prev page          D          Delete page                    │
│                                                                              │
│                                                 Press any key to close       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Technical Considerations

### Markdown Rendering in Terminal

For rendering Confluence content (converted to markdown) in the TUI:

```typescript
// Libraries to consider
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';

// Custom TUI renderer
class TerminalMarkdownRenderer {
  // Headers: Bold + color
  renderHeading(text: string, level: number): string {
    const prefix = '#'.repeat(level) + ' ';
    return chalk.bold.blue(prefix + text) + '\n\n';
  }

  // Code blocks: Background + syntax highlighting
  renderCodeBlock(code: string, lang?: string): string {
    const border = '─'.repeat(40);
    return `${border}\n${highlightCode(code, lang)}\n${border}\n`;
  }

  // Tables: Unicode box drawing
  renderTable(rows: string[][]): string {
    return formatTable(rows, {
      border: 'rounded', // ╭─╮ style
      header: true,
      padding: 1,
    });
  }

  // Links: Show inline or as numbered references
  renderLink(text: string, url: string): string {
    return `${text} [${this.linkIndex++}]`;
  }

  // Images: Placeholder (can't display in most terminals)
  renderImage(alt: string, src: string): string {
    return chalk.dim(`[Image: ${alt || src}]`);
  }
}
```

### Caching Strategy

```typescript
interface TUICache {
  // Recent pages (persisted)
  recentPages: Map<string, CachedPage>;

  // Space list (refreshed periodically)
  spaces: CachedSpaces | null;

  // Page tree nodes (lazy loaded)
  pageTree: Map<string, PageTreeNode[]>;

  // Search results (session only)
  searchResults: SearchResults | null;
}

interface CachedPage {
  page: ConfluencePage;
  markdown: string;
  fetchedAt: Date;
  ttl: number; // milliseconds
}
```

### State Persistence

```typescript
// Session state saved to ~/.atlcli/tui-session.json
interface TUISession {
  lastScreen: ScreenType;
  lastSpace: string | null;
  lastDirectory: string | null;
  expandedNodes: Record<string, string[]>;
  searchHistory: string[];
  preferences: {
    theme: 'dark' | 'light';
    previewEnabled: boolean;
    sortPreference: Record<string, SortConfig>;
  };
}
```

### Performance Optimizations

1. **Lazy loading**: Only fetch page content when viewing, not when browsing tree
2. **Pagination**: Limit API calls, load more on scroll
3. **Debounced search**: Wait for typing pause before searching
4. **Background refresh**: Update stale data without blocking UI
5. **Virtual scrolling**: For long lists, only render visible items

### Error Handling

```typescript
// Error display pattern
function showError(error: Error, context: string): void {
  const overlay = createOverlay({
    title: 'Error',
    content: `
      ${context}

      ${error.message}

      ${error.cause ? `Caused by: ${error.cause}` : ''}
    `,
    actions: [
      { key: 'r', label: 'Retry', action: retry },
      { key: 'Esc', label: 'Dismiss', action: dismiss },
    ],
  });
  showOverlay(overlay);
}
```

---

## Implementation Priority

### Phase 1: Core Navigation
1. Confluence Home (simplified)
2. Space Browser
3. Page Tree View (basic)
4. Help overlay

### Phase 2: Content Views
5. Page Detail View
6. Search Interface
7. History View

### Phase 3: Sync & Edit
8. Sync Status View
9. Conflict Resolution UI
10. Editor Integration

### Phase 4: Polish
11. Comments View
12. Labels management
13. Keyboard shortcut consistency
14. Theme support

---

## Dependencies

```json
{
  "dependencies": {
    "ink": "^4.4.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^5.0.1",
    "ink-select-input": "^5.0.0",
    "marked": "^12.0.0",
    "cli-highlight": "^2.1.11",
    "boxen": "^7.1.1",
    "chalk": "^5.3.0"
  }
}
```

Or consider `@opentui` for better performance (per tui-research.md recommendations).
