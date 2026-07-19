# 003 — Content features & scroll-* compatibility macros

Status: Plan. Covers UMSETZUNGSPLAN Lane C (T1.4–T1.6) and BASELINE-DESIGN §3
cluster C-content (C1–C9). Compatibility-critical work (C4/C5/C6) lands first,
then C3 captions and table hardening; C1/C2/C7/C8/C9 are scoped as follow-up
work packages at the end of this plan.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane C tasks T1.4 (walker learns
  `scroll-*` macros), T1.5 (engine rendering), T1.6 (table hardening); depends
  on sync point 0 (T0.1 block-model extension, T0.2 compiling no-op renderings).
- `specs/export-expansion/BASELINE-DESIGN.md` §3 "Cluster C-content" — design
  sketches for C1–C9, the shared `ExportBlock` extension, and the `walkMacro`
  patch; recommended order C4+C5 → C3 → C2 → C6–C9 → C1.
- Code seams (verified on branch `export-expansion`):
  - `packages/confluence/src/export-blocks.ts` — `walkMacro()` (line 667),
    `isInlineMacro()` (line 397, currently `status`-only), `storageToBlocks()`
    (line 330, currently takes no options), `WalkCtx` (line 278), `macroParam()`
    (line 458), `ExportBlock` union (line 102), `ExportNote` (line 116).
  - `packages/docx/src/serialize.ts` — `serializeBlock()` (line 338) with
    exhaustive `never` check (line 435); `unknown` placeholder rendering
    (line 432). `packages/docx/src/ooxml.ts` — `resolveHeadingStyleId` (line 46),
    `codeStyleXml` (line 61), `hyperlinkField` (line 166), `statusBadgeRun`
    (line 261), `escapeFieldArgument` (line 157).
    `packages/docx/src/export.ts` — `injectContentTagAtEnd` (line 845, already
    locates the body-level `sectPr`), `preprocessScrollText` (line 298/876),
    `ensureUpdateFields` (line 309), `toDownloadFilename` (line 187).
  - `packages/pdf/src/serialize.ts` — `serializeBlock()` (line 639) with
    exhaustive check (line 806); `#figure(image(...))` emission (lines 678,
    691) and the source-order comment (line 675, no `placement: auto`);
    `table.header(...)` emission (line 786); `resolveLink` (line 227);
    `collectHeadingLabels` (line 488); `CONFLUENCE_STATUS_COLORS` (line 263).
    `packages/pdf/src/template.ts` — `set page(paper: "a4", ...)` (line 70),
    header/footer closures (lines 74–88), `#meta.title` on the cover
    (line 123), `status-badge` (line 202), `dense-status-badge` (line 238).
    `packages/pdf/src/prepare.ts` — passthrough arm (`case "divider"` group,
    line 272). `packages/pdf/src/types.ts` — `PreparedPdfBlock` (line 36),
    `PdfThemeOptions` (line 79), `PdfSerializeOptions` (line 115).

## Goal & user value

Teams migrating existing wiki content into atlcli exports carry hundreds of
pages that use `scroll-*` compatibility macros. Today those macros render as
`[scroll-ignore macro not rendered]` placeholders in DOCX
(`packages/docx/src/serialize.ts:432`) or are omitted with a
`pdf-unknown-block` warning in PDF (`packages/pdf/src/serialize.ts:796-804`).
This plan makes the export honor them, in dependency order of value:

1. **C4 `scroll-only` / `scroll-ignore` (+ inline variants)** — "one source for
   web and print": internal material disappears from exports, print-only
   material appears, per-exporter selectable. Compatibility-critical; no engine
   change needed.
2. **C5 `scroll-pagebreak`** — manual page breaks, the most used print control.
3. **C6 `scroll-landscape` / `scroll-portrait`** — orientation regions for wide
   tables and diagrams (today A4 portrait is hard-wired in both engines).
4. **C3 `scroll-title` → captions** — "Figure 3: Architecture overview" via
   native numbering (Word SEQ fields, Typst figure counters); prerequisite for
   the list-of-figures/tables follow-up (C2).
5. **Table hardening (T1.6)** — verify repeating header rows in Typst on page
   breaks, add a 200-row golden, define an overflow strategy for wide tables.
6. **Follow-ups C2, C1, C7, C8, C9** — lists of tables/figures, label-based
   index, named destinations/bookmarks, status-badge theming, page-title
   override.

