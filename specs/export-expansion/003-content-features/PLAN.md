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
- `specs/export-expansion/011-quality-gates/PLAN.md` — cross-cutting quality
  infrastructure (T4.3–T4.9) that is NOT part of this plan's scope but shares
  two surfaces with it: a Confluence storage-parse budget and a link-scheme
  policy that both touch `export-blocks.ts`'s walker and land "coordinated
  with whichever of 001/003/004 is landing at the time" (011's own wording);
  and the `ExportNote.source` provenance contract (see Dependencies and Risks
  below for the concrete coordination points).
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
- **Cross-plan hot-file coordination with 011:** 011-quality-gates plans a
  Confluence storage-parse budget (node-count/nesting-depth/expanded-text
  limits on `parseXml` and the recursive `walkBlocks`/`walkInline`/
  `handleBlockElement` walkers) and a link-target scheme policy
  (`sanitizeLinkHref`, degrading `javascript:`/`data:`/`file:`/`vbscript:`
  hrefs to visible text + an `unsafe-link-skipped` note) for both
  serializers — both explicitly scoped by 011 as landing "coordinated with
  whichever of 001/003/004 is landing at the time," not as a solo 011 PR.
  These are 011's tasks, not this plan's; if either lands while this plan is
  in flight, rebase this plan's walker changes onto them rather than
  duplicating budget or scheme-check logic. If this plan lands first, keep
  the new recursive helpers (`walkMacro` macro-body recursion for
  `scroll-only`/`orientation` regions) structured so a budget check can wrap
  them later without restructuring — do not hand-roll a competing depth
  limit here.
- **Prerequisite before any implementation: real storage fixtures.** Capture
  the actual storage XML of `scroll-only`, `scroll-ignore`,
  `scroll-only-inline`, `scroll-ignore-inline`, `scroll-pagebreak`,
  `scroll-landscape`, `scroll-portrait`, `scroll-title` (and for follow-ups
  `scroll-bookmark`, `scroll-pagetitle`) from a live instance with existing
  content. Reliable public documentation of the macro names, parameter keys
  (especially the `exporter` selector) and body wrapping is hard to access —
  the fixture set is the source of truth, and every macro name/parameter
  assumption in this plan must be re-verified against it before coding.
- **C6 fixture gate (blocks the block-model freeze, not just coding):**
  BASELINE-DESIGN §3 and this plan's Architecture section currently assume
  `scroll-landscape`/`scroll-portrait` are body-wrapped macros
  (`ac:rich-text-body` → `{ type: "orientation", landscape, content }`).
  Third-party documentation of the same macro pair describes them instead as
  stateful markers that orient all following content up to a matching
  counter-macro, which would make the body-wrapped assumption produce empty
  regions or mis-orient everything after it on real content. Resolve this
  from the captured fixtures BEFORE the `orientation` block shape is treated
  as frozen — see the walker task below for both shapes and the
  marker-sequence normalization fallback.
- Follow-up C1 additionally depends on tree export (Lane A, plan 00x) to be
  useful; C2 depends on C3.
- **Exporter-identity wiring is split across two plans, not owned solely
  here.** 001-exportblock-model already plans the DOCX-side call-site fix as
  "pure plumbing" ahead of this plan's T1.4 behavior:
  `packages/docx/src/export.ts:235` becomes
  `storageToBlocks(input.details.storage ?? "", { exporter: "word" })` (see
  `specs/export-expansion/001-exportblock-model/PLAN.md`). This plan
  verifies that wiring lands correctly and owns the PDF-side wiring instead
  of re-planning the DOCX side — see the Walker "Wire hosts" task.
- **C9 optional dependency on 005-placeholders' D2 bridge:**
  `specs/export-expansion/005-placeholders/PLAN.md` sketches an *optional*
  `getContentProperty(pageId, key)` port on `ResolveDeps` (D2 bridge,
  explicitly scoped "optional scope", may not land). C9's title precedence
  needs the same capability; if D2 lands first, C9 reuses its port instead
  of building a second one — see the C9 follow-up task.

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
  Typst counters, Word SEQ fields — never hard-numbered). The
  `orientation { landscape, content }` shape is the working assumption for a
  body-wrapped macro; it is provisional until the C6 fixture gate (see
  Dependencies) confirms `scroll-landscape`/`scroll-portrait` actually wrap
  content rather than acting as paired open/close markers. If fixtures show
  the marker shape, the walker task below normalizes marker sequences into
  the same `orientation` block before this architecture changes, so engines
  keep consuming one shape either way.
- **Exporter sensitivity** flows through `StorageToBlocksOptions.exporter`
  (`"pdf" | "word"`, default: apply both macros unconditionally) into
  `WalkCtx`; hosts pass `{ exporter: "word" }` / `{ exporter: "pdf" }` from
  their export entry points. Everything stays isomorphic: no DOM, no Node
  APIs, so CLI, extension, and further hosts share the exact code path.
