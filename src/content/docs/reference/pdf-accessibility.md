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
> The exporter produces a **Tagged PDF** with a document language, a bookmark
> outline, fully embedded fonts, and alt-text pass-through. That is a solid
> starting point, and it is **not** a claim of PDF/UA-1 conformance. No
> certified conformance testing has been performed, and no conformance claim is
> embedded in the output.

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
accessible, which is why the [`pdf-image-missing-alt`](#note-codes) audit exists.
:::

## What this export does *not* guarantee

These are unverified or known-absent, and are listed so nobody has to discover
them the hard way:

- **No PDF/UA-1 certification.** No `pdfuaid:part` identifier is written into
  the XMP metadata, and no certified validation has been run. The export makes
  no conformance claim, in the file or anywhere else.
- **The `profile` field is a label, not a mode.** The export API accepts
  `profile: "pdf-ua-1"`, and the report echoes it — but it does **not** change
  the produced bytes and does **not** add a conformance identifier. An export
  requested with `pdf-ua-1` is byte-identical to one requested with `tagged`.
  It records what a host *asked for*, never what was *achieved*. (This is the
  PDF `profile` field in the export API — unrelated to the CLI's `--profile`
  flag, which selects an authentication profile. The CLI does not expose the
  PDF profile at all; every CLI export is `tagged`.)
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
  "code": "pdf-image-missing-alt",
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

The same audit runs on the DOCX export, reported as `image-missing-alt`. It is
**not identical**: see the note table below for the one difference that remains.

## Note codes

| Code | Level | Emitted when |
|---|---|---|
| `pdf-image-missing-alt` | warning | An image block on a source page has no author-written alt text. Carries `source.pageId` / `source.blockPath` / `source.assetName`. Also fires for images that failed to embed — the source defect is real either way. |
| `pdf-image-alt-fallback` | warning | The renderer substituted the technical filename into `alt:`. The render-stage counterpart of the note above; both describe one defect from different ends of the pipeline. |
| `pdf-language-missing` | warning | No usable language was supplied for the export (the PDF then declares `en` regardless), **or** the compiled file's catalog carries no `/Lang` at all. The second is read from the produced bytes, so it can catch a custom template dropping the entry. |
| `image-missing-alt` | warning | The DOCX counterpart of `pdf-image-missing-alt`. Word writes the filename into `descr`, so Word's own accessibility checker stays silent — this note is the only signal. Fires for failed embeds too, like the PDF audit. **Difference:** it carries `source.pageId` and `source.assetName` but **no `blockPath`** — the DOCX serializer does not track block paths, so a DOCX note identifies the page and the image, not the position in the page. |
| `pdf-table-cell-contrast-low` | warning | A table cell's source colours fall below the configured contrast target. |

Whitespace-only alt text (`alt=" "`) counts as missing in both engines.

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
