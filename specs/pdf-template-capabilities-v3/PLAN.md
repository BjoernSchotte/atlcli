# PDF Template Capabilities V3

Status: **In progress — P0 merged; T1–T2 implemented and verified**, 2026-08-07

Planning baseline: commit `2bf00066`

Directory: `specs/pdf-template-capabilities-v3`

## Summary decision

Extend PDF template packs as a bounded, typed design language. The next
generation combines semantic compositions, renderer-owned running-region
slots, semantic component styles, and flat decorative primitives. It must not
become a generic page builder or a way to execute Typst supplied by a recipe.

The work is split into independently landable milestones, preceded by one
mandatory runtime migration PR:

1. land a separate prerequisite PR that replaces the single production runtime
   with an exact, reproducibly vendored Typst 0.15.1 pair, forward-ports the
   CSP hardening, and establishes a non-destructive rebuild path for local
   pre-0.15 packs;
2. introduce a portable capability-catalog schema that can express ownership,
   compiler availability, conditional requirements, conflicts, and proof
   obligations;
3. introduce recipe V2 with a digest-pinned baseline plus sparse author
   overrides, while continuing to emit a complete executable pack;
4. add page, running-region, component, paint, crop, and typography features
   in PDF capability catalog V3 and canonical source revision 5, directly
   targeting the proven Typst 0.15.1 runtime;
5. implement real PDF output standards as export/compiler policy, never as a
   template-design claim.

The executable archive contract remains `wiki.pdf-template/v1` as long as the
Typst render hook and runtime bindings remain compatible. Historical catalog
V1/V2 archive bytes and canonical revision 1-4 source hashes remain immutable
migration evidence, but archives whose declared `engine.compilerRange`
excludes 0.15.1 are
intentionally rejected by the single-runtime production loader with an
actionable rebuild-required diagnostic. There is no dual-runtime requirement:
the confirmed absence of external pack users makes a direct cutover the lower-
cost contract.

```text
recipe V1 with <0.15 range ─► explicit range migration ─► recipe V1 for 0.15.1
                                                           └► catalog V2 / rev 4

legacy catalog V1/V2 archives ─► rebuild-required diagnostic

recipe V2
  + pinned baseline
  + sparse overrides
        │
        ▼
deterministic baseline resolution
        │
        ▼
full validated design V2 ──────────► catalog V3 / canonical rev 5
        │
        ├──► renderer-owned Typst 0.15.1 source
        ├──► hashed assets + deterministic pack
        └──► compile, semantic, visual, browser, and LIVE proof

export request ─► PDF standard policy ─► compiler adapter ─► output validator
```

## Goals

- Let template authors configure professional handbook and space/tree exports
  without writing TypeScript or Typst.
- Make every declared capability executable, version-gated, and associated
  with an objective proof obligation.
- Prioritize page masters, navigation, tables, lists, outlines, running heads,
  text layout, and controlled decoration over magazine-like free placement.
- Preserve deterministic pack bytes for semantically identical inputs.
- Preserve browser safety and the existing host-neutral package boundaries.
- Use one exact Typst 0.15.1 runtime; do not retain 0.14.2 solely for local
  archive compatibility.
- Fail closed on unsupported compiler features, invalid cross-field
  combinations, missing assets, or unproven PDF-standard requests.

## Non-goals

- Raw Typst, show rules, selectors, functions, arbitrary expressions, custom
  packages, or user-provided canonical source.
- A generic element tree, arbitrary grid, unconstrained absolute positioning,
  arbitrary SVG paths, masks, tiling bodies, blend modes, or scriptable layout.
- Inferring document semantics from appearance. Footnotes, citations,
  bibliographies, mathematics, glossary entries, and index markers require
  renderer-neutral source IR work before template styling is exposed.
- AcroForms or digital signatures. Signing remains a credential-bearing
  post-processing concern outside the template renderer.
- External baseline fetching. Recipe V2 resolves only already-installed,
  digest-pinned baselines through a host-provided registry.
- Claiming certified PDF/UA conformance from a template or from the presence of
  PDF tags alone.
- A dual-runtime 0.14/0.15 selector or silent widening of compiler ranges in
  historical archives.

## Current-state evidence

- `packages/template-pack/src/capabilities.ts` defines portable catalog schema
  `atlcli.template-capability-catalog/1`. A descriptor has a path, primitive
  value kind, unconditional `required`, consumers, runtime writers, enum
  values, and numeric bounds. It cannot represent conditional dependencies,
  compiler availability, ownership plane, conflicts, stability, asset
  requirements, or proof obligations.
- `packages/pdf/src/design-catalog.ts` owns PDF catalogs V1 and V2 and their
  pinned digests. V2 adds the cover/closing composition leaves delivered in
  PRs #145 and #146.
- `packages/pdf/src/settings.ts` and `packages/pdf/src/serialize.ts` currently
  recognize catalog V2 through a binary digest check and otherwise use the
  V1/legacy path. Catalog V3 therefore requires an exact fail-closed runtime
  registry; an unknown digest must never fall back to V1.
- `packages/pdf/src/template-pack.ts` maps canonical source revisions 1-4 to
  compatible catalogs. Composition-specific conditional validation is
  imperative and local to the PDF pack validator.
- `packages/template-pack/src/recipe.ts` defines
  `wiki.pdf-template-recipe/v1`. It requires a complete design and localization
  baseline and deliberately excludes hashes, provenance, archive paths,
  canonical Typst, and raw code.
- `packages/pdf/src/template-recipe.ts` always materializes recipe V1 as PDF
  catalog V2 and canonical source revision 4. It validates assets, packs,
  unpacks, repacks, loads, and compiles before returning bytes.
- `packages/template-pack/src/design.ts` models A4/Letter, orientation,
  physical margins, typography roles, design tokens, cover/outline/header/
  footer/closing feature flags, and cover/closing compositions. It does not
  have logical margins, custom paper, running-region slots, semantic component
  styles, named paints, or clipping shapes.
- `packages/template-pack/src/assets.ts` already carries normalized crop and
  opacity data. `packages/pdf/src/template-pack.ts` currently rejects
  non-trivial crop and opacity, and `packages/pdf/src/template.ts` consumes
  fit and rotation only.
- `packages/pdf/src/template.ts` hard-codes paragraph justification, bullet and
  enumeration style, table/outline behavior, and fixed header/footer grids.
- `packages/pdf/src/types.ts` exposes `PdfProfile = "tagged" | "pdf-ua-1"`.
  `packages/pdf-compiler-browser/src/compiler.ts` calls the pinned Typst
  compiler without an output-standard option, and
  `packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts`
  characterizes `pdf-ua-1` as byte-identical to `tagged` with no PDF/UA
  identifier.
- `packages/pdf-compiler-browser/src/compiler.ts` pins
  `typst.ts 0.7.0 / Typst 0.14.2`. The measured 0.15 runtime lane in
  `specs/issue-118-adaptive-browser-pdf-memory/RATCHET.md` qualifies 0.15.1 for
  a forward-port evaluation but does not authorize adoption.
- The repository does not patch the Typst compiler WASM. Root
  `patchedDependencies` applies
  `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch` to two
  `new Function` sites in generated `typst.ts` JavaScript glue, replacing them
  with exact static allowlists so MV3 and browser CSP can omit `unsafe-eval`.
  `packages/pdf-compiler-browser/scripts/vendor-typst.ts` then vendors that
  patched glue together with the pristine upstream WASM, pins both SHA-256
  values, verifies patch markers/licences, and rejects dynamic code. This patch
  is generated-glue- and version-specific; it must be re-derived and proven,
  not mechanically assumed to apply to a new wrapper.
