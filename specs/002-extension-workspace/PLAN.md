# Extension Workspace — MV3 Skeleton for `apps/extension`

Status: **Planned**

Spec ID: `002-extension-workspace`
Depends on: `specs/001-browser-ready-core` (implemented — browser entry, session auth, CI gate)
Blocks: `003-page-detection-read-path`, `004-docx-export`, `005-pdf-export`
Related strategy: `~/code/rovo-skills/FAHRPLAN.md` Phase 1 Task 1.1 · `~/code/rovo-skills/research/TYPST-EXPORT-ANGLE.md` §1b (WASM in MV3), §7.4/§7.5 Schritt 2
Origin: FAHRPLAN Phase 1 — "Workspace `apps/extension`"

---

## 1. Overview

Create the Chrome extension workspace in the monorepo: a Manifest V3 extension that loads
unpacked in Chrome, opens a side panel on Atlassian tabs, hosts an offscreen document for
WASM workloads (needed by the PDF path, spec 005), and builds via the existing Bun/Turbo
pipeline. This spec delivers **scaffolding only** — no Confluence calls, no export logic.
Its job is to make every later spec a pure feature-add on a proven skeleton.

Key architectural facts driving the shape (from the research):

- **MV3 service workers are short-lived** — any multi-second WASM job (Typst compile) must
  run in an **offscreen document**, not the service worker. The skeleton must prove the
  offscreen round-trip works before spec 005 depends on it.
- **WASM requires `wasm-unsafe-eval`** in the extension CSP (Chrome ≥ 103).
- **Session-cookie auth requires `host_permissions`** for `*.atlassian.net` so that
  `fetch(..., { credentials: "include" })` from extension contexts rides the user's
  Atlassian session (validated conceptually in 001; proven end-to-end in 003).

### Goals

- `apps/extension` workspace exists, wired into workspaces/Turbo/typecheck/CI.
- `bun run --cwd apps/extension build` produces a `dist/` directory that Chrome accepts via
  **Load unpacked** without warnings or errors.
- Side panel opens and renders a placeholder UI; service worker and offscreen document
  communicate via typed messages.
- Offscreen document instantiates a trivial WASM module (smoke test for the 005 path).
- The extension imports `@atlcli/core` (browser entry) and `@atlcli/confluence` and the
  bundle contains zero `node:`/`bun:` specifiers — enforced by extending the existing
  `check:browser` gate.

### Non-goals (this spec)

- No page detection, no REST calls, no session-auth usage (spec 003).
- No DOCX/PDF export, no template UI (specs 004/005).
- No Chrome Web Store packaging/publishing, no icons beyond placeholders, no i18n.
- No Firefox/Edge compatibility work (MV3 Chrome only for the PoC).
- No framework-heavy UI: keep the panel minimal; visual design comes with the feature specs.

---

## 2. Architecture decisions

### 2.1 Build tooling: plain `bun build` script, no extension framework

**Decision (proposed):** a small `apps/extension/scripts/build.ts` that runs
`bun build --target=browser` per entrypoint (service worker, side panel, offscreen) and
copies static assets (`manifest.json`, HTML, icons) to `dist/`. Optional `--watch` flag for
dev iteration.

Rationale: the repo is Bun-native and already has browser-build infrastructure (001's
`check:browser`). Frameworks like WXT or CRXJS bring Vite along — a second bundler
toolchain to maintain for features (HMR into extension pages) that a PoC does not need.
Revisit if dev-loop friction becomes real.

**Rejected alternative:** WXT (nice DX, auto-manifest, HMR) — deferred; adopting it later
is a build-layer swap, not an architecture change.

### 2.2 UI stack: Preact + htm (no JSX build step) — decision F1, see §8

Panel UI needs lists, progress states and a template picker in specs 003–005 — beyond
comfortable vanilla-DOM territory, but React (~45 KB) is oversized for a side panel.
**Proposal: Preact (~4 KB)**. Final call is open question F1.