Every applied macro produces an `ExportNote` in the report so "why is section X
missing?" is never a mystery. All work is host-agnostic: CLI, extension, and
further hosts consume it purely through `storageToBlocks → engine`.

## Dependencies (001)

- **001 (block model & no-op renderings, T0.1/T0.2)** must be merged first:
  the `ExportBlock` extension (`caption?`, `pageBreak`, `orientation`,
  `anchor`, enriched `unknown`, `StorageToBlocksOptions.exporter`) lands in a
  single PR in `packages/confluence/src/export-blocks.ts`, plus compiling
  no-op renderings in `packages/docx/src/serialize.ts` and
  `packages/pdf/src/serialize.ts`. The exhaustive `never` switches in both
  serializers (docx line 435, pdf line 806) then act as the to-do list for this
  plan's engine tasks. If 001 has not landed when this plan starts, its model
  changes are pulled forward into the first walker task below (same file, same
  owner — Lane C owns `export-blocks.ts` for the T1.4 landing slot after T1.1).
- **Ordering inside the hot file:** per UMSETZUNGSPLAN, `export-blocks.ts` has
  three ordered landings T1.1 → T1.4 → T1.8; this plan is the T1.4 slot.
- **Prerequisite before any implementation: real storage fixtures.** Capture
  the actual storage XML of `scroll-only`, `scroll-ignore`,
  `scroll-only-inline`, `scroll-ignore-inline`, `scroll-pagebreak`,
  `scroll-landscape`, `scroll-portrait`, `scroll-title` (and for follow-ups
  `scroll-bookmark`, `scroll-pagetitle`) from a live instance with existing
  content. Reliable public documentation of the macro names, parameter keys
  (especially the `exporter` selector) and body wrapping is hard to access —
  the fixture set is the source of truth, and every macro name/parameter
  assumption in this plan must be re-verified against it before coding.
- Follow-up C1 additionally depends on tree export (Lane A, plan 00x) to be
  useful; C2 depends on C3.

## Architecture (isomorphic)

- **Semantics live in the walker, not the engines.** `scroll-only`/
  `scroll-ignore` filtering is a content decision made once in
  `storageToBlocks()`; a dedicated "exportControl" block that both engines
  filter was rejected — the engines would duplicate identical filter code for a
  block that never renders (BASELINE-DESIGN C4b).
- **Presentation lives in blocks the engines render natively.** `pageBreak`,
  `orientation` (region block with children — OOXML can only switch
  orientation per section, and the macro semantics are a region), `anchor`, and
  `caption?` fields on `image`/`table`/`codeBlock` (not a wrapper block, so
  serializers keep their structure and numbering is done by the target format:
  Typst counters, Word SEQ fields — never hard-numbered).
- **Exporter sensitivity** flows through `StorageToBlocksOptions.exporter`
  (`"pdf" | "word"`, default: apply both macros unconditionally) into
  `WalkCtx`; hosts pass `{ exporter: "word" }` / `{ exporter: "pdf" }` from
  their export entry points. Everything stays isomorphic: no DOM, no Node
  APIs, so CLI, extension, and further hosts share the exact code path.
- **Report-first UX:** every macro application and every fallback emits an
  `ExportNote` (existing pattern, `export-blocks.ts:116`); a host option to
  disable export-control macros (e.g. CLI `--keep-ignored`) is progressive
  disclosure for debugging and is scoped as an optional task.

## Tasks

### Walker (@atlcli/confluence)

- [ ] Capture the storage-fixture set: create a page in a live instance
      containing all `scroll-*` macros above, fetch `body.storage` via
      `atlcli wiki page get`, and check the raw XML fragments into
      `packages/confluence/src/export-blocks.test.ts` (inline fixtures,
      consistent with the existing `FIXTURE` style at line 424). Record the
      verified macro names, parameter keys (`exporter` selector value set!) and
      body wrapping as comments next to each fixture.
- [ ] If 001 has not landed: extend `ExportBlock` in
      `packages/confluence/src/export-blocks.ts` with `caption?: Caption` on
      `codeBlock`/`table`/`image`, and new variants `pageBreak`,
      `orientation { landscape, content }`, `anchor { name }`; add
      `CaptionKind`/`Caption` types and `StorageToBlocksOptions` with
      `exporter?: "pdf" | "word"`; re-export new types from
      `packages/confluence/src/index.ts` and `index.browser.ts`.
