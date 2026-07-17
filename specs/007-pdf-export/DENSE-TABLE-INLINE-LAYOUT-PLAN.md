# PDF Dense-Table Inline Layout - Implementation Plan

Status: **Implemented - automated verification complete; manual wiki E2E pending**

Parent spec: [`PLAN.md`](./PLAN.md)  
Scope owner: `packages/pdf`  
Primary runtime: pinned Typst 0.14.2 through the existing browser compiler  
Product baseline: fixed A4 portrait standard template

## Implementation record (2026-07-17)

The production implementation follows the non-lossy path in this plan:

- dense classification starts at nine effective columns and is recalculated for nested
  tables;
- dense cells reduce horizontal inset from 6 pt to 2 pt and switch only their paragraph
  line breaker from `optimized` to `simple`; the pinned compiler otherwise accepted visibly
  overfull ordinary phrases at fourteen-column widths, while language-aware hyphenation stays
  enabled and normal tables remain unchanged;
- paragraph-local `layout` supplies the real cell content width to measured raw-link and
  status candidates in the pinned Typst 0.14.2 compiler;
- raw links keep their complete annotation target and use full, `hostname/…`, then a
  delimiter-aware wrapping hostname as visible candidates;
- statuses remain complete colored badges in `Source Code Pro` Bold and fall back from
  normal padding to reduced padding to a width-bounded multi-line badge;
- dense mentions retain their complete label and receive rendering-only U+200B break
  opportunities after `@` and safe account-ID delimiters;
- hard clipping was not shipped; paragraphs, cells, links, badges, and prose are not clipped.

The synthetic fourteen-column fixture compiles without diagnostics, stays tagged A4 portrait,
retains complete external link annotations, embeds `Source Code Pro` Bold, and has been rendered
to PNG for visual overflow inspection. PDF text extraction reconstructs link, status, mention,
and prose values after removing rendering-only U+200B characters and whitespace. Search,
interactive copy/paste, zoom inspection in the browser PDF viewer, and the customer-wiki export
remain manual acceptance checks.

Recorded automated verification:

- `bun test packages/pdf/src/serialize.test.ts`: 14 tests passed;
- `bun test apps/extension/tests/pdf/compiler.test.ts`: 10 tests passed, including a
  byte-identical warm repeat of the dense fixture;
- `bun test apps/extension/tests/pdf/run-export.test.ts`: 4 tests passed;
- `bun run typecheck`: passed;
- `bun run build`: passed;
- `bun run --cwd apps/extension pdf:fixture`: 7-page, unrotated A4, tagged output with an
  outline and eight embedded font files;
- Poppler PNG inspection: the primary dense rows and a repeated-header continuation page show
  no paint crossing a vertical cell boundary.

## 1. Decision summary

Very wide tables stay on the existing A4 portrait pages. This slice does not add a
landscape mode, a paper-size option, column bands, row cards, or a new export setting.

Normal table text keeps the current language-aware word wrapping and hyphenation. A
table that has at least nine effective columns additionally receives a dense inline
rendering context. That context may compact atomic UI-like values - initially raw URL
links and status badges - when their full rendering does not fit the current cell.
Ordinary prose is never shortened or clipped.

The intended behavior is:

```text
normal table
  -> current column calculation
  -> current word wrapping and hyphenation
  -> current full inline rendering

dense table (at least 9 effective columns)
  -> same page and column calculation
  -> same word wrapping and hyphenation for prose
  -> full atomic inline rendering when it fits
  -> compact semantic rendering when it does not fit
  -> bounded atomic fallback only as a last safety guard
```

This is an internal rendering policy. It creates no new user-facing configuration and
does not change the source `ExportBlock` model.

## 2. Problem statement

The current serializer places all table tracks inside the standard A4 portrait content
area. Source column proportions are retained when they are meaningfully unequal;
otherwise the exporter uses equal `1fr` tracks. The content-aware width inference is
intentionally limited to tables with three through eight columns.

For much wider tables, each track can become narrower than an unbreakable inline value:

- a status badge is an intrinsic-width `box` with horizontal padding;
- a raw URL link retains its complete visible label and Typst does not normally
  hyphenate links;
- a mention may fall back to a long technical account identifier;
- a long opaque token may have no safe line-break opportunity.

