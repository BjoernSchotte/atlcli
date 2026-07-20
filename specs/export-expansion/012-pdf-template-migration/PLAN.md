# 012 — PDF template migration: design tokens into the manifest

Status: Plan, 2026-07-19. Folder `specs/export-expansion/012-pdf-template-migration`.
Distilled scope, not a copy — see the provenance note at the end of this
document for the source draft this folder replaces.

## Reference

- `specs/export-expansion/007-pdf-template-settings/PLAN.md` — this folder's
  hard prerequisite. 007 ships the `wiki.pdf-template/v1` contract's Level-A
  surface (`PdfTemplateSettings`, page/orientation/cover/outline/header/
  footer/accent/organization/logo/watermark), the `.wiki-pdf-template`
  container (`packages/template-pack/`), the `TemplateLibrary` abstraction
  (`packages/core/src/template-library.ts`), and — per its T2.5 — a
  hardcoding ledger (either
  `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md` or
  an equivalent comment block in `packages/pdf/src/template.ts`) plus a
  lint-stub script (`packages/pdf/scripts/check-hardcoding-ledger.ts`) this
  folder inherits as its migration inventory.
- `specs/export-expansion/007-pdf-template-settings/TEMPLATE-UX.md` — only
  §7 (minimal template contract) and §9 (security/reproducibility) are
  normative for the `export-expansion` series; §5/§6 (product levels,
  wireframes) are vision this folder does not implement wholesale, but §9.5
  (logo/asset security) and the general shape of §5.1/§5.2 (curated
  templates, settings form) inform this folder's manifest design.
- `specs/export-expansion/011-quality-gates/PLAN.md` — this folder's parity
  proof runs through 011's conformance harness: the digest-equality
  machinery (`apps/browser-export-harness/scripts/check-parity.ts`,
  `apps/browser-export-harness/tests/exports.e2e.ts`) and the `pdf-settings`
  conformance case are reused, not reimplemented, for the before/after
  default-output-parity gate below.
