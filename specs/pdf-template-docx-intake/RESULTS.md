# PDF template DOCX intake proof record

This file records reproducible evidence for the implementation tasks in
`PLAN.md`. A task is complete only when every acceptance criterion has direct
evidence here or in a referenced committed artifact. Passing test counts alone
do not establish a product capability.

## Evidence conventions

- **Structural** means a committed schema, fixture, or deterministic byte-level
  assertion proves the stated contract.
- **Automated** means the named command completed successfully.
- **Browser** means the browser export harness executed in Chromium rather than
  only compiling.
- **Visual** means every rendered page image was opened and inspected.
- **Parity** means a committed conformance case produced its expected digest in
  both compared hosts.
- **Supplemental** evidence can expose unsupported real-world structure but
  cannot replace the neutral committed fixture suite.

## T0 — Contracts, characterization, fixtures, and proof scaffolding

**Status:** Proven on 2026-07-27.

### Environment and characterization boundary

| Item | Recorded value |
|---|---|
| Characterization commit before resolver changes | `704e71db8b64f59b287eeced693651d8e7f3f5c7` |
| Bun | `1.3.14` |
| typst.ts | `0.7.0` |
| Typst compiler | `0.14.2` |
| Word fixture producer | Microsoft Word for Mac `16.111.1` |
| LibreOffice fixture producer | LibreOffice `7.1.1.2` |

The characterization commit contains only the reviewed plan decision update.
No resolver or PDF-template runtime behavior had been changed when the
baseline commands and digests below were recorded.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Locked dependency install | `bun install --frozen-lockfile` | Passed; 1,562 packages installed and the vendored Typst runtime resolved |
| Reproducible PDF fonts | `bun run fonts:ensure` | Passed; 12 pinned files verified |
| Existing PDF unit characterization | `bun run test packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf-compiler-browser/src/compiler.test.ts` | Passed; 65 tests, 280 assertions, 0 failures |
| Browser harness build | `bun run build:browser-export-harness` | Passed |
| Conformance inventory | `bun run assert:conformance-cases` | Passed; 18 declared cases |
| Real browser harness | `bun run test:browser-export-harness` | Passed; 4 Playwright tests in Chromium |
| Node/browser PDF parity | `bun run check:parity` | Passed for `pdf-settings`, `blocks`, `scope`, `content-compat`, `macros`, and `manuscript` |
| T0 fixture and UX contracts | `bun run test packages/docx-template-intake/src/fixtures/fixtures.test.ts` | Passed; 10 tests, 1,512 assertions, 0 failures |
| Fixture privacy with a local deny-list marker | `ATLCLI_FIXTURE_PROHIBITED_TERMS=<private-marker> bun run test packages/docx-template-intake/src/fixtures/fixtures.test.ts` | Passed; 10 tests, 1,598 assertions, 0 failures; marker value not persisted |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| DOCX generation reproducibility | Run `create-neutral-source.py` twice with the documented runtime and compare SHA-256 | Passed; both outputs were `246e3c3e0a1d8db6ab6049dc750c64620fbc40dab7e740da6b92d3d303cdb8fa` |
| Fixture render | Run the document runtime's `render_docx.py` with `--emit_pdf` for each of the three fixtures | Passed; two pages rendered for every producer |
| Diff hygiene | `git diff --check` | Passed |

The final milestone rerun is the authoritative result for these commands. An
environment warning that the shared Turbo cache could not perform an optional
I/O operation did not fail a task and did not change any result.

### Baseline PDF digests

| Case | SHA-256 |
|---|---|
| `pdf-settings` variant A | `11105a2c8a0c234ed51c008246a971fbbef1cde451d4959844703f4e717fd0c7` |
| `pdf-settings` variant B | `0d1635cb30fcb8d74f7ff5a4facdb04ae76596db699a190af79efad6896cc25b` |
| `blocks` | `ef5c0506388bbea393aa85b2321709785d0507b12677b2a3c7257a3368179e23` |
| `scope` | `38f04ccea254209784d5abb94ac013765621f35678410911710593e5c8dc8375` |
| `content-compat` | `b4ce63e973e782bf4fd79d1b5442170fe90f6184d7483402db00784debba7541` |
| `macros` | `2acfbe84808ef083c7a36cf44c1214beed199206cd63203cfd747b5eb365f55f` |
| `manuscript` | `66f4bb7675343e6e6acdfb82552824dbe7adac02a62a07859e479bd120a166f4` |
| `manuscript-builtin` (Editorial Indigo projection) | `4f27b57e13080e39ba99d8c429cf534407a006303e3360ca7a8085578c35195a` |

The digests prove preservation of the named characterized outputs. They do not
prove visual equivalence to arbitrary Word documents.

### Committed fixtures and artifacts

| Artifact | SHA-256 or role |
|---|---|
| `packages/docx-template-intake/src/fixtures/neutral-generated-python-docx-1.2.0.docx` | `246e3c3e0a1d8db6ab6049dc750c64620fbc40dab7e740da6b92d3d303cdb8fa` |
| `packages/docx-template-intake/src/fixtures/neutral-word-16.111.1.docx` | `938e7a9d105a41ffa14baedf37f21f4388cc1b2131be7e16ad73f5b5a4a8cf4a` |
| `packages/docx-template-intake/src/fixtures/neutral-libreoffice-7.1.1.2.docx` | `688e49f1cb7d0acb31a3c5c4398fbcba14675c6785a0d1e9a75114fabdcdd466` |
| `packages/docx-template-intake/src/fixtures/goldens/*.analysis.json` | Text-free, canonical structural analyses |
| `packages/docx-template-intake/src/fixtures/goldens/analysis-result.schema.json` | Fixture-analysis JSON schema |
| `packages/docx-template-intake/src/fixtures/goldens/resource-caps.v1.json` | Parser choice, measurements, selected caps, and boundary plans |
| `packages/docx-template-intake/src/fixtures/ux/` | Versioned journey, API names, transcripts, and usability script |
| `apps/browser-export-harness/test-results/digests.json` | Generated and ignored parity evidence |
| `.tmp/pdf-template-docx-intake/t0-render/{generated,word,libreoffice}/` | Generated and ignored PDF/page-image render evidence |

The Word-produced fixture was privacy-scrubbed after its producer save.
Automated privacy checks scan extracted OOXML, metadata, committed text
artifacts, URLs, and optional local deny-list terms. Only the synthetic markers
listed in the fixture README are permitted. A private supplemental DOCX also
completed a local structural parse; no name, path, digest, metadata, or content
from it is persisted in the repository.

### Fixture measurements and selected hard caps

The selected parser is `saxes@6.0.0` in namespace-aware streaming mode. Intake
fails closed on a doctype, entity, parser warning, or malformed XML. The
existing aggregate ZIP budgets remain unchanged at 2,048 entries, 128 MiB
total uncompressed bytes, and 64 MiB for one uncompressed entry.

| Resource | Largest neutral fixture | Selected limit |
|---|---:|---:|
| XML part bytes | 438,131 | 2,097,152 |
| XML part characters | 438,131 | 2,097,152 |
| XML elements per part | 9,200 | 40,000 |
| XML depth | 13 | 64 |
| XML attributes per part | 14,031 | 60,000 |
| XML attribute characters | 92 | 512 |
| Raster pixels | 460,800 | 16,777,216 |
| Raster dimension | 1,280 | 8,192 |
| SVG bytes | 232 | 1,048,576 |
| SVG elements | 4 | 10,000 |
| SVG depth | 2 | 128 |
| SVG attributes | 11 | 50,000 |
| SVG path-data bytes | 38 | 524,288 |
| SVG filters | 0 | 64 |

Every non-zero measured maximum has at least four times headroom. For every
listed resource, the committed cap contract defines three future boundary
fixtures at `limit - 1`, `limit`, and `limit + 1`. T0 proves the measurements
and freezes those plans; T3/T5 must prove enforcement before consuming
untrusted documents or visual assets.

