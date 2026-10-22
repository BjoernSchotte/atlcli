# PDF import quality evidence

This file records sanitized, repository-safe proof for
`specs/pdf-import-quality/PLAN.md`. It contains neutral fixture identifiers and
aggregate results only. Private document content, derived assets, tenant data,
live URLs, page IDs, raw receipts, and private input digests are prohibited.

## Status

Acceptance correction: **CLOSED** (2026-10-21). PIQ-11 is superseded by the
full-document structure tree; PIQ-12 through PIQ-18 pass on the neutral corpus.

| Task | Result | Date |
|---|---|---|
| PIQ-00 | PASS | 2026-08-27 |
| PIQ-01 | PASS | 2026-08-27 |
| PIQ-02 | PASS | 2026-08-27 |
| PIQ-03 | PASS | 2026-08-27 |
| PIQ-04 | PASS | 2026-08-27 |
| PIQ-05 | PASS | 2026-08-27 |
| PIQ-06 | PASS | 2026-08-27 |
| PIQ-07 | PASS | 2026-08-27 |
| PIQ-08 | PASS | 2026-08-27 |
| PIQ-09 | PASS | 2026-08-27 |
| PIQ-10 | PASS | 2026-08-27 |
| PIQ-11 | SUPERSEDED (full-document tree) | 2026-10-20 |
| PIQ-12 | PASS | 2026-10-21 |
| PIQ-13 | PASS | 2026-10-20 |
| PIQ-14 | PASS | 2026-10-20 |
| PIQ-15 | PASS | 2026-10-20 |
| PIQ-16 | PASS | 2026-10-20 |
| PIQ-17 | PASS | 2026-10-20 |
| PIQ-18 | PASS (neutral, live) | 2026-10-20 |

## PIQ-16 untagged geometry

Result: **PASS** with deterministic geometry only (PLAN Section 14b).

### Behavior

- **Rulings:** thin paths are rules; rectangles contribute their edges. A
  connected set of rules is one local grid, so page decorations elsewhere no
  longer block a table. Drawn lines win over shading edges, which follow
  elementary cells even inside merged cells.
- **Ruled grids:** a closed frame is required; a cell edge without a drawn
  separator merges cells into a rectangular span; text that crosses a drawn
  edge is split per character, and a glyph on an edge rejects the grid.
- **Row-ruled tables:** horizontal rules give the rows, left text edges shared
  by at least two rows give the columns. A band with several lines is one row
  with wrapped cells, or several rows when every line starts in the first
  column and fills two columns.
- **Borderless:** three or more aligned single-line columns with clear gaps in
  at least three rows.
- **Continuation:** a grid that ends a page joins a grid that starts the next
  page when every column edge matches; a repeated bold header row is shown once
  and owns its characters.
- **Decoration:** rectangles that hold text and no image (shading, highlights,
  boxed notes, footer panels) are backgrounds, not figures.
- **Facts:** `PdfTextCharacterFactV2.boldFontName` is set when PDFium reports no
  weight and the font name marks it bold (macOS Quartz exports); headers and
  headings use it.
- **Reading order:** fragments narrower than 0.15 page width beside text on the
  same line (clause numbers, terms, table-of-contents page numbers) are not
  evidence of a second column.
- **Text boundaries (geometry order):** a same-line gap without any PDFium
  generated character and at most 0.8 of the block's narrowest whitespace word
  gap is no space; a gap of 2.5 glyph widths separates words of any script.
- Two-page documents get repeated-header and footer suppression (V2).

Revisions: adapter V2 `/4`, geometry policy V2 `/4`, table policy V2 `/5`.

### Neutral result

`untagged-word.pdf` (Word for Mac 16.113.4 Save As PDF of
`untagged-source.docx`): before, 0 native tables, 4 rendered crops and both
pages as page fallbacks. After, the quality oracle matches exactly: the 46-row
inventory joined across the page break with one header row and the blank cell,
the pricing table with a row span and a column span over two header rows, the
borderless contacts table, the shaded note as a paragraph, the list, and the
footer suppressed; no image, no fallback, no unresolved boundary. Live DOCSY
publication with `--scan-policy fail --unsupported fail` and ADF readback
pass.

The motivating private documents were re-measured locally with body-free
counts only. Nothing about them is recorded here.

### Verification

```text
bun run test                            9504+ pass (api report refreshed)
bun run check:import-pdf-quality        passed: true (10 fixtures)
bun run test:e2e:import-pdf             13 pass, DOCSY, cleanup verified
bun run bench:import-pdf                p95 212 ms, peak RSS 550 MiB, all gates
```

### Fallback hardening (2026-10-20)

Three false-positive page-fallback causes on Word for Mac exports, each with a
neutral regression test:

- **Flat marks:** an underscore's glyph box lies under the baseline, so it
  formed its own physical line inside its word's box (`conflicting-overlap`).
  A punctuation or symbol glyph flatter than 0.25 of its width now joins the
  nearest line above whose descender band holds it, without moving that line;
  a row of underscores well below text stays its own line.
- **Banded columns:** full-width text above or below a two-column block made
  the page `column-overlap`. A left-column fragment reaching the right column
  now separates reading bands (full-width text, left column, right column);
  right-column text beside it still fails closed.
- **Line wraps:** a line ending in a Common-script digit or an underscore left
  the wrap to the next line unresolved. Digits now match any non-CJK script,
  and a connector punctuation mark may end a wrapped line.

Follow-up for `table-render-required` pages:

- **Open frames:** a ruled grid whose row rules all end at the same x (or
  whose column rules all end at the same y) has that side implied: Word
  tables without outer side borders, and a table continued from the previous
  page without a top rule. Mixed shading components keep the closed-frame
  rule.
- **Split rows:** without a top rule and without a repeated header, the first
  row of a continued part with simple cells continues the previous page's
  last row; its cell text continues the same paragraph (shared with the
  tagged path through `continueCellBlocksV2`).
- **Contained linearization:** an alignment-only table linearized with a
  rendered crop no longer sends its page to a fallback when no other text
  lies inside its region; the rest of the page stays native.
- **No lost continuation parts:** when a page holding part of a multi-page
  table falls back, tables are projected again without continuation across
  that page. Before, the table's blocks belonged to its first page and the
  rows on its other pages were silently dropped while their characters
  counted as owned.
- **Line wraps at symbols:** a symbol (`+`, `→`) at either side of a wrap
  joins with one space.

Line-end hyphens: PDFium flags every hyphen that ends its text line
(`FPDFText_IsHyphen`, often with Unicode U+0002) and cannot tell a syllable
break from a hard hyphen. Word exports showed these flagged hyphens with the
same letter-case distribution as hyphens inside lines, so wrapped compounds
lost their hyphen. A flagged hyphen before a capital on the next line is now
retained; before a lowercase letter it is still removed. A flagged hyphen
also ends its fragment when text of another column follows on the same
visual line, even under the fragment gap.

Cell line order: the text pieces of a ruled table cell were ordered by raw
top edge, so a piece of one visual line set a hair higher (another font
size) came before the start of its line; the pair was left unresolved and
the table, then the page, fell back. Cell pieces are now ordered by physical
line, then left to right.

Revisions after these steps: geometry policy V2 `/7`, table policy V2 `/7`,
text assembly V2 `/8`. The motivating
private documents were re-measured locally; nothing about them is recorded here.

## PIQ-12

Result: **PASS** (2026-10-21).

A structure container with one unresolved child returned before visiting any
child, so a single unresolved kid of the document root dropped every sibling
and sent both pages of the neutral probe to geometry. A container now reports
the unresolved child (`pdf-import/tagged-structure-kid-unresolved`, no
corruption count) and projects its resolved children in original kid order;
whatever the unresolved child showed stays unclaimed, and the ownership audit
decides. Leaves (paragraph, list, figure, table, cell) with an unresolved child
still fail closed. Page-external children were already distinct kids
(`page-external`, PIQ-11 superseded) and are skipped on pages that do not show
them; `collectTaggedTableRowsV2()` already skipped them in row groups.

Neutral fixture: `generateMixedContainerProbe()` in
`fixtures/generate-core.ts`. Page 1 root kids: paragraph, unresolved, table
(TBody with one row on page 1 and one on page 2), list, figure, paragraph,
paragraph shown on page 2.

| Case | Block order | Page outcomes | Ownership | Fallback |
|---|---|---|---|---|
| Positive | paragraph, table (2 rows, joined across pages), list, paragraph, paragraph | both `tagged-native`, corrupt 0 | unowned 0, duplicates 0, every visible character uniquely owned | none (the vector figure is reported, not a page fallback) |
| Negative (`orphanText`: page 1 shows text only the unresolved child could own) | same blocks | page 1 `geometry-required` | 11 characters unclaimed (`pdf-import/tagged-text-unclaimed`) | page 1 |
| Unresolved leaf (`generateUnresolvedStructureKidProbe`) | none | `geometry-required`, corrupt 1 | 16 unclaimed | page 1 |

Tagged policy V2 `/5`.

## Follow-ups after PIQ-18 (2026-10-21)

- **Fallback pages keep native tables.** A native geometry table on an
  untagged page that falls back is emitted next to the page view; its evidence
  already claimed its characters. A table continued from or onto a fallback
  page therefore stays whole, and the re-projection that isolated such pages is
  removed. Geometry policy V2 `/8`, table policy V2 `/8`.
- **Lowercase after a line-end hyphen.** A flagged line-end hyphen before a
  lowercase word is kept when the same `left-right` compound appears inside a
  line elsewhere in the document (basis `document-compound`); otherwise it is
  still removed as a syllable break. Applies to geometry paragraphs, geometry
  table cells, and hybrid residual regions. Text assembly V2 `/9`.