Normal prose already receives `hyphenate: true` and optimized line breaking in table
cells. The defect is therefore not a general absence of word wrapping. The missing
policy is how atomic inline values behave when the table is dense enough that their
normal representation cannot fit.

The parent spec already requires very wide tables to remain readable. This follow-up
makes that requirement executable without changing page orientation.

## 3. Goals and non-goals

### 3.1 Goals

- Preserve A4 portrait output throughout the document.
- Preserve current word wrapping, language-aware hyphenation, and paragraph line
  breaking for normal text in all tables.
- Preserve equivalent generated `main.typ` for existing non-dense table fixtures. The
  deliberate global status-badge font change in the shared template is the only planned
  visual exception outside dense tables.
- Detect dense tables deterministically from their effective column count.
- Compact only semantic atomic inline values and only inside dense tables.
- Keep every status visually recognizable as a badge with its background color, text
  color, radius, and dedicated `Source Code Pro` typography in both normal and dense
  tables.
- Keep full external link destinations clickable even when their visible label is
  shortened.
- Prevent badges, links, mentions, and technical tokens from painting across adjacent
  cell boundaries without depending on a JavaScript report note for a Typst-time layout
  decision.
- Avoid silent loss of ordinary prose.
- Keep serializer output deterministic, browser-safe, source-mapped, and free from
  runtime network access.
- Prove behavior through the real pinned Typst compiler and a visually reviewed,
  anonymized wide-table fixture.

### 3.2 Non-goals

- No landscape pages, A3 pages, mixed page sizes, page rotation, or adaptive page
  orientation.
- No export-panel setting or template configuration for wide tables.
- No splitting a table into multiple column bands.
- No conversion of table rows into cards or key/value lists.
- No global table-font reduction and no new column-width optimization algorithm.
- No whole-cell clipping and no clipping of paragraphs, lists, headings, or other block
  content.
- No change to Confluence storage parsing or `ExportBlock` / `InlineNode` public types.
- No general mention-display-name resolver. This plan only defines rendering when a
  display name is already available and a safe fallback when it is not.
- No claim that visual ellipsis automatically preserves full accessible text. That must
  be proven by the feasibility gate before it is used for non-link semantics.

## 4. Verified current baseline

### 4.1 Table classification and widths

Current implementation:

- `packages/pdf/src/serialize.ts:91-125` infers a dominant narrative track only for
  tables with three through eight columns.
- `packages/pdf/src/serialize.ts:127-152` retains meaningful unequal source widths and
  otherwise emits equal `1fr` tracks.
- `packages/pdf/src/serialize.ts:444-462` computes the effective column count from
  colspans and emits the Typst table.
- `packages/confluence/src/export-blocks.ts:509-554` retains complete `<colgroup>`
  widths, so this follow-up does not need to change the storage walker.

### 4.2 Inline behavior

Current implementation:

- `packages/pdf/src/serialize.ts:171-235` serializes inline text, mentions, statuses,
  links, and line breaks without a table-specific context.
- External links keep their original visible inline content and their complete target.
- Mentions render `displayName` when present and otherwise fall back to `accountId`.
- Statuses render through the template-level `status-badge` helper.
- `packages/pdf/src/template.ts:105-109` enables 9 pt table text, hyphenation, and
  optimized line breaking.
- `packages/pdf/src/template.ts:197-202` renders a status as an intrinsic-width box with
  5 pt horizontal padding and currently uses `Source Sans 3` at 7.5 pt semibold.

### 4.3 Existing test boundary

- `packages/pdf/src/serialize.test.ts` covers retained widths, equal fallbacks, and
  content-aware proportions, but not a table above eight columns.
- `apps/extension/tests/pdf/compiler.test.ts:193-235` proves real compilation of a
  narrow four-column German table with hyphenation.
- `apps/extension/scripts/render-pdf-fixture.ts:81-111` contains only a four-column
  table and therefore cannot expose dense-table overflow.
- The in-browser validator checks document structure, tags, pages, outlines, and
  embedded fonts, but it cannot detect visual cell overflow.

## 5. Fixed design decisions

### 5.1 Dense-table classification

Add one internal constant in `packages/pdf/src/serialize.ts`:

