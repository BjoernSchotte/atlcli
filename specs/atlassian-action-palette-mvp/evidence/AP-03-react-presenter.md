# AP-03 shared React presenter evidence

**Status:** COMPLETE

**Date:** 2026-08-11

**Implementation base:** `cd50e38158ec7ea75863004f07259c80e82f12a6`

## Delivered boundary

`@atlcli/action-palette-react` is a browser-only presenter over the neutral `@atlcli/action-registry` catalog. The package owns presentation state, keyboard and focus behavior, input validation, accessible markup, result rendering, and host-agnostic styles. Hosts inject the catalog, bounded executor, translations, icons, lifecycle callbacks, and optional `Element`, `DocumentFragment`, or `ShadowRoot` portal target.

The runtime manifest has exactly one workspace dependency, `@atlcli/action-registry`. React and ReactDOM are peers with the range `>=18 <20`; there is no dialog, listbox, command-palette, host, engine, worker, remote-runtime, WXT, Forge, Node, or Bun runtime dependency.

## Presenter behavior and accessibility

The focused suite covers:

- root list, action panel, input, executing, queued, completed, failed, open-surface, and empty presentations;
- Arrow Up/Down, Home, End, Enter, Cmd/Ctrl+Enter, Tab/Shift+Tab, and the full Escape hierarchy;
- IME suppression, active-row scrolling, exact focus restoration, disabled action inspection, and single execution;
- bounded input validation, abort and late-result suppression, private error handling, retry, and text-only result output;
- host-supplied ShadowRoot rendering, safe translation fallbacks, long labels, English/German parity, and German selection;
- zero serious or critical axe violations in root and input states;
- inline snapshots for Reduced Motion and Forced Colors plus logical-property/compact-container checks for RTL-safe layout.

Command:

```bash
bun run test packages/action-palette-react/src
```

Result: **32 passing, 0 failing**, including two CSS mode snapshots.

## Browser and dependency graph

The dedicated boundary test runs its Bun browser build in a child process so the workspace test module graph remains isolated. The minified standalone presenter graph measured:

```text
JavaScript: 30,219 bytes
gzip:        8,601 bytes
external:    react, react-dom, react/jsx-dev-runtime
```

The build reached no Node/Bun builtin, Chrome/extension API, WXT module, Forge module, engine, or remote runtime. A dialog/listbox dependency was therefore unnecessary and rejected; the extension's AP-00 production baseline remains unchanged until AP-05 integrates a lazy host chunk.

Two consumer-resolution fixtures then bundled the same presenter through separate host roots:

| Consumer | Host React | Loaded runtime roots | Foreign React copy |
| --- | --- | --- | --- |
| Extension | `19.2.0` | host `react`, host `react-dom` | none |
| Forge | `18.3.1` | host `react`, host `react-dom` | none |

Both fixtures found their unique host marker and version exactly once in the loaded host React source.

## Build and repository gates

```bash
bun run --cwd packages/action-palette-react build
bun run typecheck
bun run check:browser
```

All commands passed. The typecheck included the extension, PDF browser compiler, and browser export harness. The neutral browser gate passed all **34** registered entrypoints; the React presenter intentionally remains outside that neutral-only list and is covered by its dedicated package boundary test.

## Visual smoke

A real Chromium render at 1440×900 confirmed the root dialog, search focus, selected row, labelled groups, context chip, unavailable reason, footer shortcuts, and backdrop. Per operator instruction, `ap03-action-palette-root.png` was displayed in the Codex task and stored outside the repository; no screenshot or temporary visual harness is committed.

AP-03 does not yet execute an Atlassian tenant action: Extension and Forge live-host integration belongs to AP-05 and AP-08. Their live tests must capture and display separate uncommitted screenshots.