- **`exportControls` is an orthogonal axis from `exporter`, not the same
  option.** `exporter` answers "which target format is this?" and decides
  match/mismatch for the `scroll-only`/`scroll-ignore` `exporter` parameter.
  `StorageToBlocksOptions.exportControls?: "apply" | "passthrough"`
  (default `"apply"`) answers a different question — "should C4/C5/C6
  filtering run at all?" — independent of which exporter is active.
  `--keep-ignored` sets `"passthrough"`: both `scroll-only` and
  `scroll-ignore` bodies are kept (nothing dropped, `pageBreak`/`orientation`
  still render), and a stable note code (`export-controls-passthrough`)
  records that the export is not representative of a normal run. Without
  this split, omitting the `exporter` option (today's only lever) still
  leaves `scroll-ignore` unconditionally dropping its body whenever the
  macro carries no `exporter` parameter of its own — exactly the debugging
  case `--keep-ignored` is meant to unblock — so `exporter` alone cannot
  implement the flag.
- **C4 truth table (apply mode).** For each of `scroll-only`/`scroll-ignore`
  (and their inline variants), the `exporter` macro parameter is matched
  against `ctx.exporter`:

  | macro param  | ctx.exporter | scroll-only result       | scroll-ignore result   |
  |--------------|--------------|---------------------------|-------------------------|
  | absent       | any/absent   | keep body (walked)        | drop body (`[]`) + note |
  | match        | present      | keep body (walked)        | drop body (`[]`) + note |
  | mismatch     | present      | drop body (`[]`) + note   | keep body (walked) + note |
  | unknown value| any          | fail-safe: keep + warn    | fail-safe: keep + warn  |

  Mismatch is the case the previous draft left unstated: for the inverse
  macros, "does not apply" means the opposite action of the match case, not
  "no-op" — `scroll-only` with a non-matching `exporter` param must drop its
  body (it is declared exclusive to a different target), while
  `scroll-ignore` with a non-matching `exporter` param must keep its body
  (it is declared to ignore only that other target). Every branch, including
  mismatch, emits a note so the report always explains inclusion/exclusion.
- **Layout-control container context.** `pageBreak` and `orientation` are
  presentation blocks that can appear inside a table cell or a callout body
  (the walker does not restrict where `scroll-pagebreak`/`scroll-landscape`/
  `scroll-portrait` may be nested). Both DOCX (`<w:tc>`-based table cells and
  `calloutTable()`, `packages/docx/src/ooxml.ts:220-224`) and PDF table
  cells cannot host a section break or a Typst page-scoped `set page` inside
  their own layout without producing invalid or structurally broken output.
  Serializers thread an internal `container: "body" | "list" | "tableCell" |
  "calloutCell"` alongside existing depth/context tracking; a fixed matrix
  (see DOCX/PDF rendering tasks) decides per container whether the layout
  control renders, is suppressed with a note, or (never) silently dropped —
  suppression always keeps the block's children, only the layout side effect
  is skipped.
- **Caption kind is validated, not passed through.** `scroll-title`'s `type`
  parameter is free text from `macroParam()` (`export-blocks.ts:457-464`,
  no allow-list). A shared `normalizeCaptionKind(raw, targetBlockType)`
  contract (new, `packages/confluence/src/export-blocks.ts`) maps known
  values/aliases (case-insensitive) to a closed `CaptionKind` enum, falls
  back to the target block's natural kind with a warning note on unknown
  input, and resolves a declared-kind-vs-target-block-type conflict
  deterministically (declared kind wins when caption-capable for that block
  type, otherwise falls back + note) so DOCX's SEQ label
  (`captionSeqLabel(kind, lang)`) and PDF's `figure(kind:)` never diverge for
  the same caption. `equation` is rejected until a real math block exists.
- **Caption locale precedence.** `captionSeqLabel(kind, lang)` needs a `lang`
  source that does not exist today (`ExportInput` and `ConfluencePageDetails`
  have no locale field; only `PdfExportMetadata.language`/`region` do,
  `packages/pdf/src/types.ts:3-11`). Precedence: explicit export option >
  host-supplied locale (the same value hosts already thread into
  `PdfExportMetadata.language` for PDF) > `"en"`. Invalid/unrecognized BCP-47
  values fall back to `"en"` with a warning note. This keeps DOCX and PDF
  captions and, later, C2's `TOC \c`/`#outline` list titles using the same
  resolved language per export.
- **Report-first UX:** every macro application and every fallback emits an
  `ExportNote` (existing pattern, `export-blocks.ts:116`); a host option to
  disable export-control macros (CLI `--keep-ignored`, see `exportControls`
  above) is progressive disclosure for debugging and is scoped as an
  optional task.

## Tasks

### Walker (@atlcli/confluence)

- [ ] Capture the storage-fixture set: create a page in a live instance
      containing all `scroll-*` macros above, fetch `body.storage` via
      `atlcli wiki page get`, and check the raw XML fragments into
      `packages/confluence/src/export-blocks.test.ts` (inline fixtures,
      consistent with the existing `FIXTURE` style at line 424). Record the
      verified macro names, parameter keys (`exporter` selector value set!) and
      body wrapping as comments next to each fixture.
- [ ] **C6 fixture gate:** from the captured fixtures, determine whether
      `scroll-landscape`/`scroll-portrait` are body-wrapped
      (`ac:rich-text-body` containing the region's content, matching the
      `orientation { landscape, content }` shape below) or paired open/close
      markers with no body (matching the K15t-documented "orients everything
      until the next marker" behavior). Record the verified shape as a
      fixture comment. If markers: specify a `normalizeOrientationMarkers()`
      pass over the sibling block stream that converts a marker sequence
      into the same `orientation { landscape, content }` blocks — landscape
      opens a region, a portrait marker (or the matching close) ends it, and
      an unterminated region at end-of-body/end-of-tree closes with the
      page's base orientation restored (info note). This keeps the
      body-wrapped `orientation` block the single downstream shape either
      way, so DOCX/PDF rendering tasks below do not fork on marker vs. body.
- [ ] If 001 has not landed: extend `ExportBlock` in
      `packages/confluence/src/export-blocks.ts` with `caption?: Caption` on
      `codeBlock`/`table`/`image`, and new variants `pageBreak`,
      `orientation { landscape, content }`, `anchor { name }`; add
      `CaptionKind`/`Caption` types and `StorageToBlocksOptions` with
      `exporter?: "pdf" | "word"` and `exportControls?: "apply" |
      "passthrough"` (default `"apply"`, see Architecture); re-export new
      types from `packages/confluence/src/index.ts` and `index.browser.ts`.
- [ ] Thread options into the walk: `storageToBlocks(storage, options?)`
      (`export-blocks.ts:330`) stores `exporter` AND `exportControls` on
      `WalkCtx` (`export-blocks.ts:278`) as two independent fields — do not
      collapse them into one flag (see Architecture's `exportControls` note
      on why `exporter` alone cannot implement `--keep-ignored`).
- [ ] `normalizeCaptionKind(raw, targetBlockType)` in
      `packages/confluence/src/export-blocks.ts` (new, exported, unit-tested
      standalone): case-insensitive known-value/alias mapping to
      `CaptionKind`, unknown input → target block's natural kind + warning
      note, `equation` rejected until a real math block exists (see
      Architecture).
- [ ] C4 in `walkMacro()` (`export-blocks.ts:667`, before the KNOWN_MACROS
      fallback), implementing the full C4 truth table from Architecture:
      `scroll-ignore` → when `exportControls === "passthrough"` or the
      `exporter` param is absent/matches `ctx.exporter`: `[]` + info note
      `scroll-ignore-applied`; when the param is present and mismatches:
      keep body (walked) + info note `scroll-ignore-skipped-other-exporter`.
      `scroll-only` → the mirrored table: keep body (walked) on
      absent/match/passthrough, drop body (`[]`) + note
      `scroll-only-skipped-other-exporter` on mismatch. Unknown `exporter`
      values fail safe (include + warning note) regardless of
      `exportControls`, never drop silently.
- [ ] C4 inline variants: extend `isInlineMacro()` (`export-blocks.ts:397`)
      to also return true for `scroll-only-inline`/`scroll-ignore-inline`, and
      handle them in `walkInlineElement` (ignore-inline → `[]` + note,
      only-inline → inline content of its body), same truth table and
      `exportControls` gate as the block form.
- [ ] C5 in `walkMacro()`: `scroll-pagebreak` → `[{ type: "pageBreak" }]`.
- [ ] C6 in `walkMacro()`: `scroll-landscape`/`scroll-portrait` →
      `{ type: "orientation", landscape, content: walkBlocks(body) }` (body
      shape) or the output of `normalizeOrientationMarkers()` (marker
      shape) per the C6 fixture gate above; nested orientation regions in
      the body-wrapped case: outer wins + warning note.
- [ ] C3 in `walkMacro()`: `scroll-title` → build
      `Caption { kind: normalizeCaptionKind(param "type", targetBlockType),
      content }` and attach via new helper `attachCaption(inner, caption,
      ctx)` to the first caption-capable block (`image`/`table`/`codeBlock`)
      produced by the macro body; fallback when no such block exists: italic
      paragraph + info note. Verify against the fixture whether the
      captioned element is body-wrapped or adjacent, and support the
      verified shape.
- [ ] Wire hosts, as a call-site matrix (not one shared assumption — the
      real call sites differ per host and engine):
      - DOCX / `{ exporter: "word" }`: already planned in
        001-exportblock-model at `packages/docx/src/export.ts:235`, ahead of
        this plan's landing slot — this task verifies it lands with an
        exporter-sensitive integration test in
        `packages/docx/src/export.test.ts`, it does not re-implement it.
      - PDF (extension) / `{ exporter: "pdf" }`: wire at the actual walk
        call site, `apps/extension/utils/pdf/run-export.ts:161`
        (`storageToBlocks(input.page.details.storage ?? "", { exporter:
        "pdf" })`), with the same integration test pattern.
      - PDF (CLI): no `storageToBlocks` call site exists yet in
        `apps/cli/src/commands/export.ts` (the CLI only calls
        `runExport`/`exportDocx` for DOCX today); wire `{ exporter: "pdf" }`
        together with the CLI PDF export seam from plan T3.2 once that
        lands, not as a standalone edit to a non-existent call site.
      - Any further host picks `exporter` up through the same
        `StorageToBlocksOptions` object at its own `storageToBlocks` call.
- [ ] Optional (progressive disclosure): CLI flag `--keep-ignored` in
      `apps/cli/src/commands/export.ts` that sets `exportControls:
      "passthrough"` (not "omits `exporter`" — see Architecture) for
      debugging, documented in the command help.

### DOCX rendering

- [ ] C5: add `pageBreakParagraph()` to `packages/docx/src/ooxml.ts`
      (`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`) and a
      `case "pageBreak"` in `serializeBlock()`
      (`packages/docx/src/serialize.ts:338`), threading the
      `container: "body" | "list" | "tableCell" | "calloutCell"` context
      (see Architecture) so cell/callout serialization (`serializeTable`'s
      cell loop at `serialize.ts:613-618`, `calloutTable()` at
      `ooxml.ts:220-224`, both currently only tracking `depth`) can be
      distinguished from body/list. Container matrix: `"body"`/`"list"` →
      render the break; `"tableCell"`/`"calloutCell"` → suppress the break,
      keep the paragraph's other content, emit info note
      `pagebreak-suppressed-in-container` naming the container kind (breaks
      inside `<w:tc>` paragraphs would split the table row/callout, not the
      page).
- [ ] C6: extract a `readBodySectPr(zip)` helper from the body-`sectPr`
      location logic in `injectContentTagAtEnd()`
      (`packages/docx/src/export.ts:845-851`) and pass the clone through
      `SerializeContext`. Render `orientation` as a section sandwich: a
      paragraph carrying the cloned portrait `sectPr` BEFORE the region
      content (a `sectPr` inside a paragraph closes the preceding section),
      then the children, then a paragraph with a clone of the SAME `sectPr`
      whose `<w:pgSz>` has its actual `w:w`/`w:h` attribute VALUES swapped
      (read from the cloned element, not a hard-coded A4 constant — the
      existing test fixture template is Letter,
      `packages/docx/src/fixtures.ts:65` — `w:w="12240" w:h="15840"`, so an
      A4-constant swap would silently produce the wrong page size against
      that fixture and any Letter-based real template) plus
      `w:orient="landscape"` and `<w:type w:val="nextPage"/>` (keep margins,
      keep `headerReference`/`footerReference`). Same container matrix as
      C5 applies to `orientation` inside a table cell/callout: suppress the
      section sandwich (a DOCX section break cannot live inside a `<w:tc>`
      or `<w:tbl>`), keep the region's children unstyled, emit info note
      `orientation-suppressed-in-container`. Fallback when the template has
      no body `sectPr`: synthesize a standard A4 `sectPr` (the synthesized
      fallback, unlike the clone path, legitimately uses A4 constants since
      there is no real template size to preserve).
- [ ] C3: add a caption-paragraph helper to `packages/docx/src/ooxml.ts` that
      emits `<w:pPr><w:pStyle w:val="Caption"/></w:pPr>` plus a SEQ field
      (`fldChar begin` / `instrText " SEQ <label> \* ARABIC "` / `fldChar
      end`) and the caption text. Resolve the `Caption` style id via the
      `parseStyleNames` map with a fallback like `resolveHeadingStyleId`
      (`ooxml.ts:46`); synthesize the style analogous to `codeStyleXml()`
      (`ooxml.ts:61`) when the template lacks it. Introduce
      `captionSeqLabel(kind, lang)` in `ooxml.ts` (en: Figure/Table/Listing,
      de: Abbildung/Tabelle/Listing) — shared later by C2's `TOC \c` fields.
      `lang` resolves per the Architecture locale-precedence contract
      (explicit option > host-supplied locale > `"en"`), threaded through
      `SerializeContext`; unrecognized values fall back to `"en"` + warning
      note.
- [ ] C3: emit the caption paragraph from `serializeBlock()` next to
      `image`/`table`/`codeBlock` blocks that carry `caption` (position:
      above tables, below figures/code — the established convention). Numbers
      refresh on open because `ensureUpdateFields` already runs
      (`packages/docx/src/export.ts:309`).
- [ ] C3 asset-failure fallback: when a captioned `image` block fails to
      embed (no `ctx.images`, or `outcome.ok === false` at
      `packages/docx/src/serialize.ts:410-428`), do not silently drop the
      image AND its caption — emit a visible numbered figure fallback (the
      existing italic-placeholder-run pattern used elsewhere, plus the same
      caption paragraph the successful path would have emitted, so the SEQ
      number is not skipped and downstream captions/`TOC \c` stay correctly
      numbered) alongside the existing `image-skipped`/`image-embed-failed`
      note.
- [ ] Replace the C4/C5/C6/C3 placeholder path: the affected `scroll-*`
      macros must no longer reach the `unknown` arm
      (`packages/docx/src/serialize.ts:431-432`).

### PDF rendering

- [ ] C5: `case "pageBreak"` in `serializeBlock()`
      (`packages/pdf/src/serialize.ts:639`) → `#pagebreak(weak: true)`
      (`weak` avoids blank pages at natural boundaries). Add the block to the
      passthrough arm in `packages/pdf/src/prepare.ts` (the
      `case "divider":` group at line 272) and to `PreparedPdfBlock`
      (`packages/pdf/src/types.ts:36`). Suppress + info note
      (`pagebreak-suppressed-in-container`) inside table cells and callouts
      (`context` already distinguishes cell serialization via `inTable`;
      extend it with the same `container` context DOCX uses so callouts are
      covered too, not just table cells).
- [ ] C6: `case "orientation"` → a scoped block
      `#[ #set page(flipped: block.landscape) ...children... ]` — must set
      `flipped` to the block's actual boolean both ways (a `scroll-portrait`
      region inside a document whose base/T2.1 `settings.orientation` is
      already `"landscape"` must flip back to portrait, not only ever force
      landscape); Typst set rules are block-scoped and page breaks at the
      region boundaries happen automatically. Once T2.1 (007-pdf-template-
      settings) lands, `flipped` combines with the document-level
      `settings.at("orientation", ...)` base per Typst's normal nested
      `set` scoping (region flips relative to whatever the page's current
      state is) — no extra plumbing needed, but pin it with a golden that
      compiles a `scroll-portrait` region inside a `settings.orientation:
      "landscape"` document once T2.1 is available; until then, note the
      dependency here rather than assuming an A4-portrait base. Verify in
      the golden that the header/footer closures from `atlcli-doc`
      (`packages/pdf/src/template.ts:74-88`) stay active — `set page(flipped:
      ...)` must not reset the other page properties. Suppress + info note
      (`orientation-suppressed-in-container`) inside table cells/callouts —
      a Typst `set page` has no effect inside a `table.cell`/`callout` box
      and must not be emitted there; render the children without the
      `set page` wrapper.
- [ ] C3: extend the existing `#figure(image(...))` emissions
      (`packages/pdf/src/serialize.ts:678,691`) with
      `caption: [...]` and `kind: <normalized caption kind>` (the kind
      resolved by the walker's `normalizeCaptionKind`, not a literal fixed
      per code path — see Architecture's caption-kind conflict rule so a
      caption declared `type="table"` on an image and DOCX's SEQ label agree
      on the same resolved kind); wrap captioned tables as
      `#figure(table(...), caption: [...], kind: <normalized kind>)` and
      captioned code as `#figure(raw(..., block: true), caption: [...],
      kind: <normalized kind>)`. Only captioned code blocks become figures —
      caption-less ones keep today's rendering (prevents C2's `kind: raw`
      outline from listing every code block). Respect the source-order rule
      at `serialize.ts:675`: no `placement: auto`.