```ts
const DENSE_TABLE_COLUMN_THRESHOLD = 9;
```

The effective column count remains the maximum sum of cell colspans in any row. A table
is dense when `effectiveColumnCount >= DENSE_TABLE_COLUMN_THRESHOLD`.

Reasons for using a structural threshold in the first slice:

- it directly targets the current unhandled range above eight columns;
- it is deterministic and independent of font measurement differences;
- it does not hard-code the current A4 content width into the host-neutral serializer;
- it avoids changing a deliberately narrow authored column in an otherwise normal
  table;
- it is easy to cover with boundary tests at eight and nine columns.

This constant is an internal policy, not a public serialization option. A future
template-aware width classifier may replace it, but that is outside this plan.

### 5.2 Rendering context, not model mutation

Introduce a serializer-internal context:

```ts
interface PdfRenderContext {
  tableDensity: "normal" | "dense";
}
```

Thread it through `serializeBlocks`, `serializeBlock`, and `serializeInline`. The default
outside a table is `normal`. When serializing a table, calculate that table's density and
pass it into all of its cell descendants.

Rules:

- Nested lists, paragraphs, and inline content inherit the surrounding table density.
- A nested table calculates and applies its own density rather than inheriting the outer
  table's classification.
- Source-map paths and document order remain unchanged.
- `PreparedPdfBlock`, `ExportBlock`, `InlineNode`, and the preparation phase remain
  unchanged.

### 5.3 Normal wrapping is an invariant

Do not change the current table-cell rules:

```typst
set text(font: "Source Sans 3", size: 9pt, hyphenate: true)
set par(linebreaks: "optimized")
```

Dense mode must not:

- disable hyphenation for prose;
- insert forced breaks into ordinary sentences;
- change paragraph justification;
- shrink all table text;
- clip the table cell or paragraph container.

Only an individual atomic value may receive a compact representation or an emergency
break policy.

Implementation evidence added one narrowly scoped exception to the original line-breaker
constraint: dense cells use `linebreaks: "simple"`. In the pinned compiler, the optimized
breaker deliberately retained overfull multi-word lines in fourteen equal columns even after
adaptive atoms were contained. The simple breaker preserves word wrapping and hyphenation but
avoids that cross-cell paint. Normal tables continue to use `linebreaks: "optimized"`.

### 5.4 Status visual contract

The PDF status macro remains a badge in every rendering mode. Update its typography to
the already bundled code family:

- font: `Source Code Pro`;
- weight: bold (the bundled 700 face);
- normal size: 7.5 pt unless the spike demonstrates a necessary dense-only adjustment;
- background: the current status color lightened by the existing template rule;
- foreground: the current safe status color;
- radius: the current 3 pt;
- label: always textual and complete in the first production slice.

Dense mode may reduce padding and allow the badge body to wrap, but it must not remove
the background, switch to ordinary prose typography, or communicate state through color
alone. This is a deliberate PDF-wide visual contract: a normal-table status also uses
`Source Code Pro`, while its current one-line badge geometry otherwise remains intact.

## 6. Compact inline architecture

### 6.1 Feasibility-gated dense paragraph primitive

Typst's `layout` exposes the outer container width, but it is block-level rather than a
transparent CSS-like inline primitive. Do not wrap each link or badge directly in
`layout`. Add a template helper provisionally named `dense-par` that replaces only a
paragraph inside a dense table when that paragraph contains at least one adaptive atom.

The wrapper receives the cell's current content width once and passes it into the
renderers for adaptive atoms. Paragraphs without adaptive atoms continue to emit the
existing plain `#par[...]` form.

Conceptual Typst shape:

```typst
#let dense-par(body) = layout(size => {
  body(size.width)
})

// The serializer supplies a body function that renders the paragraph once.
// Adaptive atoms receive `available-width`; ordinary text stays ordinary text.
```

Within that paragraph, an adaptive atom may:

1. measure its natural full rendering at unconstrained width;
2. compare that width with the cell content width;
3. choose a semantic fallback when the full rendering cannot fit;
4. emit the real semantic node exactly once.

Do not measure and render a complete link twice. Measure only the label/badge candidate,
then emit one real link or status representation. This avoids duplicate extracted text
and duplicate PDF annotations.

