# Issue 119 verification evidence

Verified on 2026-07-29. All corpora are deterministic synthetic fixtures; raw
documents, filenames, page identifiers, and tenant data are not retained.
Machine-local timings are comparative only.

## Chromium benchmark matrix

The productive extension executor ran in Chromium with CDP heap/backing samples
approximately every 25 ms during the job. The committed pre-change baseline is
the existing `chrome-post-queue.json`; new reports were written only to `/tmp`.

| Corpus and route | Logical input | Artifact | Job time | Observed heap peak | Observed backing peak |
|---|---:|---:|---:|---:|---:|
| text, 50 pages, adaptive memory | 270,928 B | 310,308 B | 289 ms | 24.05 MB | 14.01 MB |
| text, 500 pages, adaptive stream | 2,713,516 B | 1,971,952 B | 5,188 ms | 62.49 MB | 16.52 MB |
| mixed, scale 0.35, adaptive stream | 13,185,990 B | 13,228,470 B | 2,930 ms | 43.81 MB | 55.52 MB |
| image-heavy, scale 0.55, memory control | 31,825,071 B | 31,797,890 B | 1,752 ms | 25.86 MB | 159.68 MB |
| image-heavy, scale 0.55, adaptive stream | 31,825,071 B | 31,809,460 B | 4,222 ms | 26.58 MB | 87.43 MB |

The image-heavy corpus has 74 unique original-quality assets (31,779,752 B)
and 184 placements. Both A/B runs had the same 34,728,063 B backing baseline
after corpus preparation. Incremental packaging backing therefore fell from
124,955,092 B to 52,700,212 B: **57.8% lower**, exceeding the issue's 50%
balanced-mode gate. The measured runtime cost was +141%. The adaptive artifact
was emitted through a 31,809,460 B output spool; the memory control emitted one
engine buffer.

The committed 500-page baseline's completed backing checkpoint was 22,550,318
B. The final adaptive checkpoint was 5,380,745 B (76.1% lower). The 50-page
route retained the fast path and created no `docx-output-v1` spool.

## Correctness gates

- Raster ZIP entries reopen as method 0 (`STORE`); XML/vector parts remain
  method 8 (`DEFLATE`).
- Streaming output has deterministic entry order/timestamps, Data Descriptors,
  bounded input/output chunks, exact deferred-part lengths, and a valid final
  Central Directory.
- Legacy and streamed containers have equal OPC part names and uncompressed
  part bytes. Literal braces and template-like page text remain verbatim.
- Sentinel coverage includes `word/document.xml`, missing-content fallback,
  and content in a header. No sentinel bytes survive.
- Retry after sink failure, cancellation, hard output caps, incremental SHA-256,
  lost-result recovery, checkpoint tamper detection, and cleanup are covered.
- Extension IndexedDB and Node file stores recover media as `sourceRef` values
  and stream the bound object after restart without hydrating aggregate bytes.

## Commands

```bash
bun run test
bun run typecheck
bun run build
bun run --cwd apps/extension typecheck
bun run bench:export-jobs-chrome
```

The full workspace suite completed with 5,830 passing tests, 14 explicit
opt-in/live skips, and zero failures. Build, workspace typecheck, and extension
typecheck completed successfully.

## Live application compatibility

A final read-only export of one existing page through the built CLI completed
successfully with three embedded images. No remote page or issue was created,
updated, or deleted. The local artifact hash matched the executor report.

- `unzip -t` reported no errors. All PNG media entries used `STORE`; XML,
  relationships, font metadata, and the embedded font used `DEFLATE`.
- LibreOffice opened the DOCX headlessly and converted it to a two-page PDF
  with extractable text.
- Microsoft Word opened the DOCX in Compatibility Mode without a repair,
  recovery, or conversion dialog. The accessible document tree contained both
  pages, all three images, and the expected tables. The document was closed
  without saving.
- The productive Chromium extension executor completed the text, mixed, and
  image-heavy benchmark routes. The repository has no separate DOCX preview
  renderer; browser acceptance therefore covers the real executor, durable
  stores, emitted OPC bytes, and semantic part-byte parity.
