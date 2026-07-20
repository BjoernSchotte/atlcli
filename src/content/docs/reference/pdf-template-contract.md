---
title: "PDF Template Contract (wiki.pdf-template/v1)"
description: "The stable render contract the built-in PDF template and imported Level-B packages both implement: required meta keys, the settings dict, the defensive-read rule, the frozen hook set, and the versioning policy"
---

# PDF Template Contract — `wiki.pdf-template/v1`

Every PDF export renders through one versioned template surface,
`wiki.pdf-template/v1`. The contract names a **shape**, not a symbol: a Typst
function `render(meta, body, settings)`. The built-in template's `atlcli-doc`
is its first conforming implementation, and any imported Level-B template pack
targets the same surface, so generated content compiles against a single stable
seam regardless of which template renders it.

This page is the normative reference for that contract: the `meta` keys a
template may rely on, the `settings` dictionary and its read rule, the full set
of symbols generated content depends on, and the versioning policy. It is
**stable** and safe for Level-B template packages to target.

## On this page

- [Prerequisites](#prerequisites)
- [The render surface](#the-render-surface)
- [Required meta keys](#required-meta-keys)
- [The settings dictionary](#the-settings-dictionary)
- [The defensive-read rule](#the-defensive-read-rule)
- [Running-head modes](#running-head-modes)
- [The stable v1 hook set](#the-stable-v1-hook-set)
- [Versioning policy](#versioning-policy)
- [Example](#example)
- [Related topics](#related-topics)

## Prerequisites

- Familiarity with the [PDF Export Engine](pdf-engine.md) pipeline.
- For the host-facing settings and their validation, see
  [PDF Template Settings](pdf-template-settings.md). This page documents the
  contract the settings flow *into*; that page documents the settings
  themselves.

## The render surface

The contract is the Typst function shape:

```typst
#let atlcli-doc(meta: (:), settings: (:), body) = { /* … */ }
```

- `meta` — a Typst dictionary of document metadata the engine supplies (see
  [Required meta keys](#required-meta-keys)).
- `settings` — a Typst dictionary of Level-A configuration, defaulting to the
  empty dictionary `(:)` (see [The settings dictionary](#the-settings-dictionary)).
- `body` — the serialized document content.

The engine invokes it from the generated `main.typ`:

```typst
#show: atlcli-doc.with(meta: (...), settings: (...))
```

`settings: (:)` as the default is itself the backward-compatibility guarantee:
a caller that passes no `settings` keeps compiling unchanged.

## Required meta keys

A conforming template may rely on these `meta` keys (TEMPLATE-UX §7). The engine
always supplies them:

| Key | Meaning |
|-----|---------|
| `title` | Document title. |
| `space` | Confluence space key. |
| `version` | Document version label. |
| `author` | Author display name. |
| `language` | Content language (e.g. `en`, `de`); drives localized labels. |
| `exported-at` | Export timestamp. |

The engine additionally supplies the derived keys `exporter`, `region`, and
`exported-label`. A template must read any key it does not consider guaranteed
through `meta.at("<key>", default: ...)`.

## The settings dictionary

`settings` is a plain Typst dictionary whose keys are **kebab-case** on the
Typst side, even though the host-facing TypeScript field names are camelCase.
The engine performs that mapping when it emits the dict (for example
`headerText` → `header-text`, `accentColor` → `accent-color`), consistent with
existing keys such as `exported-label`.

| Typst key | Host field | Default |
|-----------|-----------|---------|
| `page` | `page` | `"a4"` |
| `orientation` | `orientation` | `"portrait"` |
| `cover` | `cover` | `true` |
| `outline` | `outline` | `true` |
| `header-text` | `headerText` | `none` |
| `footer-text` | `footerText` | `none` |
| `accent-color` | `accentColor` | `"#4B57A3"` |
| `organization-name` | `organizationName` | `none` |
| `logo` / `logo-alt` | `logo` | `none` |
| `watermark` | `watermark` | `none` |

The full type table, constraints, and validation behavior for these fields live
in [PDF Template Settings](pdf-template-settings.md). Every settings value that
reaches the Typst source is escaped through the engine's typed emitter — settings
are **data, never code**.

## The defensive-read rule

**Every** settings access in a conforming template MUST use
`settings.at("<key>", default: ...)`:

```typst
let page-size = settings.at("page", default: "a4")
let indigo = rgb(settings.at("accent-color", default: "#4B57A3"))
let wm = settings.at("watermark", default: none)
```

This is what keeps sparse dictionaries and older callers compiling: a key that
is absent falls back to its default rather than raising a missing-field error. A
template that reads `settings.page` directly is **not** conforming — it breaks
the moment a caller omits that key.

## Running-head modes

The running head (German: *Kolumnentitel*) is the line at the top of every body
page. Which text it carries is a **template design decision**, declared in the
manifest at `design.features.header.mode` — not a Level-A setting.

| Mode | Running head shows | Use it for |
|------|--------------------|------------|
| `"title"` *(default)* | Document title (left) + space key (right) | Single-page and short exports. |
| `"chapter"` | The level-1 heading that owns the page — the **first** chapter beginning on it, else the chapter still running (left) + space key (right) | Book-like documents and page-tree exports. |
| `"custom"` | The `headerText` setting | A fixed legal or classification line. |

The field is **optional**. A manifest that omits it — including every manifest
written before the mode existed — behaves exactly as `"title"`, so adding the
field changed no existing output. Invalid values are rejected by the manifest
import gate at `design.features.header.mode`, never coerced.

**Precedence.** An explicit `headerText` setting wins in *every* mode. `"custom"`
therefore documents a template's intent rather than changing resolution order,
and falls back to the document title when no `headerText` is supplied.

### Why `chapter` exists

With `"title"`, a 57-page page-tree export repeats the root page's title on all
57 pages, which tells the reader nothing about where they are. `"chapter"` names
the section instead:

```typst
let chapters = query(heading.where(level: 1)).filter(h => h.outlined)
let opening = chapters.filter(h => h.location().page() == here().page())
let running = chapters.filter(h => h.location().page() < here().page())
let chapter-head = if opening.len() > 0 {
  opening.first().body
} else if running.len() > 0 {
  running.last().body
} else {
  meta.title
}
grid(columns: (1fr, auto), chapter-head, meta.space)
```

In words: **the first chapter that begins on this page; if none begins here, the
chapter still running.** Three details of that resolution are load-bearing, and
all three were verified against the pinned compiler
(`typst.ts 0.7.0 / Typst 0.14.2`):

- **A chapter opening on this page counts.** Inside a page header, `here()`
  resolves to the *top* of the page, so a `.before(here())` selector excludes a
  chapter that opens on that very page — the head would lag one page behind at
  every chapter opening. Matching this page's own page index is what picks the
  chapter that actually owns the page.
- **`h.outlined` filter.** `outline()` renders its own level-1 heading for the
  "Contents" title. It is the only heading with `outlined: false`, and "appears
  in the table of contents" is precisely what makes a heading a chapter — without
  the filter, every page of every document would be headed *Contents*.
- **First on the page, not last.** When several short chapters begin on one page,
  the head names the **first** of them. The head sits at the top of the page and
  the content directly beneath it starts with that first chapter, so naming a
  later one would contradict what the reader sees; it is also the convention a
  dictionary's guide words follow. This only ever applies to pages that open more
  than one chapter — with at most one chapter per page, "first opening here" and
  "last at or before here" are the same heading, which is why the refinement left
  ordinary output byte-identical.

Pages before the first chapter heading (a cover, the table of contents, front
matter) fall back to the **document title**, never to an empty head. The space
key on the right and the hairline rule below are identical in all three modes.

:::note[Several chapters per page is not the usual layout]
`composeChapters` inserts a page break per chapter by default, so a tree or space
export puts exactly one chapter on each page and the first-on-page rule never
fires. It matters for documents assembled without those breaks
(`chapterBreak: "none"`) or with very short chapters.
:::

Of the two curated built-in templates, **Manuscript** ships `"chapter"` (it is a
book-like design) and **Editorial Indigo** stays on the default `"title"`.

### DOCX equivalence

The DOCX engine has the same capability, expressed the way Word expresses it: a
user template puts a `STYLEREF` field in its header
(`STYLEREF "Scroll Heading 1" \* MERGEFORMAT`) and the engine keeps it resolving
— field instructions survive byte-exactly, headings carry the exact `w:pStyle`
id the field names, and `updateFields` prompts Word to refresh on open. Word's
own rule for that field is *the last H1 that began on or before this page*, which
is what the Typst resolution above reproduces on every page that opens at most
one chapter — that is, on every page of a normal chapterized export. The two
rules part only where several chapters begin on the same page: Word names the
last of them, PDF names the first, deliberately (see the third bullet above).

The two engines differ in **where the decision lives**, not in what it does: PDF
declares the mode in a validated manifest field, DOCX inherits it from whatever
field the user's `.docx` template already contains. See
[Running headers (STYLEREF)](docx-engine.md#running-headers-styleref), including
the `styleref-style-unused-in-export` promotion trap, which has no PDF analogue
because the PDF query names no style.

## The stable v1 hook set

TEMPLATE-UX §7 prohibits generated content from depending on undocumented
template-local functions. The engine's serializer (`serialize.ts`) imports
**eight** symbols from the generated `atlcli.typ`, and all eight are the frozen
v1 hook set a conforming template must export:

| Symbol | Purpose |
|--------|---------|
| `atlcli-doc` | The `render(meta, body, settings)` document wrapper. |
| `callout` | Info/note/warning/tip/panel callout block. |
| `status-badge` | Colored status label. |
| `table-par` | Width-aware paragraph wrapper for table cells. |
| `dense-token` | Fit-or-fallback token for dense tables. |
| `dense-link` | Progressive-shortening link for dense tables. |
| `dense-status-badge` | Width-aware status badge for dense tables. |
| `task-item` | Checkbox + body task-list row. |

Generated content may depend on these and **no other** template-local
functions. Shrinking this set — relocating the five dense-table / table helpers
into engine-owned code so an external template overrides fewer hooks — is a
deliberate follow-up once a real Level-B template needs it. It is **not** part
of this contract's first cut, and any such change bumps the API string (see
below).

## Versioning policy

The contract, the manifest, and the compiler travel together. A template pack's
manifest pins `engine.api` (the contract string, `wiki.pdf-template/v1`),
`schemaVersion`, and — for Typst — `engine.compilerRange`; the import gate
rejects unknown or incompatible values (see
[Template Pack Format](template-pack-format.md)).

For the contract itself:

- **Adding a settings key is non-breaking.** Because every read is a defensive
  `settings.at("<key>", default: ...)`, an older template simply ignores a key
  it does not know, and a newer template falls back to the default when a caller
  omits it. No API-string change.
- **Removing or renaming a settings key, or changing the hook set, is
  breaking.** It bumps the `engine.api` string (a new `wiki.pdf-template/vN`),
  because existing generated content or existing templates would otherwise read
  or export a symbol that no longer means what it did.

This mirrors the manifest's own `schemaVersion` + `engine.api` +
`engine.compilerRange` gating: adding is defensive, removing/renaming is a
version bump.

## Example

A minimal conforming template skeleton — note the defaulted signature and the
defensive reads:

```typst
#let atlcli-doc(meta: (:), settings: (:), body) = {
  let is-german = meta.at("language", default: "en") == "de"
  let indigo = rgb(settings.at("accent-color", default: "#4B57A3"))

  set document(title: meta.title, author: meta.author, date: meta.exported-at)
  set page(
    paper: if settings.at("page", default: "a4") == "letter" { "us-letter" } else { "a4" },
    flipped: settings.at("orientation", default: "portrait") == "landscape",
  )

  if settings.at("cover", default: true) {
    // cover block …
    pagebreak()
  }
  if settings.at("outline", default: true) {
    outline(depth: 3)
    pagebreak()
  }
  body
}

// A conforming template must also export the other seven hook-set symbols:
// callout, status-badge, table-par, dense-token, dense-link,
// dense-status-badge, task-item.
```

## Related topics

- [PDF Template Settings](pdf-template-settings.md) — the host-facing settings
  and their validation.
- [Template Pack Format](template-pack-format.md) — the `.wiki-pdf-template`
  container, manifest schema, and import gate.
- [PDF Export Engine](pdf-engine.md) — the pipeline this contract renders in.
- [DOCX Export Engine](docx-engine.md#running-headers-styleref) — the DOCX
  equivalent of a chapter running head (`STYLEREF` in a user template).