- [ ] Thread options into the walk: `storageToBlocks(storage, options?)`
      (`export-blocks.ts:330`) stores `exporter` on `WalkCtx`
      (`export-blocks.ts:278`).
- [ ] C4 in `walkMacro()` (`export-blocks.ts:667`, before the KNOWN_MACROS
      fallback): `scroll-ignore` → `[]` + info note `scroll-ignore-applied`;
      `scroll-only` → walk the `ac:rich-text-body` children transparently.
      Honor the macro's `exporter` parameter: apply only on match with
      `ctx.exporter`, apply always when the parameter or option is absent;
      unknown `exporter` values fail safe (include + warning note), never drop
      silently.
- [ ] C4 inline variants: extend `isInlineMacro()` (`export-blocks.ts:397`)
      to also return true for `scroll-only-inline`/`scroll-ignore-inline`, and
      handle them in `walkInlineElement` (ignore-inline → `[]` + note,
      only-inline → inline content of its body), same exporter gate.
- [ ] C5 in `walkMacro()`: `scroll-pagebreak` → `[{ type: "pageBreak" }]`.
- [ ] C6 in `walkMacro()`: `scroll-landscape`/`scroll-portrait` →
      `{ type: "orientation", landscape, content: walkBlocks(body) }`; nested
      orientation regions: outer wins + warning note.
- [ ] C3 in `walkMacro()`: `scroll-title` → build
      `Caption { kind: param "type" (default "figure"), content }` and attach
      via new helper `attachCaption(inner, caption, ctx)` to the first
      caption-capable block (`image`/`table`/`codeBlock`) produced by the macro
      body; fallback when no such block exists: italic paragraph + info note.
      Verify against the fixture whether the captioned element is body-wrapped
      or adjacent, and support the verified shape.
- [ ] Wire hosts: pass `{ exporter: "word" }` from the DOCX export path and
      `{ exporter: "pdf" }` from the PDF export path at the
      `storageToBlocks` call sites in `apps/cli/src/commands/export.ts`
      (ts-engine route, line ~750) and the extension's export entry
      (`apps/extension`, same `storageToBlocks → engine` seam); further hosts
      pick the value up through the same options object.
- [ ] Optional (progressive disclosure): CLI flag `--keep-ignored` in
      `apps/cli/src/commands/export.ts` that omits the `exporter`
      option/disables C4 filtering for debugging, documented in the command
      help.

### DOCX rendering

- [ ] C5: add `pageBreakParagraph()` to `packages/docx/src/ooxml.ts`
      (`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`) and a
      `case "pageBreak"` in `serializeBlock()`
      (`packages/docx/src/serialize.ts:338`). Inside table cells, suppress the
      break and emit an info note instead (breaks inside `<w:tc>` paragraphs
      would split the table row, not the page).
- [ ] C6: extract a `readBodySectPr(zip)` helper from the body-`sectPr`
      location logic in `injectContentTagAtEnd()`
      (`packages/docx/src/export.ts:845-851`) and pass the clone through
      `SerializeContext`. Render `orientation` as a section sandwich: a
      paragraph carrying the cloned portrait `sectPr` BEFORE the region
      content (a `sectPr` inside a paragraph closes the preceding section),
      then the children, then a paragraph with the clone modified to
      `<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>` +
      `<w:type w:val="nextPage"/>` (swap w/h, keep margins,
      keep `headerReference`/`footerReference`). Fallback when the template
      has no body `sectPr`: synthesize a standard A4 `sectPr`.
- [ ] C3: add a caption-paragraph helper to `packages/docx/src/ooxml.ts` that
      emits `<w:pPr><w:pStyle w:val="Caption"/></w:pPr>` plus a SEQ field
      (`fldChar begin` / `instrText " SEQ <label> \* ARABIC "` / `fldChar
      end`) and the caption text. Resolve the `Caption` style id via the
      `parseStyleNames` map with a fallback like `resolveHeadingStyleId`
      (`ooxml.ts:46`); synthesize the style analogous to `codeStyleXml()`
      (`ooxml.ts:61`) when the template lacks it. Introduce
      `captionSeqLabel(kind, lang)` in `ooxml.ts` (en: Figure/Table/Listing,
      de: Abbildung/Tabelle/Listing) — shared later by C2's `TOC \c` fields.