- As of this planning pass, npm's stable
  [`@myriaddreamin/typst-ts-web-compiler`](https://www.npmjs.com/package/%40myriaddreamin/typst-ts-web-compiler)
  remains `0.7.0`/Typst 0.14.2. The
  existing `0.8.0-rc3` alias is a benchmark candidate for a Typst 0.15 release
  candidate, not a stable Typst 0.15.1 production pair. The prerequisite PR
  must therefore use either a newly available exact stable wrapper or a
  reproducible, source-pinned
  [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) forward-port against
  Typst 0.15.1; an RC may not be relabelled as the final runtime.
- `apps/cli/src/commands/pdf-template-yaml.ts` is the only YAML/filesystem
  adapter. `apps/cli/src/commands/export-pdf.e2e.test.ts` already proves a
  private recipe through public build/export commands and a retained `DOCSY`
  page.

## Architectural boundaries

### Three contract planes

| Plane | Owns | Must not own |
|---|---|---|
| Template recipe/pack | reusable design policy, bounded components, named paints, relative asset references | document metadata, tenant data, PDF compliance claims, arbitrary code |
| Export request | document metadata, language/region, requested PDF standards, attachments, strictness | reusable brand geometry, renderer implementation details |
| Renderer catalog/proof | compiler availability, generated source, validation rules, actual output evidence | author copy, customer assets, live credentials |

Every new option must name exactly one owning plane. A field rejected from one
plane must not be duplicated there merely for YAML convenience.

### Composition strategy

Adopt the hybrid option:

- named semantic compositions for cover, closing, running regions, navigation,
  and component families;
- renderer-owned layout presets and field slots;
- flat typed decorative primitives for page layers;
- no generic nested scene graph and no executable Typst input.

All content strings enter generated source through the existing escaping
helpers. All enums and numbers are validated before canonical source
generation. Decorative shapes remain artifacts; semantic images continue to
require explicit alt text.

## Target contracts

### Portable capability-catalog schema V2

Introduce `atlcli.template-capability-catalog/2` without changing or
re-digesting schema V1 catalogs. A schema-V2 catalog contains descriptors plus
bounded top-level constraints:

```ts
type CapabilityOwnerV2 = "template" | "export" | "source" | "renderer";
type CapabilityStabilityV2 = "experimental" | "stable" | "deprecated";
type CapabilityProofV2 =
  | "contract"
  | "canonical-source"
  | "compile"
  | "semantic-pdf"
  | "visual-pdf"
  | "browser"
  | "live";

interface TemplateCapabilityDescriptorV2 {
  path: string;
  valueKind: CapabilityValueKindV2;
  required: boolean;
  owner: CapabilityOwnerV2;
  consumers: readonly string[];
  compilerRange?: string;
  stability: CapabilityStabilityV2;
  proofs: readonly CapabilityProofV2[];
  // Existing enum, bounds, runtime-writer, and write-order fields remain.
}

interface CapabilityPredicateV2 {
  path: string;
  equals: string | number | boolean;
}

interface CapabilityRequirementV2 {
  kind: "path" | "asset" | "label";
  id: string;
}

interface CapabilityConstraintV2 {
  when: readonly CapabilityPredicateV2[]; // conjunction only
  require?: readonly CapabilityRequirementV2[];
  forbid?: readonly CapabilityRequirementV2[];
}
```

Do not implement a recursive boolean-expression language. Multiple constraints
express alternatives; predicates inside one constraint are an AND. Validation
must reject unknown predicate paths, type-incompatible `equals` values,
unknown requirements, duplicate targets, self-dependencies, contradictory
require/forbid targets, and constraint cycles.

Move the existing Type Cut and brand-lockup requirements into constraints as
the first characterization of the new engine. Keep engine-specific semantic
checks only where they cannot be represented by the portable vocabulary.

### PDF catalog and canonical-source versions

| Pack family | Portable schema | PDF catalog | Canonical revision | Compiler |
|---|---:|---:|---:|---|
| Historical migration fixtures | 1 | 1 | 1-3 | immutable `<0.15` archive; rebuild required in production |
| Composition recipe V1 fixture | 1 | 2 | 4 | immutable `<0.15` archive; rebuild required in production |
| Migrated local recipe V1 | 1 | 2 | 4 | Typst `>=0.15.1 <0.16`; source revision unchanged |
| Current capability set | 2 | 3 | 5 | Typst `>=0.15.1 <0.16` |

Never change pinned digests or source bytes for catalogs V1/V2 or revisions
1-4. Do not create catalog V4/revision 6 merely to represent the runtime
cutover: catalog V3/revision 5 is the first current generation after the
prerequisite Typst 0.15.1 PR.

### Recipe V2 and pinned baselines

Recipe V2 is a source-authoring contract, not a new executable archive format:

```yaml
schema: wiki.pdf-template-recipe/v2

template:
  id: example.handbook
  name: Example Handbook
  version: 1.0.0

baseline:
  id: atlcli.editorial
  version: 1
  catalogVersion: 3
  digest: <pinned-sha256>

design:
  page:
    format: { kind: preset, name: a4 }
    binding: left
    margin:
      mode: logical
      top: 18mm
      bottom: 22mm
      inside: 25mm
      outside: 18mm
  compositions:
    running:
      header:
        layout: split
        first: hide
        odd:
          start: { field: chapterTitle }
          end: { field: spaceKey }
        even:
          start: { field: spaceKey }
          end: { field: documentTitle }
      footer:
        layout: centered
        center: { field: pageNumber, numbering: current-of-total }
  navigation:
    contents: { enabled: true, depth: 3, pageNumbers: show, leader: dots }
    bookmarks: { enabled: true, depth: 4, includeHeadingNumbers: true }
  components:
    paragraph: { align: justify, hyphenation: auto }
    table: { repeatHeader: true, banding: rows, borders: horizontal }
    list: { bulletPreset: compact, numberingPreset: decimal-alpha-roman }
  typography:
    roles:
      body: { style: normal, kerning: true, ligatures: common }
      tableCell: { numberWidth: tabular }
  paints:
    hero:
      kind: linear
      angle: 43
      relativeTo: parent
      stops:
        - { at: 0, color: coverTitleInk }
        - { at: 58, color: coverTitleInk }
        - { at: 58, color: coverTitleInverse }
        - { at: 100, color: coverTitleInverse }

decorations:
  - kind: rect
    scope: first
    layer: page-background
    box: { x: 0mm, y: 0mm, width: 210mm, height: 80mm }
    fill: hero
```

Rules:

- The baseline resolver returns a complete, immutable baseline plus exact
  `(id, version)`, catalog identity, and digest. The recipe validator verifies
  all four before applying overrides.
- Recipe V2 does not accept an author-owned `compilerRange`. The closed
  catalog/revision registry supplies the exact executable range proven for the
  generated source. Recipe V1 retains its existing field for compatibility.
- The initial CLI resolver supports only baselines shipped with the installed
  atlcli version. No URL, package reference, arbitrary file path, or implicit
  "latest" lookup is allowed.
- Overrides are deep object patches with exact keys. Arrays replace as a
  whole; `null` is not a delete operator; YAML merge keys and aliases remain
  disabled.
- The result is validated as a complete design, projected through the selected
  catalog, and embedded in the pack. Runtime rendering never needs the recipe
  or baseline registry.
- Recipe V1 retains its exact schema and catalog-V2/revision-4 materialization.
  After the single-runtime cutover, normal build rejects a V1 recipe whose
  `compilerRange` excludes 0.15.1 with an actionable migration-required
  diagnostic. P0's non-destructive migration path writes a new V1 recipe with
  the explicit `>=0.15.1 <0.16` range only after rev4 source-level parity has
  passed, then builds a new pack. Recipe V2 remains a later authoring upgrade,
  not a prerequisite for the runtime cutover.

### Catalog-V3 design surface

Catalog V3/revision 5 includes only syntax proven on the pinned 0.15.1
compiler:

- page format: preset or bounded custom width/height;
- binding and mutually exclusive physical or logical margins;
- first/odd/even running-region variants with `single`, `split`, and
  `three-column` layouts;
- slots from an allowlist: document title, chapter title, space name/key,
  organization name, version, export date, classification, literal, current
  page, and current-of-total;
- independent visible TOC, PDF-bookmark, heading-number, and page-number
  policies;
- paragraph, list, enumeration, table, outline, callout, and code-block style
  presets, including the bounded 0.15 list-marker alignment option;
- solid, linear, radial, and conic paints with bounded stop counts;
- decorative `rect`, `line`, and `circle` primitives in existing page layers;
- execution of the existing normalized crop data and clip presets
  `rect | rounded-rect | circle`;
- safe text style/stretch, kerning, common ligatures, numeral type/width,
  paragraph alignment, hyphenation controls, and bounded variable-font axes
  constrained by inspected font metadata;
- page bleed with bounded values and semantic TrimBox/BleedBox proof.

Body layouts remain `single-column` in catalog V3. A `two-column` preset may be
added only after a separate feature-zoo proof covers wide tables, figures,
code, Confluence layout blocks, reading order, and pagination. It is not an
acceptance criterion for this plan.

### Deferred post-V3 candidates

- spot colors only after print-output/product requirements are confirmed;
- attachments only after an export-owned source and archival policy exists.

Tiling offsets, arbitrary font-feature maps, unconstrained variable axes, and
free path/mask data remain out of scope even after the upgrade.

### Export-owned output standards

Replace the ambiguous profile behavior with an explicit request that stays out
of recipe YAML:

```ts
type PdfOutputStandardV1 =
  | "pdf-ua-1"
  | "pdf-a-1a"
  | "pdf-a-1b"
  | "pdf-a-2a"
  | "pdf-a-2b"
  | "pdf-a-2u"
  | "pdf-a-3a"
  | "pdf-a-3b"
  | "pdf-a-3u";

interface PdfOutputPolicyV1 {
  standards: readonly PdfOutputStandardV1[];
  compliance: "strict";
}
```

Absence of `outputPolicy` means the existing tagged base export with no claimed
conformance standard. When the object is present, `standards` must contain one
or more unique values; an empty array and duplicates are invalid. Canonicalize
recognized standards into a renderer-owned order before request hashing and
durable replay. The base PDF version/level is derived by the renderer from the
selected standards and recorded in evidence; it is not a recipe field or a
free V1 option. The exact allowlist and compatibility table are derived from
the proven Typst 0.15.1 compiler API. Unsupported or incompatible single- or
multiple-standard combinations fail before compilation. The export report
records requested standards, compiler version, validator results, and
achieved evidence without claiming third-party certification.

## Package-level architecture changes

| Area | Required change |
|---|---|
| `packages/template-pack/src/capabilities.ts` | add schema-V2 types, validation, deterministic digest projection, constraint evaluation, and compatibility exports; leave schema V1 untouched |
| `packages/template-pack/src/design.ts` | add catalog-V3 complete design types/validators and bounded discriminated unions; do not weaken V1 validation |
| `packages/template-pack/src/recipe.ts` | add recipe V2 sparse-authoring types and pure validation; keep filesystem and baseline lookup out |
| `packages/template-pack/src/assets.ts` | add bounded clip descriptors and flat shape-decoration types; preserve image/border V1 decoding |
| `packages/pdf/src/design-catalog.ts` | add catalog V3, presentation V3, constraints, digest, compiler/proof metadata, and catalog-aware readers |
| `packages/pdf/src/template-pack.ts` | closed catalog/revision/compiler registry, schema-V2 constraint evaluation, rev5 validation, and unchanged rev1-4 branches |
| `packages/pdf/src/template-v5.ts` | renderer-owned rev5 source for page/running/component/paint/crop/typography features |
| `packages/pdf/src/template-recipe.ts` | preserve migrated V1-to-rev4 materialization; add V2 baseline resolution and full-design/rev5 materialization atomically |
| `packages/pdf/src/settings.ts`, `serialize.ts`, `font-requirements.ts` | thread only validated runtime values; cover synthetic slot text in font demand; keep template/export ownership separate |
| `packages/pdf/src/types.ts`, `compiler.ts`, `run-export.ts` | add export-owned output policy and achieved evidence without coupling it to template packs |
| root `package.json`, `bun.lock`, `patches/`, and `packages/pdf-compiler-browser/scripts/vendor-typst.ts` | in the prerequisite PR, pin an exact typst.ts/Typst 0.15.1 source pair, forward-port the generated-glue CSP patch, and re-pin glue/WASM/licence provenance |
| `packages/pdf-compiler-browser/src/compiler.ts` and vendored binding | update the production version and generated types, retain serialized compiler access, and expose a typed low-level PDF-standard option only after a real binding proof |
| `apps/cli/src/commands/pdf-template-yaml.ts` | resolve installed baselines by exact id/catalog/digest; build V1 and V2 deterministically |
| `apps/cli/src/commands/export.ts` and request/report modules | add explicit output-standard flags/JSON contract only in the output-profile task |
| docs and examples | update format, YAML, settings, accessibility, CLI, and troubleshooting docs in the same implementation slices |

All new public exports must be added to both Node and browser entry points, and
API reports/closure tests must be regenerated in the same commit.

## Compatibility and migration rules

1. Existing recipe-V1 source files remain parseable. A source whose range
   excludes 0.15.1 requires the explicit non-destructive range migration;
   the migrated V1 still materializes catalog V2/revision 4, but its new pack
   bytes and compiler range intentionally differ from the pre-cutover archive.
2. Existing catalog V1/V2 digests and presentation revisions never change.
3. Canonical revisions 1-4 and old archive fixtures remain exact, hash-pinned
   migration evidence. The single production loader rejects their `<0.15`
   ranges with a stable `rebuild required` reason; revision 5 is the only new
   production registry entry.
4. DOCX authoring remains pinned to its current catalog/revision until a
   separately reviewed migration maps durable decisions to catalog V3.
5. Recipe V2 is opt-in. Migrated recipe V1 remains a supported current input;
   there is no silent in-place rewrite of recipe files or pack archives.
6. The outer `wiki.pdf-template/v1` API changes only if the Typst render hook or
   runtime-binding shape becomes incompatible. If that becomes necessary,
   stop and create a separate contract migration plan.
7. The migration command/build path writes a new destination atomically and
   never overwrites the original archive. If a pack lacks enough source or
   recipe information for a lossless rebuild, fail before writing and name the
   missing input.
8. The compiler upgrade never rewrites old canonical revisions or widens an
   old manifest range. A source-level 0.15 exploratory compile is evidence,
   not a production compatibility claim.
9. Recipe V2 cannot claim a future compiler range. Catalog V3/revision 5 owns
   the exact `>=0.15.1 <0.16` range; there is no range spanning two bundled
   runtimes.

## Commands executors will need

Always run tests through the root script, never bare `bun test`.

| Purpose | Command | Expected on success |
|---|---|---|
| Focused template contract | `rtk bun run test packages/template-pack/src/capabilities.test.ts packages/template-pack/src/design.test.ts packages/template-pack/src/recipe.test.ts packages/template-pack/src/assets.test.ts` | exit 0; all focused tests pass |
| Focused PDF contract | `rtk bun run test packages/pdf/src/design-catalog.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/template-recipe.test.ts packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/font-requirements.test.ts` | exit 0 |
| Real Typst renderer | `rtk bun run test packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts` | exit 0; real WASM, Poppler semantic/raster oracles pass |
| Output standards | `rtk bun run test packages/pdf-compiler-browser/src/pdf-output-standards.test.ts packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts` | exit 0; requested standards are inspected in output |
| CLI authoring/export | `rtk bun run test apps/cli/src/commands/pdf-template-yaml.test.ts apps/cli/src/commands/export-pdf-template.test.ts apps/cli/src/commands/export-report.test.ts` | exit 0 |
| API closure | `rtk bun run test scripts/api-report.test.ts` | exit 0; no unreviewed API drift |
| Browser dependency gate | `rtk bun run check:browser` | exit 0; no Node/Bun-only imports in browser entries |
| Type safety | `rtk bun run typecheck` | exit 0; no diagnostics |
| Build | `rtk bun run build` | exit 0 |
| Docs | `rtk bun run docs:check && rtk bun run docs:build` | exit 0 |
| Full offline suite | `rtk bun run test` | exit 0; only explicitly gated skips remain |
| Diff hygiene | `rtk git diff --check` | exit 0 |

If a named new test does not yet exist, the task that owns it creates it before
using the command as a gate.

## Task dependency graph

```text
P0 separate prerequisite PR
   characterize 0.14.2 ─► exact Typst 0.15.1 + CSP/vendor migration
                         └► local recipe/pack rebuild contract
                                      │
                                      ▼
T1 portable catalog schema V2 + PDF catalog V3
 ├──► T2 recipe V2 + pinned baseline resolution
 ├──► T3 rev5 page model + running regions
 ├──► T4 navigation + semantic component styles
 ├──► T5 paints + shapes + crop/clip
 ├──► T6 typography + paragraph policy
 └──► T7 compiler-output-option binding proof
          └──► T8 real PDF output standards

T2 + T3 + T4 + T5 + T6 ─► T9 CLI/docs/migration UX
T3 + T4 + T5 + T6 ───────► T10 rev5 real compiler/browser/visual proof
T8 ───────────────────────► T11 output-standard conformance proof
T9 + T10 (+ T11 if T8 lands) ─► T12 LIVE DOCSY acceptance and evidence manifest
```

P0 is mandatory and must merge before T1 starts. T7/T8 may be deferred without
blocking catalog V3/revision 5; the Typst 0.15.1 runtime itself is not optional.
T12 must record which output-standard lanes landed and must not claim deferred
capabilities.

## Implementation tasks

### P0 — Land Typst 0.15.1 as a separate prerequisite PR

**Depends on:** none. This PR must merge before every capability task below.

This is intentionally isolated from the YAML/catalog implementation. Compiler
dependency, generated binding, CSP, WASM, package-size, memory, render-delta,
and local migration changes have a different blast radius and review surface.
Keeping them in one prerequisite PR makes every later capability baseline
unambiguously Typst 0.15.1.

**Source of truth:** execute
[`../typst-0151-runtime-forward-port/PLAN.md`](../typst-0151-runtime-forward-port/PLAN.md)
completely before starting T1. That plan deliberately forward-ports
`typst.ts` upstream-first; it does not compare or build an atlcli-owned WASM
wrapper. A commit-pinned, reproducible fork is permitted only as a temporary
delivery fallback with upstream PRs/issues and an explicit exit condition.

**Capability-plan acceptance contract**

- [x] One exact Typst 0.15.1 production runtime is pinned from reproducible
      source, with glue/WASM/declaration hashes and complete licence provenance.
- [x] Generic compiler, binding, and CSP changes are upstreamed or prepared as
      reviewable upstream `typst.ts` contributions; no alternative wrapper or
      dual runtime was added.
- [x] Strict browser/MV3 CSP, direct glue import, explicit WASM injection, and
      exclusion of `wasm-pack-shim.mjs` are proven in packed, browser, and
      extension artifacts.
- [x] Historical archives and revision 1-4 source hashes remain immutable; old
      ranges fail clearly and non-destructive recipe-V1 range migration builds
      deterministic 0.15.1-compatible catalog-V2/revision-4 packs.
- [x] PDF semantic/visual parity, pathological convergence, compiler lifecycle,
      Node/browser/extension parity, memory/performance ratchets, package
      consumption, full offline tests, and public CLI/LIVE DOCSY export pass.
- [x] The runtime migration is committed and merged separately, and its
      evidence identifies any temporary fork's upstream-linked exit condition.

**STOP:** Any STOP condition in the dedicated runtime plan blocks T1. Do not
silently fall back to Typst 0.14.2, a hidden second runtime, or an unplanned
atlcli-owned wrapper.

### T1 — Add portable catalog schema V2 and PDF catalog V3

**Depends on:** merged P0.

**Implementation**

- [x] Add schema-V2 types and validators to
      `packages/template-pack/src/capabilities.ts`. Do not alter schema-V1
      canonicalization, errors, exports, or digest results.
- [x] Implement deterministic constraint validation and evaluation as pure,
      browser-safe functions. Constraint order must not affect the digest.
- [x] Add `validateDesignOverlayAgainstCatalogV2` (or an equivalently explicit
      overlay-authoring mode): validate every supplied leaf and reject every
      unknown leaf while allowing omitted leaves. Never reuse the legacy mode,
      which may ignore data. After merge, require complete-baseline and PDF
      semantic validation.
- [x] Add ownership, stability, compiler range, and proof fields. Validate that
      `template`-owned descriptors can appear in recipe design, while `export`,
      `source`, and `renderer` descriptors cannot.
- [x] Add PDF catalog V3 and presentation V3 in
      `packages/pdf/src/design-catalog.ts`. Move existing composition
      dependencies into catalog constraints and add the 0.15.1-proven target
      leaves from this plan.
- [x] Pin new catalog/presentation digests and assert V1/V2 values are
      unchanged.
- [x] Add a catalog-aware reader/validator instead of another global V3 alias.
      Revision paths must pass their selected catalog explicitly.
- [x] Add an internal `PdfCatalogRuntime` registry selected by exact
      id/version/digest. Replace the V2-versus-V1 branches in `settings.ts` and
      `serialize.ts`; unknown digests fail before settings projection or source
      serialization. T1 registers only the already executable V1/V2 runtimes;
      add the V3 runtime entry in T3 only when revision 5 exists. The catalog-V3
      definition remains internal/non-advertised at the T1 boundary.
- [x] Assert that the DOCX/project authoring constants and runtime remain on
      their current catalog-V1/canonical-revision-3 path. Do not repoint a
      "latest" alias as part of catalog V3.
- [x] Regenerate Node/browser API reports and closure classifications.

**Tests**

- valid constraints, multiple predicates, asset and label requirements;
- unknown paths/targets, wrong predicate types, cycles, contradictions,
  duplicates, unsupported compiler ranges, and ownership violations;
- stable digest under object/constraint ordering changes;
- catalog V1/V2 compatibility and exact digest guards.

**Verify**

```bash
rtk bun run test packages/template-pack/src/capabilities.test.ts packages/pdf/src/design-catalog.test.ts packages/pdf/src/template-pack.test.ts
rtk bun run test scripts/api-report.test.ts
rtk bun run check:browser
```

Expected: all commands exit 0; catalog V3 is accepted only with schema V2 and
the 0.15.1 runtime, while historical catalog fixture digests remain exact.

**STOP:** If schema-V2 support requires changing the canonical projection of a
schema-V1 catalog, stop and introduce parallel canonicalizers. Never re-pin an
old digest.

### T2 — Implement the recipe-V2 contract and digest-pinned baseline resolution

**Depends on:** T1.

**Implementation**

- [x] Add `WikiPdfTemplateRecipeV2`, sparse override types, and pure validation
      to `packages/template-pack/src/recipe.ts`; retain recipe V1 decoding and
      validation unchanged for the explicit migration path.
- [x] Define a browser-safe `PdfTemplateBaselineRegistryV1` port in the PDF
      authoring boundary. A resolved baseline contains immutable complete
      design/localization, exact baseline id/version, catalog identity, and
      digest, but no network/file capability.
- [x] Ship at least one neutral built-in catalog-V3 baseline and pin its digest.
      Do not silently reinterpret the existing recipe-V1 example as V2.
- [x] Resolve baseline, verify identity/digest, apply exact-key sparse
      overrides, and validate the resulting complete design against catalog
      V3 in a pure `resolvePdfTemplateRecipeV2Design`-style function. This task
      stops at a complete immutable design/localization result; pack
      materialization and CLI filesystem dispatch belong to T9 after revision
      5 exists.
- [x] Derive `engine.compilerRange` from the closed catalog/revision registry.
      Recipe V2 must reject a stray author-provided range rather than ignore it;
      T2 can return the registry-owned range as resolution metadata without
      building a manifest.
- [x] Keep migrated recipe V1 dispatch on its catalog-V2/revision-4 materializer
      and add recipe V2 dispatch only in T9. Do not allow an unmigrated `<0.15`
      V1 range or add a pre-revision-5 V2 stub that fails later in canonical
      generation.

**Tests**

- full V2 recipe, minimal sparse override, no overrides, invalid keys;
- wrong baseline id/version/digest and catalog mismatch;
- deterministic object-key reorder and array replacement;
- null deletion rejected and unknown overlay paths fail closed;
- recipe V1 migration decoder/validator behavior unchanged.

**Verify**

```bash
rtk bun run test packages/template-pack/src/recipe.test.ts packages/template-pack/src/capabilities.test.ts packages/pdf/src/recipe-baselines.test.ts packages/pdf/src/template-recipe.test.ts
```

Expected: exit 0; migrated V1 behavior remains characterized, and semantically
identical recipe-V2 objects resolve to identical complete catalog-V3 designs
and registry metadata.

### T3 — Implement the revision-5 page model and running regions

**Depends on:** T1. Integrates with T2 when recipe V2 lands.

**Implementation**

- [x] Add catalog-V3 complete-design types for preset/custom format, binding,
      physical/logical margins, and bounded running-region compositions.
- [x] Reject custom format without both dimensions, preset plus dimensions,
      mixed physical/logical margins, non-positive body area, unsupported
      lengths, and running slots irrelevant to the selected layout.
- [x] Add `packages/pdf/src/template-v5.ts`; do not edit the source emitted by
      revisions 1-4. Register revision 5 only with catalog V3.
- [x] Compose revision 5 from typed renderer helpers. Do not implement it as a
      further regex/string-rewrite layer over `template-v4.ts`, whose current
      marker surgery remains frozen for revision 4.
- [x] Generate Typst page size, binding, logical margins, numbering, and
      first/odd/even running regions from validated data.
- [x] Add bounded page bleed values using Typst 0.15.1's page model. Derive
      TrimBox/BleedBox consistently, reject impossible geometry, and keep bleed
      independent from export-standard claims.
- [x] Keep running slots renderer-owned. Escape `literal` values and cap their
      length. Essential document content must not exist only in headers or
      footers because those regions are artifacts to assistive technology.
- [x] Add font-demand reasons for every enabled synthetic running-slot value;
      hidden variants must not load fonts solely for hidden text.
- [x] Preserve current page geometry for the neutral baseline and characterize
      the revision-4/revision-5 difference explicitly.
- [x] Add the catalog-V3 entry to `PdfCatalogRuntime` only after the revision-5
      generator and manifest validation exist; before that point a V3 manifest
      remains rejected.
- [x] Create `packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts`
      here with the minimal/page/running-region real-WASM cases. T4-T6 extend
      this same harness incrementally; T10 completes cross-host and feature-zoo
      coverage rather than creating the file late.

**Tests**

- A4/Letter/custom, left/right binding, physical/logical margins, zero and
  bounded bleed, rejected bleed/body geometry, and inspected TrimBox/BleedBox;
- first/odd/even variants for each layout preset and every allowed slot;
- current page/current-of-total numbering, frontmatter/body number reset;
- hidden/empty slots, long escaped literals, RTL metadata, insufficient body
  area, and invalid mixed margin models;
- a six-page fixture that proves odd/even switching with `pdftotext -bbox`.

**Verify**

```bash
rtk bun run test packages/template-pack/src/design.test.ts packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/font-requirements.test.ts packages/pdf/src/template-pack.test.ts
```

Expected: exit 0; revision 5 source reflects the declared page/running policy,
and revisions 1-4 remain exact.

### T4 — Implement navigation and semantic component styles

**Depends on:** T1 and the revision-5 renderer shell from T3.

**Implementation**

- [x] Model visible contents, viewer bookmarks, heading numbering, and page
      numbering as independent bounded policies.
- [x] Add semantic style objects for paragraph, bullet list, enumeration,
      table, outline, callout, and code block. Use allowlisted presets and token
      references; do not accept Typst numbering functions, content values,
      selectors, or show rules.
- [x] Expose Typst 0.15.1 list-marker alignment as a bounded enum on semantic
      list styles; do not expose arbitrary marker content or layout functions.
- [x] Move current hard-coded renderer choices behind baseline defaults so the
      neutral catalog-V3 baseline reproduces the existing visual behavior.
- [x] Generate renderer-owned Typst set/show rules from validated policies.
- [x] Ensure repeated table headers retain correct semantics and reading order;
      banding and borders are visual only.
- [x] Update font requirements for generated markers, numbering, outline
      leaders, callout labels, and code line numbers.

Typst 0.15.1 exposes a separate `heading.bookmarked` boolean but no separate
bookmark-title value. Catalog V3 therefore rejects the unsafe combination
"native heading numbers visible + bookmarks enabled + heading numbers omitted
from bookmark titles". The four navigation enablement policies remain
independent; removing numbers from bookmark titles while keeping native visible
numbers is deferred until the compiler has a semantic primitive for it.

**Tests**

- independent TOC/bookmark toggles and depth limits;
- heading/page numbering presets and frontmatter/body transitions;
- nested bullet/enumeration marker presets and each marker-alignment value;
- tables across page breaks with repeated header, banding, and border modes;
- empty and deeply nested lists, wide tables, long unbreakable code, callouts,
  links, figures, and page breaks;
- structure-tree and extracted-reading-order assertions, not screenshots alone.

**Verify**

```bash
rtk bun run test packages/template-pack/src/design.test.ts packages/pdf/src/template.test.ts packages/pdf/src/serialize.test.ts packages/pdf/src/font-requirements.test.ts packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts
```

Expected: exit 0; each policy changes only its declared semantic/visual output,
and the feature-zoo PDF remains tagged with the expected reading order.

### T5 — Implement named paints, flat shapes, and crop/clip

**Depends on:** T1 and the revision-5 renderer shell from T3.

**Implementation**

- [x] Add `PaintV1` with `solid | linear | radial | conic`, two to eight sorted
      stops, bounded percentages/angles, token color references, and explicit
      `relativeTo` values supported by the renderer.
- [x] Add decorative `rect | line | circle` descriptors with existing scopes
      and page layers. Bound item count, coordinates, dimensions, stroke width,
      rotation, and referenced paint IDs.
- [x] Implement current normalized image crop by calculating the visible source
      region and applying a bounded clip container in Typst.
- [x] Add clip presets `rect | rounded-rect | circle`. Reject radius on other
      kinds and reject any path/mask payload.
- [x] Keep non-trivial opacity disabled until a separate alpha-compositing
      positive/negative proof demonstrates PDF, raster, and browser parity.
- [x] Ensure all shapes are decorative artifacts and can never receive author
      text or alt text.

**Tests**

- every paint/shape kind, stop boundaries, duplicate hard stops, missing token,
  invalid order/count, off-page/negative geometry, and scope/layer combinations;
- crop edges and invalid zero-visible-area crops;
- rectangular, rounded, and circular clips;
- positive pixel-region oracles plus deliberately shifted/uncropped negative
  controls so the raster assertions prove they can fail;
- no shape appears as a semantic figure in the structure tree.

**Verify**

```bash
rtk bun run test packages/template-pack/src/assets.test.ts packages/template-pack/src/design.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/template.test.ts packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts
```

Expected: exit 0; declared paints/crops are visually observed, negative
controls fail their oracle, and no executable/vector-path input is accepted.

### T6 — Implement safe typography and paragraph policies

**Depends on:** T1 and the revision-5 renderer shell from T3.

**Implementation**

- [x] Extend catalog-V3 typography roles with bounded style, stretch, kerning,
      common-ligature, numeral-type, and numeral-width enums supported by
      Typst 0.15.1.
- [x] Add global/component paragraph alignment and hyphenation policies. Keep
      language and region export/document metadata; do not infer them from
      template localization.
- [x] Use explicit allowlists for OpenType choices. Add variable-font axes only
      when the selected font's inspected metadata declares the axis and min,
      default, and max bounds; reject arbitrary tags, unknown axes, and values
      outside those bounds.
- [x] Update font-demand analysis and fallback diagnostics for requested styles
      that the selected font cannot satisfy.
- [x] Prove German/English hyphenation, RTL preservation, tabular numerals,
      bounded variable-axis effects, and missing-glyph fallback with neutral
      fixtures.

The RTL fixture uses an explicit resolved document-direction input owned by
source/export metadata (`rtl`, never inferred from localization), Arabic or
Hebrew text, an asserted `/Lang`, extracted logical text order, and a pinned
raster-region alignment oracle. The missing-glyph fixture selects a code point
proven absent from the generated font-coverage map and must produce a stable
`PDF_FONT_MISSING_GLYPH` diagnostic plus the expected fallback/tofu raster
region; source-string inspection alone is insufficient.

**Verify**

```bash
rtk bun run test packages/template-pack/src/design.test.ts packages/pdf/src/template.test.ts packages/pdf/src/font-requirements.test.ts packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts packages/pdf-compiler-browser/src/pdf-lang-catalog.test.ts
```

Expected: exit 0; requested policies are present in source and observable in
semantic/raster output without changing document language ownership.

### T7 — Prove the Typst 0.15.1 compiler output-option binding

**Depends on:** merged P0. Independent of T1-T6.

P0 may expose an auditable typed low-level option while migrating the wrapper,
but this task owns the product-facing binding proof. It does not revisit the
runtime decision and may not add a second compiler.

**Implementation**

- [ ] Derive the exact PDF-standard enum and compatible combinations from the
      pinned 0.15.1 compiler API and generated binding types; do not copy a
      broader upstream list without executing each supported value.
- [ ] Thread the option through the serialized compiler adapter and prove that
      it is request-scoped, reset between compiles, cancellation-safe, and not
      leaked through compiler reuse.
- [ ] If the wrapper does not expose the option, identify the smallest
      reproducible source-pinned binding change. Keep it in the same vendor
      provenance/hash/CSP gate established by P0; never encode standards in
      generated Typst source.
- [ ] Add a canary that compiles one base PDF, one supported single standard,
      and every compiler-declared compatible multi-standard combination.
      Characterize byte, metadata, identifier, diagnostics, and failure
      differences before introducing product policy.

**Verify**

```bash
rtk bun run test packages/pdf-compiler-browser/src/compiler.test.ts packages/pdf-compiler-browser/src/pdf-output-options.test.ts
rtk bun run check:browser
rtk bun run check:browser-export-harness
rtk bun run --cwd apps/extension check:output
rtk bun run typecheck
```

Expected: exit 0; the exact 0.15.1 binding receives request-scoped options,
produces observably distinct expected outputs, rejects unsupported values, and
retains P0's CSP and compiler-lifecycle guarantees.

**STOP:** If options require an unaudited fork, CSP weakening, network loading,
generic evaluation, or compiler-global mutation that cannot be serialized and
reset by the existing adapter lock, defer output standards. Typst 0.15.1 and
catalog V3/revision 5 remain valid without T7/T8.

### T8 — Implement real output standards

**Depends on:** a successful output-option result from T7.

**Implementation**

- [ ] Replace `PdfProfile` ambiguity with an additive output-policy contract
      and explicit compatibility adapter for old callers. Deprecate, but do not
      silently reinterpret, old `pdf-ua-1` requests.
- [ ] Validate `standards` absence versus non-empty presence, duplicates,
      canonical ordering, durable request hashing, incompatible combinations,
      and renderer-derived base PDF level. Do not expose a free PDF-version
      selector in this contract.
- [ ] Thread policy through request, prepared job, replay/durable job, compiler
      port, export report, CLI JSON, Node host, browser harness, extension, and
      tests. Every persisted request pins the exact requested standards.
- [ ] Pass standards through the proven compiler binding. Reject unsupported or
      incompatible combinations before compilation; strict mode has no
      downgrade fallback.
- [ ] Inspect output identifiers, metadata, tagging, language, embedded fonts,
      alt text, and standard-specific restrictions. Use an external validator
      in the acceptance lane; internal byte inspection is not certification.
- [ ] Rename tests/docs that currently state byte identity. Preserve a legacy
      characterization test only for callers that explicitly use legacy mode.
- [ ] Keep attachments as a later export-policy lane. No recipe path or pack
      field may select host files for attachment.

**Tests**

- every supported standard and every rejected combination;
- strict failure, compiler diagnostic mapping, cancellation, replay stability;
- PDF identifiers/XMP, tagging, language, fonts, alt text, TrimBox when
  applicable, and external-validator result parsing;
- CLI/Node/browser report parity and no template-pack ownership leakage.

**Verify**

```bash
rtk bun run test packages/pdf/src packages/pdf-compiler-browser/src/pdf-output-standards.test.ts packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts apps/cli/src/commands/export-report.test.ts
rtk bun run check:browser
```

Expected: exit 0; achieved output evidence matches the explicit request, and
unsupported requests fail before returning PDF bytes.

### T9 — Complete CLI authoring, migration UX, examples, and documentation

**Depends on:** T2 plus whichever of T3-T6 are included in the release slice.

**Implementation**

- [ ] Add `materializePdfTemplateRecipeV2` to
      `packages/pdf/src/template-recipe.ts`. It consumes T2's complete resolved
      design, performs asset preflight, emits catalog V3/revision 5, generates
      canonical source, packs/unpacks/repacks, loads, and compiles before any
      bytes escape. Dispatch recipe V1 to the P0-proven rev4 materializer only
      when its range includes 0.15.1; dispatch recipe V2 to rev5. Never silently
      widen an unmigrated V1 range.
- [ ] Prove deterministic V2 pack bytes under YAML key reorder, CRLF/LF,
      asset-order changes, and warm repeats; prove failure atomicity for
      baseline, overlay, asset, canonical-generation, packing, and compile
      errors.
- [ ] Add the CLI installed-baseline resolver. Reject unknown IDs, versions,
      digests, URL-like values, paths, implicit latest versions, and baselines
      not shipped by the running installation.
- [ ] In the YAML adapter, validate the bounded recipe envelope and dispatch by
      exact schema before any asset resolution. Recipe V1 migration input and
      recipe V2 build input use identical YAML size/node/depth, duplicate-key,
      alias/tag, path-containment, symlink, and aggregate-asset budgets.
- [ ] Extend `pdf-template validate/build` help and JSON results for recipe V2,
      baseline identity, catalog V3, and revision 5.
- [ ] Add a read-only `pdf-template explain <recipe>` view that reports the
      resolved baseline, author overrides, conditional requirements, compiler
      gates, and required proofs. It must not print asset bytes or absolute
      private paths.
- [ ] Provide a neutral minimal recipe V2 and a realistic advanced handbook
      recipe exercising running heads, table/list/outline styles, a gradient,
      one shape, and one cropped image.
- [ ] Document the intentional single-runtime cutover, P0's V1 range migration,
      the optional V1-to-V2 authoring upgrade, rebuild commands, archive-only
      failure mode, installed-baseline resolution, exact field types/defaults/
      constraints, minimal and advanced examples, symptoms/causes/fixes, and
      related topics.
- [ ] Update `pdf-template-contract.md`, `template-pack-format.md`,
      `pdf-template-from-yaml.md`, `pdf-template-settings.md`,
      `pdf-accessibility.md`, CLI reference, contributing/E2E docs, and public
      package consumption docs as applicable.
- [ ] State clearly that recipe V2 is authoring input, packs contain the full
      resolved design, output standards belong to export policy, and no
      template certifies PDF/UA.

**Verify**

```bash
rtk bun run test apps/cli/src/commands/pdf-template-yaml.test.ts apps/cli/src/commands/pdf-template.test.ts scripts/api-report.test.ts
rtk bun run docs:check
rtk bun run docs:build
```

Expected: exit 0; both examples build deterministically and every long page has
the repository-standard TOC, troubleshooting, related topics, and edit link.

### T10 — Prove revision 5 through real compiler, semantic, visual, and browser lanes

**Depends on:** T3-T6 for the included feature set.

**Implementation**

- [ ] Complete the T3-created `template-capabilities-v5.test.ts` using the
      production-generated revision-5 source, pinned WASM/fonts, and neutral
      feature-zoo documents.
- [ ] Compile at least: minimal baseline; running-region booklet; component
      zoo; paints/crop/clip; multilingual typography; deliberately invalid
      fixtures that fail before compile.
- [ ] Assert page count, extracted text, text occurrence counts, URLs,
      bookmarks, structure elements, alt text, language, embedded fonts, and
      compiler diagnostics with Poppler/inspection helpers.
- [ ] Rasterize selected pages at a pinned DPI and use region/color/geometry
      oracles with negative controls. Do not use a single full-page snapshot as
      the only oracle.
- [ ] Run the same packs in Node and the neutral browser worker. Assert pack,
      manifest, source, and output-evidence parity; browser PDF bytes may differ
      only when an explicitly documented host/compiler difference exists.
- [ ] Prove deterministic warm repeat, compiler reset/reuse, cancellation,
      font-subset changes, and VFS cleanup.

**Verify**

```bash
rtk bun run test packages/pdf-compiler-browser/src/template-capabilities-v5.test.ts packages/pdf-compiler-browser/src/template-migration-parity.test.ts
rtk bun run check:browser
rtk bun run build:browser-export-harness
rtk bun run check:browser-export-harness
rtk bun run assert:conformance-cases
rtk bun run check:parity
rtk bun run test:browser-export-harness
```

Expected: exit 0; all positive and negative controls behave as designed;
historical fixtures retain exact bytes, old production loads fail with the P0
rebuild reason, and migrated packs retain the reviewed semantic design.
Register at least one revision-5 case in the browser harness conformance
manifest and parity suite so these commands exercise real Chromium/worker/WASM
output rather than dependency closure only.

### T11 — Run external output-standard conformance proof

**Depends on:** T8. Omit if T8 is deferred.

**Implementation**

- [ ] Extend the existing `scripts/verapdf/` corpus, parser, canary, and ratchet
      rather than creating a second validator harness. Pin current stable
      [veraPDF `v1.30.2`](https://github.com/veraPDF/veraPDF-library/releases/tag/v1.30.2)
      via the official
      [`verapdf/cli:v1.30.2`](https://hub.docker.com/r/verapdf/cli/tags)
      image; create
      `scripts/verapdf/verapdf.lock.json` containing the full immutable image
      digest (the reviewed Docker Hub digest begins `d5ee329657cf`), supported
      platform, and license/provenance link. Never use `latest`.
- [ ] Add a container runner and root `proof:pdf-standards` script that refuses
      a tag/digest mismatch, mounts only `scripts/verapdf/out/` read-only for
      validation, writes normalized JSON reports back to that already ignored
      directory, and uses the existing `parseVeraPdfReport`/ratchet logic.
      Use Poppler/qpdf-style inspection only as supplemental diagnostics, not
      as the conformance oracle.
- [ ] Validate one neutral fixture per supported standard using the exact
      veraPDF flavour mapping owned by the compatibility table and one
      deliberately invalid fixture proving the compliance result fails while
      the validator process/parser itself remains healthy.
- [ ] Store only redacted, non-tenant evidence: requested standards, compiler
      version, artifact digest, validator version, pass/fail, and normalized
      findings. Do not commit generated PDFs unless they are approved synthetic
      fixtures.
- [ ] Treat validator unavailability or inconclusive output as not proven, not
      as success.

**Verify**

```bash
rtk bun run proof:pdf-standards
```

Expected: the lock digest is verified, the known-good canary passes, every
valid standard fixture has zero failures for its exact flavour, the deliberate
invalid fixture is classified as a compliance failure, and normalized reports
remain under `scripts/verapdf/out/`.

### T12 — Run production CLI and LIVE DOCSY acceptance

**Depends on:** T9, T10, and T11 when output standards are included.

**Implementation**

- [ ] Extend `apps/cli/src/commands/export-pdf.e2e.test.ts` rather than creating
      a competing live harness.
- [ ] Build the private recipe V2 twice through
      `atlcli pdf-template build`, compare pack digests, and assert catalog V3,
      revision 5, baseline identity, compile digest, and page count.
- [ ] Use the existing local synthetic HTTP lane for deterministic feature-zoo
      source content and all visual/semantic oracles.
- [ ] Add one LIVE Confluence case in `DOCSY`. Prefer an owned disposable page
      containing headings, paragraphs, nested lists, a table, callout, code,
      and link. Create it only through `withE2eResources`, stamp the
      ownership property, and delete it in `finally`.
- [ ] Keep image/crop/clip assertions in the synthetic lane unless the shared
      resource tracker first gains owned attachment upload, ownership
      verification, and attachment cleanup. Do not create an untracked LIVE
      attachment merely to expand this fixture.
- [ ] If page creation is not authorized, use the retained read-only page for
      the production network/export proof and explicitly record that component
      coverage came from the synthetic lane. Never mutate the retained page.
- [ ] Export through the public production command with `--template`; when T8
      landed, also request one supported output standard through its public
      flag/request surface.
- [ ] Inspect the final PDF and export report, then remove local recipe copies,
      packs, PDFs, rasters, and non-redacted evidence working files in
      `finally`. The allowlisted redacted manifest is the only retained local
      artifact.
- [ ] Emit a redacted evidence manifest containing only schemas, compiler and
      validator versions, catalog/revision/baseline IDs, artifact digests,
      counts, pass/fail gates, cleanup summary, and timestamp. Do not persist
      profile credentials, tenant URL, page IDs, private paths, customer copy,
      asset bytes, or generated private PDFs.

The manifest schema is `atlcli.pdf-template-capabilities-evidence/1`. During a
local run its fixed ignored location is
`.tmp/pdf-template-capabilities/evidence.json`; CI may upload that file as an
artifact after privacy-field validation. The test parses and validates the
manifest, cleans every sibling working artifact, and leaves only this ignored
JSON file for review/upload. A committed test asserts the allowlisted keys and
rejects tenant/page/path fields. T12 adds a scoped root script
`clean:pdf-template-capabilities-evidence` that resolves and verifies this exact
`.tmp` child before removing it after evidence capture; it must not accept an
arbitrary path.

**Live command**

```bash
rtk env ATLCLI_E2E=1 \
ATLCLI_E2E_PAGE_ID=<retained-DOCSY-page> \
ATLCLI_E2E_PROFILE=mayflower \
ATLCLI_E2E_PDF_TEMPLATE_RECIPE=<absolute-local-recipe-v2.yaml> \
bun run test apps/cli/src/commands/export-pdf.e2e.test.ts
```

Expected: exit 0; the recipe builds deterministically, the public export path
uses the catalog-V3/revision-5 pack, semantic and raster assertions pass, the
LIVE `DOCSY` export succeeds, and cleanup reports zero owned residue. If an
owned-page delete fails, the test reports the owned residue and the sweeper is
the recovery path; it must not report full success.

## Test matrix

| Layer | Required evidence |
|---|---|
| Portable contract | schema V1 unchanged; schema V2 exact keys, constraints, ownership, compiler ranges, proof enums, digest stability |
| Recipe | V1 migration decoding; non-destructive V1 range update and rev4 rebuild; V2 baseline resolution, sparse overrides, deterministic full pack, failure atomicity |
| Compatibility | catalogs V1/V2 and revisions 1-4 byte-exact as fixtures; stable rebuild rejection in production; migrated V3/rev5 accepted on 0.15.1 |
| Page/running | paper/custom geometry, binding, logical margins, bleed/boxes, odd/even/first slots, page numbering, body-area guards |
| Components/navigation | TOC/bookmark independence, headings, list marker alignment, tables, outline, callouts, code, reading order |
| Paints/assets | gradients, shapes, crop, clips, layering, artifact semantics, negative raster controls |
| Typography | style/stretch, kerning/ligatures, numerals, bounded variable axes, justification, hyphenation, language/RTL separation |
| Compiler | exact Typst 0.15.1 source/wrapper/WASM provenance, forward-ported CSP glue patch, diagnostics, reset/reuse, cancellation, memory, VFS cleanup |
| Output policy | request compatibility, no downgrade, PDF identifiers/XMP/tags/fonts/lang/alt, external validator and negative control |
| Hosts | CLI human/JSON, Node/browser API parity, browser dependency closure, durable replay when output policy lands |
| LIVE | public build/export commands, synthetic feature zoo, retained or owned DOCSY page, redacted evidence, verified cleanup |

## Definition of done

- [ ] Catalog schema V2 can express and deterministically validate every
      catalog-V3 dependency without raw code or a recursive expression DSL.
- [ ] Recipe V2 supports a digest-pinned installed baseline plus sparse
      overrides and emits a complete deterministic pack.
- [ ] P0 has merged separately: exact Typst 0.15.1 source/wrapper/WASM hashes
      are pinned, the generated-glue CSP patch is re-derived and proved,
      browser/extension/runtime gates pass, and no dual runtime remains.
- [ ] Recipe V1, catalogs V1/V2, and canonical revisions 1-4 remain byte-exact
      migration fixtures; old-range rejection and non-destructive V1 range
      migration/rev4 rebuild are covered by executable tests.
- [ ] Catalog V3/revision 5 implements and proves the selected page, running,
      navigation, component, paint, crop/clip, and typography capabilities on
      Typst 0.15.1, including selected bleed, list-marker alignment, and
      bounded variable-font-axis capabilities.
- [ ] No `typst`, `showRules`, `selector`, `function`, arbitrary-expression,
      path/mask, or generic scene-tree field exists in recipe or manifest data.
- [ ] Typst 0.15.1 is fully ratcheted and proven. Output-standard work is
      either fully proven or explicitly recorded as deferred; no partial
      capability is advertised.
- [ ] Every implemented field names its owner, compiler availability,
      stability, consumers, and required proof classes.
- [ ] Focused tests, real compiler tests, browser gate, API closure, typecheck,
      build, docs, and full offline suite pass.
- [ ] The production CLI build/export path and LIVE `mayflower`/`DOCSY` gate
      pass with redacted evidence and verified cleanup.
- [ ] Documentation includes minimal and advanced examples, full field
      reference, troubleshooting, migration guidance, related topics, and
      explicit compliance boundaries.

## Global STOP conditions

Stop and report instead of improvising if any of the following occurs:

- preserving the new feature requires changing catalog V1/V2 digests or
  canonical revisions 1-4;
- the outer Typst render hook must change incompatibly; plan a new
  `wiki.pdf-template/vN` contract first;
- a requested YAML feature requires raw Typst, arbitrary selectors/functions,
  a generic scene tree, arbitrary masks/paths, network fetching, or an
  unbounded recursive structure;
- a recipe-V2 pack cannot be rendered from its complete manifest without the
  original recipe or baseline registry;
- P0 cannot produce an exact, reproducible Typst 0.15.1 pair or retain strict
  CSP without generic evaluation;
- a historical archive, digest, canonical revision, or compiler range would
  need to be rewritten instead of preserved as migration evidence;
- local migration would overwrite the input or fabricate missing recipe/design
  information from canonical Typst;
- the compiler binding cannot expose PDF standards without an unaudited fork,
  CSP weakening, or unsafe global-state behavior;
- external PDF validation is unavailable or inconclusive but the task would
  otherwise claim conformance;
- a semantic feature such as footnotes, citations, math, glossary, or index
  lacks renderer-neutral source IR;
- a LIVE test would use a space other than `DOCSY`, mutate a retained page,
  persist credentials/private tenant data, or delete without ownership proof;
- a verification command fails twice after a reasonable scoped correction, or
  implementation requires materially expanding an out-of-scope package.

## Maintenance and review notes

- Review catalog changes as public contract changes. A new descriptor is not
  complete until validation, canonical consumption, presentation metadata,
  compiler gating, and its declared proofs all exist.
- Keep revision implementations in separate source generators. Do not make an
  old revision call the latest generator with defaults.
- Keep authoring ergonomics in recipe V2 and executable completeness in the
  pack manifest. Do not make runtime output depend on a baseline lookup.
- Treat compiler upgrades as rendering migrations even when TypeScript APIs do
  not change.
- Any future two-column, footnote, bibliography, math, glossary, index,
  attachment, spot-color, or signing work needs its own plan and evidence lane.
- Commits use Conventional Commits, for example
  `feat(pdf): add capability catalog v3`. Do not push or release unless the
  operator explicitly requests it; releases always require the documented
  dry-run first.

## Unresolved product questions

These do not block T1-T2 after P0; resolve them before selecting the corresponding
feature slices:

1. Should catalog V3 ship all T3-T6 slices together, or should each additive
   slice receive its own catalog/revision? **Recommendation:** one catalog V3
   and revision 5 only if the work lands in one coordinated release; otherwise
   increment catalog/revision per independently released slice.
2. May recipe V2 initially resolve only atlcli-shipped baselines?
   **Recommendation:** yes. Add custom baseline registries only with a concrete
   host and distribution use case.
3. Is the first product target enterprise handbooks/space-tree exports or
   magazine layouts? **Recommendation:** enterprise handbooks; defer columns
   and arbitrary layout ambitions.
4. Which PDF standards must be product-supported first?
   **Recommendation:** start with one PDF/UA-1 lane and one archival profile
   selected after validator/tooling proof; do not promise the whole Typst
   allowlist merely because the compiler exposes it.
