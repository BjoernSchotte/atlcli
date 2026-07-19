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
