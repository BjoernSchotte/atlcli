# Documentation Improvement Plan v2

Comprehensive analysis of code vs documentation reveals significant gaps. This plan addresses all issues found.

---

## CRITICAL ISSUES (Must Fix Immediately)

### 1. Command Syntax Mismatches - Users Will Fail

| Documentation Says | Code Actually Does | Fix |
|-------------------|-------------------|-----|
| `atlcli jira get PROJ-123` | `atlcli jira issue get --key PROJ-123` | Update docs to show `issue` subcommand |
| `atlcli jira create ...` | `atlcli jira issue create ...` | Update docs |
| `atlcli page get 12345` | `atlcli page get --id 12345` | Update docs to show `--id` flag |
| `atlcli page comments add 12345 --body "text"` | `atlcli page comments add --id 12345 "text"` | Update docs |
| `atlcli docs init ./docs --space TEAM` | `atlcli docs init <dir> --space KEY` | Minor, but clarify |
| `atlcli jira analytics velocity` | `atlcli jira analyze velocity` | Command name wrong in docs |

### 2. Documented Commands That Don't Exist

| Documented Command | Status | Action |
|-------------------|--------|--------|
| `atlcli config show/get/set/...` | NOT IMPLEMENTED | Remove from docs OR implement |
| `atlcli label list/search/pages/rename/delete` | NOT IMPLEMENTED | Remove from docs (only `page label` exists) |
| `atlcli space update/delete/permissions` | NOT IMPLEMENTED | Remove from docs |
| `atlcli page attachment list/add/download` | NOT IMPLEMENTED | Remove from docs |
| `atlcli jira filter favorite/unfavorite` | NOT IMPLEMENTED | Remove from docs |
| `atlcli jira analytics cycle-time/lead-time/burnup` | NOT IMPLEMENTED | Remove from docs |
| `atlcli plugin get/update/create` | NOT IMPLEMENTED | Remove from docs |

### 3. Environment Variable Name Mismatch

- **Docs say**: `ATLCLI_BASE_URL`
- **Code uses**: `ATLCLI_SITE` (auth.ts:76)
- **Fix**: Update docs to show both, or standardize on one

---

## HIGH PRIORITY - Major Documentation Gaps

### 4. Completely Undocumented Commands

These exist in code but have NO documentation:

| Command | File:Line | What It Does |
|---------|-----------|--------------|
| `jira issue transitions` | jira.ts | List available transitions |
| `jira board list/get/backlog/issues` | jira.ts:621-749 | Board management |
| `jira sprint report` | jira.ts:978-1065 | Sprint metrics report |
| `jira filter share` | jira.ts:3001 | Share filter with users/groups |
| `jira field search` | jira.ts:4523 | Search fields by name |
| `jira subtask list/create` | jira.ts:3788-3908 | Subtask management |
| `jira component list/create/update/delete` | jira.ts:3912-4105 | Component management |
| `jira version list/create/release/delete` | jira.ts:4109-4346 | Version management |
| `jira watchers` | jira.ts | List issue watchers |
| `docs add` | docs.ts:873-1020 | Add page from template |
| `docs status` | docs.ts:1565-1703 | Show sync status |
| `docs resolve` | docs.ts:1708-1763 | Resolve sync conflicts |
| `docs diff` | docs.ts:1765-1825 | Show local vs remote diff |
| `docs check` | docs.ts:1827-1882 | Validate docs |
| `space create` | space.ts:57-67 | Create space |

### 5. Undocumented Flags on Existing Commands

| Command | Undocumented Flags | File:Line |
|---------|-------------------|-----------|
| `page list` | `--cql`, `--label` | page.ts:144-146 |
| `page create` | `--var` (template variables) | page.ts:239-260 |
| `page move` | `--before`, `--after`, `--first`, `--last`, `--position` | page.ts:1008-1086 |
| `page label add` | `--cql`, `--dry-run`, `--confirm` (bulk) | page.ts:332-373 |
| `page delete` | `--cql`, `--dry-run` (bulk) | page.ts:1244-1344 |
| `search` | `--format compact`, `--verbose` | search.ts:244,251-258 |
| `jira search` | `--type`, `--label`, `--sprint` shortcuts | jira.ts:3132-3150 |
| `jira board list` | `--type`, `--name`, `--project` | jira.ts:652-654 |
| `jira sprint create` | `--goal` | jira.ts |
| `jira bulk edit` | `--dry-run`, `--limit` | jira.ts:2466-2467 |
| `jira worklog add` | `--round` | jira.ts:1523-1525 |
| `jira epic list` | `--board`, `--done` | jira.ts:1586-1587 |

