# P1 — Semantic default icons for standard callouts

Status: in progress; P1.1 and P1.2 proved

Baseline: `5876348343c5805c3424eea5d516a8c937b4f6f5`

## 1. Outcome

Standard Confluence callouts render with deterministic semantic icons in DOCX
and PDF instead of relying on color alone:

- `info`
- `note`
- `warning`
- `tip`
- `success`
- `error`

Generic/custom `panel` remains iconless unless its typed source supplies an icon.

## 2. Why this is separate from P0

P0 fixes leaked typed emoji short names. P1 changes every ordinary callout,
including pages that never contained emoji. It therefore owns separate
accessibility decisions, layout changes, visual baselines, and release notes.

## 3. Scope

### In scope

- One target-neutral semantic-callout icon registry.
- A target-specific, empirically proved accessibility transport for decorative
  or labelled icons; ordinary text runs are not accepted as proof.
- DOCX and PDF rendering through existing callout seams.
- Explicit custom-panel precedence.
- Dense table/callout-cell layout verification.
- Real DOCX/LibreOffice and PDF/Poppler rendered goldens.
- Documentation of color-independent warning semantics.

### Out of scope

- Replacing callouts with images of the Confluence UI.
- Interactive disclosure behavior.
- Site-custom emoji asset resolution.
- Changing status-lozenge or task/decision markers.
- P0 shortcode normalization.

## 4. Target behavior

The shared registry supplies semantic symbols, never renderer-local string
literals. Every callout follows one precedence chain:

```text
explicit panelIconText
  -> non-colon panelIcon
    -> known typed panelIcon projection
      -> unresolved panelIcon kept visible + diagnosed (P0 contract)
        -> explicit Storage/DC icon=false suppression
          -> CalloutKind semantic default for standard kinds
            -> no icon for generic/custom panels
```

Thus a standard warning with an explicit source icon never receives a second
default icon. Color must not be the only distinguishing signal.

P1.1 is a blocking architecture/proof gate. It must choose and prove exactly
one target contract:

1. a decorative icon excluded from the PDF structure tree and DOCX assistive
   text, paired with one non-duplicated callout-kind label; or
2. a semantically labelled icon with target-specific replacement text.

The proof must inspect generated PDF tags/structure and DOCX OOXML plus a real
screen-reader/Office baseline. Pixel and `pdftotext` checks alone cannot check
P1.1. P1.2 may not start while P1.1 is unchecked.

### Selected accessibility contract

P1 uses candidate 2: a labelled graphical icon with target-specific
replacement text and no additional generated callout-kind text.

- DOCX writes the localized semantic label to `descr` on both `wp:docPr` and
  `pic:cNvPr`.
- PDF writes the same label as `alt` on an unoutlined `pdf.figure`.
- The explicit source icon remains ordinary authored text and suppresses the
  semantic default.
- Storage/DC `icon=false` suppresses both the graphical icon and its replacement
  text. Generic panels stay iconless unless the source supplied an icon.

The rejected decorative candidate remains covered as a regression spike. Typst
0.14.2 correctly emits it as `/Artifact`, but Word 16.111.1 with VoiceOver 10
still exposes the drawing during element navigation as
`Decorative warning callout icon: Dekorativ, Mit Text in Zeile bild`, followed
by the separately generated `Warning` label. The labelled candidate is exposed
once as `Warning, Mit Text in Zeile bild`. Word's Accessibility Checker reports
zero missing-alt-text issues for both OOXML forms. The real Office/VoiceOver
baseline was run on 2026-07-24; the temporary VoiceOver and AppleScript-control
settings were restored to off after the check.

## 5. Commit-sized implementation tasks

- [x] **P1.1 — Prove and define semantic icon accessibility contracts.**
  Build the smallest PDF/DOCX spike for both candidate contracts, select the
  one that is representable in both targets, record the exact structure/OOXML
  seam, then add an exhaustive registry for the six standard callout kinds.
  Test the complete explicit-source precedence, including a standard warning
  with an explicit icon.

  Verification:

  ```bash
  bun run test packages/confluence/src/export-blocks.test.ts
  bun run test packages/docx/src/callout-accessibility.test.ts packages/pdf/src/callout-accessibility.test.ts
  bun run typecheck
  ```

  Commit: `feat(confluence): define semantic callout icons`

