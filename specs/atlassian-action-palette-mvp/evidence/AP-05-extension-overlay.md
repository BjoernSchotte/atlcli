# AP-05 extension overlay evidence

**Status:** COMPLETE

**Date:** 2026-08-11

**Implementation base:** `4279ffe3c889e86e7f42034cb5f40307159fc3c0`

## Delivered surface

The extension now registers one top-frame, isolated-world WXT content entry across `https://*.atlassian.net/*`. Its eager shell creates at most one `atlcli-action-palette-root`, one ShadowRoot, and one extension-owned iframe. The React presenter and catalog are loaded only inside that iframe on first open; subsequent toggles reuse the same mount. The content shell is the only frame/background bridge and accepts only the exact public request protocol.

The manifest command is `action-palette`, with `Ctrl+Shift+K` as the default and `Command+Shift+K` on macOS. Both the palette footer and Settings read the actual `chrome.commands.getAll()` assignment. An unbound command is reported honestly with a link to `chrome://extensions/shortcuts`; the existing toolbar-to-sidebar path remains unchanged.

The initial WXT dynamic-import implementation inlined React into the eager content script and exceeded the 30 KiB budget. The final architecture keeps the content shell at 6,585 gzip bytes and loads the 80,396-byte presenter only after opening. The shared stylesheet export now follows the package's `development` condition, preventing WXT from silently consuming stale `dist/styles.css` while TypeScript resolves live source.

## Browser proof

```bash
bun run --cwd apps/extension build
bun run --cwd apps/extension test:palette-extension-browser:prebuilt
```

The final Playwright run loaded the production WXT directory through Chromium's unpacked-extension mechanism and passed **6 of 6** cases:

- production output on Confluence view/editor, Jira issue/board, generic Atlassian, and a non-Atlassian negative control;
- one mount across SPA navigation and 50 open/close cycles, adversarial host CSS, 150% browser zoom, outside-pointer dismissal, no duplicate listeners, no closed-state shortcut interception, and no console errors;
- exact contenteditable focus plus selection restoration;
- root, results, empty, action-panel, input, loading, and bounded-error states with zero palette WCAG A/AA violations and zero serious/critical page violations caused by the palette;
- all visible pointer targets at least 24 by 24 CSS pixels and close/back/primary controls at least 44 by 44 after zoom;
- an isolated second Playwright project copied the same production output, removed only the projected PDF capability, and proved that the PDF action remains visible, explained, `aria-disabled`, and inert even when a click event is dispatched.

The browser launch needed the already-approved unsandboxed lane because macOS Chromium Crashpad cannot initialize inside the restricted sandbox. No test assertion or output artifact changed between the blocked and authorized launches.

## Contract and static proof

```bash
bun run test apps/extension/tests/manifest.test.ts apps/extension/tests/action-palette-content.test.tsx apps/extension/tests/action-palette-protocol.test.ts
bun run test packages/action-palette-react/src/ActionPalette.test.tsx packages/action-palette-react/src/render-performance.benchmark.test.tsx
bun run test packages/action-palette-react/src/package-boundary.test.ts packages/action-palette-react/src/styles.test.ts
bun run test packages/action-registry/src/search.benchmark.test.ts
bun run check:extension-output
bun run check:browser
bun run typecheck
```

Results:

- manifest/content/protocol: **25 passing, 0 failing**;
- presenter plus render benchmark: **22 passing, 0 failing**;
- published package and stylesheet boundary: **6 passing, 0 failing**;
- pure search benchmark: **1 passing, 0 failing**;
- extension output scan: CSP-safe and complete;
- browser boundary: all 34 checked entrypoints remained browser-clean;
- full root, WXT extension, PDF browser compiler, and browser-export-harness typecheck passed.

## Performance proof

Raw samples are stored in `AP-05-performance.json`. Every latency series discards five warmups and stores 30 measured samples.

| Budget | Required | Measured |
| --- | ---: | ---: |
| Cold shortcut to focused input, p95 | <= 200 ms | 74.820 ms |
| Warm shortcut to focused input, p95 | <= 100 ms | 8.035 ms |
| React query over 500 actions, p95 | <= 50 ms | 24.967 ms |
| Pure search over 1,000 actions, p95 / max | <= 16 / 50 ms | 10.047 / 10.414 ms |
| Maximum palette long task | < 50 ms | 0 ms |
| Search-time network requests | 0 | 0 |
| Eager palette bootstrap | <= 30 KiB gzip | 6,585 bytes |
| Total lazy palette UI | <= 180 KiB gzip | 80,396 bytes |

## Screenshot boundary

This AP-05 proof used controlled local Atlassian fixtures, not a live tenant. No LIVE screenshot was therefore captured or committed. The first live-tenant acceptance run must write its screenshots outside the repository and present them in the task, as requested.
