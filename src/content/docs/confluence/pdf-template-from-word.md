---
title: "Create a PDF template from Word"
description: "Import the design of a Word document, review every proposed change, preview it, and build a verified PDF template pack"
---

# Create a PDF template from Word

Use an existing `.docx` as design evidence for a PDF template. atlcli compares
what it can recognize with the complete **Editorial Indigo** baseline, presents
the proposed changes in business terms, and applies nothing until you choose.
The result is a verified `.wiki-pdf-template` pack for later PDF exports.

The import is intentionally a review workflow, not a Word-to-PDF conversion.
Your document content is not copied into the template pack.

## On this page

- [Prerequisites](#prerequisites)
- [The four-step workflow](#the-four-step-workflow)
- [Minimal workflow](#minimal-workflow)
- [Review design choices](#review-design-choices)
- [Review graphics](#review-graphics)
- [Preview and build](#preview-and-build)
- [Resume or undo](#resume-or-undo)
- [Use the pack](#use-the-pack)
- [What can and cannot transfer](#what-can-and-cannot-transfer)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A `.docx` containing representative styles and page design.
- atlcli installed. Creating the pack is local and does not require a
  Confluence profile.
- The right to reuse every graphic you choose to include.
- A PDF viewer for the generated design review.

For a useful result, include the document elements that matter to your normal
output: headings, body text, lists, tables, headers or footers, and any
background or brand graphics. A one-page sample is enough if it contains those
elements.

## The four-step workflow

1. `import` analyzes the Word design into a local, resumable project.
2. `review` lets you apply, retain, or leave open each supported choice.
3. `preview` renders a design review and compatibility proof.
4. `build` validates the reviewed design and creates one verified pack.

The project is the durable workspace. You can stop after any command and
continue later with `status`.

## Minimal workflow

```bash
atlcli pdf-template import ./brand.docx
atlcli pdf-template review ./brand-pdf-template
atlcli pdf-template preview ./brand-pdf-template
atlcli pdf-template build ./brand-pdf-template \
  --output ./brand.wiki-pdf-template
```

The default project directory is
`./<word-file-name>-pdf-template`. Import refuses to replace an existing
directory.

The primary journey looks like this:

```text
$ atlcli pdf-template import brand.docx
Analyzed brand.docx

12 design choices are ready to apply
 4 need your review
 3 Word features cannot be transferred

No Word suggestions have been applied yet.
The draft currently uses Editorial Indigo.

Project: ./brand-pdf-template
Next: atlcli pdf-template review ./brand-pdf-template

$ atlcli pdf-template review ./brand-pdf-template
…review the grouped choices…

$ atlcli pdf-template preview ./brand-pdf-template
OK Ready to build
…
design-review: ./brand-pdf-template/proof/design-review.pdf
compatibility-proof: ./brand-pdf-template/proof/compatibility-proof.pdf

$ atlcli pdf-template build ./brand-pdf-template \
    --output ./brand.wiki-pdf-template
OK Built
…
archive: ./brand.wiki-pdf-template
```

Counts and available questions depend on the source document. The command
order, stages, project behavior, and next-action guidance do not.

## Review design choices

Interactive review groups choices by familiar areas such as page layout,
typography, colors, headings, tables, and graphics. Each item shows:

- the current Editorial Indigo value;
- the value found in Word;
- what atlcli recommends and why;
- whether the match is ready, uncertain, unsupported, or blocked.

No suggestion is applied during the default import. During review you can
accept a ready match, keep the current value, skip it for later, go back, or
stop. Stopping commits only the answers you already gave and leaves the rest
open.

For a non-interactive first pass, apply only ready choices explicitly:

```bash
atlcli pdf-template review ./brand-pdf-template \
  --apply-ready --non-interactive
```

Use `status` afterward. Build stays blocked while required decisions or
unsupported-inventory acknowledgements remain open.

## Review graphics

Graphics are separate decisions because a visually plausible match is not
proof of intent or permission. When graphics are present, review first creates
an asset contact sheet. For every included graphic, atlcli asks for:

1. its PDF role: logo, page background, cover art, header decoration, or footer
   decoration;
2. confirmation that you intend to use it;
3. confirmation that you have the right to use it;
4. whether it is decorative or needs alternative text;
5. placement: the safe slot default, a stable source placement when available,
   or an explicit custom placement.

A graphic enters the final pack only after all confirmations succeed.
Unselected graphics stay in the private local intake area and are excluded
from the pack.

Use metadata-only mode when you want to inspect style candidates without
extracting graphic bytes:

```bash
atlcli pdf-template import ./brand.docx --metadata-only
```

To review graphics later, reanalyze the original source without that flag:

```bash
atlcli pdf-template reanalyze ./brand.docx \
  --dir ./brand-pdf-template
```

## Preview and build

Preview creates:

- `proof/design-review.pdf` — baseline and reviewed design, including counts
  for applied, retained, open, and unsupported choices;
- `proof/compatibility-proof.pdf` — representative headings, paragraphs,
  tables, callouts, and other supported output;
- `proof/asset-contact-sheet.pdf` — only when the source contains graphics;
- `proof/results.json` — compiler version, hashes, page counts, regions, and
  the project generation those PDFs prove.

Open the design review before building. If you change any decision afterward,
the preview becomes stale and must be created again.

`build` refuses unanswered decisions, stale previews, invalid assets, unsafe
pack contents, or a pack that fails a real Typst compile. It never overwrites
an existing output file.

## Resume or undo

Resume without changing anything:

```bash
atlcli pdf-template status ./brand-pdf-template
```

If the Word source changed, reanalyze it into the same project:

```bash
atlcli pdf-template reanalyze ./brand-v2.docx \
  --dir ./brand-pdf-template
```

atlcli retains prior intent where it still matches and reports stale or
unmatched decisions for review. It does not partially activate a failed
reanalysis.

Undo creates a new generation from the previous committed design; it does not
delete history:

```bash
atlcli pdf-template undo ./brand-pdf-template
atlcli pdf-template preview ./brand-pdf-template
```

A restored design needs a fresh preview before it can be built.

## Use the pack

Pass the generated pack by path when exporting PDF:

```bash
atlcli wiki export 12345678 --format pdf \
  --template ./brand.wiki-pdf-template \
  --output ./brand-report.pdf --json
```

Without `--template`, PDF export continues to use Editorial Indigo. The pack is
validated locally before atlcli contacts Confluence.

## What can and cannot transfer

atlcli transfers supported design intent, not arbitrary Word rendering
behavior.

| Confidence | Examples | What happens |
|---|---|---|
| Reliable | Page size and margins, explicit colors, named style typography, paragraph spacing, borders, supported header/footer graphics | Presented as supported candidates with source evidence |
| Needs review | Theme indirection, competing style definitions, inferred graphic role, repeated decorations, layout-dependent placement | Kept open until you choose |
| Not transferable | Macros, fields or executable expressions, arbitrary DrawingML effects, unsupported shapes, Word-only pagination behavior | Named in the unsupported inventory; never silently approximated |

The compatibility proof is the final check for the output features you care
about. Word and Typst are different layout engines, so equal design tokens do
not guarantee identical line breaks or pagination.

## Security and privacy

- Analysis, review, preview, and build run locally.
- The project uses private directory and file permissions where the platform
  supports them.
- Extracted source graphics live under the project's private `.intake` area.
- The portable project state contains hashes and normalized design facts, not
  raw OOXML or document body text.
- The final pack contains only the resolved design, canonical generated Typst,
  required metadata, and graphics you explicitly accepted.
- DOCX macros, fields, expressions, and embedded code are never executed.
- XML, ZIP, raster, and SVG limits are enforced before expensive processing.
- Deleting the project is a local filesystem operation; `undo` is the safer
  choice while you are still working.

Treat the local project as sensitive if the source graphics are sensitive.
Do not commit it unless your repository policy explicitly allows those assets.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Project directory already exists | Initial import is no-clobber | Resume it with `status`, choose another `--dir`, or remove it only after confirming it is disposable |
| Review shows no graphics | Import used `--metadata-only`, or the graphic format/relationship is unsupported | Reanalyze without `--metadata-only`; check the unsupported inventory |
| Candidate placement is unavailable | Word placement depends on layout or an unsupported reference frame | Use the role's slot default or an explicit reviewed custom placement |
| Preview is stale | A decision or source analysis changed | Run `preview` again |
| Build says review remains open | One or more choices or inventory items are unanswered | Run `review`; use `status` to see the next valid action |
| Build refuses the output path | The archive already exists | Choose a new path; build deliberately does not overwrite |
| Source changed | The project was analyzed from different bytes | Run `reanalyze <updated.docx> --dir <project>` |
| A font falls back | The Word font is not in the bundled PDF font set | Choose a supported font during review and inspect the compatibility proof |

## Related topics

- [PDF template authoring CLI](/reference/pdf-template-authoring-cli/) —
  commands, flags, machine output, and automation
- [DOCX and PDF Export](/confluence/export/) — use a generated pack
- [Export template library](/confluence/export-templates/) — Word templates,
  PDF packs, and host differences
- [PDF Template Contract](/reference/pdf-template-contract/) — runtime
  contract and versioning
- [Template Pack Format](/reference/template-pack-format/) — archive and
  validation details