This remains a feasibility gate rather than assumed behavior. Typst's `layout`,
`measure`, paragraph wrapping, relative widths, tagging, repeated table headers, and row
fragmentation must be tested together in the pinned 0.14.2 engine. If `dense-par`
changes reading order, makes the paragraph opaque to tagging, or prevents row splitting,
the release implementation must use deterministic dense variants without runtime
measurement.

### 6.2 Compact external links

Only compact an external link when all of the following are true:

- it is inside a dense table;
- its visible content is plain text;
- the visible text is the URL itself or normalizes to the target URL;
- the URL can be parsed safely by the serializer.

Do not compact:

- custom human-readable link labels;
- anchor links;
- unresolved page or attachment links;
- mixed-format labels;
- unsafe or unparsable targets.

Candidate order for a raw HTTP(S) URL:

1. complete visible URL;
2. hostname plus `/...` when the URL has a non-root path, query, or fragment;
3. hostname only;
4. a width-bounded hostname prefix with a visible ellipsis, if the feasibility gate
   proves deterministic Unicode-safe truncation and acceptable extraction.

The emitted `link` target always remains the complete original URL. Candidate generation
must never rewrite the destination. The minimal visible candidate must still identify
the destination; a generic icon without text is not acceptable.

`mailto:` compaction is excluded from the first slice. Email addresses keep their
existing rendering until a separate privacy and usability rule is chosen.

### 6.3 Compact status badges

The first production implementation does not ellipsize status labels. In a dense table,
a status receives these candidates:

1. full label with the normal `Source Code Pro` badge when its natural width fits;
2. full label with reduced horizontal badge padding when that fits;
3. full label in a width-bounded, multi-line badge that retains the same font,
   foreground, background, and radius.

Candidate 3 preserves both status semantics and the status macro's visual identity. Its
label uses the existing cell language and wrapping rules inside the bounded badge. The
feasibility spike must prove whether an inline `box` with an explicit width can wrap the
label correctly; if not, `dense-par` must place a paragraph-local badge block without
changing reading order or row pagination.

A visually shortened status such as `DEPLOY...` is a future enhancement, not part of the
first production slice. It may be enabled only if the feasibility spike proves that the
complete semantic label remains available in tagged output, extraction, search, and
assistive technology. Without that proof, the complete multi-line badge is mandatory.

### 6.4 Mentions

Mentions are included in the dense rendering context but are deliberately conservative:

- When `displayName` exists, keep the complete display name and normal wrapping at
  spaces.
- Do not shorten a display name in the first production implementation. A future
  shortened form requires the same full-semantic-text gate as a status.
- When only `accountId` exists, do not invent a person name and do not replace it with an
  ambiguous generic label.
- Treat a long `accountId` as a technical token and apply the emergency-break policy.

Display-name resolution itself belongs upstream and is not part of this plan.

### 6.5 Emergency breaks for technical tokens

Dense mode may add non-printing break opportunities to a single long token only when it
cannot otherwise wrap. Apply opportunities in this order:

1. after URL/identifier delimiters such as `/`, `.`, `-`, `_`, `?`, `&`, `=`, and `:`;
2. between fixed-size segments only when a delimiter-free run remains longer than the
   selected emergency-run threshold and the extraction spike approves the chosen
   character;
3. never between every character of ordinary prose.

The full underlying value must remain unchanged for link destinations and internal
model values. The visible text transformation must be a pure PDF-serialization concern.

Compare discretionary soft hyphens and zero-width spaces; neither is accepted merely
because it compiles. The spike must verify:

- visual wrapping without a printed hyphen;
- search behavior;
- copy/paste behavior after normalizing line whitespace;
- text extraction through the chosen PDF inspection path;
- screen-reader order in the tagged document.

If these checks fail, the emergency insertion must be removed and the implementation
must fall back to the semantic compact candidate or a full wrapping badge/text value. It
must not silently ship arbitrary per-character break insertion.

### 6.6 Containment boundary

Clipping is a separately gated last resort around one final atomic rendering. It is
prohibited around:

- `table.cell` itself;
- paragraphs;
- normal text runs;
- lists or list items;
- headings;
- nested block content.

