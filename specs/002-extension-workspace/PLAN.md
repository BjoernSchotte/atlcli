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
- `bun run --cwd apps/extension build` (→ `wxt build`) produces `.output/chrome-mv3/` that
  Chrome accepts via **Load unpacked** without warnings or errors.
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

### 2.1 Build tooling: WXT (decision F2 ✅ 2026-07-14)

**Decision (Björn, 2026-07-14):** the extension is built with **WXT** as the core
framework (Vite-based, MV3-aware: manifest generation, entrypoint conventions, dev-mode
HMR, `wxt build` output ready for load-unpacked). Rationale: WXT carries the extension
plumbing so the specs 003–005 stay feature work, and its dev loop pays off across the
many joint E2E sessions ahead.

Consequence for the monorepo: `apps/extension` gets Vite/WXT as its local toolchain while
the rest of the repo stays pure Bun. Shared code (`@atlcli/core` browser entry,
`@atlcli/confluence`) is consumed as workspace source — isomorphism for those packages
remains enforced by the existing `check:browser` gate; the WXT bundle gets its own
output-scan check (Task 6).

### 2.2 UI stack: React in popup/side panel (decision F1 ✅ 2026-07-14)

**Decision (Björn, 2026-07-14):** **React** for the side panel/popup UI (WXT's React
template). Forward-looking rationale: a later phase may add an inline chat UI for the
agent overlay (Phase 3), where **CopilotKit-UI** on top of React is the candidate —
Preact/vanilla would block that path.

**Constraint for the PoC:** no remote-iframe UI — everything renders from bundled, local
assets, consistent with the privacy story ("nothing leaves the browser").

**Documented for later (post-PoC option, Björn 2026-07-14):** Chrome Web Store MV3 policy
exempts contexts *isolated from extension APIs* (iframes, sandboxed pages) from the
remote-code restriction. That enables a **remote-hosted UI web app inside a sandboxed
iframe**: UI changes deploy daily without waiting ~3 days for store review; only the
extension-side bridge goes through review. Architectural consequence we honor **now**,
cheaply: keep the boundary between UI and extension capabilities a thin, stable, typed
message protocol (`messages.ts`, §2.3). If the UI later moves into an iframe, the same
protocol runs over `postMessage` and the reviewed surface stays frozen while the UI
iterates. Trade-offs to weigh at that point: privacy story changes (UI assets load from a
remote origin — telemetry/asset hosting must be squeaky clean even if Confluence data
never leaves the browser), offline behavior, and CSP/frame wiring. Candidate trigger:
Phase 3 agent chat UI (CopilotKit), where UI iteration speed matters most.

### 2.3 Extension surfaces and message protocol

```
apps/extension/
  wxt.config.ts           # WXT config: manifest fields (§ below), React module
  entrypoints/
    background.ts         # service worker: routing, offscreen lifecycle mgmt
    sidepanel/
      index.html
      main.tsx            # React panel entry
    offscreen/
      index.html
      main.ts             # WASM host (typst.ts lives here from 005 on)
  utils/
    messages.ts           # typed message protocol (discriminated unions)
  package.json            # name: @atlcli/extension, private (wxt, react deps)
  tsconfig.json           # extends WXT's generated config
```

WXT generates `manifest.json` from `wxt.config.ts`; the following fields are **normative**
regardless of generator (asserted by the Task 2 test against the built output):

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
- Turbo: `build` task for `apps/extension` with `.output/**` outputs; depends on `^build`.
- Isomorphism gate: shared packages stay covered by `scripts/check-browser-build.ts`
  (001). The extension bundle itself is built by Vite, so Task 6 adds an **output scan**
  over `.output/chrome-mv3/**/*.js` asserting zero `node:`/`bun:` specifiers — same
  belt-and-suspenders idea, applied to the WXT artifact.
- Typecheck: extension workspace typechecks via its own `tsc --noEmit` (WXT-generated
  config, `@types/chrome` via WXT); wired into the root `typecheck` flow through Turbo so
  CI covers it.

---

## 3. Task breakdown (ordered)

> AC = acceptance criteria, each objectively checkable. Tasks marked **[E2E: user]** need
> Björn to load the unpacked extension in Chrome — coordinate before starting those checks.

### Task 1 — Workspace scaffold (WXT + React)

