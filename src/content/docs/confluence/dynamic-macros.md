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
- [Deterministic exports (`--no-live-macros`)](#deterministic-exports)
- [The export report](#the-export-report)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- **Engine:** dynamic-macro resolution runs only on the TypeScript engine
  (`--engine ts`). The default `python` engine renders placeholders.
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

## Related topics

- [DOCX and PDF Export](/confluence/export/)
- [Tree and space export](/confluence/export/#tree-and-space-export)
