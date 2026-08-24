# @atlcli/extension

Chrome extension (Manifest V3) workspace for atlcli — spec
`002-extension-workspace`. It detects Atlassian pages, exports Confluence
content to DOCX and PDF, and includes a bounded Jira + Confluence research
spike. The extension owns Chrome/session policy, IndexedDB template and job
stores, background/offscreen routing, browser downloads, and UI. Reusable
format behavior lives in `@atlcli/docx`, `@atlcli/pdf`, and the browser-only
`@atlcli/pdf-compiler-browser` package.

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
  confluence-rovo.content/
                      # page-local Rovo visibility preference + scoped CSS
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
  research-agent.ts    # DeepAgentsJS + QuickJS PTC in a fresh worker per run
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

Dev GitHub prereleases also contain a packaged
`atlcli-extension-chrome-mv3-<dev-tag>.zip`. Verify it against the release's
`checksums.txt`, extract it, and select the extracted directory containing the
root `manifest.json` with **Load unpacked**. This is a developer-sideload
artifact, not a click-installable Chrome Web Store package; it has no Web Store
auto-update.

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

## Kiteweave AI: Chat and Research

The AI workspace has two separate agent runtimes:

- **Chat** answers ordinary questions and follow-ups. **Automatic** chooses the
  bounded strategy, **Quick** prioritizes latency, and **Think deeper** may use
  a short supervisor workflow with focused subagents. It does not execute the
  long Deep Research graph.
- **Research** is the explicit long-running mode for broader, cited Jira and
  Confluence investigation and a downloadable Markdown report.

The fixed synthetic release gate targets a maximum 120-second median and a
180-second worst-of-three for a two-source **Think deeper** Chat. Simple attached
pages stay on the direct path and are normally much faster. Provider and
Atlassian latency can vary; the UI continues to stream user-facing progress and
always keeps **Stop** available. Research keeps its separate, up-to-ten-minute
report workflow and is never selected merely because Chat uses **Think deeper**.

Provider routing is an adapter concern rather than a Chat behavior. The current
Anthropic adapter uses one model ID and a bounded non-thinking finalization
corridor for drafting, repair, and synthesis. Run diagnostics expose only safe
aggregate counts by effective route and never prompts, source text, URLs,
credentials, or hidden reasoning.

Both modes bind an attached page directly by its ID. Jira is added only when
the question, an explicit context, or a Jira reference discovered in the page
requires it. Chat and Research share read-only capability contracts, but Chat
never falls through to the Research runtime.

The Research spike creates one cited Markdown report from bounded, read-only
Jira and Confluence searches. It uses `claude-sonnet-4-6` through
DeepAgentsJS. The central supervisor composes a question-specific workflow
from a bounded declarative subagent catalog; retrieval subagents can call only
the granted Jira search/detail and Confluence search/detail capabilities
through `@langchain/quickjs`.

1. Open a Jira or Confluence page on the Atlassian Cloud site you want to
   research, then open the extension side panel.
2. Select **Chat** or **Research**.
3. Enter an Anthropic API key under **Settings → AI**. Session-only storage is
   the default and is cleared when Chrome or the extension restarts. Optional
   **Remember on this device** stores the key in this Chrome profile until it
   is forgotten or the extension is removed. Both storage areas are restricted
   to trusted extension pages and workers; websites and content scripts cannot
   read the key. **Forget key** removes both copies immediately.
4. Enter a question. Name the Jira project key and Confluence space key in the
   question, or fill the two explicit key fields. Explicit fields are locked;
   the detected current Jira/Confluence context is a separate removable seed
   and cannot replace them.
5. Optionally select **From** and **To**, review the resolved site and limits,
   and confirm the disclosure.
6. Send the Chat message or select **Run research**. Use the visible stop
   control to terminate the active worker. A stopped turn remains resumable at
   its last safe durable checkpoint.
7. Review **Formatted** or **Raw Markdown**, then copy or download the `.md`
   result.

The key and Atlassian session never enter QuickJS. QuickJS has no `fetch`,
Chrome, filesystem, shell, raw JQL/CQL/GraphQL, write tools, or persistent
memory. The supervisor sandbox can dispatch only the declared bounded task
roles; retrieval sandboxes receive only their allowlisted read capabilities.
Search cursors and detail references are opaque, run-scoped host values.
Jira/Confluence content selected for the report is sent to Anthropic only after
the disclosure is confirmed.

The report contract is structured data with a deterministic Markdown
projection. Markdown is the portable hand-off for a later DOCX/PDF adapter;
this spike does not yet connect it to the export engines.

## Checks

```bash
bun run --cwd apps/extension typecheck     # wxt prepare && tsc --noEmit
bun run --cwd apps/extension check:output  # scan built bundle for leaks
bun run --cwd apps/extension test:research-extension-browser:prebuilt
```

The repository-level `bun run check:browser-export-harness` and
`bun run test:browser-export-harness` commands prove the reusable DOCX/PDF package contracts in
an independent production Vite/Chromium host.

### Parallel packed-browser checks

Build the production artifacts once, then run either the complete local
orchestrator or one fixed lane:

```bash
bun run build:browser-export-harness
bun run build:extension

# Performance-sensitive checks first; long jobs/research checks then overlap.
ATLCLI_BROWSER_EVIDENCE_ROOT="$PWD/.artifacts/browser-evidence" \
  bun scripts/ci/run-browser-lanes.ts

# Useful when separate worktrees or homelab workers own separate lanes.
ATLCLI_BROWSER_EVIDENCE_ROOT="$PWD/.artifacts/browser-evidence-jobs" \
  bun scripts/ci/run-browser-lane.ts jobs
```

The fixed lanes are `neutral-palette`, `research-worker-rovo`, and `jobs`.
Give every concurrently running worktree or worker its own evidence root; the
default is already worktree-local, but an explicit path makes the ownership
visible. Local and homelab runs enforce the palette latency budget by default.
Set `ATLCLI_BROWSER_ASSERT_TIMING=0` only on an uncontrolled shared runner;
functional, network-isolation, long-task, and bundle-size checks still run.

Each suite writes JUnit, a summary, and a SHA/run/digest-bound manifest. Passed
suites discard browser media. Failed suites retain an opaque test directory
with a Playwright trace plus screenshots and videos. GitHub CI builds the
browser artifacts once and fans the three lanes out to separate runners. It
uploads evidence only after the synthetic-evidence validator has rejected live
tenant data, credentials, private paths, unsafe archives, and unexpected files.

Live Atlassian-account checks are intentionally outside GitHub CI and its
artifact publication path. Run those only on an authorized local or homelab
worker, keep profiles and captures outside Git, and clean up created tenant
resources after the run.

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
- The optional **Hide Rovo controls** preference is applied by a narrow,
  isolated-world content script on `https://*.atlassian.net/wiki/*`. It reads
  only extension-local settings, injects no remote code, and changes no page
  content beyond a reversible visibility attribute owned by Kiteweave.
- The **UI ↔ extension-capability boundary is the typed message protocol**
  (`utils/messages.ts`). Large source and result bytes remain in the extension's job store;
  messages carry bounded control data.
- DOCX and PDF are separate engines. They share Confluence `ExportBlock[]`, not a generic
  export engine, runner, report, or output sink.
