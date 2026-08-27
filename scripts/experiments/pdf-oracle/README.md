# Temporary PDF oracle spike

This experiment asks whether independent, non-OCR PDF engines can supply the
structure and geometry evidence that PDFium does not expose for some tagged
documents. It does not change the production importer or publication path.

## Boundaries

- PDFium remains the production facts source.
- PDF.js, PDFBox, Poppler, and pdfplumber produce a separate diagnostic
  contract; their data is never labelled `PdfFactsV2`.
- Parser disagreement is not resolved by majority vote. A known authoring
  oracle or visual/source inspection decides expected structure.
- The emitted report contains aggregates only. PDFBox cell text exists only in
  the in-memory child-process pipe used to prove materializability.
- Docling, PaddleOCR, OCR, language models, and document-specific repair rules
  are outside this spike.
- Input PDFs, renders, reports, the PDFBox JAR, and generated fixtures stay in
  ignored or operating-system temporary directories and must not be committed.

## Engines

The proven run used:

- PDFium `2.15.0` through the current AtlCLI Bun source path;
- PDF.js `6.1.200`;
- Apache PDFBox `3.0.8` (`pdfbox-app-3.0.8.jar`);
- Poppler `pdftotext 26.03.0`;
- pdfplumber `0.11.9`.

Download PDFBox only to a temporary directory. The official SHA-512 for
`pdfbox-app-3.0.8.jar` is:

```text
768847238f683568507bf73570a2b6fedcbe58b25c7b4f97fba536ba110b290f
e96ba065aed58629d41fb94857d76bc1978c2f31d294b553c69f287f71ee9600
```

Source: <https://pdfbox.apache.org/download.cgi>

## Run

Generate the three small known-truth probes into an ignored directory:

```bash
bun --conditions=development \
  scripts/experiments/pdf-oracle/generate-synthetic-spike.ts \
  --output tmp/pdfs/pdf-oracle-spike-synthetic
```

Run the aggregate comparison from the current checkout:

```bash
bun --conditions=development scripts/experiments/pdf-oracle-spike.ts \
  --input tmp/pdfs/pdf-oracle-spike-synthetic/independent-structures-tagged.pdf \
  --label synthetic-structures-tagged \
  --pdfbox-jar /private/tmp/pdfbox-app-3.0.8.jar \
  --java /path/to/current/java \
  --javac /path/to/current/javac \
  --python /path/to/python-with-pdfplumber \
  --format summary
```

`--label` accepts only a non-identifying lowercase slug. The script compiles
the Java helper into a fresh temporary directory, deletes that directory in a
`finally` block, and never emits a source path, filename, title, digest, or
body text.

## Public reference inputs

- W3C complex-table working example:
  <https://www.w3.org/WAI/WCAG22/working-examples/pdf-complex-table/complex-table.pdf>
- W3C PDF20 technique and structural description:
  <https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF20>
- veraPDF atomic validation corpus, pinned by the evidence record:
  <https://github.com/veraPDF/veraPDF-corpus>

The public bytes are reference inputs downloaded to a temporary directory;
they are not repository fixtures. The veraPDF pass/fail pair checks parser
robustness around tagged tables. Its conformance label is not an import-quality
oracle and must not automatically demote an otherwise materializable table.

## Interpretation

`targetArchitectureCarries: true` means all engines completed, agreed on the
page count, and the full-document structure traversal was acyclic. It does not
claim better output for that input.

`actionableOracleAdvantage: true` means at least one independent lane exposed
material structure or geometry that the current importer did not preserve.
Production integration still requires the exact neutral fixtures and live
proof gates in `specs/pdf-import-quality/PLAN.md`.

`oracle/cross-engine-mcid-coverage-gap` is deliberately fail-visible. It means
the PDFBox table references cannot all be matched to PDFium characters by the
raw `pageIndex:mcid` key, even if the independently materialized table tokens
are all present in PDFium's text stream. A production reconciler must classify
that gap instead of silently switching text authority.
