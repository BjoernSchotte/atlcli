# PDF-00 feasibility probe

This private package freezes the two extraction engines used only for the
PDF-00 bake-off. It is intentionally outside the workspace globs, never ships
with AtlCLI, and must not be imported by production code. PDFium is the import
candidate; PDF.js is the viewer-only comparison baseline. The baseline uses
PDF.js 6.2.108 because the repository viewer's older 6.1.200 pin is affected by
GHSA-hq66-cqwq-w95j; changing the shipped viewer is deliberately separate from
this importer feasibility probe.

Install and run locally:

```bash
bun install --cwd specs/import-pdf-mvp/probe --frozen-lockfile
bun run --cwd specs/import-pdf-mvp/probe probe
```
