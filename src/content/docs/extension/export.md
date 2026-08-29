---
title: "Exporting from the panel"
description: "Scope selection, template sets, document settings, PDF preview and background exports in the atlcli side panel"
---

# Exporting from the panel

This is the walkthrough for the extension's **Export**, **Preview**, **Template
sets** and **Activity** sections. Every step here has a
[CLI equivalent](/confluence/export/) except document settings and preview,
which the CLI does not expose yet.

## On this page

- [Prerequisites](#prerequisites)
- [Export a single page](#export-a-single-page)
- [Export from the action palette](#export-from-the-action-palette)
- [Choosing what to export](#choosing-what-to-export)
- [Label filters](#label-filters)
- [Dynamic macros](#dynamic-macros)
- [Document settings (PDF)](#document-settings-pdf)
- [Image quality (PDF)](#image-quality-pdf)
- [Code themes](#code-themes)
- [Word templates](#word-templates)
- [Preview](#preview)
- [Background exports](#background-exports)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- The extension [installed and loaded](/extension/) in Chrome 140+.
- A Confluence Cloud page open in the active tab, in a session you are logged
  in to.
- For Word export: a `.docx` template, or none — the engine falls back to a
  bundled default.

## Export a single page

1. Open the Confluence page.
2. Click the atlcli toolbar button to open the side panel. The **Export**
   section shows the page title, space, version, last-modified date, word count
   and attachment list.
3. Click **Export to PDF** or **Export to Word**.
4. The file downloads as `<page title>.pdf` / `<page title>.docx`.

That is the whole default path. The scope defaults to the current page, macro
resolution is on, and every other control is behind a closed **Advanced**
disclosure — opening the panel and clicking Export is as few interactions as it
has ever been.

While a PDF export runs, the button area names the phase it is in: *Preparing
content → Fetching attachments → Queued for PDF compiler → Compiling PDF →
Validating PDF → Downloading*. When it finishes, a report line summarises images
and diagrams and breaks the time down into prepare / compile / download, so an
image-heavy page is distinguishable from a slow compile without turning on debug
logging.

## Export from the action palette

For the current published Confluence page, the palette is the shortest path to
the same durable export queue:

1. Invoke the configured palette shortcut on the page.
2. Search for `pdf` or `docx` and press `Enter` on the selected action.
3. Close the palette if you want; submission and progress remain in
   **Activity**.
4. Open **Activity** from the palette or side panel to inspect and download the
   artifact.

PDF uses the current saved publishing preferences. DOCX queues only when a
valid template resolves; otherwise the result opens **Publishing** so you can
choose or upload one. Use the full panel for tree/space scope, label filters,
document settings, template management, and preview. Jira shows these
Confluence-only actions as unavailable with a reason.

See [Atlassian action palette](/reference/action-palette/) for shortcut
remapping, Forge modal delegation, and the full host capability matrix.

## Choosing what to export

**What to export** offers three scopes. It is shared by both engines, so PDF and
Word can never disagree about what "the export" covers.

| Option | Meaning | CLI equivalent |
|--------|---------|----------------|
| **Current page** | Just this page | `--scope page` (default) |
| **Page + children** | This page and its descendants, as one document with chapters | `--scope tree` |
| **Entire space** | The whole space, rooted at its homepage | `--scope space --space <KEY>` |

**Entire space** is disabled — with the reason shown — when the page reports no
space key.

Under **Advanced**:

- **Levels below this page** bounds how deep the walk goes. The current page is
  level 0. (CLI: `--max-depth`.)
- **Include this page itself** decides whether the root page becomes a chapter
  or only a container.

A tree or space export always produces **one** document with the page hierarchy
as chapter levels — never one file per page.

### The space-export confirmation

Choosing **Entire space** and exporting asks first: *"Export the whole space
DOCSY?"* with the page count when the host can count it, and count-free wording
(*"Every page in DOCSY will be exported. This can take a while."*) when it
cannot. The confirmation exists because a whole-space export is the one action in
the panel whose cost is not obvious from the button.

## Label filters

Two fields under **Advanced** curate the result. Both accept a comma- or
whitespace-separated list; entries are trimmed, de-duplicated, and shown as
removable chips.

| Field | Rule | CLI equivalent |
|-------|------|----------------|
| **Only pages with these labels** | A page is kept when it carries **any one** of them. Empty means every page. | `--label-include` |
| **Skip pages with these labels** | A page is skipped when it carries **any one** of them. | `--label-exclude` |

**What an excluded page takes with it** decides the blast radius:

- **The page and its children** (default) — excluded pages take their subtree,
  even when the children carry no label. (`--label-exclude-mode prune-subtree`)
- **Only the page itself** — children of an excluded page are still exported.
  (`--label-exclude-mode page-only`)

If an include filter matches nothing, the export stops rather than producing an
empty document. See [Troubleshooting](#troubleshooting).

## Dynamic macros

**Resolve dynamic macros (contacts Jira/Confluence)** is on by default. It
controls the *live* renderers — issue tables, diagram images, includes,
`export_view` fallbacks.

- **On:** issue tables and rendered macro content are fetched while exporting.
- **Off:** nothing extra is fetched, dynamic macros become placeholders, and the
  export is deterministic.

Pure renderers (table of contents, excerpts, table layout) run either way.
Turning the toggle off is the panel's equivalent of the CLI's
`--no-live-macros`, and — exactly like the flag — it is **not** an offline mode:
the page body and its own attachments still load.

See [Macro compatibility](/confluence/macro-compatibility/) for what each macro
does in each engine.

## Document settings (PDF)

**Document settings** configures the built-in PDF design. This is the one
capability the panel has and the CLI does not: a CLI PDF export always produces
the default document.

| Group | Settings |
|-------|----------|
| Layout | Page size (A4 / Letter), orientation, cover page on/off, table of contents on/off |
| Branding | Header text, footer text, organisation, accent colour, logo (PNG or SVG) with alt text |
| Watermark | Watermark text, colour, opacity, angle, size |

Constraints are enforced next to the field — text at 200 characters, watermark
opacity in `(0, 1]`, angle in `-180..180`, size in `8..400` points, a logo at
most 5 MB. The panel's checks are a courtesy: the engine validates independently
and **rejects rather than clamps**, before any attachment is fetched, so a bad
value fails immediately instead of after a two-minute export. The full reference
— types, defaults, and exactly what each setting changes in the rendered
document — is [PDF Template Settings](/reference/pdf-template-settings/).

A logo always needs alt text. That is not a style rule: a meaning-bearing image
with no alternative text is rejected by the engine, because the produced PDF is
tagged and an untagged image would be invisible to assistive technology.

Settings are remembered per **site, engine and space**, so a space you brand one
way stays branded that way, and another space on the same site is unaffected.
**Reset to defaults** restores the built-in design.

## Image quality (PDF)

The PDF form's **Image quality** selector chooses how raster attachments are
embedded: **Original** (unchanged bytes, the default), **Standard (180 PPI)**,
or **Print (300 PPI)**. Standard and Print downscale large images to their
rendered size before the PDF engine decodes them, which lowers the browser's
peak memory on image-heavy trees and shrinks the file; transparency stays
lossless and images are never upscaled. Choosing Standard or Print reveals an
optional **PPI** field (`72–1200`) for an exact density — useful on a
well-equipped machine that can afford higher fidelity. The choice is pinned
into the durable job, so Retry and Run again render with the same quality. The
CLI equivalents are `--pdf-images` and `--pdf-images-ppi` (see
[DOCX and PDF Export](/confluence/export/#image-quality-profiles)).

:::note[How browser memory is bounded]
For Standard and Print, the extension prepares supported PNG/JPEG assets in a
short-lived image worker and disposes it before the PDF compiler starts.
Unsupported image shapes remain unchanged, and a browser-native decode failure
restarts the complete prepare once through the deterministic fallback. This is
automatic: **Original** still starts no image worker, and there is no decoder
setting to manage. The image-quality profile remains the main control for peak
memory on large trees.
:::

## Code themes

The **Code theme** selector is shared by PDF preview, PDF export, Word export,
and background retries. It contains the full theme catalogue bundled by the
pinned Shiki version and defaults to **GitHub Light**. Theme choices are stored
with the other per-space publishing preferences.

A dark choice changes both token colours and the code-block background in PDF
and DOCX; it does not recolour the rest of the document. Preview and final PDF
use the same resolved theme. Completion reports show the exact stable theme ID,
which is useful when comparing an interactive export with CLI or CI output.

For automation, pass the same ID as `--code-theme <id>` to either CLI export
format. See [Syntax-highlighting themes](/confluence/export/#syntax-highlighting-themes)
for examples and fallback behavior.

:::note[Word templates do not take settings]
A Word template that declares settings shows them **for information only**, with
a line saying so. The Word engine has no settings input to apply them to, and the
panel deliberately does not send one — promising configuration the engine cannot
honour would be worse than saying it plainly.
:::

## Word templates

The **Template sets** section manages `.docx` templates as named entries, each
either **Global** or scoped to one space. See
[Export template library](/confluence/export-templates/) for the model; the
panel-side mechanics are:

1. Upload a `.docx` (20 MB maximum). The panel scans it and reports which
   `$scroll.*` placeholders are supported, which will be emptied, and whether
   `$scroll.content` was found.
2. **Use this one** makes an entry the global default. **Use in `<SPACE>`**
   scopes it to the space of the page you are on — a space entry beats the
   global one for pages in that space.
3. **Check** re-hashes the stored bytes against the entry's recorded digest.

A failed integrity check is a hard error with a single remedy — re-upload. There
is no silent fallback to another template, because exporting through a template
you did not choose is worse than not exporting.

Templates are isolated per Atlassian site, so two sites that both have a space
called `DOCSY` never see each other's entries.

The browser panel has no PDF-template upload yet: it uses the built-in atlcli
document design, configured through [Document settings](#document-settings-pdf).
The CLI can consume reviewed `.wiki-pdf-template` packs; see
[Create a PDF template from Word](/confluence/pdf-template-from-word/).

## Preview

**Preview** compiles the PDF and lets you page through it before downloading.

- Preview is **opt-in**. Click **Generate preview**, or turn on **Update
  automatically** — which is **off by default**, so a plain export never waits
  for a preview compile.
- Page back and forth with **‹** / **›**, zoom with **−** / **+**, and use the
  middle button to go back to **Breite anpassen / Fit width**. That button is
  greyed out while the page already fits — it is not a full-screen control.
- When the document has a table of contents, its entries are clickable in the
  preview and jump to the linked page. The downloaded PDF carries the same
  internal links.
- **Open large preview** mounts the same view full-size in its own tab, over the
  same compiled bytes. There is no second renderer and no second compile, and
  the panel stays usable while the tab is open.
- The preview *is* the export pipeline with the download swapped for a capture,
  so what you preview is what you download — literally the same bytes, reused.

### Previews show the published page

:::caution[The preview renders the last **published** version]
It does not render unsaved editor changes. The supported loop is **edit →
publish → preview**. The panel states this above the viewer; it is repeated here
because it is the single most common surprise.
:::

### Tree and space previews are truncated

A **Current page** preview compiles the whole document. A tree or space preview
compiles the **first 5 chapters** and is labelled *"Preview — first 5 of 42
chapters"*.

The label says *chapters*, never *pages*, and that distinction is real: the PDF
page count only exists after compiling, and one dense source page can become
many PDF pages. Truncation happens on the fetched pages before they are composed,
so the count is exact rather than estimated. Two backstops bound a single
pathological chapter (600 blocks, 16 MiB of estimated assets), so an enormous
first chapter cannot make the "quick" preview slow.

A truncated preview cannot be downloaded — the bytes are a prefix of the
document, not the document. **Download** compiles the whole thing.

## Background exports

A tree or space export takes minutes. You do not have to sit with it.

**Activity** lists running and finished exports with their status — *Queued*,
*Compiling…*, *Page 12/57*, *Ready*, *Failed*, *Cancelled* — and how long ago
each one ran. Filters cover the current/all sites, PDF/DOCX, status, and time
range. Open a detail to see stages, counters, report issues, and the bounded
operational protocol. From there you can cancel, download, retry, run a
successful export again, resume an authentication-blocked job after signing in,
mark it as read, or dismiss terminal history.

What "background" means here, precisely:

> Exports keep running while Chrome is open, even when you browse elsewhere or
> close the panel. If Chrome quits, work pauses; its durable queue and
> checkpoints are resumed on the next browser start.

That covers navigating to another page, closing the side panel, and Chrome
restarting the extension's service worker or offscreen document. It does **not**
mean that code runs while Chrome itself is closed: there is no server side. If
the browser session expired in the meantime, Activity shows **Resume after
sign-in** instead of discarding the job.

Every export gets an Activity row. The toolbar badge shows the number of
unfinished jobs, capped at `9+`. With no active job it shows `✓` for unread
success or `!` for unread failure; opening Activity alone does not clear it.
Viewing the detail, downloading, or **Mark as read** acknowledges the result.
The short completion/failure colour pulse is optional under Activity; the static
badge and persisted row remain the source of truth.

**Retry** is available for failed, interrupted, or cancelled jobs. **Run again**
is available for successful jobs. Both create a linked new row and preserve the
original history; neither rewrites the old job.

Succeeded artifacts that have not been downloaded remain protected. Once
downloaded or dismissed, artifact bytes are retained for at least 24 hours.
Full reports/events remain for 7 days. Compact history is the intersection of
the newest 100 jobs and jobs younger than 30 days. See
[Export Jobs & Operations](/reference/export-jobs/) for the storage budgets and
cleanup contract.

## Examples

### Minimal: this page as a PDF

1. Open the page → open the panel → **Export to PDF**.

No scope, no settings, no template. The built-in design produces a cover,
computed table of contents, running header, page-number footer, callouts,
syntax-highlighted code, tables, images and vector diagrams.

### Advanced: a branded handbook, minus the internal pages

1. Open the handbook's root page.
2. **What to export** → **Page + children**.
3. **Advanced** → **Skip pages with these labels**: `internal, draft`. Leave
   **What an excluded page takes with it** on *The page and its children*.
4. **Document settings** → set **Organisation**, upload a **Logo** with alt
   text, set **Accent colour**, and put a disclaimer in **Footer text**.
5. **Preview** → **Generate preview** and check the first chapters.
6. Back on **Export**, click **Export to PDF**, then carry on browsing —
   **Activity** will hold the result.

The CLI equivalent of steps 1–3 is one command; steps 4–5 have no CLI form yet:

```bash
atlcli wiki export <pageId> --format pdf --scope tree \
  --label-exclude internal,draft --output ./handbook.pdf
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| **My change isn't in the preview** | The preview renders the last **published** version, not the open editor draft | Publish the page, then refresh the preview |
| **My export stopped when Chrome closed** | The queue is local; no code runs while Chrome is fully closed | Start Chrome again. The job resumes from its last durable checkpoint; sign in and choose **Resume after sign-in** if Activity reports an authentication wait |
| The toolbar still shows `✓` or `!` | Opening Activity does not acknowledge terminal work | Open the job detail, download it, or choose **Mark as read** |
| **Retry** or **Run again** created another row | Replay is append-only by design | Inspect the linked new row; the original remains immutable history |
| The middle zoom button does nothing | It is **Fit width**, not full screen, and it is disabled while the page already fits | Zoom in or out first; for a bigger view use **Open large preview** |
| The preview stops after a few chapters | A tree/space preview is capped at the first 5 chapters by design | Nothing to fix — **Download** compiles the whole document |
| **Download** is unavailable on a preview | A truncated preview's bytes are a prefix, not the document | Use **Export to PDF**, which compiles all of it |
| No page matched the include filter | The include labels match no page in scope | Widen or remove **Only pages with these labels**; check the labels on the pages |
| "Template exceeds the 20 MB limit" | The uploaded `.docx` is over the cap | Slim the template — usually an embedded image |
| "That file isn't a valid .docx (not a zip)" / "That zip isn't a Word document" | The file is not a real `.docx` | Re-save it from Word as `.docx` (not `.doc`, not `.dotx`) |
| "The stored template could not be read. Please upload it again." | The stored bytes no longer match their recorded digest | Re-upload the template |
| The export fails naming several large images | The 50 MB per-export asset budget was exceeded; the message names the largest offenders | Narrow the scope, or remove/downscale the named attachments |
| A Word export shows literal `{{ title }}` | A retired Jinja/docxtpl template was used; this engine fills `$scroll.*` only | Use a Scroll-style template — see [Rendering runtime](/confluence/export/#rendering-runtime) |
| Compilation times out | A single compile is capped at 60 seconds | Narrow the scope; very large trees are better suited to the CLI |

## Related topics

- [Browser extension](/extension/) — install, limits, and what leaves your
  browser
- [Atlassian action palette](/reference/action-palette/) — queue an export from
  the current page without opening the full panel
- [DOCX and PDF Export](/confluence/export/) — the same engines from the CLI
- [Export template library](/confluence/export-templates/)
- [Macro compatibility](/confluence/macro-compatibility/)
- [PDF Template Settings](/reference/pdf-template-settings/) — the full settings
  reference
- [Export Jobs & Operations](/reference/export-jobs/) — queue lifecycle,
  retention, recovery, and diagnostics
- [Labels](/confluence/labels/) — managing the labels the filters read
