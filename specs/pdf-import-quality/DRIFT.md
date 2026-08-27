# PDF import quality drift record

**Task:** PIQ-00

**Checked:** 2026-08-27

**Architecture baseline:** `cb981dea1f83d4dd5e17932239e42f99a1a607c7`

**Plan commit:** `e126b453b1060779bf9cf896046d300505afc388`

**Implementation starting HEAD:** `e126b453b1060779bf9cf896046d300505afc388`

## Result

The mandatory in-scope drift command was empty. Between the architecture
baseline and the implementation starting point, only
`specs/pdf-import-quality/PLAN.md` was added; no PDF importer, Confluence
publisher, CLI E2E, quality script, existing PDF specification, documentation,
manifest, or lockfile behavior changed.

```text
git diff --stat cb981dea1f83d4dd5e17932239e42f99a1a607c7..HEAD -- <planned in-scope paths>
# empty
```

## V1 consumer audit

The required symbol search found `PdfFactsV1`, `PDF_FACTS_SCHEMA_V1`, and
`PdfFactsAdapter` only in:

- the current `@atlcli/import-pdf` implementation and tests; and
- public consumer compile-smoke scripts that assert the exported V1 surface.

No repository consumer persists V1 facts or semantic results outside the
current in-memory analysis/review/publication flow. PIQ-02 may therefore add V2
facts and keep V1 exports for the public deprecation window without a persisted
facts migration. The compile-smoke consumers must be extended to cover V2 while
their V1 compatibility assertions remain.

## Privacy boundary

Implementation and committed proof use neutral synthetic or independently
authored fixtures only. Private PDFs may be used transiently for authorized
local/LIVE acceptance, but neither their bytes nor any derived text, image,
metadata, digest, identifier, URL, receipt, or capture may enter Git, CI output,
commits, or pull-request communication.

No STOP condition was reached.
