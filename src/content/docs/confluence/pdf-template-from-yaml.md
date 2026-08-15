---
title: "Create a PDF template from YAML"
description: "Define cover and closing-page compositions as validated data, build a deterministic template pack, and use it in the atlcli PDF export pipeline"
---

# Create a PDF template from YAML

Use a declarative YAML recipe when you want exact PDF branding without editing
Typst. The recipe controls the cover composition, closing page, typography,
colors, spacing, localization, and approved local images. atlcli validates the
data, generates canonical Typst, compiles it as a proof, and writes a
deterministic `.wiki-pdf-template` pack.

The final document still goes through the regular PDF export pipeline:

```text
recipe.yaml
  -> atlcli pdf-template build
  -> brand.wiki-pdf-template
  -> atlcli wiki export --format pdf --template brand.wiki-pdf-template
  -> final PDF
```

## On this page

- [Prerequisites](#prerequisites)
- [Build and use a template](#build-and-use-a-template)
- [Minimal working recipe](#minimal-working-recipe)
- [Recipe V2 and installed baselines](#recipe-v2-and-installed-baselines)
- [Advanced Recipe V2 example](#advanced-recipe-v2-example)
- [Recipe field reference](#recipe-field-reference)
- [Cover composition](#cover-composition)
- [Closing-page composition](#closing-page-composition)
- [Assets](#assets)
- [Migrate an older recipe](#migrate-an-older-recipe)
- [Validation and errors](#validation-and-errors)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- atlcli with the PDF compiler installed.
- PNG, JPEG, or sanitized SVG assets that you are allowed to reuse.
- A Recipe V2 file pinned to the installed `atlcli.editorial` baseline, or a
  complete migrated Recipe V1 file for legacy authoring.
- A configured Confluence profile only when you export wiki content. Building
  and validating a recipe is local.

The built-in Source Serif 4, Source Sans 3, and Source Code Pro families are a
safe starting point. A recipe may select only font families available to the
compiler; it does not fetch fonts from the network.

## Build and use a template

Place the YAML file and all referenced assets below one directory:

```text
executive-template/
├── recipe.yaml
└── assets/
    ├── cover.svg
    └── logo.svg
```

Validate without writing a pack:

```bash
atlcli pdf-template validate ./executive-template/recipe.yaml
```

Build the deterministic pack:

```bash
atlcli pdf-template build ./executive-template/recipe.yaml \
  --output ./executive.wiki-pdf-template
```

Use that pack in the production PDF export path:

```bash
atlcli wiki export <page-id> \
  --format pdf \
  --profile <profile> \
  --template ./executive.wiki-pdf-template \
  --output ./document.pdf
```

Both `validate` and `build` also support `--json --no-log` for automation.
Build refuses to replace an existing output and publishes nothing until YAML,
assets, the generated archive, and a real compiler proof all pass.

:::note[The archive is JSON-based]
YAML is the authoring format only. A `.wiki-pdf-template` is a deterministic
ZIP archive whose canonical manifest member is generated JSON named
`wiki-pdf-template.json`, together with canonical `atlcli.typ` and hashed asset
files. Do not edit generated archive members.
:::

## Minimal working recipe

Recipe V2 is the recommended authoring format. It pins an installed baseline
by exact identity and digest, then stores only sparse author overrides:

```yaml
schema: wiki.pdf-template-recipe/v2
template:
  id: example.editorial-minimal
  name: Editorial Minimal
  version: 1.0.0
baseline:
  id: atlcli.editorial
  version: 1
  catalogVersion: 3
  digest: 46e27e8828ff22f6ac5f6750d8b054c566c3378e7fd960f64be85251cad11f6a
design: {}
assets: {}
```

Download the [machine-checked minimal Recipe V2](https://atlcli.sh/examples/pdf-template-recipe-v2-minimal/recipe.yaml).
It resolves to a complete Catalog V3 design and canonical source revision 5.
The generated pack contains that complete resolved design; it does not depend
on the baseline registry when loaded or exported.

Inspect resolution without opening asset files or writing a pack:

```bash
atlcli pdf-template explain ./recipe.yaml --json
```

The result lists the pinned baseline, sparse author override paths, active
conditional requirements, compiler range, asset slot names, and required proof
classes. It never returns asset bytes or absolute local paths.

## Recipe V2 and installed baselines

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `schema` | string | — | Yes | Exactly `wiki.pdf-template-recipe/v2`. |
| `template.id` | stable identifier | — | Yes | No URL, path, or implicit namespace. |
| `template.name` | string | — | Yes | Non-empty bounded safe text. |
| `template.version` | semver string | — | Yes | `MAJOR.MINOR.PATCH`, optional prerelease. |
| `baseline.id` | stable identifier | — | Yes | Must be shipped by this atlcli installation; URL-like and path-like values are rejected. |
| `baseline.version` | positive integer | — | Yes | Exact version; there is no `latest`. |
| `baseline.catalogVersion` | positive integer | — | Yes | Must match the installed baseline; currently `3`. |
| `baseline.digest` | SHA-256 hex | — | Yes | Must match both the recipe and recomputed installed content. |
| `design` | sparse object | `{}` | Yes | Only Catalog V3 paths; `null` is not a delete operator. Object/array capabilities replace atomically. |
| `localization` | complete localization object | installed baseline | No | Replacement, not a sparse merge; fallback labels remain mandatory. |
| `assets` | asset declaration map | `{}` | Yes | Relative local declarations only; bytes and hashes are host-resolved. |

Resolution is local and fail-closed. atlcli never downloads baselines, accepts
an implicit newest version, widens a compiler range, or follows a baseline URL.
The installed baseline targets Typst `>=0.15.1 <0.16`, Catalog V3, and canonical
source revision 5.

## Advanced Recipe V2 example

The [advanced handbook recipe](https://atlcli.sh/examples/pdf-template-recipe-v2-advanced/recipe.yaml)
exercises logical margins, right binding, split running heads, contents and
bookmarks, table/list/outline policies, a named linear paint, a flat decorative
shape, and a cropped/clipped image. Its
[synthetic cover SVG](https://atlcli.sh/examples/pdf-template-recipe-v2-advanced/assets/cover.svg)
contains no tenant data.

Both examples are executable acceptance fixtures: `pdf-template validate`
resolves, packs, reloads, and compiles them with the pinned Typst 0.15.1 runtime.

### Legacy Recipe V1

Revision 4 intentionally requires a complete design baseline; missing catalog
fields are rejected instead of receiving hidden renderer defaults. Download
the [complete neutral starter recipe](https://atlcli.sh/examples/pdf-template-recipe/recipe.yaml)
and its [cover SVG](https://atlcli.sh/examples/pdf-template-recipe/assets/cover.svg) and
[logo SVG](https://atlcli.sh/examples/pdf-template-recipe/assets/logo.svg). Preserve the shown
directory structure, then change the identity, brand values, compositions, and
assets.

The smallest composition-specific part is:

```yaml
design:
  features:
    cover:
      enabled: true
    closingPage:
      enabled: true

  compositions:
    cover:
      kind: type-cut
      logo: hide
      typeCut:
        angle: 43
        stop: 58
    closingPage:
      kind: brand-lockup
      logo: show
      website: show
      legalNotice: show
      align: left

  branding:
    websiteLabel: example.com
    websiteUrl: https://example.com
    legalNotice: Example GmbH · Berlin
```

This excerpt is not a standalone recipe. Start from the downloadable complete
file so every required typography, color, layout, ratio, palette, and
localization field remains present.

## Recipe field reference

Recipe fields have no implicit authoring defaults unless the table says so.
`Required` means the key must be present in the YAML input. Unknown keys are
errors at every level.

### Top level and template identity

This table describes legacy Recipe V1. New recipes should use the Recipe V2
envelope above.

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `schema` | string | — | Yes | Exactly `wiki.pdf-template-recipe/v1`. |
| `template.id` | string | — | Yes | Starts with a letter; then letters, numbers, `.`, `_`, or `-`; at most 128 characters. |
| `template.name` | string | — | Yes | Non-empty, at most 200 Unicode code points; no control or Typst source metacharacters. |
| `template.version` | semver string | — | Yes | `MAJOR.MINOR.PATCH`, optionally with a prerelease suffix. |
| `template.compilerRange` | range string | — | Yes | Space-separated numeric Typst comparisons; use `>=0.15.1 <0.16` for the current runtime. |
| `design` | object | — | Yes | Complete validated revision-4 design; see below and the starter recipe. |
| `localization` | object | — | Yes | Default and fallback locale must exist; fallback document labels must be complete. |
| `assets` | map | `{}` | Yes | At most 64 entries; only supported PDF asset slots are materialized. |

### Design foundation

| Field or family | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `page.size` | enum | — | Yes | `a4` or `letter`. |
| `page.orientation` | enum | — | Yes | `portrait` or `landscape`. |
| `page.margin.{top,right,bottom,left}` | length | — | Yes | `pt`, `mm`, or `em`; absolute magnitude at most 1000. |
| `features.cover.enabled` | boolean | — | Yes | Controls the cover page. |
| `features.outline.enabled` | boolean | — | Yes | Controls the table of contents. |
| `features.outline.depth` | integer | — | Yes | `1..6`. |
| `features.header.enabled` | boolean | — | Yes | Controls the running head. |
| `features.header.mode` | enum | `title` when absent | No | `title`, `chapter`, or `custom`. |
| `features.footer.enabled` | boolean | — | Yes | Controls the footer. |
| `features.closingPage.enabled` | boolean | — | Yes | Adds or removes exactly one closing page. |
| `branding.accent` | color | — | Yes | Canonical `#RRGGBB`. |
| `branding.organizationName` | string | none | No | Same safe-string limit as `template.name`. |
| `typography.fonts.{body,heading,mono}` | font-family string | — | Yes | Must name a compiler-available family. |
| `typography.roles.<role>.font` | enum | role-specific | Conditional | `body`, `heading`, or `mono`. |
| `typography.roles.<role>.size` | length | — | Yes for cataloged roles | `pt`, `mm`, or `em`; magnitude at most 1000. |
| `typography.roles.<role>.weight` | enum | role-specific | Conditional | `regular`, `medium`, `semibold`, or `bold`. |
| `typography.roles.<role>.tracking` | length | none | No | `pt`, `mm`, or `em`; magnitude at most 1000. |
| `tokens.colors.<name>` | color | — | Yes for every cataloged name | Canonical `#RRGGBB`. |
| `tokens.layout.<name>` | length | — | Yes for every cataloged name | `pt`, `mm`, or `em`; magnitude at most 1000. |
| `tokens.ratios.<name>` | number | — | Yes for every cataloged name | `0..100`. |
| `tokens.contrast.minimum` | number | — | Yes | `1..21`. |
| `semanticPalettes.callouts.<kind>.{background,foreground}` | color | — | Yes for every cataloged kind | Canonical `#RRGGBB`. |
| `semanticPalettes.statuses.<name>` | color | — | Yes for every cataloged status | Canonical `#RRGGBB`. |

The starter recipe is the machine-checked field inventory and contains every
currently required role and token with the Editorial Indigo baseline values.
Map keys must be safe identifiers. The renderer never silently fills a missing
revision-4 catalog entry.

### Localization

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `localization.defaultLocale` | string | — | Yes | Must name an entry in `locales`. |
| `localization.fallbackLocale` | string | — | Yes | Must name a complete entry in `locales`. |
| `localization.locales.<locale>.template.name` | string | none | No | UI copy, at most 500 characters. |
| `localization.locales.<locale>.template.description` | string | none | No | UI copy, at most 500 characters. |
| `localization.locales.<locale>.document` | string map | — | Required for fallback | Must define `version`, `exported`, `exporter`, `contents`, `endOfDocument`, `pages`, `generatedWith`, and `spacePrefix`; `coverEyebrow` is optional. |
| `localization.locales.<locale>.settingGroups` | string map | none | No | Host-facing UI copy. |
| `localization.locales.<locale>.settings` | object map | none | No | Optional `label`, `help`, and `options` UI copy. |

## Cover composition

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `compositions.cover.kind` | enum | — | Yes | `standard` or `type-cut`. |
| `compositions.cover.logo` | enum | — | Yes | `show` or `hide`; `show` requires `asset.logo`. |
| `compositions.cover.metadataPosition` | enum | `flow` | No | `flow` or `bottom`; `bottom` is valid only for `type-cut`. |
| `compositions.cover.typeCut.angle` | number | — | For `type-cut` | `-180..180` degrees. |
| `compositions.cover.typeCut.stop` | number | — | For `type-cut` | `0..100`; location of the hard foreground/inverse transition. |
| `tokens.colors.coverTitleInk` | color | — | Yes | Title color on the light side. |
| `tokens.colors.coverTitleInverse` | color | — | For `type-cut` | Title color on the dark or colored side. |
| `tokens.layout.coverTitleFrameHeight` | length | — | For `type-cut` | Fixed title fitting frame. |
| `tokens.layout.coverMetaBottomInset` | length | — | For `metadataPosition: bottom` | Distance of the rule-and-metadata block from the page bottom. |
| `typography.roles.coverTitleCompact` | typography role | — | For `type-cut` | Second title fitting tier. |
| `typography.roles.coverTitleMinimum` | typography role | — | For `type-cut` | Smallest title fitting tier; overflow after this tier is an error. |

Type Cut keeps the page title as one searchable and selectable text object.
The hard color transition is generated by the renderer from `angle` and
`stop`; the YAML cannot inject Typst.

With `metadataPosition: bottom`, the renderer moves the rule and the complete
metadata grid into one bottom-anchored block. Its position is independent of
the title length and controlled by `coverMetaBottomInset`. Omitting the field
preserves the historical flow layout.

## Closing-page composition

Every closing-page value is declarative. The renderer contains no company
name, website, copyright symbol, or legal sentence.

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `compositions.closingPage.kind` | enum | — | Yes | `document-summary` or `brand-lockup`. |
| `compositions.closingPage.logo` | enum | — | Yes | `show` or `hide`. Summary pages must use `hide`. |
| `compositions.closingPage.website` | enum | — | Yes | `show` or `hide`. Summary pages must use `hide`. |
| `compositions.closingPage.legalNotice` | enum | — | Yes | `show` or `hide`. Summary pages must use `hide`. |
| `compositions.closingPage.align` | enum | — | Yes | `left`, `center`, or `right`. |
| `branding.websiteLabel` | string | none | When website is shown | Visible link label; safe-string rules apply. |
| `branding.websiteUrl` | URL string | none | When website is shown | Absolute HTTPS URL, without credentials or fragment. |
| `branding.legalNotice` | string | none | When legal notice is shown | Exact visible text; at most 200 Unicode code points. |
| `tokens.colors.closingPageBackground` | color | — | For `brand-lockup` | Canonical `#RRGGBB`. |
| `tokens.colors.closingBrandText` | color | — | For `brand-lockup` | Canonical `#RRGGBB`. |
| `tokens.layout.closingBrandBottomInset` | length | — | For `brand-lockup` | Distance from the page bottom. |
| `tokens.layout.closingBrandBlockWidth` | length | — | For `brand-lockup` | Width of the aligned content block. |
| `tokens.layout.closingBrandLogoWidth` | length | — | When logo is shown | Logo box width. |
| `tokens.layout.closingBrandLogoHeight` | length | — | When logo is shown | Logo box height. |
| `tokens.layout.closingBrandLogoGap` | length | — | When logo is shown | Gap after the logo. |
| `tokens.layout.closingBrandTextGap` | length | — | When website or legal text is shown | Gap between text elements. |
| `typography.roles.closingWebsite` | typography role | — | When website is shown | Requires `font`, `size`, and `weight`. |
| `typography.roles.closingLegal` | typography role | — | When legal notice is shown | Requires `font`, `size`, and `weight`. |

`branding.legalNotice` is literal user-owned data. atlcli does not prepend `©`,
derive a company name, or generate legal wording. For example, `© Example GmbH`
appears only if that exact string is present in YAML.

## Assets

Each asset entry has this shape:

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| map key | stable slot id | — | Yes | Supported slots include `asset.coverBackground` and `asset.logo`. |
| `source` | relative path | — | Yes | PNG, JPEG, or SVG; forward slashes; no absolute path, dot segment, or symlink escape. |
| `decorative` | boolean | — | Yes | `asset.logo` must be meaning-bearing (`false`). |
| `alt` | string | none | When `decorative: false` | Non-empty safe alternative text. |
| `placement.relativeTo` | enum | — | When placement exists | `page` or `margin`. |
| `placement.fit` | enum | slot behavior | No | `contain`, `cover`, or `stretch`. |
| `placement.x`, `placement.y` | length | — | When placement exists | Portable `pt`, `mm`, `cm`, or `in`; negative allowed. |
| `placement.width`, `placement.height` | length | — | When placement exists | Portable non-negative length. |
| `placement.opacity` | number | `1` | No | `0..1`. |
| `placement.rotation` | number | `0` | No | `-180..180` degrees. |
| `placement.crop.{left,top,right,bottom}` | number | `0` | No | Each `0..1`; opposing sides must leave a positive visible area. |

SVG validation rejects scripts, event handlers, external references, DTDs,
entities, and other active content. The pack embeds approved bytes and performs
no image fetch during rendering.

## Migrate an older recipe

Typst 0.15.1 does not silently accept packs declared for the old `<0.15`
runtime. Keep the original recipe and create a distinct migrated YAML file:

```bash
atlcli pdf-template migrate-runtime ./recipe.yaml \
  --output ./recipe.typst-0.15.1.yaml

atlcli pdf-template build ./recipe.typst-0.15.1.yaml \
  --output ./brand.typst-0.15.1.wiki-pdf-template
```

The migration changes only `template.compilerRange` to `>=0.15.1 <0.16`.
It refuses to overwrite either the source recipe or an existing destination.
An archive alone is not enough: use the original declarative recipe so design,
localization, assets, and canonical source can be regenerated and proven.

## Validation and errors

The command exits non-zero and leaves the requested output untouched when any
gate fails. JSON mode returns stable error information suitable for automation.
Common categories are:

| Symptom | Likely cause | Fix |
|---|---|---|
| YAML line and column error | Duplicate key, alias, custom tag, malformed YAML, or parser budget exceeded | Remove YAML metaprogramming and keep one plain YAML 1.2 document. |
| `is not recognized` | Unknown or misspelled key | Compare the path with this reference and the starter recipe. |
| `typeCut is required` | `kind: type-cut` without angle/stop | Add both bounded values. |
| `coverMetaBottomInset is required` | Bottom-anchored cover metadata lacks its inset token | Add `tokens.layout.coverMetaBottomInset` or use `metadataPosition: flow`. |
| branding field is required | A visible website or legal block lacks its data | Add the corresponding branding fields or set visibility to `hide`. |
| asset path error | Absolute path, `..`, symlink escape, missing file, or unsupported extension | Keep real files under the recipe directory and use portable relative paths. |
| unsafe SVG | Active or externally referenced SVG content | Export a flattened, self-contained SVG or PNG. |
| compiler range mismatch | The recipe or pack targets the pre-0.15 runtime | Run `pdf-template migrate-runtime` against the original recipe, then build its distinct output. |
| output already exists | Build never clobbers a pack | Choose a new path or move the reviewed old output first. |
| compiler proof failed | Missing font, impossible title fit, or invalid generated layout | Use bundled fonts, adjust fitting roles/frame, and rebuild. |
| baseline is not installed | Recipe V2 names an id/version not shipped by this installation | Use an exact installed baseline identity; do not replace it with a URL or `latest`. |
| baseline digest mismatch | The Recipe V2 pin or installed baseline content changed | Restore the reviewed digest/version pair or deliberately adopt a newly shipped baseline version. |
| conditional capability error | A selected composition requires another token, label, or asset | Run `pdf-template explain --json`, then add the listed requirement or select another bounded composition. |

## Security and privacy

- Recipes are data, never executable Typst. Raw source, generated hashes,
  catalog digests, and archive paths are not authoring fields.
- YAML is bounded to one UTF-8 document; aliases, anchors, merge keys, custom
  tags, duplicate keys, excessive depth, and oversized collections are rejected.
- Asset resolution is rooted at the real recipe directory and rejects traversal
  and symlink escape.
- URLs must use HTTPS and cannot contain credentials or fragments.
- Build performs no network access. `wiki export` accesses only the configured
  Confluence source and declared export dependencies.
- Treat the recipe and generated pack as brand assets. Do not commit private
  logos, legal copy, customer titles, tenant identifiers, or rendered PDFs to a
  public repository.
- PDF/A and PDF/UA standards are export policy (`--pdf-standard`), not Recipe
  V2 or pack fields. A template cannot claim or certify output conformance.

## Troubleshooting

### The cover title colors do not follow the image edge

`typeCut.angle` and `typeCut.stop` define the text transition. Align the visual
edge in `asset.coverBackground` to the same coordinate frame, then render a
real PDF and inspect the first page. The renderer does not analyze the image.

### The closing page is missing

Set `features.closingPage.enabled: true`. For a branded closing page, also set
`compositions.closingPage.kind: brand-lockup` and provide every field required
by the elements whose visibility is `show`.

### The website is visible but not clickable

Use both `branding.websiteLabel` and an absolute HTTPS
`branding.websiteUrl`. The label is display text; the URL becomes the PDF link
annotation.

### A long title fails compilation

Increase `tokens.layout.coverTitleFrameHeight`, reduce the sizes in
`coverTitleCompact` and `coverTitleMinimum`, or shorten the source page title.
atlcli fails instead of clipping text after the minimum fitting tier.

## Related topics

- [Export Confluence content](/confluence/export/) — PDF export commands and
  source scopes.
- [PDF Template Settings](/reference/pdf-template-settings/) — per-export
  settings that remain separate from pack design.
- [PDF Template Contract](/reference/pdf-template-contract/) — renderer API and
  compatibility policy.
- [Template Pack Format](/reference/template-pack-format/) — archive members,
  hashing, and import gates.
- [Create a PDF template from Word](/confluence/pdf-template-from-word/) — the
  reviewed DOCX evidence workflow.