### 2.3 Extension surfaces and message protocol

```
apps/extension/
  manifest.json           # MV3, side_panel, offscreen, host_permissions
  src/
    background.ts         # service worker: routing, offscreen lifecycle mgmt
    sidepanel/
      index.html
      main.ts(x)          # panel UI entry
    offscreen/
      index.html
      main.ts             # WASM host (typst.ts lives here from 005 on)
    messages.ts           # typed message protocol (discriminated unions)
  scripts/build.ts
  package.json            # name: @atlcli/extension, private
  tsconfig.json           # DOM + chrome types, extends root config
```

Manifest core (normative):

```jsonc
{
  "manifest_version": 3,
  "name": "atlcli",
  "permissions": ["sidePanel", "offscreen", "storage", "tabs"],
  "host_permissions": ["*://*.atlassian.net/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel/index.html" },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

- `tabs` permission is needed in 003 for reading the active tab URL; included now so the
  permission prompt is stable across the PoC (no re-approval churn for the user).
- **All message types live in `messages.ts`** as a discriminated union
  (`{ kind: "ping" } | { kind: "wasm-smoke" } | …`); both sides exhaustively switch on
  `kind`. Later specs extend this union instead of inventing ad-hoc messages.
- Offscreen document lifecycle: `background.ts` owns `chrome.offscreen.createDocument`
  (reason: `WORKERS` — WASM execution) and closes it when idle; helper
  `ensureOffscreen()` is idempotent.

### 2.4 Monorepo wiring

- Root `package.json` workspaces already cover `apps/*` — no change needed.
- Turbo: `build` task for `apps/extension` with `dist/**` outputs; depends on `^build`.
- `scripts/check-browser-build.ts` (from 001) gains the three extension entrypoints, so a
  stray Node import in extension code turns CI red like everywhere else.
- Typecheck: extension tsconfig included in root `bun run typecheck` (add `@types/chrome`).

---

## 3. Task breakdown (ordered)

> AC = acceptance criteria, each objectively checkable. Tasks marked **[E2E: user]** need
> Björn to load the unpacked extension in Chrome — coordinate before starting those checks.

### Task 1 — Workspace scaffold + build script

- [ ] `apps/extension` exists per §2.3 layout; `package.json` (`@atlcli/extension`, private) with deps on `@atlcli/core`, `@atlcli/confluence`
- [ ] `scripts/build.ts` bundles background/sidepanel/offscreen entries (`bun build --target=browser`) and copies manifest + HTML + placeholder icons to `dist/`
- [ ] `bun run --cwd apps/extension build` exits 0; `dist/` contains manifest.json, background.js, sidepanel/, offscreen/
- [ ] Turbo `build` task wired; root `bun run build` still green
- [ ] `bun run typecheck` green with extension sources included (`@types/chrome` installed)

### Task 2 — Manifest + CSP correctness

- [ ] `manifest.json` matches §2.3 (MV3, side_panel, offscreen, storage, tabs, host_permissions `*://*.atlassian.net/*`, CSP with `wasm-unsafe-eval`)
- [ ] A manifest validation test parses `dist/manifest.json` and asserts the normative fields (guards against build-script copy regressions)
- [ ] No `unsafe-eval` (only `wasm-unsafe-eval`) — asserted by the same test

### Task 3 — Message protocol + service worker

- [ ] `messages.ts` defines the typed protocol (`ping`, `wasm-smoke` at minimum) with request/response pairing (correlation id or `chrome.runtime.sendMessage` response callback)
- [ ] `background.ts` handles `ping` → `pong`; unit test for the pure router logic (extract routing into a testable function — functional core, imperative shell)
- [ ] `ensureOffscreen()` implemented: creates the offscreen document once, reuses it, survives double-invocation (unit test with mocked `chrome.offscreen`)

### Task 4 — Side panel skeleton

- [ ] Side panel renders: extension name/version, a status line ("no Atlassian page detected" placeholder for 003), and a "Ping" debug button that round-trips through the service worker and displays `pong`
- [ ] Panel opens via the extension action click (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`)
- [ ] UI stack per decision F1; no inline scripts (MV3 CSP forbids them) — all JS from bundled files

### Task 5 — Offscreen WASM smoke test

- [ ] Offscreen document loads and instantiates a minimal inline WASM module (e.g. a hand-written 8-byte-plus add function, no external dependency) on receiving `wasm-smoke`, returns the computed result
- [ ] Side panel debug section triggers `wasm-smoke` end-to-end: panel → SW → offscreen → SW → panel; result rendered
- [ ] Failure path: if WASM instantiation throws, the error message (not a hang) reaches the panel

### Task 6 — CI gate extension

- [ ] `scripts/check-browser-build.ts` includes the three extension entrypoints; `bun run check:browser` green
- [ ] Negative proof retained: seeding `node:os` into `background.ts` fails `check:browser` naming the entrypoint (fixture test, same pattern as 001 Task 6)

### Task 7 — Manual E2E: load unpacked **[E2E: user]**

Joint session — I cannot drive Björn's Chrome:

- [ ] `chrome://extensions` → Load unpacked → `apps/extension/dist` loads with **zero errors/warnings** on the extensions page
- [ ] Clicking the toolbar action opens the side panel on any tab
- [ ] Ping and WASM smoke test succeed from the panel (visible results)
- [ ] Service worker console (inspect view) shows no errors; offscreen document appears in `chrome://extensions` inspect list while active
- [ ] Reload-after-rebuild loop documented in `apps/extension/README.md` (build → reload button) so later specs' E2E sessions are smooth

---

## 4. Test plan

- **Unit (bun test):** message router, `ensureOffscreen` idempotency, manifest field assertions on `dist/manifest.json` (runs after build in CI), build-script output inventory.
- **Build-level:** `check:browser` covers all extension entrypoints (positive + seeded-negative).
- **Manual E2E (with user, Task 7):** load unpacked, side panel, ping, WASM smoke. Chrome APIs (`chrome.*`) are not unit-testable in bun without heavy mocking — mock only the thin imperative shell; keep logic pure and tested.
- No live Confluence interaction in this spec.

## 5. Definition of done

- Tasks 1–7 ACs checked (Task 7 jointly with Björn).
- `bun test`, `bun run typecheck`, `bun run build`, `bun run check:browser` green at root.
- Extension loads unpacked with zero console errors; ping + WASM round-trips proven.
- `apps/extension/README.md` documents build + load-unpacked + reload workflow.

## 6. Risks and open questions

1. **Offscreen document API churn.** `chrome.offscreen` reasons/lifetime semantics have shifted across Chrome versions; pin minimum Chrome version in the manifest (`minimum_chrome_version: "116"` — sidePanel API baseline) and verify against Björn's actual Chrome in Task 7.
2. **Side panel UX constraints.** Side panel width is user-controlled and narrow; the 004/005 UIs must be designed for ~320–400 px. Skeleton should already use a narrow-first layout.
3. **`*.atlassian.net` only.** DC/Server instances live on arbitrary domains — out of scope for the PoC (FAHRPLAN scopes Cloud); revisit host_permissions strategy (optional_host_permissions + user grant) post-PoC.
4. **Bun as extension bundler.** `bun build` lacks HTML-entry awareness (we copy HTML manually and reference hashed-free JS names). Acceptable for PoC; if asset graphs grow (fonts/WASM in 005), the build script grows with them — contained in one file.

### Decisions log

- **F1 — panel UI stack**: ❓ open (proposal: Preact + htm; alternatives: vanilla TS, React). Decide before Task 4.
- **F2 — build tooling**: ✅ proposed plain `bun build` script (§2.1); revisit only on real dev-loop pain.
