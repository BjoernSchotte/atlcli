---
title: "Export template library"
description: "How atlcli finds the template an export uses: CLI path precedence, the panel's global/space library, integrity checks, and declared settings"
---

# Export template library

An export template decides what the finished document looks like. This page is
about one question: **given a page and an engine, which template does atlcli
use?** — plus what happens when the answer is ambiguous, missing, or no longer
trustworthy.

It covers the CLI and the browser extension side by side, because the two hosts
answer that question differently today and it is better to say so than to imply
a parity that does not exist.

## On this page

- [Prerequisites](#prerequisites)
- [What a template is, per engine](#what-a-template-is-per-engine)
- [Two resolution models](#two-resolution-models)
- [CLI: path precedence](#cli-path-precedence)
- [Panel: global and space scope](#panel-global-and-space-scope)
- [Integrity: templates are verified, never trusted](#integrity-templates-are-verified-never-trusted)
- [Declared settings](#declared-settings)
- [Minimal example](#minimal-example)
- [Advanced example](#advanced-example)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- An authenticated profile (`atlcli auth login`) for the CLI, or the
  [browser extension](/extension/) installed.
- For Word: a `.docx` or `.docm` template. See
  [Scroll Word Exporter compatibility](/confluence/export/#scroll-word-exporter-compatibility)
  for the placeholder vocabulary the DOCX engine fills.

## What a template is, per engine

The word "template" means two different things depending on which document you
are producing, and conflating them is the usual source of confusion.

| Engine | Template | Where it comes from | Configurable without editing it? |
|--------|----------|---------------------|----------------------------------|
| Word (CLI / panel) | A real `.docx` you author in Word — styles, headers, footers, and `$scroll.*` placeholders | You upload or install it | No — the template *is* the design |
| PDF | The **built-in** `atlcli-doc` design (`wiki.pdf-template/v1`) | Bundled — there is nothing to install | Yes — through [settings](/reference/pdf-template-settings/) |

**PDF has no template upload in any host.** The library described below is
therefore, in practice, a Word-template library; the model is engine-aware so
that custom Typst templates can join it later without a second mechanism, but no
render path consumes one yet.

## Two resolution models

| | CLI | Browser panel |
|---|---|---|
| Templates are identified by | A name or a file path | A named entry with a stable id |
| Scoping | Directory precedence (project → profile → global) | `global`, or scoped to one Confluence space |
| Per-space override | No | Yes — a space entry beats the global entry |
| Storage | Files on disk under `~/.atlcli/` and `.atlcli/` | The browser's IndexedDB, isolated per Atlassian site |
| Integrity check | The file is read as-is | SHA-256 re-verified on every load |

Both models are two-level lookups with a first-match-wins rule; they simply pick
different axes. The panel's model is implemented by the host-neutral
`resolveTemplate` in `@atlcli/core`, so a future CLI adoption inherits the same
precedence rules rather than reinventing them. **Today the CLI does not use it.**

## CLI: path precedence

`--template <name-or-path>` resolves in this order, first match wins:

| # | Location | Use it for |
|---|----------|------------|
| 1 | A direct file path, if the file exists | One-off exports, CI checkouts |
| 2 | `.atlcli/templates/confluence/<name>.docx` | Project-specific templates, committed with the repo |
| 3 | `~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx` | Per-instance templates |
| 4 | `~/.atlcli/templates/confluence/<name>.docx` | Your personal default, shared across projects |

Both `.docx` and `.docm` (macro-enabled) are accepted.

```bash
# List what is installed
atlcli wiki export template list

# Install one at a level
atlcli wiki export template save corporate --file ./template.docx --level global

# Remove it
atlcli wiki export template delete corporate --confirm
```

The CLI may omit `--template` entirely and fall back to a
[bundled default](/confluence/export/#the-bundled-default-template).

## Panel: global and space scope

In the extension's **Template sets** section, each uploaded `.docx` is an entry
with a scope:

- **Global** — the default for every page on this Atlassian site.
- **`<SPACE>`** — an override that applies only to pages in that space.

Resolution, for a given engine and the space of the page you are exporting:

1. A **space** entry for that space wins, if one exists.
2. Otherwise the **global** entry of the same id.
3. Otherwise: no template.

Two rules make this predictable rather than merely usual:

- **A wrong-engine entry never resolves**, even when it is the only entry with a
  matching id. A stale cache or an accidental import cannot substitute a Word
  template into a Typst lookup.
- **Two entries that could each legitimately win are an error, not a race.** Two
  global entries, or two space entries for the same space, sharing an id raise
  *"Ambiguous template … remove the duplicate."* Two space entries for
  *different* spaces are not a conflict — they never compete.

Deleting a space override leaves the global entry to take over, which is the
intended way to "unassign" a space.

Entries are keyed by Atlassian site origin, so two sites that each have a space
called `DOCSY` never see each other's templates.

## Integrity: templates are verified, never trusted

Every panel entry records the SHA-256 and byte length of the archive as stored.
On **every** load, the bytes are re-hashed and cross-checked against both before
they reach the engine:

- A mismatch raises *"Template `<id>` failed its sha256 check … template was
  modified, re-upload."*
- There is **no silent fallback** to another entry. Producing a document through
  a template you did not choose is worse than not producing one.
- **Check** in the panel runs the same verification on demand.

One thing is deliberately *not* stored: the template **scan verdict** — which
`$scroll.*` placeholders are supported, which will be emptied, whether
`$scroll.content` exists. That is always re-derived from the bytes at the point
of use, so a cached verdict can never drift from the bytes it once described.

## Declared settings

A template distributed as a [`.wiki-pdf-template` pack](/reference/template-pack-format/)
may declare a `settings` map. A host renders it as a form; the vocabulary is
closed, so a pack cannot ask a host to render a widget it does not have.

| `type` | Widget | Honoured constraints | Default |
|--------|--------|----------------------|---------|
| `text` | Single-line text | `maxLength` (Unicode code points; 200 when unset) | `default` string, else empty |
| `boolean` | Checkbox | — | `default` boolean, else `false` |
| `choice` | Select | `options` — a value outside the list is rejected | `default`, else the first option |
| `color` | Colour field | Must parse to `#RRGGBB` | `default`, else empty |
| `number` | Number input | `min`, `max`, `step`, and `exclusiveMin` for a strict lower bound | `default`, else empty |
| `asset` | File picker | `accept` (media types) and `maxBytes` | none |

Optional on any entry: `label` (the pack's own wording, which a host may replace
with a translated one) and `group` (a grouping key). All settings are optional
for the exporter — omitting one applies its default.

Two boundaries worth stating plainly:

- **A manifest's open `settings` map is not the same shape as the built-in PDF
  template's fixed Level-A settings.** The two stay separate in v1; the fixed
  set is documented in [PDF Template Settings](/reference/pdf-template-settings/).
- **Word templates get no settings input.** `ExportInput` for the DOCX engine
  has no `settings` field, so a Word template's declared settings are displayed
  **for information only**. The panel says so next to the form and never sends
  them — a setting the engine cannot apply must not look as though it was
  applied.

Values a host does persist are stored per site, engine and space, so branding
one space does not brand another.

## Minimal example

Export with a template you keep in the project, no configuration anywhere else:

```bash
mkdir -p .atlcli/templates/confluence
cp corporate.docx .atlcli/templates/confluence/

atlcli wiki export 12345678 --engine ts --template corporate --output ./page.docx
```

## Advanced example

A team with one house style plus one space that has its own:

**CLI** — keep the house style global and the exception in the project that
produces that space's documents:

```bash
# House style, available everywhere
atlcli wiki export template save house --file ./house.docx --level global

# The exception, committed next to the docs it belongs to
cp legal.docx .atlcli/templates/confluence/house.docx   # same name, higher precedence

atlcli wiki export --engine ts --scope space --space LEGAL \
  --template house --output ./legal-handbook.docx
```

The project copy wins because it is level 2 and the global one is level 4 — the
command line does not change.

**Panel** — upload both, mark the house style **Use this one**, then open a page
in the space and mark the second **Use in LEGAL**. Pages in `LEGAL` resolve to
the override; everything else resolves to the global entry. Deleting the
override reverts that space to the house style.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No `docx` template `<id>` found in the library" | The id does not exist for this engine, or belongs to another site | Check **Template sets**; re-upload if the entry is on a different Atlassian site |
| "Ambiguous template `<id>` … remove the duplicate" | Two entries share an id in the same resolvable bucket | Delete one. Two entries for *different* spaces are fine and never cause this |
| "Template `<id>` failed its sha256 check … re-upload" | The stored bytes changed or were corrupted | Re-upload the template. There is deliberately no fallback |
| The wrong template was used (CLI) | A higher-precedence file shadows the one you meant | Check levels 1–4 in order; `atlcli wiki export template list` shows what is installed |
| A space override is ignored | The page is not in that space, or the entry is scoped to another site | Confirm the page's space key in the panel's page summary |
| A template's settings form is greyed out with an explanation | It is a Word template; the Word engine has no settings input | Configure the design in the template itself |
| "Template exceeds the 20 MB limit" (panel) | Over the upload cap | Usually an embedded image — slim the template |
| Jinja placeholders survive into the document | A retired docxtpl/Jinja template was supplied to the TypeScript engine | See [Jinja placeholders appear in the exported document](/confluence/export/#jinja-placeholders-appear-in-the-exported-document) |

## Related topics

- [DOCX and PDF Export](/confluence/export/) — the export commands themselves
- [Exporting from the panel](/extension/export/#word-templates) — the panel-side
  library UI
- [PDF Template Settings](/reference/pdf-template-settings/) — the fixed
  Level-A settings for the built-in PDF design
- [Template Pack Format](/reference/template-pack-format/) — the
  `.wiki-pdf-template` container and manifest schema
- [DOCX Export Engine](/reference/docx-engine/) — placeholder resolution and the
  template scan
- [Templates](/confluence/templates/) — Confluence *page* templates, a different
  thing entirely
