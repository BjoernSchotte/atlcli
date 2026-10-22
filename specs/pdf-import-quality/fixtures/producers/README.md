# Desktop producer variety fixtures

Neutral pinned exports used by `packages/import-pdf/src/producers.test.ts`.
Every source was authored for AtlCLI under the repository's Apache-2.0
license and contains no customer content. Each export was sanitized with
`../producer-tools.ts sanitize-export` (neutral Info dictionary, no XMP).

| PDF | Producer | Source | Covers |
|---|---|---|---|
| `word-table-breaks.pdf` | Microsoft Word for Mac 16.113.4, **Save As PDF** | `source.ts` (`table-breaks.docx`) | a ruled table broken between rows, a table with inside rules only across pages, a ruled table whose tall row is split by the page break |
| `libreoffice-table-breaks.pdf` | LibreOffice 7.1.1.2 Writer | `source.ts` (`table-breaks.docx`) | the same document from a second producer |
| `libreoffice-contents.pdf` | LibreOffice 7.1.1.2 Writer | `source.ts` (`contents.docx`) | a table of contents set in the heading styles it lists, numbered headings of two levels in one size (bold and regular), 10 pt body text |
| `libreoffice-deck.pdf` | LibreOffice 7.1.1.2 Impress | `deck.fodp` | slides: title, subtitle, a bulleted list, a filled callout box, a borderless table |

What the exports showed: both word processors draw the table frame across a
split row (a bottom rule on one page, a top rule on the next), so geometry
cannot tell a split row from a row break. LibreOffice splits the clause
mid-sentence, which proves the split; Word splits it between sentences, and its
rest is proven only because it is the table's sole row with blank cells. Word draws a table with inside
rules only with one vertical rule fewer than it has columns.

A scanned page with an invisible OCR text layer is generated inside the test;
it needs no pinned bytes.

Word must open files from its sandbox container
(`~/Library/Containers/com.microsoft.Word/Data/Documents`) or ask for file
access first.

Not covered, because no producer was available locally: Adobe InDesign,
Google Docs, Microsoft PowerPoint, Apple Pages and Keynote.

## Regenerate (not part of CI; output is not byte-deterministic)

```bash
bun specs/pdf-import-quality/fixtures/producers/source.ts .tmp/producers
osascript -e 'on run argv' -e 'tell application "Microsoft Word"' \
  -e 'open (POSIX file (item 1 of argv))' \
  -e 'save as active document file name (item 2 of argv) file format format PDF' \
  -e 'close active document saving no' -e 'end tell' -e 'end run' \
  "$PWD/.tmp/producers/table-breaks.docx" "$PWD/.tmp/producers/word.raw.pdf"
soffice --headless --convert-to pdf --outdir .tmp/producers .tmp/producers/table-breaks.docx
soffice --headless --convert-to pdf --outdir .tmp/producers .tmp/producers/contents.docx
soffice --headless --convert-to pdf --outdir .tmp/producers specs/pdf-import-quality/fixtures/producers/deck.fodp
bun specs/pdf-import-quality/fixtures/producer-tools.ts sanitize-export \
  --input .tmp/producers/word.raw.pdf \
  --output specs/pdf-import-quality/fixtures/producers/word-table-breaks.pdf \
  --producer "Microsoft Word for Mac <version> Save As PDF" --title "Neutral Table Breaks"
```

Sanitize the LibreOffice exports the same way (`--title "Neutral Table
Breaks"`, `--title "Neutral Service Manual"` and `--title "Neutral Field Review"`), render every page, inspect it,
and rerun `bun run test packages/import-pdf/src/producers.test.ts`.