- [ ] `apps/extension` scaffolded with WXT (React module) per §2.3 layout; `package.json` (`@atlcli/extension`, private) with deps on `@atlcli/core`, `@atlcli/confluence`
- [ ] `wxt.config.ts` declares the §2.3 manifest fields; background/sidepanel/offscreen entrypoints exist
- [ ] `bun run --cwd apps/extension build` (`wxt build`) exits 0; `.output/chrome-mv3/` contains manifest.json, background, sidepanel, offscreen assets
- [ ] `wxt` dev mode starts (`bun run --cwd apps/extension dev`) — dev-loop for later E2E sessions
- [ ] Turbo `build` task wired; root `bun run build` still green; extension typecheck wired into CI

### Task 2 — Manifest + CSP correctness

- [ ] `manifest.json` matches §2.3 (MV3, side_panel, offscreen, storage, tabs, host_permissions `*://*.atlassian.net/*`, CSP with `wasm-unsafe-eval`)
- [ ] A manifest validation test parses `.output/chrome-mv3/manifest.json` and asserts the normative fields (guards against WXT config/upgrade regressions)
- [ ] No `unsafe-eval` (only `wasm-unsafe-eval`) — asserted by the same test

### Task 3 — Message protocol + service worker

- [ ] `messages.ts` defines the typed protocol (`ping`, `wasm-smoke` at minimum) with request/response pairing (correlation id or `chrome.runtime.sendMessage` response callback)
- [ ] `background.ts` handles `ping` → `pong`; unit test for the pure router logic (extract routing into a testable function — functional core, imperative shell)
- [ ] `ensureOffscreen()` implemented: creates the offscreen document once, reuses it, survives double-invocation (unit test with mocked `chrome.offscreen`)

### Task 4 — Side panel skeleton

- [ ] Side panel renders: extension name/version, a status line ("no Atlassian page detected" placeholder for 003), and a "Ping" debug button that round-trips through the service worker and displays `pong`
- [ ] Panel opens via the extension action click (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`)
- [ ] React panel (decision F1); no inline scripts (MV3 CSP forbids them) and **no remote-loaded UI/iframes** — all JS from bundled files

### Task 5 — Offscreen WASM smoke test

- [ ] Offscreen document loads and instantiates a minimal inline WASM module (e.g. a hand-written 8-byte-plus add function, no external dependency) on receiving `wasm-smoke`, returns the computed result
- [ ] Side panel debug section triggers `wasm-smoke` end-to-end: panel → SW → offscreen → SW → panel; result rendered
- [ ] Failure path: if WASM instantiation throws, the error message (not a hang) reaches the panel

### Task 6 — CI gate extension

- [ ] Output scan over `.output/chrome-mv3/**/*.js`: zero `node:`/`bun:` specifiers, zero references to remote script origins (script/`import` from http(s) URLs) — wired as a post-build check in CI
- [ ] Negative proof: seeding `node:os` into an entrypoint fails the scan naming the file (fixture test, same spirit as 001 Task 6)
- [ ] Shared packages remain covered by the existing `bun run check:browser` (unchanged)

### Task 7 — Manual E2E: load unpacked **[E2E: user]**

Joint session — I cannot drive Björn's Chrome:

- [ ] `chrome://extensions` → Load unpacked → `apps/extension/.output/chrome-mv3` loads with **zero errors/warnings** on the extensions page
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
4. **Second toolchain (Vite via WXT) in a Bun-pure repo.** Accepted cost of the WXT decision; contained inside `apps/extension`. Watch for Bun-workspace/Vite resolution quirks when importing `@atlcli/*` source packages — if the browser `exports` condition isn't picked up by Vite automatically, configure `resolve.conditions` explicitly (note for Task 1).
5. **Large static assets (005: WASM + fonts) under WXT/Vite** need the `public/` passthrough rather than module imports — flagged here so 005 doesn't fight the bundler.

### Decisions log

- **F1 — panel UI stack**: ✅ (Björn, 2026-07-14) React (WXT React module); motivation: future agent-chat UI (Phase 3) with CopilotKit-UI as candidate. No remote-iframe UI **in the PoC**; the sandboxed-iframe remote-UI option (daily deploys without store review) is documented in §2.2 for a later phase — the typed message protocol is deliberately designed to survive that move.
- **F2 — build tooling**: ✅ (Björn, 2026-07-14) WXT as core framework; plain-bun-build alternative rejected.