- **Figure alternative text.** `--overrides-template <file>` drafts a
  digest-bound override file with one empty `set-figure-alt` per published
  figure without alt text. A supplied alt text now clears that figure's
  `pdf-import/figure-alt-missing` issue, so `--unsupported fail` no longer
  blocks on it. Rendered-region figures list their own source id in the image
  block's `sourceRefs` so issues and overrides can name them. Figure policy
  `/2`.

## Producer-evidence follow-ups (2026-10-21)

Neutral exports from Word for Mac 16.113.4 and LibreOffice 7.1.1.2
(`fixtures/producers/`) replaced assumptions about how tables meet a page
break.

- **Split rows.** Both producers draw the frame across a split row. The
  first row of a continued page is joined to the previous row only when the
  frame is drawn but open on both sides of the break; a table drawn without
  outer rules is open on every page and no longer joins rows. Where the frame
  is drawn across, the rest of the row stays a row of its own and is reported
  as `pdf-import/table-row-split-unproven`. Table policy V2 `/9`.
- **Inside rules only.** Word draws one vertical rule fewer than columns; the
  grid counted columns before implying its open sides and fell back to row
  rules, losing the first and last row of each page. Fixed.
- **Untagged headings.** Body size is the size most characters are set in, not
  most fragments; font sizes of Word's scaled fonts are estimated from glyph
  heights against all page text, including tables; heading sizes within 1.5%
  share one level. Before, same-style headings landed on one level each and
  headings beyond six distinct sizes became paragraphs. Geometry policy V2
  `/9`.
- **Filled text boxes.** A rectangle drawn as moveto, four linetos and a close
  (LibreOffice) is a background like `re`, not a figure that repeats its
  text. Figure policy `/3`.
- **Document lexicon everywhere.** The compound lexicon also reaches tagged
  paragraphs, lists, tagged tables and the legacy untagged grid, and it holds
  the document's words: a removed hyphen is proven when the joined word
  appears (basis `document-word`); a removal nothing proves is reported as
  `pdf-import/text-dehyphenation-unproven` (info, native). Text assembly V2
  `/10`.
- **Unresolved children of text elements.** A paragraph or heading with an
  unresolved child keeps its resolved text; the ownership audit still sends the
  page to geometry when visible text belongs to no element. Tables, lists and
  figures stay fail-closed. Tagged policy V2 `/6`.
- **OCR scans.** A generated scan with an invisible text layer stays a page
  image; pinned by `producers.test.ts`.

The private documents were re-checked locally and body-free only: no page
fallback, unresolved boundary, unowned or duplicate character appeared; the
recovered untagged headings follow the pattern of the author-tagged ones.
Nothing derived from them is recorded here.

## PIQ-18

Result: **PASS** for the neutral corpus and the automated DOCSY proof. The
private acceptance document was re-checked locally with body-free counts only
(unchanged: all tables native, no fallback, no unresolved boundary); it was not
republished.

### Fixtures and oracle

`acceptance-source.ts` is the single content model for
`acceptance-browser.pdf` (Chrome 155, print-to-pdf) and
`acceptance-libreoffice.pdf` (LibreOffice 7.1 Writer, tagged export through
the `UseTaggedPDF` profile setting). Both are sanitized with
`producer-tools.ts`. The oracle (ordered blocks, table shapes, figure counts)
comes from the model; only page indexes come from the PDFium text layer. The
quality gate gains `table-shape` and `figure-count` failure codes, and a
perturbation test proves that the owning fixture fails.

| Oracle item | Expected | Browser | LibreOffice |
|---|---|---|---|
| Pages | producer | 5 | 2 |
| Native tables | 2 | 2 | 2 |
| Inventory table | 61 × 3, 1 header row, blank [0,1] and [7,1] | exact | exact |
| Summary table | 3 × 2, 1 header row | exact | exact |
| Native raster figures | 1 | 1 | 1 |
| Region or page fallbacks | 0 | 0 | 0 |
| Unresolved boundaries, unowned or duplicate characters | 0 | 0 | 0 |
| `--scan-policy fail --unsupported fail` blockers | 0 | 0 | 0 |

### Importer defects the fixtures exposed

| Defect | Producer | Fix |
|---|---|---|
| Caption imported twice | Chrome | V2 figures own their caption characters; geometry no longer repairs them and the review assigns them to the caption block |
| Repeated header rows on continuation pages became loose paragraphs | LibreOffice (draws them untagged) | untagged text directly above a continuation part whose columns match the header exactly is that header's repetition |
| List items started with "• " | LibreOffice (no `Lbl`) | a leading marked-content sequence holding one marker token is the item label |
| "Item 11" read as "Item 1 1" | Chrome (one glyph per text run) | with the literal-whitespace convention a gap must exceed 2 glyph widths to be a space |
| A row split by a page break gave each cell two paragraphs | all | the cell's page views continue one paragraph (a trailing hyphen keeps them apart); runs are merged so Confluence readback matches |

Revisions: tagged policy V2 `/4`, text assembly V2 `/5`.

### Verification

```text
bun run check:import-pdf-quality       passed: true (9 fixtures)
bun run test packages/import-pdf specs/pdf-import-quality scripts/quality apps/cli/src/commands
bun run test:e2e:import-pdf            DOCSY, built CLI, cleanup verified
bun run typecheck                      4 successful tasks
```

The live cases publish each acceptance PDF with `--split off --scan-policy
fail --unsupported fail` and without `--attach-source`, read the ADF back
independently (ordered blocks, table shapes, one media node, no fallback) and
check that the only attachment is the figure. Word for Mac exports untagged
PDFs without its online service, so there is no tagged Word acceptance fixture.

## PIQ-17

Result: **PASS**. A rejected tagged table is one atomic region: its cell text
stays linearized once and its rendered crop covers the whole table, including
cells whose text boundary is unresolved. Geometry no longer re-projects those
cells as residue, so they no longer escalate to a page fallback through the
`overlapping-tagged-owner` rule. Hybrid policy V2 `/3`.

The same fixture exposed a duplicated figure: browsers tag `<figure>` as a
Figure around the image's own Figure and the caption, and both claimed the
image. V2 now projects only the outermost Figure and takes the alternative
text from the nested one when the outer has none. V1 is unchanged.

Neutral result, `struct-tree/browser-hard-table` (nested table negative,
review with `--split off`):

| Metric | Before | After |
|---|---|---|
| Page fallbacks | 1 (`overlapping-tagged-owner`) | 0 |
| Table region crops | 2 | 2 (one per page part) |
| Native raster figures | 2 media items for one image | 1, with author alt text |
| `figure-alt-missing` | 1 | 0 |
| Block order | heading, paragraph, image, image, … | heading, paragraph, image, caption and body, table crop and rows per page |

The figure (y 0.14 to 0.20) lies outside the page-0 table crop (from y 0.27).
Escalation stays explicit for residue that cannot be localized:
`dispersed-residual-regions`, `oversized-residual-region`,
`overlapping-tagged-owner` and `missing-geometry` (`hybrid.test.ts`). Two
disjoint rejected tables produce two crops (`figures.test.ts`); solved
fixtures produce none.

## Live E2E, benchmark and scaling rerun (2026-10-20)

`bun run test:e2e:import-pdf` (current checkout, profile `mayflower`, space
`DOCSY`): 10 pass, 0 fail; the resource tracker removed every created page.

`bun run bench:import-pdf` now measures the V2 adapter the CLI uses (it
measured V1 before). All gates pass: p95 218 ms (budget 30 s), first progress
p95 9 ms (500 ms), cancellation p95 0.9 ms (1 s), peak RSS 540 MiB (750 MiB),
deterministic facts and recovery. The fixture is untagged, so the
document-tree reader is measured separately on locally generated neutral
Chromium exports (not committed):

| Input | Tree read | Adapter total | Review | Native tables | Fallbacks |
|---|---|---|---|---|---|
| 15 pages, one 600-row table | 49 ms | 327 ms | 0.8 s | 1 | 0 |
| 68 pages, 150 sections and one 2,000-row table | 150 ms | 816 ms | 6.0 s | 1 | 0 |

The scaling run found that a logical table above the per-page geometry limit
of 250 rows split silently into one table per page. Tagged tables now use
`PDF_TABLE_POLICY_V2.maximumLogicalRows` (5,000; table policy V2 `/4`), and a
continuation that still cannot be joined reports
`pdf-import/table-continuation-unjoined` with its reason.

Known limits: on the 68-page input the V2 review peaks at about 1.8 GiB RSS
(the V1 review on `main` peaks at 1.2 GiB and yields no native table). A
6,000-row variant exceeds the existing PDFium evidence budget (250,000
entries) in page-scoped structure extraction and fails closed.

## PIQ-13 to PIQ-15 on the document tree

Result: **DONE** in the production tagged lane. V2 page structures now come
from the full-document structure tree (`facts.structureSource:
"document-tree"`); V1 keeps PDFium's page-scoped structure so its pinned facts
are unchanged.

### Contract and revision changes

- `PdfStructureKidFactV2` gains `page-external` and `object-reference`;
  `unresolved` gains the reason `document-structure-invalid`.
- `PdfStructureNodeFactV2.logicalId` (optional) is equal on every page that
  shows an element; `PdfFactsV2.structureSource` records the structure origin.
- Revisions: adapter V2 `/3`, analysis policy V2 `/3`, tagged policy V2 `/3`,
  table policy V2 `/3`, text assembly V2 `/4`. API report and closure
  regenerated.

### Behavior

- **PIQ-13:** empty `TH`/`TD` are native empty cells. A row whose producer
  omitted an empty cell element is re-placed by its cells' `/Headers`
  references and the gap becomes an empty cell. Nested, rotated or
  Unicode-invalid cells still fail closed.