- [ ] C3: propagate `caption` through `preparePdfDocument()`
      (`packages/pdf/src/prepare.ts:159`) onto `PreparedPdfBlock`
      (`packages/pdf/src/types.ts:36`), including the `diagram` variant.
- [ ] C3 asset-failure fallback: when a captioned `image` block has no
      `assetPath` (`packages/pdf/src/serialize.ts:680-681`), keep the
      existing `[Image unavailable: ...]` text fallback but wrap it as a
      numbered `#figure(..., caption: [...], kind: <normalized kind>)` too,
      matching the DOCX behavior above, so a broken attachment does not
      shift figure numbering or leave a caption-less entry in C2's list of
      figures.
- [ ] T1.6 table hardening: verify that the emitted
      `table.header(...)` (`packages/pdf/src/serialize.ts:786`) repeats on
      every page (Typst default is `repeat: true`; make it explicit —
      `table.header(repeat: true, ...)` — so the golden pins the behavior) and
      add a 200-row table golden that compiles and paginates.
- [ ] T1.6 wide-table overflow strategy: define a deterministic
      `classifyTableLayout(columnCount, sourceWidths, longestAtomicToken,
      availableWidth)` in `packages/pdf/src/serialize.ts` (next to
      `tableColumns()`, `serialize.ts:200-224`) that returns one of
      `"normal" | "dense" | "scaled" | "overflow-warned"` from validated
      inputs (existing `DENSE_TABLE_COLUMN_THRESHOLD` stays the `"dense"`
      boundary at `serialize.ts:729-731`). Escalation, each with fixed Typst
      markup and its own note code: (1) `"dense"` — today's inset shrink
      (`serialize.ts:789`, 6pt → 2pt), unchanged; (2) `"scaled"` — when dense
      inset is still insufficient (longest atomic token, e.g. a URL or ID,
      exceeds the narrowest computed track even at dense inset), scale body
      text down to a defined minimum (e.g. 7pt, never below Typst's
      practical readability floor) via `#set text(size: ...)` inside the
      table block, note code `table-text-scaled`; (3) `"overflow-warned"` —
      when even minimum-size text does not fit the longest atomic token,
      render at the minimum size anyway (accept clipping/wrap over
      silently losing content) and emit a warning note recommending an
      orientation region (C6 gives users the manual fix), note code
      `table-overflow-warned`. Compiler goldens (compiled through the real
      Typst path, not just markup snapshots): long URLs/IDs as the longest
      atomic token, CJK text, extreme `colgroup` width ratios, col-/rowspans
      combined with the dense threshold, and the same wide table nested
      inside a C6 `orientation` (landscape) region to confirm the
      escalation resets against the wider landscape text area rather than
      the portrait one.

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
      `packages/docx/src/placeholder-map.ts`. **`preprocessScrollText` cannot
      implement this as written** — it only rewrites text inside existing
      `<w:t>` runs (`rewriteScrollText`, `packages/docx/src/export.ts:876-884`)
      and has no path to insert `<w:fldChar>`/`<w:instrText>` as sibling
      elements, which a `TOC \c` field requires. Instead, add a dedicated
      `preprocessScrollListFields()` document pass that runs BEFORE the
      generic text substitution: scan body/header/footer paragraphs for one
      that is atomically just the `$scroll.figurelist`/`$scroll.tablelist`
      placeholder (same atomic-paragraph check used by the existing include
      mechanism), and replace that whole paragraph with the standard field
      sequence — `fldChar begin` → `instrText " TOC \h \z \c
      \"<captionSeqLabel>\" "` → `fldChar separate` → cached-result run →
      `fldChar end` — reusing the field-building shape already established by
      `hyperlinkField()` (`ooxml.ts:166-174`). A placeholder that shares a
      paragraph with other content is left untouched with an actionable info
      note (`scroll-list-mixed-paragraph`) rather than partially rewritten.
      A DOCX golden must assert the field XML round-trips as a real
      `<w:fldChar>` field, not literal `<w:t>` text (i.e. that naive text
      substitution was NOT used). Template-authored table-of-figures fields
      already refresh via `ensureUpdateFields`.
