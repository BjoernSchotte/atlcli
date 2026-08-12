---
title: "Browser extension"
description: "What the atlcli side panel does, how to install it, and how it relates to the CLI"
---

# Browser extension

The atlcli browser extension is a Chrome side panel that exports the Confluence
page you are looking at — to PDF or to Word — **without sending the page to an
export service**. It runs the same export engines the CLI runs, in your browser,
using the Confluence session you are already logged in with. The separate,
optional AI workflow contacts the configured provider only after disclosure and
explicit submit.

Use the panel when the export is a one-off and you want to see the result before
you commit to it. Use the [CLI](/confluence/export/) when the export is a
repeatable job.

## On this page

- [Prerequisites](#prerequisites)
- [Install](#install)
- [What the panel can do](#what-the-panel-can-do)
- [Use the action palette](#use-the-action-palette)
- [Panel vs. CLI](#panel-vs-cli)
- [Where your data goes](#where-your-data-goes)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- **Google Chrome 140 or newer.** The panel uses the MV3 side panel and
  offscreen-document APIs; the manifest declares
  `minimum_chrome_version: "140"`.
- **A Confluence Cloud site** you are logged in to. The extension requests host
  access to `*.atlassian.net` and to `api.media.atlassian.com` (the CDN that
  serves attachment downloads) and to nothing else. Confluence **Data Center**
  is not covered by those host permissions — use the CLI there.
- For a Word export: a `.docx` template, or nothing at all if you are happy with
  the bundled default.

## Install

The extension is not published to the Chrome Web Store yet. Install it from a
local build:

```bash
bun install
bun run --cwd apps/extension build      # → apps/extension/.output/chrome-mv3/
```

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3/`.
3. Click the atlcli toolbar button to open the side panel.
4. Open a Confluence page. The panel picks it up automatically.

After a rebuild, click the **reload** (↻) icon on the atlcli card in
`chrome://extensions`. If you are running the HMR dev server
(`bun run --cwd apps/extension dev`) that step is automatic.

Alternatively, a dev GitHub prerelease provides a verified
`atlcli-extension-chrome-mv3-<dev-tag>.zip`. Download its `checksums.txt`,
verify and extract the ZIP, then choose the extracted directory with **Load
unpacked**. See [Development releases](/reference/dev-releases/#install-the-packaged-browser-extension).

:::caution[No Web Store auto-update]
The release ZIP is for developer sideloading. It is not click-installable and
does not receive Chrome Web Store auto-updates. Updating requires a new verified
ZIP and a reload from `chrome://extensions`.
:::

## Use the action palette

The action palette is the fast keyboard surface for actions that do not need
the full panel. On an Atlassian Cloud tab, press `Ctrl+Shift+K` on
Windows/Linux or `Command+Shift+K` on macOS, search, move with the arrow keys,
and press `Enter`. Chrome owns the effective shortcut and may leave it unbound.

To inspect or remap it, open **Settings** → **Action palette shortcut** →
**Open Chrome shortcut settings**, or go directly to
`chrome://extensions/shortcuts`. The Settings screen and palette footer show
the assignment Chrome actually reports.

From the palette you can queue current-page PDF/DOCX exports, open Publishing
or Activity, jump to the full sidebar, and explicitly submit a bounded Quick AI
question from a Confluence page or Jira issue. The sidebar remains available
for scopes, templates, preview, durable activity, detailed AI work, and
continuation. See the [Atlassian action palette reference](/reference/action-palette/)
for host differences, keyboard behavior, and privacy boundaries.

## What the panel can do

The panel is a list of **sections** in the left-hand nav. A section whose
prerequisites are unmet stays visible and tells you why, rather than
disappearing.

| Section | What it is for |
|---------|----------------|
| **Export** | Choose what to export and produce a PDF or a Word document. See [Exporting from the panel](/extension/export/). |
| **Preview** | Compile the PDF and page through it before downloading. Opt-in — nothing compiles until you ask. |
| **Template sets** | Named Word templates with global or per-space scope. See [Export template library](/confluence/export-templates/). |
| **Activity** | Running and finished exports, so a long export is something you can walk away from. |
| **Settings** | Panel language (English/German, or follow the browser) and an optional browser-local switch that hides the top and bottom-right Rovo entry points on Confluence pages. Exported documents keep the page's own language. |
| **About** | Version, host, and which capabilities this host advertises. |

The palette is not another persistence system. PDF/DOCX submissions enter the
same durable **Activity** queue, and Quick AI continues through the existing
**Research** surface.

## Panel vs. CLI

Both hosts drive the same engines (`@atlcli/confluence` → `@atlcli/docx` /
`@atlcli/pdf`), so a page exports the same way in both. What differs is what
each host has wired up:

| Capability | Panel | CLI |
|-----------|-------|-----|
| PDF export | Yes | `--format pdf` |
| Word export | Yes | TypeScript engine (default; `--engine ts` is optional) |
| Page / tree / space scope | Yes | `--scope page\|tree\|space` |
| Label include/exclude filters | Yes | `--label-include` / `--label-exclude` |
| Dynamic macro resolution on/off | Yes (a toggle) | `--no-live-macros` |
| **PDF document settings** (page size, cover, header/footer, accent colour, logo, watermark) | **Yes** | **No** — not exposed as flags yet |
| **PDF preview before download** | **Yes** | **No** — there is nothing to preview in a headless run |
| **Background exports you can leave and come back to** | **Yes** | Foreground process with a durable journal; no detached daemon |
| Two-level (global + per-space) template library | Yes | No — the CLI resolves templates by [file path precedence](/confluence/export/#template-resolution) |
| Machine-readable report + classified exit codes | No | `--json` / `--report json` |
| `--keep-ignored` debugging passthrough | No | Yes |
| Scriptable, headless, CI | No | Yes |

The two "No" rows on the CLI side are the honest ones to know about: **PDF
settings and preview are panel-only today.** A CLI PDF export always produces
the default document design. If you need a branded PDF from CI, that is not yet
possible from flags.

## Where your data goes

Exports stay in the browser. Optional AI calls are the explicit exception, so
it is worth stating both paths precisely:

- **The compile is local.** The Typst compiler, its WebAssembly module, and
  every font are bundled with the extension and run in an offscreen document in
  your browser. There is no rendering service.
- **Network access is limited by the manifest** to the Atlassian site you are on
  and to `api.media.atlassian.com` for authenticated attachment redirects.
  The only additional host is `api.anthropic.com`, used by the optional AI
  workflow after explicit submit. Opening or searching the palette causes no
  provider request.
- **The content security policy forbids remote code.**
  `script-src 'self' 'wasm-unsafe-eval'` — no CDN, no inline scripts, no
  string-to-code constructors. A build-time scan over the packed output enforces
  it.
- **The Rovo visibility switch is local and reversible.** A bundled content
  script reads only the extension's own preference record and toggles one
  Kiteweave-owned marker on the Confluence document. It does not read, transmit,
  or rewrite page content.
- **External images are not fetched.** An image hosted outside your Atlassian
  site is exported as a readable fallback with a note, not silently downloaded.
- Bytes in flight live in your browser's IndexedDB. Succeeded artifacts that
  have not been downloaded remain protected. After download or dismissal,
  artifact bytes are retained for at least 24 hours; full reports for 7 days;
  compact history is bounded to the newest 100 jobs younger than 30 days.

## Limits

| Area | Limit |
|------|-------|
| Word template upload | 20 MB, `.docx` only |
| Embedded assets | 25 MB per file, 50 MB per export |
| One persisted spool object | 128 MiB |
| One job's persisted spool | 256 MiB |
| All common job spool data | 512 MiB |
| Final DOCX/PDF artifact | 64 MiB |
| Artifact/report/history retention | 24 hours after delivery/dismissal / 7 days / newest 100 younger than 30 days |
| Compiler timeout | 60 seconds per compile |
| Tree/space preview | First 5 chapters (see [Preview](/extension/export/#preview)) |
| Datasource tables | 100 rows |

Chrome's origin quota can be lower than a product cap. The runner checks
available storage and waits or fails with a named quota reason instead of
starting a render it cannot safely persist.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No Atlassian page detected" | The active tab is not a Confluence page | Open a Confluence page or blog post in the tab, then reopen the panel |
| "You don't appear to be logged in to this Atlassian site" | The panel uses your browser session and there isn't one | Log in to the site in that tab and click **Retry** |
| "Detected Jira issue …. Nothing to export here yet" | Jira content is recognised but not exportable | Open a Confluence page |
| The panel never appears on a Data Center site | The manifest grants host access to `*.atlassian.net` only | Export from the [CLI](/confluence/export/) instead |
| A section is greyed out | That section's requirement is unmet; the entry says which | Open a Confluence page, or read the stated reason |
| Nothing changed after a rebuild | Chrome is still running the previous unpacked build | Click **reload** (↻) on the atlcli card in `chrome://extensions` |
| The palette shortcut does nothing | Chrome left it unbound or another command owns the chord | Open **Settings** → **Action palette shortcut**, then assign an available chord in Chrome |
| Quick AI is unavailable | The tab has no supported current page/issue or no provider key is configured | Open a Confluence page or Jira issue and configure the key in **Settings** |

## Related topics

- [Exporting from the panel](/extension/export/) — the full walkthrough
- [Atlassian action palette](/reference/action-palette/) — shortcuts, actions,
  Quick AI, Forge differences, and contribution boundary
- [DOCX and PDF Export](/confluence/export/) — the CLI path, same engines
- [Export template library](/confluence/export-templates/) — global and
  space-scoped templates
- [Macro compatibility](/confluence/macro-compatibility/) — what each macro does
  in each engine
- [PDF Export Engine](/reference/pdf-engine/) — the compiler, assets, and
  verification
- [Export Jobs & Operations](/reference/export-jobs/) — lifecycle, recovery,
  retention, and diagnostics
