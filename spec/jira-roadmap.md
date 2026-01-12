# Jira Package Roadmap

## Overview

Roadmap for implementing first-class Jira support in atlcli as `@atlcli/jira` package.

**Prerequisites:** Uses `@atlcli/core` for authentication (no new auth implementation needed).

---

## 1. Core Issue Operations (Priority: High)

**Status**: COMPLETE ✅

Foundation for all Jira functionality.

**Features:**
- `jira issue create --project <key> --type <type> --summary <text>` - Create issue
- `jira issue get <key>` - Get issue details
- `jira issue update <key> [--assignee] [--priority] [--labels]` - Update issue
- `jira issue delete <key> --confirm` - Delete issue
- `jira issue transition <key> --to <status>` - Change status
- `jira issue link <key> --blocks|--relates <target>` - Link issues
- `jira issue comment <key> <text>` - Add comment
- `jira issue attach <key> <file>` - Add attachment

**API Endpoints:**
- `POST /rest/api/3/issue` - Create
- `GET /rest/api/3/issue/{key}` - Read
- `PUT /rest/api/3/issue/{key}` - Update
- `DELETE /rest/api/3/issue/{key}` - Delete
- `POST /rest/api/3/issue/{key}/transitions` - Transition

**Package Files:**
- `packages/jira/src/client.ts` - Core API client
- `packages/jira/src/types.ts` - Issue, Project, User types
- `apps/cli/src/commands/jira/issue.ts` - CLI commands

---

## 2. JQL Search (Priority: High)

**Status**: COMPLETE ✅

Powerful query language for finding issues.

**Features:**
- `jira search <query>` - Search with JQL
- `jira search --project <key>` - Filter by project
- `jira search --assignee <user>` - Filter by assignee (use "me" for current)
- `jira search --status <status>` - Filter by status
- `jira search --type <type>` - Filter by issue type
- `jira search --label <label>` - Filter by label
- `jira search --sprint <name|id>` - Filter by sprint
- `jira search --created-since <date>` - Date filters
- `jira search --updated-since <date>`
- Output formats: table, compact, json

**JQL Examples:**
```jql
# My open issues
assignee = currentUser() AND resolution IS EMPTY

# Sprint issues
sprint IN openSprints() AND project = PROJ

# Overdue
due < now() AND resolution IS EMPTY

# Recently changed
status CHANGED DURING (startOfWeek(), now())
```

**Package Files:**
- `packages/jira/src/jql.ts` - JQL builder helpers
- `apps/cli/src/commands/jira/search.ts` - Search command

---

## 3. Project Management (Priority: High)

**Status**: COMPLETE ✅

List and manage Jira projects.

**Features:**
- `jira project list` - List all projects
- `jira project get <key>` - Get project details
- `jira project components <key>` - List components
- `jira project versions <key>` - List versions
- `jira project types` - List issue types for project

**API Endpoints:**
- `GET /rest/api/3/project/search` - List
- `GET /rest/api/3/project/{key}` - Get
- `GET /rest/api/3/project/{key}/components` - Components
- `GET /rest/api/3/project/{key}/versions` - Versions

---

## 4. Board & Sprint Management (Priority: High)

**Status**: Not Started

Agile board and sprint operations.

**Features:**
- `jira board list` - List boards
- `jira board get <id>` - Get board details
- `jira board backlog <id>` - Show backlog issues
- `jira sprint list --board <id>` - List sprints
- `jira sprint get <id>` - Get sprint details
- `jira sprint create --board <id> --name <name> [--start] [--end]` - Create sprint
- `jira sprint start <id>` - Start sprint
- `jira sprint close <id>` - Complete sprint
- `jira sprint add <issues...> --sprint <id>` - Add issues to sprint
- `jira sprint remove <issues...> --sprint <id>` - Remove from sprint

**API Endpoints:**
- `GET /rest/agile/1.0/board` - List boards
- `GET /rest/agile/1.0/board/{id}/sprint` - Board sprints
- `POST /rest/agile/1.0/sprint` - Create sprint
- `POST /rest/agile/1.0/sprint/{id}/issue` - Move issues

**Sprint States:** `future` → `active` → `closed`

---

