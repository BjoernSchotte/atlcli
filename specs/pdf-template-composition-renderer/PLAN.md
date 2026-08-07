# Declarative PDF Cover and Closing-Page Composition Renderer

Status: **Proposed / ready for implementation review**, 2026-08-07

Planning baseline: commit `cbd7ecea`

Directory: `specs/pdf-template-composition-renderer`

## Summary decision

Extend the PDF template-pack renderer with a bounded, declarative composition
model for cover and closing pages. The first new cover composition is
`type-cut`; the first new closing composition is `brand-lockup`.

No brand-specific copy, URL, logo, color, geometry, or visibility decision may
be embedded in `packages/pdf/src/template.ts`. In particular, the renderer must
not contain `Mayflower`, `mayflower.de`, or `© Mayflower GmbH`. Those values
belong to the template recipe and resulting validated manifest.

The source authoring surface is YAML because the intended template owner should
be able to create and review a pack without writing TypeScript or generated
manifest hashes. The executable `.wiki-pdf-template` format remains unchanged:
its canonical member is still `wiki-pdf-template.json`, and atlcli compiles the
YAML recipe into that JSON manifest, canonical Typst, and verified assets.

```text
template.yaml + local assets
        │
        ▼
bounded YAML parse + recipe validation
        │
        ▼
PDF capability catalog V2 + canonical source revision 4
        │
        ▼
wiki-pdf-template.json + canonical atlcli.typ + hashed assets
        │
        ▼
real Typst-WASM compile gate
        │
        ▼
deterministic .wiki-pdf-template
```

The implementation remains deliberately bounded. This is not an arbitrary page
builder and the YAML cannot inject Typst source. It exposes named compositions
and typed fields that atlcli translates into engine-owned Typst.

## Confirmed product and architecture decisions

1. The Confluence page title remains one semantic text value. Type Cut renders
   `meta.title` exactly once with a hard two-color linear gradient as its Typst
   `text.fill`; it never splits, duplicates, rasterizes, or semantically parses
   title words.
2. The Type Cut boundary is a straight line, calibrated against a straight
   segment in the cover-background asset. Arbitrary SVG-path text clipping is
   not part of this slice.
3. Cover and closing-page content is declarative. The closing page can
   independently show or hide its logo, website, and legal notice.
4. The legal notice is literal pack data. For the Mayflower pack the YAML may
   contain `legalNotice: "© Mayflower GmbH"`; the renderer contains no such
   literal.
5. The website has separate display and target values. For example,
   `websiteLabel: "mayflower.de"` and
   `websiteUrl: "https://mayflower.de"`. Only validated HTTPS URLs are link
   targets.
6. The current archive contract stays `wiki.pdf-template/v1`. Capability
   catalog V2 and canonical-source revision 4 evolve the renderer without
   changing the outer engine API.
7. Existing catalog-V1/canonical revisions 1–3 remain loadable and byte-stable.
   Their canonical source must not be regenerated with the new branches.
8. The existing DOCX-derived authoring flow remains on catalog V1/revision 3
   in this slice. YAML recipes are the first authoring path for V2/revision 4.
   Migrating durable DOCX-authoring projects and their accepted decisions is a
   separate follow-up, not an implicit side effect of this renderer work.
9. Committed tests use neutral synthetic branding and geometric SVG fixtures.
   Supplied customer material, tenant identifiers, generated previews, and
   live PDFs remain local, disposable test inputs.

## Current-state evidence

- `packages/template-pack/src/design.ts` defines
  `WikiPdfTemplateDesignV1`. `features.cover` and
  `features.closingPage` currently contain only `enabled`; branding contains
  only `accent` and optional `organizationName`.
- `packages/template-pack/src/localization.ts` defines a fixed document-label
  vocabulary. Unknown labels do not reach Typst.
- `packages/pdf/src/design-catalog.ts` owns
  `PDF_TEMPLATE_CAPABILITIES_V1` and its pinned digest. Renderer helpers are
  currently hard-wired to that catalog.
- `packages/pdf/src/template.ts` emits the current cover title as one solid-ink
  `meta.title`. It always emits the existing summary closing page after `body`,
  even though the design carries `features.closingPage.enabled`.
- `packages/pdf/src/template-pack.ts` supports canonical-source revisions 1–3,
  exact-matches one catalog id/version/digest, and already validates
  `asset.logo` plus `asset.coverBackground`.
- `packages/pdf/src/settings.ts` passes the resolved design subset, labels, and
  logo VFS path into Typst. It deliberately filters localization keys against
  the engine-owned vocabulary.
- `packages/pdf/src/serialize.ts` already serializes `meta.title` intact. No
  Confluence/ADF title-pipeline change is needed.
- `packages/pdf/src/template-authoring-runtime.ts` already turns validated
  asset decisions into descriptors, hashes, decorations, VFS paths, and a
  canonical pack. Its current proof compiler disables the cover, so it is not
  sufficient evidence for a composition pack.
- `packages/pdf-compiler-browser/src/docx-template-assets.test.ts` is the
  existing real Typst-WASM + Poppler raster/text pattern.
- `apps/cli/src/commands/export-pdf.e2e.test.ts` already proves a generated pack
  through the live PDF export path against a retained `DOCSY` page.
- The current executable pack is JSON, not YAML:
  `packages/template-pack/src/manifest.ts` names
  `wiki-pdf-template.json`, and
  `apps/cli/src/commands/pdf-template-project-writer.ts` writes it into the
  build output. YAML is therefore a new authoring adapter, not an archive-format
  migration.

## Target declarative contract

### Additive design model

Extend `WikiPdfTemplateDesignV1` with an optional `compositions` section. The
outer type name remains V1 because the addition is backward-compatible; the
renderer capability catalog determines whether the new leaves are executable.

