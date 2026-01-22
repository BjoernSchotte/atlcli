# Search

Search Confluence content using CQL (Confluence Query Language).

::: toc

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View permission on spaces to search

## Quick Start

```bash
# Search by text
atlcli wiki search "API documentation"

# Search in space
atlcli wiki search "API" --space TEAM

# Search by label
atlcli wiki search --label api
```

## Recent Pages

Quick access to recently modified pages:

```bash
# Last 7 days (default)
atlcli wiki recent

# Last 30 days
atlcli wiki recent --days 30

# Filter by space
atlcli wiki recent --space TEAM

# Filter by label
atlcli wiki recent --label api

# Limit results
atlcli wiki recent --limit 50
```

The `wiki recent` command generates CQL like:
```
type = page AND lastModified >= now("-7d") ORDER BY lastModified DESC
```

## My Pages

Quick access to pages you created or contributed to:

```bash
# Pages I created (default)
atlcli wiki my

# Pages I contributed to (edited)
atlcli wiki my --contributed

# Filter by space
atlcli wiki my --space TEAM

# Filter by label
atlcli wiki my --label api

# Limit results
atlcli wiki my --limit 50
```

The `wiki my` command generates CQL like:
```
type = page AND creator = currentUser() ORDER BY lastModified DESC
```

## CQL Search

Use full CQL for advanced queries:

```bash
atlcli wiki search --cql "space = TEAM AND label = api AND lastModified > now('-7d')"
```

## Search Filters

### By Space

```bash
atlcli wiki search "query" --space TEAM
atlcli wiki search "query" --space TEAM,DOCS,API
```

### By Content Type

```bash
atlcli wiki search "query" --type page
atlcli wiki search "query" --type blogpost
atlcli wiki search "query" --type attachment
```

### By Label

```bash
# Single label
atlcli wiki search --label api

# Multiple labels (AND)
atlcli wiki search --label "api,v2"
```

### By Creator

```bash
atlcli wiki search --creator "alice@company.com"
atlcli wiki search --creator currentUser()
```

### By Ancestor

Search within a page tree:

```bash
atlcli wiki search "query" --ancestor 12345
```

### By Date

```bash
# Modified recently
atlcli wiki search --modified-since "7d"
atlcli wiki search --modified-since "2025-01-01"

# Created recently
atlcli wiki search --created-since "30d"
```

## Search Options

| Flag | Description |
|------|-------------|
| `--space` | Filter by space key(s) |
| `--type` | Content type: page, blogpost, attachment |
| `--label` | Filter by label(s) |
| `--title` | Search in title only |
| `--creator` | Filter by creator |
| `--ancestor` | Search under page tree |
| `--modified-since` | Modified after date/duration |
| `--created-since` | Created after date/duration |
| `--limit` | Max results (default: 25) |
| `--start` | Pagination offset |
| `--format` | Output: table, json |

## Output Formats

### Table (Default)

```bash
atlcli wiki search "API" --space TEAM
```

```
ID        TITLE                 SPACE   MODIFIED
12345     API Reference         TEAM    2025-01-14
12346     API Authentication    TEAM    2025-01-13
12347     API Rate Limits       TEAM    2025-01-10
```

### JSON

```bash
atlcli wiki search "API" --space TEAM --json
```

```json
{
  "schemaVersion": "1",
  "results": [
    {
      "id": "12345",
      "title": "API Reference",
      "space": {"key": "TEAM", "name": "Team Docs"},
      "type": "page",
      "url": "https://company.atlassian.net/wiki/spaces/TEAM/pages/12345",
      "excerpt": "...comprehensive <em>API</em> documentation...",
      "lastModified": "2025-01-14T10:00:00Z",
      "creator": {"displayName": "Alice"},
      "labels": ["api", "reference"]
    }
  ],
  "total": 42,
  "limit": 25,
  "start": 0
}
```

## CQL Reference

### Common Operators

| Operator | Example |
|----------|---------|
| `=` | `space = TEAM` |
| `!=` | `space != ARCHIVE` |
| `~` | `title ~ "API*"` (contains) |
| `IN` | `space IN (TEAM, DOCS)` |
| `NOT IN` | `label NOT IN (draft, deprecated)` |
| `AND` | `space = TEAM AND type = page` |
| `OR` | `label = api OR label = docs` |

### Date Functions

| Function | Description |
|----------|-------------|
| `now()` | Current time |
| `now('-7d')` | 7 days ago |
| `now('-1M')` | 1 month ago |
| `startOfDay()` | Start of today |
| `startOfWeek()` | Start of current week |

### Special Values

| Value | Description |
|-------|-------------|
| `currentUser()` | Logged-in user |
| `currentSpace()` | Current space context |

## Examples

### Find Outdated Content

```bash
atlcli wiki search --cql "lastModified < now('-90d') AND space = DOCS"
```

### Find My Recent Pages

```bash
atlcli wiki search --creator currentUser() --modified-since 7d
```

### Find Pages Without Labels

```bash
atlcli wiki search --cql "space = TEAM AND label IS EMPTY"
```

### Find Draft Content

```bash
atlcli wiki search --label draft --space TEAM
```

### Full-Text Search in Title

```bash
atlcli wiki search --title "installation guide"
```

### Export Search Results

```bash
# Get all IDs for scripting
atlcli wiki search --label api --json | jq -r '.results[].id'

# Export to CSV
atlcli wiki search --space TEAM --json | \
  jq -r '.results[] | [.id, .title, .lastModified] | @csv'
```

## Pagination

For large result sets:

```bash
# First 25
atlcli wiki search "query" --limit 25 --start 0

# Next 25
atlcli wiki search "query" --limit 25 --start 25

# Get all (iterate)
START=0
while true; do
  RESULT=$(atlcli wiki search "query" --limit 100 --start $START --json)
  COUNT=$(echo $RESULT | jq '.results | length')
  [ "$COUNT" -eq 0 ] && break
  echo $RESULT | jq -r '.results[].title'
  START=$((START + 100))
done
```

## Troubleshooting

### No Results Found

**Symptom**: Search returns empty results for content you know exists.

**Causes**:
- Content hasn't been indexed yet (newly created pages)
- Search query syntax error
- Space filter excludes the target space

**Fix**: Wait a few minutes for indexing, or check CQL syntax. Try without space filter to verify.

### CQL Syntax Error

**Symptom**: `Error: CQL parse error`

**Cause**: Invalid CQL query syntax.

**Fix**: Check operators and field names. Use quotes around values with spaces.

## Related Topics

- [Labels](labels.md) - Search by label
- [Pages](pages.md) - Page operations after finding results
- [Audit](audit.md) - Find stale or orphaned content
