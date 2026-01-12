# Jira Package Research

Comprehensive research for implementing first-class Jira support in atlcli.

---

## Executive Summary

This document consolidates research on Jira REST API capabilities for building a CLI tool. Key findings:

- **API v3 is required** for Jira Cloud (v2 deprecated by Oct 2025)
- **JQL is powerful** with 50+ functions, history operators, and saved filters
- **Agile metrics require workarounds** - no official API for velocity/burndown charts
- **Time tracking is well-supported** via native API and Tempo plugin
- **Bulk operations available** for up to 1,000 issues per request
- **Goals API does not exist** yet (feature request pending)

---

## 1. API Overview

### Versions and Base URLs

| Platform | API Version | Base URL |
|----------|-------------|----------|
| Jira Cloud | v3 (required) | `https://{site}.atlassian.net/rest/api/3/` |
| Jira Software (Agile) | 1.0 | `https://{site}.atlassian.net/rest/agile/1.0/` |
| Jira Server/DC | v2/latest | `https://{server}/rest/api/2/` |

**Important:** API v2 is being retired between August-October 2025. All new development must target v3.

### Authentication

| Method | Platform | Implementation |
|--------|----------|----------------|
| API Token + Basic Auth | Cloud | `Authorization: Basic base64(email:token)` |
| OAuth 2.0 (3LO) | Cloud | Authorization code flow |
| Personal Access Token | Server/DC | `Authorization: Bearer {PAT}` |

### Rate Limits (Cloud)

- Points-based model (enforced Feb 2026)
- Burst limits for short time windows
- Quota limits evaluated hourly
- Handle HTTP 429 with `Retry-After` header
- Implement exponential backoff with jitter

### Key Differences: Cloud vs Server

| Aspect | Cloud | Server/DC |
|--------|-------|-----------|
| User ID | Account ID (opaque) | Username |
| Rich Text | Atlassian Document Format (ADF) | Wiki markup |
| Webhooks | Expire after 30 days | Persistent |
| Rate Limits | Strict, points-based | Configurable |

---

## 2. Core CRUD Operations

### Issues

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Create | `/rest/api/3/issue` | POST |
| Create bulk | `/rest/api/3/issue/bulk` | POST (max 1000) |
| Get | `/rest/api/3/issue/{issueIdOrKey}` | GET |
| Update | `/rest/api/3/issue/{issueIdOrKey}` | PUT |
| Delete | `/rest/api/3/issue/{issueIdOrKey}` | DELETE |
| Search (JQL) | `/rest/api/3/search` | GET/POST |
| Transition | `/rest/api/3/issue/{key}/transitions` | POST |

### Issue Sub-resources

- Comments: `/rest/api/3/issue/{key}/comment`
- Attachments: `/rest/api/3/issue/{key}/attachments`
- Worklogs: `/rest/api/3/issue/{key}/worklog`
- Watchers: `/rest/api/3/issue/{key}/watchers`
- Links: `/rest/api/3/issueLink`

### Projects

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List | `/rest/api/3/project/search` | GET |
| Get | `/rest/api/3/project/{key}` | GET |
| Create | `/rest/api/3/project` | POST |
| Update | `/rest/api/3/project/{key}` | PUT |
| Delete | `/rest/api/3/project/{key}` | DELETE |

### Users & Groups

- Users identified by `accountId` in Cloud
- Bulk user fetch: `/rest/api/3/user/bulk`
- Group management: `/rest/api/3/group/*`

---

## 3. JQL (Jira Query Language)

### Operators

| Type | Operators |
|------|-----------|
| Comparison | `=`, `!=`, `>`, `>=`, `<`, `<=` |
| Text | `~` (contains), `!~` (not contains) |
| List | `IN`, `NOT IN` |
| Empty | `IS EMPTY`, `IS NOT EMPTY` |
| History | `WAS`, `WAS NOT`, `CHANGED` |
| Logical | `AND`, `OR`, `NOT` |

### Key Functions

**User Functions:**
- `currentUser()` - Logged-in user
- `membersOf("group")` - Group members

**Date Functions:**
- `now()`, `startOfDay()`, `endOfDay()`
- `startOfWeek()`, `endOfWeek()` (with offset support)
- `startOfMonth()`, `endOfMonth()`
- `startOfYear()`, `endOfYear()`

**Sprint Functions:**
- `openSprints()` - Active sprints
- `closedSprints()` - Completed sprints
- `futureSprints()` - Planned sprints

**Version Functions:**
- `releasedVersions()`, `unreleasedVersions()`
- `latestReleasedVersion()`, `earliestUnreleasedVersion()`