```ts
export const DESIGN_COVER_COMPOSITION_KINDS = [
  "standard",
  "type-cut",
] as const;

export const DESIGN_CLOSING_COMPOSITION_KINDS = [
  "document-summary",
  "brand-lockup",
] as const;

export type DesignVisibility = "show" | "hide";
export type DesignHorizontalAlignment = "left" | "center" | "right";

export interface DesignCoverCompositionV1 {
  kind: "standard" | "type-cut";
  logo: DesignVisibility;
  typeCut?: {
    angle: number; // degrees, finite, -180..180
    stop: number;  // percentage, finite, 0..100
  };
}

export interface DesignClosingPageCompositionV1 {
  kind: "document-summary" | "brand-lockup";
  logo: DesignVisibility;
  website: DesignVisibility;
  legalNotice: DesignVisibility;
  align: DesignHorizontalAlignment;
}

export interface DesignPageCompositionsV1 {
  cover: DesignCoverCompositionV1;
  closingPage: DesignClosingPageCompositionV1;
}
```

Extend branding with optional, validated content:

```ts
export interface DesignBranding {
  accent: DesignColor;
  organizationName?: string;
  websiteLabel?: string;
  websiteUrl?: string;   // absolute HTTPS URL only
  legalNotice?: string; // safe literal, maximum 200 Unicode code points
}
```

Composition validation is cross-field, not best-effort:

- `type-cut` requires `typeCut.angle`, `typeCut.stop`, the inverse title color,
  the fixed title-frame height, and a first-page `asset.coverBackground`
  decoration.
- `standard` rejects a stray `typeCut` object so typos cannot become dead data.
- `brand-lockup` with `logo: show` requires a valid `asset.logo`.
- `brand-lockup` with `website: show` requires both `websiteLabel` and an HTTPS
  `websiteUrl`.
- `brand-lockup` with `legalNotice: show` requires non-empty `legalNotice`.
- `document-summary` retains the existing title/metadata/colophon layout and
  ignores none of the declared brand-lockup fields silently; irrelevant
  `show` values are rejected.
- If `features.closingPage.enabled` is false, no closing page is emitted. This
  behavior is introduced only in canonical revision 4; revisions 1–3 retain
  their characterized source and output.

### Capability-catalog V2 leaves

Catalog V2 contains all V1 descriptors plus these new leaves:

```text
compositions.cover.kind
compositions.cover.logo
compositions.cover.typeCut.angle
compositions.cover.typeCut.stop
compositions.closingPage.kind
compositions.closingPage.logo
compositions.closingPage.website
compositions.closingPage.legalNotice
compositions.closingPage.align
branding.websiteLabel
branding.websiteUrl
branding.legalNotice
tokens.colors.coverTitleInverse
tokens.colors.closingPageBackground
tokens.colors.closingBrandText
tokens.layout.coverTitleFrameHeight
tokens.layout.closingBrandBottomInset
tokens.layout.closingBrandBlockWidth
tokens.layout.closingBrandLogoWidth
tokens.layout.closingBrandLogoHeight
tokens.layout.closingBrandLogoGap
tokens.layout.closingBrandTextGap
typography.roles.closingWebsite.*
typography.roles.closingLegal.*
typography.roles.coverTitleCompact.*
typography.roles.coverTitleMinimum.*
```

The new capability descriptors are optional at the portable catalog layer so
historical design objects remain structurally readable. The PDF V2 manifest
validator enforces the conditional completeness rules above before canonical
source generation.

Do not change `PDF_TEMPLATE_CAPABILITY_DIGEST_V1`. Add separately pinned:

```ts
PDF_TEMPLATE_CAPABILITIES_V2
PDF_TEMPLATE_CAPABILITY_DIGEST_V2
PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2
PDF_TEMPLATE_PRESENTATION_REVISION_V2
```

### YAML recipe authoring surface

The YAML recipe is a source format and must not expose renderer-generated
fields such as `capabilityCatalog.digest`, `canonicalSource`, descriptor hashes,
payload hashes, or raw Typst.

Normative shape:

```yaml
schema: wiki.pdf-template-recipe/v1

template:
  id: mayflower.executive
  name: Mayflower Executive
  version: 1.0.0
  compilerRange: ">=0.14 <0.15"

design:
  page:
    size: a4
    orientation: portrait
    margin:
      top: 23mm
      right: 22mm
      bottom: 20mm
      left: 22mm

  features:
    cover:
      enabled: true
    outline:
      enabled: true
      depth: 3
    header:
      enabled: true
      mode: title
    footer:
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
    accent: "#E75204"
    organizationName: Mayflower GmbH
    websiteLabel: mayflower.de
    websiteUrl: https://mayflower.de
    legalNotice: "© Mayflower GmbH"

  # Full typography, color, layout, ratio, and semantic-palette baseline.
  # No renderer default may silently fill a missing V2 capability.
  typography: {}
  tokens: {}
  semanticPalettes: {}

localization:
  defaultLocale: de
  fallbackLocale: de
  locales:
    de:
      document:
        coverEyebrow: ANGEBOTSINDIKATION
        # Existing required document labels remain present here.

assets:
  asset.coverBackground:
    source: assets/cover-sail.svg
    decorative: true
    placement:
      relativeTo: page
      fit: stretch
      x: 0mm
      y: 0mm
      width: 210mm
      height: 297mm
  asset.logo:
    source: assets/logo.svg
    decorative: false
    alt: Mayflower
```

The complete recipe must carry the same full design baseline required by the
existing authoring materializer; `{}` above is documentation shorthand only
and is invalid input. `@atlcli/template-pack` validates the portable recipe and
design shape. The PDF-owned materializer then proves catalog-V2 completeness
and cross-object requirements; the template-pack package must not import
`@atlcli/pdf` to perform that engine-owned check.

The builder generates the asset descriptors, content hashes, media types,
intrinsic dimensions, writers, decorations, canonical-source reference,
catalog reference, payload provenance, and `atlcli.typ`. Relative asset paths
resolve against the recipe directory and must stay within that directory.

YAML import rules:

- core YAML schema only; no custom tags;
- duplicate keys rejected;
- aliases/anchors and merge keys rejected for the first version;
- maximum recipe bytes, nesting depth, scalar length, collection size, and
  alias count enforced before materialization;