The release design should avoid clipping when a semantic fallback can wrap. If clipping
survives the spike, the atomic wrapper must have an explicit width derived from the cell,
`clip: true`, and a visible ellipsis. Invisible truncation is prohibited.

A Typst-time fit decision cannot add an `ExportNote` back into the already serialized
JavaScript report. Therefore the design must not rely on an export-report warning as the
only disclosure of clipping. If acceptable extraction, tagging, and visible disclosure
cannot all be proven, remove clipping from the production implementation.

## 7. Implementation work packages

### Work package 0 - Freeze the regression shape and prove Typst behavior

Files:

- `apps/extension/tests/pdf/compiler.test.ts`
- `apps/extension/scripts/render-pdf-fixture.ts`
- temporary spike code only where required by the existing compiler harness

Tasks:

- [ ] Add an anonymized dense-table fixture with fourteen columns.
- [ ] Include ordinary German and English prose, a custom-label link, a visible raw URL,
      multiple status labels, a display-name mention, an account-ID-only mention, and a
      delimiter-free technical token.
- [ ] Keep all fixture hosts under `example.com` or `example.invalid` and use synthetic
      names and identifiers.
- [ ] Compile through the real pinned browser compiler.
- [ ] Prove that paragraph-local `layout` receives the table cell's usable post-inset
      width rather than the full page width for equal tracks, unequal tracks, and a
      colspan cell.
- [ ] Prove that natural-width `measure` uses the final badge/link styling and padding.
- [ ] Prove that `dense-par` preserves inline ordering and does not add an extra paragraph
      or line break around surrounding text.
- [ ] Prove that a width-bounded atomic wrapper prevents visual bleed.
- [ ] Confirm that measurement does not duplicate extracted text and that each external
      link creates exactly one PDF annotation.
- [ ] Record tagged-text, search, copy/paste, reflow, and text-extraction behavior for
      clipping and emergency break characters.
- [ ] Benchmark at least five warm runs of the normal and dense fixtures.
- [ ] Stop before production implementation if paragraph-local layout harms tagging,
      row fragmentation, or deterministic output.

Exit gate:

- A real compiled fixture demonstrates candidate selection inside a table cell.
- No glyph from an atomic element paints across a vertical cell border.
- Normal prose still wraps and hyphenates as before.
- The page remains A4 portrait.
- Link annotations retain the complete original target.
- Extracted text contains each rendered value once.
- Median warm compilation is no more than 20% slower and the PDF is no more than 10%
  larger than the equivalent fixture without dense paragraph wrappers.

### Work package 1 - Add dense-table classification and context threading

Files:

- `packages/pdf/src/serialize.ts`
- `packages/pdf/src/serialize.test.ts`

Tasks:

- [ ] Add `DENSE_TABLE_COLUMN_THRESHOLD` and a pure density classifier.
- [ ] Reuse the existing colspan-aware effective column count.
- [ ] Add the internal `PdfRenderContext`.
- [ ] Thread the context through block and inline serialization without changing source
      paths or public models.
- [ ] Recalculate density for nested tables.
- [ ] Add boundary tests for eight and nine effective columns.
- [ ] Add tests for colspans and nested-table context isolation.
- [ ] Assert that a normal table's ordinary text and link output stays unchanged and
      that its status call keeps the full label while adopting the intentional shared
      badge-font change.

Exit gate:

- Dense context reaches every inline node inside a dense table and nowhere else.
- Existing preparation types and Confluence walker snapshots remain unchanged.

### Work package 2 - Implement compact raw-URL links

Files:

- `packages/pdf/src/serialize.ts`
- `packages/pdf/src/template.ts`
- `packages/pdf/src/serialize.test.ts`
- `apps/extension/tests/pdf/compiler.test.ts`

Tasks:

- [ ] Add a pure URL-label classifier and candidate generator.
- [ ] Normalize only for comparison; never normalize or mutate the actual link target.
- [ ] Emit normal link markup outside dense tables.
- [ ] Emit `dense-par` plus measured compact-link candidates only for raw-URL labels
      inside dense tables.
- [ ] Preserve custom link labels exactly.
- [ ] Add unit cases for path, query, fragment, internationalized hostname, malformed URL,
      custom label, and unsafe scheme.
