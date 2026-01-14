# Documentation Improvement Plan

Based on comprehensive source code analysis, this plan addresses all documentation gaps to achieve first-class documentation with great DX/UX.

---

## Priority 1: CRITICAL GAPS (Missing Core Features)

### 1.1 Confluence - Completely Undocumented Features

| Feature | Files to Create/Update | Effort |
|---------|----------------------|--------|
| **Webhooks** | Create `docs/confluence/webhooks.md` | New file |
| **Bulk Operations** | Add to `docs/confluence/pages.md` | Section |
| **Page Children** | Add to `docs/confluence/pages.md` | Section |
| **Page Copy** | Add to `docs/confluence/pages.md` | Section |
| **Page Archive** | Add to `docs/confluence/pages.md` | Section |
| **Page Reorder/Sort** | Create `docs/confluence/reorder.md` | New file |
| **Validation** | Create `docs/confluence/validation.md` | New file |
| **Ignore Patterns** | Create `docs/confluence/ignore.md` | New file |

### 1.2 Jira - Completely Undocumented Features

| Feature | Files to Create/Update | Effort |
|---------|----------------------|--------|
| **Attachments** | Create `docs/jira/attachments.md` | New file |
| **Subtasks** | Create `docs/jira/subtasks.md` | New file |
| **Projects** | Create `docs/jira/projects.md` | New file |
| **Components** | Create `docs/jira/components.md` | New file |
| **Versions** | Create `docs/jira/versions.md` | New file |
| **Filter Sharing** | Add to `docs/jira/filters.md` | Section |
| **Worklog Report** | Add to `docs/jira/time-tracking.md` | Section |

### 1.3 CLI Infrastructure - Critical Fixes

| Issue | Fix Required |
|-------|--------------|
| **Config path wrong** | Docs say `~/.config/atlcli/` but code uses `~/.atlcli/` - fix all references |
| **Search command missing** | Add `atlcli search` to CLI reference |
| **Template system** | Document template variables, loops, conditionals |

---

## Priority 2: HIGH GAPS (Major Feature Enhancements)

### 2.1 Confluence Command Syntax Fixes

**Comments (docs/confluence/comments.md)**:
```bash
# WRONG in docs:
atlcli page comments add 12345 --body "text"

# CORRECT per code:
atlcli page comments add --id 12345 "text"
atlcli page comments add-inline --id 12345 --selection "text to match" --match-index 0
atlcli page comments reply --id 12345 --parent <comment-id> "reply text"
```

**Labels (docs/confluence/labels.md)**:
```bash
# Add bulk operations via CQL:
atlcli page label add api --cql "space = TEAM" --confirm
atlcli page label remove deprecated --cql "space = TEAM" --dry-run
```

### 2.2 Sync Features (docs/confluence/sync.md)

Add documentation for:
- `--label <name>` - Filter sync by label
- `--webhook-port <port>` - Start webhook server
- `--webhook-url <url>` - Register webhook with Confluence
- `--auto-create` - Auto-create pages for new local files
- `--on-conflict merge|local|remote|prompt` - Conflict resolution strategies
- `--poll-interval <ms>` - Polling interval for changes
- Three-way merge algorithm explanation
- Conflict markers format
- `.atlcli/` directory structure (state, locks, base files)

### 2.3 Jira Analytics (docs/jira/analytics.md)

Add documentation for:
- `jira analyze scope-change --board <id> --sprint <id>`
- Predictability metrics
- Metric calculation explanations

### 2.4 Jira Time Tracking (docs/jira/time-tracking.md)

Add documentation for:
- `jira worklog report --user me --from <date> --to <date>`
- Time formats: `1h30m`, `1.5h`, `90m`, `1:30`, `1d`, `1w`
- Started date formats: `today`, `yesterday`, `14:30`, ISO 8601
- `--adjust-estimate auto|leave|manual|new`
- `--round 15m|30m|1h`

### 2.5 Move Operations (docs/confluence/pages.md or new reorder.md)

```bash
atlcli page move <id> --before <target-id>
atlcli page move <id> --after <target-id>
atlcli page move <id> --first
atlcli page move <id> --last
atlcli page move <id> --position <n>
atlcli page sort <parent-id> --alphabetical|--natural|--by created|modified [--reverse]
```

---

## Priority 3: MEDIUM GAPS (Feature Completeness)

### 3.1 New Documentation Files to Create

| File | Content |
|------|---------|
| `docs/confluence/webhooks.md` | Register, list, delete webhooks; event types; webhook server |
| `docs/confluence/validation.md` | Broken links, macro syntax, page size limits |
| `docs/confluence/ignore.md` | `.atlcliignore` patterns, defaults, gitignore compatibility |
| `docs/confluence/reorder.md` | Sort strategies, move operations, position control |
| `docs/jira/attachments.md` | Upload, download, list attachments |
| `docs/jira/subtasks.md` | Create, list subtasks |
| `docs/jira/projects.md` | List, get projects; issue types |
| `docs/jira/components.md` | Component CRUD operations |
| `docs/jira/versions.md` | Version management, releases |

### 3.2 Existing Files to Enhance