- unknown top-level and nested keys rejected with a stable path;
- asset sources must be relative portable paths without `..`, absolute roots,
  drive prefixes, control characters, or symlink escape;
- YAML strings remain data and pass through existing Typst string escaping;
- the builder writes no output until validation, pack verification, and the
  real compile gate have all passed.

## Renderer behavior

### Type Cut

Revision 4 generates one title block in a fixed coordinate frame:

```typst
#let title-fill = gradient.linear(
  rgb(cover-title-ink),
  rgb(cover-title-inverse),
  angle: type-cut-angle * 1deg,
  relative: "parent",
).sharp(2)

#block(
  width: 100%,
  height: cover-title-frame-height,
)[
  #text(fill: title-fill)[#meta.title]
]
```

The exact Typst emitted by T0 may use repeated hard stops instead of
`.sharp(2)` if that is the only formulation that passes the pinned compiler,
but it must remain a single `meta.title` text object and use
`relative: "parent"`.

Title fitting uses three manifest-defined typography roles
(`coverTitle`, `coverTitleCompact`, `coverTitleMinimum`). Revision 4 measures
the title in the fixed frame and selects the largest fitting role. It must not
truncate, scale non-uniformly, or overflow invisibly. If even the minimum role
does not fit, compilation fails with an actionable diagnostic rather than
silently clipping the title.

### Brand lockup closing page

`brand-lockup` emits a new page only when
`features.closingPage.enabled == true`. The page fill, anchor geometry,
alignment, logo dimensions, gaps, typography, colors, website label/URL, and
legal notice all come from the validated V2 design and accepted assets.

Conceptual renderer shape:

```typst
#place(
  left + bottom,
  dy: -closing-brand-bottom-inset,
  block(width: closing-brand-block-width)[
    // Each section is emitted only when its YAML visibility is "show".
    // Values are already escaped/validated by the TypeScript boundary.
    logo
    link(website-url)[website-label]
    legal-notice
  ],
)
```

The `©` symbol is ordinary Unicode pack data. The renderer neither prepends it
nor derives it from `organizationName`.

## Version and compatibility matrix

| Canonical revision | Capability catalog | Renderer behavior | Load/build policy |
|---|---:|---|---|
| 1 | legacy/V1 rules | historical canonical source | load only; preserve exact source |
| 2 | V1 | decorations | load only; preserve exact source |
| 3 | V1 | positioned logo | current DOCX authoring output; preserve exact source |
| 4 | V2 | compositions, Type Cut, declarative closing page | YAML recipe build and load |

`validatePdfTemplateManifest` must select the expected catalog by canonical
revision, rather than compare every pack to one global “current” catalog.
Revision 4 requires an exact V2 id/version/digest. Revisions 2–3 continue to
require exact V1. Revision 1 retains its existing compatibility behavior.

The existing `PDF_CANONICAL_SOURCE_REVISION` alias must not be silently changed
under the DOCX authoring runtime. Introduce explicit revision constants and a
revision-to-catalog registry; callers choose deliberately.

## Scope

### In scope

- `packages/template-pack/src/design.ts`
- `packages/template-pack/src/design.test.ts`
- `packages/template-pack/src/localization.ts`
- `packages/template-pack/src/manifest.ts`
- `packages/template-pack/src/manifest.test.ts`
- `packages/template-pack/src/recipe.ts` (new, pure recipe shape/validation)
- `packages/template-pack/src/recipe.test.ts` (new)
- `packages/template-pack/src/index.browser.ts`
- `packages/template-pack/README.md`
- `packages/pdf/src/design-catalog.ts`
- `packages/pdf/src/design-catalog.test.ts`
- `packages/pdf/src/template.ts`
- `packages/pdf/src/template.test.ts`
- `packages/pdf/src/template-pack.ts`
- `packages/pdf/src/template-pack.test.ts`
- `packages/pdf/src/settings.ts`
- `packages/pdf/src/settings.test.ts`
- `packages/pdf/src/font-requirements.ts`
- `packages/pdf/src/font-requirements.test.ts`
- `packages/pdf/src/template-recipe.ts` (new, recipe-to-pack materializer)
- `packages/pdf/src/template-recipe.test.ts` (new)
- `packages/pdf/src/template-authoring-runtime.test.ts` (new characterization tests)
- `packages/pdf/src/template-preview.ts`
- `packages/pdf/src/internal.ts`
- `packages/pdf/src/index.browser.ts` only for intentionally public host seams
- `packages/pdf-compiler-browser/src/template-composition-v4.test.ts` (new)
- `apps/cli/src/commands/pdf-template.ts`
- `apps/cli/src/commands/pdf-template.test.ts`
- `apps/cli/src/commands/pdf-template-yaml.ts` (new host filesystem adapter)
- `apps/cli/src/commands/pdf-template-yaml.test.ts` (new)
- `apps/cli/src/commands/export-pdf.e2e.test.ts`
- `apps/cli/package.json` and `bun.lock` for a direct YAML-parser dependency if
  the CLI does not already declare one
- generated API reports/snapshots only when their owning checks require them
- user/reference documentation for YAML recipe creation and validation

### Explicitly out of scope

- changes to Confluence title acquisition, ADF conversion, or
  `packages/pdf/src/serialize.ts` title semantics;
- arbitrary Typst source in a pack or YAML recipe;
- an unconstrained element tree, coordinate-language, expressions, scripts, or
  custom renderer callbacks in YAML;
- arbitrary SVG-path text clipping;
- changing the pinned Typst/WASM version;
- automatic DOCX inference of Type Cut or brand-lockup compositions;
- automatic migration of existing durable DOCX authoring projects from
  catalog V1 to V2;
- browser Studio UI, Figma/Canva import, font upload, or new corporate fonts;
- committing supplied customer PDFs, Mayflower asset files, live tenant IDs,
  generated private packs, PDFs, or raster previews;
- pushing, releasing, or opening a PR without explicit operator instruction.

## Drift check before implementation

Run before T0:

