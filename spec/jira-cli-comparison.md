# atlcli vs jira-cli: Competitive Analysis

This compares the Jira part of atlcli with [ankitpokhrel/jira-cli](https://github.com/ankitpokhrel/jira-cli) ("JiraCLI": Go, MIT, about 6k stars). JetBrains sponsors jira-cli; JetBrains has no Jira CLI of its own.

**Date:** 2026-10-23. This updates the analysis of 2026-01-28.

**Status:** milestones A, B and C and the fixes in section 6 are implemented (branch `docs/jira-cli-comparison`). Open: D (TUI) and the Server/DC search risk. Deviations from the plan are listed in [Outcome](#8-outcome).

**Sources:**
- For jira-cli: the `main` source (last push 2026-10-17, every flag taken from `internal/cmd/**`), the README, the release notes of `v1.7.0`, `skills/jira-cli/SKILL.md`, and the wiki.
- For atlcli: `apps/cli/src/commands/jira*.ts`, `digest*.ts`, `audit-jira.ts`, `packages/jira/src`, and `src/content/docs/jira`.

---

## Summary

**Where things stand.**
- The latest jira-cli release is still `v1.7.0` of 2025-08-31. Everything since then (Cloudflare Access auth, an agent skill file, small fixes) exists only unreleased on `main`.
- atlcli has caught up on most of the gaps from January (`issue open`, `epic add/remove`, `sprint add`, `jira me`, stdin input). It is now well ahead in breadth: attachments, full comment and worklog management, sprint lifecycle, bulk operations, filters, components and versions, analytics, digest, audit, and reports on Confluence.

**What jira-cli still does better.** It is better at the everyday, interactive part:
1. the TUI explorer;
2. shell-friendly list output (`--plain --columns --no-headers`, `--csv`);
3. shortcuts that save typing (assignee by name, `x`, `default`, relative dates, `~` negation, `--history`, `--watching`);
4. `issue clone`;
5. an editor prompt.

**Recommendation.** Adopt the cheap scripting and input ergonomics (milestones A and B below). The TUI remains the one large gap; decide on it separately (see `spec/jira-tui-design.md`).

---

## 1. jira-cli: complete inventory

### Meta

| Topic | jira-cli |
|---|---|
| Release | `v1.7.0` (2025-08-31); `main` unreleased since then |
| Install | Homebrew tap, Docker (ghcr), Scoop, Nix, FreeBSD/NetBSD, `go install`, release binaries |
| Platforms | Linux, macOS and BSD fully; Windows partly (TUI bugs) |
| Jira | Cloud (REST v3 for search and read; v2 for many writes), Server/DC ("local", REST v2), Agile 1.0 |
| Auth | `basic` (email + token or user + password), `bearer` (PAT), `mtls` (client certificates), `cf-access` (Cloudflare Access, new 2026-08). No SSO (#477, the most-voted issue) |
| Token sources | `JIRA_API_TOKEN`, then `.netrc`, then the OS keychain |
| Config | `jira init` writes YAML to `~/.config/.jira/.config.yml` and pulls metadata (issue types, epic fields, custom fields). No named profiles: you switch with `--config` / `JIRA_CONFIG_FILE`. Every key can be overridden as `JIRA_<KEY>` |
| Global flags | `-c/--config`, `-p/--project`, `--debug` |
| Agents | `skills/jira-cli/SKILL.md` (2026-10) recommends `--raw`, `--plain --columns --no-headers` and `--csv`. No MCP |

### Commands

**`issue list`** (aliases `ls`, `search`). A positional text argument becomes `text ~ "..."`.
- **Filters:**
  - `-t` type, `-s` status (repeatable), `-y` priority, `-R` resolution
  - `-a` assignee and `-r` reporter (email or name; `x` = unassigned)
  - `-l` label (repeatable), `-C` component, `-P` parent
  - `--history` (recently viewed), `-w/--watching`
  - `--created` / `--updated` (`today|week|month|year`, a date, or `-10d|-2w|-1h|-30m`), and `--created-after/-before`, `--updated-after/-before`
  - `-q/--jql`
  - A `~` prefix negates a value (`-s~Done -a~x`).
- **Order and paging:** `--order-by` (default `created`, `rank` too), `--reverse`, `--paginate from:limit` (`from` is ignored on Cloud).
- **Output:**
  - The TUI table by default.
  - `--plain`, with `--no-headers`, `--no-truncate` and `--delimiter`.
  - `--columns` (fixed fields only; no custom fields, #616).
  - `--fixed-columns`, `--raw` (JSON), `--csv`, `--comments N`.

**`issue create`**
- Flags:
  - `-t`, `-P` parent or epic, `-s`, `-b`, `-y`
  - `-r`, `-a`, `-l`, `-C`
  - `--fix-version`, `--affects-version`, `-e` original estimate
  - `--custom key=value` (kebab-case field names from `init` metadata)
  - `-T/--template file|-`, stdin, `--web`, `--no-input`, `--raw`
- With no flags it runs as an interactive prompt, with an editor via `JIRA_EDITOR`/`VISUAL`/`EDITOR`.

**`issue edit`**
- Same fields as create. A `-` prefix removes a value (`--label -p2`).
- `--skip-notify`, stdin, `--web`.

**Other issue subcommands**

| Command | Flags and behaviour |
|---|---|
| `issue assign KEY USER` | name, email, `x` (unassign) or `default`; prompts if ambiguous |
| `issue move KEY STATE` | `--comment`, `-a`, `-R` resolution, `--web` |
| `issue view KEY` | `--comments N`, `--plain`, `--raw`; pager (`JIRA_PAGER`); linked issues |
| `issue link IN OUT TYPE` / `issue unlink IN OUT` | — |
| `issue link remote KEY URL TITLE` | web link |
| `issue clone KEY` | overrides (`-P -s -y -a -l -C`), `-H "find:replace"` in summary and body |
| `issue delete KEY` | `--cascade` (also deletes subtasks) |
| `issue comment add KEY [BODY]` | `-T` template, `--internal` (JSM), stdin. Add only |
| `issue worklog add KEY "2d 3h"` | `--started`, `--timezone`, `--comment`, `--new-estimate`. Add only |
| `issue watch KEY USER` | add only, no unwatch |

**Epics**

| Command | Flags and behaviour |
|---|---|
| `epic list [KEY]` | explorer or issues of the epic; all list filters; `--table` |
| `epic create` | create flags plus `-n` name |
| `epic add EPIC ISSUE...` | up to 50 issues; `--skip-notify` |
| `epic remove ISSUE...` | up to 50 issues; `--skip-notify` |

**Sprints**

| Command | Flags and behaviour |
|---|---|
| `sprint list [ID]` | explorer; `--state`, `--current/--prev/--next`, `--show-all-issues`, `--table`, `--columns`. Shows only the last 25 sprints; no `--board` (#847) |
| `sprint add ID ISSUE...` | up to 50 issues |
| `sprint close ID` | not documented |

There is no sprint create or start.

**Other commands**

| Command | Flags and behaviour |
|---|---|
| `board list` | — |
| `project list` | — |
| `release list` | read only |
| `open [KEY]` | opens the project or issue in the browser (`JIRA_BROWSER`) |
| `me` | for `-a$(jira me)` |
| `serverinfo` | — |
| `completion` | bash, zsh, fish, powershell |
| `man` | generates man pages |
| `version` | — |

### TUI (tview)

- **Views:**
  - an issue table;
  - an epic or sprint explorer (sidebar plus issue list).
- **Keys:**
  - navigation: arrows or `hjkl`, `g`/`G`, `Ctrl+f`/`Ctrl+b`;
  - `v` view in the pager;
  - `m` transition (modal);
  - `Enter` open in the browser;
  - `c` copy the URL;
  - `Ctrl+k` copy the key;
  - `Ctrl+r`/`F5` refresh;
  - `w`/`Tab` switch panes;
  - `?` help, `q` quit.
- No editing, commenting or assigning in the TUI (#280, #781).

### Markdown, custom fields, limits

- **Markdown and wiki markup:** input in Markdown or Jira wiki markup is converted to wiki markup and sent through v2. ADF is shown as approximate Markdown; not every node is translated.
- **Custom fields:** option, array, number, project and string, through `--custom`.
- **Structural limits:**
  - no attachments;
  - comments, worklogs and watchers are add only;
  - no sprint create or start;
  - releases read only;
  - no filter management;
  - no bulk operations;
  - no analytics or reports;
  - non-English on-prem instances need manual config;
  - Cloud pagination is broken without a total (#898).
- **Open PRs (upcoming):**
  - #1023 `--body-format` (skip the Markdown conversion);
  - #1035 comment mentions;
  - #1019 parent in the view;
  - #1016 a `--no-input` hang;
  - #995 comment visibility;
  - #1007 an optional default project.

---

## 2. Comparison by area

✅ = present, ◐ = partial, — = missing.

| Area | jira-cli | atlcli |
|---|---|---|
| Issue CRUD, transition | ✅ | ✅ (plus `transitions`, `history` = changelog) |
| Assign by name, `x`, `default` | ✅ | ◐ accountId or `none` only |
| Clone with find/replace | ✅ | — |
| Delete with subtasks | ✅ `--cascade` | ✅ `--delete-subtasks` |
| Comments | ◐ add only (+ JSM `--internal`) | ✅ list, add, edit, delete |
| Worklog | ◐ add only | ✅ CRUD, report, timer, rounding |
| Watchers | ◐ add | ✅ watch, unwatch, list |
| Attachments | — | ✅ attach, list, download, delete |
| Issue and remote links | ✅ | ◐ issue links ✅; web links only as Confluence page links |
| Subtasks | via `-P` | ✅ `subtask create/list` |
| Epics | ✅ list, create, add, remove, explorer | ✅ list, get, create, issues, add, remove, progress |
| Sprints | ◐ list, add, close | ✅ list, get, create, start, close, delete, issues, add, remove, report, review |
| Boards | ◐ list | ✅ list (`--all-projects`), get, backlog, issues |
| Projects | list | ✅ list, get, create, types |
| Versions | ◐ list | ✅ CRUD, release, release notes as a page |
| Components | — | ✅ CRUD |
| Filters | — | ✅ CRUD, share |
| Fields | config metadata | ✅ list, get, options, search |
| Bulk | ◐ only epic/sprint add (50) | ✅ edit, transition, label, delete, move, link-page, `--dry-run` |
| Import / export | — | ✅ CSV/JSON with comments and attachments |
| Issue templates | ◐ description file | ✅ hierarchical issue templates |
| Webhooks | — | ✅ serve, register, refresh |
| Analytics | — | ✅ velocity, burndown, scope change, predictability (as of the sprint), flow, aging, CFD |
| Reports | — | ✅ sprint review and release notes as Confluence pages, PDF/DOCX |
| Digest / audit | — | ✅ `digest` (with an LLM summary), `audit jira` (rules, baseline, `--fail-on`) |
| Search filters | ✅ many short flags, relative dates, negation | ◐ `--project --assignee --status --type --label --sprint`, otherwise JQL |
| `--history`, `--watching` | ✅ | — |
| List output | ✅ TUI, plain, columns, CSV, raw | ◐ JSON (text output mostly pretty JSON); CSV only for export and flow |
| TUI | ✅ | — |
| Editor prompt | ✅ | — (manual loop via `--description-file`) |
| Stdin | ✅ | ✅ `--description-file -`, `--body-file -` |
| Markdown | ◐ MD → wiki markup (v2), ADF → MD lossy | ✅ MD ↔ ADF in both directions (mentions, panels, tables, task lists, ADF preservation) |
| `open` | ✅ project or issue | ◐ issue only |
| `me`, `serverinfo`, `man` | ✅ | `me` ✅, `doctor` instead of serverinfo, no man |
| Completion | bash, zsh, fish, powershell | bash, zsh (dynamic) |
| Auth | basic, PAT, mTLS, Cloudflare Access, netrc, keychain | API token, PAT, custom CA, keychain, named profiles |
| Server/DC | ✅ | ◐ (see the risk below) |
| Agent integration | skill file | `research`/`chat` (LLM, read only), digest `--summarize`, JSON with `schemaVersion` |
| Confluence | — | ✅ the whole second product |

---

## 3. Recommendations: what to adopt

Ordered by value per effort.

### Milestone A: input ergonomics (small)

1. **Assignee resolution.** `--assignee` on `issue create/update/assign`, `subtask create` and `bulk edit` should accept `me`, `x`/`none`, `default`, an email or a name. Resolve it through `/user/search` (and `/user/assignable/search` for a project); ask or fail on ambiguity. This also fixes the docs, which already promise `--assignee <email>` while the code passes the value through as an accountId.
2. **`jira search --watching` and `--history`.** `--watching` is JQL `watcher = currentUser()`; `--history` is `issuekey in issueHistory()` (Jira-native, no local file needed).
3. **Relative dates on `search`.** `--created`/`--updated` accept `-7d`, `week` or a date and map directly to JQL. Add a `~` negation only if it is asked for.
4. **`open` for a project and other keys.** Make `jira open [KEY|PROJECT]` a shortcut; today only `issue open <key>` exists.
5. **`--type Bug,Task` as a real list.** The code currently builds `issuetype = "Bug,Task"` (a bug; the docs promise multiple types). It should become `issuetype in (...)`, and the same for `--status`.

### Milestone B: shell-friendly output (medium)

6. **A table view for lists.** Today, list commands without `--json` print pretty JSON anyway. Add a table renderer in `output()` for arrays, with `--columns key,summary,status`, `--no-headers` and `--delimiter`, plus `--csv`. A central change in one place, instead of one per command. This is the biggest scripting gap; jira-cli's own agent skill promotes exactly this.
7. **`--columns` with custom fields.** Do it right away; jira-cli cannot (#616).

### Milestone C: functions (medium)

8. **`jira issue clone KEY`.** Copy summary, description, type, priority, labels, components and parent, with field overrides and `--replace find:replace`. It can reuse the issue-template code (`templates.ts` already reads issues as templates).
9. **Remote web links.** `issue link --url <url> --title` (jira-cli `link remote`), alongside the Confluence page links that already exist.
10. **Editor fallback.** `issue create/update` and `comments add` without a description open `$EDITOR` when a TTY is present. A small step; `template.ts` already does this for wiki templates.
11. **`comments add --internal`** for JSM projects (property `sd.public.comment`). Small, if JSM matters.

### Milestone D: TUI (large, decide separately)

12. An explorer for issues, sprints and epics, as in `spec/jira-tui-design.md`. It is the only remaining large gap, but it is neither scripting nor agent work, which is where atlcli is heading. **Recommendation:** postpone; do A–C first.

### Not worth adopting

| Feature | Reason |
|---|---|
| mTLS, Cloudflare Access | niche; ask for it when someone needs it |
| `--paginate from:limit` | Cloud has no `startAt`; our `nextPageToken` with `--limit/--all-results` is correct |
| Man pages, fish/powershell completion | low value; fish only if someone asks |
| Wiki-markup input | atlcli converts MD ↔ ADF properly; wiki markup would be a step backwards |
| Config without profiles | our named profiles are better |

---

## 4. Where atlcli is already better

1. **Breadth of write operations:**
   - attachments;
   - comments and worklogs with edit, delete and list;
   - unwatch;
   - the whole sprint lifecycle (create, start, close, delete, remove);
   - components, versions and filters with CRUD.

   jira-cli has none of this.
2. **Bulk with `--dry-run`:** any JQL as input, parallel batches, `bulk move` into a sprint or the backlog. jira-cli can only add to an epic or sprint, 50 issues at a time.
3. **Analytics that agree with Jira:**
   - sprint metrics as of the sprint (changelog replay; matches Jira's sprint report exactly, PR #281);
   - flow (cycle time, lead time, throughput), aging and CFD with `flow.statusMap`.

   jira-cli has no metrics at all.
4. **Reports as Confluence pages:** sprint review and release notes from templates, with PDF/DOCX export. Jira and Confluence in one tool is our strongest point.
5. **Digest and audit:** a daily overview across Jira and Confluence with an optional LLM summary; workflow and hygiene rules with baseline and `--fail-on` for CI.
6. **Faithful Markdown:** MD ↔ ADF in both directions, with mentions, panels, tables, task lists and preservation of unknown ADF nodes. jira-cli goes through wiki markup and loses ADF nodes when displaying.
7. **Automation:**
   - webhook server and registration;
   - import and export (CSV/JSON with attachments);
   - issue templates in three levels;
   - plugins with hooks;
   - stable JSON contracts (`schemaVersion`, error codes).
8. **Worklog timer and time report:** `worklog timer`, `worklog report`, and rounding.
9. **Profiles:** named profiles with their own defaults (project, board, space, status map) instead of switching config files.
10. **Release pace:** atlcli releases monthly (CalVer); jira-cli has not released for 14 months.

## 5. Where jira-cli is better (still open)

| Gap | Priority |
|---|---|
| TUI explorer | large, see D |
| Plain / table / CSV output for lists | high, see B |
| Assignee by name, `x`, `default` | high, see A |
| Search short flags (dates, negation, `--watching`, `--history`) | medium, see A |
| `issue clone` | medium, see C |
| Editor prompt, interactive create | small, see C |
| Distribution (Homebrew core, Scoop, Nix, Docker, Windows) | separately; we have a Homebrew tap |
| Server/DC maturity | check (see the risk) |

---

## 6. Found along the way: docs and code disagree

These are not features, but bugs to fix. Each is a small PR.

| Docs say | Code does |
|---|---|
| `jira filter run --id` (`reference/cli-commands.md:798`) | does not exist |
| `filter share --user <email>` (`cli-commands.md:799`, `jira/filters.md:72`) | only `--type global\|project\|group` |
| `field list --system` (`cli-commands.md:846`, `jira/fields.md:26`) | only `--custom` and `--type` |
| `search --type Bug,Task` | builds `issuetype = "Bug,Task"` (`jira.ts:4534`) and finds nothing |
| `--assignee <email>` / `--lead <email>` | passed through as an accountId |
| `jira help` names analyze and bulk incompletely | flow/aging/cfd and move/link-page are missing from the overview |

**Risk:** on Server/DC, `search` calls `/rest/api/2/search/jql`. Data Center most likely does not offer that endpoint (it has `/rest/api/2/search`). This is unverified, because there is no DC instance to test against. If DC matters, fall back to `/search` there.

---

## 7. Status of the January milestones

| January 2026 | Today |
|---|---|
| `open` command | ◐ `issue open <key>`; project missing (A4) |
| Assign shortcuts | — (A1) |
| `--watching` | — (A2) |
| `--plain/--columns/--no-headers` | — (B6) |
| `--history` | — (A2, via `issueHistory()` instead of a local file) |
| Issue clone | — (C8) |
| TUI | — (D12) |

Done since January but not in that list: `jira me`, `epic add/remove`, `sprint add/remove`, `board list --all-projects`, stdin for descriptions and comments, attachments, flow/aging/CFD, digest, audit, sprint review, release notes, and sprint metrics as of the sprint.

---

## 8. Outcome

Implemented as planned, with these deviations:

- **Assignee `default`** only on `issue assign`, as in jira-cli. On create, leaving `--assignee` out already gives the default assignee.
- **`--edit`** is an explicit flag on `issue create`, `issue update` and `comments add`, not an automatic fallback: a missing description must not open an editor in a script. `update --edit` starts from the current description.
- **Clone** copies summary, description, type, labels and, in the same project, components and parent. Priority is not copied: the live test failed with "the selected priority is invalid" when the source priority was outside the project's scheme. No "Cloners" link is created.
- **Web links:** `issue link --key --url [--title]` and `issue unlink --key --remote <id>`. There is no list command; `link` prints the id.
- **Table output** is now the default text output of the issue lists (`search`, `my`, `filter run`, board, sprint and epic issues). Before, they printed JSON even without `--json`; scripts that parsed that need `--json`.
- **Filter flags with `--jql`:** they are ANDed onto the JQL instead of being ignored. `defaults.project` only applies without `--jql`.
- **`filter share`:** `--user`, `--group` or `--project` alone imply the type; the docs' `--owner` and `--role` did not exist and were removed from the docs.
- **Argument parser:** a value that starts with a dash and a digit (`--updated -7d`, `--max-depth -1`) is now a value, not a flag.
- **Not done:** `~` negation, `--created-before`/`--updated-before`, `issue clone --link`, the Server/DC search fallback.