- **PIQ-14:** closing punctuation or a spaced en dash at a line end before a
  letter, and a word before opening punctuation or an en dash on the next
  line, join with one space. Ideographic punctuation and digits are excluded.
  A block that writes word spaces as literal glyphs (and has no generated
  whitespace) proves `no-space` for an ambiguous same-line run change
  (`whitespace-convention`). A left-to-right line whose glyphs were emitted out
  of visual order is read in visual order; sequences with right-to-left text
  are never reordered.
- **PIQ-15:** a table whose logical identity appears on several pages is
  projected once as a whole. Rows are joined by structure identity: a
  repeated header (same element, or a header-only row at the start of a
  continuation page with identical characters) appears once and still owns
  its repetitions; a row split by a page break joins its cells' content; row
  spans across a page break are kept.
- Lists: an item's own text before a nested list (word processors and
  browsers) is the item paragraph; an item without visible text is an empty
  item instead of demoting the whole list.

### Neutral results (CLI preview, before → after)

| Fixture | Native tables | Page fallbacks | Unresolved boundaries |
|---|---|---|---|
| struct-tree/browser-multipage-table | 0 → 2 | 3/3 → 0 | 249 → 0 |
| struct-tree/browser-rowspan-break | – → 1 | – → 0 | – → 0 |
| struct-tree/browser-list-patterns | – | – → 0 | – → 0 |
| struct-tree/browser-hard-table (nested table negative) | 0 → 0 (linearized) | 2 → 1 | 125 → 2 |

### Private acceptance

A private tagged document (word-processor export) was imported locally and,
with the owner's explicit approval, into DOCSY as one test page. Before: every
page was a page fallback and no table was native. After: no page fallback, all
of its tables native including one continued across a page break with a single
header, and an independent readback matched every table cell and the complete
word sequence of the local result. No private bytes, text, identifiers,
counts or URLs are recorded here.

### Verification

```text
bun run test packages/import-pdf      all pass
bun run typecheck                     4 successful tasks
bun run check:import-pdf-quality      passed: true, falseNativeCount 0
bun run check:research-privacy        tracked tree passed
bun run check:browser                 passed
bun run test scripts/api-report.test.ts scripts/quality   pass
```

## Full-document structure tree spike

Result: **GO** for the full-document tag tree as the primary tagged-PDF
structure source. Production routing is not changed yet.

### What was built

- `packages/import-pdf/src/pdf-objects.ts`: read-only PDF object reader in
  pure TypeScript (classic and stream cross-references, `/Prev` and
  `/XRefStm`, object streams, FlateDecode with PNG predictors, scan recovery)
  plus a content-stream classifier for MCID-marked sequences.
- `packages/import-pdf/src/struct-tree.ts`: `StructTreeRoot` traversal with
  `obj:<num>` identity, RoleMap resolution, MCR/OBJR/integer kids, table
  attributes (`RowSpan`, `ColSpan`, `Scope`, `Headers`), a body-free
  correlation with PDFium V2 facts, and `elementCharacters()` which returns
  PDFium character positions in structure order.
- Inflate uses `fflate` 0.8.3, already in the workspace through `@atlcli/docx`.

### Neutral results

| Fixture | PDFium unresolved kids | Tree invalid kids | Unmatched refs | Marked chars owned once |
|---|---|---|---|---|
| independent tagged (3) | 0 | 0 | 0 (one XObject figure classified) | 100 % |
| producer-browser | 1 | 0 | 0 | 100 % |
| producer-libreoffice | 0 | 0 | 0 | 100 % |
| struct-tree/browser-multipage-table | 175 | 0 | 0 | 100 % |
| struct-tree/browser-hard-table | 58 | 0 | 0 | 100 % |

- The three-page table is one logical table (71 rows, 3 columns). Chromium
  tags each repeated page header as additional content of the same `TH`, which
  is direct proof for removing repeated headers in PIQ-15.
- Chromium omits the element for an empty `TD`; the remaining cells carry
  `/Headers` references that place them unambiguously.
- Exact cell text materialized through `elementCharacters()` matches the
  authored sources, including `rowspan` across a page break, `colspan`, CJK and
  the nested table.
- A private local acceptance document (Word export) was evaluated transiently.
  Its only gap was MCID sequences painting a single space that PDFium does not
  report as characters; the classifier proves them whitespace. No private
  bytes, counts, text or identifiers are recorded here.

### Remaining gaps (not structure-tree issues)

- Cell text still needs the V2 text assembler: wrapped lines without an
  emitted space (`Inner`/`A`) and punctuation transitions stay unresolved
  boundaries (PIQ-14).
- A nested table's text is also inside the outer cell's references; the
  projection must exclude nested `Table` descendants.
- One RTL row shows PDFium's character order within a single MCID; bidi
  handling belongs to text assembly.
- Untagged PDFs (common for contracts) are out of scope for this lane.

### Verification

```text
bun run test packages/import-pdf scripts/experiments
139 pass
0 fail
```

```text
bun run typecheck            4 successful tasks
bun run check:research-privacy   tracked tree passed
bun run check:import-pdf-quality passed: true
bun run test scripts/api-report.test.ts   5 pass
```

## Temporary multi-engine oracle spike

Result: **diagnostic architecture GO; production integration NOT proven**.
The spike code (PDFBox, pdfplumber, PDF.js and Poppler drivers) was removed on
2026-10-20 after the full-document structure tree replaced its role; it remains
in git history.
This checkpoint does not complete PIQ-11 through PIQ-18 and does not change
the production importer or Confluence publication path.

### Design and privacy boundary

- the current PDFium `2.15.0` V2 review is the production baseline;
- PDF.js `6.1.200` supplies an independent page-structure summary;
- Apache PDFBox `3.0.8` traverses the full document structure tree and
  materializes table rows/cells internally;
- Poppler `pdftotext 26.03.0` supplies independent text and bounding-box
  coverage;
- pdfplumber `0.11.9` supplies independent line- and text-grid candidates;
- Docling, PaddleOCR, OCR, language models, and document-specific repair rules
  were not used;
- engine outputs are not combined by voting; expected structure comes from an
  independent generator, documented standards example, or reviewed source;
- cell text exists only in the in-memory PDFBox-to-Bun pipe. The emitted report
  contains non-identifying labels and aggregate counts only;
- no downloaded public PDF, generated spike PDF, render, JSON report, PDFBox
  JAR, or private input/derivative is committed.

The PDFBox application JAR was downloaded from the official Apache page and
its published SHA-512 was verified before execution. The veraPDF corpus was
read from its official repository at commit
`a146f4f07c1598410630533a193c2dd4fc44419f` (CC BY 4.0).

### Independent inputs and results

| Input | Independent truth | Current PDFium result | Oracle result |
|---|---|---|---|
| generated fragmented tagged text | generator operations and structure tree | no fallback; zero unresolved structure children | PDF.js/PDFBox role-count delta `0` |
| generated tagged structures | exactly two tables with eight cells | two editable tables; no fallback | PDFBox materializes two tables/eight cells; table-token coverage in PDFium facts `1.0` |
| generated fragmented untagged text | generator operations and rendered page | no fallback; zero unowned characters | all lanes complete; no false structure advantage reported |
| W3C complex table | official PDF20 example plus visual inspection: one six-column table, two header rows, four body rows, row/column spans | zero editable tables; one page fallback; four unresolved structure children | PDFBox: one table, six rows, 35 structural cells including four empty span placeholders, zero unknown children; every materialized table token occurs in PDFium facts, while raw page-plus-MCID reference overlap is `0.825` |
| veraPDF `7.5-t01-pass-e` | atomic tagged-table pass case | one editable table; no fallback | PDFBox and pdfplumber each identify one table; exact token coverage |
| veraPDF `7.5-t01-fail-a` | atomic PDF/UA failure case for the same visible table family | one editable table; no fallback | same import shape as the pass case; the PDF/UA conformance distinction is not itself an import-fidelity decision |

pdfplumber reports four line-table candidates for the W3C page because merged
and row-spanning cells divide the raw grid. That is useful local geometry
evidence but not evidence for four logical tables. The documented/visual
oracle and full structure tree determine that the page contains one table.

The body-free private lane was executed locally but is deliberately excluded
from committed counts, document characteristics, URLs, hashes, and results.
It cannot satisfy PIQ-18 until the neutral fixture, production implementation,
DOCSY readback, and no-fallback gates pass.

### What the spike proves

- the missing information is structural correlation, not missing born-digital
  text: the full-structure adapter can materialize cell content and an
  independent multiset check confirms that every table token exists in
  PDFium's text stream;
- exact cross-engine page-plus-MCID overlap is not complete even in the public
  W3C example. Production reconciliation must classify empty/page-external
  references and cannot assume that both parsers expose identical MCID keys;
- a full-document structure view can expose table identity across source page
  boundaries, which the current page-scoped failure path cannot preserve;
- structure and local geometry provide complementary evidence: one recovers
  authored semantics and the other localizes visible grids;
- a separate neutral oracle IR is viable; inventing PDFium provenance for
  another parser or selecting the majority parser would make evidence weaker;
- the spike does not yet prove spans in ADF/Storage, production dependency
  packaging, deterministic continuation merge, localized fallback, or live
  Confluence fidelity.

### Verification

```text
bun run test scripts/experiments/pdf-oracle-spike.test.ts
4 pass
0 fail
8 expect() calls
```

```text
bun run test packages/import-pdf scripts/experiments/pdf-oracle-spike.test.ts
121 pass
0 fail
1033 expect() calls
```

