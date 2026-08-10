---
title: PDF Accessibility & PDF/UA Conformance
description: What accessibility properties an exported PDF actually has, what it does not, and how to audit your source pages.
---

This page states exactly what the PDF export does and does not guarantee for
accessibility. It is deliberately conservative: every capability claimed below
is asserted against real compiled PDF bytes in
`packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts`, and
anything not verified there is listed under [What this export does *not*
guarantee](#what-this-export-does-not-guarantee).

## On this page

- [The short version](#the-short-version)
- [What the export produces](#what-the-export-produces)
- [What this export does *not* guarantee](#what-this-export-does-not-guarantee)
- [Known veraPDF rule gaps](#known-verapdf-rule-gaps)
- [Auditing your source pages](#auditing-your-source-pages)
- [Note codes](#note-codes)
- [Related topics](#related-topics)

## The short version

> **Not certified PDF/UA-1.**
> The default exporter produces a **Tagged PDF** with a document language, a
> bookmark outline, fully embedded fonts, and alt-text pass-through. An explicit
> `--pdf-standard ua-1` request additionally selects Typst's PDF/UA-1 output and
> writes the standard identifier. Neither path is a certification claim until
> the external validator acceptance lane has passed.

If you need a legally defensible PDF/UA-1 conformance statement, treat an
atlcli export as an input to your accessibility remediation process, not as its
output.

## What the export produces

Each row is a property of the compiled file, verified by compiling a real PDF
and inspecting its bytes.

| Property | What lands in the PDF | Verified by |
|---|---|---|
| **Tagged PDF** | A `/StructTreeRoot` structure tree, `/MarkInfo` with `/Marked true`, and `/Suspects false` — the compiler asserting its own tagging is derived, not guessed. | `validatePdfOutput` **refuses to emit** an untagged document; claims test |
| **Document language** | A `/Lang` entry in the document catalog, e.g. `/Lang (de-DE)`. A screen reader uses it to choose pronunciation. | `pdf-lang-catalog.test.ts` (real compiler, four locales) |
| **Bookmark outline** | A `/Outlines` tree generated from the document's headings. | Claims test |
| **Embedded fonts** | Every font used is embedded (`/FontFile2` / `/FontFile3`). Nothing depends on a font being installed on the reader's machine. | Claims test asserts **every** `/FontDescriptor` carries a font programme; `validatePdfOutput` separately **refuses to emit** a document with zero |
| **Alt-text pass-through** | Author-written alt text on an image reaches `/Alt` on a `/Figure` structure element. | Claims test |

Two details that commonly surprise people:

:::note[The bookmark outline is not the Contents page]
The `outline` template setting controls the rendered **Contents page** inside
the document. Turning it off does **not** remove the PDF bookmark outline —
bookmarks are generated from headings either way. This is pinned by a test, so
you can rely on it.
:::

:::caution[Alt text is passed through, not created]
When an image has no author-written alt text, the exporter substitutes the
**filename**. The resulting PDF still contains a well-formed `/Alt` entry, so a
checker that merely tests for its *presence* reports no problem — while a screen
reader announces `chart-final-v2.png`.

This is the single most likely way an export looks accessible without being
accessible, which is why the [`image-missing-alt`](#note-codes) audit exists.
:::

## What this export does *not* guarantee

These are unverified or known-absent, and are listed so nobody has to discover
them the hard way:

- **No PDF/UA-1 certification yet.** With no output policy, no
  `pdfuaid:part` identifier is written. `--pdf-standard ua-1` writes the
  identifier and the report includes byte-inspected evidence, but the external
  veraPDF acceptance lane remains the certification boundary.
- **The legacy `profile` field is a label, not a mode.** The export API accepts
  `profile: "pdf-ua-1"`, and the report echoes it — but it does **not** change
  the produced bytes and does **not** add a conformance identifier. An export
  requested with `pdf-ua-1` is byte-identical to one requested with `tagged`.
  It records what a host *asked for*, never what was *achieved*. (This is the
  PDF `profile` field in the export API — unrelated to the CLI's `--profile`
  flag, which selects an authentication profile. The CLI does not expose the
  PDF profile at all. The separate `--pdf-standard` flag is the strict compiler
  mode and is never inferred from this legacy label.)
- **No veraPDF verdict yet.** See [Known veraPDF rule gaps](#known-verapdf-rule-gaps).
- **No semantic review of tag order.** Tags reflect the exported block
  structure. Whether that reading order matches the *intended* reading order of
  a complex page (multi-column macros, floated layouts) is not checked.
- **No colour-contrast guarantee for source content.** Table cell text contrast
  is checked and reported (`pdf-table-cell-contrast-low`), but arbitrary
  author-chosen colours elsewhere are passed through as-is.
- **No table header-scope inference.** Header cells are tagged from the source
  table's header rows; complex tables with irregular headers are not repaired.
- **Alt text quality is never assessed.** Only its presence is (see above).

## Known veraPDF rule gaps

The PDF/UA ratchet lives in `scripts/verapdf/`: a corpus compiler
(`compile-corpus.ts`), the ratchet core (`ratchet.ts`), and a baseline of
accepted failures (`baseline.json`). It runs the official veraPDF CLI with
`--flavour ua1`, fails on any rule failure not in the baseline **or** any
baselined failure whose instance count rises, and warns when a baselined
failure starts passing so the baseline shrinks monotonically.

**The baseline is currently empty (`{}`), and that means "not yet measured" —
not "zero gaps."** veraPDF has not yet run against the corpus in CI: the
sha256-pinned binary (`verapdf.lock.json`) and its workflow are still pending,
and the ratchet test skips itself when the binary is absent. No conclusion about
this exporter's PDF/UA rule conformance can be drawn from the empty baseline.

When the first real run lands, its failing rules are recorded in
`baseline.json` as a reviewed diff, **and this section is updated in the same
change** with the concrete rule list. If you are reading this paragraph, that
has not happened yet.

## Auditing your source pages

Most accessibility defects in an exported PDF originate on the Confluence page,
not in the exporter — so the export reports them per page.

```bash
atlcli wiki export 123456 --format pdf --output ./report.pdf --report json
```

The report's `notes` array carries every audit finding. Each note includes a
`source` object identifying **which page and which block** to fix:

```json
{
  "level": "warning",
  "code": "image-missing-alt",
  "message": "The image \"chart-final-v2.png\" has no alternative text; the exported PDF falls back to a technical label, which assistive technology cannot use. Add alt text on the source page.",
  "source": {
    "pageId": "123456",
    "blockPath": "blocks[4].content[0]",
    "assetName": "chart-final-v2.png"
  }
}
```

To make missing alt text or a missing document language **fail** a pipeline, add
`--strict`, which exits with code `2` when the export completes with warnings:

```bash
atlcli wiki export 123456 --format pdf --output ./report.pdf --report json --strict
```

The same audit runs on the DOCX export, under the **same** code — the fact "this
image has no alt text" belongs to the Confluence page, not to the file format you
asked for, so one `notesByCode` key finds it whichever way you export. The two
notes are not byte-identical: see the note table below for the one difference
that remains.

## Note codes

Every audit note below is `level: "warning"`, and that level is exactly the `severity` it
carries in the `--report json` document — so `--strict` counts all of them. Notes at
`level: "info"` (timings, label filters, macros that rendered fine) map to
`severity: "info"` and never fail a build; see
[Note severity and `--strict`](/confluence/export/#note-severity-and---strict).

| Code | Level | Engines | Emitted when |
|---|---|---|---|
| `image-missing-alt` | warning | PDF + DOCX | An image block on a source page has no author-written alt text. Also fires for images that failed to embed — the source defect is real either way. **The one difference between the engines:** a PDF note carries `source.pageId` / `source.blockPath` / `source.assetName`, a DOCX note carries `source.pageId` / `source.assetName` but **no `blockPath`** (the DOCX serializer tracks no block paths). Same defect, less precise directions. |
| `image-embed-failed` | warning | PDF + DOCX | One named image could not be embedded, with the reason. Not an accessibility note as such, but listed here because the alt-text audit above fires alongside it for the same image. |
| `pdf-image-alt-fallback` | warning | PDF only | The renderer substituted the technical filename into `alt:`. The render-stage counterpart of `image-missing-alt`; both describe one defect from different ends of the pipeline. There is no DOCX counterpart — Word's `descr` gets the same substitution silently. |
| `pdf-language-missing` | warning | PDF only | No usable language was supplied for the export (the PDF then declares `en` regardless), **or** the compiled file's catalog carries no `/Lang` at all. The second is read from the produced bytes, so it can catch a custom template dropping the entry. |
| `pdf-table-cell-contrast-low` | warning | PDF only | A table cell's source colours fall below the configured contrast target. |

Whitespace-only alt text (`alt=" "`) counts as missing in both engines.

:::note[Renamed in this release: `pdf-image-missing-alt` → `image-missing-alt`]
The PDF engine used to report the alt-text audit as `pdf-image-missing-alt` and a
failed image embed as `pdf-image-skipped`, while the DOCX engine reported the
identical conditions as `image-missing-alt` and `image-embed-failed`. A pipeline
that gated on one spelling passed silently on the other format.

Both now use the unprefixed code. **If you grep a report for
`pdf-image-missing-alt` or `pdf-image-skipped`, update the expression** — see
[Migrating retired note codes](/confluence/export/#migrating-retired-note-codes)
for the full table and a compatible `jq` expression.
:::

:::caution[There is currently no way to mark an image as decorative]
`alt=""` does **not** silence the warning, and there is no suppression flag —
Confluence storage collapses an empty `alt` to an absent one, so the two are
indistinguishable by the time the exporter sees them.

This is deliberate rather than an oversight: the renderer substitutes the
**filename** when alt text is absent, so an image you intended as decorative
would still be announced as `chart-final-v2.png` by a screen reader. Marking it
decorative would require emitting an artifact/`/Artifact`-tagged image instead,
which the exporter does not currently do. Until it does, the warning is
accurate and unsilenceable — so treat it as a to-do list, and do not go looking
for a flag that does not exist.
:::

## Related topics

- [PDF Export Engine](/reference/pdf-engine/) — the pipeline these audits run in
- [PDF Template Settings](/reference/pdf-template-settings/) — `outline`, language and locale settings
- [DOCX Export Engine](/reference/docx-engine/) — the DOCX-side image path
- [CLI Commands](/reference/cli-commands/) — `--report json`, `--strict` and exit codes