- [ ] C3: emit the caption paragraph from `serializeBlock()` next to
      `image`/`table`/`codeBlock` blocks that carry `caption` (position:
      above tables, below figures/code — the established convention). Numbers
      refresh on open because `ensureUpdateFields` already runs
      (`packages/docx/src/export.ts:309`).
- [ ] Replace the C4/C5/C6/C3 placeholder path: the affected `scroll-*`
      macros must no longer reach the `unknown` arm
      (`packages/docx/src/serialize.ts:431-432`).

### PDF rendering

- [ ] C5: `case "pageBreak"` in `serializeBlock()`
      (`packages/pdf/src/serialize.ts:639`) → `#pagebreak(weak: true)`
      (`weak` avoids blank pages at natural boundaries). Add the block to the
      passthrough arm in `packages/pdf/src/prepare.ts` (the
      `case "divider":` group at line 272) and to `PreparedPdfBlock`
      (`packages/pdf/src/types.ts:36`). Suppress + info note inside table
      cells (`context` already distinguishes cell serialization).
- [ ] C6: `case "orientation"` → a scoped block
      `#[ #set page(flipped: true) ...children... ]`; Typst set rules are
      block-scoped and page breaks at the region boundaries happen
      automatically. Verify in the golden that the header/footer closures from
      `atlcli-doc` (`packages/pdf/src/template.ts:74-88`) stay active —
      `set page(flipped: true)` must not reset the other page properties.
- [ ] C3: extend the existing `#figure(image(...))` emissions
      (`packages/pdf/src/serialize.ts:678,691`) with
      `caption: [...]` and `kind: image`; wrap captioned tables as
      `#figure(table(...), caption: [...], kind: table)` and captioned code as
      `#figure(raw(..., block: true), caption: [...], kind: raw)`. Only
      captioned code blocks become figures — caption-less ones keep today's
      rendering (prevents C2's `kind: raw` outline from listing every code
      block). Respect the source-order rule at `serialize.ts:675`: no
      `placement: auto`.
- [ ] C3: propagate `caption` through `preparePdfDocument()`
      (`packages/pdf/src/prepare.ts:159`) onto `PreparedPdfBlock`
      (`packages/pdf/src/types.ts:36`), including the `diagram` variant.
- [ ] T1.6 table hardening: verify that the emitted
      `table.header(...)` (`packages/pdf/src/serialize.ts:786`) repeats on
      every page (Typst default is `repeat: true`; make it explicit —
      `table.header(repeat: true, ...)` — so the golden pins the behavior) and
      add a 200-row table golden that compiles and paginates.
- [ ] T1.6 wide-table overflow strategy: define and implement the fallback for
      tables wider than the text area — order of escalation: shrink inset
      (dense mode exists, `serialize.ts:789`), then scale text, then emit a
      warning note recommending an orientation region (C6 gives users the
      manual fix). Document the chosen strategy in the report note text.

### Follow-up packages C1/C2/C7–C9

- [ ] C2 (PDF, cheap after C3): add
      `lists?: { tables?: boolean; figures?: boolean; code?: boolean }` to
      `PdfSerializeOptions` (`packages/pdf/src/types.ts:115`); default: a list
      switches on automatically when ≥2 captions of that kind exist
      (zero-config, named in the report). Emit
      `#outline(target: figure.where(kind: image|table|raw), title: ...)`
      after the contents outline in `atlcli-doc`
      (`packages/pdf/src/template.ts`).
- [ ] C2 (DOCX): new placeholders `$scroll.figurelist`/`$scroll.tablelist` in
      `packages/docx/src/placeholder-map.ts`; `preprocessScrollText`
      (`packages/docx/src/export.ts:298`) replaces the placeholder paragraph
      with a `TOC \h \z \c "<captionSeqLabel>"` field. Template-authored
      table-of-figures fields already refresh via `ensureUpdateFields`.