- `packages/pdf/src/template.ts` / `serialize.ts` — the hot files this
  folder migrates off hardcoded presentation literals; current state is
  whatever 007 leaves behind (page geometry, section toggles, header/footer,
  accent, organization, logo, watermark already threaded as `settings`;
  everything else — typography roles, color tokens, semantic palettes,
  component spacing/layout — still hardcoded, per 007's T2.5 ledger).
- `specs/export-expansion/009-package-publishing/PLAN.md` — the `atlcli`
  product name is likely to be renamed (§"Deferred: npm registry
  publishing"); this folder's manifest/contract identifiers use the
  `wiki.*`/`com.acme.*`-style namespacing already adopted by 007 rather than
  `@atlcli/*`, so this folder does not need to be revisited when the
  product-rename decision lands — see Risks.

## Goal & user value

007 makes the built-in PDF template *configurable* (Level A: geometry,
toggles, header/footer, accent, organization, logo, watermark). This folder
makes it *replaceable*: the remaining hardcoded presentation of the
built-in template — typography, color tokens, semantic palettes, component
spacing — moves into `wiki.pdf-template/v1` manifest data, so a second
curated template can exist without forking `template.ts`, and so a future
Level-B custom template has a real design contract to target instead of an
implicit one baked into TypeScript control flow.

1. **A complete design model in the manifest.** Page, features, branding,
   typography roles, color tokens, semantic palettes, and per-component
   layout all become typed, validated manifest fields — not because every
   field becomes end-user editable in this folder, but because the
   built-in template's presentation becomes fully declarative and
   reviewable as data.
2. **An enforced boundary between manifest data and engine code.** A
   hardcoding-migration ledger (inherited from 007, extended here to
   completion) plus an automated audit prove that no new presentation
   literal re-enters `template.ts`/`serialize.ts` outside a small, reviewed
   engine-invariant allowlist.
3. **Proven non-regression.** The built-in template's default output
   (Editorial-Indigo-equivalent, whatever the current built-in is named) is
   byte- or raster-identical before and after the migration, gated by 011's
   existing parity harness rather than a new one.
4. **A second curated template that proves the abstraction.** A visually
   distinct built-in template renders through the same manifest schema and
   passes the same correctness/parity fixtures, with no template-ID
   conditionals in engine code.
5. **A localization data model.** The manifest gains a `localization` shape
   (default/fallback locale, per-locale document labels and UI copy) as a
   data structure; consuming it in a host UI is folder 010's job, not this
   folder's.
6. **The point where 007's direct `.at()` reads retire.** A `bindings`
   layer (explicit, typed setting→design-field mappings, validated against
   an allowlist of target paths) replaces `template.ts`'s current direct
   `settings.at("accent-color", default: ...)`-style reads with resolved
   design values assembled by the settings resolver.

## Dependencies

- **Hard prerequisite: folder 007 merged.** This folder consumes 007's
  container format, `TemplateLibrary`, the `wiki.pdf-template/v1` Level-A
  settings surface, and the hardcoding ledger/lint-stub from 007's T2.5 as
  its migration inventory — it does not re-derive that inventory from
  scratch. Do not start implementation tasks below before 007's Definition
  of Done is met.
- **File ownership — hot files, same convention as `UMSETZUNGSPLAN.md`'s
  hot-file table:** `packages/pdf/src/template.ts` and
  `packages/pdf/src/serialize.ts` are this folder's hot files, inherited
  from 007 (which owns them through its own landing). This folder is the
  next and, for the scope below, final owner of the presentation-literal
  content of both files — after this folder lands, neither file should
  contain a design value outside the reviewed engine-invariant allowlist.
  No other lane touches these files during this folder's implementation
  window; coordinate through the same rebase discipline 007 established
  for the T3.3 exception.
- **Extension UI is explicitly out of scope, delegated to folder 010.**
  This folder ships the manifest schema, the resolver, the settings→
  bindings allowlist, and the second curated template as engine/library
  work (`packages/pdf`, `packages/template-pack`, `packages/core`). Any
  panel UI for selecting a template, editing settings, or displaying
  localized labels is `010-extension-integration/PLAN.md`'s T5.2 — this
  folder produces the data shapes T5.2 consumes, it does not build a UI.
- **PR #48's "no archive format in this slice" deferral does not carry
  over — it is superseded.** The closed draft PR #48 (see provenance note)
  deferred the `.wiki-pdf-template` container to a follow-up because no
  archive format existed yet at the time it was written. 007 already ships
  that container (`packages/template-pack/`, T2.4). This folder therefore
  does **not** re-open or re-scope the container format; it only adds
  manifest fields the existing container already knows how to carry
  (`schemaVersion` stays compatible via additive fields, per 007's Risks
  entry on settings schema versioning).
- **011's conformance harness must have landed its `pdf-settings` case**
  (007's dependency, inherited here) before this folder's default-parity
  gate can run — the gate reuses `check-parity.ts`, it does not build a
  parallel comparison mechanism.

## Architecture

**The manifest becomes the single source of presentation truth for a
built-in template; `template.ts` becomes a consumer, not an author, of
design values.**

```
manifest (design + typography + tokens + semanticPalettes + components
          + localization + assetSlots + requiredFonts, per 007's T2.4
          schema plus this folder's additive fields)
   │
   ▼
resolvePdfSettings(options)                      (packages/pdf/src/settings.ts, extended)
   │  1. manifest defaults
   │  2. persisted host values
   │  3. per-export overrides
   │  4. validation + canonical normalization
   │  5. apply declared bindings to an immutable design copy   ◄── new in this folder
   │  6. document-locale selection + label resolution           ◄── new in this folder
   │  7. asset-slot resolution                                  ◄── extends 007's logo slot
   ▼
resolved settings dict: { values, design, labels, assets }
   │  typstSettingsDict(resolved) — same typstString-escaped emission 007 established
   ▼
main.typ: #show: <template>.with(meta: (...), settings: (...))
   │
   ▼
template.ts: reads settings.design.* / settings.labels.* — no more
             hardcoded typography/token/palette/component literals
             outside the engine-invariant allowlist
```

- **Design model** (`WikiPdfTemplateDesignV1`-shaped, TypeScript types in
  `packages/template-pack/src/manifest.ts`, extending 007's manifest
  schema): `page`, `features`, `branding`, `typography`, `tokens`
  (`colors`, `layout`, `contrast`), `semanticPalettes` (`callouts`,
  `statuses`), `components` (paragraph, headings, lists, codeBlock,
  callout, statusBadge, table, header, footer, cover, closingPage). Every
  field is typed and bounded (lengths use a validated unit suffix, colors
  are canonical `#RRGGBB` or token references, ratios are bounded finite
  numbers) — no Typst expressions or raw source fragments accepted
  anywhere in the manifest.
- **Bindings** (`packages/pdf/src/settings.ts`, extending 007's resolver):
  a `bindings` array on the manifest maps a declared `settings` key to one
  or more design-field targets from a versioned allowlist (e.g. `accent`
  setting → `design.tokens.colors.accent`; `cover` setting →
  `design.features.cover.enabled`) with only `identity` or explicit
  `choice-map` transforms — no computed paths, no callbacks, no generic
  object merge. This is the mechanism that replaces 007's direct
  `settings.at("accent-color", ...)` reads in `template.ts`: after this
  folder, `template.ts` reads `settings.design.tokens.colors.accent`
  (already resolved and bound), never a raw Level-A settings key.
- **Localization** (`packages/template-pack/src/manifest.ts`): a
  `localization` map (`defaultLocale`, `fallbackLocale`, per-locale
  `template`/`document`/`settingGroups`/`settings` copy) becomes manifest
  data; `resolvePdfSettings` resolves `labels` (document-facing strings
  like "Version", "Exported", "Contents") for the export's document
  locale. A separate, host-facing `localizeTemplateUi(manifest, uiLocale)`
  pure function resolves UI-facing copy (template name/description,
  setting labels/help) — this is the data folder 010 consumes for a
  generated settings form; this folder does not build the form.
- **Hardcoding audit**: extends 007's T2.5 lint stub
  (`packages/pdf/scripts/check-hardcoding-ledger.ts`) from a heuristic
  grep into an enforced CI check once the ledger is complete — every
  presentation literal in `template.ts`/`serialize.ts` is either resolved
  from `settings.design.*`/`settings.labels.*`, or is a reviewed entry in
  a documented **engine-invariant allowlist** (structural values that are
  not presentation choices — e.g. Typst API argument names, not colors or
  sizes).
- **Everything real, nothing mocked** (same rule as every folder in this
  series): manifest fixtures are real JSON validated by the real
  `validateManifest`; the parity gate compiles real PDFs through the real
  compiler and compares real bytes/rasters via 011's real harness.

## Tasks

### Design model & manifest schema (T6.1)

- [x] `packages/template-pack/src/manifest.ts`: extend 007's manifest
      schema with `design: WikiPdfTemplateDesignV1` (`page`, `features`,
      `branding`, `typography`, `tokens`, `semanticPalettes`,
      `components`, per the Architecture section's field list) and
      `requiredFonts` validation (007's T2.4 declared the field
      shape-only; this folder cross-checks it against the bundled runtime
      font inventory, e.g. `packages/pdf/src/runtime-assets.ts`, and
      rejects an unsatisfiable requirement at import). `validateManifest`
      rejects out-of-bounds lengths/ratios, non-canonical colors, and any
      Typst-source-shaped string in a design field (same "settings are
      data, not code" rule as 007's T2.1, extended to the design model).
- [x] `packages/template-pack/src/manifest.ts`: `bindings:
      WikiPdfTemplateSettingBindingV1[]` — `{ setting, targets, transform?
      }`; `targets` validated against a versioned allowlist of design
      paths; `transform` is `identity` or an explicit `choice-map` —
      reject anything else at validation time, not at render time.
      **Shipped scope (narrowed deliberately):** the allowlist covers
      accent, page size, orientation, cover/outline enabled, outline
      depth, header/footer *enabled*, and organization name.
      Header/footer **text** and the **logo asset + alt** are NOT
      bindable design targets: they are per-export *content and assets*,
      not presentation tokens, so they stay Level-A settings the template
      reads directly (`settings.at("header-text" | "logo" | …)`). The DoD
      requirement — retire 007's direct `.at()` reads "for every field
      covered by a binding" — therefore holds as written.
- [x] `packages/template-pack/src/manifest.ts`: `localization:
      WikiPdfTemplateLocalizationV1` — `defaultLocale`, `fallbackLocale`,
      `locales` map (`template`, `document`, `settingGroups`, `settings`
      copy, per the Architecture section). `validateManifest` requires
      the `fallbackLocale` entry to be complete (non-empty name/
      description, every document label, every declared setting/group/
      option label); other locales may be partial with a lint warning on
      a missing field, never a hard reject.
- [x] Tests: `packages/template-pack/src/manifest.test.ts` (extend) —
      real fixture manifests covering every new field, boundary values
      for lengths/ratios/colors, an incomplete `fallbackLocale` (reject),
      a partial non-fallback locale (accept + warning), a `bindings`
      entry targeting an unknown path (reject), and a `choice-map`
      missing a value for a declared choice option (reject).

### Resolver: bindings, locale, labels (T6.2)

- [x] `packages/pdf/src/settings.ts`: extend `resolvePdfSettings` to the
      seven-step order documented in 007's Risks entry ("Built-in vs.
      manifest settings") — manifest defaults → persisted host values →
      per-export overrides → validation/normalization → **apply declared
      bindings to an immutable design copy** → **document-locale
      selection + label resolution** → asset-slot resolution. Return
      shape gains `design` (fully resolved, bound `WikiPdfTemplateDesignV1`)
      and `labels` (resolved document-facing strings) alongside the
      existing `values`/`assets`.
- [x] `packages/pdf/src/settings.ts`: `applyBindings(design, bindings,
      values)` — pure function, one allowlisted target write per binding,
      duplicate-target-write detection (two bindings writing the same
      path is a validation error, not last-write-wins).
- [x] `packages/template-pack/src/localize.ts` (new): `localizeTemplateUi
      (manifest, uiLocale)` — pure function resolving UI-facing copy
      (template name/description, setting/group/option labels) per the
      locale-fallback chain (exact locale incl. region → base language →
      `defaultLocale` → `fallbackLocale`); this is the function folder
      010 calls to render a generated settings form, not built here.
- [x] `packages/pdf/src/serialize.ts` / `template.ts`: `settings` dict
      emitted to Typst gains `design` and `labels` namespaces alongside
      the existing `values`/`assets`; `typstSettingsDict` (007's emitter)
      extends to serialize the new namespaces with the same
      `typstString`-escaping discipline — no new emission path, one
      escaper for every settings namespace.
- [x] Tests: `packages/pdf/src/settings.test.ts` (extend) — bindings
      resolve to the correct design path; duplicate-target-write is
      rejected; locale resolution follows the four-step fallback chain
      exactly, including a region-specific locale (`de-CH`) falling back
      to base language (`de`); `localizeTemplateUi` returns the fallback
      locale's copy when the requested UI locale doesn't exist.

### Hardcoding migration: built-in template (T6.3)

- [x] Complete 007's T2.5 ledger: extend
      `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`
      (or the `template.ts` comment-block equivalent, whichever 007
      chose) with every remaining presentation literal — typography roles
      per level/role, all color tokens, both semantic palettes, and every
      component's spacing/layout constants — as its own ledger row with a
      manifest destination path, before any migration edit lands. This is
      restatement of current behavior, not new design.
- [x] `packages/pdf/src/template.ts`: replace each ledgered hardcoded
      literal with a read from `settings.design.*`/`settings.labels.*`,
      grouped by ledger category (typography, then tokens, then
      semantic palettes, then components) — each step keeps the built-in
      template's manifest defaults equal to the literal it replaces, so
      output does not change mid-migration.
      **Deviation:** this landed as ONE commit, not the per-category
      series the task asked for. The categories are interdependent (the
      template stops compiling until the whole design object is threaded)
      and the lint could not go green until every category had moved, so
      an intermediate commit would have been red. Reviewability is
      instead carried by the byte-parity proof (T6.4) plus the ledger's
      per-category destination table.
- [x] `packages/pdf/src/serialize.ts`: any presentation literal owned by
      the serializer (not `template.ts`) moves the same way; semantic
      content emission (meta, blocks) is unaffected.
- [x] Built-in manifest for the existing template (name/id per whatever
      007 shipped, e.g. `builtin.<name>`): fixed `schemaVersion`, full
      `design`/`typography`/`tokens`/`semanticPalettes`/`components`/
      `localization` populated from the completed ledger; default setting
      values reproduce today's output exactly — selecting the built-in
      template with no overrides and omitting template selection entirely
      must be equivalent.
- [x] `packages/pdf/scripts/check-hardcoding-ledger.ts` (007's lint stub,
      extended here): once the ledger is complete, flip the check from
      "heuristic warning" to "CI-enforced" — any new bare hex color,
      length literal, or font-family string in `template.ts`/
      `serialize.ts` outside the ledger's recorded set and the engine-
      invariant allowlist fails the build.
- [x] Document the **engine-invariant allowlist**: a short, reviewed list
      (in the lint stub's header comment or a sibling
      `packages/pdf/ENGINE-INVARIANTS.md`) of literals that are
      structurally required by the engine and are not presentation
      choices — e.g. Typst API argument names/keywords, not colors,
      sizes, or copy. Every entry needs a one-line justification; the
      list is reviewed on every addition, not append-only by default.

### Default-output parity (T6.4)

- [x] Capture the pre-migration baseline: compile the built-in template's
      default output (via 011's harness `pdf-settings` conformance case)
      before T6.3's literal-by-literal replacement starts; record the
      sha256 digest and, if the pinned compiler's output isn't perfectly
      byte-stable across the migration (e.g. due to incidental Typst
      source reordering), a rasterized comparison using the same
      perceptual-difference tooling 011's DOCX media-parity check uses,
      adapted to compare full PDF page rasters within a documented
      tolerance.
- [x] After T6.3 completes, re-run the same fixture and assert digest
      equality (preferred) or raster equality within tolerance
      (fallback, only if byte-identity turns out to be infeasible —
      document which one applies and why). A default-output change of
      any kind is a **STOP**: review the exact cause before proceeding,
      never silently accept a new baseline.
- [x] Wire this comparison into `apps/browser-export-harness/scripts/
      check-parity.ts` as an explicit "pre/post migration" mode (or a
      one-off script reusing its digesting/comparison functions) — reuse
      011's existing digest/report-projection machinery rather than
      building a second comparator.
      **Deviation:** `check-parity.ts` was NOT edited. Spec 011 round 2
      owns `apps/browser-export-harness` in this same wave, so touching it
      would have collided. The parity gate instead reuses 011's *approach*
      (the identical `BrowserPdfCompiler` + pinned wasm/fonts path, sha256
      digest equality) as a package-level real-compiler test in
      `packages/pdf-compiler-browser/src/template-migration-parity.test.ts`,
      with `node:crypto` for the digest rather than importing the harness's
      `sha256Hex`. No second *comparator* was built — only a second call
      site for the same technique.
- [x] Tests: a fixture-based regression test asserting the comparison
      script itself rejects a deliberately altered raster (mirrors 011's
      own infrastructure-test pattern for its parity checker).

### Second curated template (T6.5)

- [x] Design decision (open question, see Risks): the second template's
      visual direction and name are a review decision before
      implementation starts — it must differ from the built-in in cover
      treatment, page master/header/footer, heading typography and
      rhythm, and accent usage; a superficial accent-color-only variant
      does not satisfy this task.
- [x] Author the second template's manifest (same schema as T6.1/T6.3's
      built-in, distinct `design`/`typography`/`tokens`/
      `semanticPalettes`/`components`/`localization` values) — no new
      `template.ts` branches, no `if (templateId === ...)` conditionals;
      the second template proves the manifest is sufficient by rendering
      through the identical engine code path as the built-in.
- [x] Package it through 007's `.wiki-pdf-template` container
      (`packages/template-pack/src/pack.ts`) and register it as a second
      built-in entry alongside the first in whatever catalog/registry
      structure 007 or this folder's T6.1 establishes for built-ins.
- [x] Tests: the second template compiles cleanly through the same
      correctness fixture as the built-in (007's Level-A serialize
      goldens + compile smokes, re-run against the second template's
      manifest) and passes the same 011 conformance case and the same
      hardcoding-audit lint stub (no violations from the new template's
      own source, since it has none — this proves the second template
      needed zero new `template.ts` code).

### Tests (no mocking)

Same rule as every folder in this series: pure functions get direct
input/output tests; anything touching the compiler compiles for real; no
mocked HTTP, no stubbed compiler.

- [x] Covered inline per task above; consolidate here at implementation
      time only if a cross-cutting suite (e.g. one file testing the full
      resolver pipeline end-to-end against both built-in manifests) proves
      more maintainable than task-scoped test files.

## Implementation record — deviations & decisions (2026-07-20)

**Parity method: digest equality (the preferred option), not raster.**
`packages/pdf-compiler-browser/src/template-migration-parity.test.ts` pins the
sha256 of the built-in template's default output over a fixture exercising every
migrated role, both semantic palettes, and the component set. The digest was
captured from the pre-migration engine (007 state) with the pinned compiler
`typst.ts 0.7.0 / Typst 0.14.2` **before** any literal moved, and is unchanged
after the migration: `351fd2d4f0a178368d642ef939f2de2736ddc506f196cd70b47e455cad376975`
(73050 bytes). Byte-identity was achievable because the rewrite preserves the
Typst *document model* exactly, so the raster fallback was never needed. The
test refuses to compare across compiler versions, and a tamper case proves the
gate would actually catch a regression.

**How the design reaches the engine (two mechanisms, deliberately).** Static
design (typography roles, color tokens, semantic palettes, component
spacing/layout, page margins) is interpolated when
`createAtlcliTypstTemplate(design, labels)` generates the Typst string — the
template helpers (`callout`, `status-badge`, `task-item`, …) are called from the
document body at main.typ top level and cannot see `atlcli-doc`'s `settings`, so
generation-time interpolation is the only way to make them data-driven. The
settings-driven subset (accent, page size/orientation, cover/outline,
organization name) plus the localized labels travel in the emitted
`settings.design` / `settings.labels` dictionary and are read at Typst runtime,
which is what retires 007's direct `settings.at("accent-color", …)` reads. Every
runtime read falls back to a generation-time default drawn from the same
manifest, so `settings: (:)` still compiles (007's backward-compatibility
contract).

**Colors are `#RRGGBB` only.** The Architecture section allows "canonical
`#RRGGBB` or token references"; token references were not implemented — neither
curated template needs them and omitting them keeps the resolver free of a
reference-resolution pass. Accepting a strict subset is forward-compatible.

**Serializer presentation is design-parameterized.** `serialize.ts` originally
bound the built-in design at module scope, which made a second template's
`tableStroke`/`tableHeaderBackground`/`mention`/`placeholder` dead data. The
active design is now threaded through the `Writer` (block scope) and
`RenderContext` (inline scope), so those tokens genuinely apply. The Confluence
status palette moved with it (`semanticPalettes.statuses` is per-template).

**Security: manifest localization is an injection surface.** A document-label
KEY is interpolated into generated Typst as a dictionary key (unquoted), where
`typstString` cannot help. An unvalidated key (`x: panic("…"), y`) escaped the
key position and was evaluated as code by the real compiler. Closed in three
layers: (1) `validateLocalization` asserts label keys are safe identifiers and
runs label values through the design model's "no Typst metacharacters" check;
(2) `resolveTemplateLabels` resolves only the declared
`WIKI_PDF_V1_DOCUMENT_LABELS` vocabulary, so an unknown key never reaches
emission; (3) `typstSettingsDict` hard-fails on any key that is not a safe
identifier. Regression tests cover all three layers plus a real-compiler proof
that a gate-bypassing manifest cannot execute code. UI-only copy
(`template`/`settingGroups`/`settings`) is bounded and control-char-free but may
contain punctuation, since it never reaches Typst.

**Hardcoding-lint accepted limits.** The lint is a heuristic review aid, not a
parser. Known bypasses (a literal wrapped in its own `${…}`, 3-/4-/8-digit hex,
`cm`/`in`/`%` units, multi-family font stacks) are accepted: all are contrived,
and the byte-parity gate plus review are the real backstop. Tightening it is
cheap follow-up work if a real case appears.

## Documented extension — chapter running head (2026-07-20)

**Not in any spec's original task list.** It came out of the M1 acceptance run:
on a 57-page tree export every page's running head read "M1 Abnahme Root" — the
root page title. That is correct per the shipped design (the head had exactly
two behaviours, document title + space key, or the fixed `headerText` string),
but useless for a book-like document. DOCX already had the equivalent capability
(a user template can carry a `STYLEREF "Heading 1"` field; spec 006 G1 built the
STYLEREF inventory/validation), so PDF was asymmetric. Recorded here because
this folder owns the design model the field lives in.

**Where the field went, and why.** `design.features.header.mode`, a bounded enum
`"title" | "chapter" | "custom"` validated by `validateDesign` —
*not* a new top-level `header` section. `features` already owns the header as a
named section, and `features.outline` already carries bounded configuration
beyond `enabled` (`depth`), so "a feature section holds its own bounded options"
was the established convention rather than a new one. The field is **optional**:
an absent `mode` stays `undefined` (the `branding.organizationName` /
`TypographyRole.font` precedent — reject invalid, never coerce absent) and
consumers resolve it through the exported `DEFAULT_DESIGN_HEADER_MODE`
(`"title"`). That is what makes the addition non-breaking for every manifest
written before it existed.

**No binding, deliberately.** `features.header.mode` was NOT added to
`BINDING_TARGET_ALLOWLIST`. A binding needs a Level-A source, and
`bindingSourceValue` in `packages/pdf/src/settings.ts` is a closed switch over
the six existing Level-A keys — an allowlisted target with no source would be
permanently unreachable configuration in a *versioned* allowlist. Adding a
target later is non-breaking (same additive rule the contract states for
settings keys), so the honest order is: add a Level-A `headerMode` setting +
its CLI/extension surface first, then the binding. Until then the mode is what
it should be anyway — a template-design choice an author makes in the manifest,
like `page.margin` or a typography role.

**The Typst construct, verified against the real compiler** (`typst.ts 0.7.0 /
Typst 0.14.2`), not assumed:

```typst
query(heading.where(level: 1))
  .filter(h => h.outlined and h.location().page() <= here().page())
```

The obvious `heading.where(level: 1).before(here()).last()` was rejected on
evidence: inside a page header `here()` resolves to the **top** of the page, so
`.before(here())` excludes a chapter that opens on that very page, and the head
lags one page behind at every chapter opening (probed per page with `panic`
diagnostics against the pinned compiler: the page where "Beta Chapter" opened
still read "Alpha Chapter"). The `h.outlined` filter is equally load-bearing —
`outline()` emits its own level-1 heading for the "Contents" title, the only
heading with `outlined: false`; without the filter every page of every document
was headed *Contents*. Pages with no preceding chapter fall back to `meta.title`,
never to an empty head.

**Default parity preserved.** The mode is resolved at template-*generation* time
(it is static design, not settings-driven), so the chapter branch is only ever
emitted for a chapter-mode design. The generated Typst for the default design is
character-identical to the pre-feature template, and
`template-migration-parity.test.ts` still pins
`351fd2d4f0a178368d642ef939f2de2736ddc506f196cd70b47e455cad376975` unchanged.

**Manuscript opted in** (`features.header.mode: "chapter"`) — it is the
book-like curated template, and it has no pinned digest, so its output changing
is intended. Editorial Indigo stays on `"title"`, which is what keeps the
digest fixed.

**Tests** (no mocks; real compiler, real fonts, real import gate). Header text is
not recoverable from a compiled PDF — Typst subsets fonts and emits glyph ids,
and the running head reaches neither the outline nor the structure tree — so
`chapter-running-head.test.ts` asserts through **byte-equality between two real
renders constructed to agree only if the head resolves to a specific string**
(e.g. a single chapter whose heading equals the document title renders
byte-identically in both modes; a document with no chapter heading does too,
which is simultaneously the fallback proof and the ToC-exclusion regression
guard). That is a stronger claim than a substring match, not a weaker one.

**Refinement — first chapter on the page, not the last (2026-07-20).** Came from
the user's review of the M1 acceptance artifacts produced by the entry above, so
it belongs to this same follow-up rather than to a new spec. When SEVERAL
chapters begin on one page, `started.last()` named the *last* of them; the head
now names the *first*. Rationale: the head sits at the top of the page and the
content directly below it starts with that first chapter, so naming a later one
contradicts what the reader sees — and first-on-page is the dictionary /
guide-word convention. The resolution became:

```typst
let chapters = query(heading.where(level: 1)).filter(h => h.outlined)
let opening = chapters.filter(h => h.location().page() == here().page())
let running = chapters.filter(h => h.location().page() < here().page())
let chapter-head = if opening.len() > 0 { opening.first().body }
  else if running.len() > 0 { running.last().body }
  else { meta.title }
```

Both behaviours the entry above measured survive unchanged and are pinned by
their own tests: the `== here().page()` branch still selects a chapter that
*opens* on this page (the one-page lag of `.before(here())` does not return), and
the `h.outlined` filter still keeps the ToC's own "Contents" heading out.

**Equivalence in the normal case, proven not asserted.** `composeChapters`
inserts a `pageBreak` per chapter by default, so ordinary tree/space exports put
at most one chapter on a page — and there "first opening here" and "last at or
before here" are the same heading. Because the old rule can no longer be
executed, the proof is a pinned digest: a one-chapter-per-page fixture was
compiled against `origin/main` at `62a0031` (the commit before this refinement)
with the pinned compiler, and its sha256
`90bef12c83c654c059f5cc3918b21469c3640c7dad78683676b7766b02023ca0` is asserted by
`chapter-running-head.test.ts` after the change. It reproduces byte-for-byte.
Provenance is recorded on the constant; a change there means the refinement
altered output in the case it was supposed to leave alone, so it is never a
re-baselining candidate.

The new discriminating tests were themselves checked by temporarily restoring the
`started.last()` rule: the first-on-page assertion and its mirrored control both
fail under it, while the equivalence digest passes under *both* rules — which is
exactly the split the change claims. `template-migration-parity.test.ts` still
pins `351fd2d4…` unchanged (the default design is `title` mode, so the chapter
branch is never emitted for it).

## Definition of Done

- The built-in template's default output is proven parity-identical
  before and after migration (T6.4): digest-equal, or raster-equal within
  a documented tolerance with the reason byte-identity wasn't achievable
  recorded in this file.
- The hardcoding audit (`check-hardcoding-ledger.ts`, CI-enforced per
  T6.3) is green: no unledgered presentation literal remains in
  `template.ts`/`serialize.ts` outside the reviewed engine-invariant
  allowlist.
- The bindings layer is live: `template.ts` reads resolved
  `settings.design.*`/`settings.labels.*` values, not raw Level-A setting
  keys via direct `.at(...)` calls — 007's temporary direct-read pattern
  is fully retired for every field covered by a binding.
- A second curated template exists, differs meaningfully from the
  built-in (cover, page master, typography, accent — not just a color
  swap), compiles through the unchanged engine code path, and passes the
  same correctness and conformance gates as the built-in.
- `localization` is populated for the built-in template's fallback locale
  completely, `localizeTemplateUi` is exported and tested, and no engine
  code hardcodes a document-facing label that has a `localization` entry.
- `bun run typecheck` and `bun test` pass; the 011 conformance case for
  PDF settings still passes unmodified (parity of *behavior*, not just
  output bytes).

## Risks & open questions

- **Contract becomes the old monolith renamed.** If the second template
  (T6.5) ends up copying `template.ts` branches or serializer logic keyed
  on template ID, that is a **STOP**: move the shared logic back into
  engine-owned runtime before continuing. The whole point of this folder
  is that a second template needs zero new engine code.
- **Manifest becomes an untyped dumping ground.** If implementation
  pressure produces an arbitrary object field, a raw Typst expression, or
  a duplicated default outside the typed design schema, that is a
  **STOP**: add a named, bounded, typed field instead, or leave a
  justified entry in the engine-invariant allowlist with its
  one-line reason.
- **Engine invariants absorb presentation choices.** If a font, color,
  spacing value, or label ends up on the engine-invariant allowlist
  because migrating it was inconvenient rather than because it's
  genuinely structural, reject the allowlist entry and move the value
  into the manifest before this folder's Definition of Done is claimed.
- **Settings become code injection (inherited from 007's own risk entry,
  restated for the larger surface here).** Every new `design`/`labels`
  string this folder threads into Typst source goes through
  `typstString`/typed constructors — a raw concatenation anywhere in
  `template.ts`/`serialize.ts` is a blocker finding, not a style nit.
  Compile hostile fixtures (settings/labels containing `"`, `\`, `#{`)
  as part of T6.2's tests.
- **Localization is incomplete.** A missing fallback-locale label leaks
  an engine-hardcoded English literal into a non-English export, or
  renders empty text. T6.1's manifest validation rejects an incomplete
  fallback locale at import; T6.4's parity check does not by itself catch
  a missing *non-default*-locale label, since the parity fixture uses the
  default locale — track this as a gap for folder 010's UI work to
  surface (a locale switcher that hits missing labels) rather than a gap
  this folder can close alone.
- **Product/package naming stays decoupled from this folder's contract
  identifiers.** `009-package-publishing/PLAN.md` records that the
  `atlcli` product name is likely to change; this folder's manifest
  fields, contract id (`wiki.pdf-template/v1`), and built-in template ids
  (`builtin.<name>`) intentionally avoid embedding `atlcli`/`@atlcli` in
  persisted data (mirrors 007's own container-naming decision). If a
  rename lands before or during this folder's implementation, no manifest
  schema change is expected — only documentation/CLI copy, which is 009's
  concern, not this folder's.
- **Second template's visual direction is an open product decision**, not
  an engineering one — do not start T6.5 implementation before it's
  settled (see T6.5's first task).
- **Font glyph coverage** for the second template's typography choices —
  same open question 007 already carries for custom corporate fonts; a
  cmap preflight is expensive, deferred to whichever folder first ships
  non-bundled fonts.

### Open questions carried over from draft PR #48 (§16)

These product decisions were deliberately **not** answered when PR #48 was
distilled into this folder. Resolve them during this folder's review /
first task before the affected work starts; the recommended defaults are
the ones PR #48 stated.

- [ ] **Preference scope for persisted template settings:** confirm the
      recommended local `tenant origin + space key` scope, or start with
      browser-global defaults for the first slice. (Persistence itself is
      implemented in `010-extension-integration/PLAN.md` T5.2 — this
      decision feeds that work, but is recorded here because it shapes
      which manifest `settings` make sense per scope.)
- [ ] **Initially editable subset:** all current defaults migrate into the
      manifest, but confirm whether logo, header/footer text, page size,
      cover, outline, organization name, and accent color should all
      receive first-slice `settings`/`bindings`, or whether some remain
      manifest-owned but not yet user-editable. (007's Level-A set —
      including accent/organization/logo — is the current baseline;
      this question is about everything beyond it.)
- [ ] **Legacy compatibility alias:** keep `ATLCLI_TYPST_TEMPLATE` for one
      repository release cycle as a deprecated alias, or remove it
      immediately once all in-repo consumers are migrated. (Interacts
      with the product-rename decision tracked in
      `009-package-publishing/PLAN.md` — a soon-to-be-renamed env var is
      a weak argument for a long deprecation window.)
- [ ] **Unknown manifest fields:** retain PR #48's proposed split
      (hard error for built-in templates, development-mode warning for
      imported ones), or reject unknown keys unconditionally from day
      one. (007's T2.4 validation currently rejects unknown top-level
      keys; whichever answer wins must be applied consistently there.)
- [ ] **Initially shipped locales:** recommended baseline is a complete
      English fallback plus a complete German bundle for the built-in
      template; confirm whether the second curated template must ship
      both immediately or only the complete fallback locale.

---

Distilled from draft PR #48 (`specs/pdf-template-editor/PLAN.md`, branch
`codex/pdf-template-contract-plan`); the PR is closed in favour of this
folder.