### 6. Jira Bulk Operations - Syntax Completely Wrong

**Docs say:**
```bash
atlcli jira bulk edit --jql "..." --set-labels api
atlcli jira bulk edit --jql "..." --set-priority High
```

**Code actually does:**
```bash
atlcli jira bulk edit --jql "..." --set "labels=api"
atlcli jira bulk edit --jql "..." --set "priority=High"
```

**Fix**: Rewrite bulk-operations.md with correct `--set field=value` syntax

### 7. Webhook Documentation - Completely Different Approach

**Docs describe**: Configuration file-based approach (`.atlcli-webhooks.json`)
**Code implements**: CLI flag-based approach (`--port`, `--secret`, `--events`)

**Fix**: Rewrite webhooks.md for both Confluence and Jira to match actual CLI

---

## MEDIUM PRIORITY - Feature Documentation Gaps

### 8. Missing Feature Documentation

| Feature | What's Missing | Where to Add |
|---------|---------------|--------------|
| Three-way merge algorithm | How conflicts are detected/resolved | sync.md |
| Conflict markers format | `<<<<<<< LOCAL` / `>>>>>>> REMOTE` | sync.md |
| Timer state file | `~/.atlcli/timer.json` location | time-tracking.md |
| Rate limiting | Automatic retry with backoff | New: reference/api-behavior.md |
| Story points detection | Auto-detects custom field by name | analytics.md |
| Template field filtering | Which fields are excluded | jira/templates.md |
| Scope change calculation | How `addedDuringSprint` works | analytics.md |
| Attachment MIME types | Supported file types | confluence/attachments.md |
| Markdown normalization | CRLF handling, whitespace | sync.md |
| Content hashing | SHA-256 for change detection | sync.md |

### 9. Time Format Documentation Incomplete

**Docs show**: `1h30m`, `2h`
**Code supports**: `1h30m`, `1.5h`, `90m`, `1:30`, `1 hour 30 minutes`, `1w 2d 3h 4m`, `today`, `yesterday`, `14:30`, ISO 8601

**Fix**: Add complete time format reference to time-tracking.md

### 10. Macro Documentation Incomplete

**Documented macros**: ~15
**Implemented macros**: 28+