```text
bun run check:import-pdf-quality
passed: true
7 fixtures passed
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun run test:e2e:import-pdf
10 pass
0 fail
205 expect() calls
```

The live gate built the current CLI, published and independently read back only
the existing neutral fixtures in DOCSY, and exercised its cleanup/rollback
paths. It did not publish the private input or change the production importer.

All six neutral/public runs reported `targetArchitectureCarries: true`: every
engine completed, page counts agreed, and the PDFBox structure traversal was
acyclic. Only the W3C case reported an actionable oracle advantage; the other
cases act as agreement and false-positive controls.

Public references:

- <https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF20>
- <https://www.w3.org/WAI/WCAG22/working-examples/pdf-complex-table/complex-table.pdf>
- <https://github.com/veraPDF/veraPDF-corpus>
- <https://pdfbox.apache.org/download.cgi>

## PIQ-00

### Baseline

- implementation starting commit:
  `e126b453b1060779bf9cf896046d300505afc388`;
- runtime: Bun `1.3.14`;
- mandatory in-scope drift diff: empty;
- repository status before evidence files: clean;
- persisted V1 consumer: none found;
- STOP condition: none.

### Verification

```text
bun run test packages/import-pdf
55 pass
0 fail
508 expect() calls
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

The typecheck emitted non-fatal restricted-cache IO warnings after all four
tasks succeeded. They did not change the result and are not treated as a source
or implementation failure.

### PIQ-00 gate

- [x] Drift checked against the planning baseline.
- [x] V1 consumers classified; no persisted facts migration is required.
- [x] Importer baseline passes through the root Bun test script.
- [x] Repository typecheck passes.
- [x] Privacy boundary recorded without private input evidence.

## PIQ-01

### Neutral corpus

- four independent PDFs are generated byte-identically by Bun from a
  deterministic low-level writer;
- three pinned desktop-producer PDFs use the same neutral semantic source
  family and record exact producer/version/export provenance;
- producer families proven: independent, Word, LibreOffice, and browser print;
- all seven PDFs contain one page so every positive or critical-negative
  outcome is isolated and attributable;
- `manifest.json` records exact ordered blocks, boundary actions with source
  character indexes, structure outcomes, ownership/fallback expectations,
  safe links, byte lengths, and digests;
- the manifest oracle is authored independently of importer output.

The pinned producer variance is explicit: the current Word export is
`digital-untagged`; LibreOffice and Chromium are tagged. The LibreOffice export
contains the neutral CJK string in its text layer but does not render its glyph
with the local exporter/font combination. That fixture is marked as a critical
producer-rendering negative and requires fallback; it is not counted as
positive visual CJK evidence. Independent facts, Word, and Chromium provide
the positive CJK lanes.

### PDF and privacy verification

- all final PDFs were rendered at 144 DPI and visually inspected;
- the six positive render lanes have no overlap, clipping, or missing glyphs;
- the single intentional LibreOffice negative is isolated in the manifest;
- `pdfinfo` confirms one page, no encryption, no forms, and no JavaScript for
  every fixture;
- desktop exports contain fixed neutral metadata and no creation/modification
  timestamps or XMP metadata streams;
- source, raw PDF bytes, manifest, and PDFium-extracted text/structure/link
  fields are scanned for local user paths, email addresses, Atlassian hosts,
  and `ATLCLI_FIXTURE_PROHIBITED_TERMS`;
- only `example.com` is allowlisted for fixture links.

### Verification

```text
bun run test packages/import-pdf/src/fixtures.test.ts
3 pass
0 fail
209 expect() calls
```

```text
bun run test packages/import-pdf
58 pass
0 fail
717 expect() calls
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

The typecheck again emitted only non-fatal restricted-cache IO warnings after
all tasks succeeded.

### PIQ-01 gate

- [x] Fragmented text, ordered mixed kids, line boundaries, scripts, producer
      structures, localized residue, and explicit negative shapes are covered.
- [x] The independent generator is Bun-only and byte-deterministic in CI.
- [x] Desktop producer bytes are pinned with complete neutral provenance.
- [x] Exact truth is richer than token matching and remains importer-independent.
- [x] Final PDFs were rendered and visually reviewed.
- [x] Focused tests, the full importer suite, typecheck, and privacy scans pass.

## PIQ-02

### Additive V2 facts

- V2 character facts retain a stable first-seen per-page text-run ordinal;
  parser handles are never serialized;
- V2 structure facts retain exact mixed child-index order, including explicit
  unresolved gaps, and preserve direct MCIDs only as a non-duplicating fallback;
- separate injected, Node, and browser V2 factories emit identical canonical
  facts and digests;
- the production factory continues to return V1 through an internal projection;
- two pinned neutral V1 facts digests and their V1 options digest remain exact;
- a regression gate proves that a tight canonical-size budget is applied to
  the public V1 projection rather than the larger internal V2 evidence;
- lifecycle fault cleanup, cancellation, hard-budget rejection, deterministic
  recovery, and the reviewed public PDFium allowlist remain intact;
- the public API report and reachable closure contain only the intended
  additive import-PDF symbols and no reachable-but-unexported gaps.

The unresolved-child case is generated in memory from a neutral deterministic
probe and is not added as another committed PDF binary.

### Verification

```text
bun run test packages/import-pdf/src/pdfium.test.ts \
  packages/import-pdf/src/package-boundary.test.ts
20 pass
0 fail
```

```text
bun run test packages/import-pdf
65 pass
0 fail
767 expect() calls
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun run build:browser-export-harness
1 successful task
0 failed tasks

bun run test:browser-export-harness
6 pass
0 fail
```

The browser E2E required execution outside the filesystem/network sandbox so
its local server could bind its loopback port. No external service or private
input was used.

```text
bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
V1 and V2 browser facts surfaces loaded from built package output
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

The build and typecheck emitted only non-fatal restricted-cache IO warnings
after all tasks succeeded.

### PIQ-02 gate

- [x] V2 facts and injected, Node, and browser factories are additive.
- [x] Stable text runs and exact mixed structure-child order are deterministic.
- [x] Unusable child positions remain explicit and direct fallback does not
      duplicate usable ordered MCIDs.
- [x] Existing V1 schema, revisions, factory type, representative digests, and
      canonical-size budget behavior remain stable.
- [x] Browser/Node parity, lifecycle, cancellation, hard budgets, and PDFium
      package boundaries pass.

## PIQ-03

### Shared text assembly

- one pure, source-neutral assembler preserves caller-supplied logical order
  and emits exact boundary actions, evidence bases, confidence, source indexes,
  stable decision IDs, transformations, and unresolved counts;
- all geometry thresholds, confidence values, and presentation-ligature rules
  live in one frozen `/2` policy;
- safe canonicalization retains line and soft-hyphen evidence until assembly;
- authored/generated whitespace, qualified run gaps, physical-line joins,
  punctuation, hard/generated hyphens, CJK, RTL, ligatures, NFC, conflicting
  geometry, and aligned/misaligned/empty `ActualText` have exact assertions;
- neutral tagged and untagged PDF facts calibrate exact run-gap, line-join, and
  dehyphenation decisions without creating expectations from importer output;
- issues and decision IDs contain opaque locators and indexes, not source body;
- the new surface is exported consistently for Node and browser consumers;
- legacy V1 production assembly remains unchanged until PIQ-04 can switch all
  callers and dependent semantic revisions atomically.

### Verification

```text
bun run test packages/import-pdf/src/text.test.ts \
  packages/import-pdf/src/text-assembly.test.ts
16 pass
0 fail
54 expect() calls
```

```text
bun run test packages/import-pdf
79 pass
0 fail
819 expect() calls
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
text-assembly /2 browser surface loaded from built package output
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

The tarball smoke required temporary-directory access and the browser E2E
required a local loopback port outside the sandbox. No external service or
private input was used.

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

Build and typecheck emitted only non-fatal restricted-cache IO warnings after
all tasks succeeded.

### PIQ-03 gate

- [x] Every required boundary family has exact evidence and final-text proof.
- [x] `ActualText` is authoritative, including aligned and empty values;
      unalignable marks are reported without source-body disclosure.
- [x] Three pure runs produce identical assembly and digest.
- [x] Neutral PDF facts calibrate the fixed geometry policy.
- [x] Full importer, build, typecheck, API, packed consumer, and browser gates
      pass.
- [x] No private PDF or private-derived artifact was read or written.

## PIQ-04 tagged-lane checkpoint

This is a proven intermediate checkpoint, not completion of PIQ-04. The
geometry lane and atomic production cutover remain open.

### Tagged V2 routing

- V2 tagged correlation follows ordered mixed structure kids and retains
  generated whitespace or hyphen bridge evidence between adjacent MCIDs;
- paragraphs, headings, safe link runs, list items, and tagged table cells all
  consume the shared text-assembly segments;
- synthesized separators inherit a link only when their nearest source
  characters resolve to the same safe annotation;
- mismatching `ActualText` never receives a source link and emits a body-free
  issue instead;
- boundary decisions, transformations, exact character indexes, confidence,
  and outcomes are bound into the `/2` semantic digest;
- an unresolved structure-child position is explicitly reported and demoted
  to geometry rather than being silently skipped;
- V1 tagged normalization and the production route remain unchanged until the
  remaining PIQ-04 lanes can cut over atomically.

The neutral fragmented tagged fixture produces seven exact editable blocks,
including qualified spaces, generated-hyphen removal, RTL, CJK, ligature
expansion, umlauts, and the bounded safe link. It records 22 boundary
decisions, zero unresolved boundaries, and all 143 eligible tagged characters
are claimed exactly once. The separate untagged residue remains intentionally
out of this checkpoint; PIQ-05 owns hybrid recovery.

### Verification