```bash
rtk git status --short
rtk git rev-parse --short HEAD
rtk git diff --stat cbd7ecea..HEAD -- \
  packages/template-pack \
  packages/pdf \
  packages/pdf-compiler-browser \
  apps/cli/src/commands/pdf-template.ts \
  apps/cli/src/commands/export-pdf.e2e.test.ts
rtk rg -n "PDF_CANONICAL_SOURCE_REVISION|PDF_TEMPLATE_CAPABILITIES_V1|createAtlcliTypstTemplate|closingPage" \
  packages/template-pack packages/pdf apps/cli
```

**STOP:** If the pack engine API no longer is `wiki.pdf-template/v1`, canonical
revision 4 is already allocated, the capability-catalog digest scheme changed,
or the renderer no longer owns `atlcli.typ`, update this plan before coding.

## Commands and expected success

Always run tests through the repository wrapper, never bare `bun test`.

| Purpose | Command | Expected result |
|---|---|---|
| Focused contract tests | `rtk bun run test packages/template-pack/src/design.test.ts packages/template-pack/src/manifest.test.ts packages/template-pack/src/recipe.test.ts` | exit 0; all tests pass |
| Focused PDF tests | `rtk bun run test packages/pdf/src/design-catalog.test.ts packages/pdf/src/template.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/font-requirements.test.ts packages/pdf/src/template-recipe.test.ts` | exit 0; all tests pass |
| Real renderer proof | `rtk bun run test packages/pdf-compiler-browser/src/template-composition-v4.test.ts` | exit 0; real Typst-WASM compile, Poppler text/raster assertions pass |
| CLI YAML path | `rtk bun run test apps/cli/src/commands/pdf-template-yaml.test.ts apps/cli/src/commands/pdf-template.test.ts` | exit 0; YAML build and diagnostics pass |
| API closure | `rtk bun run test scripts/api-report.test.ts` | exit 0; no API closure/report drift |
| Browser dependency gate | `rtk bun run check:browser` | exit 0; no Node/Bun imports in browser entries |
| Type safety | `rtk bun run typecheck` | exit 0; no diagnostics |
| Build | `rtk bun run build` | exit 0 |
| Full suite | `rtk bun run test` | exit 0; no unexpected skips or failures |
| Diff hygiene | `rtk git diff --check` | exit 0; no whitespace errors |

## Task dependency graph

```text
T0 Typst spike
 ├──► T1 design/recipe contracts
 │      ├──► T2 catalog V2 + revision registry
 │      │      ├──► T3 Type Cut renderer
 │      │      └──► T4 closing-page renderer
 │      └──► T5 YAML recipe materializer
 ├──────────────────────────────► T6 CLI YAML authoring path
 T3 + T4 + T5 + T6 ─────────────► T7 real compiler/raster/browser proof
 T7 ─────────────────────────────► T8 docs + live DOCSY acceptance
```

## Technical implementation tasks

### T0 — Prove the pinned Typst primitives before extending contracts

T0 is an isolated primitive/feasibility proof only. Its hand-written Typst
probe is not real PDF acceptance evidence. T7/T8 must produce every acceptance
PDF through the public atlcli YAML build and
`wiki export --format pdf --template` paths.

**Proven formulation:** Typst 0.14.2 renders
`gradient.linear(..., relative: "parent").sharp(2)` with a stable hard
boundary when the single title content value is rendered in a fixed-size
parent block. The three-tier fitting measurement uses an auto-height version
of that same title block; only the selected fixed-height block is emitted.

**Implementation**

- [x] Create a disposable or committed neutral compiler test in
      `packages/pdf-compiler-browser/src/template-composition-v4.test.ts` that
      compiles a fixed A4 page with a single multiline title, a hard two-color
      gradient fill, and `relative: "parent"` using the pinned Typst-WASM and
      bundled fonts.
- [x] Try `.sharp(2)` first. If it does not produce a stable hard boundary in
      Typst 0.14.2, use two repeated stops. Record the selected form in a test
      comment and in this plan before proceeding.
- [x] Prove a fixed-height title frame can be measured and assigned one of
      three font-size tiers without duplicating `meta.title`.
- [x] Compile one-, two-, three-, and deliberately overlong-title fixtures.
      The first three must fit. The overlong fixture must fail through the
      planned explicit guard, not through an opaque Typst panic.
- [x] Use `pdftotext -layout` to prove each successful PDF contains the full
      title once. Do not use raw PDF byte substring matching as the semantic
      oracle.
- [x] Rasterize the cover with `pdftoppm` and assert both title colors occur on
      opposite sides of the expected diagonal. Include a negative fixture with
      a shifted cut so the oracle demonstrably fails.
- [x] Prove an HTTPS link with a Unicode legal string compiles and extracts as
      text. This is a compiler feasibility check, not renderer implementation.

**Verify**

```bash
rtk bun run test packages/pdf-compiler-browser/src/template-composition-v4.test.ts
```

Expected: exit 0; six tests pass using
`typst.ts 0.7.0 / Typst 0.14.2`: compiler pin, three fitting/extraction cases,
the deliberate overflow guard, and the hard-boundary test with its shifted-cut
negative control.

**STOP:** If the pinned compiler cannot render a single semantic title with a
stable hard boundary across multiple lines, stop and report. Do not substitute
duplicate text layers, raster text, arbitrary clipping, or a Typst upgrade.

### T1 — Add bounded composition and YAML-recipe contracts

**Implementation**

- [x] Add the composition types, enum constants, defaults, and validators to
      `packages/template-pack/src/design.ts` exactly as described under
      “Target declarative contract.” Follow the optional-mode pattern already
      used by `features.header.mode`: reject invalid explicit values and keep
      absence distinguishable from an explicit value.
- [x] Add `websiteLabel`, `websiteUrl`, and `legalNotice` to
      `DesignBranding`. Implement a dedicated HTTPS validator for
      `websiteUrl`; a generic safe-string check is insufficient for a link
      target.
- [x] Bound all strings and numbers. Reject control characters, non-finite
      numbers, unsupported schemes, usernames/passwords in URLs, fragments if
      the product does not need them, and stray configuration that would be
      ignored by the selected composition kind.
