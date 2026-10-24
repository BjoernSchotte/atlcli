# Plan: `atlcli tui` MVP

**Status:** implemented on `feat/tui` (draft PR #327), M0–M5; see [Outcome](#outcome). **Date:** 2026-10-23.
**Builds on:** [the spike](tui-opentui-spike.md) (branch `spike/tui-opentui`). **Replaces:** `jira-tui-design.md` (too broad; kanban, dashboards and charts are out of scope here).

## Goal

A fullscreen tool for **working** in Jira and Confluence:
- browse, read and triage issues;
- change issues: status, assignee, comments, description, labels, sprint;
- browse, read and edit wiki pages.

It should feel like a first-class terminal app: alternate screen, no flicker, mouse, resizable panes, help on every screen.

**The CLI stays untouched.** Flags, `--json` and exit codes do not change. `atlcli tui` is a separate entry point. It refuses to start without a TTY, and it loads OpenTUI only when called (the spike measured no startup cost for the other commands).

## Non-goals (MVP)

- Kanban board, dashboards, charts, burndown.
- Attachments: upload, download, preview.
- Creating spaces, page restrictions, Confluence comments.
- Jira admin (fields, workflows, webhooks).
- Offline mode or a local cache beyond the session.
- Data Center-only features. The TUI uses the same clients as the CLI, so Data Center works as far as the CLI does.

## User-facing design

### Layout

```
┌ atlcli · Jira ▸ TCW · Sprint 42 ──────────────────────────── mayflower ┐
│┌ Navigator ──────┐┌ Issues (23) · status != Done ┐┌ TCW-289 ────────────┐│
││▾ Boards         ││▸TCW-289 In Arbeit  Ann  Ren…││ Rendering von …     ││
││  ▾ TCW Board    ││ TCW-288 Fertig     –    Bes…││ Bug · In Arbeit · … ││
││    ● Sprint 42  ││ …                           ││ [Details][Comments] ││
││      Backlog    ││                             ││ [Links][History]    ││
││▸ Epics          ││                             ││ Description …       ││
││▸ Filters        ││                             ││                     ││
│└─────────────────┘└─────────────────────────────┘└─────────────────────┘│
│ t status  a assign  c comment  e edit  l labels  s sprint  ? help       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Three panes:** navigator, list and detail. The navigator collapses (`[`); the detail pane can go fullscreen (`z`). Below about 100 columns, list and detail stack instead of sitting side by side.
- **Two areas:** Jira and Wiki. `1` and `2` switch, and so does a click on the header.
- **Overlays:** modals (pickers, forms, confirmations), toasts for results and errors, a help overlay (`?`) listing the keys of the current pane, and a command palette (`:` or `Ctrl+K`) that finds every action by name.
- **Mouse:**
  - click selects or focuses;
  - double-click opens;
  - the wheel scrolls;
  - dragging a pane border resizes;
  - a click on a tab or button triggers it.
- **Keys:** vim-like and arrow keys side by side. The help overlay and the status bar always show the keys for the focused pane.

### Jira

| Pane | Content |
|---|---|
| Navigator | Boards → sprints (active, future, backlog); epics of the project; saved filters (`filter list`); "My open issues", "Watching", "Recent" |
| List | Columns key, type, status, priority, assignee, summary (configurable as in `--columns`). `/` opens a filter bar that takes the `search` flags (`--assignee me --status ~Fertig`) or raw JQL. `o` sorts. Multi-select with `space`, `V` and shift+click |
| Detail | Tabs: Details (fields and description as markdown), Comments, Links (`Enter` follows a link), History |

**Actions.** Each one works on the selection or on the open issue:

| Key | Action | UI |
|---|---|---|
| `t` | transition | picker of the valid transitions (localized names) |
| `a` | assign | user picker with search (`searchUsers`), plus `me` and `none` |
| `c` | comment | inline editor (`textarea`) with markdown preview |
| `e` | edit summary and description | `$EDITOR` (the TUI suspends) |
| `l` | labels | multi-select picker with free entry |
| `s` | move to sprint | sprint picker |
| `p` | set epic or parent | issue picker |
| `n` | new issue, or clone with `N` | form: project, type, summary, then `$EDITOR` |
| `y` / `Y` | copy key / URL | toast |
| `O` | open in the browser | |

**Writes.** Every write shows what it will change and asks first:
- a single change asks with `y/n`;
- bulk changes over 5 issues list them and need `y` twice.

After a write, the issue is reloaded, and a toast reports the result. An error shows as a toast together with the exact Jira message (`jiraErrorText`).

### Wiki

| Pane | Content |
|---|---|
| Navigator | Spaces (favourites first), then the page tree, loading children on expand (`getPageDirectChildren`) |
| List | Context: children of the selected page, search results (CQL from `/`), recently changed pages, or pages with a label |
| Detail | The page as markdown (storage → markdown, as `docs pull` converts it), plus metadata: version, author, labels |

**Actions:**

| Key | Action |
|---|---|
| `e` | edit: see the flow below |
| `n` | new child page (title, then `$EDITOR`) |
| `l` | labels |
| `m` | move: pick a parent in the tree |
| `h` | history: versions, with a diff between any two (`<diff>`) |
| `y` / `Y` / `O` | copy the id, copy the URL, open in the browser |

**Edit flow:**
1. The page is fetched, with its version, and converted to markdown.
2. It opens in `$EDITOR`.
3. A **diff** shows the result.
4. A confirmation follows.
5. The push uses `version + 1`, so a 409 means someone else changed the page. The TUI then offers to reload, open the diff against the new version, or cancel.

**Safety:** the edit must use the same conversion and safeguards as `docs push`, not `wiki page update`, which has no guard. Pages with content markdown cannot round-trip (unknown macros) are flagged before editing, the same way `docs push` handles them. **Research task W0** settles which guard applies to a single-page edit.

## Architecture

```
apps/cli/src/commands/tui.ts      entry: TTY guard, profile, clients, dynamic import of @atlcli/tui
packages/tui/                     private package, own tsconfig (skipLibCheck only here)
  src/app.tsx                     shell: header, panes, status bar, overlays
  src/store.ts                    state, reduce(), dispatch via a ref (batched keys)
  src/keymap.ts                   key → action per focus context (pure)
  src/actions/jira.ts, wiki.ts    async effects: client calls → actions
  src/views/…                     one component per pane, modal and picker
  src/theme.ts                    colors and the markdown syntax style (dark and light)
```

**Package boundary:**
- `@atlcli/tui` depends on `@atlcli/core`, `@atlcli/jira`, `@atlcli/confluence` and OpenTUI, never on `apps/cli`.
- `apps/cli` passes in the clients and `openUrl`, and imports the package dynamically only in `atlcli tui`.
- The package is `private` and not published. It is internal: it does not join the API-report gate as a public library, and M0 says so in the gate's config.
- Its own `tsconfig.json` sets `skipLibCheck` and `jsxImportSource: @opentui/react`. The root `tsconfig.json` goes back to full lib checking, and the root typecheck excludes `packages/tui`; turbo typechecks the package on its own.

1. **A pure core and a thin view.** State, `reduce()` and the key map are plain TypeScript and test without a terminal. Components only render state and dispatch.

   The spike showed the store has to advance **synchronously** (a ref), because several keys can arrive in one batch.

2. **Actions reuse the shared layers, not the command handlers.** The handlers in `jira.ts` and `page.ts` call `fail()` and `process.exit`, which must not happen inside the TUI. Actions call `JiraClient` and `ConfluenceClient` directly.

   The pure helpers the TUI needs move from `apps/cli/src/commands/jira-input.ts` into `@atlcli/jira`, re-exported where the CLI imports them today:
   - `buildSearchJql` and its JQL helpers;
   - `resolveUser` and `pickUser`;
   - `renderIssueView`.

   Each move updates the API report, which is additive.

   Where logic exists only inside a handler, it moves into a pure, exported function that the handler and the TUI share. This has to be done for at least:
   - transition name matching, including localized names;
   - the user picker's search;
   - the wiki edit guard.

   The CLI's behaviour does not change; its tests cover each move.

3. **Async without races.** Each request carries the key it was made for. A response for an issue no longer selected is dropped. Requests whose result nobody waits for any more are cancelled (`AbortSignal`, which `search` already supports).

4. **`$EDITOR`** suspends the renderer, runs the existing `editInEditor`, then resumes.

5. **Configuration** lives in `~/.atlcli/config.json` under `tui`: `theme`, `keymap` overrides, `columns` and the start area. Only the values the MVP reads are added.

## Testing

| Level | What | How |
|---|---|---|
| Unit | `reduce`, keymap, actions (stub client), shared helpers | `bun run test`, as now |
| Render | each view and modal: content, layout at 80 and 160 columns, key and mouse flows | `@opentui/react` `testRender` + `captureCharFrame`, `mockInput`, `mockMouse`; snapshots |
| Live e2e | real site, real terminal | `scripts/tui-e2e.ts`: tmux driver (start, keys, SGR mouse, resize, capture) with scenarios against `mayflower` |

- **Live scope:** writes go only to ATLCLI (Jira) and DOCSY (Confluence), and test resources are cleaned up.
- **The PR template** lists the live scenarios run.
- **CI** runs the unit and render tests. The live e2e runs locally.

## Milestones

Each milestone is one PR, live-tested and documented.

| # | Content | Done when |
|---|---|---|
| **M0** Foundation | Shell (header, panes, status bar), store, keymap, theme, overlays (modal, toast, help, palette), render-test helpers, tmux e2e harness, `docs/tui.md` | Empty shell with help and palette; harness drives it |
| **M1** Jira read | Navigator (boards, sprints, epics, filters, my/watching/recent), list with filter bar and sorting, detail with tabs, links followable | Live: TCW and ATLCLI browsable by keyboard and mouse |
| **M2** Jira write | Transition, assign, comment, edit, labels, sprint, epic; multi-select bulk; create and clone | Live: every action on an ATLCLI test issue, cleaned up |
| **M3** Wiki read | Spaces, page tree, page view, CQL search, recent, labels, history with diff | Live: DOCSY browsable |
| **M4** Wiki write | W0 (edit guard), edit with diff and conflict handling, child page, labels, move | Live: edit and conflict scenario in DOCSY, cleaned up |
| **M5** Polish | Light theme, keymap config, resizable panes, Linux and Windows binary smoke tests, release notes | Release candidate |

**Merge order:** M0 → M1 → M2 → M3 → M4 → M5 (Jira first, as decided).

**M0 also:**
- creates `packages/tui` with its own `tsconfig`;
- takes `skipLibCheck` out of the root `tsconfig`;
- moves the spike's `state.ts` and `app.tsx` into the package.

## Risks

| Risk | Mitigation |
|---|---|
| OpenTUI is 0.x; the API changes | Pin the exact version; views stay thin; bump deliberately with the render tests as a guard |
| Native library on some platform or libc | M5 smoke tests on Linux glibc and musl and on Windows; on failure the TUI says so, and the CLI is unaffected |
| Lossy markdown round-trip of wiki pages | W0, diff before every push, refuse when the guard says so |
| Lost updates | Jira: reload after each write. Confluence: the version check (409) |
| Keys that terminals swallow (`Esc` + key, `Ctrl+…`) | Each action also reachable through the palette and the mouse |

## Decisions

Decided on 2026-10-23.

1. **Editing text is mixed:**
   - comments are written inline (`textarea`) with a markdown preview;
   - descriptions and wiki pages are edited in `$EDITOR`.
2. **Wiki editing is in the MVP:** edit existing pages and create child pages. Every push shows a diff first and checks the version.
3. **Own package:** `packages/tui` with its own `tsconfig` (see [Architecture](#architecture)). `skipLibCheck` applies only there.
4. **Order: Jira first.** M0 → M1 → M2 → M3 → M4 → M5, one after another.

## Outcome

All milestones are implemented and live-tested (profile `mayflower`, writes in ATLCLI and DOCSY only, everything created was deleted). The user guide is `src/content/docs/tui.md`.

### Deviations from the plan

| Plan | Built | Why |
|---|---|---|
| Labels on `l` | `L` | `l` is "right/open" in the vim keys |
| Wiki history on `h` | Versions on `v`; the wiki detail has the tabs page and info | `h` is "left/back" |
| Columns "as `--columns`" | `tui.columns` with a fixed set (key, type, status, priority, assignee, updated) | No field lookup per row; the summary always comes last |
| Spaces "favourites first" | The default space first, then by name | Favourites would cost a request per space |
| `skipLibCheck` only in the package | Yes, plus a hand-written type facade (`packages/tui/index.d.ts`) | The CLI's typecheck follows `import("@atlcli/tui")` into OpenTUI's declarations otherwise; `facade.test.ts` checks the facade |
| — | `<` / `>` resize the focused pane | A keyboard way for what the mouse does by dragging |

### Found and fixed along the way

- **Batched keys:** commands start on the key press, not a tick later. In a batch (fast typing, paste), the next key sees the picker the previous one opened.
- **Done statuses:** `flow.statusMap` names are translated for JQL (`Fertig` → `Done`), as the CLI's `--status` does. Otherwise "My open issues" listed done work.
- **Parent removal:** sends `parent: null`. Jira silently ignores an `update` with `set: { none: true }`. `UpdateIssueInput` now allows `null`.
- **Switching lists:** a switch no longer keeps the old selection when the old item is also in the new list.
- **Wiki edits:** conflicts are detected twice, before the write (version check) and by Confluence (409).
- **`VISUAL=`:** an empty value falls back to `$EDITOR`. It ran an empty command (exit 126), in the CLI's `--edit` too.
- **SIGTERM / SIGHUP:** these end the TUI and restore the terminal. Before, the process kept running after `kill` or a closed terminal.
- **Release build:** `windows-x64` is cross-compiled on Linux, where `bun install` leaves out OpenTUI's Windows library. The job now installs every platform's optional packages (`--os='*' --cpu='*'`).
- **Release smoke test:** `scripts/ci/tui-smoke.py` starts each native archive's TUI in a pseudo-terminal and quits it with `q` and with SIGTERM.
- **Data Center page tree:** root pages came from the Cloud-only v2 listing and children from v2 `direct-children`, so the tree failed on Data Center. There it now uses v1 (`/space/{key}/content/page?depth=root`, `/content/{id}/child/page`). Tested live against a local Confluence 9.2 Data Center (Docker, Postgres 15, Atlassian's 3-hour developer license): the tree expanded three levels, and the run found that opening a page still listed its children through v2 (404); fixed. `scripts/tui-e2e.ts` `wiki-read` and `wiki-write` (new page, edit with diff, conflict, cleanup) pass against it.
- **Windows:** the release runs the cross-compiled `atlcli.exe` on `windows-latest` before bundling: `--version` and the hidden `tui --self-test`, which draws the shell into OpenTUI's test renderer and needs no terminal. A one-off run of this job on the branch passed ([run 40033687743](https://github.com/BjoernSchotte/atlcli/actions/runs/40033687743)).

### Requirement check

Each requirement of this plan, against the code and a live run (`mayflower`; ATLCLI and DOCSY; Confluence Data Center 9.2 in Docker; Windows through `smoke-windows`):

| Plan | Where | Live |
|---|---|---|
| Separate entry, CLI untouched, TTY guard, OpenTUI loaded only in `atlcli tui` | `apps/cli/src/commands/tui.ts` | Without a TTY: JSON error, exit 1 |
| Three panes, `[` collapses the navigator, `z` fullscreen detail, stacked below 100 columns | `app.tsx`, `commands.ts`; render tests at 80, 140, 160 columns | tmux, resized to 90×30 |
| `1`/`2` and header click, modals, toasts, help `?`, palette `:`/`Ctrl+K` | `commands.ts`, `overlays.ts`, `views.tsx` | e2e `jira-read`; Windows click |
| Mouse: click, double-click, wheel, border drag, tab click; shift+click marks | `views.tsx`, `app.tsx`; render tests | tmux SGR mouse |
| Jira navigator: boards → sprints and backlog, epics, favourite filters, my open, watching, recent | `jira.ts` | e2e `jira-read` (TCW, ATLCLI) |
| Jira list: columns, `/` with search flags or JQL, `o` sort, `space`/`V`/shift+click | `jira.ts`, `commands.ts` | e2e `jira-read` |
| Jira detail tabs; `Enter` on links | `jira-view.tsx`, `jira.ts` | e2e `jira-read` |
| `t` `a` `c` `e` `L` `s` `p` `n` `N` `y` `Y` `O`; confirm every write, `y` twice above 5 | `jira-actions.ts` (`BULK_CONFIRM`) | e2e `jira-write`; sprint move on a temporary board |
| Reload after a write, errors as toasts with Jira's message | `jira-actions.ts` | e2e `jira-write` |
| Wiki navigator: spaces, page tree loading on expand | `wiki.ts` (`directChildren`, v1 on Data Center) | e2e `wiki-read`; Data Center three levels |
| Wiki list: children, CQL search (labels: `label = "x"`), recently updated, my pages | `wiki.ts` | e2e `wiki-read`, Data Center |
| Wiki detail: markdown as `docs pull` converts it; version, author, labels | `wiki.ts`, `wiki-view.tsx` | info tab shows "updated … by …" |
| `e` (diff, version + 1, conflict: show, redo, discard), `n`, `L`, `m`, `v`, `y`/`Y`/`O`; W0 guard | `wiki.ts`, `editBlockReason` | e2e `wiki-write` incl. conflict; Data Center |
| Pure core (store, keymap) and thin views; synchronous store for batched keys | `store.ts`, `keymap.ts`, `state.ts` | — (unit tests) |
| Shared helpers moved to `@atlcli/jira` (search JQL, user pick, transitions) | `packages/jira/src/input.ts`; API report | CLI unchanged (its tests) |
| Async: stale answers dropped, superseded list requests cancelled (`AbortSignal`) | `jira.ts`, `wiki.ts` `listAbort`; tests | burst of three list switches: two searches cancelled |
| `$EDITOR` suspends the renderer | `app.tsx` `suspend`, CLI `editInEditor` | e2e writes; Windows with a script editor |
| Config `tui.area`, `theme`, `keymap`, `columns` | `tuiConfig`, `TuiSettings` | copy of the config via `ATLCLI_CONFIG` |
| Unit, render and live e2e tests; CI runs unit and render | `packages/tui/src/*.test.ts*`, `scripts/tui-e2e.ts` | full CI runs on the branch |
| M5: light theme, keymap, resizable panes, binary smoke tests (Linux glibc and musl, Windows), release notes | `theme.ts`, `tui-smoke.py`, `tui-smoke-windows.py`; release notes come from the Conventional Commits at release | Docker (glibc, musl), Windows runner |

Rerun on the code of the final commit (`b036d9ad`):
- `scripts/tui-e2e.ts` against `mayflower`: all four scenarios (ATLCLI, DOCSY, with `$EDITOR` edits), and `jira-read` against TCW.
- **Cancelling:** opening three lists in one burst sent three searches; the first two were cancelled (no response in the request log), the last one was answered, and the list showed it.
- **Author:** the info tab of a DOCSY page shows "updated … by …".
- **Linux binaries** built from it, in Docker under a TTY: Debian 12 (glibc) and Alpine 3.20 (musl) drew the shell and ended on SIGTERM; `tui --self-test` passed and the TTY guard refused without a terminal in both.
- Full local `bun run test` (10,156 pass) and a full CI run ([40045771133](https://github.com/BjoernSchotte/atlcli/actions/runs/40045771133)).

The PR description (#327) lists the live scenarios; the repository has no PR template file.

### Platform notes

- **Windows:** in a real console (ConPTY, `scripts/ci/tui-smoke-windows.py`, part of the release's `smoke-windows` job, against a local Jira stub) the binary draws, `?` opens the help, `e` edits an issue through `$EDITOR` with the diff and saves it (the stub receives the edited description), a mouse click on the Wiki tab switches the area and `q` quits with 0 ([run 40044278411](https://github.com/BjoernSchotte/atlcli/actions/runs/40044278411)). Without `$VISUAL`/`$EDITOR`, Windows now falls back to `notepad` instead of `vi`. Not run there: a live Atlassian site, and Notepad itself (the test uses a script as the editor).
- **Linux:** both binaries ran in Docker under a TTY: they drew the shell and ended on SIGTERM.
  - **glibc:** Debian 12, arm64.
  - **musl:** Alpine 3.20, arm64, with `libstdc++` installed (Bun's runtime needs it). atlcli's releases have no musl build; this checks that the TUI's native library works there.
- **Sprint moves:** tested live on a temporary scrum board in ATLCLI (into a sprint, back to the backlog); board, sprint, filter and issue were deleted afterwards.