```text
bun run test packages/import-pdf/src/text-assembly.test.ts \
  packages/import-pdf/src/links-v2.test.ts \
  packages/import-pdf/src/tagged.test.ts \
  packages/import-pdf/src/tables.test.ts
28 pass
0 fail
146 expect() calls
```

```text
bun run test packages/import-pdf
85 pass
0 fail
845 expect() calls
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
V2 tagged semantic schema, digest, page outcome, and 16 boundary decisions
loaded from built browser package output
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

The tarball smoke required temporary-directory access and the browser E2E
required a local loopback port outside the sandbox. No external service or
private input was used.

### Checkpoint gate

- [x] Tagged text, links, list items, and tagged table cells use one V2
      assembler without changing the V1 production path.
- [x] Exact ADF and Storage text, safe link boundaries, and neutral boundary
      evidence pass.
- [x] Unresolved structure and `ActualText` mark mismatch fail closed with
      body-free diagnostics.
- [x] Full importer, build, typecheck, API, packed consumer, and browser gates
      pass.
- [x] No customer PDF or customer-derived artifact was read, staged, or
      written.

## Acceptance correction checkpoint

This is a sanitized code-inspection checkpoint, not implementation evidence.
No private source bytes, text, images, metadata, identifiers, URLs, hashes,
counts derived from private content, or tenant receipts are recorded here.

The current production path proves these remaining gaps directly from source:

- `packages/import-pdf/src/adapter/pdfium.ts` maps every child position for
  which both page-scoped PDFium child calls return no value to the single
  `child-handle-and-mcid-unavailable` reason. The facts contract has no
  page-external variant.
- `packages/import-pdf/src/normalize.ts` returns immediately when a structure
  node is in `unresolvedNodeIds`, including semantic containers, before
  visiting resolved children.
- `packages/import-pdf/src/tables.ts` treats unresolved row-wrapper children
  as `row-wrapper-content`, rejects a tagged cell when its assembled text is
  empty, and rejects a table when any cell has an unresolved boundary.
- the same module derives one untagged grid from every eligible thin path on a
  page and rejects the grid when any resulting cell has no already assembled
  fragment.
- `packages/import-pdf/src/untagged.ts` adds table and page-geometry failure
  reasons to the page qualification set, so a local table ambiguity can
  suppress native projection for the full page.

The earlier neutral corpus contains producer tables but not the combined
multi-page continuation, repeated header, blank cell, mixed body/figure, and
decorative-rule case. Its PASS result therefore does not close that product
outcome.

### Checkpoint result

- [x] The premature overall completion claim is withdrawn.
- [x] PIQ-11 through PIQ-18 are specified with fail-closed acceptance gates.
- [x] The correction contains only repository facts and neutral requirements.
- [ ] Page-external structure children are classified and proven.
- [ ] Usable siblings survive page-external or unresolved container children.
- [ ] Tagged blank cells are native and proven.
- [ ] Safe punctuation line joins are deterministic and proven.
- [ ] Multi-page table continuation is reconciled and proven.
- [ ] Local connected grids are detected before global reading order.
- [ ] Remaining grid ambiguity is region-scoped and proven.
- [ ] Neutral and live publication acceptance passes.

## Post-implementation geometry and line-wrap hardening

The completed V2 production path now rejects two additional false-positive
fallback causes with neutral regression coverage:

- a bare Roman or decimal page number is page furniture only when it is in the
  lower-right footer zone;
- a horizontal gap becomes a column boundary only when both start positions
  repeat and at least two vertically aligned fragments support both sides;
- an indented singleton therefore remains in one-column source order, while
  repeated aligned two-column evidence retains column-first order;
- generated physical-line whitespace after closing punctuation joins to a
  following non-CJK word with one provenance-bound synthesized space.

The geometry and shared text-assembly policy literals advance to `/3`. V1
behavior remains unchanged, and the generated public API report records the
new literal values.

### Verification

```text
bun run test packages/import-pdf/src apps/cli/src/commands/wiki-import-pdf.test.ts
123 pass
0 fail
1086 expect() calls
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke-vite.ts
Vite tarball, DOCX, and PDF smoke pass
```

```text
bun run test:e2e:import-pdf
10 live cases pass
0 fail
205 expect() calls
owned neutral DOCSY resources cleaned up
```

No private source, derived artifact, tenant identifier, live URL, raw receipt,
or private body was added to this evidence or to the repository.

## PIQ-10

PIQ-10 is complete. The final prescribed matrix passes against the current
checkout, including the full monorepo suite, semantic quality gate,
performance budgets, public API guard, documentation, and neutral built-CLI
Cloud publication with verified cleanup.

### Pinned versions and neutral inputs

- AtlCLI `0.17.2`;
- `@atlcli/import-pdf` `0.1.0`;
- Bun `1.3.14`;
- `@embedpdf/pdfium` `2.15.0`;
- vendored PDFium WASM SHA-256
  `c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8`;
- facts and semantic production contracts use `/2`, text assembly policy uses
  `/2`, and production review/plan use `/3` while prior public revisions
  remain compatible.

The final fixture test independently verified these committed neutral PDF
digests against `manifest.json`:

| Fixture | SHA-256 |
|---|---|
| `tagged-fragmented-boundaries` | `45ce6c5d5bf4554d59bf15777677e8c1856a9ba34692b47038507c3deb5986bf` |
| `tagged-structures-positive` | `aefd197a939482fe350a5c82250fd219fb9fc5d23895bcab42f8de88c1c60a6f` |
| `tagged-structures-negative` | `1d3d4368f7347c8fe84b7c2bc101ad30fddd376e505848ec6ba9bdcde7bdad14` |
| `untagged-fragmented-boundaries` | `bb4864067ce71ec8cbed5f43f69abde854eb331ec5826ca29ac016ee1dd290f3` |
| `producer-word` | `abd78bedabfdc0e3e24745aa35515cc619041ddf10df2ff5525d470569052dec` |
| `producer-libreoffice` | `cab1614b8e6db27e30b6f76a0fb63b1c64e22aeee392c65d546ccde3e7844b6b` |
| `producer-browser` | `a7282415f72fc860964b75533c62dfefe1ce75ac4f11a25b9ec2fcc84d04bc7f` |

### Semantic quality result

- 7 of 7 fixture rows and 4 of 4 producer families pass;
- accounted-page rate, exact fragmented-text rate, exact ordered-block-pair
  rate, word-boundary precision/recall, tagged-list F1, tagged-table-cell F1,
  and explicit-span F1 are all `1.0`;
- unreported visible-character loss, duplicate ownership, false-native cases,
  unresolved boundaries in native blocks, and unsafe promoted links are all
  `0`.

### Final verification matrix

```text
bun run test packages/import-pdf
114 pass, 0 fail, 1015 expect() calls across 17 files

bun run check:import-pdf-quality
7/7 fixtures pass; 4/4 producer families pass

bun run typecheck
4 successful tasks, 0 failed tasks

bun run build
34 successful tasks, 0 failed tasks

bun run test scripts/api-report.test.ts
5 pass, 0 fail, 14 expect() calls

bun run test
8513 pass, 26 intentional skips, 0 fail
43350 expect() calls across 716 files

bun run docs:check
3 files checked; 0 errors, 0 warnings, 0 hints

bun run test:e2e:import-pdf
10 pass, 0 fail, 205 expect() calls
owned-resource deletion and no-current-state proof pass

git diff --check
pass

git status --short
clean after removal of test-generated consumer outputs
```

The full monorepo suite ran in the host environment because its local HTTP
server and packed-consumer tests require loopback and temporary-directory
access that the restricted sandbox does not provide.

### Performance result

The five-sample neutral 100-page, 25 MiB benchmark passes every gate:

| Gate | Result | Budget |
|---|---:|---:|
| analysis p95 | `199.410459 ms` | `30000 ms` |
| first progress p95 | `5.830042 ms` | `500 ms` |
| cancellation p95 | `0.571583 ms` | `1000 ms` |
| peak RSS | `575553536 bytes` | `786432000 bytes` |

All samples are deterministic, recover to the same facts digest, observe a
stable WASM-memory plateau, and cancel after one page.

### Live cleanup and privacy result

- the current Bun-built CLI published only committed neutral fixtures;
- exact source extraction and independent ordered ADF readback both pass;
- the failure matrix rolls back every exactly owned resource;
- normal-case cleanup proves every owned page absent by ID and exact title;
- no raw ADF, source body, tenant/page identifier, live URL, receipt, profile,
  credential, browser capture, or generated live artifact is retained;
- the only PDFs introduced by this branch are the seven manifest-allowlisted
  neutral corpus fixtures listed above. The motivating private PDF and every
  customer-derived artifact remain outside Git.

### Release recommendation

The PDF import quality work is a merge candidate after normal draft-PR review
and green remote CI. No release was created. A release remains a separate,
explicit operation and must start with the repository's required dry-run.

### Task gate

- [x] Every command in the prescribed PIQ-10 order passes.
- [x] Every producer family passes independently; aggregates hide no failure.
- [x] Time, RSS, cancellation, lifecycle, and determinism budgets pass.
- [x] Current built-CLI Cloud publication and cleanup pass.
- [x] Final evidence contains only bounded neutral facts and digests.
- [x] No private PDF, customer-derived artifact, or tenant data entered Git.

## PIQ-06

PIQ-06 is complete. Producer-shaped tagged tables and list bodies now retain
all representable source structure, while unsupported shapes and unmatched
Figures remain explicit rather than being silently dropped or over-closed.

### Tables, lists, and Figures

- a pure V2 row collector accepts direct `TR` children and flattens allowlisted
  `THead`, `TBody`, and `TFoot` wrappers in exact kid order; nested neutral
  containers qualify only when they contain rows without sibling semantic
  content;
- absent `RowSpan` and `ColSpan` default to one only inside the existing
  complete, non-overlapping grid proof. Rotated grids, nested tables, malformed
  wrappers, holes, and overlaps remain linearized with explicit evidence;
- rendered table fallbacks are keyed and cropped per table source ID, so two
  separate tables on one page produce two bounded candidates rather than one
  page-wide union;
- V2 list projection traverses every ordered `LBody` paragraph plus one
  compatible nested list. Inline producer bodies remain supported. Multiple
  nested lists and unknown children each receive exact residual evidence and
  issues instead of first-child selection;
- list labels and every accepted paragraph have leaf ownership evidence.
  Reported aggregate and residual evidence is diagnostic and cannot become a
  competing confirmed character owner;
- deferred Figure evidence is removed only for a source ID with a verified
  materialized candidate. Unmatched Figures remain reported and select the
  smallest proven fallback scope: bounded region, page, or report-only;
- visual fallback assessment consumes the post-materialization evidence, so a
  successfully attached Figure closes only its own deferred report.

The independent positive structure fixture produces two native tables and one
ordered list whose item contains two paragraphs and one nested list. All 117
visible characters have one final owner, with zero duplicates, zero residual
characters, and no visual fallback. The independent negative fixture reports
both incompatible nested lists, keeps 91 residual characters visible through
page fallback, and records zero duplicate ownership attempts. A form-backed
Figure without a materializable candidate remains report-only.

### Verification

```text
bun run test packages/import-pdf/src/tables.test.ts \
  packages/import-pdf/src/tagged.test.ts \
  packages/import-pdf/src/figures.test.ts \
  packages/import-pdf/src/fallback-policy.test.ts
