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

- [ ] `packages/template-pack/src/manifest.ts`: extend 007's manifest
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
- [ ] `packages/template-pack/src/manifest.ts`: `bindings:
      WikiPdfTemplateSettingBindingV1[]` — `{ setting, targets, transform?
      }`; `targets` validated against a versioned allowlist of design
      paths (start with the Level-A set 007 already exposes: accent,
      page size, cover/outline enabled, outline depth, header/footer
      text, organization name, logo asset + alt); `transform` is
      `identity` or an explicit `choice-map` — reject anything else at
      validation time, not at render time.
- [ ] `packages/template-pack/src/manifest.ts`: `localization:
      WikiPdfTemplateLocalizationV1` — `defaultLocale`, `fallbackLocale`,
      `locales` map (`template`, `document`, `settingGroups`, `settings`
      copy, per the Architecture section). `validateManifest` requires
      the `fallbackLocale` entry to be complete (non-empty name/
      description, every document label, every declared setting/group/
      option label); other locales may be partial with a lint warning on
      a missing field, never a hard reject.
- [ ] Tests: `packages/template-pack/src/manifest.test.ts` (extend) —
      real fixture manifests covering every new field, boundary values
      for lengths/ratios/colors, an incomplete `fallbackLocale` (reject),
      a partial non-fallback locale (accept + warning), a `bindings`
      entry targeting an unknown path (reject), and a `choice-map`
      missing a value for a declared choice option (reject).

### Resolver: bindings, locale, labels (T6.2)

- [ ] `packages/pdf/src/settings.ts`: extend `resolvePdfSettings` to the
      seven-step order documented in 007's Risks entry ("Built-in vs.
      manifest settings") — manifest defaults → persisted host values →
      per-export overrides → validation/normalization → **apply declared
      bindings to an immutable design copy** → **document-locale
      selection + label resolution** → asset-slot resolution. Return
      shape gains `design` (fully resolved, bound `WikiPdfTemplateDesignV1`)
      and `labels` (resolved document-facing strings) alongside the
      existing `values`/`assets`.
- [ ] `packages/pdf/src/settings.ts`: `applyBindings(design, bindings,
      values)` — pure function, one allowlisted target write per binding,
      duplicate-target-write detection (two bindings writing the same
      path is a validation error, not last-write-wins).
- [ ] `packages/template-pack/src/localize.ts` (new): `localizeTemplateUi
      (manifest, uiLocale)` — pure function resolving UI-facing copy
      (template name/description, setting/group/option labels) per the
      locale-fallback chain (exact locale incl. region → base language →
      `defaultLocale` → `fallbackLocale`); this is the function folder
      010 calls to render a generated settings form, not built here.