- [x] Add optional document label `coverEyebrow` without making it mandatory
      for V1 packs. Split the localization vocabulary into required V1 labels
      and supported optional labels; preserve the old required set exactly.
- [x] Add `packages/template-pack/src/recipe.ts` with
      `WikiPdfTemplateRecipeV1` and `validatePdfTemplateRecipeV1(unknown)`.
      This module validates structured data only and performs no filesystem IO.
- [x] The recipe validator must reject renderer-generated fields, unknown keys,
      raw source/code fields, unsafe asset paths, invalid slot identities, and an
      invalid portable design shape. Catalog-V2 completeness and asset/design
      cross-references belong to the PDF materializer in T5; do not introduce a
      `@atlcli/template-pack` → `@atlcli/pdf` dependency. Duplicate YAML keys
      are rejected by the parser adapter in T6; a parsed object cannot retain
      that source-level fact.
- [x] Export the pure types/validators from `index.browser.ts`; preserve the
      browser-safe dependency graph.
- [x] Add positive and boundary tests in `design.test.ts`,
      `localization` tests, `manifest.test.ts`, and `recipe.test.ts`.
- [x] Add negative tests for unsafe URLs, injected Typst-like strings,
      non-finite angle/stop values, missing conditional fields, stray Type Cut
      data on a standard cover, and brand-lockup visibility without content.
- [x] Regenerate and verify the template-pack and transitively affected PDF API
      reports and closure classifications.

**Verify**

```bash
rtk bun run test packages/template-pack/src/design.test.ts packages/template-pack/src/manifest.test.ts packages/template-pack/src/recipe.test.ts
rtk bun run check:browser
```

Expected: 66 focused tests pass; the old required localization set is
unchanged, new optional copy resolves when present, and no Node/Bun import
enters the template-pack browser graph. Typecheck, build, and the API-report
guard also exit 0.

### T2 — Introduce capability catalog V2 and revision-aware compatibility

**Implementation**

- [x] Preserve `PDF_TEMPLATE_CAPABILITIES_V1`,
      `PDF_TEMPLATE_CAPABILITY_DIGEST_V1`, and the V1 presentation revision
      byte-for-byte.
- [x] Add catalog/presentation V2 with the composition, branding, typography,
      color, and layout leaves listed above. Give every descriptor exactly one
      renderer consumer and one presentation classification or details-only
      classification.
- [x] Pin and assert the V2 catalog digest and presentation revision in
      `design-catalog.test.ts`; include guards that V1 values did not change.
- [x] Replace single global catalog assumptions in renderer helpers with an
      explicit catalog argument or versioned V1/V2 helper. A V1 path must never
      read V2-only leaves.
- [x] In `template-pack.ts`, add canonical revision 4 and a closed
      revision-to-catalog registry. Reject unknown revisions and mismatched
      revision/catalog pairs with stable error reasons.
- [x] Keep the exact `canonicalSourceFor` branches for revisions 1–3. Add a new
      revision-4 branch rather than modifying prior branches or default options.
      At the T2 boundary the branch rejects canonical generation explicitly
      until T3 installs the renderer; it must never ignore declared composition
      data or silently render the old cover.
- [x] Add compatibility tests that load known revision-1/2/3 packs and compare
      regenerated canonical source to their existing bytes.
- [x] Add negative tests: revision 4 + V1 digest, revision 3 + V2 digest,
      correct id/version with wrong digest, missing V2 conditional values, and
      unsupported revision 5.
- [x] Keep the current DOCX authoring runtime explicitly pinned to V1/revision
      3. Add a code comment and assertion so a future alias change cannot migrate
      durable projects accidentally.
- [x] Regenerate and verify the PDF API report and closure classification.

**Verify**

```bash
rtk bun run test packages/pdf/src/design-catalog.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/template-authoring-runtime.test.ts
```

Expected: 34 tests pass; V1 digest/revisions remain unchanged, the V2/revision-4
manifest contract validates, its pre-T3 canonical-generation guard is explicit,
and every catalog/revision mismatch fails before Typst compilation. Typecheck,
browser build, full build, and the API-report guard also exit 0.

**STOP:** If preserving revisions 1–3 requires changing their canonical source
or re-baselining existing PDFs, stop and split a migration plan. Compatibility
is not traded for this visual feature.

### T3 — Implement canonical revision-4 Type Cut cover rendering

**Implementation**

- [x] Add a revision-4 renderer path in `packages/pdf/src/template-v4.ts` selected
      only by the canonical generator. Do not alter the source returned for
      revisions 1–3.
- [x] Read the validated cover composition through catalog V2. `standard`
      emits the characterized cover; `type-cut` emits the new fixed-frame title
      composition.
- [x] Apply the T0-proven hard gradient to one `meta.title` text object using
      the declared foreground/inverse colors, angle, and stop.
- [x] Implement the three-tier title fitting guard. Keep title wrapping natural
      and ensure the gradient coordinate space remains the fixed title frame,
      not each individual line.
- [x] Respect `compositions.cover.logo`; Type Cut must not infer visibility from
      whether `asset.logo` exists.
- [x] Keep the cover-background asset in the existing validated decoration path
      (`asset.coverBackground`, scope `first`, page-background layer). Do not
      add a private image loader or inline data URL.
- [x] Use the optional localized `coverEyebrow` when present; fall back to the
      existing space label when absent.
- [x] Emit all numbers as validated finite literals and all text via
      `typstString`; no YAML string may enter generated source unescaped.
- [x] Add source-level tests for the single title emission, mode branches,
      exact config values, optional eyebrow fallback, logo visibility, and
      injection resistance.

**Verify**

```bash
rtk bun run test packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/template-pack.test.ts
```

Expected: exit 0; revision 4 contains the declared Type Cut geometry and one
title object, while revisions 1–3 remain byte-identical.

Supplemental component proof (not final PDF acceptance):

```bash
rtk bun run test packages/pdf-compiler-browser/src/template-composition-v4-renderer.test.ts
```

Expected: the production revision-4 source compiles with the pinned
Typst-WASM, including the declared repeated hard stops and fitting guard. T7
still owns acceptance through the public atlcli build/export chain.

