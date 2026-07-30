# @atlcli/extension

Chrome extension (Manifest V3) workspace for atlcli — spec `002-extension-workspace`.
It detects Confluence pages and exports DOCX and PDF from a side panel. The extension owns
Chrome/session policy, IndexedDB template and job stores, background/offscreen routing, browser
downloads, and UI. Reusable format behavior lives in `@atlcli/docx`, `@atlcli/pdf`, and the
browser-only `@atlcli/pdf-compiler-browser` package.

Built with [WXT](https://wxt.dev) `0.20.x` (Vite-based, MV3-aware) and React 19.
The side-panel UI is branded **Kiteweave Browser**; the package and manifest retain the
`atlcli` engineering name.

## Prerequisites

- `bun install` at the repo root (installs WXT, React, `@types/chrome`).
- Google Chrome ≥ 140 (the manifest pins `minimum_chrome_version: "140"`; this
  is the oldest browser exercised by the built MV3 PDF.js worker test).

## Layout

```
entrypoints/
  background.ts       # service worker: message router + offscreen lifecycle
  sidepanel/          # React side panel (index.html + main.tsx + App.tsx)
  offscreen/          # headless PDF compiler host (index.html + main.ts)
utils/
  docx/               # extension storage/session/output adapters
  pdf/                # extension page, job, worker, and output adapters
  messages.ts         # typed message protocol (discriminated unions)
  router.ts           # message router (functional core, unit-tested)
  offscreen.ts        # idempotent ensureOffscreen() helper
workers/
  pdf-compiler.ts      # static WASM/font/license imports + compiler package
scripts/
  check-output-build.ts  # manifest, inventory, CSP, and runtime-leak scan
```

## Build

```bash
bun run --cwd apps/extension build     # → apps/extension/.output/chrome-mv3/
# or from the repo root (via Turbo):
bun run build
```

The load-unpacked target is **`apps/extension/.output/chrome-mv3/`**.

## Dev loop (HMR)

```bash
bun run --cwd apps/extension dev        # starts the WXT dev server + opens Chrome
```

WXT auto-reloads on source changes. In a headless/CI environment the dev server
still starts; only the automatic Chrome launch is skipped.

## Load unpacked + reload-after-rebuild workflow

1. Run a production build: `bun run --cwd apps/extension build`.
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. Click **Load unpacked** and select `apps/extension/.output/chrome-mv3/`.
4. Click the atlcli toolbar action to open the side panel.
5. Open an eligible Confluence page. Upload/select a DOCX template for Word export, or run the
   built-in PDF export.

Both formats create a durable Activity row before the first source read. After
submission, navigate to another tab/page or close the side panel: the
background/offscreen runner continues. **History** shows progress, statistics,
bounded events, Retry/Run again, resume after sign-in, and download. The toolbar
badge shows the active count and unread success/failure state.

**After each rebuild:** click the **reload** (↻) icon on the atlcli card in
`chrome://extensions`. During active `dev` sessions WXT reloads automatically, so
this manual step is only needed for `build` (production) artifacts.

Inspect the service worker via the **service worker** link on the card; the
offscreen document appears in the card's inspect list while a WASM job is active.

## Checks

```bash
bun run --cwd apps/extension typecheck     # wxt prepare && tsc --noEmit
bun run --cwd apps/extension check:output  # scan built bundle for leaks
```

The repository-level `bun run check:browser-export-harness` and
`bun run test:browser-export-harness` commands prove the reusable DOCX/PDF package contracts in
an independent production Vite/Chromium host.

## Design notes

- The compact shell has a scalable product-area switcher. **Publishing** is active;
  **Jira SafeOps** and **Automations** are labelled as planned rather than exposed as
  working features. Publishing screens remain registry-driven: **Create**, **Preview**,
  **Templates**, and **History**.
- Primary navigation keeps text labels at the 320 px minimum width and implements the
  tab keyboard pattern (Left/Right/Home/End). The product menu implements
  Up/Down/Home/End/Escape and restores focus to its trigger.
- PDF and Word remain format-specific flows. PDF uses the built-in document design;
  Word export stays disabled until an explicit DOCX template is available.
- **No remote-hosted UI / no inline scripts** — everything renders from bundled,
  local assets (MV3 CSP `script-src 'self' 'wasm-unsafe-eval'`). The bundled
  offscreen document hosts the PDF compiler worker.
- The **UI ↔ extension-capability boundary is the typed message protocol**
  (`utils/messages.ts`). Large source and result bytes remain in the extension's job store;
  messages carry bounded control data.
- DOCX and PDF are separate engines. They share Confluence `ExportBlock[]`, not a generic
  export engine, runner, report, or output sink.
