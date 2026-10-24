---
title: "Terminal UI"
description: "atlcli tui: a fullscreen terminal UI for browsing, triaging and editing Jira issues and Confluence pages, with keyboard and mouse"
---

# Terminal UI

`atlcli tui` opens a fullscreen terminal UI for working in Jira and Confluence:
- browse your issues, boards, sprints and pages;
- read them, rendered as markdown;
- change them in place: status, assignee, comments, labels, sprint and parent, and page edits with a diff before saving;
- see a sprint or any list as a board of columns, and move cards across it;
- save lists as views or Jira filters;
- look up every change you made as the `atlcli` command that does the same, for your scripts.

Lists reload on their own while you leave the keyboard alone.

Everything else in atlcli stays as it is. Flags, `--json` and exit codes do not change, and scripts and CI keep using the commands. The TUI is a separate entry point that only starts in an interactive terminal.

## Prerequisites

- An authenticated profile (`atlcli auth login`) with Jira and Confluence access.
- An interactive terminal: macOS Terminal, iTerm2, Ghostty, kitty, WezTerm, Windows Terminal or tmux. In CI or a pipe, `atlcli tui` fails with `atlcli tui needs an interactive terminal.` instead of waiting for input.
- For editing descriptions and pages: `$VISUAL` or `$EDITOR`. If neither is set, `vi` is used (`notepad` on Windows).

## Steps

1. Start it:

   ```bash
   atlcli tui
   ```

   Jira opens with **My open issues**. `2` switches to the Wiki, `1` back to Jira.

2. Find your way: `?` lists the keys of the focused pane. `:` (or `Ctrl+K`) opens the **command palette**, where every command can be found by name.

3. Move between the three panes with `Tab`. Alternatively, `h`/`l` (or the arrow keys) move left and right, `Enter` opens and `Esc` goes back:
   - the **navigator** on the left (queries, boards, filters, spaces and the page tree);
   - the **list**;
   - the **detail** on the right.

4. Change something: select an issue and press `t`. Pick the new status and confirm with `y`. Every change asks first.

5. Quit with `q` (or `Ctrl+C`). The terminal is restored as it was.

## Layout

```
 atlcli  1 Jira  2 Wiki   assignee = currentUser() AND statusCategory != Done …   mayflower
┌─ Navigator ───────────┐┌─ My open issues (100+) ─────────────┐┌─ ABC-12 ──────────────────┐
│  My open issues       ││  ABC-12   In Progress  Ann   Login…│││  details  comments 2  …   │
│  Watching             ││  ABC-9    To Do        –     Docs… ││ Fix the login             │
│▾ Boards (ABC)         ││                                    ││ Bug · In Progress · High  │
│    ● Sprint 42        ││                                    ││ Description …             │
└───────────────────────┘└────────────────────────────────────┘└───────────────────────────┘
 / filter · t status · a assign · c comment · e edit · L labels · s sprint · n new · q quit
```

- **Header:** the areas (click to switch), the JQL or CQL behind the list, the profile and what is loading.
- **Status bar:** the keys of the focused pane on the left; the result of the last action, or an error, on the right.
- **Narrow terminals** (under 100 columns): the list and the detail stack, and the navigator shows only while it has the focus.

## Keys

The help (`?`) always shows the keys of the focused pane. These are the defaults.

### Everywhere