### Visual inspection

All six page images were inspected at original resolution. Each producer
render preserves the two-section portrait/landscape structure, page border,
header, heading hierarchy, body/direct formatting, table, visual, and caption.
No clipping, overlap, missing glyph, or unintended overflow was observed.
Expected producer normalization changes table width slightly; LibreOffice also
omits the SVG extension while retaining the raster fallback.

### UX contract evidence

- The state fixture defines exactly seven stages and only stage-valid next
  actions.
- Ten normative transcripts cover first import, resume, ready and uncertain
  review, asset review, changed-source recovery, build blocking, preview,
  build, and undo.
- Primary-path text never exposes candidate IDs, capability paths, JSON
  editing, a built-in baseline identifier, OOXML, or Typst.
- Failure transcripts state that the active draft is retained.
- Every transcript message code is registered with bounded parameters. Removing
  its default copy still emits the stable code plus safe diagnostic parameters.
- The synthetic usability script requires a rendered design review in no more
  than four primary commands and correct explanations of applied, retained,
  open, and unsupported choices.

This evidence proves the frozen contract and proof scaffolding. It does not
claim that the intake engine, renderer extensions, CLI journey, or pack loader
from T1–T10 already exist.

## T1 — Versioned PDF capability catalog and complete baselines

**Status:** Proven on 2026-07-27.

### Catalog and presentation contracts

| Item | Recorded value |
|---|---|
| Runtime descriptors | 201 |
| Primary presentation descriptors | 78 |
| Explicit details-only descriptors | 123 |
| Capability catalog digest | `d871153baebf8e1cc318736ea34103213882e5d9569aa0efc820b226753a885c` |
| Presentation registry revision | `4b9725c298b76d2627ab45ccd061134a011b56d27837fd68d409dd0f0e6b246d` |

`packages/template-pack/src/capabilities.ts` owns the browser-safe generic
contracts, canonical flattening, validation, and digest functions.
`packages/pdf/src/design-catalog.ts` owns the renderer-specific inventory and
presentation classification. Runtime capability data contains no localized
copy. Reordering a separate localization object leaves both digests unchanged;
regrouping a presentation descriptor changes only the presentation revision.

The coverage test scans executable source in the Typst template, serializer,
settings resolver, theme, and binding validator. It rejects direct reads from
an unprojected design, checks every literal or helper-derived path against the
catalog, covers every binding allowlist target, and requires exactly one
matching runtime writer for every curated binding.

### Baseline and legacy behavior

- Editorial Indigo and Manuscript flatten and unflatten canonically and contain
  every required capability. Manuscript now states the 18 values that
  previously came from hidden Editorial Indigo fallbacks.
- Strict authoring validation rejects an unconsumed leaf with
  `unknown-capability` and the exact path. Legacy validation reports and drops
  the same leaf.
- A foreign sparse V1 design remains structurally readable but fails execution
  at its first exact missing path; it is never completed from Editorial Indigo.
- Known historical curated IDs use an explicit, characterized compatibility
  adapter. The four historical success/error callout aliases are named in that
  adapter rather than hidden at renderer read sites.
- Catalog descriptors reject multiple runtime writers unless all writers have
  one declared order. The production V1 catalog currently has no intentional
  overlap, so no runtime overlap order is claimed.

### Presence semantics and the Manuscript correction

`resolvePdfSettings()` records raw presence separately from normalized Level-A
values. All six bindable settings are covered by no-input, single-input, and
partial-input assertions. A runtime binding writes only when its source key was
present. Theme `ink`, `paper`, and `minimumContrast` writes are likewise
field-presence based and append exact engine-policy trace entries.

This corrects one characterized Manuscript defect. Previously, absent inputs
were normalized and then treated as authored values. That replaced the
manifest's green accent and own ink/paper with Editorial Indigo defaults. The
trace identifies only these writes:

| Target | Correct source/value | Former injected source/value |
|---|---|---|
| `branding.accent` | baseline `#0B6E4F` | `setting.accentColor` → `#4B57A3` |
| `tokens.colors.accent` | baseline `#0B6E4F` | `setting.accentColor` → `#4B57A3` |
| `tokens.colors.ink` | baseline `#1B2733` | `theme.colors.ink` → `#172B4D` |
| `tokens.colors.paper` | baseline `#FBF9F4` | `theme.colors.paper` → `#FCFBF8` |
| `tokens.contrast.minimum` | baseline `4.5` | `theme.table.coloredCellText.minimumContrast` → `4.5` |

The contrast value is numerically unchanged but remains in the former write
trace because the old resolver still overwrote it.

### PDF parity and raster comparison

| Case | T0 SHA-256 | T1 SHA-256 | Result |
|---|---|---|---|
| Editorial Indigo projection | `4f27b57e13080e39ba99d8c429cf534407a006303e3360ca7a8085578c35195a` | `4f27b57e13080e39ba99d8c429cf534407a006303e3360ca7a8085578c35195a` | Byte-identical |
| Manuscript | `66f4bb7675343e6e6acdfb82552824dbe7adac02a62a07859e479bd120a166f4` | `b258511c3daf444015562e868b049e38ab0ea54631a5eeecafab36e5a0568845` | Expected presence fix |

The T0 Manuscript digest was reproduced exactly on the T1 code by explicitly
supplying the former normalized Level-A and theme defaults. The corrected and
former PDFs are both tagged, four-page A4 documents. Poppler rendered all
eight pages at 144 DPI (`1191 × 1684` pixels). At an 8% background tolerance,
the corresponding non-background bounds were exactly equal:

| Page | Bounds in both renders |
|---|---|
| 1 | `474x481+153+418` |
| 2 | `884x1522+153+77` |
| 3 | `888x1522+150+77` |
| 4 | `660x1090+153+509` |

Every old/new page pair was visually inspected. Pagination, typography,
spacing, line wrapping, tables, headers, footers, and content placement are
unchanged. Only the expected accent, ink, and paper colors move from injected
Editorial Indigo defaults to the Manuscript manifest. No clipping, overlap,
missing glyph, or geometry drift was observed. Generated PDFs and page images
remain ignored under `.tmp/pdf-template-docx-intake/t1/`.

All other T0 browser digests remain byte-identical:
`pdf-settings` A/B, `blocks`, `scope`, `content-compat`, and `macros`.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T1 suite | `bun run test packages/template-pack/src/capabilities.test.ts packages/pdf/src/design-catalog.test.ts packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts` | Passed; 65 tests, 461 assertions, 0 failures |
| PDF serializer and real compiler regressions | `bun run test packages/pdf/src/serialize.test.ts packages/pdf-compiler-browser/src/second-template.test.ts packages/pdf-compiler-browser/src/chapter-running-head.test.ts` | Passed; 105 tests, 448 assertions, 0 failures |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero reachable-but-unexported gaps |
| Repository type safety | `bun run typecheck` | Passed |
| Full monorepo build | `bun run build` | Passed; 17 tasks |
| Full repository suite | `bun run test` | Passed outside the filesystem sandbox; 5,532 tests passed, 12 environment-gated tests skipped, 0 failures |
| Browser output integrity | `bun run check:browser-export-harness` | Passed |
| Conformance inventory | `bun run assert:conformance-cases` | Passed; 18 declared cases |
| Real browser harness | `bun run test:browser-export-harness` | Passed; 4 Playwright tests in Chromium |
| Browser/Bun parity | `bun run check:parity` | Passed for all six digest-producing cases |
| Diff hygiene | `git diff --check` | Passed |

The first full-suite run inside the restricted filesystem sandbox failed its
local HTTP-server tests because socket binding was unavailable. It also found
the expected stale API reports. After exporting the new reachable types and
updating the reviewed reports, the unrestricted rerun above completed with
zero failures.

This evidence proves T1 only. It does not claim that the authoring core or DOCX
analysis from T2 onward exists.

