# P1 — Semantic default icons for standard callouts

Status: planned follow-up; blocked on P1.1 accessibility seam proof

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

## 5. Commit-sized implementation tasks

- [ ] **P1.1 — Prove and define semantic icon accessibility contracts.**
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

- [ ] **P1.2 — Render semantic icons in DOCX and PDF.**
  Route both engines through the shared registry, preserve current palettes and
  custom colors, and keep generic panels iconless without source metadata.

  Verification:

  ```bash
  bun run test packages/docx/src/serialize.test.ts packages/pdf/src/serialize.test.ts
  bun run typecheck
  ```

  Commit: `feat(export): render semantic callout icons`

- [ ] **P1.3 — Prove layout, extraction, and accessibility behavior.**
  Add standard callouts in body, list/table/callout containers, update reviewed
  render goldens, and prove no clipping, tofu, duplicate extracted labels, or
  color-only semantics.

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