### T4 — Implement the fully declarative closing-page renderer

**Implementation**

- [x] Parse and emit `features.closingPage.enabled` in revision-4 settings.
      When false, do not append a page break or closing page.
- [x] Keep `document-summary` as the revision-4 equivalent of the existing
      closing page, driven by its current roles/tokens/labels.
- [x] Add `brand-lockup` using only catalog-V2 values and validated runtime
      assets. The renderer must not synthesize organization copy, website copy,
      URL, copyright glyph, year, or legal wording.
- [x] Emit logo, website, and legal notice independently according to their
      YAML visibility values. A hidden item consumes no layout gap.
- [x] Use `asset.logo` only when `logo: show`; require alt text at the existing
      manifest validation boundary. Place it using closing-page design tokens,
      not the existing cover-logo placement.
- [x] Render `websiteLabel` as visible text linked to the validated
      `websiteUrl`. Add a PDF link annotation assertion in the real-compiler
      test; text extraction alone does not prove the link target exists.
- [x] Render `legalNotice` exactly as supplied. Add a test where it does not
      begin with `©` to prove the renderer does not prepend anything.
- [x] Support left/center/right block alignment as a bounded enum and test all
      three at source level; raster proof may focus on left alignment.
- [x] Set the page background from `closingPageBackground` and text from
      `closingBrandText`; never reuse the cover paper or ink implicitly.
- [x] Update `packages/pdf/src/font-requirements.ts` so enabled brand-lockup
      website/legal copy participates in demand-aware font selection, disabled
      closing pages do not require closing-only roles, and brand-lockup does not
      request the document title through `closingTitle`. Add regression tests
      including the `©` glyph and a Unicode legal string.
- [x] Add tests for every visibility combination, absent required content,
      Unicode copy, escaped adversarial strings, disabled closing page, and
      stable standard summary mode.

**Verify**

```bash
rtk bun run test packages/template-pack/src/design.test.ts packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/font-requirements.test.ts packages/pdf/src/template-pack.test.ts
```

Expected: exit 0; no brand literal appears in renderer source, disabled means
zero closing page, and each visible item is controlled independently by YAML
data.

The supplemental production-source compiler test from T3 also proves that
disabling the closing page removes exactly one PDF page and that `pdfinfo
-url` observes the declared HTTPS target as a real link annotation. It remains
component evidence; T7/T8 own public atlcli-pipeline acceptance.

**Machine guard**

```bash
rtk rg -n "Mayflower|mayflower\.de|© Mayflower" packages/pdf packages/template-pack
```

Expected: no matches outside neutral test comments that explicitly assert the
absence of hardcoding. Prefer keeping even those literals only in a disposable
live recipe so the command returns no matches.

### T5 — Materialize a V2/revision-4 pack from a validated recipe

**Implementation**

- [x] Add `packages/pdf/src/template-recipe.ts` with a host-neutral function
      that accepts a validated recipe plus already-resolved asset bytes. Reuse
      existing descriptor, hash, dimension, SVG-safety, budget, VFS, canonical
      source, pack, and compile-proof code instead of duplicating it.
- [x] Refactor private helpers from `template-authoring-runtime.ts` only when
      necessary into a shared PDF-internal module. Preserve current DOCX
      materializer behavior with characterization tests before moving logic.
- [x] Generate the exact catalog V2 and revision-4 references; YAML cannot
      override them.
- [x] Generate deterministic asset descriptor IDs and archive paths from slots
      and content digests. Recipe filenames must not become executable VFS paths.
- [x] Validate cross-object requirements after asset resolution: Type Cut
      background present and first-page-scoped; brand logo present when shown;
      no unreferenced assets; media type matches bytes; SVG passes the existing
      safety gate.
- [x] Generate canonical Typst only after the complete design and visuals have
      passed validation. Re-run `validatePdfTemplatePack` against the resulting
      files before packing.
- [x] Add a composition-aware executable proof profile. Unlike the current
      neutral proof compiler, it must leave cover and closing page enabled and
      use titles at all three fitting tiers.
- [x] Guarantee no output bytes are returned when validation or compilation
      fails.
- [x] Test deterministic warm repeats, key-order independence, CRLF/LF YAML
      equivalence after parsing, asset-order independence, tampered hashes,
      unsafe SVG, missing logo/background, and compile failure.

**Verify**

```bash
rtk bun run test packages/pdf/src/template-recipe.test.ts packages/pdf/src/template-authoring-runtime.test.ts packages/pdf/src/template-pack.test.ts
```

Expected: exit 0; two semantically identical recipes produce byte-identical
packs, old DOCX materialization stays unchanged, and every invalid recipe fails
before an archive is returned.

The proof compiler now exercises revision 4 with cover and closing page enabled
across three deterministic title tiers. Unit tests characterize profile
selection and failure atomicity; the existing real BrowserPdfCompiler component
test remains green. This is still component evidence. T7/T8 retain ownership of
the public `atlcli pdf-template build` → `atlcli wiki export` acceptance chain.

### T6 — Add the CLI YAML build path with safe local asset resolution

**Implementation**

- [x] Add `apps/cli/src/commands/pdf-template-yaml.ts` as the only filesystem
      adapter. Parse YAML with a directly declared dependency; do not rely on a
      transitive dependency from `@atlcli/core` or `@atlcli/confluence`.
- [x] Use strict parser options: core schema, unique keys, no custom tags,
      aliases/merge disabled, and documented resource bounds. Convert parser
      diagnostics into stable `ATLCLI_ERR_VALIDATION` output with YAML line,
      column, and normalized contract path when available.
- [x] Resolve asset sources relative to the recipe directory. Use realpath/lstat
      checks to prevent `..`, absolute paths, and symlinks from escaping that
      directory. Read only after recipe shape validation and enforce aggregate
      byte budgets before hashing.
- [x] Extend `atlcli pdf-template build` and `validate` to accept either an
      existing authoring project directory or a `.yaml`/`.yml` recipe. Dispatch
      by stat + extension, not by catching arbitrary project-load errors.