| Key | Command |
|---|---|
| `?` | Keys of the focused pane |
| `:` or `Ctrl+K` | Command palette |
| `1` / `2` | Jira / Wiki |
| `Tab` / `Shift+Tab` | Next / previous pane |
| `[` | Show or hide the navigator |
| `z` | Detail fullscreen on/off |
| `<` / `>` | Narrower / wider pane (the navigator when focused, else the list) |
| `r` or `F5` | Reload |
| `O` | Open in the browser |
| `y` / `Y` | Copy the key (or page id) / the URL |
| `!` | [Command log](#command-log): what this session changed, as `atlcli` commands |
| `F` | [Save the list](#saved-views) as a view (in Jira, also as a favourite filter) |
| `q` or `Ctrl+C` | Quit |

### Navigator, list and detail

| Pane | Keys |
|---|---|
| Navigator | `j`/`k` move, `g`/`G` top and bottom, `Enter` or `l` open or expand, `h` collapse or go to the parent |
| List | `j`/`k`, `g`/`G`, `PgDn`/`PgUp`, `Enter` or `l` show the detail, `h` to the navigator, `Space` mark (and move down), `V` mark all, `U` clear the marks |
| Detail | `j`/`k` scroll, `Space`/`PgDn` page, `g` top, `.` and `,` next and previous tab, `Esc` back to the list |

### Jira

| Key | Action | Notes |
|---|---|---|
| `/` | Filter | Takes `jira search` flags (`--assignee me --status ~Done --updated -7d`) or raw JQL |
| `o` | Sort | Updated, created, priority, status, due date, key, rank |
| `+` | Load more | When the list says `100+` |
| `b` | [Board view](#board-view) on/off | The list as columns |
| `Enter` on the **links** tab | List linked issues, parent and subtasks | |
| `t` | Transition | Picker of the valid transitions |
| `a` | Assign | `me`, `unassigned`, or search users by name or email |
| `c` | Comment | Inline editor with a markdown preview (`Ctrl+P`); `Ctrl+S` sends |
| `e` | Edit summary and description | Summary in a prompt, description in `$EDITOR`; a diff before saving |
| `L` | Labels | `Tab` toggles, typing adds a new one |
| `s` | Move to a sprint or the backlog | Uses the navigator's board, `--board`, or the project's first scrum board |
| `p` | Set or remove the parent (epic) | Searches the project's epics |
| `n` / `N` | New issue / clone | A clone is linked as "clones" to its source, like a clone made in Jira |
| `R` | Reorder (rank) | Up, down, to the top or to the bottom; the list must be sorted by rank (`o` → Rank). Marked issues move as one block |

`t`, `a`, `L` (add only), `s`, `p` and `R` work on all **marked** issues, or on the selected one when none is marked.

Boards and sprints, with the navigator focused:

| Key | On | Action |
|---|---|---|
| `n` | **Boards** (or a kanban board) | New board: name, then scrum or kanban. It lands in the project of `--project` (or asks for one), on a new filter `project = KEY ORDER BY Rank ASC` that is shared with the project |
| `n` | A scrum board, one of its sprints or its backlog | New sprint on that board, not started |
| `S` | A future sprint | Start it: today until the end date you give (default: two weeks) |
| `S` | The active sprint | Complete it. Its open issues stay in the closed sprint and show in the backlog; move them with `s` |
| `d` | A sprint | Delete it; its issues move to the backlog |
| `d` | A board | Delete it, or it and its filter. Its sprints go with it; issues are not touched |

Deleting needs `y` twice.

With the navigator focused, `d` on an entry under **Saved views** deletes that view, and on one under **Favourite filters** deletes the filter in Jira (`y` twice; Jira only lets you delete your own).

### Board view

`b` shows the Jira list as a board: one column per board column, the cards in rank order. `b` again shows the rows.

- **Columns:** a list that came from a board, one of its sprints or its backlog shows that board's columns. Any other list (a search, a filter, an epic) gets one column per status, ordered to do, in progress, done. Statuses the board does not map go into a last column, **Not on the board**.
- **Moving:** `h`/`l` go to the previous and next column (empty ones are skipped), `j`/`k` move within a column.
- **Cards:** key, assignee and the summary in up to two lines. The board takes the room of the list and the detail; `Enter` shows the selected card's issue fullscreen, `Esc` returns to the board.
- **Every issue key works on the selected card:** `t`, `a`, `c`, `e`, `L`, `s`, `p`, marks with `Space`.

| Key | Action |
|---|---|
| `Shift+→` / `Shift+←` | Move the card one column right or left |
| `m` | Move the card to a column you pick |

Moving a card is a transition into a status of the target column. It runs **at once**, without asking, and shows in the [command log](#command-log). When several transitions lead into the column, a picker asks which one; when none does, the status bar says so and nothing changes.

### Saved views

`F` saves the list under a name:
- **A saved view** stays on this computer, in `tui.views` of the config, for the profile you use. It works in both areas: JQL in Jira, CQL in the wiki (a search, not a page's children).
- **A Jira favourite filter** (Jira only) is created in Jira after you confirm. Jira's web UI and your other devices see it too.

Saved views show in the navigator under **Saved views**, filters under **Favourite filters**. Saving a view under an existing name replaces it.

### Wiki

| Key | Action | Notes |
|---|---|---|
| `/` | Search | Plain words search the default space; CQL (`label = "howto"`) searches as written |
| `e` | Edit the page | In `$EDITOR`, then a diff; saved only if nobody changed the page meanwhile |
| `n` | New child page | Under the selected page (or at the top of the selected space) |
| `L` | Labels | |
| `m` | Move under another page | Searches the space's pages by title |
| `v` | Compare with an earlier version | A diff between that version and the current one |

The detail pane has two tabs (`.` and `,` switch): **page**, the page as markdown, and **info**: title, space, id, version, when and by whom it was last updated, labels, and whether it can be edited here.

## Mouse

- **Click** a row to select it, and a navigator entry to open it.
- **Shift+click** marks a row for a bulk change.
- **Double-click** a list row to show its detail.
- The **wheel** scrolls any pane.
- **Drag** the right border of the navigator or the list to resize it.
- **Click** a tab (details, comments, …) or an area in the header.
- **Board view:** click a card to select it, double-click it to show its issue.

## Safety

- **Every change asks first** and lists what it will change. A change to more than five issues, and deleting a board or a sprint, needs `y` twice.
- **Wiki edits** use the same markdown conversion as `atlcli wiki docs push`. They show a diff and save as version + 1. If someone saved the page meanwhile, the TUI does not overwrite it and offers three choices:
  - show what changed in Confluence;
  - edit again on the new version, with your text as a draft below it;
  - discard your edit.
- **Pages the converter cannot keep intact** cannot be edited here. A page with a macro whose content atlcli cannot preserve shows "Read only here", and you edit it in Confluence.
- **Text you typed is not thrown away silently:** `Esc` in the comment editor asks first.
- **One exception:** moving a card on the board does not ask. It is a single transition, and the command log records it.

## Command log

`!` lists every change this session made, newest first: when, whether it worked (✓ or ✗ with Jira's or Confluence's error), what changed, and the `atlcli` command that does the same:

```
16:37:56 ✓ ATLCLI-173 → In Arbeit
  $ atlcli jira issue transition --key ATLCLI-173 --to 'In Arbeit' --profile work
```

`j`/`k` select an entry, `y` copies its command, `Esc` closes. The commands are quoted for `sh` and `zsh`, so they paste into a shell or a script as they are. A change to several issues becomes one `jira bulk …` command with `--jql "key in (…)"`. Where the TUI took text from `$EDITOR`, the command names the file the CLI expects (`--edit`, or `--body <file>`).

The log covers changes only, not what you read, and it lasts for the session.

## Configuration

Optional, in `~/.atlcli/config.json` (or the file `ATLCLI_CONFIG` names):

```json
{
  "tui": {
    "area": "wiki",
    "theme": "light",
    "columns": ["key", "type", "status", "assignee"],
    "keymap": { "jira.transition": ["t", "T"], "app.quit": ["q"] },
    "refresh": 60
  }
}
```

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `tui.area` | `"jira"` \| `"wiki"` | `"jira"` | Area to start in |
| `tui.theme` | `"dark"` \| `"light"` | `"dark"` | Colors |
| `tui.columns` | list of `key`, `type`, `status`, `priority`, `assignee`, `updated` | `["key", "status", "assignee"]` | Issue list columns before the summary. A narrow list drops columns from the right |
| `tui.keymap` | object: command id → list of keys | none | Replaces a command's keys. Command ids are in the palette (`:`) and in the help |
| `tui.refresh` | whole seconds, `0` or at least `10` | `60` | Auto-refresh: after this long without a key press, the list and the open detail reload, and again every time it passes while you stay idle. They keep the selection and the marks, and the detail stays on screen until its new version is there. Never while a dialog is open or a change is saving. `0` turns it off; smaller values become `10` |
| `tui.views` | list of `{ "profile", "area", "name", "query" }` | none | Saved views. The TUI writes them (`F`); entries of other profiles are kept |

An invalid value fails at start with a message naming it (`tui.theme must be "dark" or "light", not "dakr".`) instead of falling back silently.

These settings also apply:
- **`flow.statusMap`:** statuses mapped to `done` (e.g. a "Fertig" in a To Do category) are left out of "My open issues", "Watching", boards and epics.
- **Defaults** from `atlcli config`: the project, board and space preselect the navigator.

### Options

| Flag | Meaning |
|---|---|
| `--area jira\|wiki` | Start area |
| `--jql <query>` | First Jira list (default: your open issues) |
| `--project <key>` | Project for the navigator's boards and epics |
| `--board <id>` | Board to preselect |
| `--space <key>` | Space to open and search |
| `--profile <name>` | Auth profile |

## Examples

Triage a sprint:

```bash
atlcli tui --project ABC --board 42
```

In the navigator, open **Boards → Sprint**. Mark issues with `Space`, then press `a` to assign them all, or `t` to move them on together.

Work on the docs of one space:

```bash
atlcli tui --area wiki --space DOCS
```

Search with `/`, edit with `e`, check the diff, save with `y`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `atlcli tui needs an interactive terminal.` | Started from a script, CI or a pipe | Run it in a terminal; scripts use the `jira` and `wiki` commands |
| "This terminal does not support copying (OSC 52)." | The terminal or tmux blocks OSC 52 | In tmux: `set -g set-clipboard on`; or use `O` to open the item instead |
| A key does nothing | The terminal or tmux swallowed it (e.g. `Esc` followed at once by a letter reads as Alt+letter) | Use the command palette (`:`), the mouse, or remap the key in `tui.keymap` |
| "No scrum board found for ABC." on `s` | The project has only kanban boards | Pass `--board`, or open a scrum board in the navigator first |
| "Read only here" on a page | The page has a macro atlcli cannot keep | Edit that page in Confluence |
| "changed in Confluence (vN → vM); not saved" | Someone saved the page while you edited | Choose "Edit again on the new version" to merge |
| Colors hard to read | Light terminal background | `"tui": { "theme": "light" }` |
| "ABC-1 has no transition into …" on the board | The workflow has no transition from the card's status into that column | Move it through the column in between, or pick another status with `t` |
| "Only a search can be saved" on `F` | The wiki list shows a page's children or a space's top pages | Search with `/` (e.g. `ancestor = 123`), then save |
| The list jumps back to Jira's order after a while | Auto-refresh reloaded it; Jira's search shows a new rank only after a few seconds | Wait a moment and reload (`r`), or raise `tui.refresh` |

## Related Topics

- [Configuration](configuration.md): `tui`, `flow.statusMap` and the defaults
- [Jira search](jira/search.md): the flags the filter bar takes
- [Issues](jira/issues.md): the same actions as commands, for scripts
- [Confluence sync](confluence/sync.md): the conversion the Wiki edit uses