- [ ] C7 anchors: walker emits `anchor` blocks for `scroll-bookmark`
      (params `name`/`id` — fixture-verify) AND the native `anchor` macro
      (today a placeholder). PDF: `case "anchor"` →
      `#[]#label(...)` via `typstLabel` (`packages/pdf/src/escape.ts`), and an
      anchor collection pass alongside `collectHeadingLabels`
      (`packages/pdf/src/serialize.ts:488`) feeding `resolveLink`
      (`serialize.ts:227`). DOCX: `bookmarkStart`/`bookmarkEnd` helper in
      `packages/docx/src/ooxml.ts` with a document-wide id counter in
      `SerializeContext`, plus a `HYPERLINK \l` variant of `hyperlinkField`
      (`ooxml.ts:166`, reusing `escapeFieldArgument`); shared, tested
      `bookmarkName()` normalizer (≤40 chars, letter first, `\W` → `_`).
      Anchor-vs-heading-label collisions resolve deterministically (anchor
      wins + note). True PDF named destinations are stage 2 (Typst does not
      emit them yet — post-processing or upstream).
- [ ] C8 status styling: add `status?: { font?, size?, weight?, radius?,
      uppercase?, palette? }` to `PdfThemeOptions`
      (`packages/pdf/src/types.ts:79`), fill defaults in
      `packages/pdf/src/theme.ts`, interpolate into `status-badge`/
      `dense-status-badge` (`packages/pdf/src/template.ts:202,238`), and merge
      (not replace) `theme.status.palette` over `CONFLUENCE_STATUS_COLORS`
      (`packages/pdf/src/serialize.ts:263`). Run palette values through the
      existing contrast warning (`noteLowCellContrast` pattern,
      `serialize.ts:544`). DOCX (`statusBadgeRun`, `ooxml.ts:261`) follows
      later with a DOCX theme option — PDF side first.
- [ ] C9 title override: walker recognizes `scroll-pagetitle` (macro → `[]` +
      note `scroll-pagetitle-applied`, value surfaced as
      `StorageToBlocksResult.titleOverride?`); shared helper
      `resolveExportTitle(details, explicit?)` in `packages/confluence` with
      precedence explicit host override (CLI `--title` / panel field) >
      content property `atlcli.export.title` > `scroll-pagetitle` macro > page
      title, returning the chosen source for the report note. Hosts set
      `details.title`/`metadata.title` before `exportDocx`/
      `serializePdfDocument`; filename follows via `toDownloadFilename`
      (`packages/docx/src/export.ts:187`).
- [ ] C1 label index (after tree export lands): `parseIndexTerms(labels)`
      (slash-split) in `packages/confluence`, new `indexMarker` block emitted
      by the orchestrator (labels are page metadata, not walker territory);
      PDF `#metadata(...) <atlcli-idx>` markers + a query-based index section
      in `atlcli-doc` (self-implemented, no remote packages); DOCX `XE` fields
      + `INDEX` field behind a `$scroll.index` placeholder (same route as C2).
      Only labels with a configured prefix (e.g. `idx-` or containing `/`)
      become index terms; preflight report lists recognized terms.

### Tests (no mocking)

Hard rule: NEVER mock. Unit tests run real storage XML through the real
walker; golden tests run the real serializers; E2E runs the real CLI against a
real instance.

- [ ] Walker unit tests in `packages/confluence/src/export-blocks.test.ts`
      using the captured real storage fixtures: scroll-only kept /
      scroll-ignore dropped (+ note), exporter parameter match/mismatch/absent
      /unknown-value (fail-safe include + warn), inline variants, pagebreak
      block, orientation nesting (outer wins + note), scroll-title caption
      attachment incl. no-captionable-block fallback, and block-tree
      snapshots (existing snapshot style, line 452/511). These are regression
      tests: each asserts the exact behavior that the placeholder path used to
      produce is gone.
- [ ] DOCX golden/serializer tests in `packages/docx/src/serialize.test.ts`
      and `packages/docx/src/golden.test.ts`: `pageBreak` emits
      `<w:br w:type="page"/>`; orientation region emits two `sectPr`
      paragraphs with landscape `pgSz` (w/h swapped) and preserved
      header/footer references; caption paragraph carries `pStyle Caption` +
      correct SEQ label; feature-zoo golden extended with the fixture macros
      so the full pipeline stays byte-stable.
- [ ] PDF golden/serializer tests in `packages/pdf/src/serialize.test.ts`
      (+ `prepare.test.ts` for the passthrough/caption propagation):
      `#pagebreak(weak: true)`, `#set page(flipped: true)` region,
      `figure(..., caption: ..., kind: ...)` for image/table/raw, explicit
      `table.header(repeat: true, ...)`, 200-row table golden, wide-table
      overflow note; source-map paths (`writeMapped`) stay consistent.