- [x] Keep `import`, `review`, `preview`, and `undo` project-only. Error output
      must explain that YAML recipes are direct declarative builds and do not
      have DOCX decision history.
- [x] Add `--output` behavior matching current pack builds. Write to a temporary
      sibling and publish with an atomic same-filesystem no-clobber operation
      only after validation, compilation, and packing pass; preserve an existing
      output on failure.
- [x] Add `--json` result fields for recipe path, catalog version, canonical
      revision, pack digest, compile digest, and page count. Do not include
      absolute asset paths or YAML content.
- [x] Update help with a minimal recipe command and the trust boundary:
      `atlcli pdf-template build ./template.yaml --output ./brand.wiki-pdf-template`.
- [x] Add tests for valid YAML, malformed YAML, duplicate keys, custom tags,
      aliases, path traversal, symlink escape, asset budget, unknown fields,
      invalid URL/legal combinations, existing output preservation, JSON
      redaction, deterministic repeats, and `.yml` parity.

**Verify**

```bash
rtk bun run test apps/cli/src/commands/pdf-template-yaml.test.ts apps/cli/src/commands/pdf-template.test.ts
```

Expected: exit 0; a neutral YAML recipe builds a verified pack, every unsafe
input fails with a stable path, and failure never clobbers the target archive.

The public `atlcli pdf-template build` command now builds and reloads a neutral
revision-4 pack with the pinned production compiler. This proves the CLI recipe
adapter and pack boundary, but it is not PDF acceptance: T7/T8 still own the
required public `atlcli wiki export --format pdf --template ...` evidence.

### T7 — Prove real compiler, text, raster, link, browser, and pack parity

**Implementation**

- [ ] Complete `template-composition-v4.test.ts` as a full pack test: YAML
      recipe data → recipe validator → V2/revision-4 materializer → pack loader
      → serializer → real `BrowserPdfCompiler`.
- [ ] Use a synthetic A4 SVG with a mathematically known straight orange edge
      and a neutral SVG logo. Do not commit Mayflower or customer material.
- [ ] Assert the final PDF is tagged, has embedded fonts and expected outline,
      and has exactly `body pages + cover + closing` pages when both are on.
- [ ] Assert disabling the closing page removes exactly one page and disabling
      the cover removes exactly one page.
- [ ] Use `pdftotext -layout` to assert the title appears exactly once on the
      cover and not on `brand-lockup`; website and legal notice appear exactly
      once on the closing page.
- [ ] Inspect PDF annotations to prove the website target equals the declared
      HTTPS URL and no undeclared URL is present.
- [ ] Rasterize cover and closing pages. Assert the title foreground/inverse
      pixels track the synthetic diagonal within a documented tolerance, the
      closing background and alignment match tokens, and hidden elements leave
      no pixels/text.
- [ ] Add a deliberate shifted-diagonal and shifted-closing-block negative to
      guard the visual oracle itself.
- [ ] Add a browser-harness conformance case if the CLI recipe materializer
      exposes a new public DTO; otherwise prove the resulting pack through the
      existing browser pack-loader/export case. Node and browser pack bytes,
      runtime snapshot, PDF bytes, and reports must agree.
- [ ] Run API closure, browser dependency, typecheck, build, and the full suite.

**Verify**

```bash
rtk bun run test packages/pdf-compiler-browser/src/template-composition-v4.test.ts
rtk bun run build:browser-export-harness
rtk bun run test:browser-export-harness
rtk bun run assert:conformance-cases
rtk bun run check:parity
rtk bun run test scripts/api-report.test.ts
rtk bun run check:browser
rtk bun run typecheck
rtk bun run build
rtk bun run test
rtk git diff --check
```

Expected: every command exits 0; no unexpected skip hides the composition test,
and Node/browser hosts agree on the validated pack and PDF output.

### T8 — Document and live-test the Mayflower recipe without persisting private data

**Implementation**

- [ ] Add task-first documentation under `src/content/docs/` for: prerequisites,
      a minimal YAML recipe, full field reference (type/default/required/bounds),
      asset preparation, build/validate commands, examples, errors,
      troubleshooting, security model, and related topics.
- [ ] Document clearly that `.wiki-pdf-template` archives contain generated
      JSON even when authored from YAML.
- [ ] Document all closing-page fields. State explicitly that copyright/legal
      text is not generated: users supply the exact desired string.
- [ ] Add a local-only Mayflower YAML recipe in a disposable directory using
      the approved logo/background assets. Do not add it or its outputs to git.
- [ ] Build the pack twice and compare SHA-256 digests. Load both through
      `loadPdfTemplatePack` and confirm V2/revision 4 and the exact declarative
      values.
- [ ] Render synthetic titles covering one, two, three, and long lines. Inspect
      the cover and closing-page rasters at 144 dpi. Record only non-sensitive
      pass/fail evidence; do not commit the source PDF, customer title, asset
      bytes, absolute paths, or screenshots.
- [ ] Extend `apps/cli/src/commands/export-pdf.e2e.test.ts` with an optional
      environment-provided recipe or pack path. The live test reads one retained
      page in space `DOCSY` via profile `mayflower`, exports through the same
      production CLI path, and deletes all local artifacts in `finally`.
- [ ] If the test creates a temporary Confluence page to exercise multiple
      title lengths, use the existing `apps/cli/src/e2e/` ownership marker,
      scope breakers, and `finally` cleanup. Prove deletion before considering
      the task complete.
- [ ] Never persist the retained page ID, tenant URL, token, customer content,
      local recipe path, or produced PDF in the spec, fixtures, logs, commit, or
      PR text.

**Offline verification**

```bash
rtk bun run docs:check
rtk bun run docs:build
rtk bun run test apps/cli/src/commands/pdf-template-yaml.test.ts packages/pdf-compiler-browser/src/template-composition-v4.test.ts
```

Expected: documentation and tests pass with no private input.

**Live verification**

