# PDF import MVP drift record

**Task:** PDF-00
**Checked:** 2026-08-18
**Plan baseline:** `b6826af5489ca08db6dea0e1ca384323c0d1c59f`
**Task starting HEAD:** `58f7cc3c075f2d342e2e91f7f07aa2e5f828349f`

## Result

The mandatory Section 3.5 diff found no implementation drift in the DOCX
importer, Confluence client/publisher, CLI import command, PDF viewer, browser
harness, workspace manifest, or root lockfile between the plan baseline and the
task starting HEAD. The three intervening commits changed only this PDF plan.
No PDF analyzer, generic import IR, new baseline schema, attachment behavior, or
`wiki import` route was merged.

```text
git diff --stat b6826af5489ca08db6dea0e1ca384323c0d1c59f..58f7cc3c075f2d342e2e91f7f07aa2e5f828349f -- <Section 3.5 paths>
# empty
```

The current DOCX behavior lock remains:

- neutral fixture SHA-256:
  `e43a973b75743966f6494afde8b48ad536e6ff2958fdf74b6170d5f1d853d01`;
- preview: one heading, two paragraphs, one list;
- ADF digest:
  `beecac58ae32f52ced9670c4f765136e4ebd2fce1642195cc63f518e9a571023`;
- the existing DOCX package and CLI regression set passes 92 tests.

## Reconciliations made during PDF-00

1. The committed feasibility work lives only in
   `specs/import-pdf-mvp/{fixtures,probe}`. It adds no workspace dependency and
   no production code.
2. The plan's proposed `canonical.ts` reuse was corrected to the shipped
   `canonicalJson` export in `packages/import-docx/src/baseline.ts`.
3. The comparison probe uses `pdfjs-dist` 6.2.108. The Extension still resolves
   its existing 6.1.200 line and is affected by GHSA-hq66-cqwq-w95j; upgrading
   that viewer is a separate security change with its own output/browser gates.
4. The exact PDFium candidate is `@embedpdf/pdfium` 2.15.0 with caller-supplied
   local WASM bytes. Its default CDN constant is never called.
5. A neutral Chromium worker is feasible. There is no PDFium import worker in
   the shipped Extension and no Forge application workspace in this repository,
   so those product capabilities remain unavailable and are not claimed by
   PDF-00.
6. Committed evidence omits live Confluence IDs, URLs, parent IDs, timestamps,
   and tenant output. The required live test is recorded only as a sanitized
   create/readback/delete/404 result.

No STOP condition was reached. PDFium is accepted as the CLI importer candidate;
Extension and Forge import availability remain gated future work.