- [x] **P1.2 — Render semantic icons in DOCX and PDF.**
  Route both engines through the shared registry, preserve current palettes and
  custom colors, and keep generic panels iconless without source metadata.

  Evidence (2026-07-24):

  - DOCX embeds six deterministic, browser-safe 32×32 PNG assets as 16×16
    labelled inline drawings without counting them as authored page images.
  - The part-aware include path places a footer callout drawing relationship
    in `footer1.xml.rels`; the document part receives no dangling copy.
  - PDF compiles the production template through the real browser WASM compiler
    with exactly six `/Figure` structure entries and `/Alt` values `Info`,
    `Note`, `Warning`, `Tip`, `Success`, and `Error`.
  - Explicit icons, generic panels, and Storage/DC `icon=false` bypass the
    semantic default in both renderers.
  - The focused production suite passes 350 tests; the complete workspace
    typecheck and `git diff --check` pass.

  Verification:

  ```bash
  bun run test packages/docx/src/image.test.ts packages/docx/src/export.test.ts packages/docx/src/serialize.test.ts packages/pdf/src/serialize.test.ts packages/pdf-compiler-browser/src/callout-accessibility.test.ts
  bun run typecheck
  git diff --check
  ```

  Commit: `feat(export): render semantic callout icons`

- [x] **P1.3 — Prove layout, extraction, and accessibility behavior.**
  Add standard callouts in body, list/table/callout containers, update reviewed
  render goldens, and prove no clipping, tofu, duplicate extracted labels, or
  color-only semantics.

  Evidence (2026-07-24):

  - The schema-valid ADF fixture contains all six standard kinds, a list nested
    inside an info callout, and a warning callout inside a bounded table cell.
  - The direct block-model browser fixture additionally places semantic
    callouts in list, table, and nested-callout containers.
  - Browser direct/background parity, packed production output, browser
    typecheck/build/output scan, and the Playwright Chromium case pass.
  - The rendered-golden verifier proves one labelled DOCX/PDF icon per standard
    body callout plus the second table warning, while extracted text keeps all
    bodies and exactly one authored literal `:warning:` control.
  - All 3 DOCX and all 8 PDF reference PNGs were inspected individually:
    callout icons are visible, color-independent, unclipped, non-tofu, and do
    not collide with nested list or table content.
  - Re-rendered output matches the reviewed references exactly:
    `maxMeanPixelDifference=0`, `minContentBoundsIou=1`.

  Verification:

  ```bash
  bun run check:browser
  bun run typecheck:browser-export-harness
  bun run build:browser-export-harness
  bun run check:browser-export-harness
  bun run test:browser-export-harness
  bun run update:adf-rendered-goldens
  # Visually review every regenerated PDF and DOCX PNG before continuing.
  bun run check:adf-rendered-goldens
  ```

  Commit: `test(export): prove semantic callout icon fidelity`

- [ ] **P1.4 — Document and certify the visual change.**
  Update user-facing export documentation and the gap register, run aggregate
  gates, and perform a live `mayflower`/`DOCSY` export. Create a uniquely named
  page containing all six standard callout kinds, one standard warning with an
  explicit source icon, one custom panel with known icon, and one custom panel
  with an unresolved icon. Export it through production PDF and TypeScript
  DOCX paths, inspect visual and accessibility structure, then delete the page
  in `finally` and prove a subsequent `wiki page get` returns not found. Record
  only redacted artifact/evidence paths and the cleanup result.

  Verification:

  ```bash
  bun run test
  bun run typecheck
  bun run build
  bun run check:browser
  bun run docs:check
  git diff --check
  ```

  Commit: `docs(export): document semantic callout icons`

## 6. Stop conditions

Stop and report if:

- a selected icon is not available in the pinned PDF and DOCX font policy;
- extracted text duplicates or corrupts the callout title/body;
- a screen reader receives an unexplained decorative glyph;
- a standard icon conflicts with an explicit custom-panel icon;
- the added icon makes dense/nested callouts clip or overflow.

## 7. Definition of done

P1 is complete only after all four tasks have passed their gates, each checked
task has its own pushed commit under an explicit delivery authorization, both
rendered artifacts have been visually and accessibly reviewed, and the live
test resources have been removed.
