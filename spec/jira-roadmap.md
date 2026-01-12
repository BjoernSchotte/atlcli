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

**Status**: COMPLETE ✅

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

**Status**: COMPLETE ✅

Log and manage work time on issues.

**Phase 1 Features (Worklog CRUD) - COMPLETE:**
- `jira worklog add <key> <time> [--comment] [--started] [--round]` - Log time ✅
- `jira worklog list --issue <key>` - List worklogs for issue ✅
- `jira worklog update --issue <key> --id <id> [--time] [--comment] [--started]` - Update worklog ✅
- `jira worklog delete --issue <key> --id <id> --confirm` - Delete worklog ✅

**Phase 2 Features (Timer Mode) - COMPLETE:**
- `jira worklog timer start <key> [--comment]` - Start tracking time ✅
- `jira worklog timer stop [--round] [--comment]` - Stop tracking and log ✅
- `jira worklog timer status` - Show active timer ✅
- `jira worklog timer cancel` - Cancel without logging ✅

**Phase 3 Features (Pending):**
- `jira worklog report --user <user> [--since] [--until]` - Time report

**Time Formats:** `1h30m`, `1.5h`, `90m`, `1:30`, `1d`, `1w` (week=5d, day=8h)

**Started Date Formats:** `today`, `yesterday`, `14:30`, `2026-01-12`, ISO 8601

**Rounding:** `--round 15m`, `--round 30m`, `--round 1h`

**Timer Storage:** `~/.atlcli/timer.json` (global, single timer at a time)

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

**Status**: COMPLETE ✅

Manage epics and issue hierarchy.

**Features:**
- `jira epic list [--project <key>] [--board <id>] [--done]` - List epics ✅
- `jira epic get <key>` - Get epic details with progress ✅
- `jira epic create --project <key> --summary <text>` - Create epic ✅
- `jira epic issues <key> [--status]` - List child issues ✅
- `jira epic add <issues...> --epic <key>` - Add issues to epic ✅
- `jira epic remove <issues...>` - Remove from epic ✅
- `jira epic progress <key>` - Show completion progress with bar ✅

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

**Status**: COMPLETE ✅

Calculate velocity, burndown, and sprint health metrics.

**Features:**
- `jira analyze velocity --board <id> [--sprints <n>] [--points-field <field>]` - Velocity trend ✅
- `jira analyze burndown --sprint <id> [--points-field <field>]` - Burndown data ✅
- `jira analyze scope-change --sprint <id> [--points-field <field>]` - Scope stability ✅
- `jira analyze predictability --board <id> [--sprints <n>] [--points-field <field>]` - Say-do ratio ✅
- `jira sprint report <id> [--points-field <field>]` - Full sprint report ✅

**Metrics:**
| Metric | Calculation |
|--------|-------------|
| Velocity | Sum of completed story points |
| Avg Velocity | Rolling average (3-5 sprints) |
| Say-Do Ratio | Completed / Committed × 100 |
| Scope Stability | 1 - (Added + Removed) / Committed |

**Implementation Notes:**
- Story points field auto-detected from field metadata (or specify with `--points-field`)
- Burndown requires fetching changelog for each issue (can be slow for large sprints)
- Scope change analysis parses Sprint field changes in changelog

**Package Files:**
- `packages/jira/src/analysis.ts` - Metrics calculation
- `apps/cli/src/commands/jira.ts` - CLI commands (under `jira analyze`)

---

## 8. Bulk Operations (Priority: Medium)

**Status**: COMPLETE ✅

Batch operations on multiple issues.

**Features:**
- `jira bulk edit --jql <query> --set <field>=<value> [--dry-run] [--limit <n>]` - Bulk edit ✅
- `jira bulk transition --jql <query> --to <status> [--dry-run] [--limit <n>]` - Bulk transition ✅
- `jira bulk label add <label> --jql <query> [--dry-run] [--limit <n>]` - Add labels ✅
- `jira bulk label remove <label> --jql <query> [--dry-run] [--limit <n>]` - Remove labels ✅
- `jira bulk delete --jql <query> --confirm [--dry-run] [--limit <n>]` - Bulk delete ✅