**Missing from docs**:
- `:::include page="id"` - Include another page
- Local image syntax: `![alt](./page.attachments/file)`
- Local attachment link: `[text](./page.attachments/file)`
- Code block extended syntax: `` ```python{title="example.py" collapse} ``
- Unknown macro preservation (base64 encoding)

---

## LOW PRIORITY - Minor Gaps

### 11. Help Text Inconsistencies

- Global `--profile` flag works but not shown in `--help`
- `--version` flag works but not shown in `--help`
- OAuth flag shown in auth help but marked "not implemented"

### 12. Exit Codes Not Documented

Code defines error codes but no documentation:
- `ATLCLI_ERR_USAGE`
- `ATLCLI_ERR_AUTH`
- `ATLCLI_ERR_API`
- `ATLCLI_ERR_IO`
- `ATLCLI_ERR_CONFIG`
- `ATLCLI_ERR_VALIDATION`

### 13. Plugin System Gaps

- Hook system underdocumented (`beforeCommand`, `afterCommand`, `errorHooks`)
- Plugin installation only works from local path (npm/git URL not implemented)
- No documentation about hook parameters and context

---

## IMPLEMENTATION PLAN

### Phase 1: Critical Fixes (Immediate)

1. **Fix Jira command syntax** in all docs
   - Change `jira get` → `jira issue get`
   - Change `jira create` → `jira issue create`
   - Add `--key` flag where needed

2. **Fix page command syntax**
   - Add `--id` flag to examples
   - Fix comments command syntax

3. **Remove documented-but-not-implemented commands**
   - Remove `config` command section
   - Remove standalone `label` commands
   - Remove `space update/delete/permissions`
   - Remove `page attachment` commands
   - Remove `jira filter favorite/unfavorite`
   - Remove `jira analytics cycle-time/lead-time/burnup`
   - Remove `plugin get/update/create`

4. **Fix analytics command name**
   - Change `jira analytics` → `jira analyze`

5. **Fix bulk operations syntax**
   - Change `--set-labels` → `--set labels=value`

### Phase 2: Add Missing Command Documentation

6. **Create/update Jira docs**:
   - Add `jira board` commands to boards-sprints.md
   - Add `jira sprint report` to boards-sprints.md
   - Add `jira filter share` to filters.md
   - Add `jira field search` to fields.md
   - Add `jira component` to projects.md (enhance)
   - Add `jira version` to projects.md (enhance)
   - Add `jira watchers` to issues.md

7. **Create/update Confluence docs**:
   - Add `docs add/status/resolve/diff/check` to sync.md
   - Add `space create` to spaces.md

8. **Update cli-commands.md** with all missing commands/flags

### Phase 3: Enhance Feature Documentation

9. **Enhance sync.md**:
   - Add three-way merge explanation
   - Add conflict marker format
   - Add `.atlcli/` directory structure details

10. **Enhance time-tracking.md**:
    - Add complete time format reference
    - Add timer state file location
    - Add rounding options

11. **Enhance macros.md**:
    - Add all 28+ supported macros
    - Add code block extended syntax
    - Add local attachment syntax

12. **Rewrite webhooks.md** (both Confluence and Jira):
    - Document actual CLI flag approach
    - Remove configuration file approach

### Phase 4: Reference Documentation

13. **Create reference/api-behavior.md**:
    - Rate limiting and retry behavior
    - API version detection (Cloud vs Server)

14. **Create reference/error-codes.md**:
    - Document all error codes
    - Exit code conventions

15. **Enhance plugins/creating-plugins.md**:
    - Document hook system properly
    - Document context parameters

---

## FILES TO MODIFY

| File | Changes |
|------|---------|
| docs/jira/issues.md | Fix command syntax, add watchers |
| docs/jira/boards-sprints.md | Add board commands, sprint report |
| docs/jira/analytics.md | Fix command name, add scope-change details |
| docs/jira/bulk-operations.md | Rewrite with correct --set syntax |
| docs/jira/filters.md | Add filter share, remove favorites |
| docs/jira/fields.md | Add field search |
| docs/jira/time-tracking.md | Add all time formats, rounding |
| docs/jira/projects.md | Enhance components/versions |
| docs/jira/webhooks.md | Rewrite for CLI approach |
| docs/confluence/sync.md | Add merge algorithm, conflict markers, add/status/resolve/diff/check |
| docs/confluence/spaces.md | Add space create |
| docs/confluence/macros.md | Add all macros |
| docs/confluence/webhooks.md | Rewrite for CLI approach |
| docs/reference/cli-commands.md | Major rewrite - fix all syntax |
| docs/reference/environment.md | Fix env var names |
| docs/authentication.md | Fix env var names |
| docs/configuration.md | Remove config command references |

## FILES TO CREATE

| File | Content |
|------|---------|
| docs/reference/error-codes.md | Exit codes and error handling |
| docs/reference/api-behavior.md | Rate limiting, retries, API versions |

## SECTIONS TO REMOVE

| File | Section to Remove |
|------|-------------------|
| docs/reference/cli-commands.md | `config` commands (lines 391-399) |
| docs/reference/cli-commands.md | Standalone `label` commands (lines 108-112) |
| docs/reference/cli-commands.md | `space update/delete/permissions` |
| docs/reference/cli-commands.md | `page attachment` commands |
| docs/reference/cli-commands.md | `plugin get/update/create` |
| docs/jira/analytics.md | cycle-time, lead-time, burnup |
| docs/jira/filters.md | favorite/unfavorite commands |

---

## SUMMARY

| Category | Count |
|----------|-------|
| Critical syntax fixes | 6 |
| Commands to remove from docs | 15+ |
| Undocumented commands to add | 15+ |
| Undocumented flags to add | 25+ |
| Files to modify | 17 |
| Files to create | 2 |
| Sections to rewrite completely | 3 (bulk-ops, webhooks x2) |