## T2 — Browser-compatible authoring core

**Status:** Proven on 2026-07-27.

### Package and contract boundary

`packages/pdf-template-authoring` is a new renderer- and DOCX-independent
workspace package. Its default, browser, and Node entry points expose the same
portable surface. The browser gate bundles the complete entry point and proves
that no `node:`/`bun:` builtin is reached. A source-contract test additionally
rejects `File`, `Blob`, `PathLike`, IndexedDB, Node streams, and direct
Node/Bun imports in the core and its application ports.

The generated API report classifies 101 exported symbols as experimental
`0.x`. The generated closure report has zero reachable-but-unexported gaps.
The package owns:

- versioned candidates, evidence, decisions, staleness, layer diffs,
  resolution snapshots, import views, progress events, and typed messages;
- the only decision reducer and the only import-view/action reducers;
- separate safe and recommended policy identities and input digests;
- repository, asset-store, preview-compiler, and runtime-materializer ports;
- deterministic in-memory adapters for repository history, optimistic
  conflicts, undo-as-new-generation, byte-copying assets, and previews.

Candidate handles, candidate fingerprints, source fingerprints, semantic
reconciliation keys, catalog/baseline/decision/snapshot digests, and project
generation IDs use separate canonical inputs. Tests change each dimension
independently and prove that unrelated identities remain stable.

### Decision, resolution, and reconciliation proof

- Baseline-only resolution covers every effective target with a baseline trace.
  Accepted candidates are frozen; an override wins and clearing it reveals the
  frozen value again.
- Resolution sorts canonical writes and applies only declared candidate rank.
  Unequal values at equal rank produce a deterministic
  `ambiguous-conflict`; reversing input order produces the same conflict.
  Atomic candidates pass validation and apply as a unit or leave the input
  state unchanged.
- A semantic tombstone blocks only its key. A wildcard tombstone blocks future
  candidates throughout its target/group scope. Exact reset leaves neighboring
  tombstones, rejections, and overrides intact.
- Rejection is fingerprint-bound. An alternative in the same semantic group
  remains visible, safe, and selectable; canonical JSON round-trips unchanged.
- Safe policy accepts only unambiguous, native, type-valid token candidates
  that are source-explicit/source-derived and conclusive. Assets, fonts,
  conversions, invalid values, conflicts, and blocked candidates stay open.
  Recommended policy adds only corroborated candidates. Both persist their
  policy ID, version, and canonical input digest. User decisions contain
  neither policy metadata nor timestamps.
- Asset acceptance fails without a role, SHA-256 identity, rights
  confirmation, and a complete accessibility/rendering decision.
  Layout-dependent scenes cannot use candidate placement.
- Reanalysis proves all six states: `current`, `candidate-changed`,
  `candidate-missing`, `mapping-changed`, `source-changed-same-value`, and
  `catalog-migration-required`. Every case returns the original frozen
  decisions unchanged.

### Host-neutral journey proof

The table-driven projection test covers all seven product stages:
`analyzing`, `review-required`, `ready-to-preview`, `ready-to-build`, `built`,
`source-changed`, and `blocked`. Each row asserts the complete enabled action
set. `ready-to-build` is constructible only with zero unanswered items, zero
blockers, a current inventory acknowledgement, current decisions, and two
fresh previews.

Individual Word-value, keep-current, customize, and asset actions are bound to
the exact review item that enabled them. Apply-ready, keep-all-remaining,
inventory acknowledgement, reanalysis, preview, build, and undo pass through
the same reducer semantics. A disabled or cross-item action fails closed.

The primary view calls the safe set “ready to apply” through structured action
codes. It contains no “Accept recommendations” action; the broader recommended
set exists only in the expert API. Keeping all remaining suggestions creates
explicit scoped tombstones, takes `unanswered` to zero, and leaves unsupported
items visible. Changing the analysis digest makes the inventory
acknowledgement stale.

Canonical view JSON is byte-identical after candidate reordering. Locale is not
an input, and values/messages contain no ANSI, HTML, or localized prose.
Authoring messages have exactly one registry owner and exact parameter names,
types, formats, and bounds. Unsafe paths, URLs, HTML, terminal escapes,
unknown/duplicate codes, and excess parameters fail validation. Blocking
diagnostics require a recovery action except for an unreadable source.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T2 suite | `bun run test packages/pdf-template-authoring/src` | Passed; 27 tests, 152 assertions, 0 failures |
| Browser portability | `bun run check:browser` | Passed; all 22 browser entry points, including the new authoring barrel, built without Node/Bun builtins |
| Package declaration build | `bun run --cwd packages/pdf-template-authoring build` | Passed |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 18 tasks |
| Full repository suite | `bun run test` | Passed outside the filesystem sandbox; 5,559 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The live Confluence E2E is not applicable to T2: this task deliberately adds no
CLI command, filesystem adapter, network operation, renderer behavior, or
Confluence mutation. Browser bundling, in-memory port integration, full build,
and the complete repository suite prove this package boundary. Live CLI and
export evidence begins at the CLI/materialization tasks.

This evidence proves T2 only. It does not claim that the secure OOXML facts
layer or DOCX-to-catalog matching from T3 onward exists.

## T3 — Secure, namespace-aware OPC/OOXML facts layer

**Status:** Proven on 2026-07-27.

### Hardened intake boundary

`@atlcli/docx-template-intake` is a browser-safe, byte-in/facts-out package
with identical default, browser, and Node exports. It owns no file, terminal,
network, persistence, or renderer operations. Its generated API report exposes
37 experimental `0.x` symbols, and its closure report has zero
reachable-but-unexported gaps.

The package delegates ZIP admission to the existing `@atlcli/docx`
`unzipDocx()` boundary. `DOCX_TEMPLATE_INTAKE_BUDGET` adds 2 MiB decoded XML
byte and character limits without changing the existing export mode. An
instrumented regression proves that a declared-oversize XML part is rejected
before `asText()`, active-content inspection, or streaming parse can read it.
The complete pre-existing bomb, forged-directory, entry-flood, hostile-path,
active-content, and risky-field corpus remains green.

After preflight, a namespace-aware `saxes` 6.0.0 streaming parser reads XML in
16 KiB decoded chunks. The frozen per-part limits are 2 MiB bytes, 2 MiB
characters, 40,000 elements, depth 64, 60,000 attributes, 512 characters per
attribute, and 100,000 total nodes. Boundary tests cover every rejecting limit
and an exact-maximum control. A 256 KiB text body produces a summary shorter
than 160 serialized characters and retains neither text nor a DOM. Malformed
XML, `DOCTYPE`, and entity declarations fail closed as typed part errors.

### Canonical OOXML facts and compatibility

The OPC graph normalizes internal relationship targets relative to their
source part and reports traversal, missing targets, and duplicate IDs with
stable diagnostics. External targets become only `external-unresolved`
records containing a scheme class and fingerprint. A fetch spy proves zero
network access, and golden JSON proves that host, path, query, credentials,
document text, raw XML, Base64, and absolute source paths are absent.

The semantic relationship allowlist reads only supported
WordprocessingML/theme/drawing parts. OLE objects, embedded packages, audio,
video, external data, and unknown binaries are inventoried only by class and
declared size. Payload spies across all six classes prove zero reads and zero
extraction.

Facts are derived from namespace URI and local name, so prefix permutations
and equivalent Transitional/Strict inputs produce byte-identical semantic
results. The inventory covers styles, theme color slots, settings, numbering,
fonts, sections and page geometry, headers, footers, backgrounds, page
borders, drawings, media references, and per-story/per-section style or direct
format usage. Insertions count as visible usage; deletions do not, and any
revision presence lowers confidence through a named warning.

`MarkupCompatibilityProfileV1` pins understood namespaces/features and the
first-understood-choice-else-fallback policy. DrawingML choice plus VML
fallback contributes exactly one scene while both variant fingerprints remain
as provenance. Multiple choices, unknown `Requires`, missing fallbacks,
nested `AlternateContent`, and relevant MCE attributes have explicit tested
outcomes or named diagnostics.