- [ ] Compile a real fixture and inspect the PDF link annotation target.

Exit gate:

- Full links remain clickable.
- Custom labels are unchanged.
- A raw URL uses the most descriptive candidate that fits.
- No link text crosses a cell boundary.

### Work package 3 - Implement non-lossy status badges and mention behavior

Files:

- `packages/pdf/src/serialize.ts`
- `packages/pdf/src/template.ts`
- `packages/pdf/src/serialize.test.ts`
- `apps/extension/tests/pdf/compiler.test.ts`

Tasks:

- [ ] Change the shared `status-badge` typography from `Source Sans 3` semibold to the
      bundled `Source Code Pro` bold face.
- [ ] Retain the current status-derived background, foreground, and radius.
- [ ] Extend `status-badge` to support measured normal-padding, reduced-padding, and
      width-bounded multi-line candidates.
- [ ] Preserve the complete one-line badge outside dense tables apart from the deliberate
      font-family/weight change.
- [ ] Fall back to the complete multi-line badge when neither one-line candidate fits.
- [ ] Prove that the multi-line badge keeps its background across all rendered lines and
      does not alter cell reading order.
- [ ] Keep complete mention display names with normal wrapping.
- [ ] Route account-ID-only mentions through the technical-token policy.
- [ ] Add LTR, RTL, combining-mark, emoji, and mixed-script test labels.

Exit gate:

- No status or mention becomes color-only or semantically ambiguous.
- Every status remains visually recognizable as the status macro.
- Dense mode cannot make an atomic box paint outside its cell.
- Normal mode remains visually and structurally unchanged.
- Extracted status and mention text appears once and remains complete.

### Work package 4 - Add emergency technical-token wrapping

Files:

- `packages/pdf/src/serialize.ts`
- `packages/pdf/src/serialize.test.ts`
- `apps/extension/tests/pdf/compiler.test.ts`

Tasks:

- [ ] Add a pure token classifier that excludes normal prose.
- [ ] Insert preferred break opportunities after known delimiters.
- [ ] Compare discretionary soft hyphens and zero-width spaces, then add a
      delimiter-free emergency-run fallback only if Work package 0 proves acceptable
      search, extraction, and copy/paste behavior.
- [ ] Do not mutate link targets, account IDs, source maps, or report summaries.
- [ ] Cover Unicode, RTL, long numbers, UUID-like values, URLs, account IDs, and ordinary
      long words.
- [ ] Prove that language-aware hyphenation remains enabled for normal words.

Exit gate:

- Technical tokens wrap without visible overlap.
- Ordinary prose behavior is unchanged.
- Copied/extracted values satisfy the recorded normalization contract.

### Work package 5 - Strengthen the real fixture and verification workflow

Files:

- `apps/extension/scripts/render-pdf-fixture.ts`
- `apps/extension/tests/pdf/compiler.test.ts`
- `src/content/docs/reference/pdf-engine.md`

Tasks:

- [ ] Keep the existing four-column fixture and add a separate dense-table section so
      regression coverage includes both modes.
- [ ] Require a successful real compile with zero compiler diagnostics.
- [ ] Preserve repeated table headers across page breaks.
- [ ] Render the fixture to PNG for manual visual inspection.
- [ ] Inspect at least the first table page and one repeated-header continuation page.
- [ ] Add a structural check for complete external link annotations if the existing
      browser validator can do so without a new heavy dependency.
- [ ] Document the dense-table policy and its limits in the PDF engine reference.
- [ ] Document that page orientation does not change automatically.

Exit gate:

- The fixture shows no cross-cell paint, unreadable badge overflow, or full raw URL in a
  cell where the compact label should be selected.
- Normal text still wraps with the current language-aware behavior.
- Cold and warm compilation remain deterministic under the existing definition.

### Work package 6 - Repository validation and manual E2E

Automated commands:

```bash
bun test packages/pdf/src/serialize.test.ts
bun test apps/extension/tests/pdf/compiler.test.ts
bun test apps/extension/tests/pdf/run-export.test.ts
bun run typecheck
bun run build
bun run --cwd apps/extension pdf:fixture
```

Manual E2E prerequisites follow the repository workflow rules:

- profile: `mayflower`
- space: `DOCSY`
- use an anonymized or synthetic page containing the dense regression table
- clean up any page created solely for the test

Manual checks:

- [ ] Export stays A4 portrait on every page.
- [ ] A normal table looks unchanged.
- [ ] A dense table keeps ordinary word wrapping and hyphenation.
- [ ] Full custom link labels remain visible and wrap normally.
- [ ] Raw URL labels compact only when necessary and remain clickable.
- [ ] Statuses retain `Source Code Pro`, their badge background, foreground, and radius,
      and remain understandable without relying on color.
- [ ] Mentions remain identifiable.
- [ ] No atomic value crosses a vertical cell border at 100%, 200%, and 400% zoom.
- [ ] Repeated table headers remain correct.
- [ ] Search and copy/paste match the Work package 0 contract.
- [ ] No release behavior depends on a report warning that Typst cannot emit after
      serialization.

## 8. File-by-file change map

| File | Planned change |
|---|---|
| `packages/pdf/src/serialize.ts` | Dense classification, render-context threading, link/status/mention candidate generation, technical-token policy |
| `packages/pdf/src/template.ts` | Paragraph-local `dense-par`, measured compact link/status primitives, `Source Code Pro` status typography, and reduced-padding/multi-line badge variants |
| `packages/pdf/src/serialize.test.ts` | Pure classifier, context, candidate, determinism, Unicode, and unchanged-normal-mode tests |
| `apps/extension/tests/pdf/compiler.test.ts` | Real Typst compile coverage for dense cells, semantics, links, wrapping, and nested content |
| `apps/extension/scripts/render-pdf-fixture.ts` | Synthetic fourteen-column visual regression section |
| `src/content/docs/reference/pdf-engine.md` | Document dense-table behavior, unchanged orientation, and fallback limits |
| `specs/007-pdf-export/PLAN.md` | Link this follow-up from the table policy and mark the wide-table contract as concretized when implementation ships |

Files expected to remain unchanged:

- `packages/confluence/src/export-blocks.ts`
- `packages/pdf/src/prepare.ts`
- `packages/pdf/src/types.ts`
- the PDF job store, worker protocol, compiler lifecycle, and download flow
- DOCX serialization and templates

Any implementation that needs to change one of these expected-unchanged areas must stop
and update this plan before proceeding.

## 9. Test matrix

### 9.1 Unit serialization

| Case | Expected result |
|---|---|
| 8 effective columns | normal context |
| 9 effective columns | dense context |
| 8 cells plus a colspan producing 9 tracks | dense context |
| dense outer table, normal nested table | nested table resets to normal |
| normal outer table, dense nested table | nested table selects dense |
| normal raw-URL link | existing complete label and target |
| dense custom-label link | label unchanged |
| dense raw-URL link | ordered compact candidates, full target |
| dense unsafe URL | existing unresolved behavior, no compaction |
| dense status | normal badge, reduced-padding badge, then complete multi-line badge |
| normal status | complete one-line badge using `Source Code Pro` bold |
| dense display-name mention | complete name with normal wrapping |
| dense account-ID mention | technical-token policy, no invented name |
| prose paragraph | unchanged literal text and marks |
| delimiter-free token | emergency behavior only when gate passed |

### 9.2 Real compiler

- Four-column normal table in German.
- Fourteen-column dense table in German and English.
- Multiple dense-table rows crossing a page boundary.
- Repeated complete header row.
- Raw URL plus custom-label URL in adjacent cells.
- Status, mention, long technical token, and ordinary prose in adjacent cells.
- Nested list and nested paragraph inside a dense cell.
- Colspan and rowspan coverage without invalid Typst diagnostics.
- Tagged output and embedded fonts retained.

### 9.3 Visual and semantic verification

- No paint across cell strokes.
- No whole-cell or paragraph clipping.
- No global font shrink.
- Normal words still wrap and hyphenate.
- Shortened link label still exposes the complete clickable destination.
- Shortened non-link label is enabled only with proven full semantic text.
- Search and copy/paste behavior is documented and repeatable.
- Page format never changes.

## 10. Acceptance criteria

The implementation is complete only when all of the following hold:

1. Tables below nine effective columns retain the existing rendering path.
2. Dense tables stay in A4 portrait and retain the existing table track calculation.
3. Ordinary table text keeps current word wrapping, language-aware hyphenation, marks,
   colors, and explicit line breaks.
4. Custom human-readable link labels are never automatically shortened.
5. A raw external URL may display a shorter label, but its complete destination remains
   clickable and verifiable in the PDF.
6. Statuses remain complete visual badges using `Source Code Pro`; mentions remain
   complete text in the first production implementation. Visually shortened variants
   require a separately recorded semantic proof.
7. No atomic inline element visually crosses a cell border in the synthetic regression
   fixture.
8. No paragraph, list, heading, or complete cell is clipped.
9. Emergency token breaks do not silently corrupt search, extraction, copy/paste, or
   screen-reader order.
10. Repeated table headers and row pagination still work.
11. Serializer output and compiled PDF remain deterministic under the existing fixed-
    input contract.
12. Browser build, tests, typecheck, fixture compile, manual visual review, and required
    E2E checks pass.
13. Documentation states that the exporter does not automatically change orientation.
14. Median warm compilation is no more than 20% slower and output size is no more than
    10% larger for the dense regression fixture.

## 11. Risks and mitigations

### Risk 1 - `layout` reports the wrong width inside the dense paragraph

Mitigation: Work package 0 is a hard feasibility gate. Do not approximate cell width
from A4 constants inside the serializer if the runtime primitive fails.

### Risk 2 - Paragraph-local layout introduces unstable pagination

Mitigation: wrap only affected paragraphs, prove row fragmentation and repeated-header
behavior in multi-page tables, and compare cold/warm deterministic compiles before
production integration.

### Risk 3 - Visual truncation loses accessible semantics

Mitigation: links retain their full destination; statuses retain a complete wrapping
badge and mentions retain complete wrapping text unless tagged full semantics are
independently verified.

### Risk 4 - Zero-width breaks damage search or copy/paste

Mitigation: gate the delimiter-free fallback on extracted-text and manual copy tests.
Prefer semantic short labels and delimiter-aware breaks.

### Risk 5 - Clipping hides real content

Mitigation: prefer non-lossy wrapping fallbacks. If clipping cannot provide a visible
ellipsis plus acceptable tagging, extraction, copy, and reflow behavior, omit it from
the release design.

### Risk 6 - Dense context leaks into nested or later content

Mitigation: pass immutable context arguments rather than mutating global writer state;
add nested-table and following-paragraph regression tests.

### Risk 7 - Compact labels become language- or tenant-specific

Mitigation: derive raw-link labels structurally from the URL and use generic synthetic
fixtures. Do not add hostname, project, status, or person-name allowlists.

## 12. Recommended execution order

1. Work package 0 - runtime and semantic feasibility spike.
2. Work package 1 - pure dense classification and context plumbing.
3. Work package 2 - raw URL compaction, the least semantically risky visible change.
4. Work package 3 - status badge and mention handling after the layout/tagging gate.
5. Work package 4 - emergency token wrapping only after copy/search validation.
6. Work package 5 - fixture, documentation, and automated verification.
7. Work package 6 - full repository validation and manual E2E.

Do not start Work package 3 or 4 before recording the corresponding Work package 0
results in this document or a linked implementation note.

## 13. Unresolved questions

These questions do not block the initial feasibility spike, but they must be answered
before the affected production work package is considered complete:

1. Can Typst 0.14.2 expose the complete semantic status or mention text while rendering
   a shorter visual candidate in a tagged PDF? This does not block the first production
   slice, which always keeps those labels complete.
2. Does paragraph-local `layout` receive the real cell content width reliably across
   equal tracks, unequal tracks, colspans, first pages, and repeated-header continuation
   pages?
3. Which Unicode-safe truncation primitive is deterministic for the final raw-link
   hostname fallback: serializer-generated grapheme candidates or a template-side
   measured-prefix function?
4. Is delimiter-aware insertion of zero-width break opportunities acceptable under the
   project's search, extraction, copy/paste, and accessibility expectations?
5. Should hard atomic clipping ship at all? Recommendation: omit it unless the spike
   proves a visible ellipsis, correct tagged semantics, acceptable extraction and
   copy/paste, and stable pagination together.