- [ ] C7 anchors: walker emits `anchor` blocks for `scroll-bookmark` (params
      `name`/`id` — fixture-verify). **Not this task's job any more (cross-plan
      correction):** the native `<ac:structured-macro ac:name="anchor">` →
      `{ type: "anchor"; name }` walker mapping is now a
      002-scope-orchestration task (`002-scope-orchestration/PLAN.md`,
      Composition, "map Confluence's `ac:name=\"anchor\"`… instead of falling
      through to the generic unknown-macro branch") — 002 lands ahead of this
      follow-up package (`nach 001` vs. C7's unscheduled follow-up slot per
      UMSETZUNGSPLAN), so building the same mapping here a second time would
      either duplicate or silently overwrite 002's walker hunk in the same
      hot file. This task is scoped to `scroll-bookmark` only; verify on
      landing that the native-macro case already exists (from 002) rather
      than re-adding it.
      Engine rendering for the resulting **standalone** `anchor` block
      (distinct from 002's own engine task, which covers heading
      `explicitAnchor` only): PDF `case "anchor"` → `#[]#label(...)` via
      `typstLabel` (`packages/pdf/src/escape.ts`), registered into 002's
      anchor registry (`composeChapters`'s `Map<rawAnchorKey, destination>`,
      `002-scope-orchestration/PLAN.md`, Composition) rather than a second
      anchor-collection pass, so `resolveLink` (`serialize.ts:227`) resolves
      both heading- and block-anchors through the one label map. DOCX:
      `bookmarkStart`/`bookmarkEnd` helper in `packages/docx/src/ooxml.ts`
      with a document-wide id counter in `SerializeContext`, plus a
      `HYPERLINK \l` variant of `hyperlinkField` (`ooxml.ts:166`, reusing
      `escapeFieldArgument`) — bookmark names run through 002's registry
      sanitizer (strip control characters, collapse to ASCII-safe, ≤40 chars
      with a hash-suffix on overflow/collision), **not** a second
      `bookmarkName()` normalizer, so a `scroll-bookmark` anchor and a
      heading-derived anchor can never sanitize to conflicting names for the
      same destination. Anchor-vs-heading-label collisions resolve
      deterministically (anchor wins + note) — this is the same collision
      rule 002's registry already documents for heading vs. explicit-anchor
      slugs; C7 does not need a second rule, only to route through the same
      map. True PDF named destinations are stage 2 (Typst does not emit them
      yet — post-processing or upstream).
- [ ] C8 status styling: add `status?: { font?, size?, weight?, radius?,
      uppercase?, palette? }` to `PdfThemeOptions`
      (`packages/pdf/src/types.ts:79`) **typed and validated to the same bar
      as the existing theme contract** (`packages/pdf/src/theme.ts:19-37`
      throws typed errors on invalid colors/enums/ranges today; this is a
      new Typst-code-generating surface, not a cosmetic add-on) — `font`:
      either an escaped Typst string via `typstString` or a closed
      registry-id enum, never raw interpolation; `weight`: closed enum
      (`"regular" | "medium" | "semibold" | "bold"`, matching Typst's own
      weight vocabulary) or a validated numeric 100–900; `uppercase`:
      boolean; `size`/`radius`: finite numbers within a fixed `pt` range
      (reject `NaN`/`Infinity`/negative, mirroring the `minimumContrast`
      pattern at `theme.ts:33-36`); `palette` values through the existing
      `normalizeExportColor` (same as `colors.ink`/`colors.paper` today).
      Invalid input throws a typed config error carrying the field path
      (`theme.ts`'s existing `Invalid PDF theme color at ${path}` style).
      Adversarial unit tests: quotes, backslashes, embedded Typst
      fragments/function calls in `font`, `NaN`/`Infinity`/negative
      size/radius, invalid palette colors — all must throw, none may reach
      `template.ts`'s currently-static `status-badge`/`dense-status-badge`
      markup (`template.ts:202,238`) as raw interpolation. Fill defaults in
      `packages/pdf/src/theme.ts`, interpolate into `status-badge`/
      `dense-status-badge`, and merge (not replace)
      `theme.status.palette` over `CONFLUENCE_STATUS_COLORS`
      (`packages/pdf/src/serialize.ts:263`). Run palette values through the
      existing contrast warning (`noteLowCellContrast` pattern,
      `serialize.ts:544`). DOCX (`statusBadgeRun`, `ooxml.ts:261`) follows
      later with a DOCX theme option — PDF side first.
- [ ] C9 title override: walker recognizes `scroll-pagetitle` (macro → `[]` +
      note `scroll-pagetitle-applied`, value surfaced as
      `StorageToBlocksResult.titleOverride?`); a **pure** helper
      `resolveExportTitle({ pageTitle, macroTitle?, propertyTitle?,
      explicitTitle? }): { title: string; source: "explicit" | "property" |
      "macro" | "page" }` in `packages/confluence` — pure over explicit
      inputs, no fetching inside it, so it is trivially unit-testable
      without a live content-property port. Precedence: `explicitTitle`
      (CLI `--title` / panel field) > `propertyTitle` (content property
      `atlcli.export.title`) > `macroTitle` (`scroll-pagetitle`) >
      `pageTitle`. Fetching `propertyTitle` needs a lazily-invoked
      `getContentProperty(pageId, key)` port that `ConfluencePageDetails`
      does not expose today (`getPageDetails()` only expands
      `metadata.properties.editor`, `packages/confluence/src/client.ts:539-
      552,595-610`) — reuse 005-placeholders' optional D2 bridge
      (`ResolveDeps.getContentProperty`) if it has landed by the time this
      task starts; otherwise implement the same port shape here (`{ value:
      string; stringified: boolean } | null`) and let 005 adopt it instead
      of building a second one. Not-found falls through to the next source
      silently; permission/rate-limit/network errors on the property fetch
      produce a distinguishable note (`export-title-property-fetch-failed`)
      and fall through rather than failing the export. Hosts set
      `details.title`/`metadata.title` from the resolved value before
      `exportDocx`/`serializePdfDocument`; filename follows via
      `toDownloadFilename` (`packages/docx/src/export.ts:187`). E2E pins
      the full precedence chain end to end (property set + macro present +
      explicit override all on one fixture page) and the filename it
      produces.
- [ ] C1 label index (after tree export lands): `parseIndexTerms(labels)`
      (slash-split) in `packages/confluence`, new `indexMarker` block emitted
      by the orchestrator (labels are page metadata, not walker territory);
      PDF `#metadata(...) <atlcli-idx>` markers + a query-based index section
      in `atlcli-doc` (self-implemented, no remote packages); DOCX `XE` fields
      + `INDEX` field behind a `$scroll.index` placeholder (same route as C2).
      Only labels with a configured prefix (e.g. `idx-` or containing `/`)
      become index terms; preflight report lists recognized terms.
      **Injection hardening (labels are user-controlled Confluence data):** a
      single label-derived index term feeds two different unsafe grammars —
      Word `XE` field arguments and Typst metadata/string literals — plus a
      shared hierarchy separator (labels split into levels, e.g. `idx-
      foo/bar`). Specify one parser producing normalized hierarchy levels
      (trim, length-cap, collapse control characters), then two
      engine-specific serializers: DOCX escapes each level individually
      with the existing `escapeFieldArgument` (`ooxml.ts:157-159`, guards
      `"`/`\`) before XML-escaping and joining with the hierarchy
      separator (escaping the whole joined string instead of each level
      would let a crafted label inject a fake extra hierarchy level); PDF
      routes every level exclusively through `typstString`
      (`packages/pdf/src/escape.ts:16-18`), never raw interpolation into
      the metadata dict. Adversarial tests: `"`, `\`, CR/LF, Unicode
      (including RTL/zero-width), extremely long labels (length cap
      enforced + note), and two distinct raw labels that normalize to the
      same index term (deterministic collision handling + note).

### Tests (no mocking)

Hard rule: NEVER mock. Unit tests run real storage XML through the real
walker; golden tests run the real serializers; E2E runs the real CLI against a
real instance.

- [ ] Walker unit tests in `packages/confluence/src/export-blocks.test.ts`
      using the captured real storage fixtures: scroll-only kept /
      scroll-ignore dropped (+ note), full C4 truth table — exporter
      parameter match/mismatch/absent/unknown-value crossed with
      `exportControls: "apply" | "passthrough"` (mismatch must produce the
      opposite action per macro, not a no-op; passthrough keeps both
      bodies) — inline variants, pagebreak block, orientation nesting
      (outer wins + note) AND, per the C6 fixture gate, either body-wrap
      parsing or `normalizeOrientationMarkers()` sequencing (open → close,
      open → EOF restores base orientation, whichever shape the fixtures
      confirm), `normalizeCaptionKind` known/alias/unknown/conflict cases,
      scroll-title caption attachment incl. no-captionable-block fallback,
      and block-tree snapshots (existing snapshot style, line 452/511).
      These are regression tests: each asserts the exact behavior that the
      placeholder path used to produce is gone.
- [ ] DOCX golden/serializer tests in `packages/docx/src/serialize.test.ts`
      and `packages/docx/src/golden.test.ts`: `pageBreak` emits
      `<w:br w:type="page"/>`; orientation region emits two `sectPr`
      paragraphs with landscape `pgSz` whose `w:w`/`w:h` are the SOURCE
      template's actual swapped values (assert against the Letter fixture,
      `packages/docx/src/fixtures.ts:65`, not an A4 constant) and preserved
      header/footer references; `pageBreak`/`orientation` inside a table
      cell and inside a callout are suppressed with the container-specific
      note and keep their children (four combinations: pageBreak×{cell,
      callout}, orientation×{cell,callout}); caption paragraph carries
      `pStyle Caption` + correct SEQ label in `de`/`en`/missing-locale
      (falls back to `en` + note); a captioned image with a failed embed
      still emits a numbered caption; feature-zoo golden extended with the
      fixture macros so the full pipeline stays byte-stable.
- [ ] PDF golden/serializer tests in `packages/pdf/src/serialize.test.ts`
      (+ `prepare.test.ts` for the passthrough/caption propagation):
      `#pagebreak(weak: true)`, `#set page(flipped: block.landscape)` for
      both boolean values, `pageBreak`/`orientation` suppressed inside a
      table cell and a callout with the container-specific note,
      `figure(..., caption: ..., kind: ...)` for image/table/raw using the
      normalized caption kind (including a declared-kind-vs-target-block
      conflict case), a failed image embed still producing a numbered
      `figure(...)` fallback, explicit `table.header(repeat: true, ...)`,
      200-row table golden, `classifyTableLayout` golden per escalation
      tier (`"dense"`/`"scaled"`/`"overflow-warned"`) with matching note
      codes; source-map paths (`writeMapped`) stay consistent.
- [ ] Compile-level verification: run the compiled Typst output of the new
      goldens through the real compiler path used by
      `packages/pdf/src/run-export.test.ts` to prove the emitted markup is
      valid — page count increases across a `pagebreak`; landscape page
      dimensions in the produced PDF for both orientation directions;
      `classifyTableLayout`'s compiler goldens (long URLs/IDs, CJK, extreme
      `colgroup` ratios, col-/rowspans, same wide table inside a landscape
      `orientation` region) all compile and paginate without content loss;
      C2's `TOC \c` field (once implemented) compiles to a real field, not
      literal text, verified against the produced document XML.
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
      2. Create a test page named `atlcli-e2e-content-features-<epoch-seconds>`
         (the `atlcli-e2e-<feature>-<timestamp>` convention
         `specs/export-expansion/011-quality-gates/PLAN.md` establishes for
         all live E2E resources — this plan is one of the first to run live
         E2E, so start the convention here rather than inventing an ad-hoc
         name; adopt 011's shared `makeE2eTitle`/cleanup helper once it lands
         instead of the inline name) containing scroll-only, scroll-ignore,
         scroll-pagebreak, and scroll-title macros.
      3. Export it as DOCX and PDF via the CLI (`atlcli wiki export ... --engine
         ts` and the PDF route from plan T3.2 once available; until then, the
         package-level export against the live page body).
      4. Assert: scroll-only content present, scroll-ignore content absent
         (and named in the report), a page break at the marker (PDF page
         count / DOCX `w:br` present), caption text attached.
      5. Clean up: delete the test page in a `finally`/equivalent block
         wrapping steps 3–4, so a failing assertion still deletes the page
         (workflow rule, tightened so a failed run never leaves residue in
         `DOCSY`).
- [ ] Run `bun run typecheck` and the full `bun test` before commit; both
      engines' exhaustive switches must compile with no remaining `never`
      gaps for the new block variants.

## Definition of Done

- Real storage fixtures for all in-scope `scroll-*` macros are checked in,
  with verified macro names and parameter keys, INCLUDING the resolved
  `scroll-landscape`/`scroll-portrait` shape (body-wrapped vs. marker
  sequence, C6 fixture gate) confirmed against fixtures before the
  `orientation` block shape shipped.
- C4/C5/C6/C3 walker behavior implemented behind
  `StorageToBlocksOptions.exporter` AND the orthogonal `exportControls`;
  hosts (CLI, extension, further hosts) pass their exporter identity at
  their real `storageToBlocks`/`exportDocx` call sites (verified per the
  call-site matrix, not assumed); every application, including the
  exporter-mismatch case, produces a report note.
- Both engines render `pageBreak`, `orientation`, and captions natively
  (DOCX: `w:br type="page"`, section sandwich with a cloned `sectPr` whose
  `pgSz` swap uses the template's actual dimensions — not a hard-coded A4
  constant — SEQ-field captions with a resolved locale; PDF:
  `pagebreak(weak: true)`, `set page(flipped: block.landscape)` for both
  boolean values, `figure(caption:, kind:)` using the walker-normalized
  caption kind); no in-scope macro reaches the `unknown`-placeholder arms
  anymore.
- `pageBreak` and `orientation` inside a table cell or callout are
  suppressed with a container-specific note (never silently dropped, never
  emitted as invalid/structurally broken markup) in both engines.
- A captioned image that fails to embed still emits a numbered figure
  fallback in both engines, so a broken attachment never shifts
  caption/SEQ numbering.
- `table.header(repeat: true)` pinned by a 200-row golden; `classifyTableLayout`
  implements the dense → scaled → overflow-warned escalation with a note
  code per tier, pinned by compiler goldens (long tokens, CJK, extreme
  `colgroup` ratios, spans, landscape-region nesting).
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
- **`scroll-landscape`/`scroll-portrait` shape unverified (part of the same
  top risk, called out separately because it blocks a model-freeze decision
  rather than just a coding detail):** the plan's `orientation { landscape,
  content }` block assumes a body-wrapped macro; third-party documentation of
  the same macro pair describes stateful open/close markers instead. The C6
  fixture gate (Dependencies) and the `normalizeOrientationMarkers()`
  fallback (Walker tasks) resolve this before the block shape ships either
  way — tracked here so a marker-shaped fixture is not treated as a surprise
  mid-implementation.
- **DOCX section sandwich:** templates without a body `sectPr` (synthesize A4
  fallback), margin handling when swapping w/h, and faithful
  `headerReference`/`footerReference` cloning are the labor-intensive part of
  C6; validate with LibreOffice and Word. The `pgSz` swap must read the
  cloned section's actual `w:w`/`w:h` (the repo's own test template is
  Letter, not A4 — `packages/docx/src/fixtures.ts:65`) — only the no-`sectPr`
  fallback path may legitimately hard-code A4.
- **Caption conventions:** position (above tables vs. below figures) and
  SEQ-label language are convention decisions — defaults chosen here, template
  option later. Word SEQ numbers only refresh on open/print preview; we rely on
  `ensureUpdateFields`. Locale for `captionSeqLabel(kind, lang)` follows the
  explicit-option > host-locale > `"en"` precedence in Architecture; there is
  no locale field on `ExportInput`/`ConfluencePageDetails` today, so this is
  new plumbing, not a rename of an existing field.
- **Typst named destinations (C7):** not emitted by Typst today; internal
  links + outline cover most of the value, true `/Names` injection is a
  post-processing stage 2 — track upstream.
- **C1 value gating:** a label index only becomes useful with tree export;
  keep it sequenced after Lane A and behind a label-prefix filter so process
  labels never pollute the index. Labels are also user-controlled text
  reaching two field/string grammars (Word `XE`, Typst metadata) — the
  injection-hardening contract in the C1 task is required before this ships,
  not an optional follow-up to the follow-up.
- **C9's content-property source may not exist yet:** `resolveExportTitle`'s
  `propertyTitle` input depends on a `getContentProperty` port that only
  005-placeholders' optional D2 bridge currently plans, and D2 is explicitly
  scoped as possibly not landing. C9 must not silently degrade to "explicit >
  macro > page" without a note explaining the content-property source was
  unavailable — see the C9 task's `export-title-property-fetch-failed` note.
- **`ExportNote.source` provenance contract (owned by 011, coordinated
  001→003→004, not a task of this plan):** 011-quality-gates specifies that
  `ExportNote` needs stable source fields (`pageId`, `pageTitle`, `pageUrl`,
  `blockPath`, `assetName`) beyond today's `level`/`code`/`message`/
  `macroName` (`export-blocks.ts:116-122`), gated by its cross-engine report-
  parity check. This plan's new note codes (`scroll-ignore-applied`,
  `scroll-only-applied`, orientation-nesting warning, exporter-mismatch
  fail-safe warning, scroll-title caption-fallback) do not block on that
  contract and should land on schedule — but once `ExportNote.source` exists,
  a follow-up commit must backfill it on these codes, otherwise this plan's
  own goal ("why is section X missing is never a mystery") stops being true
  the moment content lives in a multi-page tree export (Lane A) instead of a
  single page. Track here so the follow-up isn't missed.
- Resolved (was open in an earlier draft): `pageBreak`/`orientation` inside
  callouts now follow the same container matrix as table cells — suppress +
  container-specific note, children kept — see Architecture's "Layout-control
  container context" and the DOCX/PDF rendering tasks.
- Open: whether `--keep-ignored` ships in this plan or with the report/DX
  work (T3.4) — the `exportControls` option it needs is specified either way
  (Architecture), so shipping the flag later is a pure CLI-surface decision,
  not a re-design; property-key namespace for the C9 content property
  (`atlcli.export.title`) needs a one-time decision consistent with the
  planned space-property index; whether C9's `getContentProperty` port is
  built here or arrives via 005-placeholders' D2 bridge depends on landing
  order and is tracked as a risk above, not blocking this plan's own scope.