- [ ] `packages/pdf/src/serialize.ts` / `template.ts`: `settings` dict
      emitted to Typst gains `design` and `labels` namespaces alongside
      the existing `values`/`assets`; `typstSettingsDict` (007's emitter)
      extends to serialize the new namespaces with the same
      `typstString`-escaping discipline — no new emission path, one
      escaper for every settings namespace.
- [ ] Tests: `packages/pdf/src/settings.test.ts` (extend) — bindings
      resolve to the correct design path; duplicate-target-write is
      rejected; locale resolution follows the four-step fallback chain
      exactly, including a region-specific locale (`de-CH`) falling back
      to base language (`de`); `localizeTemplateUi` returns the fallback
      locale's copy when the requested UI locale doesn't exist.

### Hardcoding migration: built-in template (T6.3)

- [ ] Complete 007's T2.5 ledger: extend
      `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`
      (or the `template.ts` comment-block equivalent, whichever 007
      chose) with every remaining presentation literal — typography roles
      per level/role, all color tokens, both semantic palettes, and every
      component's spacing/layout constants — as its own ledger row with a
      manifest destination path, before any migration edit lands. This is
      restatement of current behavior, not new design.
- [ ] `packages/pdf/src/template.ts`: replace each ledgered hardcoded
      literal with a read from `settings.design.*`/`settings.labels.*`,
      grouped by ledger category (typography, then tokens, then
      semantic palettes, then components) as separate, reviewable commits
      rather than one large diff — each commit keeps the built-in
      template's manifest defaults equal to the literal it replaces, so
      output does not change mid-migration.
- [ ] `packages/pdf/src/serialize.ts`: any presentation literal owned by
      the serializer (not `template.ts`) moves the same way; semantic
      content emission (meta, blocks) is unaffected.
- [ ] Built-in manifest for the existing template (name/id per whatever
      007 shipped, e.g. `builtin.<name>`): fixed `schemaVersion`, full
      `design`/`typography`/`tokens`/`semanticPalettes`/`components`/
      `localization` populated from the completed ledger; default setting
      values reproduce today's output exactly — selecting the built-in
      template with no overrides and omitting template selection entirely
      must be equivalent.
- [ ] `packages/pdf/scripts/check-hardcoding-ledger.ts` (007's lint stub,
      extended here): once the ledger is complete, flip the check from
      "heuristic warning" to "CI-enforced" — any new bare hex color,
      length literal, or font-family string in `template.ts`/
      `serialize.ts` outside the ledger's recorded set and the engine-
      invariant allowlist fails the build.
- [ ] Document the **engine-invariant allowlist**: a short, reviewed list
      (in the lint stub's header comment or a sibling
      `packages/pdf/ENGINE-INVARIANTS.md`) of literals that are
      structurally required by the engine and are not presentation
      choices — e.g. Typst API argument names/keywords, not colors,
      sizes, or copy. Every entry needs a one-line justification; the
      list is reviewed on every addition, not append-only by default.

### Default-output parity (T6.4)

- [ ] Capture the pre-migration baseline: compile the built-in template's
      default output (via 011's harness `pdf-settings` conformance case)
      before T6.3's literal-by-literal replacement starts; record the
      sha256 digest and, if the pinned compiler's output isn't perfectly
      byte-stable across the migration (e.g. due to incidental Typst
      source reordering), a rasterized comparison using the same
      perceptual-difference tooling 011's DOCX media-parity check uses,
      adapted to compare full PDF page rasters within a documented
      tolerance.
- [ ] After T6.3 completes, re-run the same fixture and assert digest
      equality (preferred) or raster equality within tolerance
      (fallback, only if byte-identity turns out to be infeasible —
      document which one applies and why). A default-output change of
      any kind is a **STOP**: review the exact cause before proceeding,
      never silently accept a new baseline.
- [ ] Wire this comparison into `apps/browser-export-harness/scripts/
      check-parity.ts` as an explicit "pre/post migration" mode (or a
      one-off script reusing its digesting/comparison functions) — reuse
      011's existing digest/report-projection machinery rather than
      building a second comparator.
- [ ] Tests: a fixture-based regression test asserting the comparison
      script itself rejects a deliberately altered raster (mirrors 011's
      own infrastructure-test pattern for its parity checker).

### Second curated template (T6.5)

- [ ] Design decision (open question, see Risks): the second template's
      visual direction and name are a review decision before
      implementation starts — it must differ from the built-in in cover
      treatment, page master/header/footer, heading typography and
      rhythm, and accent usage; a superficial accent-color-only variant
      does not satisfy this task.
- [ ] Author the second template's manifest (same schema as T6.1/T6.3's
      built-in, distinct `design`/`typography`/`tokens`/
      `semanticPalettes`/`components`/`localization` values) — no new
      `template.ts` branches, no `if (templateId === ...)` conditionals;
      the second template proves the manifest is sufficient by rendering
      through the identical engine code path as the built-in.
- [ ] Package it through 007's `.wiki-pdf-template` container
      (`packages/template-pack/src/pack.ts`) and register it as a second
      built-in entry alongside the first in whatever catalog/registry
      structure 007 or this folder's T6.1 establishes for built-ins.
- [ ] Tests: the second template compiles cleanly through the same
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

- [ ] Covered inline per task above; consolidate here at implementation
      time only if a cross-cutting suite (e.g. one file testing the full
      resolver pipeline end-to-end against both built-in manifests) proves
      more maintainable than task-scoped test files.

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

---

Distilled from draft PR #48 (`specs/pdf-template-editor/PLAN.md`, branch
`codex/pdf-template-contract-plan`); the PR is closed in favour of this
folder.