37 pass
0 fail
233 expect() calls
```

```text
bun run test packages/import-pdf/src \
  apps/cli/src/commands/wiki-import-pdf.test.ts \
  apps/cli/src/commands/wiki-import-pdf-publication.test.ts
126 pass
0 fail
1100 expect() calls
```

```text
bun --conditions=development run --cwd apps/cli src/index.ts wiki import \
  ../../specs/pdf-import-quality/fixtures/independent-structures-tagged.pdf \
  --space DOCSY --json
review schema /2
2 native tables
1 complete ordered list plus 1 nested list
117 visible and 117 uniquely owned characters
0 duplicate ownership attempts
0 residual reported characters
1 unmatched Figure at report-only scope
0 blockers
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke.ts
tarball consumer smoke PASS
DOCX smoke PASS
PDF smoke PASS

bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
DOCX browser smoke PASS
PDF browser smoke PASS
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

The packed consumer tests required temporary-directory access and the browser
E2E required a local loopback port outside the sandbox. Only committed neutral
fixtures were used. No customer PDF, customer-derived artifact, tenant
identifier, live URL, or private content entered Git, evidence, or test output.

### Task gate

- [x] Wrapper rows retain exact source order and absent spans default safely.
- [x] Nested, rotated, malformed, overlapping, and incomplete tables fail
      closed.
- [x] Separate tables receive separate rendered fallback candidates.
- [x] Every representable list paragraph and compatible nested list projects;
      every unsupported child remains explicit residual evidence.
- [x] Figure reports close by verified source ID only; unmatched Figures retain
      their smallest safe fallback scope.
- [x] Exact structure, text, character ownership, and fallback counts pass.
- [x] Full importer, CLI, typecheck, build, API, packed consumer, and browser
      gates pass.
- [x] No customer PDF or customer-derived artifact entered Git or evidence.

## PIQ-07

PIQ-07 is complete. The documented source-fidelity thresholds now run as one
body-free Bun gate, with an independent result row for every neutral fixture
and producer family.

### Executable semantic gate

- `scripts/quality/import-pdf-quality.ts` reads the neutral truth manifest,
  runs the current V2 review pipeline, and emits fixture IDs, counts, rates,
  booleans, and stable failure codes only;
- each fixture independently enforces accounted pages, zero unreported visible
  loss, zero duplicate ownership, zero false-native negative outcomes, exact
  fragmented text, word-boundary precision/recall, ordered block pairs,
  tagged list/nesting F1, tagged table cell-text F1, span F1, exact manifest
  boundary decisions, exact fallback scope, required issue codes, zero
  unresolved native boundaries, and zero promoted unsafe links;
- an aggregate cannot hide a failed producer because `passed` requires every
  fixture row to pass its class-specific thresholds;
- the manifest now includes the complete producer list items, explicit nested
  depth, required non-native issue codes, and span truth without changing any
  committed PDF bytes;
- the guard-the-guard test perturbs one expected block string and one expected
  boundary action. Each mutation fails only its owning fixture row;
- the gate exposed a pinned LibreOffice negative whose text-layer characters
  had no material rendered glyph height. V2 tagged normalization now reports
  that nine-character run with `pdf/tagged-text-geometry-degenerate` instead of
  publishing it as native; auto mode retains a page fallback with
  `missing-geometry` and zero duplicate owners.

The semantic gate passes all seven fixtures and all independent, Word,
LibreOffice, and browser producer rows. Aggregate accounted pages, fragmented
text, boundary precision/recall, ordered blocks, tagged lists, tagged tables,
and spans are all `1.0`. Unreported loss, duplicate ownership, false-native
negatives, unresolved native boundaries, and promoted unsafe links are all
zero. The JSON report contains no expected or extracted source body.

### Verification

```text
bun run check:import-pdf-quality
7 of 7 fixture rows pass
4 of 4 producer families pass
all rate/F1 gates 1.0
all loss/duplicate/false-native/unsafe-link counts 0
```

```text
bun run test scripts/quality/import-pdf-quality.test.ts
3 pass
0 fail
54 expect() calls
```

```text
bun run test packages/import-pdf/src \
  scripts/quality/import-pdf-quality.test.ts \
  apps/cli/src/commands/wiki-import-pdf.test.ts \
  apps/cli/src/commands/wiki-import-pdf-publication.test.ts
130 pass
0 fail
1155 expect() calls
```

```text
bun --conditions=development run --cwd apps/cli src/index.ts wiki import \
  ../../specs/pdf-import-quality/fixtures/producer-libreoffice.pdf \
  --space DOCSY --json
9 residual reported characters
0 duplicate ownership attempts
page fallback: missing-geometry
default publication blocker present
```

```text
bun run bench:import-pdf
5 deterministic samples
analysis p95: 195.612 ms / 30000 ms budget
first progress p95: 5.620 ms / 500 ms budget
cancellation p95: 0.690 ms / 1000 ms budget
peak RSS: 575799296 bytes / 786432000 byte budget
recovery and WASM plateau: pass
```

```text
bun run typecheck
4 successful tasks
0 failed tasks

bun run build
34 successful tasks
0 failed tasks
```

```text
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke.ts
tarball consumer smoke PASS
DOCX smoke PASS
PDF smoke PASS

bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
DOCX browser smoke PASS
PDF browser smoke PASS
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

Peak-RSS measurement, packed consumer installation, and the browser E2E needed
their normal host facilities outside the sandbox. Only committed neutral
fixtures were read. No customer PDF, customer-derived artifact, tenant
identifier, live URL, or private body entered Git, the quality report, or this
evidence.

### Task gate

- [x] One Bun command enforces every documented semantic threshold per fixture.
- [x] No aggregate can hide a failing producer or critical negative family.
- [x] Block and boundary guard mutations fail for the expected reason.
- [x] A real text-layer-only negative is no longer reported as native.
- [x] Quality output is body-free and contains stable fixture metrics only.
- [x] Performance, cancellation, recovery, and memory budgets remain green.
- [x] Full importer, CLI, typecheck, build, API, packed consumer, and browser
      gates pass.
- [x] No customer PDF or customer-derived artifact entered Git or evidence.

## PIQ-08

PIQ-08 is complete. Production preview now uses a versioned V3 review schema
that surfaces source-fidelity quality separately from the unchanged
Confluence semantic-readback transport check.

### Versioned source-fidelity review

- V1 and V2 review contracts remain callable and retain their prior report and
  terminal behavior. V3 upgrades the completed V2 analysis without changing
  projected blocks, assets, split assignments, or publisher readback;
- every V3 page reports explicit, inferred, dehyphenated, and unresolved
  boundaries; tagged, geometry, and fallback character owners; duplicate and
  unowned characters; reported residuals; geometry-repaired characters and
  regions; fallback scope; and normalized fallback area;
- dehyphenation is explicitly a visible subset of inferred boundaries, so the
  established V2 inferred count remains compatible;
- each page has a body-free fidelity decision code:
  `pdf/source-fidelity-accounted`, `pdf/text-boundary-unresolved`, or
  `pdf/character-ownership-failed`;
- ownership failures add the warning issue
  `pdf-import/character-ownership-failed` with page index and counts only. The
  existing `pdf-import/text-boundary-unresolved` issue remains authoritative;
- `--unsupported fail` now adds page-labelled, code-labelled blockers for
  every unresolved boundary and every duplicate/unowned character;
- all new page counts, decision codes, issue summaries, blockers, and the V3
  review-policy revision participate in the semantic and plan digests;
- JSON and terminal preview contain bounded counts, labels, codes, locators,
  and normalized areas, never the affected source body;
- CLI and the neutral executable quality gate use V3. The public Node and
  browser tarball consumers both exercise the new surface;
- the documentation now distinguishes extraction fidelity from Confluence
  semantic readback, explains hybrid/local fallback and boundary diagnostics,
  adds merged-word/ownership troubleshooting, and repeats the prohibition on
  committing customer PDFs or derived artifacts.

The publisher and its semantic-readback implementation were not changed.

### Verification

```text
bun run test packages/import-pdf/src/review-v2.test.ts \
  apps/cli/src/commands/wiki-import-pdf.test.ts
