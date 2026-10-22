---
name: confluence-pdf
description: PDF export of Confluence pages and the pdf-template command group for building branded PDF template packs from Word documents or YAML recipes.
metadata:
  tags: confluence, pdf, pdf-template, export, branding
---

# PDF export and PDF templates

`atlcli wiki export --format pdf` renders pages to a tagged PDF. `atlcli
pdf-template` builds the design packs (`.wiki-pdf-template`) that change how it
looks. Scope, report, exit codes, CI auth and jobs are shared with DOCX, see
[confluence-export.md](confluence-export.md). `pdf-template` is unrelated to
`wiki template` (Confluence page templates).

## Contents

- [Exporting](#exporting)
- [Choosing a design](#choosing-a-design)
- [Template pack from a Word document](#template-pack-from-a-word-document)
- [Template pack from a YAML recipe](#template-pack-from-a-yaml-recipe)
- [Automation output](#automation-output)
- [Anti-patterns](#anti-patterns)

## Exporting

```bash
atlcli wiki export 12345678 --format pdf --output ./report.pdf --json
atlcli wiki export 12345678 --format pdf --scope tree --label-exclude internal \
  --out-dir ./dist --report json --strict
atlcli wiki export 12345678 --format pdf --pdf-standard ua-1 -o ./a11y.pdf --json
atlcli wiki export 12345678 --format pdf --pdf-images standard -o ./small.pdf
```

Tree and space scopes produce one PDF, never one per page. Use `--output` for a
file or `--out-dir` for a derived `<pageId>-<slug>.pdf` name, not both. An
existing file is kept unless `--force` is given. The file is written atomically,
a failed run leaves no partial file.

| Option | Effect |
|--------|--------|
| `--no-cover`, `--no-toc`, `--no-closing-page` | Leave one page out, wins over the template |
| `--pdf-standard <name>` | `a-1b`, `a-1a`, `a-2b`, `a-2u`, `a-2a`, `a-3b`, `a-3u`, `a-3a`, `a-4`, `a-4f`, `a-4e`, `ua-1`; no fallback to a lower standard |
| `--pdf-images original\|standard\|print` | Re-encode large raster images (180 or 300 PPI) |
| `--pdf-images-ppi <72-1200>` | Exact density, needs `standard` or `print` |
| `--code-theme <id>` | Shiki theme, default `github-light` |
| `--exported-at <ISO8601>` | Fixed timestamp, also `SOURCE_DATE_EPOCH` |
| `--no-cache` | No persisted asset cache |
| `--strict` | Exit 2 on warnings |

The report lists `outputPolicy` and, on success, `outputStandardEvidence` when
`--pdf-standard` was used. That evidence is not a certification.
`ATLCLI_EXPORT_SOURCE=storage` switches the page source from ADF to storage
format and adds the `adf-storage-fallback` note.

Cloud sites read ADF, Data Center reads storage. Mermaid diagrams and Confluence
chart macros render as vector graphics.

## Choosing a design

`--template` takes:

- nothing: Editorial Indigo (cover, contents, running header, page numbers,
  closing page).
- `report`: built-in Report template for short documents. No cover or closing
  page, title block and accent band on page 1, contents to heading level 2.
- a path ending in `.wiki-pdf-template`: a verified pack. It is validated before
  Confluence is contacted.

## Template pack from a Word document

Everything here is local. No Confluence profile is needed and the DOCX is never
copied into the pack.

```bash
atlcli pdf-template import ./brand.docx            # creates ./brand-pdf-template
atlcli pdf-template status ./brand-pdf-template
atlcli pdf-template review ./brand-pdf-template
atlcli pdf-template preview ./brand-pdf-template
atlcli pdf-template build ./brand-pdf-template --output ./brand.wiki-pdf-template
```

- `import` refuses an existing project directory (`--dir` picks another) and
  applies no suggestion by default (`--policy suggest-only`). `--metadata-only`
  skips extracting graphics.
- `review` is interactive in a terminal. In scripts only explicit flags change
  anything: `--apply-ready`, `--keep-current-for-remaining`,
  `--acknowledge-unsupported`, always with `--non-interactive`.
- A graphic enters the pack only when role, usage intent, rights
  (`--rights-confirmed`), alt text or `--decorative`, and placement are all
  confirmed. Do not confirm rights on the user's behalf.
- `preview` writes `proof/design-review.pdf` and `proof/compatibility-proof.pdf`.
  Any later decision makes the preview stale.
- `build` refuses open decisions, a stale preview and an existing output file.
- `reanalyze <new.docx> --dir <project>` re-reads a changed Word file,
  `undo <project>` restores the previous design as a new generation.
- Stages in `status`: `review-required`, `ready-to-preview`, `ready-to-build`,
  `built`, `source-changed`, `blocked`.

Expert commands: `analyze`, `diff`, `decide`, `set --target <path> --value
<json>`, `clear-override`, `clear-optional`, `validate`, `pack`.

## Template pack from a YAML recipe

```bash
atlcli pdf-template explain ./recipe.yaml --json
atlcli pdf-template validate ./recipe.yaml
atlcli pdf-template build ./recipe.yaml --output ./brand.wiki-pdf-template
```

A Recipe V2 starts with `schema: wiki.pdf-template-recipe/v2`, a `template`
block (`id`, `name`, `version`), a `baseline` pinned by `id`, `version`,
`catalogVersion` and `digest`, a sparse `design` object and an `assets` map. The
baseline must be one shipped with the installed atlcli; there is no `latest`. To
change a recipe, run `explain` first, it lists the baseline, overrides, asset
slots and active constraints without opening asset files. Asset paths are
relative to the recipe directory and symlinks that escape it are rejected.
`migrate-runtime <recipe-v1.yaml> --output <path>` adapts an older Recipe V1 to
the current compiler range. `build` writes nothing until YAML, assets, archive
and a real compiler proof pass, and it never replaces an existing file.

## Automation output

`--json` implies `--non-interactive`, writes one `atlcli.pdf-template-result/1`
document to stdout (`ok`, `exitCode`, `diagnostics`, `nextActions`, `view`) and
JSONL progress to stderr. Add `--no-log` to silence ordinary logging. Follow
`nextActions` instead of guessing the next command. `--details` shows IDs and
digests in text output.

## Anti-patterns

- Editing files inside a pdf-template project by hand. Use `review`, `decide`,
  `set`, `reanalyze`, `undo`.
- Committing a project directory. `.intake/` holds the extracted source
  graphics.
- Passing a `.docx` to `wiki export --template` with `--format pdf`. PDF takes a
  `.wiki-pdf-template` pack or `report`.
- Expecting `--page-size`, `--watermark` or `--accent-color`. They do not exist.
  Settings come from a pack.
- Retrying a build that fails with `Cannot find package
  '@atlcli/pdf-compiler-browser'`. The installed build has no PDF compiler.

Related: [confluence-export.md](confluence-export.md),
[confluence-templates.md](confluence-templates.md).
