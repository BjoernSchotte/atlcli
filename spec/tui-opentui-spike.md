# Spike: `atlcli tui` on OpenTUI + React

**Status:** spike on branch `spike/tui-opentui`, not for merge. **Date:** 2026-10-23.

## Question

Is OpenTUI (0.6.8, `@opentui/react`) a sound base for a fullscreen, mouse-capable `atlcli tui` that leaves the CLI untouched for CI and ops? Can the agent drive and verify it through tmux?

## What was built

`atlcli tui [--project <key>] [--jql <query>]`: a read-only Jira browser.

- **Layout:** issue list on the left, the selected issue on the right (summary, type · status · priority · assignee, description as rendered markdown), key hints at the bottom.
- **Keys:** `j`/`k`, `g`/`G`, `PgUp`/`PgDn`, `Tab`/`Enter`/`Esc` to switch pane, space to page, `o` open in the browser, `r` reload, `q` and `Ctrl+C` quit.
- **Mouse:** click a row to select it; the wheel scrolls either pane.

**Files:**

| File | Role |
|---|---|
| `apps/cli/src/commands/tui.ts` | the command: TTY guard, JQL, client, then a dynamic import of the app |
| `apps/cli/src/tui/state.ts` | state and key map as pure functions, with `state.test.ts` |
| `apps/cli/src/tui/app.tsx` | the OpenTUI/React view |

## Findings

| Question | Result |
|---|---|
| Runs under Bun in this repo | Yes. `react` must be the hoisted version (19.2.7); a second copy breaks hooks ("resolveDispatcher() is null"). |
| Fullscreen, no flicker | Alternate screen by default. Leaving it restores the terminal (`q`, `Ctrl+C`, exit 0). |
| Mouse | SGR click and wheel events select rows and scroll, sent through tmux as raw escape sequences. |
| Markdown | The `<markdown>` renderable shows ADF → markdown, with a scrollbar. |
| Resize | 160×40 → 100×20 re-lays out cleanly. |
| CI safety | Without a TTY: `atlcli tui needs an interactive terminal.`, exit 1, JSON error with `--json`. |
| Lazy load | `--version` startup unchanged (368 vs 371 ms, 10 runs each). |
| Compiled binary | `bun build --compile` embeds the native library; the TUI runs from a directory without `node_modules`. +13 MB (186.4 vs 173.3 MB; the release binary is a few PRs older). |
| Typecheck | OpenTUI's `.d.ts` need `skipLibCheck` (set in the root `tsconfig.json`, as OpenTUI's README asks). |
| tmux control | `send-keys`, raw SGR mouse sequences, `resize-window` and `capture-pane` give a full test loop; driver script in the session scratchpad. |

## Pitfalls found

1. **Batched keys.** Several keys can arrive before React re-renders (fast typing, paste, tmux). A handler that reads React state then sees the old pane (`Tab j` moved the list instead of scrolling the detail). Fix: the state advances synchronously in a ref (`reduce` on `stateRef.current`) and React renders the result. Every future pane needs the same.
2. **Flex shrink.** Fixed columns need `flexShrink: 0`, or long summaries squeeze the key column; `truncate` puts the ellipsis in the middle, so the summary just clips.
3. **`Esc` + key at once** reads as Alt+key (terminal behaviour). Real typing is fine; tests must send `Esc` separately.

## Not tested

- Windows and Linux binaries (only macOS arm64).
- `o` (opens a browser; uses the existing `openUrl`).
- Writes: transition, assign, comment, edit.
- The Confluence side.

## Recommendation

Go for OpenTUI + React. It covers every hard requirement (fullscreen, mouse, scroll, markdown, resize) and the build, and the cost of the native dependency is acceptable (+13 MB, no startup cost). Next:

1. A plan in `spec/` for the MVP:
   - Jira: actions with confirmation, a sprint and epic sidebar, a filter bar.
   - Wiki: page tree, page view, edit with diff before push.
2. Keep views thin over pure state and action modules (as `state.ts`), so tests need no terminal.
3. A tmux-based e2e harness in the repo (start, keys, mouse, capture), so every TUI change is tested live.
4. Decide `skipLibCheck`: keep it global, or move the TUI into its own package with its own `tsconfig`.