```bash
rtk env ATLCLI_E2E=1 \
ATLCLI_E2E_PAGE_ID=<retained-DOCSY-page> \
ATLCLI_E2E_PROFILE=mayflower \
ATLCLI_E2E_PDF_TEMPLATE_RECIPE=<absolute-local-recipe.yaml> \
bun run test apps/cli/src/commands/export-pdf.e2e.test.ts
```

Expected: exit 0; the recipe builds, the retained DOCSY page exports through the
production PDF CLI with the generated pack, the PDF is tagged and outlined,
cover/closing page count and extracted text match the recipe, and no remote or
local test resource remains unintentionally.

## Test matrix

| Layer | Required cases |
|---|---|
| Design contract | defaults, all enums, angle/stop bounds, HTTPS URL, Unicode legal copy, conditional requirements, unknown/dead fields |
| YAML parser | valid YAML, duplicate keys, aliases, custom tags, deep nesting, oversized scalar/list/map, malformed syntax |
| Filesystem adapter | relative path, traversal, absolute path, symlink escape, missing file, aggregate budget, existing-output preservation |
| Catalog compatibility | V1 digest unchanged, V2 digest pinned, rev1–3/V1 load, rev4/V2 load, every mismatched pair rejected |
| Canonical source | rev1–3 exact parity, one Type Cut title, finite literals, escaped strings, no brand literals |
| Cover renderer | standard, Type Cut, logo show/hide, optional eyebrow, 1/2/3/long titles, diagonal positive/negative raster oracle |
| Closing renderer | disabled, document-summary, brand-lockup, 8 visibility combinations, 3 alignments, literal legal copy, exact HTTPS link |
| Pack | deterministic repeat, reordered YAML/object keys, reordered assets, hash tamper, unsafe SVG, missing/extra asset |
| Compiler | real Typst-WASM, tagged PDF, outline, embedded fonts, expected page count, text exactly once, link annotation |
| Hosts | CLI JSON/human output, Node/browser parity, browser dependency graph |
| Live | retained DOCSY read/export, production CLI/template flag, disposable artifacts, optional owned-page cleanup |

## Definition of done

- [ ] A template owner can express Type Cut and the complete brand-lockup
      closing page in YAML without changing TypeScript or Typst.
- [ ] `© Mayflower GmbH`, any alternative legal string, the website label/URL,
      logo visibility, and closing-page placement are pack configuration, not
      renderer literals.
- [ ] The cover title is searchable/selectable and appears exactly once in PDF
      text extraction for every supported length tier.
- [ ] `features.closingPage.enabled: false` removes the closing page in revision
      4 without changing revision-1/2/3 output.
- [ ] V1 catalog digest and revision-1/2/3 canonical source remain unchanged.
- [ ] V2/revision-4 mismatches and incomplete compositions fail before Typst.
- [ ] YAML cannot inject Typst, escape its recipe root, use unsafe SVG, exceed
      budgets, or clobber an existing output after failure.
- [ ] A real pinned Typst-WASM test proves the cover, closing page, text, link,
      page count, raster geometry, and negative oracles.
- [ ] CLI and browser hosts load and render the same generated pack.
- [ ] The full repository tests, typecheck, browser gate, build, docs, API
      closure, and diff hygiene pass.
- [ ] A live `mayflower`/`DOCSY` export passes through the production CLI path,
      with no private identifiers/artifacts committed and all created resources
      cleaned up.
- [ ] No push or release occurs without explicit operator instruction.

## STOP conditions

Stop and report instead of improvising if any of these occurs:

- the pinned Typst compiler cannot implement a stable single-text Type Cut;
- revision 4 or capability catalog version 2 is already allocated differently;
- supporting V2 requires changing the outer `wiki.pdf-template/v1` API;
- revisions 1–3 cannot remain byte-stable;
- a proposed YAML field would require arbitrary Typst, executable expressions,
  or an unconstrained element tree;
- link-target validation cannot be restricted to HTTPS before source emission;
- the logo/background assets require a new executable media decoder or bypass
  existing SVG/asset safety gates;
- the real compiler/raster test has to be skipped in normal CI;
- live verification would require persisting a tenant/page identifier or using
  a space other than `DOCSY`;
- implementation touches any explicitly out-of-scope source path for reasons
  not documented by a plan amendment.

## Git workflow for implementation

- Create branch `codex/pdf-template-composition-renderer` from the reviewed
  baseline when implementation starts.
- Use conventional commits and keep logical proof boundaries separate, for
  example:
  - `feat(template-pack): add declarative page compositions`
  - `feat(pdf): add canonical composition renderer v4`
  - `feat(cli): build PDF template packs from YAML`
  - `test(pdf): prove Type Cut and closing-page rendering`
  - `docs(pdf): document YAML composition recipes`
- Run the focused verification for each task before committing that logical
  unit.
- Run the complete Definition-of-done command set and the live E2E before the
  final implementation commit.
- Do not push, release, or open a PR unless the operator explicitly requests it.

## Deferred follow-ups

- Migrate durable DOCX authoring projects and accepted decisions from catalog
  V1 to V2 with an explicit migration/reanalysis UX.
- Add composition controls to a browser template Studio.
- Add further bounded composition kinds only when a real design cannot be
  represented by `standard`, `type-cut`, `document-summary`, or
  `brand-lockup`.
- Evaluate localized legal notices if one pack must emit materially different
  legal copy by document locale. Until then, `branding.legalNotice` is exact
  pack data and intentionally locale-independent.
- Evaluate separate logo assets per page role if a future template needs both
  a cover mark and a different closing lockup. This slice reuses `asset.logo`
  because the selected Type Cut cover explicitly hides the logo.

## Unresolved questions for product review

1. Should fragments be allowed in `branding.websiteUrl`? Recommended answer:
   no for V1 of the recipe; permit only absolute HTTPS URLs without credentials.
2. Should `legalNotice` later become locale-specific? Recommended answer: not
   in this slice; keep exact literal pack data until a real multilingual legal
   requirement exists.
3. Should the existing DOCX authoring flow move to catalog V2 immediately?
   Recommended answer: no; ship and prove the YAML renderer first, then plan a
   migration that preserves durable decisions explicitly.