| File | Additions |
|------|-----------|
| `docs/confluence/pages.md` | Bulk delete/archive via CQL, copy, children |
| `docs/confluence/comments.md` | Fix command syntax, add `--type`, `--match-index` |
| `docs/confluence/labels.md` | Bulk CQL operations, `--dry-run` |
| `docs/confluence/history.md` | `--from`/`--to` comparison, restore message |
| `docs/confluence/sync.md` | All webhook/conflict/polling options |
| `docs/jira/issues.md` | Unlink, unwatch, expand options |
| `docs/jira/filters.md` | Filter sharing commands |
| `docs/jira/time-tracking.md` | Report command, all time formats, adjust options |
| `docs/jira/analytics.md` | Scope-change, predictability metrics |
| `docs/jira/bulk-operations.md` | `--set-field`, `--dry-run`, concurrency details |
| `docs/jira/fields.md` | Field search, options commands |
| `docs/jira/boards-sprints.md` | Sprint report, goal management |

### 3.3 Reference Documentation Updates

**docs/reference/cli-commands.md** - Add missing commands:
- `atlcli jira project list|get|types`
- `atlcli jira issue` subcommands
- `atlcli jira subtask create|list`
- `atlcli jira component` commands
- `atlcli jira version` commands
- `atlcli jira me`
- `atlcli page copy|children|sort|archive`
- `atlcli search` (Confluence search)

**docs/configuration.md** - Fix and add:
- Correct path: `~/.atlcli/config.json` (not `~/.config/atlcli/`)
- Project-level `.atlcli/config.json` support
- All config options with defaults

**docs/reference/environment.md** - Add:
- `ATLCLI_SITE` environment variable
- Precedence order clarification

---

## Priority 4: LOW GAPS (Advanced/Niche Features)

### 4.1 Plugin Development

| File | Content |
|------|---------|
| `docs/plugins/creating-plugins.md` | Enhance with: hooks model, lifecycle, abort signals, flag definitions |
| `docs/plugins/plugin-api.md` | Create: full API reference for plugin developers |

### 4.2 Recipes & Patterns

| File | Content |
|------|---------|
| `docs/recipes/multi-workspace.md` | Multiple Atlassian instances setup |
| `docs/recipes/log-analysis.md` | Analyzing logs for debugging |
| `docs/recipes/webhook-integration.md` | Setting up webhooks with CI/CD |
| `docs/recipes/large-migrations.md` | Migrating large Confluence spaces |
| `docs/recipes/partial-sync.md` | Sync strategies for large spaces |

### 4.3 Troubleshooting Enhancements

| Topic | Add to troubleshooting.md |
|-------|---------------------------|
| Auth failures | Token expiration, permission errors |
| Sync conflicts | Resolution strategies, manual merge |
| API rate limiting | Retry behavior, backoff |
| Large files | Size limits, chunking |
| Network issues | Timeout configuration |

### 4.4 Internal Documentation (for contributors)

| File | Content |
|------|---------|
| `docs/contributing.md` | Enhance with: error codes, testing patterns, commit conventions |
| `docs/reference/error-codes.md` | Create: ERROR_CODES enumeration documentation |

---

## Implementation Order

### Phase 1: Critical Fixes (Immediate)
1. Fix config path references (`~/.atlcli/` not `~/.config/atlcli/`)
2. Fix comment command syntax in docs
3. Add `atlcli search` to CLI reference
4. Create `docs/jira/attachments.md`
5. Create `docs/jira/subtasks.md`

### Phase 2: Core Enhancements (High Priority)
6. Enhance `docs/confluence/sync.md` with all options
7. Enhance `docs/confluence/pages.md` with bulk/copy/children/archive
8. Create `docs/confluence/webhooks.md`
9. Create `docs/confluence/validation.md`
10. Create `docs/confluence/ignore.md`
11. Enhance `docs/jira/time-tracking.md` with all formats
12. Enhance `docs/jira/analytics.md` with all metrics

### Phase 3: Feature Completeness (Medium Priority)
13. Create `docs/jira/projects.md`
14. Create `docs/jira/components.md`
15. Create `docs/jira/versions.md`
16. Create `docs/confluence/reorder.md`
17. Enhance `docs/jira/filters.md` with sharing
18. Enhance `docs/jira/bulk-operations.md`
19. Update all CLI reference commands

### Phase 4: Polish (Lower Priority)
20. Add advanced recipes
21. Enhance troubleshooting
22. Plugin API documentation
23. Error codes reference
24. Contributor documentation

---

## Summary Statistics

| Category | Current Coverage | Target | Gap |
|----------|-----------------|--------|-----|
| Confluence Features | ~50% | 95% | 45% |
| Jira Features | ~55% | 95% | 40% |
| CLI Reference | ~60% | 100% | 40% |
| Configuration | ~40% | 95% | 55% |
| Recipes | ~20% | 80% | 60% |
| Troubleshooting | ~30% | 90% | 60% |

**Total new files to create**: 12
**Total files to enhance**: 18
**Critical syntax fixes**: 5
**Config/path fixes**: 3

---

## Verification Checklist

After implementation, verify:
- [ ] All CLI `--help` output matches documentation
- [ ] All code examples in docs are executable
- [ ] Config paths are consistent throughout
- [ ] Command syntax matches actual implementation
- [ ] Navigation includes all new pages
- [ ] No broken internal links
- [ ] mkdocs builds without warnings