### Host-neutral diagnostics and progress

All portable warnings and errors have a stable code, severity, validated safe
parameters, and recovery actions when recovery is possible. Host code renders
locale-specific copy from those facts; changing copy leaves the canonical
analysis and diagnostic identity unchanged. Scan and resolve progress events
are monotonic, structured-clone safe, and byte-identical through browser and
Node entry points.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T3 suite | `bun run test packages/docx/src/scan.test.ts packages/docx-template-intake/src/opc.test.ts packages/docx-template-intake/src/ooxml-facts.test.ts packages/docx-template-intake/src/privacy.test.ts` | Passed; 79 tests, 258 assertions, 0 failures |
| Browser portability | `bun scripts/check-browser-build.ts` | Passed; all 23 browser entry points, including the intake barrel, built without Node/Bun builtins |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | Passed; 5,577 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The first complete-suite attempt exposed the intentionally updated browser
entry-point inventory; the next exposed one order-sensitive assertion in an
otherwise canonical diagnostic test. Both proof harness expectations were
corrected, and the final complete run above passed with zero failures.

The live Confluence E2E is not applicable to T3: this task adds no CLI command,
network write, renderer path, or Confluence mutation. All source inputs are
neutral synthetic fixtures; no private supplemental DOCX or customer-derived
artifact was used or persisted.

This evidence proves T3 only. It does not claim style resolution, catalog
matching, asset extraction, CLI review, or template-pack materialization from
T4 onward.

## T4 — Style, theme, section, usage, and token matching

**Status:** Proven on 2026-07-27.

### Resolved design model

`@atlcli/docx-template-intake` now exposes a one-unzip, browser-safe analysis
path from DOCX bytes to a resolved design model and catalog candidates. Style
resolution applies `docDefaults`, arbitrarily deep `basedOn` inheritance,
style properties, and per-use direct formatting in the required order.
Missing parents, inheritance cycles, and invalid property values remain typed
diagnostics; an unresolved chain cannot become a safe match.

Semantic role detection combines standard style identity, localized display
name, quick-format metadata, UI priority, outline level, inheritance, and
effective non-deleted usage. It distinguishes built-in, localized, and custom
heading evidence without treating an unused style name as proof. Inserted
content contributes usage; deleted revisions do not; revision presence is
retained as a confidence signal.

Theme resolution is deterministic per script and produces canonical uppercase
hex colors after color-scheme mapping, tint, and shade. Equivalent theme and
literal representations therefore produce the same candidate fingerprint.
Fonts are matched only against an injected bundled-family set; a non-bundled
family is blocked from safe adoption and no font bytes are read or emitted.

### Section masters and catalog-constrained matching

Page geometry retains exact twip values, recognizes A4 and Letter only within
the frozen tolerance, and never rounds custom sizes to a supported format.
Multi-section geometry becomes a global native candidate only when every
effective section agrees. First/default/even header and footer references are
resolved with Word inheritance, `titlePg`, even/odd settings, and page-number
restart semantics. Unsupported section scope is reported explicitly rather
than globalized.

The versioned matcher can emit only capability paths present in the injected
PDF catalog. It covers page, body, H1–H3, code, table, central color, spacing,
font, and decoration concepts. Direct-format aggregates require the pinned
minimum count and dominance threshold. Every candidate carries value nature,
confidence, compatibility, adoption, rule version, evidence locators, and
structured explanation facts.

The shared review projection presents business concepts and
baseline/proposed/effective values. Internal candidate IDs, fingerprints, and
capability paths are confined to its details payload. The intake API report
contains 85 experimental symbols and its closure report has zero
reachable-but-unexported gaps.

All test documents are neutral synthetic in-memory OOXML fixtures. The
end-to-end fixture asserts that document text, display names, source paths,
and raw XML do not enter the resolved model or candidate output.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T4 suite | `bun run test packages/docx-template-intake/src/style-resolution.test.ts packages/docx-template-intake/src/theme-resolution.test.ts packages/docx-template-intake/src/section-resolution.test.ts packages/docx-template-intake/src/matching.test.ts` | Passed; 21 tests, 353 assertions, 0 failures |
| Existing authoring contract | `bun run test packages/pdf-template-authoring/src` | Passed; 27 tests, 152 assertions, 0 failures |
| Browser portability | `bun scripts/check-browser-build.ts` | Passed; all 23 browser entry points built without Node/Bun builtins |
| Package declaration builds | `bun run --cwd packages/docx-template-intake build` and `bun run --cwd packages/pdf-template-authoring build` | Passed |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | 5,597 passed, 12 environment-gated skips, 1 unrelated aggregate-load timing failure; the affected `apps/cli/src/commands/export-job-runtime.test.ts` then passed 10/10 in isolation |
| Diff hygiene | `git diff --check` | Passed |

The first full-suite attempt ran inside a network-restricted sandbox and
failed existing tests that bind loopback ports. Repeating outside that sandbox
made those tests green. The only remaining full-run failure was the
timing-sensitive job-stream assertion above; its immediate isolated rerun
passed without code changes.

The live Confluence E2E is not applicable to T4: this task adds no CLI command,
filesystem adapter, renderer behavior, network operation, or Confluence
mutation. Its evidence is the real in-memory DOCX path, browser portability,
catalog and authoring integration, build/type gates, and repository regression
suite.

This evidence proves T4 only. It does not claim asset extraction, page-scene
mapping, CLI review, or template-pack materialization from T5 onward.

## T5 — Visual assets, backgrounds, and page scenes

**Status:** Proven on 2026-07-27.

### Shared capability and safe asset boundary

`@atlcli/template-pack` now owns the engine-neutral
`TemplateAssetCapabilitiesV1` contract and fail-closed validator. The PDF
renderer publishes `PDF_TEMPLATE_ASSET_CAPABILITIES_V1` with its existing
per-file byte ceiling plus explicit width, height, total-pixel, SVG element,
path, and filter budgets. DOCX intake consumes that injected descriptor; T6
can pass the same object to pack validation without introducing a package
cycle or a second set of limits.

Internal PNG, JPEG, and SVG parts are verified against both magic bytes and
OOXML content types. PNG/JPEG dimensions are read without rendering. SVG input
uses the existing shared hostile-content policy and additional complexity
limits. Byte limits apply before media decoding, and invalid or over-budget
assets never reach the asset store. Identical bytes across different parts
produce one verified handle while every source occurrence remains a distinct
scene.

The host-owned asset store must return the canonical digest-bound handle;
path-shaped or inconsistent handles fail closed. External relationships are
never fetched, stored, copied to the private sidecar, or proposed for native
adoption.

### Scene, master, and review model

The DrawingML resolver preserves inline and anchored placement, independent
horizontal and vertical reference systems, `simplePos` and its activation
flag, extents and effect extents, distances, wrap, z-order signals, overlap
and cell-layout flags, complete transforms, flips, rotation, opacity, and
crop. Page/margin anchors are native; paragraph/line-dependent placement is
explicitly unsupported. Relationship-free shapes remain inventory scenes
through an `inline-xml` fingerprint.

Header and footer scenes bind to effective first/default/even section masters.
Non-uniform multi-section layouts, multi-section first-page variants, and
page-number restarts remain `unsupported-section-scope`. Solid/theme document
backgrounds and page-border facts are preserved; only a four-sided uniform
`single` border relative to the page is classified as native.

AlternateContent choice and fallback representations share one logical scene,
retain selected-branch provenance, and keep variant assets separate. Charts,
SmartArt, VML, groups, text boxes, EMF/WMF, and complex effects are counted
and localized without producing asset slots or Typst.

Role suggestions for repeated header logos, page-filling backgrounds,
first-page cover art, and large rotated/transparent watermarks carry
structured reasons and remain `corroborated`, never filename-derived
conclusions. Every `AssetReviewDescriptorV1` defaults to **Do not include**;
rights, semantic role, accessibility, and placement remain unanswered until a
user decision.

