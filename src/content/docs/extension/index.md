---
title: "Browser extension"
description: "What the atlcli side panel does, how to install it, and how it relates to the CLI"
---

# Browser extension

The atlcli browser extension is a Chrome side panel that exports the Confluence
page you are looking at — to PDF or to Word — **without sending the page
anywhere**. It runs the same export engines the CLI runs, in your browser, using
the Confluence session you are already logged in with.

Use the panel when the export is a one-off and you want to see the result before
you commit to it. Use the [CLI](/confluence/export/) when the export is a
repeatable job.

## On this page

- [Prerequisites](#prerequisites)
- [Install](#install)
- [What the panel can do](#what-the-panel-can-do)
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
| **Settings** | Panel language (English/German, or follow the browser). Exported documents keep the page's own language. |
| **About** | Version, host, and which capabilities this host advertises. |

## Panel vs. CLI

Both hosts drive the same engines (`@atlcli/confluence` → `@atlcli/docx` /
`@atlcli/pdf`), so a page exports the same way in both. What differs is what
each host has wired up:

| Capability | Panel | CLI |
|-----------|-------|-----|
| PDF export | Yes | `--format pdf` |
| Word export | Yes | `--engine ts` (or `python`) |
| Page / tree / space scope | Yes | `--scope page\|tree\|space` |
| Label include/exclude filters | Yes | `--label-include` / `--label-exclude` |
| Dynamic macro resolution on/off | Yes (a toggle) | `--no-live-macros` |
| **PDF document settings** (page size, cover, header/footer, accent colour, logo, watermark) | **Yes** | **No** — not exposed as flags yet |
| **PDF preview before download** | **Yes** | **No** — there is nothing to preview in a headless run |
| **Background exports you can leave and come back to** | **Yes** | Not applicable — the process is the job |
| Two-level (global + per-space) template library | Yes | No — the CLI resolves templates by [file path precedence](/confluence/export/#template-resolution) |
| Machine-readable report + classified exit codes | No | `--json` / `--report json` |
| `--keep-ignored` debugging passthrough | No | Yes |
| Scriptable, headless, CI | No | Yes |

The two "No" rows on the CLI side are the honest ones to know about: **PDF
settings and preview are panel-only today.** A CLI PDF export always produces
the default document design. If you need a branded PDF from CI, that is not yet
possible from flags.

## Where your data goes

Nowhere. This is the point of the extension, so it is worth stating precisely:

- **The compile is local.** The Typst compiler, its WebAssembly module, and
  every font are bundled with the extension and run in an offscreen document in
  your browser. There is no rendering service.
- **Network access is limited by the manifest** to the Atlassian site you are on
  and to `api.media.atlassian.com` for authenticated attachment redirects.
  Nothing else is reachable.
- **The content security policy forbids remote code.**
  `script-src 'self' 'wasm-unsafe-eval'` — no CDN, no inline scripts, no
  string-to-code constructors. A build-time scan over the packed output enforces
  it.
- **External images are not fetched.** An image hosted outside your Atlassian
  site is exported as a readable fallback with a note, not silently downloaded.
- Bytes in flight (a queued export, a cached preview) live in your browser's
  IndexedDB and are cleared after 24 hours.

## Limits

| Area | Limit |
|------|-------|
| Word template upload | 20 MB, `.docx` only |
| Embedded assets | 25 MB per file, 50 MB per export |
| One export job's bytes | 64 MiB |
| All stored jobs and cached previews together | 128 MiB |
| Job/preview retention | 24 hours |
| Compiler timeout | 60 seconds per compile |
| Tree/space preview | First 5 chapters (see [Preview](/extension/export/#preview)) |
| Datasource tables | 100 rows |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No Atlassian page detected" | The active tab is not a Confluence page | Open a Confluence page or blog post in the tab, then reopen the panel |
| "You don't appear to be logged in to this Atlassian site" | The panel uses your browser session and there isn't one | Log in to the site in that tab and click **Retry** |
| "Detected Jira issue …. Nothing to export here yet" | Jira content is recognised but not exportable | Open a Confluence page |
| The panel never appears on a Data Center site | The manifest grants host access to `*.atlassian.net` only | Export from the [CLI](/confluence/export/) instead |
| A section is greyed out | That section's requirement is unmet; the entry says which | Open a Confluence page, or read the stated reason |
| Nothing changed after a rebuild | Chrome is still running the previous unpacked build | Click **reload** (↻) on the atlcli card in `chrome://extensions` |

## Related topics

- [Exporting from the panel](/extension/export/) — the full walkthrough
- [DOCX and PDF Export](/confluence/export/) — the CLI path, same engines
- [Export template library](/confluence/export-templates/) — global and
  space-scoped templates
- [Macro compatibility](/confluence/macro-compatibility/) — what each macro does
  in each engine
- [PDF Export Engine](/reference/pdf-engine/) — the compiler, assets, and
  verification
