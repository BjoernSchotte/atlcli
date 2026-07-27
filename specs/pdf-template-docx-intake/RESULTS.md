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