Portable visual JSON contains only role/ordinal source references,
fingerprints, sanitized master locations, and safe handles. Raw part names,
relationship targets, shape metadata, and source alt text exist only in the
separate private sidecar. Random Unicode probes prove that separation.

The generated API/closure reports expose 105 experimental intake symbols, 102
template-pack symbols, and 82 PDF host symbols with zero
reachable-but-unexported gaps. Archive-level and oracle-test helpers remain
outside the public barrels.

### Independent oracle

Reviewed Microsoft Word 16.111.1 and LibreOffice 7.1.1.2 fixtures have frozen
oracle entries covering selected asset digest, relationship and target
fingerprints, crop, anchor references, section/master assignment, and default
adoption. A field-addressed comparator proves that mutations to crop,
relationship target, AlternateContent branch, and section assignment each
produce exactly one responsible mismatch.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T5 suite | `bun run test packages/docx-template-intake/src/assets.test.ts packages/docx-template-intake/src/drawingml.test.ts packages/docx-template-intake/src/visual-roles.test.ts` | Passed; 21 tests, 90 assertions, 0 failures |
| Shared asset-capability contract | `bun run test packages/template-pack/src/asset-capabilities.test.ts packages/pdf/src/template-asset-capabilities.test.ts` | Passed; 3 tests, 10 assertions, 0 failures |
| Complete intake regression suite | `bun run test packages/docx-template-intake/src` | Passed; 69 tests, 2,051 assertions, 0 failures |
| Browser portability | `bun scripts/check-browser-build.ts` | Passed; all 23 browser entry points built without Node/Bun builtins |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | Passed outside the network sandbox; 5,622 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The live Confluence E2E is not applicable to T5: this task adds no CLI command,
renderer behavior, filesystem adapter, network operation, or Confluence
mutation. It uses neutral synthetic inputs plus the committed privacy-reviewed
Word and LibreOffice fixtures.

This evidence proves T5 only. It does not claim runtime asset slots,
decorations in rendered PDFs, CLI review, or template-pack materialization
from T6 onward.

## T6 — PDF asset slots and page decorations

**Status:** Proven on 2026-07-27.

### Three-phase validation and fixed compiler boundary

`@atlcli/template-pack` now owns engine-neutral asset descriptors, references,
and page-decoration shapes. Its validator checks only JSON shape, safe relative
paths, references, lengths, colors, and numeric bounds. It does not claim that
a slot is supported by PDF or that payload bytes exist.

`@atlcli/pdf` adds the second, engine-specific manifest phase and the third,
payload-integrity phase. The PDF phase accepts only the five cataloged slots,
the image-decoration and page-border writers, the four proven page scopes, and
bounded page or margin geometry. The pack phase verifies referenced payloads,
hashes, media magic, declared dimensions, byte/pixel/SVG-complexity limits,
canonical-pack file ownership, bundled fonts, and collision-free
compiler-owned VFS targets. `loadPdfTemplatePack()` runs all three phases.
Legacy packs retain their existing tolerance for opaque unreferenced payloads;
canonical authoring packs reject them.

Meaning-bearing logos require alt text. Backgrounds, headers, footers, and
borders must be decorative. Hostile SVG, external references, unbundled fonts,
unknown writers, and VFS collisions fail before Typst compilation. The V1
builder explicitly rejects image or foreground watermarks, section-specific
decorations, text-relative or non-uniform borders, border art, crop, and
partial opacity. Intake facts for those cases remain available for review but
cannot become executable manifest claims.

### Real renderer and preview proof

The PDF runtime mounts verified visual payloads only at fixed
`template-assets/*` paths and threads the resolved pack through settings,
serialization, and export. Page and cover backgrounds render in the page
background layer; header and footer ornaments render in bounded margin-relative
placements; a four-sided, page-relative `single` border becomes one declarative
border decoration. Decoration source is omitted entirely for packs without
visuals, preserving the established default PDF byte digests.

The pinned Typst-WASM compiler rendered all five asset slots plus the uniform
border. Poppler rasterization at 36 dpi produced at least six pages and exact
color-oracle vectors for `first`, `odd`, `even`, and `all`: cover green on the
first page only, page red on odd pages, header blue on even pages, footer
yellow on every page, logo purple on the first page, and the cyan border on
every page. The output remained tagged and outlined; all ornaments were
`pdf.artifact` content and only the meaning-bearing logo produced a `/Figure`
structure element. Existing embedded-font assertions and the two approved
default-output digest tests remained green.

`PdfTemplatePreviewCompiler` is a host-neutral adapter over structured
requests. Its design-review proof produced two pages with summary, baseline,
and current region references; displayed the exact `12 / 4 / 3 / 1 / 4`
`TemplateImportViewV1` counts; and visibly distinguished A4 portrait from
Letter landscape, both typography stacks, both accent colors, and the accepted
background. Compatibility-proof and asset-contact-sheet requests produced
typed page/region references without exposing source paths. Node and browser
entry points returned identical metadata, digests, regions, and PDF bytes for
the same request.

The generated API/closure reports expose 112 template-pack symbols, 102 PDF
symbols, and 102 authoring symbols with zero reachable-but-unexported gaps.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T6 suite | `bun run test packages/template-pack/src/manifest.test.ts packages/pdf/src/settings.test.ts packages/pdf/src/template.test.ts packages/pdf-compiler-browser/src/docx-template-assets.test.ts` | Passed; 63 tests, 316 assertions, 0 failures |
| Default-output and migration parity | `bun run test packages/pdf-compiler-browser/src/docx-template-assets.test.ts packages/pdf-compiler-browser/src/chapter-running-head.test.ts packages/pdf-compiler-browser/src/template-migration-parity.test.ts` | Passed; 24 tests, 100 assertions, 0 failures |
| Browser portability | `bun scripts/check-browser-build.ts` | Passed; all 23 browser entry points built without Node/Bun builtins |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests, 14 assertions, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | Passed outside the network sandbox; 5,637 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The first full-suite attempt ran inside a network-restricted sandbox and
correctly exposed unrelated loopback failures. It also found two genuine
default-output digest regressions: unconditional decoration helpers had changed
packs with no visuals. Decoration source is now conditional, and the targeted
digest tests plus the final full suite prove byte-identical legacy output.

The live Confluence E2E is not applicable to T6: this task adds renderer and
template-pack behavior but no CLI command, filesystem adapter, network
operation, or Confluence mutation. Its E2E-equivalent evidence is the real
Typst-WASM compile, Poppler raster oracle, PDF structure inspection, and
Node/browser compiler parity.

This evidence proves T6 only. It does not claim project persistence,
deterministic authoring-pack builds, CLI review flows, or later import and
inspection commands from T7 onward.

## T7 — Project ports, CLI repository, previews, and deterministic packs

**Status:** Proven on 2026-07-27.

### Pure build and minimal pack boundary

`@atlcli/pdf-template-authoring` now owns the side-effect-free
`buildTemplateProject()` orchestration. The caller injects the active
catalog/baseline pins, verified asset store, preview artifacts, and
`TemplateRuntimeMaterializer`; the package still has no dependency on
`@atlcli/pdf`, a filesystem, or a terminal. The build binds the resolved
snapshot to the current analysis, decisions, catalog, and baseline before
materialization.

Analysis, authoring snapshot, runtime snapshot, and manifest use canonical
JSON. Runtime output is checked against the exact resolved design and accepted
asset set. Every manifest asset is then checked against its concrete payload
digest and length. Two logically equal projects with different object and file
insertion order produced identical JSON, canonical Typst, and pack bytes.

The pack inventory is fail-closed: `wiki-pdf-template.json`, `atlcli.typ`, and
accepted asset paths are the only members. Rejected and undecided private
assets were present in the injected store but absent from both manifest and
archive. A golden over the unpacked manifest and payload rejected
`decisionDigest`, `sourceDigest`, baseline, candidate, decision, and trace
fields.