**Implementation Notes:**
- No true bulk API in Jira Cloud - operations executed in parallel batches (10 concurrent)
- Reuses existing client methods (updateIssue, transitionIssue, deleteIssue, addLabels, removeLabels)
- `--dry-run` shows preview of affected issues
- `--limit <n>` caps max issues (default 1000)
- `--confirm` required for delete operations
- Supports field assignments: priority, assignee, labels

**Limitations:**
- Summary/Description cannot be bulk edited (unique per issue)
- Max 1,000 issues per operation (configurable with --limit)

**Package Files:**
- `packages/jira/src/types.ts` - BulkOperationSummary type
- `apps/cli/src/commands/jira.ts` - CLI commands (under `jira bulk`)

---

## 9. Import/Export (Priority: Low)

**Status**: COMPLETE ✅

Import and export issues with comments and attachments.

**Features:**
- `jira export --jql <query> --output <file> [--format csv|json] [--no-comments] [--no-attachments]` - Export issues ✅
- `jira import --file <path> --project <key> [--dry-run] [--skip-attachments]` - Import issues ✅

**Export:**
- Supports CSV and JSON formats
- Includes all fields (standard and custom)
- Comments exported with author, body, created
- Attachments: base64 in JSON, separate files for CSV

**Import:**
- Create-only mode (doesn't update existing)
- Dry-run preview support
- Comments and attachments included

**Package Files:**
- `packages/jira/src/export.ts` - Export logic
- `packages/jira/src/import.ts` - Import logic

---

## 10. Saved Filters (Priority: Low)

**Status**: COMPLETE ✅

Manage personal and shared JQL filters.

**Features:**
- `jira filter list [--query <text>] [--limit <n>] [--favorite]` - List saved filters ✅
- `jira filter get <id>` - Get filter details and JQL ✅
- `jira filter create --name <name> --jql <query> [--description] [--favorite]` - Create filter ✅
- `jira filter update <id> [--name] [--jql] [--description]` - Update filter ✅
- `jira filter delete <id> --confirm` - Delete filter ✅
- `jira filter share <id> --type <global|project|group> [--project] [--group]` - Share filter ✅

**API Endpoints:**
- `GET /rest/api/3/filter/search` - List
- `GET /rest/api/3/filter/{id}` - Get
- `POST /rest/api/3/filter` - Create
- `PUT /rest/api/3/filter/{id}` - Update
- `DELETE /rest/api/3/filter/{id}` - Delete
- `POST /rest/api/3/filter/{id}/permission` - Share

---

## 11. Tempo Integration (Priority: Low)

**Status**: SKIPPED ⏭️

Commercial plugin - not implementing.

**Reason:** Tempo is a paid third-party plugin. The built-in Jira time tracking (`jira worklog`) covers standard use cases.

---

## Priority Order

| Priority | Feature | Effort | Dependencies | Status |
|----------|---------|--------|--------------|--------|
| 1 | Core Issue Operations | Medium | None | ✅ COMPLETE |
| 2 | JQL Search | Medium | Issues | ✅ COMPLETE |
| 3 | Project Management | Small | Client | ✅ COMPLETE |
| 4 | Board & Sprint | Medium | Issues | ✅ COMPLETE |
| 5 | Time Tracking | Small | Issues | ✅ COMPLETE |
| 6 | Epic Management | Small | Issues, Agile | ✅ COMPLETE |
| 7 | Sprint Analytics | Large | Sprints | ✅ COMPLETE |
| 8 | Bulk Operations | Medium | Issues, JQL | ✅ COMPLETE |
| 9 | Import/Export | Medium | Issues, JQL | ✅ COMPLETE |
| 10 | Saved Filters | Small | JQL | ✅ COMPLETE |
| 11 | Tempo Integration | Medium | Time Tracking | ⏭️ SKIPPED |

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
