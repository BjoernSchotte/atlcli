# Full-document structure tree fixtures

Neutral pinned Chromium exports used by
`packages/import-pdf/src/struct-tree.test.ts`. Both sources were authored for
AtlCLI under the repository's Apache-2.0 license and contain no customer
content. Document metadata is limited to the title, Chromium version and
export timestamp.

| PDF | Source | Covers |
|---|---|---|
| `browser-multipage-table.pdf` | `browser-multipage-table.html` | one table across three pages, repeated `THead`, intentional empty `TH`, an omitted empty `TD` placed by `/Headers`, punctuation-bearing wrapped cells, a second table with row and column spans |
| `browser-hard-table.pdf` | `browser-hard-table.html` | figure before a table, `rowspan` crossing a page break, `colspan`, a nested table, CJK and RTL cells |

Regenerate (not part of CI; output is not byte-deterministic):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --no-pdf-header-footer --print-to-pdf=browser-multipage-table.pdf \
  browser-multipage-table.html
```

Then update the exact expectations in `struct-tree.test.ts`.

Body-free diagnostics for any local PDF (prints only counts):

```bash
PROBE_LABELS=index bun --conditions=development \
  scripts/experiments/struct-tree-probe.ts <file.pdf>...
