# Jira TUI Design Specification

## Research Summary

### Existing Jira TUI Tools Analyzed

1. **[jira-cli](https://github.com/ankitpokhrel/jira-cli)** - Feature-rich Go CLI with interactive TUI
   - Explorer view with sidebar/content split for epics and sprints
   - Table views with vim-like navigation (j/k/h/l, g/G, CTRL+f/b)
   - TAB to toggle focus between panels
   - Markdown rendering for issue descriptions

2. **[JiraTUI](https://github.com/whyisdifficult/jiratui)** - Python Textual-based TUI
   - Full-text search capabilities
   - YAML configuration
   - Built with Rich framework for styling

3. **[jira-tui (Jorres)](https://github.com/Jorres/jira-tui)** - Multi-tab interface
   - Multiple tabs with independent filters
   - Configurable columns: KEY, TYPE, PARENT, SUMMARY, STATUS, ASSIGNEE
   - Markdown-based issue editing
   - Theme customization with hex colors

4. **[kanban-tui](https://github.com/Zaloog/kanban-tui)** - Python kanban board
   - Four default columns: Ready, Doing, Done, Archive
   - Cards with title, description, dates, color-coded categories
   - Drag-and-drop support
   - Bar charts for analytics with Plotext

5. **[rust_kanban](https://github.com/yashs662/rust_kanban)** - Rust kanban
   - Mouse support for clicking, scrolling
   - Command palette (Ctrl+P)
   - Undo/redo support
   - Multiple themes

### Key Design Principles from Research

- **[Lazygit](https://github.com/jesseduffield/lazygit)** pattern: Multi-panel layout with clear focus indicators
- **Speed over beauty**: Terminal users value efficiency
- **Vim-style navigation**: Standard j/k/h/l movement
- **Responsive design**: Adapt to terminal width with truncation
- **Consistent keybindings**: `?` for help, `q` to quit, `/` to search

---

## 1. Jira Home/Dashboard

### Purpose
Quick overview of the user's Jira work state - what needs attention now.

### ASCII Mockup

```
+--------------------------------------------------------------------------------+
| atlcli - Jira                                               user@company.com   |
+--------------------------------------------------------------------------------+
|                                                                                 |
|  MY OPEN ISSUES (12)                        RECENT ACTIVITY                     |
|  +---------------------------------+        +--------------------------------+  |
|  | PROJ-123 Fix login timeout  !H |        | PROJ-456 commented by @alice   |  |
|  | PROJ-124 Update docs           |        | PROJ-789 transitioned to Done  |  |
|  | PROJ-125 Refactor auth      !M |        | PROJ-234 assigned to you       |  |
|  | PROJ-126 Add tests             |        | PROJ-567 new comment           |  |
|  | PROJ-127 Review PR          !H |        +--------------------------------+  |
|  +---------------------------------+                                            |
|                                                                                 |
|  ACTIVE SPRINT: Sprint 42                   QUICK STATS                         |
|  +-------------------------------+          +--------------------------------+  |
|  | Days Left: 5 of 14            |          | Velocity: 34 pts (avg: 31)     |  |
|  | Progress: [=========>    ] 67%|          | My Issues: 12 open, 8 in prog  |  |
|  | Committed: 42 pts             |          | Blockers: 2                    |  |
|  | Completed: 28 pts             |          | Due Today: 1                   |  |
|  +-------------------------------+          +--------------------------------+  |
|                                                                                 |
|  [s] Search  [i] My Issues  [b] Board  [p] Sprint  [c] Create  [?] Help  [q] Quit
+--------------------------------------------------------------------------------+
```

### Information to Show

**My Open Issues Panel**
- Top 5-10 issues assigned to user
- Key, truncated summary (30-40 chars)
- Priority indicator (!H = High, !M = Medium)
- Status badge color

**Recent Activity Panel**
- Last 5 activity items
- Issue key, action type, actor
- Timestamp (relative: "2h ago")

**Active Sprint Panel**
- Sprint name and state
- Progress bar (completed/committed points)
- Days remaining
- Burndown mini-graph (optional)

**Quick Stats Panel**
- Current velocity vs average
- Issue counts by state
- Blockers count
- Due today count

### Quick Actions

| Key | Action |
|-----|--------|
| `s` | Open search interface |
| `i` | Go to My Issues list |
| `b` | Open board/kanban view |
| `p` | Open current sprint |
| `c` | Create new issue |
| `?` | Show help |
| `q` | Quit |
| `r` | Refresh data |
| `Enter` | Open selected item |

### Layout Suggestions

- **Two-column layout** for wide terminals (>120 cols)
- **Single-column stacked** for narrow terminals (<80 cols)
- **Focus rotation** with Tab between panels
- **Auto-refresh** every 60 seconds (configurable)

---

## 2. Issue List View

### Purpose
Display and navigate a list of issues from search/filter results.

### ASCII Mockup - Wide Terminal (>100 cols)

```
+--------------------------------------------------------------------------------+
| Issues: project = PROJ AND status != Done                    [48 results]      |
+--------------------------------------------------------------------------------+
| Filter: [project = PROJ AND status != Done________________________] [Apply] |
| Sort: Updated v  | Status: All v | Type: All v | Assignee: All v               |
+--------------------------------------------------------------------------------+
| [ ] KEY       TYPE   PRIORITY  STATUS      ASSIGNEE     SUMMARY                 |
+--------------------------------------------------------------------------------+
| [ ] PROJ-123  Bug    !High     In Review   @john        Fix login timeout is... |
| [x] PROJ-124  Task   Medium    To Do       @alice       Update documentati...   |
| [x] PROJ-125  Story  !High     In Prog     @bob         Implement new auth...   |
| [ ] PROJ-126  Task   Low       To Do       Unassigned   Add unit tests for...   |
| [ ] PROJ-127  Bug    Medium    Blocked     @carol       Database connectio...   |
| [ ] PROJ-128  Epic   Medium    In Prog     @dave        Q1 Platform Migrat...   |
|>[ ] PROJ-129  Story  !High     To Do       @eve         User profile page ...   |
| [ ] PROJ-130  Task   Low       Done        @frank       Clean up legacy co...   |
+--------------------------------------------------------------------------------+
| Page 1/6  | j/k:Move  Space:Select  Enter:Open  t:Transition  a:Assign  ?:Help  |
+--------------------------------------------------------------------------------+
```

### ASCII Mockup - Narrow Terminal (<80 cols)

```
+------------------------------------------------------+
| Issues: project = PROJ                   [48 results]|
+------------------------------------------------------+
| KEY       STATUS      SUMMARY                        |
+------------------------------------------------------+
| PROJ-123  In Review   Fix login timeout issues whe...|
| PROJ-124  To Do       Update documentation for AP...|
|>PROJ-125  In Prog     Implement new authentication...|
| PROJ-126  To Do       Add unit tests for payment...|
| PROJ-127  Blocked     Database connection pooling...|
+------------------------------------------------------+
| j/k:Nav  Enter:Open  t:Trans  ?:Help                |
+------------------------------------------------------+
```

### Column Configuration

**Default columns (in priority order for truncation)**:
1. Selection checkbox `[ ]`
2. KEY (always visible, 10 chars)
3. STATUS (12 chars, color-coded)
4. SUMMARY (flexible, min 20 chars)
5. TYPE (hidden <80 cols)
6. PRIORITY (hidden <100 cols)
7. ASSIGNEE (hidden <120 cols)
8. UPDATED (hidden <140 cols)

**Truncation rules**:
- Summary always truncated with `...`
- Status shows abbreviated form if needed (e.g., "In Prog")
- Hide columns progressively as terminal narrows

### Filtering UI

**Quick filter bar** (inline above list):
- JQL input field with autocomplete
- Dropdown filters for common fields
- Clear filters button

**Filter shortcuts**:
| Key | Action |
|-----|--------|
| `/` | Focus JQL input |
| `f` | Open filter panel |
| `F` | Clear all filters |
| `1-9` | Apply saved filter |

### Sorting Controls

| Key | Action |
|-----|--------|
| `o` | Open sort menu |
| `O` | Reverse sort order |
| Default fields: Updated, Created, Priority, Key |

### Selection & Multi-Select

| Key | Action |
|-----|--------|
| `Space` | Toggle selection on current item |
| `v` | Enter visual/selection mode |
| `Ctrl+a` | Select all |
| `Ctrl+n` | Deselect all |
| `*` | Invert selection |

**Bulk actions on selection**:
- `t` - Transition all selected
- `a` - Assign all selected
- `l` - Add label to all selected
- `d` - Delete all selected (with confirm)

### Navigation

| Key | Action |
|-----|--------|
| `j` / `Down` | Move down |
| `k` / `Up` | Move up |
| `g` | Go to first |
| `G` | Go to last |
| `Ctrl+d` | Page down |
| `Ctrl+u` | Page up |
| `Enter` | Open issue detail |
| `o` | Open in browser |

---

## 3. Issue Detail View

### Purpose
Display full issue information with ability to take actions.

### ASCII Mockup

```
+--------------------------------------------------------------------------------+
| PROJ-123: Fix login timeout issues when server is under high load              |
| Bug | !High | In Review | @john.doe                                            |
+--------------------------------------------------------------------------------+
|                                                                                 |
| DESCRIPTION                                                                     |
| ------------------------------------------------------------------------------- |
| When the server experiences high traffic (>1000 req/s), login requests         |
| timeout after 30 seconds. This affects approximately 5% of users during        |
| peak hours.                                                                     |
|                                                                                 |
| Steps to reproduce:                                                             |
| 1. Generate high load using load testing tool                                   |
| 2. Attempt to login from a new browser session                                  |
| 3. Observe timeout error after 30 seconds                                       |
|                                              [More... Press 'd' for full desc] |
| ------------------------------------------------------------------------------- |
|                                                                                 |
| DETAILS                               | LINKS & RELATIONS                       |
| Created:  2026-01-10 by @alice        | Parent: PROJ-100 (Epic: Auth Improve)  |
| Updated:  2026-01-14 (2 hours ago)    | Blocks:  PROJ-456, PROJ-789            |
| Due:      2026-01-20 (5 days)         | Related: PROJ-234                       |
| Sprint:   Sprint 42                   | Subtasks: 2/3 complete                  |
| Labels:   backend, performance        | Confluence: Design Doc                  |
| Components: API, Auth                 |                                         |
| Story Pts: 5                          |                                         |
| Time:     2h logged / 4h estimated    |                                         |
| ------------------------------------------------------------------------------- |
|                                                                                 |
| COMMENTS (3)                                                       [c] Add new  |
| ------------------------------------------------------------------------------- |
| @alice (2h ago):                                                                |
|   I've identified the bottleneck in the session validation. Working on a fix.  |
|                                                                                 |
| @bob (1d ago):                                                                  |
|   Can we get metrics on the current timeout rates? @carol can you help?        |
|                                                                                 |
|                                                     [Enter to expand, j/k nav] |
| ------------------------------------------------------------------------------- |
|                                                                                 |
| [t] Transition  [a] Assign  [e] Edit  [c] Comment  [w] Watch  [l] Log Time     |
| [s] Subtasks    [k] Link    [m] Move  [d] Full Desc  [o] Browser  [q] Back     |
+--------------------------------------------------------------------------------+
```

### Fields to Show

**Header Section**
- Issue key and full summary (word-wrapped)
- Type icon/badge
- Priority indicator
- Status badge (color-coded)
- Assignee

**Description Section**
- Rendered markdown/ADF content
- Collapsed by default if >10 lines
- `d` to expand/collapse

**Details Panel** (left column)
- Created date and reporter
- Updated date (relative)
- Due date (with warning if overdue)
- Sprint
- Labels (comma-separated)
- Components
- Story points
- Time tracking (logged/estimated)

**Links & Relations Panel** (right column)
- Parent issue (for subtasks/epic children)
- Blocks/Blocked by
- Related issues
- Subtask progress
- Remote links (Confluence, etc.)

**Comments Section**
- Latest 3-5 comments
- Author, timestamp, body preview
- `Enter` to expand comment
- `c` to add new comment

### Long Description Handling

1. **Initial view**: First 5-10 lines visible
2. **Expand button**: `d` to toggle full description
3. **Scrollable region**: j/k within description when focused
4. **External viewer**: `D` to open in $PAGER

### Comments Display

```
COMMENTS (12)                                                    [c] Add new
+----------------------------------------------------------------------------+
| @alice.smith (2 hours ago)                                           [r]   |
| I've identified the root cause. The session cache TTL was set too low.     |
| Will push a fix shortly.                                                   |
+----------------------------------------------------------------------------+
| @bob.jones (1 day ago)                                               [r]   |
| Can we add monitoring for this metric? CC @carol                           |
+----------------------------------------------------------------------------+
| [Load more... 10 older comments]                                           |
+----------------------------------------------------------------------------+
```

- Show latest 3-5 comments by default
- `Enter` on comment to expand
- `r` on comment to reply
- Load more with pagination

### Related Issues/Links Display

```
LINKS & RELATIONS
+------------------------------------------------+
| Parent Epic                                     |
|   PROJ-100  Auth System Improvements      Done |
+------------------------------------------------+
| Blocks (2)                                      |
|   PROJ-456  Deploy to staging         In Prog  |
|   PROJ-789  Update load balancer      To Do    |
+------------------------------------------------+
| Subtasks (2/3 complete)                         |
|   [x] PROJ-123-1  Analyze logs           Done  |
|   [x] PROJ-123-2  Implement fix          Done  |
|   [ ] PROJ-123-3  Add tests           In Prog  |
+------------------------------------------------+
```

### Action Buttons

| Key | Action |
|-----|--------|
| `t` | Transition issue (show status menu) |
| `a` | Assign issue (user picker) |
| `e` | Edit issue (opens editor) |
| `c` | Add comment |
| `w` | Toggle watch |
| `l` | Log time |
| `s` | View/create subtasks |
| `k` | Link to another issue |
| `m` | Move to sprint/epic |
| `d` | Toggle description expansion |
| `o` | Open in browser |
| `q` | Back to list |

---

## 4. Board/Kanban View

### Purpose
Visual kanban board showing issues across workflow columns.

### ASCII Mockup - Standard Board

```
+--------------------------------------------------------------------------------+
| Board: Team Alpha Kanban                                    Sprint 42 | Active |
+--------------------------------------------------------------------------------+
| TO DO (5/10)      | IN PROGRESS (3/3) | IN REVIEW (2)     | DONE (12)        |
| WIP: 10           | WIP: 3 [FULL]     | WIP: -            | WIP: -           |
+-------------------|-------------------|-------------------|------------------+
| +---------------+ | +---------------+ | +---------------+ | +---------------+|
| | PROJ-234      | | |>PROJ-123     | | | PROJ-456      | | | PROJ-111      ||
| | User profile  | | | Fix login    | | | Deploy staging| | | Add metrics   ||
| | @alice   5pts | | | @john    5pts| | | @carol   3pts | | | @dave    2pts ||
| | !High         | | | !High        | | | Medium        | | | Low           ||
| +---------------+ | +---------------+ | +---------------+ | +---------------+|
| +---------------+ | +---------------+ | +---------------+ | +---------------+|
| | PROJ-235      | | | PROJ-124     | | | PROJ-457      | | | PROJ-112      ||
| | API refactor  | | | Update docs  | | | Review PR     | | | Clean logs    ||
| | @bob     8pts | | | @alice   2pts| | | @eve     2pts | | | @frank   1pt  ||
| | Medium        | | | Low          | | +---------------+ | +---------------+|
| +---------------+ | +---------------+ |                   |                  |
| +---------------+ | +---------------+ |                   | [+12 more...]    |
| | PROJ-236      | | | PROJ-125     | |                   |                  |
| | Test coverage | | | Auth system  | |                   |                  |
| | Unassigned    | | | @bob     5pts| |                   |                  |
| +---------------+ | +---------------+ |                   |                  |
|                   |                   |                   |                  |
| [+2 more...]      |                   |                   |                  |
+-------------------|-------------------|-------------------|------------------+
| h/l:Column  j/k:Card  Enter:Detail  m:Move  Space:Quick-move  ?:Help         |
+--------------------------------------------------------------------------------+
```

### Column Rendering

**Column header format**:
```
| STATUS NAME (count/wip) |
| WIP: limit [status]     |
```

**WIP limit indicators**:
- Normal: `WIP: 5`
- At limit: `WIP: 5 [FULL]` (yellow)
- Over limit: `WIP: 5 [OVER!]` (red)
- No limit: `WIP: -`

**Column width calculation**:
```
available_width = terminal_width - (borders + padding)
column_width = available_width / visible_columns
min_column_width = 20  // Show at least key + status
```

**Responsive column hiding**:
- < 60 cols: Show 2 columns with horizontal scroll
- 60-100 cols: Show 3 columns
- 100-140 cols: Show 4 columns
- > 140 cols: Show all columns

### Card Representation

**Full card (>25 char column width)**:
```
+---------------+
| PROJ-123      |
| Fix login ti..|
| @john    5pts |
| !High         |
+---------------+
```

**Compact card (<25 char column width)**:
```
+-----------+
|PROJ-123 !H|
|Fix login..|
+-----------+
```

**Minimal card (<15 char column width)**:
```
+--------+
|PROJ-123|
+--------+
```

**Card elements**:
- Issue key (always visible)
- Summary (truncated)
- Assignee avatar/name (abbreviated)
- Story points
- Priority indicator

### Drag-and-Drop Alternatives

Since TUI cannot support true drag-and-drop, provide these alternatives:

**Quick-move with Space**:
1. Press `Space` on a card
2. Card is "grabbed" (highlighted)
3. Move with `h/l` to target column
4. Press `Space` again to drop
5. Or `Esc` to cancel

**Move menu with `m`**:
```
Move PROJ-123 to:
+------------------+
| > In Progress    |
|   In Review      |
|   Done           |
|   Backlog        |
+------------------+
```

**Keyboard shortcuts**:
| Key | Action |
|-----|--------|
| `1-9` | Move to column N |
| `m` | Open move menu |
| `Space` | Grab/drop card |
| `Esc` | Cancel move |

### WIP Limits Visualization

```
| IN PROGRESS (3/3) |     <- At WIP limit
| WIP: 3 [FULL]     |     <- Yellow background

| IN PROGRESS (4/3) |     <- Over WIP limit
| WIP: 3 [OVER!]    |     <- Red background, warning
```

**Visual indicators**:
- Normal: Default colors
- At limit: Yellow column header
- Over limit: Red column header + warning message

### Navigation

| Key | Action |
|-----|--------|
| `h` / `Left` | Move to previous column |
| `l` / `Right` | Move to next column |
| `j` / `Down` | Move to next card in column |
| `k` / `Up` | Move to previous card in column |
| `g` | Go to first card |
| `G` | Go to last card |
| `0` | Go to first column |
| `$` | Go to last column |
| `Enter` | Open card detail |
| `Space` | Grab/move card |
| `m` | Move card menu |
| `s` | Switch sprint/swimlane |
| `r` | Refresh board |

---

## 5. Sprint View

### Purpose
Focused view of sprint with progress, metrics, and issue management.

### ASCII Mockup

```
+--------------------------------------------------------------------------------+
| Sprint 42: Q1 Feature Development                              [Active Sprint] |
+--------------------------------------------------------------------------------+
|                                                                                 |
| PROGRESS                                              Jan 6 - Jan 20 (Day 9/14) |
| +--------------------------------------------------------------------------+   |
| |                                                                          |   |
| | Points:  [=====================>          ] 28/42 pts (67%)              |   |
| | Issues:  [========================>       ] 15/20 issues (75%)           |   |
| |                                                                          |   |
| +--------------------------------------------------------------------------+   |
|                                                                                 |
| BURNDOWN                                                                        |
| +--------------------------------------------------------------------------+   |
| | 45 |*                                                                    |   |
| | 40 | *   Ideal                                                           |   |
| | 35 |  *  ----                                                            |   |
| | 30 |   *      *                                                          |   |
| | 25 |    *       *   Actual                                               |   |
| | 20 |     *  *    *  ====                                                 |   |
| | 15 |        *  *  *                                                      |   |
| | 10 |             *  *                                                    |   |
| |  5 |                  *                                                  |   |
| |  0 +----+----+----+----+----+----+----+----+----+----+----+----+----+--  |   |
| |    D1   D3   D5   D7   D9   D11  D13  End                                |   |
| +--------------------------------------------------------------------------+   |
|                                                                                 |
| SPRINT METRICS                          | SPRINT HEALTH                         |
| Committed: 42 points                    | Say-Do Ratio: 67%                     |
| Completed: 28 points                    | Scope Change: +3 / -1 pts             |
| Remaining: 14 points                    | Blockers: 2 issues                    |
| Velocity:  34 pts (avg 31)              | At Risk: 3 issues                     |
+--------------------------------------------------------------------------------+
|                                                                                 |
| SPRINT ISSUES                                                                   |
| +--------------------------------------------------------------------------+   |
| | Status      | Count | Points | Issues                                    |   |
| +-------------|-------|--------|-------------------------------------------+   |
| | Done        |   8   |   15   | PROJ-111, PROJ-112, PROJ-113, ...        |   |
| | In Review   |   3   |    7   | PROJ-123, PROJ-456, PROJ-789             |   |
| | In Progress |   4   |   10   | PROJ-124, PROJ-125, PROJ-234, PROJ-235   |   |
| | To Do       |   5   |   10   | PROJ-126, PROJ-127, ...                  |   |
| +--------------------------------------------------------------------------+   |
|                                                                                 |
| [i] View Issues  [b] Board  [a] Add Issues  [r] Remove Issues  [c] Complete    |
| [s] Start Sprint [m] Metrics Detail  [g] Sprint Goal  [?] Help  [q] Back       |
+--------------------------------------------------------------------------------+
```

### Sprint Progress/Burndown Inline

**Progress bars**:
```
Points:  [=====================>          ] 28/42 pts (67%)
         |-------- completed --------|---- remaining ----|

Issues:  [========================>       ] 15/20 issues (75%)
```

**ASCII Burndown chart**:
```
45 |*
40 | *   Ideal ----
35 |  *
30 |   *      *
25 |    *       *   Actual ====
20 |     *  *    *
15 |        *  *  *
10 |             *  *
 5 |                  *
 0 +----+----+----+----+----+----+
   D1   D3   D5   D7   D9   D11
```

**Mini burndown for narrow terminals**:
```
Burndown: [*****.......]  On track
```

### Issue List Within Sprint

**Grouped by status**:
```
+------------------------------------------------------------+
| Done (8 issues, 15 pts)                                    |
|   PROJ-111  Add metrics dashboard     @dave      2pts Done |
|   PROJ-112  Clean up logs            @frank      1pt  Done |
|   [+6 more...]                                             |
+------------------------------------------------------------+
| In Progress (4 issues, 10 pts)                             |
|   PROJ-124  Update docs              @alice      2pts      |
|   PROJ-125  Auth system              @bob        5pts      |
|   PROJ-234  User profile             @alice      2pts      |
|   PROJ-235  API refactor             @bob        1pt       |
+------------------------------------------------------------+
```

### Sprint Actions

| Key | Action |
|-----|--------|
| `s` | Start sprint (if future) |
| `c` | Complete sprint (if active) |
| `a` | Add issues to sprint |
| `r` | Remove issues from sprint |
| `i` | View all sprint issues |
| `b` | Open board view |
| `m` | View detailed metrics |
| `g` | Edit sprint goal |
| `e` | Edit sprint dates |
| `q` | Back to sprint list |

### Sprint State Transitions

```
FUTURE                    ACTIVE                    CLOSED
+--------+  [s] Start    +--------+  [c] Complete  +--------+
| Sprint |  ---------->  | Sprint |  ----------->  | Sprint |
| 43     |               | 43     |                | 43     |
+--------+               +--------+                +--------+

Start Sprint dialog:
+----------------------------------+
| Start Sprint 43                  |
| Start Date: [2026-01-21]         |
| End Date:   [2026-02-04]         |
| Goal: [Q1 feature completion   ] |
|                                  |
| [Start]  [Cancel]                |
+----------------------------------+

Complete Sprint dialog:
+----------------------------------+
| Complete Sprint 42               |
|                                  |
| 4 incomplete issues:             |
|   PROJ-126, PROJ-127, ...        |
|                                  |
| Move to: [Sprint 43        v]    |
|          [Backlog            ]   |
|                                  |
| [Complete]  [Cancel]             |
+----------------------------------+
```

---

## 6. Search Interface

### Purpose
Powerful JQL-based search with both direct input and guided filter builder.

### ASCII Mockup - JQL Mode

```
+--------------------------------------------------------------------------------+
| Search Issues                                                                   |
+--------------------------------------------------------------------------------+
|                                                                                 |
| JQL Query:                                                                      |
| +--------------------------------------------------------------------------+   |
| | project = PROJ AND status != Done AND assignee = currentUser()           |   |
| +--------------------------------------------------------------------------+   |
| [Tab: Autocomplete]  [Ctrl+Enter: Search]  [F2: Filter Builder]                 |
|                                                                                 |
| Recent Queries:                                                                 |
| > project = PROJ AND sprint in openSprints()                                    |
|   assignee = currentUser() AND updated >= -7d                                   |
|   project = PROJ AND type = Bug AND priority = High                             |
|                                                                                 |
| Saved Filters:                                                                  |
|   [1] My Open Issues                                                            |
|   [2] Sprint Bugs                                                               |
|   [3] Overdue Tasks                                                             |
|                                                                                 |
+--------------------------------------------------------------------------------+
| JQL Syntax Help:                                                                |
| Fields: project, status, assignee, reporter, priority, type, sprint, labels    |
| Operators: =, !=, IN, NOT IN, ~, !~, IS, IS NOT, >, <, >=, <=                   |
| Functions: currentUser(), openSprints(), startOfDay(), endOfWeek()             |
| Combine: AND, OR, NOT, ORDER BY                                                 |
+--------------------------------------------------------------------------------+
```

### ASCII Mockup - Filter Builder Mode

```
+--------------------------------------------------------------------------------+
| Search Issues - Filter Builder                                    [F2: JQL Mode]|
+--------------------------------------------------------------------------------+
|                                                                                 |
| Project:    [PROJ                    v]  [x] Include sub-projects              |
| Type:       [All                     v]  Bug | Task | Story | Epic             |
| Status:     [All                     v]  To Do | In Progress | Done            |
| Assignee:   [Current User            v]  Me | Unassigned | [Search...]         |
| Reporter:   [Any                     v]                                         |
| Priority:   [Any                     v]  Highest | High | Medium | Low         |
| Sprint:     [Current Sprint          v]  Open Sprints | Specific...            |
| Labels:     [                        v]  [+] Add label filter                   |
| Created:    [Any time                v]  Today | This week | Custom range      |
| Updated:    [Any time                v]                                         |
| Due Date:   [Any                     v]  Overdue | This week | No due date     |
|                                                                                 |
| Text Search: [login timeout_______________________________________]            |
|              Searches summary and description                                   |
|                                                                                 |
| Sort By:    [Updated    v] [Descending v]                                       |
|                                                                                 |
| Generated JQL:                                                                  |
| project = PROJ AND assignee = currentUser() AND text ~ "login timeout"         |
|                                                                                 |
| [Search]  [Save Filter]  [Clear]                                               |
+--------------------------------------------------------------------------------+
```

### JQL Input Features

**Autocomplete**:
- Field names: `pro` -> `project`
- Operators after field: `project ` -> `=, !=, IN, NOT IN`
- Values: `project = PR` -> `PROJ, PROJ2, ...`
- Functions: `current` -> `currentUser()`

**Syntax highlighting** (if terminal supports colors):
- Fields: Blue
- Operators: Yellow
- Values: Green
- Functions: Magenta
- Keywords (AND, OR): Bold

**Error feedback**:
```
JQL Query:
+--------------------------------------------------------------------------+
| project = PROJ AND statuss = Done                                        |
+--------------------------------------------------------------------------+
Error: Field 'statuss' does not exist. Did you mean 'status'?
       ^^^^^^^
```

### Filter Builder UI

**Dropdown behavior**:
- Arrow keys to navigate options
- Type to filter options
- Enter to select
- Tab to move to next field

**Multi-value fields**:
```
Status: [x] To Do  [x] In Progress  [ ] In Review  [ ] Done
```

**Date range picker**:
```
Created: [Custom Range    v]
         +------------------+
         | From: [2026-01-01]
         | To:   [2026-01-15]
         +------------------+
```

### Results Display

```
+--------------------------------------------------------------------------------+
| Search Results: 48 issues found                                   [Edit Query] |
+--------------------------------------------------------------------------------+
| [ ] KEY       TYPE   STATUS      ASSIGNEE     SUMMARY                          |
+--------------------------------------------------------------------------------+
| [ ] PROJ-123  Bug    In Review   @john        Fix login timeout issues when... |
| [ ] PROJ-124  Task   To Do       @alice       Update documentation for API...  |
|>[ ] PROJ-125  Story  In Prog     @bob         Implement new authentication...  |
| [ ] PROJ-126  Task   To Do       Unassigned   Add unit tests for payment...    |
+--------------------------------------------------------------------------------+
| [Tab: Edit Query]  [Enter: Open Issue]  [s: Save Filter]  [e: Export]          |
+--------------------------------------------------------------------------------+
```

### Search Navigation

| Key | Action |
|-----|--------|
| `Tab` | Switch between query and results |
| `Ctrl+Enter` | Execute search |
| `F2` | Toggle JQL / Filter Builder mode |
| `/` | Focus query input |
| `Enter` (in results) | Open issue |
| `s` | Save as filter |
| `1-9` | Apply saved filter |
| `Up/Down` (in query) | Browse recent queries |

---

## Global Keybindings

### Consistent Across All Screens

| Key | Action |
|-----|--------|
| `?` | Show help overlay |
| `q` / `Esc` | Back / Quit current view |
| `Q` | Quit application |
| `r` | Refresh current view |
| `o` | Open current item in browser |
| `:` | Command palette |
| `/` | Search |
| `g` | Go to (quick navigation) |

### Vim-Style Navigation

| Key | Action |
|-----|--------|
| `j` / `Down` | Move down |
| `k` / `Up` | Move up |
| `h` / `Left` | Move left / collapse |
| `l` / `Right` | Move right / expand |
| `g` | Go to first |
| `G` | Go to last |
| `Ctrl+d` | Half page down |
| `Ctrl+u` | Half page up |
| `Ctrl+f` | Full page down |
| `Ctrl+b` | Full page up |

### Mouse Support (Optional)

- Click to select
- Scroll to navigate lists
- Double-click to open
- Right-click for context menu

---

## Visual Design System

### Color Palette

```
Status Colors:
  To Do:       Gray (#888888)
  In Progress: Blue (#3B82F6)
  In Review:   Purple (#8B5CF6)
  Done:        Green (#22C55E)
  Blocked:     Red (#EF4444)

Priority Colors:
  Highest:     Red (#EF4444)
  High:        Orange (#F97316)
  Medium:      Yellow (#EAB308)
  Low:         Blue (#3B82F6)
  Lowest:      Gray (#6B7280)

Issue Type Icons:
  Bug:         B (red)
  Task:        T (blue)
  Story:       S (green)
  Epic:        E (purple)
  Subtask:     - (gray)
```

### Box Drawing Characters

```
Borders:     ┌ ─ ┐   ┬
             │   │   │
             ├ ─ ┤   ┼
             └ ─ ┘   ┴

Progress:    [████████░░░░░░░░░░░░] 40%

Tables:      ╔═══╤═══╤═══╗
             ║   │   │   ║
             ╟───┼───┼───╢
             ╚═══╧═══╧═══╝
```

### Typography

```
Headers:     BOLD UPPERCASE
Subheaders:  Bold Mixed Case
Body:        Normal text
Emphasis:    *italic* or _underline_
Code:        `monospace`
Links:       [underlined] (if supported)
```

---

## Implementation Notes

### Framework Recommendations

For TypeScript/Node.js:
1. **Ink** - React-based TUI framework (good for component model)
2. **Blessed** - Full-featured terminal library
3. **Terminal-kit** - Comprehensive terminal utilities

### Responsive Design Strategy

```typescript
interface TerminalLayout {
  width: number;
  height: number;

  // Breakpoints
  isNarrow: boolean;    // < 80 cols
  isMedium: boolean;    // 80-120 cols
  isWide: boolean;      // > 120 cols

  // Layout decisions
  columnCount: number;
  showSidebar: boolean;
  truncationLimit: number;
}

function calculateLayout(cols: number, rows: number): TerminalLayout {
  return {
    width: cols,
    height: rows,
    isNarrow: cols < 80,
    isMedium: cols >= 80 && cols < 120,
    isWide: cols >= 120,
    columnCount: cols < 60 ? 2 : cols < 100 ? 3 : cols < 140 ? 4 : 5,
    showSidebar: cols >= 100,
    truncationLimit: Math.max(20, Math.floor(cols / 4)),
  };
}
```

### Data Caching

```typescript
// Cache structure for TUI performance
interface TUICache {
  myIssues: CachedData<JiraIssue[]>;
  currentSprint: CachedData<JiraSprint>;
  boardColumns: CachedData<BoardColumn[]>;
  recentActivity: CachedData<Activity[]>;
}

interface CachedData<T> {
  data: T;
  fetchedAt: Date;
  staleAfter: number; // seconds
}
```

### Keyboard Handler Pattern

```typescript
type KeyHandler = (key: string, ctrl: boolean, shift: boolean) => boolean;

const issueListKeys: Record<string, KeyHandler> = {
  'j': () => moveDown(),
  'k': () => moveUp(),
  'enter': () => openDetail(),
  't': () => showTransitionMenu(),
  'space': () => toggleSelection(),
  '?': () => showHelp(),
};
```

---

## Sources

- [jira-cli](https://github.com/ankitpokhrel/jira-cli) - Feature-rich interactive Jira CLI
- [JiraTUI](https://github.com/whyisdifficult/jiratui) - Textual-based Jira TUI
- [jira-tui (Jorres)](https://github.com/Jorres/jira-tui) - Multi-tab Jira interface
- [kanban-tui](https://github.com/Zaloog/kanban-tui) - Python kanban board TUI
- [rust_kanban](https://github.com/yashs662/rust_kanban) - Rust kanban with mouse support
- [Lazygit](https://github.com/jesseduffield/lazygit) - Excellent TUI UX patterns
- [Command Line Interface Guidelines](https://clig.dev/) - CLI design best practices
- [terminal-columns](https://github.com/privatenumber/terminal-columns) - Responsive table rendering
- [awesome-tuis](https://github.com/rothgar/awesome-tuis) - Comprehensive TUI list