### History Predicates

```jql
status CHANGED FROM "To Do" TO "Done" AFTER "2024-01-01"
assignee WAS currentUser() DURING (startOfMonth(), endOfMonth())
```

### Example Queries

```jql
# My open issues in current sprint
sprint IN openSprints() AND assignee = currentUser() AND resolution IS EMPTY

# Critical bugs created this week
issuetype = Bug AND priority IN (Critical, Blocker) AND created >= startOfWeek()

# Overdue issues
due < now() AND resolution IS EMPTY

# Issues changed status this week
status CHANGED DURING (startOfWeek(), endOfWeek())

# Stale issues (not updated in 30 days)
updated < -30d AND resolution IS EMPTY
```

### Saved Filters API

```
POST /rest/api/3/filter  # Create filter
GET /rest/api/3/filter/{id}  # Get filter
PUT /rest/api/3/filter/{id}  # Update filter
```

---

## 4. Agile/Sprint Features

### Board & Sprint API

| Operation | Endpoint |
|-----------|----------|
| List boards | `/rest/agile/1.0/board` |
| Get board | `/rest/agile/1.0/board/{id}` |
| Board sprints | `/rest/agile/1.0/board/{id}/sprint` |
| Create sprint | `/rest/agile/1.0/sprint` |
| Get sprint | `/rest/agile/1.0/sprint/{id}` |
| Sprint issues | `/rest/agile/1.0/sprint/{id}/issue` |
| Move to sprint | `/rest/agile/1.0/sprint/{id}/issue` (POST) |
| Backlog issues | `/rest/agile/1.0/board/{id}/backlog` |

### Sprint States

- `future` - Not started
- `active` - In progress
- `closed` - Completed

### Metrics and Reports (Limited API)

**No official API for:**
- Velocity charts
- Burndown/burnup data
- Sprint reports

**Workaround - GreenHopper API (undocumented):**

```
GET /rest/greenhopper/1.0/rapid/charts/velocity.json?rapidViewId={boardId}
GET /rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId={boardId}&sprintId={sprintId}
GET /rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart?rapidViewId={boardId}&sprintId={sprintId}
```

