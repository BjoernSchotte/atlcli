# Issue 119 — bounded-memory DOCX packaging plan

Status: implemented and verified on 2026-07-29.

## Contract

Keep one shared TypeScript DOCX engine for CLI, ordinary browser, extension,
and Forge hosts. Preserve customer templates and all current semantic/report
contracts. Hosts provide only durable source, template, media, and output
stores.

## Delivery sequence

1. Extend the reusable Chromium job harness with `text`, `mixed`, and
   `image-heavy` DOCX corpora plus sampled in-job heap/backing peaks.
2. Apply per-entry ZIP compression: `STORE` for PNG/JPEG/GIF and DEFLATE for
   XML/text/vector parts.
3. Add a bounded fflate OPC writer with Data Descriptors, deterministic Central
   Directory metadata, explicit ZIP32 budgets, cancellation, and sink errors.
4. Preserve customer-template processing with a unique sentinel and stream the
   target part as prefix, verbatim body, and suffix.
5. Detach prepared media into hash-bound descriptors; extension and Node
   stores materialize opaque references and read each object lazily.
6. Select the existing in-memory path below 1 MiB and streaming at or above
   that lower-bound size.
7. Re-measure before adding a cursor/two-pass page serializer.

## Phase 5 gate

The final 500-page Chrome run reduced the completed backing-storage checkpoint
from 22.55 MB to 5.38 MB. The image-heavy A/B reduced incremental packaging
backing by 57.8%. The remaining composed graph/body XML is therefore not the
dominant binary peak in this lane, so the issue's conditional Phase 5 is not
activated. A cursor/two-pass serializer remains appropriate only if a later
larger text/mixed corpus shows that graph ownership has become material again.

## Unresolved questions

None for this issue. Forge still supplies its host lifecycle/spool adapter; it
must consume the same shared contracts rather than fork the serializer.
