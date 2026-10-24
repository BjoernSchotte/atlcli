# Plan: TUI command log, auto-refresh, saved views, kanban board

**Status:** implemented on `feat/tui-board-log-refresh`. **Date:** 2026-10-24. **Builds on:** [the TUI MVP](tui-mvp-plan.md) (released in v2026.10.6).

The [research](tui-research.md) and the [Jira TUI design](jira-tui-design.md) named Lazygit, K9s, jira-cli, jira-tui (Jorres) and kanban-tui as models. A comparison after the MVP left four gaps worth closing, in one PR:

| Model | Gap | Here |
|---|---|---|
| Lazygit: "transparency, log all underlying commands" | No record of what the TUI did | Command log with the CLI equivalent of every write |
| K9s | Lists only update on `r` | Auto-refresh when idle |
| jira-tui (Jorres): tabs with their own filters | Only Jira's favourite filters | Save the current list as a favourite filter |
| kanban-tui, Jira's own board | No board view (an MVP non-goal) | Kanban view of the current list |

## 1. Command log

Every write the TUI makes is logged with the `atlcli` command that does the same, so the TUI teaches the CLI for scripts and CI.

- **Key:** `!` opens the log (newest first). `j`/`k` move, `y` copies the command of the selected entry, `Esc` closes. Also in the palette.
- **Entry:** time, ✓ or ✗ (with Jira's error), what changed ("ATLCLI-12 → In Arbeit"), and the command.
- **Bulk:** one command for all issues, `--jql "key in (A-1, A-2)"` (`jira bulk transition|label|move`).
- **Where:** `confirmWrite` (Jira), `confirm` (wiki) and the agile writes take the command next to the change; the shared confirm path appends the entry when the write ends. No proxy around the clients: the log needs the user-level command, not the REST calls.
- **Scope:** writes only, session only (no file). Reads are not logged.
- **Quoting:** arguments that need it are single-quoted, so the line pastes into `sh`/`zsh`.

Mapping (the CLI has a command for every TUI write):

| TUI | CLI |
|---|---|
| `t` | `jira issue transition --key K --to S`, bulk: `jira bulk transition --jql … --to S` |
| `a` | `jira issue assign --key K --assignee U` |
| `c` | `jira issue comment --key K '…'` |
| `e` | `jira issue update --key K --summary '…' --edit` |
| `L` | `jira issue update --key K --add-labels a --remove-labels b`, bulk: `jira bulk label add a --jql …` |
| `s` | `jira sprint add K… --sprint N` / `jira sprint remove K…` |
| `p` | `jira epic add K… --epic E` / `jira epic remove K…` |
| `n` / `N` | `jira issue create --project P --type T --summary '…'` / `jira issue clone K` |
| `R` | `jira issue rank K… --before|--after K` |
| board/sprint `n` `S` `d` | `jira board create|delete`, `jira sprint create|start|close|delete` |
| `F` (below) | `jira filter create --name '…' --jql '…' --favourite` |
| wiki `e` `n` `L` `m` | `wiki page update --id N --body page.md`, `wiki page create …`, `wiki page label add|remove … --id N`, `wiki page move --id N --parent P` |

## 2. Auto-refresh

- The list and the open detail reload after `tui.refresh` seconds without a key press, and every `tui.refresh` seconds while it stays idle. Default 60; `0` turns it off.
- Never while an overlay is open or a task runs (no list jumping under a picker, no race with a write).
- Quiet: the selection and the marks stay (`withItems` keeps them), the detail keeps showing until the new one arrives, no busy indicator.
- The waiting after a key press also covers Jira's search lag after `R` (the list is reordered locally).

## 3. Saved views

Both kinds, by the owner's decision:

- **Local views** (`tui.views` in the config, per profile; Jira and wiki): `F` → name → saved through `TuiOptions.saveViews`, which the CLI writes (re-reading the config first). They show under "Saved views" in both navigators.
- **Jira favourite filters:** `F` in Jira offers both; the filter needs a confirm (`createFilter({ name, jql, favourite: true })`) and is logged.
- `d` in the navigator deletes a view, or (`y` twice) a filter. Jira refuses for filters of others; the toast says so.
- Wiki lists of a page's children cannot be saved (no CQL); the toast says to search instead.

## 4. Kanban view

`b` in the Jira list (or the palette) toggles the list between rows and a board of columns. It works on any list:

- **Columns:** from the board's configuration (`GET /board/{id}/configuration` → `columnConfig.columns[].statuses[].id`) when the list came from a board or one of its sprints; otherwise one column per status in the list, ordered by status category (to do, in progress, done). Issues with an unmapped status go to the last column.
- **Board context:** `loadIssues(ctx, title, jql, boardId?)` stores `jira.boardId`; `open` passes it for boards and sprints, sort and reload keep it, a filter (`/`) clears it.
- **Selection:** stays `list.selected` (an index into the items). Every action (`t`, `a`, `c`, `e`, `s`, marks, …) works unchanged on the selected card; the detail loads as in the list.
- **Keys in the board:** `h`/`l` previous/next column (empty columns are skipped), `j`/`k` within a column, `Shift+←`/`Shift+→` (and `m`, a column picker) move the card = a transition into a status of that column (one match: at once, by the owner's decision, and logged; several: picker; none: toast). `L` stays labels. `Enter` shows the detail fullscreen, `Esc` back.
- **Layout:** the board takes the list and detail area. Each column is at least 24 columns wide; when they do not fit, a window of columns around the selected one shows, with `‹ n more` / `n more ›` in the title.
- **Cards:** key, assignee; the summary in up to two lines; marks as in the list.
- **Mouse:** click selects, double click shows the detail. No drag and drop (H/L does it; drag needs hit-testing across columns).
- **After a move:** the issue reloads (as after `t`), and the card moves to its new column.

New client method: `JiraClient.getBoardColumns(boardId)` (the same configuration call `getBoardFilterId` makes), with an API report update.

## Not in this PR

Undo, burndown and velocity charts, worklog timer, attachments, Confluence comments, drag and drop.

## Tests

- Unit: CLI command builders and quoting; log entries on success and failure; idle timer (fake time) and the skip rules; `kanbanColumns` (board config, fallback, unmapped), column navigation, move target; filter save/delete.
- Render: the board at 80 and 160 columns, the log overlay.
- Live (`mayflower`, ATLCLI and DOCSY): every logged command pasted into the shell does what the TUI did; auto-refresh picks up a change made in the web UI; save and delete a filter; move cards across the "atlcli Roadmap" board; clean up.

## Docs

`src/content/docs/tui.md` (keys, configuration `tui.refresh`, board view, log), the skill if it lists TUI keys, `spec/tui-mvp-plan.md` (kanban no longer a non-goal), README terminal UI section, maybe a screenshot of the board.

## Decisions

1. Auto-refresh on by default, 60 s (minimum 10).
2. Saved views: both, local views and Jira favourite filters.
3. Moving a card runs at once, without a confirm; the command log records it.

## Found on the way

- Label pickers could not remove the last label: with every mark removed, Enter took the item under the cursor again. Fixed (`toggled` on the picker), with a regression test.
- Wiki refresh reloaded the navigator's selected node, not the node the list came from; auto-refresh would have swapped the list. It now uses the list's own node.