- [ ] Compile-level verification: run the compiled Typst output of the new
      goldens through the real compiler path used by
      `packages/pdf/src/run-export.test.ts` to prove the emitted markup is
      valid (page count increases across a `pagebreak`, landscape page
      dimensions in the produced PDF).
- [ ] E2E against space `DOCSY`, profile `mayflower` (per workflow rules):
      1. Verify the insertion route: `atlcli wiki page create`/`update`
         convert markdown to storage
         (`apps/cli/src/commands/page.ts:301,365`), so confirm scroll-* macros
         can be inserted via a storage-format REST update through the CLI/page
         tooling — e.g. a small script using `ConfluenceClient.createPage/
         updatePage` (`packages/confluence/src/client.ts`) with the raw
         storage fixture as body; if the markdown route round-trips the macros
         via the base64 macro passthrough, that is acceptable too. Document
         the working route in the test.
      2. Create a test page containing scroll-only, scroll-ignore,
         scroll-pagebreak, and scroll-title macros.
      3. Export it as DOCX and PDF via the CLI (`atlcli wiki export ... --engine
         ts` and the PDF route from plan T3.2 once available; until then, the
         package-level export against the live page body).
      4. Assert: scroll-only content present, scroll-ignore content absent
         (and named in the report), a page break at the marker (PDF page
         count / DOCX `w:br` present), caption text attached.
      5. Clean up: delete the test page (workflow rule).
- [ ] Run `bun run typecheck` and the full `bun test` before commit; both
      engines' exhaustive switches must compile with no remaining `never`
      gaps for the new block variants.

## Definition of Done

- Real storage fixtures for all in-scope `scroll-*` macros are checked in,
  with verified macro names and parameter keys.
- C4/C5/C6/C3 walker behavior implemented behind
  `StorageToBlocksOptions.exporter`; hosts (CLI, extension, further hosts)
  pass their exporter identity; every application produces a report note.
- Both engines render `pageBreak`, `orientation`, and captions natively
  (DOCX: `w:br type="page"`, section sandwich with cloned `sectPr`, SEQ-field
  captions; PDF: `pagebreak(weak: true)`, `set page(flipped: true)` region,
  `figure(caption:, kind:)`); no in-scope macro reaches the
  `unknown`-placeholder arms anymore.
- `table.header(repeat: true)` pinned by a 200-row golden; wide-table
  overflow strategy implemented and reported.
- All tests above green without mocks; goldens byte-stable; typecheck clean;
  E2E performed on `DOCSY`/`mayflower` with cleanup.
- Follow-up packages C1/C2/C7–C9 remain as unchecked tasks with their design
  anchored here (not required for this plan's merge, but the model/API choices
  made here must not block them).
- `docs/` updated with a feature guide for export-control macros, page breaks,
  orientation regions, and captions, including a compatibility matrix of
  supported `scroll-*` macros (docs are first-class; same PR as the behavior
  change).

## Risks & open questions

- **Macro vocabulary unverified (top risk):** exact names/values of the
  `exporter` selection parameter, the inline variant names, and the
  `scroll-title` body shape (wrapping vs. adjacency) are assumptions until the
  live fixtures are captured. Mitigation: fixture capture is the first task;
  fail-safe behavior (include + warn) for anything unrecognized.
- **DOCX section sandwich:** templates without a body `sectPr` (synthesize A4
  fallback), margin handling when swapping w/h, and faithful
  `headerReference`/`footerReference` cloning are the labor-intensive part of
  C6; validate with LibreOffice and Word.
- **Caption conventions:** position (above tables vs. below figures) and
  SEQ-label language are convention decisions — defaults chosen here, template
  option later. Word SEQ numbers only refresh on open/print preview; we rely on
  `ensureUpdateFields`.
- **Typst named destinations (C7):** not emitted by Typst today; internal
  links + outline cover most of the value, true `/Names` injection is a
  post-processing stage 2 — track upstream.
- **C1 value gating:** a label index only becomes useful with tree export;
  keep it sequenced after Lane A and behind a label-prefix filter so process
  labels never pollute the index.
- Open: exact behavior of `pageBreak` inside callouts (suppress + note like
  table cells, or honor?); whether `--keep-ignored` ships in this plan or with
  the report/DX work (T3.4); property-key namespace for the C9 content
  property (`atlcli.export.title`) needs a one-time decision consistent with
  the planned space-property index.