## 5. Time Tracking (Priority: Medium)

**Status**: Not Started

Log and manage work time on issues.

**Features:**
- `jira worklog add <key> <time> [--comment] [--started]` - Log time
- `jira worklog list <key>` - List worklogs for issue
- `jira worklog update <id> --time <time>` - Update worklog
- `jira worklog delete <id> --confirm` - Delete worklog
- `jira worklog report --user <user> [--since] [--until]` - Time report

**Time Formats:** `1w`, `2d`, `4h`, `30m` (week=5d, day=8h)

**API Endpoints:**
- `POST /rest/api/3/issue/{key}/worklog` - Create
- `GET /rest/api/3/issue/{key}/worklog` - List
- `PUT /rest/api/3/issue/{key}/worklog/{id}` - Update
- `DELETE /rest/api/3/issue/{key}/worklog/{id}` - Delete

**Package Files:**
- `packages/jira/src/worklog.ts` - Worklog operations
- `apps/cli/src/commands/jira/worklog.ts` - CLI commands

---

## 6. Epic Management (Priority: Medium)

**Status**: Not Started

Manage epics and issue hierarchy.

**Features:**
- `jira epic list --project <key>` - List epics
- `jira epic get <key>` - Get epic details
- `jira epic create --project <key> --summary <text>` - Create epic
- `jira epic issues <key>` - List child issues
- `jira epic add <issues...> --epic <key>` - Add issues to epic
- `jira epic remove <issues...>` - Remove from epic
- `jira epic progress <key>` - Show completion progress

**API Endpoints:**
- `GET /rest/agile/1.0/board/{id}/epic` - List epics
- `GET /rest/agile/1.0/epic/{key}/issue` - Epic issues
- `POST /rest/agile/1.0/epic/{key}/issue` - Move to epic

**Hierarchy:**
```
Epic (Level 1)
└── Story/Task (Level 0)
    └── Subtask (Level -1)
```

---

## 7. Sprint Analytics (Priority: Medium)

**Status**: Not Started

Calculate velocity, burndown, and sprint health metrics.

**Features:**
- `jira analyze velocity --board <id> [--sprints <n>]` - Velocity trend
- `jira analyze burndown --sprint <id>` - Burndown data
- `jira analyze scope-change --sprint <id>` - Scope stability
- `jira analyze predictability --board <id>` - Say-do ratio
- `jira sprint report <id>` - Full sprint report

**Metrics:**
| Metric | Calculation |
|--------|-------------|
| Velocity | Sum of completed story points |
| Avg Velocity | Rolling average (3-5 sprints) |
| Say-Do Ratio | Completed / Committed × 100 |
| Scope Stability | 1 - (Added + Removed) / Committed |

**Note:** No official API for velocity/burndown. Must calculate from issue data and changelog.

**Package Files:**
- `packages/jira/src/analysis.ts` - Metrics calculation
- `apps/cli/src/commands/jira/analyze.ts` - CLI commands

---

## 8. Bulk Operations (Priority: Medium)

**Status**: Not Started

Batch operations on multiple issues.

**Features:**
- `jira bulk edit --jql <query> --set <field>=<value>` - Bulk edit
- `jira bulk transition --jql <query> --to <status>` - Bulk transition
- `jira bulk label add <label> --jql <query>` - Add labels
- `jira bulk label remove <label> --jql <query>` - Remove labels
- `jira bulk delete --jql <query> --confirm` - Bulk delete
- `--dry-run` flag for preview

**API Endpoints:**
- `POST /rest/api/3/issue/bulk` - Bulk create (max 1000)
- `POST /rest/api/3/bulk/issues/fields` - Bulk edit
- `POST /rest/api/3/issue/bulk/transition` - Bulk transition
- `POST /rest/api/3/issue/bulk/delete` - Bulk delete

**Limitations:**
- Summary/Description cannot be bulk edited (unique per issue)
- Max 1,000 issues per request

**Package Files:**
- `packages/jira/src/bulk.ts` - Bulk operations
- `apps/cli/src/commands/jira/bulk.ts` - CLI commands

---

## 9. Import/Export (Priority: Low)

**Status**: Not Started

Import and export issues in various formats.