`buildGeneratedPdfTemplatePack()` validates the canonical entry source,
round-trips the container byte-identically, and then compiles that exact pack
with an injected compiler. The CLI compiler loads the pinned Typst-WASM and
font set, renders a neutral heading/paragraph/table feature zoo, and requires a
tagged PDF with an outline. The real compile proof passed. A changed
`atlcli.typ` and an intentionally failing compiler both prevented pack output.

### Immutable persistence and current-intent undo

The CLI directory repository initializes through an adjacent staging
directory and refuses every existing target. Existing projects append
hash-addressed immutable `state/<generation>` directories before atomically
swapping the current marker. Private intake data is a separately
digest-verified sidecar. Accepted asset bytes remain content-addressed below
`.intake`; only confirmed build assets can be copied to `assets/<slot>/...`,
and existing or foreign bytes are never replaced or deleted.

Every repository commit and preview mutation uses an atomic exclusive lock and
rereads the base generation under that lock. Same-base concurrent writers and
conflicting preview writers produced exactly one winner. Crash injection
before the pointer swap left the old generation active; injection after the
swap exposed only the fully verified new generation. Active, expired, reused
PID, and changed-base lock cases preserved the pointer and foreign files.
Root, state, lock, intake-asset, accepted-asset, and tampered-marker cases all
failed closed on symlinks or corrupt identity.

The directory and browser-safe in-memory implementations passed the same
repository contract imported from the authoring package test support, with no
CLI dependency. Read, optimistic conflict, history, exact-generation preview,
and append-only undo semantics agree. Stateful undo is prepared by the pure
authoring core: it restores only prior decisions, re-resolves the snapshot
against current analysis/source/catalog/baseline, retains current accepted
asset handles and private intake, clears preview/build markers, and commits a
new generation without deleting history.

### Readiness, previews, and canonical-source compatibility

Build refuses unanswered review items, unacknowledged inventory, blockers,
stale decisions, missing previews, wrong-generation previews, bad preview
digests, and preview artifacts missing their required semantic regions.
Failures carry typed recovery actions. Reanalysis preserves frozen authoring
intent and accepted asset handles, replaces derived/private analysis data,
reconciles all accepted candidate and asset decisions, and invalidates
previews.

Preview orchestration requests design review and compatibility proof for every
generation plus a contact sheet only when visual candidates exist. The
design-review contract requires summary, baseline, and current regions; the
compatibility proof requires the feature-zoo region; the contact sheet
requires only the asset-grid region. Digests, lengths, output handles/bytes,
page counts, generation, and snapshot identity are verified before build. The
real T6 Typst preview adapter additionally proves valid PDFs, exact summary
counts, visible baseline/current samples, asset-only contact sheets, and
Node/browser byte parity.

The PDF canonical-source contract is now explicit and exported:
`wiki.pdf-canonical-typst` revision `2`. Revision `1` remains supported, while
unknown future revisions receive `unsupported-canonical-revision` with an
explicit migration diagnostic. The CLI materializer uses only
`createAtlcliTypstTemplate()` with fallback locale labels; document locale
continues to enter at render time rather than becoming pack source.

The generated API/closure reports expose 124 experimental authoring symbols
and 105 stable PDF symbols with zero reachable-but-unexported gaps.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T7 suite | `bun run test packages/pdf-template-authoring/src/project.test.ts packages/template-pack/src/pack.test.ts apps/cli/src/commands/pdf-template-project-writer.test.ts` | Passed; 36 tests, 148 assertions, 0 failures |
| Extended authoring/pack/preview proof | `bun run test packages/pdf-template-authoring/src/project.test.ts packages/template-pack/src/pack.test.ts apps/cli/src/commands/pdf-template-project-writer.test.ts packages/pdf-template-authoring/src/core.test.ts packages/pdf/src/template-pack.test.ts packages/pdf-compiler-browser/src/docx-template-assets.test.ts scripts/api-report.test.ts` | Passed; 82 tests, 429 assertions, 0 failures |
| Browser portability | `bun run check:browser` | Passed; all 23 browser entry points built without Node/Bun builtins |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed within the extended suite; 5 tests, zero closure gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | Passed outside the network sandbox; 5,664 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The first full-suite attempt ran inside the network-restricted sandbox. Its 48
failures were existing loopback-server tests that could not bind; the same
suite outside that sandbox passed without code changes.

The live Confluence E2E is not applicable to T7: this task adds project
persistence and real local pack compilation, but no user-callable CLI command,
Confluence API operation, or remote mutation. All fixtures are neutral and
synthetic. No source filename, document text, customer identity, raw OOXML, or
private DOCX bytes are present in tests, project-portable state, packs, commit
content, or this evidence.

This evidence proves T7 only. It does not claim the human/expert CLI commands,
resume scripts, help/completion surface, or browser journey from T8 onward.

## T8 — Human and expert CLI journeys

**Status:** Proven on 2026-07-27.

### Task-oriented primary flow

The new top-level `pdf-template` domain exposes the business journey as
`import → review → preview → build`, with `status` as the read-only resume
surface and `undo` as an append-only recovery action. Root help, domain help,
and shell completions keep this separate from `wiki template`, which manages
Confluence page templates. The help includes a realistic first-import
transcript, names Editorial Indigo and `suggest-only` as defaults, explains
local graphic extraction, and states the final pack boundary before listing
expert commands.

Default import derives the no-clobber
`./<docx-basename>-pdf-template` path and records no suggestion decision.
Tests created equal generations from the same source in independent
directories containing spaces and Unicode. A second initial analysis into an
existing target failed without moving the active generation. Fresh repository
instances reconstructed the exact stage, grouped counts, blockers, preview
freshness, and next actions after import, review, preview, build, and undo.

The line-oriented review driver renders only action descriptors enabled by the
host-neutral import view. It groups business concepts, shows current, Word,
and effective values, explains why a match was proposed, and supports skip,
back, stop, and later resume. The ordinary transcript contains no candidate
fingerprint or capability path. Explicit batch flags apply the safe set, write
current-design tombstones, and acknowledge only the current unsupported
inventory; no `--all` exists. JSON, explicit non-interactive mode, and either
non-TTY stream never prompt or infer a mutation.

### Graphics, previews, and verified build

Graphic review first creates and names the contact sheet, then asks separately
for inclusion, role, rights, accessibility, alternative text, and placement.
The CLI rejects a missing role or rights confirmation, both or neither
accessibility modes, decorative graphics with alt text, missing or multiple
placement modes, and layout-dependent candidate placement. The accepted
round trip pins the content hash, media type, role, accessibility choice, and
slot-default placement. Metadata-only import persists no asset bytes and
returns the exact reanalysis command needed before graphic review.

A fresh CLI subprocess ran the pinned Typst-WASM preview adapter and produced
valid tagged `design-review.pdf` and `compatibility-proof.pdf` files.
`proof/results.json` binds their digests, compiler version, page counts,
semantic page regions, snapshot digest, and committed generation. Review-only
graphic bytes can appear in a contact sheet without entering the runtime pack.
Templates without decorations no longer import absent decoration helpers.

Build and expert `pack` share the same readiness and executable gates.
Unanswered review, blockers, missing or stale previews, and stale decisions
return typed recovery actions; rendered CLI recovery commands use the actual
project path. A successful build passed the real generated-pack compiler,
created one no-clobber `.wiki-pdf-template` archive, and committed the built
stage. Reusing the output path failed without replacing it.

### Expert and automation surface

`analyze`, `reanalyze`, `diff`, `decide`, `set`, `clear-override`,
`clear-optional`, `validate`, and `pack` expose lower-level automation without
changing the primary journey. Safe and recommended policy tests materialized
different, exact core policy sets. Typed overrides reject unknown paths,
wrong value types, and bounds violations; override, optional clear, baseline
tombstone, and group reset stay independent.