10 pass
0 fail
89 expect() calls
```

```text
bun run docs:check
3 files checked
0 errors, 0 warnings, 0 hints
```

```text
bun run check:import-pdf-quality
7 of 7 fixture rows pass
4 of 4 producer families pass
all rate/F1 gates 1.0
all loss/duplicate/false-native/unsafe-link counts 0

bun run test scripts/quality/import-pdf-quality.test.ts
3 pass
0 fail
54 expect() calls
```

```text
bun run test packages/import-pdf/src \
  scripts/quality/import-pdf-quality.test.ts \
  apps/cli/src/commands/wiki-import-pdf.test.ts
123 pass
0 fail
1130 expect() calls
```

```text
bun --conditions=development run --cwd apps/cli src/index.ts wiki import \
  ../../specs/pdf-import-quality/fixtures/independent-fragmented-tagged.pdf \
  --space DOCSY --scan-policy report
page 1: explicit 14, inferred 12, dehyphenated 1, unresolved 0
ownership: 158/158; tagged 130, geometry 28, fallback 0, unowned 0
repair: 28 characters in 1 region; fallback none
decision: pdf/source-fidelity-accounted
no extracted body emitted
```

```text
bun run typecheck
4 successful tasks
0 failed tasks

bun run build
34 successful tasks
0 failed tasks
```

```text
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke.ts
tarball consumer smoke PASS
DOCX smoke PASS
PDF smoke PASS

bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
DOCX browser smoke PASS
PDF browser smoke PASS
review V3 browser decision: pdf/source-fidelity-accounted
```

Packed consumer installation used its normal host registry access. All PDF
verification read only committed neutral fixtures. No customer PDF,
customer-derived body, image, identifier, live URL, or private receipt entered
Git, preview output, tests, API reports, or this evidence.

### Task gate

- [x] V1/V2 remain compatible and production preview uses V3.
- [x] Every requested source-fidelity count is present per page and digest-bound.
- [x] Unresolved boundaries and ownership failures have stable issue/decision
      codes and fail-closed policy tests.
- [x] Standard JSON and terminal output identify page, counts, decision, and
      fallback scope without source body text.
- [x] Extraction fidelity is documented separately from unchanged semantic
      readback.
- [x] Focused, quality, full importer, docs, typecheck, build, API, Node
      consumer, and browser consumer gates pass.
- [x] No customer PDF or customer-derived artifact entered Git or evidence.

## PIQ-09

PIQ-09 is complete. The current checkout's Bun-built CLI now publishes the
neutral fragmented tagged fixture and proves exact source extraction separately
from exact Confluence ADF semantic readback.

### Independent extraction and publication proof

- the live suite reads `tagged-fragmented-boundaries` truth from the committed
  neutral manifest and resolves only its generated fixture path;
- before publication, the V3 source review is independently summarized as
  ordered semantic blocks and compared exactly with all eight manifest blocks;
- extraction also proves the expected single localized repair region, zero
  unresolved boundaries, zero unowned/duplicate characters, no fallback, and
  `pdf/source-fidelity-accounted`;
- publication runs through `bun run build:cli` and the resulting current
  `dist/index.js`, not an installed release;
- Confluence readback uses a separate ADF tree walker. It records ordered
  heading/paragraph/list/table-row summaries, link destinations, media IDs,
  table count, and fallback scope without using body-wide concatenation for
  the new case;
- the ordered ADF summary matches all eight neutral block strings exactly.
  Links, tables, media, fallbacks, and attachments are independently asserted
  empty for this fixture;
- extraction and ADF readback share only the independent neutral truth, so a
  transport success cannot hide a wrong extraction and an extraction success
  cannot replace publication readback;
- the shared resource tracker deletes the owned live page in `finally`; the
  existing page-ID 404 and exact-title absence checks prove no current state
  remains;
- the failure-injection matrix now builds V3 reviews as production does and
  retains exact child-first rollback proof for every sensitive stage;
- live output contains test names and bounded counts only. No page ID, tenant
  ID, URL, raw ADF, API receipt, or source body is written to evidence or disk.

The production publisher and semantic-readback implementation were not
changed.

### Verification

```text
bun run test apps/cli/src/e2e/wiki-import-pdf-live.e2e.test.ts
0 pass
10 skip
0 fail
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun run test:e2e:import-pdf
current Bun CLI build: pass
10 live cases pass
0 fail
205 expect() calls
fragmented extraction: 8 exact ordered blocks
fragmented ADF readback: 8 exact ordered blocks
fragmented links/tables/media/fallbacks/attachments: 0
owned-page cleanup and no-current-state proof: pass
```

```text
git status --short
only the intended live E2E test and sanitized plan/evidence changes
no generated live artifact
```

Only committed neutral fixtures were published to `DOCSY`. No customer PDF,
customer-derived artifact, tenant identifier, live URL, raw receipt, or private
body entered Git, logs retained by the task, or this evidence.

### Task gate

- [x] The current Bun build, not an installed release, publishes the fixture.
- [x] Exact manifest extraction is separate from exact ordered ADF readback.
- [x] Ordered text, links, table/media identity, and fallback scope are checked.
- [x] The new case uses no body-wide text concatenation or token-only checks.
- [x] Every owned page is cleaned and verified absent by ID and title.
- [x] Live evidence is sanitized and no generated artifact is tracked.
- [x] No customer PDF or customer-derived artifact entered Git or evidence.

## PIQ-05

### Character ownership and hybrid recovery

- V2 `auto` now uses a pure hybrid reconciler for tagged PDFs. Accepted tagged
  nodes retain semantic ownership while every visible unclaimed character is
  routed through localized geometry analysis;
- explicit `tags` remains tags-only and reports the unclaimed residue, while
  explicit `geometry` remains geometry-only. Neither explicit route executes a
  hybrid repair;
- the final ledger assigns every non-whitespace visible character exactly one
  deterministic tagged, geometry, fallback, or reported owner. Conflicting
  attempts are counted separately and fail closed;
- localized residual fragments are joined only within a versioned normalized
  gap. At most two independently localized regions may be repaired; distant
  regions remain separate, and dispersed, overlapping, oversized, rotated, or
  otherwise unqualified residue escalates safely;
- unresolved localized residue selects a bounded region fallback. Missing or
  dispersed residue retains page fallback. Materialized region/page fallbacks
  close the corresponding reported issues and update the final ownership
  outcome to `attached`;
- semantic and review digests now bind the ownership ledger, policy revision,
  boundary counts, repair metrics, duplicate attempts, residual counts, and
  fallback area;
- JSON and terminal previews expose only body-free per-page and aggregate
  ownership/repair metrics. The V1 review contract remains unchanged.

The positive independent tagged fixture produces eight exact editable blocks.
All 158 visible characters have unique owners; 28 residual characters become
one editable approximated repair, with 14 explicit boundaries, 12 inferred
boundaries, zero unresolved boundaries, zero duplicate attempts, zero residual
reported characters, and no fallback.

The negative independent tagged fixture retains page fallback: all 160 visible
characters have deterministic owners, 73 remain explicitly reported until the
page image is attached, no geometry repair is accepted, no duplicate attempt
occurs, and normalized fallback area is `1`. A synthetic two-region probe
proves that distant localized regions remain two repairs rather than becoming
one oversized crop.

### Verification

```text
bun run test packages/import-pdf/src/hybrid.test.ts \
  packages/import-pdf/src/fallback-policy.test.ts \
  packages/import-pdf/src/visual-fallbacks.test.ts \
  packages/import-pdf/src/review-v2.test.ts \
  packages/import-pdf/src/tagged.test.ts \
  packages/import-pdf/src/split.test.ts \
  apps/cli/src/commands/wiki-import-pdf.test.ts
38 pass
0 fail
250 expect() calls
```

```text
bun run test packages/import-pdf \
  apps/cli/src/commands/wiki-import-pdf.test.ts \
  apps/cli/src/commands/wiki-import-pdf-publication.test.ts
118 pass
0 fail
1052 expect() calls
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke.ts
tarball consumer smoke PASS
DOCX smoke PASS
PDF smoke PASS
```

```text
bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
DOCX browser smoke PASS
PDF browser smoke PASS
```

```text
bun run --cwd apps/browser-export-harness test:e2e
6 pass
0 fail
```

The packed consumer tests required temporary-directory access and the browser
E2E required a local loopback port outside the sandbox. Only existing neutral,
repository-owned fixtures were used. No customer PDF, derived private content,
tenant identifier, live URL, or new PDF file was read, generated, recorded, or
staged.

### Task gate

- [x] `auto` repairs localized tagged residue without duplicating tagged text.
- [x] Explicit tags and geometry modes retain their distinct routing.
- [x] Every visible character has one final owner; conflicting attempts are
      counted and publication fails closed.
- [x] Localized repair, region fallback, and page fallback remain distinct.
- [x] Fallback attachment closes the covered report and ownership outcome.
- [x] Semantic, issue, split, and plan digests repeat identically.
- [x] Split planning assigns every source page exactly once.
- [x] Full importer, CLI, typecheck, build, API, packed consumer, and browser
      gates pass.
- [x] No customer PDF or customer-derived artifact entered Git or evidence.

## PIQ-04 production cutover

PIQ-04 is complete. The tagged and geometry lanes proven in the preceding
checkpoints now flow through one additive V2 production review contract.

### Atomic V2 route

- the CLI production command uses the V2 PDFium facts adapter and
  `buildPdfImportReviewV2`; the existing V1 adapter, normalizers, review
  builder, schemas, and digest meanings remain exported unchanged;
- review schema `atlcli.pdf-import-review/2` binds the V2 facts digest,
  tagged/geometry policy revision, text-assembly policy revision, semantic
  evidence, boundary decisions, transformations, fallbacks, overrides, split
  result, and blockers into the semantic and plan digests;
- figure semantics have an additive `/2` schema. Tagged captions use the same
  V2 assembly segments as published text, and new figure evidence remains a
  valid V2 record without fabricating boundary ownership;
- visual fallback materialization preserves V2 evidence, while fallback
  assessment and split planning accept both versioned contracts without
  changing their existing V1 policy meanings;
- JSON and terminal previews expose only body-free boundary totals,
  unresolved counts, and transformation totals. They do not include boundary
  source text;
- the public API report exposes explicit V1 and V2 overloads. The reachable
  closure contains no private type gaps.

The exact neutral Word producer review emits review schema `/2`, the expected
heading, paragraphs, logical RTL, CJK, ordered list, and native two-column
table. It reports 48 boundary decisions, zero unresolved boundaries, no
fallback, and no publication blocker.

### Verification

```text
bun run test packages/import-pdf/src/review-v2.test.ts \
  packages/import-pdf/src/figures.test.ts \
  packages/import-pdf/src/visual-fallbacks.test.ts \
  apps/cli/src/commands/wiki-import-pdf.test.ts