**Features:**
- `jira export --jql <query> --format csv -o file.csv` - Export to CSV
- `jira export --jql <query> --format json -o file.json` - Export to JSON
- `jira import --file issues.csv --project <key>` - Import from CSV
- `jira import --file issues.json --project <key>` - Import from JSON

**Fields for Export:**
- key, summary, status, priority, assignee, reporter
- created, updated, resolved, due
- labels, components, fix versions
- story points, time spent, time estimate

---

## 10. Saved Filters (Priority: Low)

**Status**: Not Started

Manage personal and shared JQL filters.

**Features:**
- `jira filter list` - List saved filters
- `jira filter get <id>` - Get filter JQL
- `jira filter create --name <name> --jql <query>` - Create filter
- `jira filter update <id> --jql <query>` - Update filter
- `jira filter delete <id> --confirm` - Delete filter
- `jira filter share <id> --with <group|project>` - Share filter

**API Endpoints:**
- `GET /rest/api/3/filter/search` - List
- `POST /rest/api/3/filter` - Create
- `PUT /rest/api/3/filter/{id}` - Update

---

## 11. Tempo Integration (Priority: Low)

**Status**: Not Started

Optional integration for advanced time tracking.

**Features:**
- `jira tempo log <key> <time> --account <account>` - Log with account
- `jira tempo report --from <date> --to <date>` - Detailed report
- `jira tempo accounts` - List Tempo accounts
- Billable hours tracking
- Account categories: BILLABLE, INTERNAL, OPERATIONAL

**API Base:** `https://api.tempo.io/4`

**Note:** Requires separate Tempo API token.

---

## Priority Order

| Priority | Feature | Effort | Dependencies | Status |
|----------|---------|--------|--------------|--------|
| 1 | Core Issue Operations | Medium | None | ✅ COMPLETE |
| 2 | JQL Search | Medium | Issues | ✅ COMPLETE |
| 3 | Project Management | Small | Client | ✅ COMPLETE |
| 4 | Board & Sprint | Medium | Issues | Not Started |
| 5 | Time Tracking | Small | Issues | Not Started |
| 6 | Epic Management | Small | Issues, Agile | Not Started |
| 7 | Sprint Analytics | Large | Sprints | Not Started |
| 8 | Bulk Operations | Medium | Issues, JQL | Not Started |
| 9 | Import/Export | Medium | Issues, JQL | Not Started |
| 10 | Saved Filters | Small | JQL | Not Started |
| 11 | Tempo Integration | Medium | Time Tracking | Not Started |

---

## Package Structure

```
packages/jira/
├── src/
│   ├── client.ts          # Jira REST API client (uses @atlcli/core auth)
│   ├── types.ts           # Issue, Project, Sprint, etc.
│   ├── jql.ts             # JQL builder and parser
│   ├── agile.ts           # Board/Sprint operations
│   ├── worklog.ts         # Time tracking
│   ├── bulk.ts            # Bulk operations
│   ├── analysis.ts        # Metrics calculation
│   └── index.ts           # Public exports
├── package.json           # depends on @atlcli/core
└── README.md

apps/cli/src/commands/jira/
├── issue.ts               # Issue CRUD commands
├── search.ts              # JQL search command
├── project.ts             # Project commands
├── board.ts               # Board commands
├── sprint.ts              # Sprint commands
├── worklog.ts             # Time logging commands
├── epic.ts                # Epic commands
├── analyze.ts             # Analysis commands
├── bulk.ts                # Bulk operation commands
└── index.ts               # Command registration
```

---

## Technical Notes

### API Version
- **Cloud:** Must use API v3 (v2 deprecated Oct 2025)
- **Server/DC:** API v2 supported

### Rich Text
- Cloud uses Atlassian Document Format (ADF) for descriptions/comments
- Server uses wiki markup
- Package should abstract this difference

### Rate Limits
- Points-based model (enforced Feb 2026)
- Implement exponential backoff with jitter
- Handle HTTP 429 with `Retry-After` header

### Known Limitations
- No Goals API (feature request ATLAS-140)
- No official velocity/burndown API (calculate from data)
- Automation rules not accessible via API
- GreenHopper API undocumented and may change