Reanalysis retains authoring intent and reports deterministic reconciliation
states. An unmarked target fails without mutation. Unknown, bare, duplicate,
and conflicting flags return the fixed usage code and do not move the active
generation. Human and JSON output derive from the same result/view DTO.
Machine mode emits exactly one JSON document on stdout and valid progress
JSONL on stderr. The default copy-coverage test owns every reachable registry
and CLI presentation code; a missing English entry fails, while an unavailable
locale visibly falls back to the stable code.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T8 suite | `bun run test apps/cli/src/commands/pdf-template*.test.ts` | Passed; 34 tests, 215 assertions, 0 failures |
| Real CLI preview | T8 test `real CLI preview writes tagged design/compatibility PDFs and JSONL progress` | Passed in a fresh source-run CLI process with pinned Typst-WASM |
| Real executable build | T8 journey plus project-writer compile gate | Passed; deterministic verified archive and tagged feature-zoo compile |
| Browser portability | `bun run check:browser` | Passed; all 23 browser entry points built without Node/Bun builtins |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; updated PDF report and zero reachable-but-unexported gaps |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test` | Passed outside the network sandbox; 5,686 tests passed, 12 environment-gated tests skipped, 0 failures |
| Diff hygiene | `git diff --check` | Passed |

The live Confluence E2E is not applicable to T8: every new command operates on
a local DOCX, local authoring project, local proofs, and a local pack. It
performs no Confluence read or mutation. The applicable end-to-end proof is the
fresh CLI subprocess plus the real pinned Typst-WASM preview and pack
compilation. The shared export path that consumes this pack is T9 scope.

All committed fixtures and transcripts are neutral and synthetic. Portable
state, proof metadata, packs, tests, and this record contain no source-DOCX
path, document text, raw OOXML, customer identity, or private source bytes.

This evidence proves T8 only. It does not claim the durable export pack store,
real export consumption, browser conformance journey, visual goldens,
usability sessions, or live Confluence pack E2E from T9–T10.

## T9 — Verified pack loader and real PDF export

**Status:** Proven on 2026-07-27.

### Canonical runtime and fail-closed loading

The PDF loader now accepts only budget-valid, content-addressed packs whose
manifest pins the supported capability catalog and whose `atlcli.typ` can be
regenerated byte-identically by its declared canonical-source revision.
Revision 1 and revision 2 select distinct generators; an unknown revision
returns a migration diagnostic. A correctly hashed archive containing free
Typst, an extreme raster, an over-complex SVG, a changed manifest, changed
source, or changed asset fails before compiler invocation with a specific
validation code.

The resulting `PdfTemplateRuntimeV1` contains only structured-clone-safe
manifest data, the validated runtime snapshot, verified canonical source, and
copied accepted-asset bytes. `runPdfExport` takes a defensive clone at its
prepare boundary. German and English documents therefore share one static
source digest while runtime labels differ through `settings.labels`; Level A
settings remain a separate, declared override layer.

### Durable content-addressed consumption

`PdfExportJobRequestV1.template` is now an exact tagged union: a built-in
template identity or a verified pack `recordKey + archiveSha256`. Validators
reject mixed variants, local paths, and unverified hashes while continuing to
normalize legacy built-in requests. The CLI writes and verifies local archive
bytes before durable request creation, links the record after creation, and
persists no source path.

The new host-wide `TemplatePackStoreV1` is separate from the lease-bound job
spool. Its file implementation uses atomic content-addressed records,
cross-process locking, SHA verification, deduplication, durable reachability
links, a complete retained-job scan, and a grace period before orphan
deletion. Restart tests replace the caller's archive bytes and reconstruct the
store before execution; the executor still renders exclusively from the
verified stored record. Shared-pack retention keeps the record until every
referencing job is gone and never removes foreign records.

### CLI and browser proof

`wiki export --format pdf --template <pack>` validates and stores the archive
before constructing the Confluence client. A real CLI test proves zero API
calls for invalid input, and a second real CLI run shows the pack's design and
background in the rendered PDF while omission remains on Editorial Indigo.
The browser production conformance harness structured-clones the same runtime
DTO and compiles its canonical source with the same accepted assets.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Normative T9 suite | `bun run test packages/pdf/src/template-pack.test.ts packages/pdf/src/run-export.test.ts packages/export-jobs/src/request.test.ts packages/export-jobs/src/template-pack-store.test.ts packages/export-jobs/src/validation.test.ts packages/export-wiring/src/jobs/pdf-job-executor.test.ts apps/cli/src/commands/export-job-request.test.ts apps/cli/src/commands/export-pdf-template.test.ts` | Passed; 161 tests, 409 assertions, 0 failures |
| Browser production conformance | `bun run test:browser-export-harness --grep "every registered conformance case"` | Passed; structured-clone and real canonical-pack render included |
| Durable restart and retention | `bun run test packages/export-node/src/jobs/file-persistence.test.ts apps/cli/src/commands/export-job-runtime.test.ts apps/cli/src/commands/export-jobs.test.ts` | Passed in the full repository suite; store restart, shared references, retention, retry, and rerun covered |
| Real compiler visual fixture | `bun run test packages/pdf-compiler-browser/src/docx-template-assets.test.ts` | Passed; 3 tests, 53 assertions, 0 failures |
| API report and closure guard | `bun run test scripts/api-report.test.ts` | Passed; 5 tests and zero reachable-but-unexported gaps |
| Browser portability | `bun run check:browser` | Passed; all 23 browser entry points built without Node/Bun builtins |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| Full monorepo build | `bun run build` | Passed; 19 tasks |
| Full repository suite | `bun run test --bail` | Passed outside the network sandbox; 5,705 tests passed, 12 environment-gated tests skipped, 0 failures |

The first full-suite pass correctly exposed a legacy visual fixture whose
placeholder source no longer satisfied the canonical-source contract. The
fixture was migrated to revision 2 and its source regenerated through the
production generator. Subsequent isolated reruns also distinguished two
transient parallel-test failures from product regressions; the final complete
suite passed without exclusions.

All fixtures, archives, store records, and reports are neutral and synthetic.
The changes and evidence contain no local source path in a durable request, no
customer identity, no private DOCX content, and no raw private OOXML.

This evidence proves T9 only. T10 evidence is recorded separately below.

## T10 — Cross-shape, visual, live E2E, and usability proof

**Status:** Technical slice proven on 2026-07-27; task completion is waiting
for the five independent human usability sessions.

### Browser contract and deterministic vertical slice

The
[`docx-template-intake` conformance flow](../../apps/browser-export-harness/src/docx-template-intake-flow.ts)
uses only browser barrels, structured-clone-safe DTOs, and explicit in-memory
repository, asset, preview, compile, and output ports. It performs the complete
synthetic flow:

`DOCX → catalog/visual analysis → import view → explicit actions → accepted
page background and header decoration → previews → runtime materialization →
canonical pack → real Typst-WASM PDF`.

The browser and Bun runs agree on the source and analysis digests, every
projected view, grouped counts, section/item order, diagnostics, action IDs and
disabled reasons, next actions, resolved snapshot digest, preview
freshness/metadata, runtime projection, pack digest, and final PDF bytes. Both
pack and final PDF are byte-identical on a warm repeat. The final PDF has six
pages, tagging, an outline, embedded fonts, and both accepted decorations.

The browser dependency gate now checks 25 entry points, including the intake
application and PDF authoring runtime. Four seeded negative tests separately
prove rejection of CLI, filesystem-adapter, process-lock, and terminal
dependencies; the existing builtin checks reject Node and Bun imports.

### Raster and real-editor proof

The
[`docx-template-assets` golden set](../../packages/pdf-compiler-browser/test-fixtures/docx-template-assets-golden/manifest.json)
contains six lossless Poppler PPM pages produced with Poppler 26.03.0 at
36 DPI. The allowed mean pixel difference is `0.002` and the minimum
color-bounds intersection-over-union is `0.98`. The pages prove
`first`/`odd`/`even`/`all` scopes for cover, page, header, footer, logo, and
uniform-border colors. An intentionally shifted page is rejected by both the
pixel and bounding-box criteria. All six pages were opened together and
visually inspected; the expected colored regions were present with no missing
or clipped decoration.

The
[`real-editor chain test`](../../packages/pdf-compiler-browser/src/docx-template-intake-chain.test.ts)
starts from independently reviewed Word and LibreOffice oracles and checks the
complete `oracle → scene → decision → runtime snapshot → pack descriptor →
rendered page/BBox` chain:

| Fixture | Safe | Needs review | Blocked | Open after explicit background decision |
|---|---:|---:|---:|---:|
| Microsoft Word for Mac 16.111.1 | 0 | 7 | 9 | 6 |
| LibreOffice 7.1.1.2 | 3 | 5 | 9 | 7 |

For both files, asset hash, relationship reference, target fingerprint,
AlternateContent branch, crop, horizontal/vertical anchor, section, and master
agree from oracle through the scene. The same asset hash is then present in the
explicit decision, runtime snapshot, and generated pack descriptor, and its
render changes more than 20% of the first-page raster with a non-empty bounding
box. The source oracle classifies the illustrative body graphic as
`do-not-include`; assigning it as a page background in this test is an explicit
user override used only to prove the complete rendering chain, not a product
recommendation.

### CLI output and documentation

The committed
[`human-output snapshot`](../../apps/cli/src/commands/__snapshots__/pdf-template.test.ts.snap)
contains the actual CLI presenter output for first import, resume, ready and
uncertain review, asset review, source-change recovery, blocked build,
successful preview, successful build, and undo. Every state is rendered at
80 and 120 columns with ANSI color enabled and disabled. Tests strip ANSI
before enforcing the width, require a valid next or recovery command, and
verify that plain mode contains no escape sequence.

Task-first documentation now covers the
[`Word-to-PDF-template workflow`](../../src/content/docs/confluence/pdf-template-from-word.md)
and the
[`CLI/JSON reference`](../../src/content/docs/reference/pdf-template-authoring-cli.md).
It includes the minimal flow, exact transcript, resume/undo, automation and
action gating, schemas, TTY/non-TTY behavior, troubleshooting, privacy and
security boundaries, graphics limits, and related topics.

### Live Confluence E2E

The live test resolved an existing retained page in `DOCSY` through profile
`mayflower`, passed its ID only through the process environment, and did not
persist that identifier or any page content. It created no remote resource.
All generated DOCX, project, pack, report, baseline PDF, and templated PDF
artifacts lived in a disposable local directory removed in `finally`.

The run first exported the page with Editorial Indigo and then with a reviewed
DOCX-derived pack at the same fixed timestamp. Both outputs were valid tagged,
outlined PDFs with equal page counts, while their bytes differed as required.
The same run proved exit 4 for a missing page and exit 3 for invalid
credentials. Its first attempt exposed that the durable job runtime had reduced
both source failures to generic exit 5; the final implementation preserves only
the redacted `authentication`/`not-found` class across the durable boundary and
the regression tests cover both paths.

The tree case remained skipped because `ATLCLI_E2E_TREE_ROOT_ID` was not
provided; it is an existing hand-off from the earlier tree-export work and is
not part of T10's single-page pack acceptance.

### Commands and results

| Evidence category | Exact command | Result |
|---|---|---|
| Browser contract | `bun run build:browser-export-harness && bun run test:browser-export-harness && bun run assert:conformance-cases && bun run check:parity` | Passed; 4 Chromium tests, 19 registered cases, and byte/report parity for the seven compared PDF cases including `docx-template-intake` |
| Real-editor chain | `bun run test packages/pdf-compiler-browser/src/docx-template-intake-chain.test.ts` | Passed; 2 tests, 36 assertions, 0 failures |
| Raster goldens | `bun run test packages/pdf-compiler-browser/src/docx-template-assets.test.ts` | Passed; all six pages within tolerance and the shifted negative rejected |
| Human-output matrix | `bun run test apps/cli/src/commands/pdf-template.test.ts` | Passed; 23 tests, one 40-variant snapshot, 0 failures |
| Live E2E | `ATLCLI_E2E=1 ATLCLI_E2E_PAGE_ID=<retained-DOCSY-page> ATLCLI_E2E_PROFILE=mayflower bun run test apps/cli/src/commands/export-pdf.e2e.test.ts` | Passed; 5 tests, 1 unrelated tree hand-off skipped, 0 failures |
| Browser dependency graph | `bun run check:browser` | Passed; 25 browser entry points |
| API reports and closure | `bun run test scripts/api-report.test.ts` | Passed; 5 tests and zero reachable-but-unexported gaps |
| Repository type safety | `bun run typecheck` | Passed for root, extension, browser compiler, and browser harness |
| Full build | `bun run build` | Passed; 19 tasks |
| Documentation | `bun run docs:check && bun run docs:build` | Passed; zero diagnostics and 78 generated pages |
| Full repository suite | `bun run test` | Passed; 5,720 tests, 13 documented skips, 0 failures, 20,409 assertions, and 4 snapshots across 391 files |
| Diff hygiene | `git diff --check` | Passed with no errors |

### Post-implementation real-DOCX hardening

An operator-supplied private Word document exposed a legitimate
2,520-character opaque OOXML attribute that exceeded the original
per-attribute limit. The document part was only 36 KB and contained 998
attributes, so this was not a ZIP, decoded-size, node-count, or aggregate
attribute-count exhaustion case. The per-attribute limit is now 4,096
characters: a committed boundary test accepts the exact maximum and rejects
the next character.

The unchanged private DOCX then completed through the normal CLI with no
runtime override. It reached `review-required` with five review items and
seven explicitly non-transferable items. The source document, its path,
digest, content, and extracted private assets remain uncommitted and are not
recorded in this evidence file.

The same document also exposed a stable mixed-axis DrawingML logo anchor:
horizontal `column` and vertical `page` in a one-column section. Intake now
normalizes those axes into one margin-relative placement while retaining the
source extent. A multi-column negative remains layout-dependent. The user
explicitly confirmed role, rights, meaningful accessibility text, and
`candidate-placement`; no heuristic silently included the image.

The resulting canonical-revision-3 pack retained the accepted PNG and its
placement in the `asset.logo` reference. It compiled through pinned
Typst-WASM, then produced a ten-page tagged A4 PDF from the retained `DOCSY`
page through the configured live profile. Page 1 was rendered with Poppler and
visually inspected at original resolution: the logo appeared once in the
detected upper-left position and size, with no fixed-slot duplicate, clipping,
or overlap. The generated private project, pack, PDF raster, page content,
source identifier, asset digest, and source path remain ignored or untracked.

| Supplemental proof | Result |
|---|---|
| Analyzer, CLI, manifest, settings, canonical source, and real compile tests | Passed; 98 tests, 654 assertions, 0 failures |
| Full build and API reports | Passed; 19 build tasks; all three changed public API reports regenerated |
| Private DOCX import/build | Passed through the normal CLI; stable logo placement available and explicitly accepted |
| Live retained-page export | Passed; 10-page tagged A4 PDF, one embedded page image, one rendered diagram, no export errors |
| Page-1 visual inspection | Passed; accepted logo present once at detected placement with no clipping or overlap |

### External usability evidence

The
[`usability evidence record`](USABILITY-RESULTS.md)
is deliberately still empty. No implementer, agent, or synthetic test is
counted as a representative participant. T10 and the overall definition of
done remain open until five uninvolved business-document users complete the
script, at least four succeed without facilitator intervention, and any
repeated blocking journey defect is fixed and rerun.

The automated output matrix proves rendering, terminology, width, color, and
next-action contracts. It does not substitute for that human comprehension
evidence.
