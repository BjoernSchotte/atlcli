---
title: "Exporting pages with dynamic macros"
description: "How atlcli renders Jira tables, draw.io diagrams, includes, TOCs and third-party macros in DOCX and PDF exports"
---

# Exporting pages with dynamic macros

Many Confluence pages embed **dynamic macros** — a live Jira issue table, a
draw.io diagram, a Page Properties Report, a `{children}` list, a re-used
excerpt. When you export with `--engine ts`, atlcli resolves these to real,
themed content instead of collapsing them into a gray placeholder.

## On this page

- [How it works: the fallback chain](#how-it-works-the-fallback-chain)
- [Supported macros](#supported-macros)
- [Datasource smart links (modern Jira tables and Confluence lists)](#datasource-smart-links)
- [Deterministic exports (`--no-live-macros`)](#deterministic-exports)
- [The export report](#the-export-report)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- **Engine:** for DOCX, dynamic-macro resolution runs only on the TypeScript
  engine (`--engine ts`); the default `python` engine renders placeholders.
  `--format pdf` always resolves macros (PDF has a single built-in engine).
- An auth profile with access to the space (and, for Jira macros, the linked
  Jira site).

## How it works: the fallback chain

For every macro the storage walker did not natively convert, atlcli tries each
stage in order and stops at the first that produces content:

1. **Native conversion** — callouts, code, status, expand, … (handled by the
   walker; these never reach the resolver).
2. **Specific renderer** — a Jira table, a diagram image, an include, a TOC,
   etc. (see the table below). Full template/theme fidelity.
3. **`export_view` fallback** — Confluence renders the macro server-side to
   HTML and atlcli converts the HTML subset to real blocks. This transparently
   covers current-generation third-party apps that declare an ADF export
   function.
4. **Visible placeholder + report note** — the guaranteed floor. The macro's
   preserved body/plain-text is still rendered beneath the placeholder line, so
   content is **never silently dropped**.

## Supported macros

Each built-in renderer and the macro names it claims. "Live" renderers contact
Jira/Confluence/`export_view`/attachment APIs; "Pure" renderers read only the
page content already fetched.

| Renderer | Macro names | Type |
|----------|-------------|------|
| `toc` | `toc` | Pure |
| `jira` | `jira`, `jiraissues` | Live |
| `confluence-list` | `confluence-list` (synthetic — see [datasource smart links](#datasource-smart-links)) | Live |
| `diagram` | `drawio`, `inc-drawio`, `drawio-sketch`, `gliffy` | Live |
| `multiexcerpt-include` | `multiexcerpt-include-macro`, `multiexcerpt-include` | Live |
| `scroll-tablelayout` | `scroll-tablelayout`, `scroll-tablelayout-macro` | Pure |
| `children` | `children` | Live |
| `include` | `include` | Live |
| `excerpt-include` | `excerpt-include` | Live |
| `excerpt` | `excerpt` | Pure |
| `page-properties-report` | `detailssummary` | Live |
| `export-view` (catch-all) | any other macro | Live |

Any macro not claimed by a specific renderer falls through to the `export_view`
catch-all, then to the placeholder floor.

## Datasource smart links

Since **2026-05-22** the Confluence Cloud editor no longer inserts a
`jira` macro when you add an issue table. It inserts a **datasource smart
link** — an `<a data-datasource="…">` element that carries the query, the chosen
columns and the target site id. Atlassian's Jira Legacy macro became the *Jira
Data Center* macro and existing Cloud instances were auto-converted. The same
mechanism backs the **Confluence list** card ("Confluence search results") the
editor inserts when you embed a filtered list of pages.

atlcli reads these directly, so both render as real, themed tables in DOCX and
PDF alike — no separate code path, no configuration.

| Provider | Behaviour |
|----------|-----------|
| **Jira work items** (`d8b75300-…`) | Rendered as a live issue table |
| **Confluence search** (`768fc736-…`) | Rendered as a live page table — see [Confluence lists](#confluence-lists) |
| **JSM Assets** (`361d618a-…`) | Kept as a link + `datasource-provider-unsupported` note |
| Anything else | Kept as a link + `datasource-provider-unknown` note **including the raw provider id** |

What is preserved:

- **Your JQL, byte for byte** — including the trailing `ORDER BY` that carries
  your chosen sort. atlcli never rewrites the query.
- **Your column order**, taken from the table view's `columns`. The provider's
  `issuetype` key and the legacy macro's `type` key both resolve.

What degrades — always with a note, never silently:

| Case | Note code |
|------|-----------|
| Unreadable/invalid `data-datasource` payload, or no `table` view | `datasource-invalid` |
| Unrecognized provider id (printed in the message) | `datasource-provider-unknown` |
| Recognized but not implemented (JSM Assets) | `datasource-provider-unsupported` |
| Table built on a **saved filter** instead of JQL, or a filter with no query equivalent | `datasource-filter-unsupported` |
| Parameters that compose to **no query at all** (an unbounded site-wide search is never issued) | `datasource-query-empty` |
| A requested **column that cannot be filled** — rendered empty and named | `datasource-column-unresolved` |
| Table targets a **different site** than the export is authenticated against | `datasource-cross-site` |

In every degraded case the original link is kept in the document, so nothing is
lost.

:::caution[Why a different site degrades instead of rendering]
Atlassian's datasource dialog has a site selector, so a Confluence page can
embed a table from another Jira site. Running that JQL against *your* site
would return plausible-looking but wrong rows. atlcli refuses to guess: unless
the table's own link points at the site the export is authenticated against, it
degrades to the link and says so.
:::

**Row cap.** Atlassian stores no row limit in a datasource (its own export
pages through the live component until exhausted). atlcli caps the table at
**100 rows** and emits a `macro-degraded` warning naming the cut whenever the
cap is reached, so a truncated table is never mistaken for a complete one.

### Confluence lists

A Confluence list card renders as a real table carrying **your column selection,
in your order**. Cells are text: the UI's type glyph becomes the content-type
name, the space chip becomes the space name, and the owner avatar becomes the
display name (avatars are not downloaded — the name carries the information).

| Column | Source |
|--------|--------|
| `type` | Content type (`Page`, `Blog post`, `Attachment`, `Whiteboard`, `Folder`, …) |
| `title` | Page title, linked (see [Links inside the export](#links-inside-the-export)) |
| `space` | Space display name (falls back to the space key) |
| `description` | The search excerpt, as plain text |
| `ownedBy` | Owner display name |
| `updatedAt` | Last-modified date, `YYYY-MM-DD` |
| `labels` | Comma-separated label names |
| `status` | `Current` / `Draft` / `Archived` |

A column atlcli cannot fill renders **empty and is named** in a
`datasource-column-unresolved` note — never a silently blank column. The same
note (at `info` level) fires when a mapped column turns out empty on every row,
which is what a wrong field mapping looks like from the outside.

**Supported filters.** The list's query is composed from **all** present
parameters — an empty search box with filters set still queries correctly:

| Filter (as the card stores it) | Query |
|--------------------------------|-------|
| `searchString` | `text ~ "…"` (or `title ~ "…"` with *title only*) |
| `spaceKeys` | `space in (…)` |
| `labels` | `label in (…)` |
| `entityTypes` | `type in (…)` |
| `ancestorPageIds` | `ancestor in (…)` |
| `creatorAccountIds` | `creator in (…)` |
| `contributorAccountIds` | `contributor in (…)` |
| `lastModified` (absolute dates) | `lastmodified >= … / <= …` |
| `contentStatuses` | sent as a search-request filter (CQL has no content-status field) |

Anything else — `contentARIs`, a *relative* last-modified window like "last 7
days", or a filter Atlassian adds later — degrades to the link with a
`datasource-filter-unsupported` note **naming the filter**. Dropping a filter
would widen the table with rows you never asked for, which is worse than no
table at all. A relative date window additionally has no reproducible meaning in
an exported document, whose reader may be in another timezone months later.

**Volume.** Confluence lists are usually large — a single-contributor filter can
match thousands of pages. atlcli caps the table at **100 rows**, and when the cap
bites the note names **both** counts ("100 of 2817 matching results are shown")
and the **link to the live list stays under the table** so the remaining rows are
one click away. An untruncated table has no link: its absence tells you nothing
was withheld. Narrow the list in Confluence (space, label or type filters) to
make the export show the rows you care about.

**Wide tables.** Eight columns get a horizontal scrollbar in the browser; a page
has none. A datasource table degrades through the ordinary wide-table path, so
you get the `table-text-scaled` / `table-overflow-warned` notes you already know
rather than a datasource-specific behaviour.

### Links inside the export

In a `--scope tree` or `--scope space` export, result pages that are **chapters
of the same document** link internally — clicking a row's title jumps to that
chapter instead of opening a browser. Rows pointing outside the export link to
their absolute URLs and are reported once per table with the usual
`link-outside-scope` note.

**Data Center.** The legacy `<ac:structured-macro ac:name="jira">` path is
unchanged and keeps working; both forms can coexist on one site.

## Deterministic exports

For CI or compliance exports that must not issue extra network calls to Jira /
`export_view` / attachment lookups, pass `--no-live-macros`:

```bash
atlcli wiki export 12345 -t corporate.docx -o out.docx --engine ts --no-live-macros
```

- It suppresses **only** the Live renderers; Pure renderers (TOC,
  scroll-tablelayout, `excerpt`, transparent passthroughs) still run.
- It is **not** an offline mode: the page body and its own attachments still
  fetch over the network. The guarantee is "no additional
  Jira/`export_view`/attachment-lookup calls".
- It requires `--engine ts` and fails fast with a usage error on
  `--engine python`.

## The export report

Every macro the resolver touches produces exactly one terminal note:

- `macro-rendered-via` (info) — resolved by a renderer or `export_view`.
- `macro-degraded` (warning) — fell through to the placeholder floor, or a live
  call was skipped (e.g. a Jira 403).
- `macro-skipped-by-config` (info) — suppressed by `--no-live-macros` or a
  resolution deadline.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Jira table missing, "no permission" note | The export profile's Jira user can't view the issues | Grant access, or accept the placeholder |
| Diagram shows a placeholder | No preview attachment on the page (previews are only written on save) | Open and re-save the diagram in Confluence, then re-export |
| "preview may be outdated" note | The diagram preview is older than the page's last edit | Re-save the diagram to regenerate its preview |
| A third-party macro is a placeholder | The app declares no `export_view`/ADF export | Placeholder + note is the honest floor |
| Macros not resolved at all | Running the `python` engine | Add `--engine ts` |
| A Jira table exports as a bare URL, `datasource-cross-site` note | The table points at a different Jira site than the export profile | Export with a profile on that site, or accept the link |
| A Jira table exports as a bare URL, `datasource-filter-unsupported` note | The table is built on a saved filter, not JQL | Rebuild the table with an explicit JQL query |
| A Jira table exports as a bare URL, `datasource-provider-unknown` note | Atlassian introduced a datasource provider newer than this release | Report the provider id printed in the note |
| A Confluence list shows only 100 rows | The list matches more than the row cap; the note names both counts | Narrow the list in Confluence, or follow the link kept under the table |
| A Confluence list column is empty, `datasource-column-unresolved` note | That column has no field this exporter can read, or the field is empty on every row | Pick a different column in Confluence, or accept the empty column |
| A Confluence list exports as a bare URL, `datasource-query-empty` note | The list has no filter that maps to a query (an unbounded site-wide search is never issued) | Add a space, label, type or contributor filter to the list |
| A Confluence list exports as a bare URL, `datasource-filter-unsupported` note | The list uses a filter with no query equivalent (specific content, or a *relative* date window) | Replace it with a space/label/type filter or an absolute date range |
| The "Open the full list" link lands on an empty Confluence search page | Not an export defect: the link is the URL Confluence itself stored on the card, and the list macro's own detail-view link opens the same URL with the same result. Confluence's search page does not always reproduce a contributor-only filter | Use the exported table, or rebuild the filter in Confluence search directly |

## Related topics

- [DOCX and PDF Export](/confluence/export/)
- [Tree and space export](/confluence/export/#tree-and-space-export)
