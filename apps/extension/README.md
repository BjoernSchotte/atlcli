# @atlcli/extension

Chrome extension (Manifest V3) workspace for atlcli — spec `002-extension-workspace`.
This is **scaffolding only**: a side panel, a service worker, and an offscreen
WASM host wired together over a typed message protocol. No Confluence calls, no
export logic (those arrive in specs 003–005).

Built with [WXT](https://wxt.dev) `0.20.x` (Vite-based, MV3-aware) and React 19.

## Prerequisites

- `bun install` at the repo root (installs WXT, React, `@types/chrome`).
- Google Chrome ≥ 116 (the manifest pins `minimum_chrome_version: "116"` for the
  side panel + offscreen APIs).

## Layout

```
entrypoints/
  background.ts       # service worker: message router + offscreen lifecycle
  sidepanel/          # React side panel (index.html + main.tsx + App.tsx)
  offscreen/          # headless WASM host (index.html + main.ts)
utils/
  messages.ts         # typed message protocol (discriminated unions)
  router.ts           # PURE message router (functional core, unit-tested)
  offscreen.ts        # idempotent ensureOffscreen() helper
  wasm-smoke.ts        # inline WASM add module + runner
scripts/
  check-output-build.ts  # post-build isomorphism scan (node:/bun:/remote)
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
5. In the side panel **Debug** section, use **Ping** (round-trips through the
   service worker → `pong`) and **WASM smoke** (panel → SW → offscreen → SW →
   panel → `40 + 2 = 42`).

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

## Design notes

- **No remote-hosted UI / no inline scripts** — everything renders from bundled,
  local assets (MV3 CSP `script-src 'self' 'wasm-unsafe-eval'`). The bundled
  offscreen document is where WASM (typst.ts in spec 005) runs.
- The **UI ↔ extension-capability boundary is the typed message protocol**
  (`utils/messages.ts`). Keeping it thin and stable preserves the option to move
  the UI into a sandboxed remote iframe later (PLAN §2.2) without re-review churn.
