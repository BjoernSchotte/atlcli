# atlcli vs jira-cli: Competitive Analysis

Comparison of atlcli against [ankitpokhrel/jira-cli](https://github.com/ankitpokhrel/jira-cli) (Go, ~4k stars, Atlassian-supported).

**Date:** 2026-01-28

---

## Executive Summary

atlcli has **more features** but jira-cli has **better UX** via its interactive TUI. The biggest competitive gap is the lack of an interactive terminal interface. atlcli's unique strengths are Confluence support, bidirectional markdown sync, and analytics.

---

## Feature Comparison

### Where atlcli EXCELS

| Area | atlcli | jira-cli |
|------|--------|----------|
| **Confluence support** | Full featured (page CRUD, sync, search, templates) | None |
| **Bidirectional Markdown↔Confluence sync** | First-class `docs pull/push/watch` | None |
| **Sprint management** | Create, start, close, report | List only |
| **Analytics** | Velocity, burndown, scope-change, predictability | None |
| **Bulk operations** | Edit/transition/label/delete via JQL | None |
| **Import/Export** | CSV/JSON with comments + attachments | None |
| **Saved JQL filters** | Full CRUD + sharing | None |
| **Webhooks** | Local server + registration API | None |
| **Timer mode** | `worklog timer start/stop/status` | None |
| **Subtask management** | Create, list | None |
| **Components/Versions** | Full CRUD | List releases only |
| **Custom fields** | List, search, get options | None |
| **Issue templates** | Hierarchical storage (global/profile/project) | Description templates only |
| **DOCX export** | Word templates for Confluence pages | None |
| **Page templates** | Handlebars with 50+ modifiers | None |

### Where atlcli is ON PAR

| Feature | Both tools have |
|---------|----------------|
| Issue CRUD | Create, get, update, delete, transition |
| JQL search | Full query support |
| Project listing | List, get |
| Worklog | Add/list/update/delete |
| Comments | Add with markdown |
| Link issues | Create/delete issue links |
| Shell completion | bash/zsh |
| JSON output | `--json` flag |
| Multiple profiles | Profile switching |

### Where jira-cli BEATS atlcli

| Gap | jira-cli | atlcli |
|-----|----------|--------|
| **Interactive TUI** | Excellent explorer view, vim navigation (hjkl, g/G), panel focus, mouse support | CLI-only |
| **Server/DC support** | Both Cloud + Server | Cloud-only (by design) |
| **Browser integration** | `jira open KEY-1`, `c` to copy URL to clipboard | Missing |
| **Issue cloning** | `issue clone` with text replacement `-H"find:replace"` | Not implemented |
| **History** | `--history` for recently viewed issues | Missing |
| **Watch filter** | `-w` to list watched issues | Have `watchers` but not as search filter |
| **Maturity** | 4k+ stars, battle-tested, Atlassian-supported | Newer, smaller community |
| **Windows** | Proper Windows support | Untested |
| **Plain output** | `--plain --columns --no-headers` combo for scripting | Have JSON, less flexible for shell scripts |

---

## jira-cli Features Worth Adopting

### High Value, Low Effort

1. **`atlcli open [KEY]`** - Open project or issue in browser
   - `atlcli open` → opens current project
   - `atlcli open PROJ-123` → opens specific issue
   - Trivial to implement, high UX value

2. **`--history`** - Recently viewed issues
   - Track issue keys viewed via `issue get`
   - Store in `~/.atlcli/history.json`
   - `atlcli jira search --history` or `atlcli jira issue list --history`

3. **Assign shortcuts**
   - `atlcli jira issue assign PROJ-123 x` → unassign
   - `atlcli jira issue assign PROJ-123 default` → default assignee
   - `atlcli jira issue assign PROJ-123 me` → self-assign (already works)

### Medium Value, Medium Effort

4. **Issue cloning**
   - `atlcli jira issue clone PROJ-123`
   - `atlcli jira issue clone PROJ-123 --replace "old:new"` - text replacement
   - Copy summary, description, priority, labels, components

5. **Watch filter for search**
   - `atlcli jira search --watching` or `-w`
   - Uses `watcher = currentUser()` JQL

6. **Plain/columns output mode**
   - `atlcli jira search --plain --columns key,summary,status --no-headers`
   - Better for shell scripting than JSON

### High Value, High Effort

7. **Interactive TUI**
   - See `spec/tui-research.md` for full analysis
   - Explorer view with vim navigation
   - Panel-based layout
   - This is the #1 competitive gap

---

## Milestones

### Milestone 1: Quick Wins (Low Effort)

**Goal:** Close obvious UX gaps with minimal implementation effort.

| Task | Effort | Impact |
|------|--------|--------|
| `atlcli open [KEY]` command | Small | High |
| Assign shortcuts (`x`, `default`) | Small | Medium |
| `--watching` / `-w` search filter | Small | Medium |

**Definition of Done:**
- Commands implemented and tested
- Help text updated
- Shell completion updated

### Milestone 2: Scripting Improvements

**Goal:** Match jira-cli's shell scripting ergonomics.

| Task | Effort | Impact |
|------|--------|--------|
| `--plain` output mode (tab-separated) | Medium | High |
| `--columns` flag for field selection | Medium | High |
| `--no-headers` flag | Small | Medium |
| Issue history tracking | Medium | Medium |
| `--history` search filter | Small | Medium |

**Definition of Done:**
- Can replicate jira-cli shell script examples
- Output is pipe-friendly
- History persists across sessions

### Milestone 3: Issue Cloning

**Goal:** Full issue cloning with text replacement.

| Task | Effort | Impact |
|------|--------|--------|
| Basic `issue clone KEY` | Medium | High |
| `--replace "find:replace"` option | Medium | Medium |
| Clone with field overrides (`--summary`, `--assignee`) | Small | Medium |
| Clone subtasks option | Medium | Low |

**Definition of Done:**
- Can clone issues across projects
- Text replacement works in summary and description
- Subtasks optionally cloned

### Milestone 4: Interactive TUI (Major)

**Goal:** Match or exceed jira-cli's interactive experience.

See `spec/tui-research.md` and `spec/jira-tui-design.md` for detailed plans.

| Phase | Scope |
|-------|-------|
| 4.1 | Framework setup, basic screen navigation |
| 4.2 | Issue list with filtering, issue detail view |
| 4.3 | Sprint/board views, Confluence page browser |
| 4.4 | Charts (burndown, velocity), command palette |
| 4.5 | Themes, customization, polish |

**Definition of Done:**
- Full keyboard navigation (vim-style)
- Explorer views for issues, sprints, epics
- Confluence page tree browser
- No flickering (synchronized output)
- Works in tmux/SSH

---

## Features NOT Worth Adopting

| Feature | Reason |
|---------|--------|
| Server/DC support | Strategic decision to focus on Cloud |
| Go rewrite | TypeScript/Bun is our differentiator |
| Exact CLI syntax | Our command structure is already established |

---

## Strategic Advantages to Maintain

These are atlcli's unique selling points that no competitor matches:

1. **Confluence + Jira in one tool** - No context switching
2. **Bidirectional markdown sync** - Docs-as-code workflow
3. **Sprint analytics** - Velocity, burndown, predictability metrics
4. **Bulk operations via JQL** - Powerful automation
5. **Webhook server** - Real-time integrations
6. **Template system** - Both Jira issues and Confluence pages

---

## Conclusion

atlcli is feature-superior but UX-inferior to jira-cli. The path forward:

1. **Quick wins** (Milestone 1-3): Close obvious gaps with low effort
2. **TUI** (Milestone 4): The major investment needed to match UX
3. **Maintain advantages**: Keep building on Confluence, analytics, automation

The goal is not to clone jira-cli, but to offer a compelling alternative that excels at:
- Unified Jira + Confluence workflows
- Automation and scripting
- Analytics and insights
- Documentation-as-code