21 pass
0 fail
151 expect() calls
```

```text
bun run test packages/import-pdf/src apps/cli/src/commands/wiki-import-pdf.test.ts
102 pass
0 fail
976 expect() calls
```

```text
bun --conditions=development run --cwd apps/cli src/index.ts wiki import \
  ../../specs/pdf-import-quality/fixtures/producer-word.pdf \
  --space DOCSY --json
review schema /2
48 boundary decisions
0 unresolved boundaries
1 native table
0 fallbacks
0 blockers
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke.ts
tarball consumer smoke PASS
DOCX smoke PASS
PDF smoke PASS
skipLibCheck:false consumer typecheck PASS
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

The tarball consumer required temporary-directory access and the browser E2E
required a local loopback port outside the sandbox. No external service,
customer PDF, customer-derived artifact, tenant identifier, or live URL was
used or recorded.

### Task gate

- [x] Production facts, semantic review, policy revisions, and dependent
      digests move together to V2.
- [x] Tagged, geometry, link, list, and table text use the shared assembler.
- [x] Figures and visual fallbacks retain valid V2 evidence.
- [x] Boundary metrics are body-free in JSON and terminal previews.
- [x] Existing V1 entry points retain their versioned behavior.
- [x] Full importer, CLI, build, typecheck, API, packed consumer, and browser
      gates pass.
- [x] No customer or tenant-derived material entered Git or evidence output.

## PIQ-04 geometry-lane checkpoint

This is a proven intermediate checkpoint, not completion of PIQ-04. The
tagged and geometry V2 lanes are now independently proven; the atomic
production cutover remains open.

### Geometry V2 routing

- V2 geometry first clusters characters into physical lines, then assembles
  every fragment, paragraph continuation, list item, and untagged table cell
  through the shared text-boundary engine;
- paragraph lines join only with adjacent physical-line, column, font, indent,
  punctuation, lowercase-continuation, and vertical-gap evidence;
- generated line breaks and hyphens remain in the assembly input, so every
  join, dehyphenation, hard-hyphen retention, and synthesized space has a
  stable boundary decision;
- RTL normalization covers both whole-line reverse-order output and producer
  output whose words require independent geometric reversal. RTL-only
  alignment does not create a false extra column;
- untagged tables accept either stroked paths or thin painted path segments,
  but only when interval coverage proves every grid line complete. Alignment
  without that proof remains non-native;
- when a producer reports no usable font size, repeated occurrences of the
  same glyph provide a document-local scale calibration. Script-specific
  glyph dimensions without cross-fragment evidence remain body text;
- boundary decisions, transformations, exact character indexes, confidence,
  and outcomes are bound into the `/2` untagged semantic digest;
- V1 normalization and the production review route remain unchanged until the
  remaining PIQ-04 cutover can happen atomically.

The independent fragmented geometry fixture produces ten exact editable
blocks with one qualified physical-line join, punctuation attachment, hard
hyphen retention, logical RTL, CJK without invented space, a ligature
expansion, and a safe link. It accounts for all 281 eligible characters with
33 boundary decisions and zero unresolved boundaries.

The pinned neutral Word producer now produces the exact heading, paragraphs,
logical RTL, CJK, ordered list, and native two-column table. It accounts for
all 352 eligible characters with 48 boundary decisions, one qualified column,
zero unresolved boundaries, and no fallback. A deliberately unresolved
geometry boundary still removes the page from native output with a body-free
issue.

### Verification

```text
bun run test packages/import-pdf/src/text-assembly.test.ts \
  packages/import-pdf/src/untagged.test.ts \
  packages/import-pdf/src/tables.test.ts \
  packages/import-pdf/src/fixtures.test.ts
32 pass
0 fail
381 expect() calls
```

```text
bun run test packages/import-pdf
92 pass
0 fail
895 expect() calls
```

```text
bun run build
34 successful tasks
0 failed tasks
```

```text
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun run test scripts/api-report.test.ts
5 pass
0 fail
14 expect() calls
```

```text
bun scripts/consumer-smoke-vite.ts
Vite 8.1.4 tarball consumer PASS
V2 untagged semantic schema, digest, geometry-native page outcome, and 51
boundary decisions loaded from built browser package output
```

```text
bun run test:browser-export-harness
6 pass
0 fail
```

```text
bun run typecheck
4 successful tasks
0 failed tasks
```

The tarball smoke required temporary-directory access and the browser E2E
required a local loopback port outside the sandbox. No external service or
private input was used.

### Checkpoint gate

- [x] Geometry fragments, paragraph continuations, lists, links, and untagged
      table cells use one V2 assembler without changing the V1 production path.
- [x] Exact ADF and Storage text plus neutral boundary evidence pass.
- [x] The independent fixture and three producer families preserve logical
      text; the previously failing Word producer is native without fallback.
- [x] Incomplete geometry and unresolved text boundaries fail closed.
- [x] Full importer, build, typecheck, API, packed consumer, and browser gates
      pass.
- [x] No customer PDF or customer-derived artifact was read, staged, or
      written.

## Heading verification, split rows, OCR layers, table model (2026-10-21)

Headings on the private untagged corpus were checked against the documents'
own section numbers (body-free counts only, local, not recorded here):
numbered headings of one depth landed on up to four levels, deeper styles
fell past level six, and tables of contents were read as headings with their
page numbers as headings of their own.

- **Set font size from the text matrix.** `FPDFText_GetFontSize` is the `Tf`
  operand; Word's one-point fonts carry their size in the text matrix. The
  adapter multiplies by the matrix's vertical scale, so sizes are exact and the
  glyph-height estimate only applies when none is reported. Adapter V2 `/5`.
- **Bold from the font name for any non-bold weight.** LibreOffice reports 400
  for bold fonts, not 0; the name now decides whenever the weight is below 600.
- **One level per style.** A size together with bold or regular is a style; at
  one size bold ranks above regular. Neutral evidence: `libreoffice-contents.pdf`
  sets `1` and `1.1` headings both in 12 pt, bold and regular.
- **Tables of contents.** A line ending in a right-hand page number whose text
  stands again on a later page proves a contents line; three with
  non-decreasing numbers prove a table of contents. Its lines become
  paragraphs and its page numbers are suppressed with evidence. A numbered
  column elsewhere repeats no later text and stays.
- **Numbering check.** Headings whose level disagrees with the majority level
  of their numbering depth, or sits no deeper than a shallower depth, are
  reported as `pdf-import/heading-numbering-mismatch`. After the changes the
  corpus reports none; depth 1 and depth 2 each hold one level. Geometry policy
  V2 `/10`.
- **Split rows joined by text.** The rest of a row split by a break, with the
  frame drawn across, is joined when it fills only cells the row before fills
  and each of its cells continues a cell that stops mid-sentence or starts in
  lowercase (`pdf-import/table-row-split-joined`). LibreOffice's export of the
  neutral clause table splits mid-sentence and joins; Word's splits between
  sentences and stays reported. On the corpus every reported split row joined.
  Table policy V2 `/10`.
- **OCR layers.** Text in render mode 3 is recorded as `invisible`. A page image
  of a scan gets its OCR layer as a collapsed, unverified section after its
  caption (`pdf-import/ocr-text-attached`); the scan itself stays a page image.
- **Table model measured.** On the untagged corpus the Table Transformer had one
  candidate region in all documents and its proposal did not fit the
  characters; the geometric tables were identical with and without it, at about
  0.1 s extra per document. It stays opt-in.

Not covered: a Word export of `contents.docx` is missing because Word's
sandbox asked for file access, which was not granted unattended.

## Wrapped contents entries, split rows in dense tables (2026-10-22)

- **Contents entries.** On a page proven as a table of contents, an entry
  wrapped onto up to three lines is proven by its joined lines above the page
  number, and an unnumbered line between the first and last entry whose text
  stands on a later page is an entry. Both become paragraphs, not headings.
  Unit-tested with synthetic pages (`contents.test.ts`); no new export.
- **Split rows in dense tables.** The rest of a split row that starts a new
  sentence is joined when it is the only row of the table with blank cells and
  at least five filled body rows prove the table leaves none blank
  (`pdf-import/table-row-split-joined`). Word's export of the neutral clause
  table now joins like LibreOffice's. A table that leaves other cells blank
  still reports `pdf-import/table-row-split-unproven`. Table policy V2 `/11`.