**Limitations:**
- Only returns last 7 sprints for velocity
- Requires Basic Auth (OAuth doesn't work)
- Undocumented and may change

### Programmatic Analysis Required

Calculate metrics from issue data:

```python
def calculate_sprint_velocity(issues, story_points_field):
    """Sum completed story points in sprint."""
    return sum(
        getattr(issue.fields, story_points_field) or 0
        for issue in issues
        if issue.fields.status.statusCategory.key == 'done'
    )

def analyze_commitment_vs_completion(sprint_issues, changelog):
    """Track scope changes during sprint."""
    committed = 0  # Points at sprint start
    completed = 0  # Points done
    added = 0      # Points added mid-sprint
    removed = 0    # Points removed mid-sprint
    # Analyze changelog for sprint membership changes
    return {'committed': committed, 'completed': completed,
            'added': added, 'removed': removed}
```

### Key Metrics to Implement

| Metric | Calculation |
|--------|-------------|
| Velocity | Sum of completed story points |
| Average Velocity | Rolling average (3-5 sprints) |
| Say-Do Ratio | Completed / Committed * 100 |
| Scope Stability | (Added + Removed) / Committed |
| Sprint Health | Composite score of above |

---

## 5. Time Tracking

### Worklog CRUD

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Create | `/rest/api/3/issue/{key}/worklog` | POST |
| List | `/rest/api/3/issue/{key}/worklog` | GET |
| Update | `/rest/api/3/issue/{key}/worklog/{id}` | PUT |
| Delete | `/rest/api/3/issue/{key}/worklog/{id}` | DELETE |
| Bulk updated | `/rest/api/3/worklog/updated?since={ts}` | GET |
| Bulk move | `/rest/api/3/worklog/move` | POST |
| Bulk delete | `/rest/api/3/worklog/delete` | POST |

### Create Worklog Request

```json
{
  "timeSpentSeconds": 3600,
  "started": "2024-01-15T09:00:00.000+0000",
  "comment": {
    "type": "doc",
    "version": 1,
    "content": [{"type": "paragraph", "content": [{"text": "Work description", "type": "text"}]}]
  }
}
```

### Time Tracking Fields

| Field | Description |
|-------|-------------|
| `timeoriginalestimate` | Original estimate (seconds) |
| `timeestimate` | Remaining estimate (seconds) |
| `timespent` | Total logged (seconds) |
| `aggregatetimespent` | Sum including subtasks |

### Duration Formats

- `w` - weeks (typically 5 days)
- `d` - days (typically 8 hours)
- `h` - hours
- `m` - minutes

### Tempo API (Optional)

For advanced time tracking with billable hours:

```
Base URL: https://api.tempo.io/4

POST /worklogs  # Create with billableSeconds
GET /worklogs?project={id}&from=2024-01-01&to=2024-01-31
```

**Account Categories:** BILLABLE, CAPITALIZED, INTERNAL, OPERATIONAL

---

## 6. Epic & Hierarchy Management

### Epic API

| Operation | Endpoint |
|-----------|----------|
| Get epic | `/rest/agile/1.0/epic/{epicIdOrKey}` |
| Epic issues | `/rest/agile/1.0/epic/{epicIdOrKey}/issue` |
| Move to epic | `/rest/agile/1.0/epic/{epicIdOrKey}/issue` (POST) |
| Issues without epic | `/rest/agile/1.0/epic/none/issue` |
| Board epics | `/rest/agile/1.0/board/{boardId}/epic` |

### Parent-Child Linking

**Use `parent` field (recommended):**
```json
{
  "fields": {
    "parent": {"key": "EPIC-123"},
    "summary": "Child issue",
    "issuetype": {"name": "Story"}
  }
}
```

**Note:** `Epic Link` custom field is deprecated.

### Hierarchy Levels

```
Default:
  Epic (Level 1) → Story/Task (Level 0) → Subtask (Level -1)

Premium (Advanced Roadmaps):
  Initiative (Level 2+) → Epic → Story → Subtask
```

### Progress Calculation

Jira tracks by issue count, not story points. Calculate programmatically:

```python
def epic_progress_by_points(epic_issues, story_points_field):
    total = sum(getattr(i.fields, story_points_field) or 0 for i in epic_issues)
    done = sum(
        getattr(i.fields, story_points_field) or 0
        for i in epic_issues
        if i.fields.status.statusCategory.key == 'done'
    )
    return (done / total * 100) if total > 0 else 0
```

### Cross-Project Dependencies

```json
POST /rest/api/3/issueLink
{
  "type": {"name": "Blocks"},
  "inwardIssue": {"key": "PROJ-123"},
  "outwardIssue": {"key": "OTHER-456"}
}
```

### Goals API

**NOT AVAILABLE** - Feature request: ATLAS-140

Workaround: Link epics to Atlassian projects via UI only.

---

## 7. Bulk Operations

### Bulk Create/Edit/Delete

| Operation | Endpoint | Limit |
|-----------|----------|-------|
| Bulk create | `POST /rest/api/3/issue/bulk` | 1,000 issues |
| Bulk edit | `POST /rest/api/3/bulk/issues/fields` | 1,000 issues |
| Bulk transition | `POST /rest/api/3/issue/bulk/transition` | 1,000 issues |
| Bulk delete | `POST /rest/api/3/issue/bulk/delete` | 1,000 issues |

### Bulk Edit Request

```json
{
  "selectedActions": ["labels", "priority"],
  "selectedIssueIdsOrKeys": ["TEST-1", "TEST-2"],
  "editedFieldsInput": {
    "labels": {"bulkEditMultiSelectFieldOption": "ADD", "value": ["new-label"]},
    "priority": {"value": "High"}
  }
}
```

### Fields That Cannot Be Bulk Edited

- Summary, Description (individual per issue)
- Attachments
- Time tracking fields
- Resolution (requires workflow)

### Bulk Worklog Operations

```json
POST /rest/api/3/worklog/move
{
  "sourceIssueIdOrKey": "TEST-1",
  "targetIssueIdOrKey": "TEST-2",
  "worklogIds": [10001, 10002]
}
```

Limit: 5,000 worklogs per operation

### Issue Linking

**No bulk linking API** - must script individual calls:

```bash
for link in links; do
  curl -X POST /rest/api/3/issueLink -d "$link"
done
```

---

## 8. Administration Features

### Custom Fields

```
GET /rest/api/3/field  # List all fields
POST /rest/api/3/field  # Create custom field
GET /rest/api/3/field/{id}/contexts  # Get contexts
```

### Schemes

| Scheme | Endpoint |
|--------|----------|
| Permission | `/rest/api/3/permissionscheme` |
| Notification | `/rest/api/3/notificationscheme` |
| Issue Type | `/rest/api/3/issuetypescheme` |
| Workflow | `/rest/api/3/workflowscheme` |
| Screen | `/rest/api/3/screenscheme` |

### Automation Rules

**No API available** for managing automation rules programmatically.

---

## 9. Proposed CLI Commands

### Core Issue Commands

```bash
# CRUD
jira issue create --project PROJ --type Story --summary "Title"
jira issue get PROJ-123
jira issue update PROJ-123 --assignee user --priority High
jira issue delete PROJ-123 --confirm

# Search
jira search "project = PROJ AND status = Open"
jira search --assignee me --sprint current
jira search --label bug --created-since 7d

# Transitions
jira issue transition PROJ-123 --to "In Progress"
jira issue transition PROJ-123 --to Done --resolution Fixed
```

### Sprint/Agile Commands

```bash
# Boards
jira board list
jira board get 123

# Sprints
jira sprint list --board 123
jira sprint create --board 123 --name "Sprint 1" --start 2024-01-15 --end 2024-01-29
jira sprint start 456
jira sprint close 456

# Sprint management
jira sprint add PROJ-123 PROJ-124 --sprint 456
jira sprint remove PROJ-123 --sprint 456

# Analysis
jira sprint report 456
jira sprint velocity --board 123
jira sprint burndown 456
```

### Time Tracking Commands

```bash
# Log time
jira worklog add PROJ-123 2h --comment "Development"
jira worklog add PROJ-123 1h30m --started "2024-01-15 09:00"

# Query
jira worklog list PROJ-123
jira worklog list --user me --since 7d
jira worklog report --project PROJ --from 2024-01-01 --to 2024-01-31

# Manage
jira worklog update 10001 --time 3h
jira worklog delete 10001 --confirm
```

### Epic Commands

```bash
# Epic management
jira epic list --project PROJ
jira epic get EPIC-123
jira epic create --project PROJ --summary "Epic title"

# Child issues
jira epic issues EPIC-123
jira epic add PROJ-456 PROJ-457 --epic EPIC-123
jira epic remove PROJ-456 --epic EPIC-123

# Progress
jira epic progress EPIC-123
jira epic report EPIC-123
```

### Bulk Commands

```bash
# Bulk operations
jira bulk create --file issues.json
jira bulk edit --jql "project = PROJ" --set priority=High
jira bulk transition --jql "sprint = 456" --to Done
jira bulk delete --jql "label = to-delete" --confirm

# Import/Export
jira export --jql "project = PROJ" --format csv -o issues.csv
jira import --file issues.csv --project PROJ
```

### Analysis Commands

```bash
# Velocity and metrics
jira analyze velocity --board 123 --sprints 6
jira analyze predictability --board 123
jira analyze scope-change --sprint 456

# Reports
jira report sprint --id 456
jira report backlog --board 123
jira report time --project PROJ --period month

# Health checks
jira health sprint 456
jira health backlog --board 123
```

---

## 10. Package Structure Recommendation

```
packages/jira/
├── src/
│   ├── client.ts          # Jira REST API client
│   ├── jql.ts             # JQL builder and parser
│   ├── agile.ts           # Board/Sprint operations
│   ├── worklog.ts         # Time tracking
│   ├── bulk.ts            # Bulk operations
│   ├── analysis.ts        # Metrics calculation
│   └── index.ts           # Public exports
├── package.json
└── README.md

apps/cli/src/commands/
├── jira/
│   ├── issue.ts           # Issue CRUD commands
│   ├── search.ts          # JQL search command
│   ├── sprint.ts          # Sprint commands
│   ├── board.ts           # Board commands
│   ├── worklog.ts         # Time logging commands
│   ├── epic.ts            # Epic commands
│   ├── bulk.ts            # Bulk operation commands
│   └── analyze.ts         # Analysis commands
```

---

## 11. Implementation Phases

### Phase 1: Foundation
- Jira client with auth (API token, PAT)
- Issue CRUD
- Basic JQL search
- Project listing

### Phase 2: Agile Core
- Board management
- Sprint CRUD
- Move issues to/from sprints
- Backlog management

### Phase 3: Time Tracking
- Worklog CRUD
- Time queries
- Basic time reports

### Phase 4: Analysis
- Velocity calculation
- Sprint metrics
- Burndown data (from changelog)
- Health scores

### Phase 5: Bulk & Admin
- Bulk create/edit/transition
- Import/export
- Custom field management

### Phase 6: Advanced
- Epic management
- Cross-project dependencies
- Advanced reports
- Tempo integration (optional)

---

## Sources

- [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
- [Jira Software REST API (Agile)](https://developer.atlassian.com/cloud/jira/software/rest/)
- [JQL Reference](https://support.atlassian.com/jira-software-cloud/docs/jql-fields/)
- [Tempo API](https://apidocs.tempo.io/)
- [Bulk Operations](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-bulk-operations/)
